const { app, BrowserWindow, BrowserView, WebContentsView, ipcMain, shell, net, dialog, session, screen, Tray, Menu, Notification } = require('electron');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const fs = require('fs');
const { parse: parseJsonc } = require('jsonc-parser');
const http = require('http');
const express = require('express');
const { createProductStateStore } = require('./product-state.cjs');
const { createProductStateSaveController } = require('./product-state-save-controller.cjs');
const {
  codeBuddyFetchOptions,
  createCodeBuddyRuntimeManager,
  decodeProcessOutput,
} = require('./codebuddy-runtime-manager.cjs');
const { createQuitRequestController } = require('./quit-request-controller.cjs');
const { createFinalExitController } = require('./final-exit-controller.cjs');
const { deleteModelConfig, ensureModelConfigFile, listModelConfig, saveModelConfig } = require('./model-config.cjs');
const { normalizeGitRequest, validateGitArgs } = require('./git-validate.cjs');
const { normalizeDirList, isAllowedGitCwd, isTrustedGitSender, isTrustedMainSender } = require('./git-security.cjs');
const { createWorkspaceTrust } = require('./workspace-trust.cjs');
const { buildAttachmentChooseDialogOptions } = require('./attachment-choose.cjs');
const { createAttachmentScope } = require('./attachment-scope.cjs');
const {
  isTrustedRendererNavigation,
  normalizeExternalHttpUrl,
  rendererOriginForEntry,
} = require('./navigation-policy.cjs');
const {
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  MIN_HEIGHT,
  MIN_WIDTH,
  clampWindowState,
  windowStateIsVisible,
} = require('./window-state.cjs');
const {
  RECOMMENDED_VERSION,
  buildCompatStatus,
  assertCliCompatibleForRuntime,
} = require('./cli-compat.cjs');
const { resolveCodeBuddySpawnSpec, resolveNpmSpawnSpec } = require('./codebuddy-cli-path.cjs');
const { readProjectWorkflowProgress } = require('./workflow-progress.cjs');

const CODEBUDDY_CLI_NPM_PACKAGE = '@tencent-ai/codebuddy-code';
const { MobileRemoteHost, defaultConfig: defaultMobileRemoteConfig } = require('./mobile-remote/host.cjs');

const isDev = !app.isPackaged;

/** @type {import('./mobile-remote/host.cjs').MobileRemoteHost | null} */
let mobileRemoteHost = null;

function mobileRemoteConfigPath() {
  return path.join(app.getPath('userData'), 'mobile-remote-config.json');
}

function readMobileRemoteConfig() {
  try {
    const raw = fs.readFileSync(mobileRemoteConfigPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...defaultMobileRemoteConfig(),
      ...(parsed && typeof parsed === 'object' ? parsed : {}),
    };
  } catch {
    return defaultMobileRemoteConfig();
  }
}

function writeMobileRemoteConfig(config) {
  const next = {
    ...defaultMobileRemoteConfig(),
    ...(config && typeof config === 'object' ? config : {}),
  };
  const file = mobileRemoteConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // L1: atomic temp+rename with 0o600 so the relay endpoint/TLS preference is
  // not left in a half-written or world-readable file.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* windows */ }
  return next;
}

function getMobileRemoteHost() {
  if (!mobileRemoteHost) {
    mobileRemoteHost = new MobileRemoteHost({
      userDataPath: app.getPath('userData'),
      getConfig: readMobileRemoteConfig,
      setConfig: writeMobileRemoteConfig,
      net,
      runtimeManager,
      getProductState: () => productStateStore.load(),
      listBackgroundTasks: () => {
        try { return listBackgroundSessions(); } catch { return []; }
      },
      log: (...args) => logStartup(`mobileRemote: ${args.map(String).join(' ')}`),
    });
  }
  return mobileRemoteHost;
}

// 生产构建本地 HTTP 服务器端口（动态分配）
let prodServerPort = null;
let staticServer = null; // express 静态服务器引用：before-quit 时显式 close 避免端口残留

let mainWindow = null;
let rightBrowserView = null;
let trustedRendererOrigin = null;
let tray = null;
let windowCreationPromise = null;
let closeToTrayHintShown = false;
// 二次启动发生在静态服务器/窗口就绪前时先记下，就绪后补一次显示；
// 否则用户在首实例初始化完成前双击第二次启动会被静默吞掉（不弹窗无提示）。
let pendingShowRequested = false;
const activeTaskNotifications = new Set();
const senderAbortRegistrations = new WeakMap();

function registerSenderAbort(sender, controller, streamId = null) {
  if (!sender || sender.isDestroyed()) return () => {};
  let registration = senderAbortRegistrations.get(sender);
  if (!registration) {
    registration = { entries: new Set(), listener: null };
    registration.listener = () => {
      for (const entry of registration.entries) {
        try { entry.controller.abort(); } catch (_) {}
        if (entry.streamId) codebuddyStreams.delete(entry.streamId);
      }
      registration.entries.clear();
      senderAbortRegistrations.delete(sender);
    };
    sender.once('destroyed', registration.listener);
    senderAbortRegistrations.set(sender, registration);
  }
  const entry = { controller, streamId };
  registration.entries.add(entry);
  return () => {
    const current = senderAbortRegistrations.get(sender);
    if (!current) return;
    current.entries.delete(entry);
    if (!current.entries.size) {
      try { sender.removeListener('destroyed', current.listener); } catch (_) {}
      senderAbortRegistrations.delete(sender);
    }
  };
}
let pendingNotificationTarget = null;
// startup.log 放 userData：打包后 __dirname 在 asar 内（只读虚拟路径），相对路径写失败被静默吞
const startupLog = path.join(app.getPath('userData'), 'electron-startup.log');

// 窗口状态持久化文件（P0-3）
const WINDOW_STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');
const productStateStore = createProductStateStore(app.getPath('userData'), logStartup);
const productStateSaveController = createProductStateSaveController({
  store: productStateStore,
  delayMs: 800,
  logger: logStartup,
});
const workspaceTrust = createWorkspaceTrust({ loadProductState: () => productStateStore.load() });

function sanitizeProductStateSnapshot(state) {
  const previous = productStateStore.load();
  return workspaceTrust.sanitizeIncomingState(state, previous);
}

function readWindowState() {
  try {
    if (!fs.existsSync(WINDOW_STATE_FILE)) return null;
    const s = JSON.parse(fs.readFileSync(WINDOW_STATE_FILE, 'utf8'));
    // 简单合法性校验：宽高正数、屏幕内可见
    if (typeof s.width !== 'number' || typeof s.height !== 'number' || s.width < 100 || s.height < 100) return null;
    return s;
  } catch (_) {
    return null;
  }
}

function restoredWindowBounds(state) {
  if (!state) return null;
  const displays = screen.getAllDisplays();
  if (!windowStateIsVisible(state, displays)) return null;
  return clampWindowState(state, displays, { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
}

// 无已存窗口状态时：显式主屏居中，不依赖 Windows 默认放置。多显示器下
// CW_USEDEFAULT 可能把窗口放到屏幕外（尤其上次窗口在副屏/负坐标时），
// 侧栏会被显示器裁掉。有 savedBounds 时走 clamp 恢复。
function primaryCenteredBounds() {
  const workArea = screen.getPrimaryDisplay().workArea || { x: 0, y: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  const width = Math.min(DEFAULT_WIDTH, Math.max(MIN_WIDTH, workArea.width));
  const height = Math.min(DEFAULT_HEIGHT, Math.max(MIN_HEIGHT, workArea.height));
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  };
}

function writeWindowState(state) {
  try {
    // L1: atomic temp+rename with 0o600.
    const tmp = `${WINDOW_STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, WINDOW_STATE_FILE);
    try { fs.chmodSync(WINDOW_STATE_FILE, 0o600); } catch { /* windows */ }
  } catch (_) {
    /* 写失败不阻塞 */
  }
}

function showCloseToTrayHint() {
  if (!tray || typeof tray.displayBalloon !== 'function') return;
  try {
    tray.displayBalloon({
      title: 'CodeBuddy Desktop 仍在运行',
      content: '窗口已隐藏到系统托盘。点击托盘图标可恢复，右键选择“完全退出”可关闭应用。',
      iconType: 'info',
      noSound: true,
    });
  } catch (error) {
    logStartup(`Tray hint failed: ${error?.message || error}`);
  }
}

// 真退出标志：渲染进程确认退出后为 true，普通 X 关窗口仍只隐藏到托盘。
// 这样编辑器可以在真正退出前处理未保存内容。
let reallyQuitting = false;
let quitRequestPreparing = false;
let exitCleanupStarted = false;
const quitRequestController = createQuitRequestController({
  // No renderer answer → force quit quickly (was 8s; felt like “tray exit is stuck”).
  timeoutMs: 2500,
  // Renderer acked but never confirm/cancel (hung save / dialog path) → hard stop.
  hardDeadlineMs: 6000,
  // Dirty-file dialog budget. hold() disarms the timers above; this fallback
  // still fires so a renderer that crashes/hangs after the dialog cannot pin
  // the quit request forever (normal dialogs resolve far sooner).
  holdDeadlineMs: 120000,
  onTimeout(requestId) {
    if (reallyQuitting) return;
    logStartup(`Quit request timed out request=${requestId}; forcing application exit`);
    beginFinalApplicationExit(`renderer-timeout:${requestId}`);
  },
});

function redactSecrets(text) {
  return (
    String(text || '')
      // 后端 stdout 形态："Password    xxx" / "Password: xxx" / "Password:xxx"（大写开头，留冒号）
      .replace(/(Password\s*:\s*)[^\s,}]+/g, '$1[redacted]')
      .replace(/(Password\s+)[^\s,}]+/g, '$1[redacted]')
      // JSON 形态："password":"xxx" / 'password':'xxx'（保留值的引号对）
      .replace(/(["']password["']\s*:\s*)(["'])[^"']+\2/g, '$1$2[redacted]$2')
      // URL query 形态：?password=xxx / &password=xxx
      .replace(/([?&]password=)[^\s&]+/gi, '$1[redacted]')
      .replace(/(Authorization\s*:\s*Bearer\s+)[^\s,}]+/gi, '$1[redacted]')
      .replace(/(["'](?:token|api[_-]?key|secret|auth)["']\s*:\s*)(["'])[^"']+\2/gi, '$1$2[redacted]$2')
      .replace(/([?&](?:token|api[_-]?key|secret|auth)=)[^\s&]+/gi, '$1[redacted]')
      .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[opusr]_[A-Za-z0-9_]{20,})\b/g, '[redacted-token]')
  );
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactDiagnosticText(value) {
  let text = redactSecrets(value);
  try {
    const home = app.getPath('home');
    for (const candidate of [home, home.replace(/\\/g, '/')]) {
      if (candidate) text = text.replace(new RegExp(escapeRegExp(candidate), 'gi'), '%USERPROFILE%');
    }
  } catch (_) {}
  return text;
}

function redactProjectPath(value, projectPath) {
  let text = redactDiagnosticText(value);
  for (const candidate of [projectPath, String(projectPath || '').replace(/\\/g, '/')]) {
    if (candidate) text = text.replace(new RegExp(escapeRegExp(candidate), 'gi'), '%PROJECT_ROOT%');
  }
  return text;
}

function readDiagnosticLog(filePath, maxBytes = 200 * 1024) {
  try {
    const content = fs.readFileSync(filePath);
    return redactDiagnosticText(content.slice(-maxBytes).toString('utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    return `Unable to read diagnostic log: ${error?.message || error}`;
  }
}

// M-perf: startup/renderer logs are buffered and flushed on a 1s timer instead
// of a synchronous appendFileSync per line — renderer console spam (SSE parse
// warnings, reconnect storms) used to block the main-process event loop with
// sync disk I/O for every message.
const startupLogBuffer = [];
let startupLogFlushTimer = null;

function flushStartupLog() {
  if (startupLogFlushTimer) {
    clearTimeout(startupLogFlushTimer);
    startupLogFlushTimer = null;
  }
  if (!startupLogBuffer.length) return;
  const batch = startupLogBuffer.splice(0);
  try {
    // 日志轮转：超 1MB 截断保留尾 200KB，避免长期启动累积占满磁盘 + 测试全文读越来越慢
    try {
      const stats = fs.statSync(startupLog);
      if (stats.size > 1024 * 1024) {
        const tail = fs.readFileSync(startupLog);
        fs.writeFileSync(startupLog, tail.slice(-200 * 1024));
      }
    } catch (_) {
      /* 文件不存在或读失败不阻塞写入 */
    }
    fs.appendFileSync(startupLog, batch.join(''));
  } catch (_) {}
}

function logStartup(message) {
  startupLogBuffer.push(`[${new Date().toISOString()}] ${message}\n`);
  if (!startupLogFlushTimer) startupLogFlushTimer = setTimeout(flushStartupLog, 1000);
}

function destroyTrayIcon(reason = 'exit') {
  if (!tray) return;
  try {
    tray.destroy();
    logStartup(`Tray icon destroyed reason=${reason}`);
  } catch (error) {
    logStartup(`Tray destroy failed reason=${reason}: ${error?.message || error}`);
  }
  tray = null;
}

const finalExitController = createFinalExitController({
  trayDelayMs: 50,
  forceDelayMs: 1200,
  destroyTray: destroyTrayIcon,
  requestQuit(reason) {
    logStartup(`Electron app.quit requested reason=${reason}`);
    app.quit();
  },
  forceExit(reason) {
    logStartup(`Electron app.exit fallback reason=${reason}`);
    app.exit(0);
  },
});

function beginFinalApplicationExit(reason) {
  if (reallyQuitting || finalExitController.isStarted()) return false;
  reallyQuitting = true;
  logStartup(`Final application exit started reason=${reason}`);
  return finalExitController.start(reason);
}

const GUI_RELEASES_URL = 'https://github.com/ChisaAlter/codebuddy-gui/releases';
const GUI_LATEST_RELEASE_API = 'https://api.github.com/repos/ChisaAlter/codebuddy-gui/releases/latest';

function compareVersions(left, right) {
  const parts = (value) =>
    String(value || '')
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((item) => Number.parseInt(item, 10) || 0);
  const leftParts = parts(left);
  const rightParts = parts(right);
  const length = Math.max(leftParts.length, rightParts.length, 3);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function trustedGuiReleaseUrl(value) {
  try {
    const parsed = new URL(String(value || GUI_RELEASES_URL));
    if (parsed.origin === 'https://github.com' && parsed.pathname.startsWith('/ChisaAlter/codebuddy-gui/releases'))
      return parsed.toString();
  } catch (_) {}
  return GUI_RELEASES_URL;
}

function trustedGuiDownloadUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    const match = decodeURIComponent(parsed.pathname).match(
      /^\/ChisaAlter\/codebuddy-gui\/releases\/download\/v(\d+(?:\.\d+){1,3})\/CodeBuddy-GUI-Setup-(\d+(?:\.\d+){1,3})\.exe$/i,
    );
    if (
      parsed.origin === 'https://github.com' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      match?.[1] === match?.[2]
    ) {
      return parsed.toString();
    }
  } catch (_) {}
  return null;
}

function firstExistingPath(candidates) {
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function readMcpConfigFile(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8').trim();
    if (!text) return {};
    const errors = [];
    const value = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) {
      const offset = errors[0]?.offset;
      throw new Error(`JSONC 格式无效${Number.isFinite(offset) ? `（位置 ${offset}）` : ''}`);
    }
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`${filePath}: ${error?.message || error}`);
  }
}

function comparableMcpPath(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function publicMcpArgs(args) {
  let redactNext = false;
  return (Array.isArray(args) ? args : []).map((value) => {
    const text = String(value);
    if (redactNext) {
      redactNext = false;
      return '[redacted]';
    }
    const assignment = text.match(/^(--?[^=]*(?:token|api[-_]?key|secret|password|auth|credential)[^=]*)=(.*)$/i);
    if (assignment) return `${assignment[1]}=[redacted]`;
    if (/^--?[^=]*(?:token|api[-_]?key|secret|password|auth|credential)/i.test(text)) redactNext = true;
    return redactSecrets(text);
  });
}

function publicMcpUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (parsed.username) parsed.username = 'redacted';
    if (parsed.password) parsed.password = 'redacted';
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/(?:token|api[-_]?key|secret|password|auth|credential)/i.test(key))
        parsed.searchParams.set(key, '[redacted]');
    }
    return redactSecrets(parsed.toString());
  } catch (_) {
    return redactSecrets(value);
  }
}

function publicMcpConfig(config = {}) {
  return {
    type: String(config.type || (config.command ? 'stdio' : config.url ? 'http' : 'unknown')),
    command: typeof config.command === 'string' ? redactSecrets(config.command) : '',
    args: publicMcpArgs(config.args),
    url: typeof config.url === 'string' ? publicMcpUrl(config.url) : '',
    description: typeof config.description === 'string' ? config.description : '',
    envKeys: config.env && typeof config.env === 'object' && !Array.isArray(config.env) ? Object.keys(config.env) : [],
    headerKeys:
      config.headers && typeof config.headers === 'object' && !Array.isArray(config.headers)
        ? Object.keys(config.headers)
        : [],
  };
}

function resolveMcpConfigLocations(cwd) {
  const rawCwd = String(cwd || '').trim();
  if (!rawCwd || !path.isAbsolute(rawCwd)) throw new Error('MCP 配置需要有效的项目绝对路径');
  const resolvedCwd = path.resolve(rawCwd);
  try {
    if (!fs.statSync(resolvedCwd).isDirectory()) throw new Error('not a directory');
  } catch (_) {
    throw new Error(`项目目录不存在或不可访问: ${resolvedCwd}`);
  }
  const homeDir = os.homedir();
  const configRoot = String(process.env.CODEBUDDY_CONFIG_DIR || '').trim() || path.join(homeDir, '.codebuddy');
  return {
    cwd: resolvedCwd,
    user: firstExistingPath([
      path.join(configRoot, '.mcp.json'),
      path.join(configRoot, 'mcp.json'),
      path.join(homeDir, '.codebuddy.json'),
    ]),
    project: firstExistingPath([path.join(resolvedCwd, '.mcp.json'), path.join(resolvedCwd, 'mcp.json')]),
    local: path.join(homeDir, '.mcp.json'),
  };
}

function configuredMcpServers(scope, config, filePath) {
  const servers =
    config?.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)
      ? config.mcpServers
      : {};
  const disabled = new Set(Array.isArray(config?.disabledMcpServers) ? config.disabledMcpServers.map(String) : []);
  return Object.entries(servers).map(([name, value]) => ({
    name,
    scope,
    filePath,
    disabled: disabled.has(name),
    config: publicMcpConfig(value),
  }));
}

function listConfiguredMcpServers(cwd) {
  const locations = resolveMcpConfigLocations(cwd);
  const errors = [];
  const readScope = (scope, filePath, select = (value) => value) => {
    try {
      return configuredMcpServers(scope, select(readMcpConfigFile(filePath)) || {}, filePath);
    } catch (error) {
      errors.push({ scope, filePath, message: error?.message || String(error) });
      return [];
    }
  };
  const user = readScope('user', locations.user);
  const project = readScope('project', locations.project);
  const local = readScope('local', locations.local, (value) => {
    const projects =
      value?.projects && typeof value.projects === 'object' && !Array.isArray(value.projects) ? value.projects : {};
    const target = comparableMcpPath(locations.cwd);
    const projectKey = Object.keys(projects).find((candidate) => comparableMcpPath(candidate) === target);
    return projectKey ? projects[projectKey] : {};
  });
  const scopeRank = { local: 0, project: 1, user: 2 };
  const servers = [...local, ...project, ...user].sort(
    (left, right) => scopeRank[left.scope] - scopeRank[right.scope] || left.name.localeCompare(right.name),
  );
  return { cwd: locations.cwd, locations, servers, errors };
}

function sandboxStateFilePath() {
  const configRoot = String(process.env.CODEBUDDY_CONFIG_DIR || '').trim() || path.join(os.homedir(), '.codebuddy');
  return path.join(configRoot, 'sandbox-state.json');
}

function readSandboxSnapshot() {
  const statePath = sandboxStateFilePath();
  if (!fs.existsSync(statePath)) {
    return { statePath, stateExists: false, currentSandboxId: null, aliases: [], sandboxes: [] };
  }

  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Sandbox 状态文件无法读取: ${error?.message || error}`);
  }

  const e2b = state?.e2b && typeof state.e2b === 'object' ? state.e2b : {};
  const sandboxValues =
    e2b.sandboxes && typeof e2b.sandboxes === 'object' && !Array.isArray(e2b.sandboxes) ? e2b.sandboxes : {};
  const aliasValues =
    e2b.aliasMapping && typeof e2b.aliasMapping === 'object' && !Array.isArray(e2b.aliasMapping)
      ? e2b.aliasMapping
      : {};
  const aliases = Object.entries(aliasValues)
    .map(([alias, sandboxId]) => ({ alias: String(alias), sandboxId: String(sandboxId || '') }))
    .filter((item) => item.alias && item.sandboxId)
    .sort((left, right) => left.alias.localeCompare(right.alias));
  const aliasesBySandbox = new Map();
  for (const item of aliases) {
    const values = aliasesBySandbox.get(item.sandboxId) || [];
    values.push(item.alias);
    aliasesBySandbox.set(item.sandboxId, values);
  }
  const currentSandboxId = typeof e2b.currentSandboxId === 'string' ? e2b.currentSandboxId : null;
  const sandboxes = Object.entries(sandboxValues)
    .map(([key, rawValue]) => {
      const value = rawValue && typeof rawValue === 'object' ? rawValue : {};
      const sandboxId = String(value.sandboxId || key);
      const projectValues =
        value.projects && typeof value.projects === 'object' && !Array.isArray(value.projects) ? value.projects : {};
      const projects = Object.entries(projectValues).map(([projectKey, rawProject]) => {
        const project = rawProject && typeof rawProject === 'object' ? rawProject : {};
        return {
          key: String(projectKey),
          localPath: typeof project.localPath === 'string' ? project.localPath : '',
          remotePath: typeof project.remotePath === 'string' ? project.remotePath : '',
          lastSyncedAt: typeof project.lastSyncedAt === 'string' ? project.lastSyncedAt : null,
        };
      });
      return {
        sandboxId,
        current: sandboxId === currentSandboxId,
        createdAt: typeof value.createdAt === 'string' ? value.createdAt : null,
        lastUsedAt: typeof value.lastUsedAt === 'string' ? value.lastUsedAt : null,
        templateName: typeof value.templateName === 'string' ? value.templateName : '',
        aliases: aliasesBySandbox.get(sandboxId) || [],
        projects,
      };
    })
    .sort((left, right) => {
      if (left.current !== right.current) return left.current ? -1 : 1;
      const leftTime = Date.parse(left.lastUsedAt || left.createdAt || '') || 0;
      const rightTime = Date.parse(right.lastUsedAt || right.createdAt || '') || 0;
      return rightTime - leftTime || left.sandboxId.localeCompare(right.sandboxId);
    });

  return { statePath, stateExists: true, currentSandboxId, aliases, sandboxes };
}

function validateSandboxId(value) {
  const sandboxId = String(value || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(sandboxId)) throw new Error('Sandbox ID 格式无效');
  return sandboxId;
}

function runCapturedProcess(
  command,
  args,
  {
    cwd = os.homedir(),
    env = process.env,
    timeoutMs = 120000,
    maxOutputBytes = 2 * 1024 * 1024,
    timeoutMessage = 'CodeBuddy 命令执行超时',
  } = {},
) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    const appendTail = (current, data, markTruncated) => {
      const combined = Buffer.concat([current, Buffer.from(data)]);
      if (combined.length <= maxOutputBytes) return { value: combined, truncated: markTruncated };
      return { value: combined.slice(-maxOutputBytes), truncated: true };
    };
    const terminateProcess = () => {
      if (!proc.pid || proc.killed) return;
      if (process.platform === 'win32') {
        try {
          const killer = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
          killer.once('error', () => {
            try {
              proc.kill('SIGKILL');
            } catch (_) {}
          });
          killer.unref();
          return;
        } catch (_) {}
      }
      try {
        proc.kill('SIGKILL');
      } catch (_) {}
    };
    const timeoutId = setTimeout(() => {
      if (settled) return;
      terminateProcess();
      const error = new Error(timeoutMessage);
      error.code = 'ETIMEDOUT';
      finish(error);
    }, timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (error) reject(error);
      else resolve(value);
    };
    proc.stdout.on('data', (data) => {
      const next = appendTail(stdout, data, stdoutTruncated);
      stdout = next.value;
      stdoutTruncated = next.truncated;
    });
    proc.stderr.on('data', (data) => {
      const next = appendTail(stderr, data, stderrTruncated);
      stderr = next.value;
      stderrTruncated = next.truncated;
    });
    proc.on('error', (error) => {
      const message = /(?:ENOENT|not recognized|not found|不是内部或外部命令|找不到)/i.test(
        String(error?.message || error),
      )
        ? '未找到 CodeBuddy CLI。请确认命令行中可以直接运行 codebuddy。'
        : error?.message || String(error);
      finish(new Error(message));
    });
    proc.on('close', (code) => {
      const output = decodeProcessOutput(stdout).trim();
      const errorOutput = decodeProcessOutput(stderr).trim();
      if (code === 0)
        finish(null, {
          output: output || errorOutput,
          stdout: output,
          stderr: errorOutput,
          stdoutTruncated,
          stderrTruncated,
        });
      else finish(new Error(errorOutput || output || `CodeBuddy 命令执行失败，退出码 ${code}`));
    });
  });
}

function runCodeBuddyCli(args, options = {}) {
  // Resolve Windows npm shims (codebuddy.cmd) to node + JS entry so shell:false works.
  const argv = Array.isArray(args) ? args.map((arg) => String(arg)) : [];
  const spec = resolveCodeBuddySpawnSpec(argv, options.env || process.env);
  return runCapturedProcess(spec.command, spec.args, {
    ...options,
    env: spec.env,
  });
}

function runSandboxCli(args, timeoutMs = 120000) {
  return runCodeBuddyCli(['sandbox', ...args], { timeoutMs });
}

let sandboxOperation = null;

async function runExclusiveSandboxOperation(args) {
  if (sandboxOperation) throw new Error('另一个 Sandbox 操作正在进行，请稍候');
  const operation = runSandboxCli(args);
  sandboxOperation = operation;
  try {
    const result = await operation;
    return { ...result, snapshot: readSandboxSnapshot() };
  } finally {
    if (sandboxOperation === operation) sandboxOperation = null;
  }
}

function publicBackgroundSession(value = {}) {
  const numberValue = (item) => (Number.isFinite(Number(item)) ? Number(item) : null);
  const stringValue = (item) => (typeof item === 'string' ? item : '');
  return {
    pid: numberValue(value.pid),
    name: stringValue(value.name),
    sessionId: stringValue(value.sessionId),
    kind: stringValue(value.kind) || 'unknown',
    status: stringValue(value.status),
    cwd: stringValue(value.cwd),
    startedAt: numberValue(value.startedAt),
    lastHeartbeat: numberValue(value.lastHeartbeat),
    updatedAt: numberValue(value.updatedAt),
    endpoint: stringValue(value.endpoint || value.url),
    mode: stringValue(value.mode),
    version: stringValue(value.version),
    os: stringValue(value.os),
    arch: stringValue(value.arch),
    hostname: stringValue(value.hostname),
    logPath: stringValue(value.logPath),
  };
}

async function listBackgroundSessions() {
  const result = await runCodeBuddyCli(['ps', '--json'], { timeoutMs: 30000 });
  const output = String(result.stdout || result.output || '').trim();
  if (!output || /^No active sessions\.?$/i.test(output))
    return { sessions: [], refreshedAt: new Date().toISOString() };
  let parsed;
  try {
    const arrayStart = output.indexOf('[');
    const arrayEnd = output.lastIndexOf(']');
    parsed = JSON.parse(arrayStart >= 0 && arrayEnd > arrayStart ? output.slice(arrayStart, arrayEnd + 1) : output);
  } catch (error) {
    throw new Error(`CodeBuddy 后台会话列表格式无效: ${error?.message || error}`);
  }
  if (!Array.isArray(parsed)) throw new Error('CodeBuddy 后台会话列表不是数组');
  const sessions = parsed
    .map(publicBackgroundSession)
    .filter((item) => Number.isInteger(item.pid) && item.pid > 0)
    .sort((left, right) => (right.startedAt || 0) - (left.startedAt || 0));
  return { sessions, refreshedAt: new Date().toISOString() };
}

function validateBackgroundPid(value) {
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 0 || pid > 2147483647) throw new Error('后台会话 PID 无效');
  return pid;
}

function validateBackgroundSessionName(value) {
  const name = String(value || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name))
    throw new Error('后台会话名称只能包含字母、数字、点、连字符和下划线');
  return name;
}

function validateBackgroundCwd(value) {
  const raw = String(value || '').trim();
  if (!raw || !path.isAbsolute(raw)) throw new Error('后台会话需要有效的项目绝对路径');
  const cwd = path.resolve(raw);
  try {
    if (!fs.statSync(cwd).isDirectory()) throw new Error('not a directory');
  } catch (_) {
    throw new Error(`项目目录不存在或不可访问: ${cwd}`);
  }
  if (!workspaceTrust.isTrustedCwd(cwd)) {
    throw new Error('后台会话目录不在已信任的工作区内');
  }
  return cwd;
}

function stripTerminalFormatting(value) {
  const escapeSequence = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
  return String(value || '').replace(escapeSequence, '');
}

async function startBackgroundSession(payload = {}) {
  const name = validateBackgroundSessionName(payload.name);
  const cwd = validateBackgroundCwd(payload.cwd);
  const prompt = String(payload.prompt || '').trim();
  if (!prompt) throw new Error('请输入后台任务内容');
  if (prompt.length > 20000) throw new Error('后台任务内容不能超过 20000 个字符');

  let result;
  const bgEnv = resolveCodeBuddySpawnSpec(['--version'], process.env).env || process.env;
  const spec = resolveCodeBuddySpawnSpec(['--bg', '--name', name, '--', prompt], {
    ...bgEnv,
    CODEBUDDY_GUI_BG_NAME: name,
    CODEBUDDY_GUI_BG_PROMPT: prompt,
  });
  result = await runCapturedProcess(spec.command, spec.args, { cwd, env: spec.env, timeoutMs: 60000 });
  let snapshot = await listBackgroundSessions();
  for (let attempt = 0; attempt < 4 && !snapshot.sessions.some((item) => item.name === name); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    snapshot = await listBackgroundSessions();
  }
  return { output: stripTerminalFormatting(result.output), snapshot };
}

async function readBackgroundSessionLogs(pidValue) {
  const pid = validateBackgroundPid(pidValue);
  const snapshot = await listBackgroundSessions();
  const target = snapshot.sessions.find((item) => item.pid === pid);
  if (!target) throw new Error('后台会话已结束或不存在');
  if (!target.logPath) throw new Error('该会话没有可读取的日志文件');
  const maxBytes = 1024 * 1024;
  let descriptor;
  let content;
  let truncated = false;
  try {
    const stats = fs.statSync(target.logPath);
    if (!stats.isFile()) throw new Error('not a file');
    const length = Math.min(stats.size, maxBytes);
    const buffer = Buffer.alloc(length);
    descriptor = fs.openSync(target.logPath, 'r');
    const bytesRead = length ? fs.readSync(descriptor, buffer, 0, length, Math.max(0, stats.size - length)) : 0;
    content = stripTerminalFormatting(decodeProcessOutput(buffer.subarray(0, bytesRead)));
    truncated = stats.size > maxBytes;
  } catch (error) {
    throw new Error(`后台日志读取失败: ${error?.message || error}`);
  } finally {
    if (descriptor !== undefined)
      try {
        fs.closeSync(descriptor);
      } catch (_) {}
  }
  return {
    pid,
    content,
    truncated,
  };
}

async function killBackgroundSession(pidValue) {
  const pid = validateBackgroundPid(pidValue);
  const snapshot = await listBackgroundSessions();
  const target = snapshot.sessions.find((item) => item.pid === pid);
  if (!target) throw new Error('后台会话已结束或不存在');
  if (target.kind !== 'bg') throw new Error(`只能终止 CodeBuddy 后台任务，当前类型为 ${target.kind}`);
  const result = await runCodeBuddyCli(['kill', String(pid)], { timeoutMs: 30000 });
  return { output: stripTerminalFormatting(result.output), snapshot: await listBackgroundSessions() };
}

async function openBackgroundSessionEndpoint(value) {
  if (!isAllowedLocalRuntimeUrl(value, { allowDevPort: false })) {
    throw new Error('只允许打开已登记的本机 CodeBuddy Endpoint');
  }
  await shell.openExternal(String(value));
  return { url: String(value) };
}

function spawnDetachedInteractiveProcess(command, args, { cwd, windowsHide }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      detached: true,
      stdio: 'ignore',
      windowsHide,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve({ pid: child.pid });
    });
  });
}

async function attachBackgroundSession(pidValue) {
  const pid = validateBackgroundPid(pidValue);
  const snapshot = await listBackgroundSessions();
  const target = snapshot.sessions.find((item) => item.pid === pid);
  if (!target) throw new Error('后台会话已结束或不存在');
  if (target.kind !== 'bg') throw new Error(`只能接管 CodeBuddy 后台任务，当前类型为 ${target.kind}`);
  if (process.platform !== 'win32') throw new Error('当前版本仅支持在 Windows 交互终端中接管后台会话');

  const cwd = validateBackgroundCwd(target.cwd);
  const windowsPowerShell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const powershell = fs.existsSync(windowsPowerShell) ? windowsPowerShell : 'powershell.exe';
  const command = `& codebuddy attach ${pid}`;
  const title = `CodeBuddy · ${target.name || `PID ${pid}`}`.slice(0, 80);
  const windowsTerminal = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wt.exe');

  if (fs.existsSync(windowsTerminal)) {
    try {
      const launched = await spawnDetachedInteractiveProcess(
        windowsTerminal,
        [
          '-w',
          '0',
          'new-tab',
          '--title',
          title,
          '-d',
          cwd,
          powershell,
          '-NoLogo',
          '-NoProfile',
          '-NoExit',
          '-Command',
          command,
        ],
        { cwd, windowsHide: true },
      );
      return { session: target, terminal: 'Windows Terminal', launcherPid: launched.pid };
    } catch (error) {
      logStartup(`Windows Terminal attach launch failed: ${error?.message || error}`);
    }
  }

  try {
    const launched = await spawnDetachedInteractiveProcess(
      powershell,
      ['-NoLogo', '-NoProfile', '-NoExit', '-Command', command],
      { cwd, windowsHide: false },
    );
    return { session: target, terminal: 'Windows PowerShell', launcherPid: launched.pid };
  } catch (error) {
    throw new Error(`无法打开交互终端: ${error?.message || error}`);
  }
}

let backgroundSessionOperation = null;

async function runExclusiveBackgroundSessionOperation(operation) {
  if (backgroundSessionOperation) throw new Error('另一个后台会话操作正在进行，请稍候');
  const promise = Promise.resolve().then(operation);
  backgroundSessionOperation = promise;
  try {
    return await promise;
  } finally {
    if (backgroundSessionOperation === promise) backgroundSessionOperation = null;
  }
}

function publicDaemonServiceStatus(value = {}) {
  const service = value?.systemService && typeof value.systemService === 'object' ? value.systemService : {};
  return {
    status: typeof value.status === 'string' ? value.status : 'unknown',
    pid: Number.isInteger(Number(value.pid)) ? Number(value.pid) : null,
    port: Number.isInteger(Number(value.port)) ? Number(value.port) : null,
    endpoint: typeof value.endpoint === 'string' ? value.endpoint : '',
    systemService: {
      installed: service.installed === true,
      backend: typeof service.backend === 'string' ? service.backend : 'unknown',
      configPath: typeof service.configPath === 'string' ? service.configPath : '',
    },
  };
}

async function readDaemonServiceStatus() {
  const result = await runCodeBuddyCli(['daemon', 'status'], { timeoutMs: 30000 });
  const output = String(result.stdout || result.output || '').trim();
  let parsed;
  try {
    const objectStart = output.indexOf('{');
    const objectEnd = output.lastIndexOf('}');
    parsed = JSON.parse(
      objectStart >= 0 && objectEnd > objectStart ? output.slice(objectStart, objectEnd + 1) : output,
    );
  } catch (error) {
    throw new Error(`CodeBuddy Daemon 状态格式无效: ${error?.message || error}`);
  }
  return publicDaemonServiceStatus(parsed);
}

const DAEMON_PERMISSION_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto']);

function normalizeDaemonInstallOptions(payload = {}) {
  const args = ['daemon', 'install'];
  const portText = String(payload.port ?? '').trim();
  if (portText) {
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Daemon 端口必须是 1 到 65535 之间的整数');
    args.push('--port', String(port));
  }
  const permissionMode = String(payload.permissionMode || 'default').trim();
  if (!DAEMON_PERMISSION_MODES.has(permissionMode)) throw new Error('Daemon 权限模式无效');
  args.push('--permission-mode', permissionMode);
  return args;
}

async function installDaemonService(payload) {
  const current = await readDaemonServiceStatus();
  if (current.systemService.installed) return { output: 'CodeBuddy Daemon 系统服务已安装', snapshot: current };
  const result = await runCodeBuddyCli(normalizeDaemonInstallOptions(payload), { timeoutMs: 60000 });
  const snapshot = await readDaemonServiceStatus();
  if (!snapshot.systemService.installed) throw new Error('CodeBuddy 命令已完成，但系统服务仍未安装');
  return { output: stripTerminalFormatting(result.output), snapshot };
}

async function uninstallDaemonService() {
  const current = await readDaemonServiceStatus();
  if (!current.systemService.installed) return { output: 'CodeBuddy Daemon 系统服务未安装', snapshot: current };
  const result = await runCodeBuddyCli(['daemon', 'uninstall'], { timeoutMs: 60000 });
  const snapshot = await readDaemonServiceStatus();
  if (snapshot.systemService.installed) throw new Error('CodeBuddy 命令已完成，但系统服务仍然存在');
  return { output: stripTerminalFormatting(result.output), snapshot };
}

let daemonServiceOperation = null;

async function runExclusiveDaemonServiceOperation(operation) {
  if (daemonServiceOperation) throw new Error('另一个 Daemon 系统服务操作正在进行，请稍候');
  const promise = Promise.resolve().then(operation);
  daemonServiceOperation = promise;
  try {
    return await promise;
  } finally {
    if (daemonServiceOperation === promise) daemonServiceOperation = null;
  }
}

function parseCodeBuddyCliVersion(value) {
  const output = stripTerminalFormatting(value).trim();
  const match = output.match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/);
  if (!match) throw new Error(`无法识别 CodeBuddy CLI 版本: ${output || '命令未返回版本号'}`);
  return match[1];
}

async function getCodeBuddyCliInfo() {
  // 先解析 spawn spec：PATH/注册表里完全找不到时直接 missing，避免无效 spawn。
  const probeSpec = resolveCodeBuddySpawnSpec(['--version'], process.env);
  if (!probeSpec.resolved) {
    const compat = buildCompatStatus(null, { missing: true });
    return {
      version: null,
      output: '',
      truncated: false,
      compat,
      error: compat.message,
      resolved: false,
      source: null,
    };
  }

  try {
    const result = await runCodeBuddyCli(['--version'], {
      timeoutMs: 10000,
      maxOutputBytes: 64 * 1024,
      timeoutMessage: '读取 CodeBuddy CLI 版本超过 10 秒，已停止命令',
    });
    const output = stripTerminalFormatting(result.output).trim();
    let version = null;
    let parseError = null;
    try {
      version = parseCodeBuddyCliVersion(output);
    } catch (error) {
      parseError = error;
    }
    if (!version) {
      return {
        version: null,
        output,
        truncated: Boolean(result.stdoutTruncated || result.stderrTruncated),
        compat: buildCompatStatus(null, { unknown: true }),
        error: parseError?.message || '无法识别 CodeBuddy CLI 版本',
        resolved: true,
        source: probeSpec.source || null,
      };
    }
    return {
      version,
      output,
      truncated: Boolean(result.stdoutTruncated || result.stderrTruncated),
      compat: buildCompatStatus(version),
      resolved: true,
      source: probeSpec.source || null,
    };
  } catch (error) {
    const message = String(error?.message || error || '');
    const missing = /not found|ENOENT|不是内部或外部命令|无法识别|未找到 CodeBuddy CLI/i.test(message);
    return {
      version: null,
      output: message,
      truncated: false,
      compat: buildCompatStatus(null, missing ? { missing: true } : { unknown: true }),
      error: message || '读取 CodeBuddy CLI 版本失败',
      resolved: Boolean(probeSpec.resolved),
      source: probeSpec.source || null,
    };
  }
}

async function ensureCodeBuddyCliCompatibleForRuntime() {
  const info = await getCodeBuddyCliInfo();
  assertCliCompatibleForRuntime(info.compat);
  return info;
}

async function runCodeBuddyCliDoctor() {
  const result = await runCodeBuddyCli(['doctor'], {
    timeoutMs: 45000,
    maxOutputBytes: 512 * 1024,
    timeoutMessage: 'CodeBuddy CLI 诊断超过 45 秒，已停止命令。请检查 CLI 配置或网络后重试。',
  });
  return {
    output: stripTerminalFormatting(result.output).trim() || '诊断完成，CodeBuddy CLI 未返回文本输出。',
    truncated: Boolean(result.stdoutTruncated || result.stderrTruncated),
  };
}

async function updateCodeBuddyCli() {
  const before = await getCodeBuddyCliInfo();
  if (!before.version) {
    throw new Error(
      before.error ||
        `未找到可用的 CodeBuddy CLI，无法执行 update。请先安装推荐版本 v${RECOMMENDED_VERSION}。`,
    );
  }
  const result = await runCodeBuddyCli(['update'], {
    timeoutMs: 5 * 60 * 1000,
    maxOutputBytes: 1024 * 1024,
    timeoutMessage: 'CodeBuddy CLI 更新超过 5 分钟，已停止命令。请在终端中检查当前安装状态。',
  });
  const after = await getCodeBuddyCliInfo();
  return {
    beforeVersion: before.version,
    afterVersion: after.version,
    changed: before.version !== after.version,
    compat: after.compat,
    output: stripTerminalFormatting(result.output).trim() || '更新命令已完成，CodeBuddy CLI 未返回文本输出。',
    truncated: Boolean(result.stdoutTruncated || result.stderrTruncated),
  };
}

function validateCodeBuddyInstallTarget(value) {
  const target = String(value || '').trim();
  if (target.toLowerCase() === 'latest') return 'latest';
  const version = target.replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('安装目标必须是 latest 或完整版本号，例如 2.120.0');
  }
  return version;
}

function runNpmCli(args, options = {}) {
  const argv = Array.isArray(args) ? args.map((arg) => String(arg)) : [];
  const spec = resolveNpmSpawnSpec(argv, options.env || process.env);
  if (!spec.resolved) {
    const error = new Error(
      '未找到 npm 命令。请先安装 Node.js（含 npm），或在终端执行 npm install -g @tencent-ai/codebuddy-code 后点刷新检测。',
    );
    error.code = 'NPM_NOT_FOUND';
    throw error;
  }
  return runCapturedProcess(spec.command, spec.args, {
    ...options,
    env: spec.env,
  });
}

/**
 * 通过 npm 全局安装/对齐 CodeBuddy CLI（零安装或强制覆盖推荐版）。
 * package 固定为 @tencent-ai/codebuddy-code[@version]
 */
async function bootstrapCodeBuddyCliViaNpm(targetValue = RECOMMENDED_VERSION) {
  const target = validateCodeBuddyInstallTarget(targetValue);
  const pkg = target === 'latest' ? CODEBUDDY_CLI_NPM_PACKAGE : `${CODEBUDDY_CLI_NPM_PACKAGE}@${target}`;
  const before = await getCodeBuddyCliInfo();
  const result = await runNpmCli(['install', '-g', pkg], {
    timeoutMs: 10 * 60 * 1000,
    maxOutputBytes: 2 * 1024 * 1024,
    timeoutMessage: 'npm 安装 CodeBuddy CLI 超过 10 分钟，已停止命令。请检查网络或在终端手动安装。',
  });
  const after = await getCodeBuddyCliInfo();
  if (!after.version) {
    throw new Error(
      after.error ||
        `npm 安装已完成，但仍无法读取 CodeBuddy CLI 版本。请确认 PATH 中存在 codebuddy（常见于 %APPDATA%\\npm），必要时重启桌面端。推荐版本 v${RECOMMENDED_VERSION}。`,
    );
  }
  return {
    method: 'npm',
    package: pkg,
    target,
    beforeVersion: before.version || null,
    afterVersion: after.version,
    changed: before.version !== after.version,
    compat: after.compat,
    output: stripTerminalFormatting(result.output).trim() || 'npm 安装已完成。',
    truncated: Boolean(result.stdoutTruncated || result.stderrTruncated),
  };
}

async function installCodeBuddyCli(targetValue) {
  const target = validateCodeBuddyInstallTarget(targetValue);
  const before = await getCodeBuddyCliInfo();
  // 尚无 codebuddy 时走 npm 全局安装；已有 CLI 则优先 codebuddy install。
  if (!before.version || before.compat?.status === 'missing') {
    return bootstrapCodeBuddyCliViaNpm(target);
  }

  let result;
  try {
    result = await runCodeBuddyCli(['install', target], {
      timeoutMs: 10 * 60 * 1000,
      maxOutputBytes: 1024 * 1024,
      timeoutMessage: 'CodeBuddy CLI 安装超过 10 分钟，已停止命令。请在终端中检查当前安装状态。',
    });
  } catch (error) {
    const message = String(error?.message || error || '');
    if (/not found|ENOENT|不是内部或外部命令|未找到 CodeBuddy CLI/i.test(message)) {
      // codebuddy 半残时回退 npm
      return bootstrapCodeBuddyCliViaNpm(target);
    }
    throw error;
  }
  const after = await getCodeBuddyCliInfo();
  if (!after.version) {
    throw new Error(
      after.error ||
        `安装命令已完成，但仍无法读取 CodeBuddy CLI 版本。请确认 PATH 中存在 codebuddy，并安装推荐版本 v${RECOMMENDED_VERSION}。`,
    );
  }
  return {
    method: 'codebuddy',
    target,
    beforeVersion: before.version || null,
    afterVersion: after.version,
    changed: before.version !== after.version,
    compat: after.compat,
    output: stripTerminalFormatting(result.output).trim() || '安装命令已完成，CodeBuddy CLI 未返回文本输出。',
    truncated: Boolean(result.stdoutTruncated || result.stderrTruncated),
  };
}

/**
 * 一键修复：missing/unknown → npm 装推荐版；outdated → codebuddy install 推荐版（失败再 npm）。
 */
async function ensureRecommendedCodeBuddyCli() {
  const before = await getCodeBuddyCliInfo();
  const status = before.compat?.status;
  if (status === 'ok' || status === 'newer') {
    return {
      method: 'noop',
      target: RECOMMENDED_VERSION,
      beforeVersion: before.version || null,
      afterVersion: before.version || null,
      changed: false,
      compat: before.compat,
      output: before.compat?.message || '当前 CodeBuddy CLI 已满足要求。',
      truncated: false,
    };
  }
  if (status === 'outdated' && before.version) {
    try {
      return await installCodeBuddyCli(RECOMMENDED_VERSION);
    } catch (error) {
      // install 失败时再尝试 npm 强制覆盖
      const npmResult = await bootstrapCodeBuddyCliViaNpm(RECOMMENDED_VERSION);
      return {
        ...npmResult,
        output: `${String(error?.message || error || '')}\n\n已回退 npm 安装：\n${npmResult.output}`.trim(),
      };
    }
  }
  return bootstrapCodeBuddyCliViaNpm(RECOMMENDED_VERSION);
}

let cliMaintenanceOperation = null;

async function runExclusiveCliMaintenanceOperation(operation) {
  if (cliMaintenanceOperation) throw new Error('另一个 CodeBuddy CLI 维护操作正在进行，请稍候');
  const promise = Promise.resolve().then(operation);
  cliMaintenanceOperation = promise;
  try {
    return await promise;
  } finally {
    if (cliMaintenanceOperation === promise) cliMaintenanceOperation = null;
  }
}

const PLUGIN_MAINTENANCE_SCOPES = new Set(['user', 'project', 'local']);

function validatePluginMaintenanceScope(value) {
  const scope = String(value || 'user').trim();
  if (!PLUGIN_MAINTENANCE_SCOPES.has(scope)) throw new Error('插件维护作用域无效');
  return scope;
}

function validatePluginMaintenanceId(value) {
  const plugin = String(value || '').trim();
  if (!plugin || plugin.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._/@-]*$/.test(plugin)) {
    throw new Error('插件 ID 格式无效');
  }
  return plugin;
}

function validatePluginMaintenanceCwd(value) {
  const raw = String(value || '').trim();
  if (!raw) return os.homedir();
  if (!path.isAbsolute(raw)) throw new Error('插件维护需要有效的项目绝对路径');
  const cwd = path.resolve(raw);
  try {
    if (!fs.statSync(cwd).isDirectory()) throw new Error('not a directory');
  } catch (_) {
    throw new Error(`项目目录不存在或不可访问: ${cwd}`);
  }
  return cwd;
}

function parseTrailingJsonArray(value) {
  const output = String(value || '').trim();
  const start = output.lastIndexOf('[');
  if (start < 0) return [];
  try {
    const parsed = JSON.parse(output.slice(start));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

async function updateInstalledPlugin(payload = {}) {
  const plugin = validatePluginMaintenanceId(payload.plugin);
  const scope = validatePluginMaintenanceScope(payload.scope);
  const cwd = validatePluginMaintenanceCwd(payload.cwd);
  const result = await runCodeBuddyCli(['plugin', 'update', plugin, '--scope', scope], {
    cwd,
    timeoutMs: 2 * 60 * 1000,
    maxOutputBytes: 512 * 1024,
    timeoutMessage: '插件更新超过 2 分钟，已停止命令。请检查当前插件安装状态。',
  });
  return {
    plugin,
    scope,
    output: stripTerminalFormatting(result.output).trim() || '插件更新命令已完成，CodeBuddy CLI 未返回文本输出。',
    truncated: Boolean(result.stdoutTruncated || result.stderrTruncated),
  };
}

async function previewPluginDependencyPrune(payload = {}) {
  const scope = validatePluginMaintenanceScope(payload.scope);
  const cwd = validatePluginMaintenanceCwd(payload.cwd);
  const result = await runCodeBuddyCli(['plugin', 'prune', '--scope', scope, '--dry-run'], {
    cwd,
    timeoutMs: 60000,
    maxOutputBytes: 512 * 1024,
    timeoutMessage: '插件依赖检查超过 60 秒，已停止命令。',
  });
  const output = stripTerminalFormatting(result.output).trim() || '未发现可清理的插件依赖。';
  const items = parseTrailingJsonArray(output);
  return {
    scope,
    items,
    hasChanges: items.length > 0,
    output,
    truncated: Boolean(result.stdoutTruncated || result.stderrTruncated),
  };
}

async function prunePluginDependencies(payload = {}) {
  const scope = validatePluginMaintenanceScope(payload.scope);
  const cwd = validatePluginMaintenanceCwd(payload.cwd);
  const result = await runCodeBuddyCli(['plugin', 'prune', '--scope', scope, '--yes'], {
    cwd,
    timeoutMs: 2 * 60 * 1000,
    maxOutputBytes: 512 * 1024,
    timeoutMessage: '插件依赖清理超过 2 分钟，已停止命令。请检查当前插件安装状态。',
  });
  return {
    scope,
    output: stripTerminalFormatting(result.output).trim() || '插件依赖清理命令已完成，CodeBuddy CLI 未返回文本输出。',
    truncated: Boolean(result.stdoutTruncated || result.stderrTruncated),
  };
}

logStartup('main.cjs loaded');

/**
 * Validate that a URL points at a locally-hosted CodeBuddy runtime (or, in dev,
 * the Vite dev server). Previously both codebuddy:openStream and
 * codebuddy:request accepted ANY 127.0.0.1/localhost port, so a renderer
 * compromise (or XSS) could pivot to other local services on the loopback
 * interface — a limited SSRF surface. This tightens the port set to:
 *   - the ports of currently-running CodeBuddy runtimes (runtimeManager.list),
 *   - the packaged static-content server port (prodServerPort),
 *   - the Vite dev server port 5173 (only when allowDevPort and isDev).
 * Hostnames are limited to 127.0.0.1 / localhost / [::1].
 */
function isAllowedLocalRuntimeUrl(rawUrl, { allowDevPort = false } = {}) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ''));
  } catch (_) {
    return false;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (!localHosts.has(parsed.hostname)) return false;
  const port = Number(parsed.port);
  if (!Number.isFinite(port) || port <= 0) return false;
  const allowed = new Set();
  try {
    for (const r of runtimeManager.list()) {
      if (r && r.port) allowed.add(Number(r.port));
    }
  } catch (_) {}
  if (prodServerPort) allowed.add(Number(prodServerPort));
  if (allowDevPort && isDev) allowed.add(5173);
  return allowed.has(port);
}

function assertTrustedRuntimeCwd(projectId, cwd) {
  if (!workspaceTrust.isTrustedCwd(cwd)) {
    throw new Error('untrusted workspace cwd');
  }
  const state = productStateStore.load();
  const project = projectId ? state.projectsById?.[projectId] : null;
  if (project?.workspacePath) {
    const expected = path.resolve(project.workspacePath);
    let actual;
    try {
      actual = path.resolve(cwd);
    } catch (_) {
      throw new Error('invalid cwd');
    }
    if (actual !== expected) {
      throw new Error('cwd does not match project workspace');
    }
  }
}

const runtimeManager = createCodeBuddyRuntimeManager({
  net,
  logger: (message) => logStartup(redactSecrets(message)),
  onStatus: (runtime) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('runtime:status', runtime);
    }
  },
});

ipcMain.handle('runtime:ensure', async (_event, request = {}) => {
  await ensureCodeBuddyCliCompatibleForRuntime();
  assertTrustedRuntimeCwd(request.projectId, request.cwd);
  return runtimeManager.ensure(request.projectId, request.cwd, {
    accountLoginSite: request.accountLoginSite,
  });
});
ipcMain.handle('runtime:list', () => runtimeManager.list());
ipcMain.handle('workflow:readProgress', (_event, request = {}) =>
  readProjectWorkflowProgress({
    runtimeManager,
    configRoot: String(process.env.CODEBUDDY_CONFIG_DIR || '').trim() || path.join(os.homedir(), '.codebuddy'),
    request,
  }),
);
ipcMain.handle('runtime:stop', (_event, projectId) => runtimeManager.stop(projectId));
ipcMain.handle('runtime:restart', async (_event, request = {}) => {
  await ensureCodeBuddyCliCompatibleForRuntime();
  assertTrustedRuntimeCwd(request.projectId, request.cwd);
  return runtimeManager.restart(request.projectId, request.cwd, {
    accountLoginSite: request.accountLoginSite,
  });
});
ipcMain.handle('cliAuth:getDiskAuth', () => {
  try {
    const { readCodeBuddyDiskAuth, resolveAccountLoginSiteForRuntime } = require('./codebuddy-auth-site.cjs');
    const disk = readCodeBuddyDiskAuth(process.env);
    return {
      ...disk,
      resolvedSite: resolveAccountLoginSiteForRuntime(null, process.env),
    };
  } catch (error) {
    return {
      site: null,
      domain: null,
      userId: null,
      nickname: null,
      path: null,
      resolvedSite: 'global',
      error: error?.message || String(error),
    };
  }
});
ipcMain.handle('notification:consumeOpenThread', () => {
  const target = pendingNotificationTarget;
  pendingNotificationTarget = null;
  return target;
});

ipcMain.handle('notification:showTaskResult', async (_event, payload = {}) => {
  if (reallyQuitting || !Notification.isSupported()) return { shown: false, reason: 'unsupported' };
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) {
    return { shown: false, reason: 'window-focused' };
  }

  const title = String(payload.title || 'CodeBuddy Desktop')
    .trim()
    .slice(0, 120);
  const body = String(payload.body || '')
    .trim()
    .slice(0, 500);
  const target = {
    projectId: typeof payload.projectId === 'string' ? payload.projectId : null,
    threadId: typeof payload.threadId === 'string' ? payload.threadId : null,
  };

  try {
    const notification = new Notification({
      title,
      body,
      icon: path.join(__dirname, '..', 'build', 'icon.png'),
      silent: false,
    });
    activeTaskNotifications.add(notification);
    const release = () => activeTaskNotifications.delete(notification);
    notification.once('close', release);
    notification.once('failed', release);
    notification.once('click', async () => {
      release();
      pendingNotificationTarget = target;
      const windowResult = showOrCreateMainWindow();
      if (windowResult && typeof windowResult.then === 'function') await windowResult;
    });
    notification.show();
    // Mirror task notifications to paired mobile-remote clients (in-connection).
    if (mobileRemoteHost) {
      try {
        mobileRemoteHost.broadcast({
          type: 'notify',
          title,
          body,
          projectId: target.projectId,
          threadId: target.threadId,
        });
      } catch (_) {
        /* non-blocking */
      }
    }
    return { shown: true };
  } catch (error) {
    logStartup(`Task notification failed: ${error?.message || error}`);
    return { shown: false, reason: error?.message || String(error) };
  }
});

ipcMain.handle('app:checkForUpdates', async () => {
  const currentVersion = app.getVersion();
  const timeout = createTimeoutSignal(15000);
  try {
    const response = await net.fetch(GUI_LATEST_RELEASE_API, {
      signal: timeout.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `CodeBuddy-GUI/${currentVersion}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (response.status === 404) {
      return {
        status: 'no-release',
        currentVersion,
        latestVersion: null,
        updateAvailable: false,
        releaseUrl: GUI_RELEASES_URL,
      };
    }
    if (!response.ok) throw new Error(`GitHub Releases 请求失败: ${response.status} ${response.statusText}`);
    const release = await response.json();
    const latestVersion = String(release?.tag_name || '')
      .trim()
      .replace(/^v/i, '');
    if (!latestVersion || !/^\d+(?:\.\d+){0,3}(?:[-+].*)?$/.test(latestVersion)) {
      throw new Error('最新发布版本号格式无效');
    }
    const installerName = `CodeBuddy-GUI-Setup-${latestVersion}.exe`;
    const installerAsset = Array.isArray(release?.assets)
      ? release.assets.find((asset) => asset?.name === installerName)
      : null;
    const downloadUrl = trustedGuiDownloadUrl(installerAsset?.browser_download_url);
    return {
      status: 'ok',
      currentVersion,
      latestVersion,
      updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
      releaseUrl: trustedGuiReleaseUrl(release?.html_url),
      downloadUrl,
      downloadAvailable: Boolean(downloadUrl),
      publishedAt: release?.published_at || null,
    };
  } catch (error) {
    const message = error?.name === 'AbortError' ? 'GitHub Releases 请求超时' : error?.message || String(error);
    logStartup(`GUI update check failed: ${message}`);
    return {
      status: 'error',
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: GUI_RELEASES_URL,
      error: message,
    };
  } finally {
    timeout.cleanup();
  }
});

ipcMain.handle('app:openReleasePage', async (_event, releaseUrl) => {
  const target = trustedGuiReleaseUrl(releaseUrl);
  await shell.openExternal(target);
  return { url: target };
});

ipcMain.handle('app:openUpdateDownload', async (_event, downloadUrl) => {
  const target = trustedGuiDownloadUrl(downloadUrl);
  if (!target) throw new Error('Windows 安装包下载地址无效，请改用发布页下载');
  await shell.openExternal(target);
  return { url: target };
});

// 登录链接兜底：CLI 推送 _codebuddy.ai/authUrl 时由 GUI 打开默认浏览器
// （Windows 上 CLI 的 rundll32 url,OpenURL 静默失败，不能依赖它）。
// 校验与渲染进程外链一致：仅 http/https、无内嵌凭据。
ipcMain.handle('app:openExternal', async (_event, rawUrl) => {
  const target = normalizeExternalHttpUrl(rawUrl);
  if (!target) throw new Error('只允许打开 http/https 地址');
  await shell.openExternal(target);
  return { url: target };
});

ipcMain.handle('app:getInfo', () => ({
  name: app.getName(),
  version: app.getVersion(),
  packaged: app.isPackaged,
  userDataPath: app.getPath('userData'),
}));

function requireTrustedMainSender(event) {
  if (!isTrustedMainSender(event.sender, mainWindow)) {
    throw new Error('forbidden: untrusted sender');
  }
}

// 手机远程（mobile-remote）：与微信/企微「远程控制」channel 分离
ipcMain.handle('mobileRemote:getStatus', async (event) => {
  requireTrustedMainSender(event);
  return getMobileRemoteHost().getStatus();
});
ipcMain.handle('mobileRemote:getConfig', (event) => {
  requireTrustedMainSender(event);
  return readMobileRemoteConfig();
});
ipcMain.handle('mobileRemote:setConfig', async (event, config = {}) => {
  requireTrustedMainSender(event);
  const next = writeMobileRemoteConfig(config);
  const host = getMobileRemoteHost();
  let startError = null;
  if (next.enabled) {
    try {
      await host.start();
    } catch (error) {
      startError = error?.message || String(error);
      logStartup(`mobileRemote start failed: ${startError}`);
      // Roll back enabled so the persisted config does not claim the host is on
      // while it is actually not running (the renderer would otherwise show
      // enabled=true with no running status and no explanation). Stop anything
      // that partially started, then persist enabled=false.
      const rolled = writeMobileRemoteConfig({ ...readMobileRemoteConfig(), enabled: false });
      await host.stop().catch(() => {});
      return { config: rolled, status: host.getStatus(), startError };
    }
  } else {
    await host.stop();
  }
  return { config: next, status: host.getStatus(), startError };
});
ipcMain.handle('mobileRemote:getPairingOffer', async (event) => {
  requireTrustedMainSender(event);
  return getMobileRemoteHost().getPairingOffer();
});
ipcMain.handle('mobileRemote:getPairingOfferWithToken', async (event) => {
  requireTrustedMainSender(event);
  return getMobileRemoteHost().getPairingOffer();
});
ipcMain.handle('mobileRemote:start', async (event) => {
  requireTrustedMainSender(event);
  const config = writeMobileRemoteConfig({ ...readMobileRemoteConfig(), enabled: true });
  const status = await getMobileRemoteHost().start();
  return { config, status };
});
ipcMain.handle('mobileRemote:stop', async (event) => {
  requireTrustedMainSender(event);
  const config = writeMobileRemoteConfig({ ...readMobileRemoteConfig(), enabled: false });
  const status = await getMobileRemoteHost().stop();
  return { config, status };
});
ipcMain.handle('mobileRemote:listDevices', (event) => {
  requireTrustedMainSender(event);
  return getMobileRemoteHost().listDevices();
});
ipcMain.handle('mobileRemote:revokeDevice', async (event, deviceId) => {
  requireTrustedMainSender(event);
  return getMobileRemoteHost().revokeDevice(deviceId);
});

ipcMain.handle('mcp:listConfigs', (_event, cwd) => {
  if (!workspaceTrust.isTrustedCwd(cwd)) {
    throw new Error('mcp cwd is not a trusted workspace');
  }
  return listConfiguredMcpServers(cwd);
});
ipcMain.handle('sandbox:list', () => readSandboxSnapshot());
ipcMain.handle('sandbox:kill', (_event, sandboxId) =>
  runExclusiveSandboxOperation(['kill', validateSandboxId(sandboxId)]),
);
ipcMain.handle('sandbox:clean', () => runExclusiveSandboxOperation(['clean']));
ipcMain.handle('backgroundSession:list', () => listBackgroundSessions());
ipcMain.handle('backgroundSession:start', (_event, payload) =>
  runExclusiveBackgroundSessionOperation(() => startBackgroundSession(payload)),
);
ipcMain.handle('backgroundSession:logs', (_event, pid) => readBackgroundSessionLogs(pid));
ipcMain.handle('backgroundSession:kill', (_event, pid) =>
  runExclusiveBackgroundSessionOperation(() => killBackgroundSession(pid)),
);
ipcMain.handle('backgroundSession:openEndpoint', (_event, endpoint) => openBackgroundSessionEndpoint(endpoint));
ipcMain.handle('backgroundSession:attach', (_event, pid) => attachBackgroundSession(pid));
ipcMain.handle('daemonService:status', () => readDaemonServiceStatus());
ipcMain.handle('daemonService:install', (_event, payload) =>
  runExclusiveDaemonServiceOperation(() => installDaemonService(payload)),
);
ipcMain.handle('daemonService:uninstall', () => runExclusiveDaemonServiceOperation(() => uninstallDaemonService()));
ipcMain.handle('cliMaintenance:getInfo', () => getCodeBuddyCliInfo());
ipcMain.handle('cliMaintenance:doctor', () => runExclusiveCliMaintenanceOperation(() => runCodeBuddyCliDoctor()));
ipcMain.handle('cliMaintenance:update', () => runExclusiveCliMaintenanceOperation(() => updateCodeBuddyCli()));
ipcMain.handle('cliMaintenance:install', (_event, target) =>
  runExclusiveCliMaintenanceOperation(() => installCodeBuddyCli(target)),
);
ipcMain.handle('cliMaintenance:ensureRecommended', () =>
  runExclusiveCliMaintenanceOperation(() => ensureRecommendedCodeBuddyCli()),
);
ipcMain.handle('pluginMaintenance:update', (_event, payload) =>
  runExclusiveCliMaintenanceOperation(() => updateInstalledPlugin(payload)),
);
ipcMain.handle('pluginMaintenance:previewPrune', (_event, payload) =>
  runExclusiveCliMaintenanceOperation(() => previewPluginDependencyPrune(payload)),
);
ipcMain.handle('pluginMaintenance:prune', (_event, payload) =>
  runExclusiveCliMaintenanceOperation(() => prunePluginDependencies(payload)),
);
ipcMain.handle('modelConfig:list', () => listModelConfig());
ipcMain.handle('modelConfig:save', (_event, payload) => saveModelConfig(payload));
ipcMain.handle('modelConfig:delete', (_event, modelId) => deleteModelConfig(modelId));
ipcMain.handle('modelConfig:open', async () => {
  const filePath = ensureModelConfigFile();
  shell.showItemInFolder(filePath);
  return { filePath };
});

ipcMain.handle('app:reportRendererError', (_event, payload = {}) => {
  const kind =
    String(payload.kind || 'reactErrorBoundary')
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 40) || 'rendererError';
  const message = String(payload.message || 'Renderer error').slice(0, 4000);
  const stack = String(payload.stack || '').slice(0, 40000);
  const componentStack = String(payload.componentStack || '').slice(0, 20000);
  const route = String(payload.route || '').slice(0, 500);
  writeCrashLog('renderer:' + kind, {
    stack: [message, stack, componentStack && 'Component stack:' + componentStack, route && 'Route: ' + route]
      .filter(Boolean)
      .join('\n'),
  });
  return { reported: true };
});

ipcMain.handle('app:exportDiagnostics', async () => {
  const timestamp = new Date().toISOString();
  const fileTimestamp = timestamp.replace(/[:.]/g, '-');
  const saveOptions = {
    title: '导出 CodeBuddy Desktop 诊断报告',
    defaultPath: `CodeBuddy-GUI-diagnostics-${fileTimestamp}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  };
  const result =
    mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showSaveDialog(mainWindow, saveOptions)
      : await dialog.showSaveDialog(saveOptions);
  if (result.canceled || !result.filePath) return { canceled: true };

  const runtimes = runtimeManager.list().map((runtime) => ({
    projectId: runtime.projectId,
    cwd: runtime.cwd ? '[redacted-project-path]' : null,
    cwdAccessible: runtime.cwd ? fs.existsSync(runtime.cwd) : false,
    status: runtime.status,
    port: runtime.port,
    pid: runtime.pid,
    error: runtime.error ? redactProjectPath(runtime.error, runtime.cwd) : null,
    startedAt: runtime.startedAt,
  }));
  const windowState =
    mainWindow && !mainWindow.isDestroyed()
      ? {
          visible: mainWindow.isVisible(),
          focused: mainWindow.isFocused(),
          minimized: mainWindow.isMinimized(),
          maximized: mainWindow.isMaximized(),
          bounds: mainWindow.getBounds(),
        }
      : null;
  const report = {
    schemaVersion: 1,
    generatedAt: timestamp,
    app: {
      name: app.getName(),
      version: app.getVersion(),
      packaged: app.isPackaged,
      userDataPath: redactDiagnosticText(app.getPath('userData')),
    },
    system: {
      platform: process.platform,
      arch: process.arch,
      release: require('os').release(),
      locale: app.getLocale(),
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        v8: process.versions.v8,
      },
    },
    window: windowState,
    runtimes,
    logs: {
      startup: readDiagnosticLog(startupLog),
      crash: readDiagnosticLog(path.join(app.getPath('userData'), 'crash.log')),
    },
    exclusions: [
      'project files',
      'project paths',
      'conversation content',
      'drafts',
      'product-state.json',
      'runtime passwords',
    ],
  };
  await fs.promises.writeFile(result.filePath, JSON.stringify(report, null, 2), 'utf8');
  return { canceled: false, path: result.filePath };
});

ipcMain.handle('app:openUserData', async () => {
  const userDataPath = app.getPath('userData');
  await fs.promises.mkdir(userDataPath, { recursive: true });
  const openError = await shell.openPath(userDataPath);
  if (openError) throw new Error(openError);
  return { path: userDataPath };
});

function getRendererEntry() {
  if (isDev) return 'http://localhost:5173';
  return `http://127.0.0.1:${prodServerPort}/index.html`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probeUrl(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForRenderer(url, attempts = 30) {
  if (!isDev) return true;
  for (let i = 0; i < attempts; i += 1) {
    const ok = await probeUrl(url);
    logStartup(`probe ${i + 1}/${attempts} ${url} => ${ok}`);
    if (ok) return true;
    await wait(500);
  }
  return false;
}

async function createWindow() {
  logStartup('createWindow called');
  let entry = getRendererEntry();
  const ready = await waitForRenderer(entry, 40);
  logStartup(`renderer ready=${ready} entry=${entry}`);

  // 如果 Vite dev server 不可达，回退到本地 HTTP 生产构建
  if (!ready && isDev) {
    const prodIndex = path.join(__dirname, '..', 'out', 'dist', 'index.html');
    if (fs.existsSync(prodIndex)) {
      entry = `http://127.0.0.1:${prodServerPort}/index.html`;
      logStartup(`dev server unreachable, falling back to ${entry}`);
    }
  }

  // 恢复上次窗口状态（P0-3）：bounds + isMaximized，最小化不存
  const restoredWindowState = readWindowState();
  const savedBounds = restoredWindowBounds(restoredWindowState);
  const defaultBounds = primaryCenteredBounds();
  closeToTrayHintShown = Boolean(restoredWindowState?.closeToTrayHintShown);
  const winOpts = {
    width: savedBounds?.width || defaultBounds.width,
    height: savedBounds?.height || defaultBounds.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    title: 'CodeBuddy Desktop',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // L2: gate DevTools on isDev so production builds cannot detach DevTools
      // (sandbox+CSP already neutralize the privilege, this removes the surface).
      devTools: isDev,
      // Keep timers/stream paint alive while the window is unfocused so returning
      // from another app does not dump multi-second backlog and freeze the UI.
      backgroundThrottling: false,
    },
  };
  if (savedBounds?.x != null && savedBounds?.y != null) {
    winOpts.x = savedBounds.x;
    winOpts.y = savedBounds.y;
  } else {
    winOpts.x = defaultBounds.x;
    winOpts.y = defaultBounds.y;
  }
  mainWindow = new BrowserWindow(winOpts);
  const loadTrustedRendererUrl = (url) => {
    trustedRendererOrigin = rendererOriginForEntry(url);
    return mainWindow.loadURL(url);
  };
  const guardRendererNavigation = (event, url) => {
    if (isTrustedRendererNavigation(url, trustedRendererOrigin)) return;
    event.preventDefault();
    const externalUrl = normalizeExternalHttpUrl(url);
    if (externalUrl) {
      shell.openExternal(externalUrl).catch((error) => {
        logStartup(`Unable to open external navigation target: ${error?.message || error}`);
      });
    } else {
      logStartup(`Blocked renderer navigation to unsupported target: ${redactDiagnosticText(url)}`);
    }
  };
  mainWindow.webContents.on('will-navigate', guardRendererNavigation);
  mainWindow.webContents.on('will-redirect', guardRendererNavigation);
  mainWindow.webContents.on('context-menu', (_event, params) => {
    // 生产构建钳制 Chromium 默认右键菜单（Inspect/Reload 等调试入口，devTools
    // 已被 devTools:false 禁用，这里再堵掉右键入口）。编辑区内保留剪贴板
    // 操作；非编辑区选中文本时保留“复制”（与原生右键行为一致，避免功能
    // 丢失）；业务右键菜单由渲染层组件自行渲染。
    if (isDev) return;
    const template = [];
    if (params.isEditable) {
      template.push(
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' },
      );
    } else if (params.selectionText) {
      template.push({ role: 'copy', label: '复制' });
    }
    if (!template.length) return;
    Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const externalUrl = normalizeExternalHttpUrl(url);
    if (externalUrl) {
      shell.openExternal(externalUrl).catch((error) => {
        logStartup(`Unable to open external window target: ${error?.message || error}`);
      });
    } else {
      logStartup(`Blocked external window target: ${redactDiagnosticText(url)}`);
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('render-process-gone', async (_event, details = {}) => {
    const reason = details.reason || 'unknown';
    writeCrashLog('renderProcessGone', new Error('reason=' + reason + ' exitCode=' + (details.exitCode ?? 'unknown')));
    if (reallyQuitting || reason === 'clean-exit') return;
    const targetWindow = mainWindow;
    try {
      const options = {
        type: 'error',
        title: 'CodeBuddy Desktop 界面异常退出',
        message: '应用界面进程已异常退出，错误已写入 crash.log。',
        detail: '可以重新加载界面，或先打开诊断目录获取日志。',
        buttons: ['重新加载界面', '打开诊断目录并重新加载', '退出应用'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      };
      const result =
        targetWindow && !targetWindow.isDestroyed()
          ? await dialog.showMessageBox(targetWindow, options)
          : await dialog.showMessageBox(options);
      if (result.response === 2) {
        beginFinalApplicationExit('renderer-crash-dialog');
        return;
      }
      if (result.response === 1) {
        const userDataPath = app.getPath('userData');
        await fs.promises.mkdir(userDataPath, { recursive: true });
        const openError = await shell.openPath(userDataPath);
        if (openError) logStartup('Unable to open diagnostics after renderer exit: ' + openError);
      }
      // A crashed renderer can never finish the quit handshake (its requestId is
      // lost), so a pending request would deadlock every later quit attempt via
      // hasPending(). Cancel it before reloading; the user can retry tray exit.
      const pendingQuitRequestId = quitRequestController.currentRequestId();
      if (pendingQuitRequestId) quitRequestController.cancel(pendingQuitRequestId);
      if (targetWindow && !targetWindow.isDestroyed()) targetWindow.reload();
    } catch (error) {
      logStartup('Renderer exit recovery failed: ' + (error?.message || error));
      if (targetWindow && !targetWindow.isDestroyed()) targetWindow.reload();
    }
  });
  mainWindow.on('unresponsive', () => logStartup('Main window became unresponsive'));
  mainWindow.on('responsive', () => logStartup('Main window became responsive again'));
  if (savedBounds?.isMaximized) {
    mainWindow.maximize();
  }

  // 窗口状态持久化（P0-3）：关闭/最大化/移动/缩放时存，最小化不存
  const saveWindowState = (options = {}) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const minimized = mainWindow.isMinimized();
    if (minimized && !options.allowMinimized) return;
    const isMax = mainWindow.isMaximized();
    const b = minimized
      ? lastNormalBounds || mainWindow.getNormalBounds()
      : isMax
        ? lastNormalBounds || mainWindow.getNormalBounds()
        : mainWindow.getBounds();
    if (!isMax && !minimized) lastNormalBounds = b;
    writeWindowState({ ...b, isMaximized: isMax, closeToTrayHintShown });
  };
  let lastNormalBounds = null;
  mainWindow.on('resize', saveWindowState);
  mainWindow.on('move', saveWindowState);
  mainWindow.on('maximize', () => {
    lastNormalBounds = mainWindow.getNormalBounds();
    saveWindowState();
  });
  mainWindow.on('unmaximize', saveWindowState);
  mainWindow.on('close', (event) => {
    if (!reallyQuitting && tray) {
      event.preventDefault();
      const shouldShowHint = !closeToTrayHintShown;
      closeToTrayHintShown = true;
      saveWindowState({ allowMinimized: true });
      mainWindow.hide();
      if (shouldShowHint) setTimeout(showCloseToTrayHint, 150);
      return;
    }
    saveWindowState();
  });
  mainWindow.on('closed', () => {
    closeRightBrowserView();
    mainWindow = null;
  });

  loadTrustedRendererUrl(entry).catch((error) => {
    logStartup(`loadURL failed: ${error?.message || error}`);
    // 生产模式无 did-fail-load 兜底，失败时给用户可见提示而非黑屏静默
    if (!isDev && mainWindow && !mainWindow.isDestroyed()) {
      try {
        dialog.showErrorBox(
          'CodeBuddy Desktop 加载失败',
          `无法加载应用界面：\n\n${error?.message || error}\n\n启动日志已写入 userData/electron-startup.log，重启应用前建议反馈给开发者。`,
        );
      } catch (_) {}
    }
  });

  // 捕获渲染进程控制台全级别输出（dev 模式详记，生产只记 WARN+）
  // Electron 32+ passes a single event object; the legacy positional signature
  // (level, message, line, sourceId) is removed in Electron 36.
  mainWindow.webContents.on('console-message', (event) => {
    const level = event.level;
    const message = event.message;
    const line = event.lineNumber;
    const sourceId = event.sourceId;
    if (isDev || level >= 2) {
      const tag = level === 3 ? 'ERROR' : level === 2 ? 'WARN' : level === 1 ? 'INFO' : 'LOG';
      const src = sourceId ? ` @${String(sourceId).split('/').slice(-2).join('/')}:${line}` : '';
      // L3: redact secrets from renderer console logs (a renderer that warns
      // with a token/URL would otherwise persist it to startup.log).
      logStartup(`renderer [${tag}]${src}: ${redactSecrets(String(message))}`);
    }
  });

  if (isDev) {
    mainWindow.webContents.on('did-fail-load', (_event, code, desc, validatedURL) => {
      logStartup(`did-fail-load code=${code} desc=${desc} url=${validatedURL}`);
      setTimeout(async () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          const ok = await waitForRenderer(entry, 10);
          logStartup(`retry after fail ready=${ok}`);
          // 如果 Vite 仍然不可达，回退到生产构建
          if (!ok) {
            const prodIndex = path.join(__dirname, '..', 'out', 'dist', 'index.html');
            if (fs.existsSync(prodIndex)) {
              const prodUrl = `http://127.0.0.1:${prodServerPort}/index.html`;
              logStartup(`fallback to prod: ${prodUrl}`);
              loadTrustedRendererUrl(prodUrl).catch(() => {});
              return;
            }
          }
          loadTrustedRendererUrl(entry).catch(() => {});
        }
      }, 1200);
    });
  }
}

function closeRightBrowserView() {
  if (!rightBrowserView) return false;
  try {
    if (rightBrowserView instanceof BrowserView) {
      mainWindow?.removeBrowserView(rightBrowserView);
    } else {
      mainWindow?.contentView?.removeChildView?.(rightBrowserView);
    }
  } catch (_) {}
  try {
    rightBrowserView.webContents?.close?.();
  } catch (_) {}
  rightBrowserView = null;
  return true;
}

function rightBrowserBounds(bounds = {}) {
  const x = Number(bounds.x);
  const y = Number(bounds.y);
  const width = Number(bounds.width);
  const height = Number(bounds.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  if (x < 0 || y < 0 || width > 10000 || height > 10000) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

function createRightBrowserView() {
  if (rightBrowserView || !mainWindow || mainWindow.isDestroyed()) return rightBrowserView;
  const BrowserSurface = WebContentsView || BrowserView;
  if (!BrowserSurface) throw new Error('当前 Electron 不支持内置浏览器');
  const browserSession = session.fromPartition('persist:codebuddy-right-browser');
  rightBrowserView = new BrowserSurface({
    webPreferences: {
      session: browserSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  if (rightBrowserView instanceof BrowserView) {
    mainWindow.setBrowserView(rightBrowserView);
  } else {
    mainWindow.contentView.addChildView(rightBrowserView);
  }
  rightBrowserView.webContents.setWindowOpenHandler(({ url }) => {
    const target = normalizeExternalHttpUrl(url);
    if (target) rightBrowserView.webContents.loadURL(target).catch(() => {});
    return { action: 'deny' };
  });
  const guard = (_event, url) => {
    if (normalizeExternalHttpUrl(url)) return;
    try { _event.preventDefault(); } catch (_) {}
  };
  rightBrowserView.webContents.on('will-navigate', guard);
  rightBrowserView.webContents.on('will-redirect', guard);
  rightBrowserView.webContents.on('did-navigate', (_event, url) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('rightBrowser:state', { url });
  });
  rightBrowserView.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('rightBrowser:state', { errorCode, errorDescription, url: validatedURL });
  });
  return rightBrowserView;
}

ipcMain.handle('rightBrowser:open', async (_event, rawUrl) => {
  const target = normalizeExternalHttpUrl(rawUrl);
  if (!target) throw new Error('只允许打开无凭据的 http/https 地址');
  const view = createRightBrowserView();
  await view.webContents.loadURL(target);
  return { url: target };
});

ipcMain.on('rightBrowser:setBounds', (_event, rawBounds) => {
  const bounds = rightBrowserBounds(rawBounds);
  if (!bounds || !rightBrowserView || !mainWindow || mainWindow.isDestroyed()) return;
  if (rightBrowserView instanceof BrowserView) mainWindow.setBrowserView(rightBrowserView);
  rightBrowserView.setBounds(bounds);
});

ipcMain.handle('rightBrowser:close', () => closeRightBrowserView());

function showOrCreateMainWindow() {
  if (!app.isReady() || (!isDev && !prodServerPort)) return null;
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (!windowCreationPromise) {
      windowCreationPromise = createWindow()
        .catch((error) => {
          logStartup(`Window creation failed: ${error?.stack || error}`);
          try {
            dialog.showErrorBox('CodeBuddy Desktop 启动失败', error?.message || String(error));
          } catch (_) {}
        })
        .finally(() => {
          windowCreationPromise = null;
        });
    }
    return windowCreationPromise;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  return mainWindow;
}

/**
 * Ensure a BrowserWindow exists for quit IPC. Prefer not flashing a hidden-to-tray
 * window into the foreground unless it is already visible / needs a dirty-file dialog.
 */
async function ensureMainWindowForQuit() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  const windowResult = showOrCreateMainWindow();
  if (windowResult && typeof windowResult.then === 'function') await windowResult;
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

async function requestApplicationQuit() {
  if (reallyQuitting) return;
  if (quitRequestPreparing || quitRequestController.hasPending()) {
    logStartup(
      `Quit request ignored because one is already pending request=${quitRequestController.currentRequestId() || 'preparing'}`,
    );
    return;
  }
  quitRequestPreparing = true;
  try {
    // Hidden tray apps can still receive IPC; avoid a full show/focus flash unless
    // the renderer later reports dirty files (window:show) or the window is already open.
    const window = await ensureMainWindowForQuit();
    if (!window) {
      beginFinalApplicationExit('no-main-window');
      return;
    }

    if (window.isVisible()) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }

    const { started, requestId } = quitRequestController.begin();
    if (!started) return;
    const sendRequest = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      logStartup(`Quit request sent request=${requestId}`);
      mainWindow.webContents.send('app:quitRequested', { requestId });
    };
    if (mainWindow.webContents.isLoadingMainFrame()) mainWindow.webContents.once('did-finish-load', sendRequest);
    else sendRequest();
  } finally {
    quitRequestPreparing = false;
  }
}

ipcMain.on('window:show', () => {
  showOrCreateMainWindow();
});

ipcMain.on('app:confirmQuit', (_event, requestId) => {
  if (!quitRequestController.confirm(requestId)) {
    logStartup(`Ignored stale quit confirmation request=${String(requestId || '')}`);
    return;
  }
  logStartup(`Quit request confirmed request=${requestId}`);
  beginFinalApplicationExit(`renderer-confirmed:${requestId}`);
});

ipcMain.on('app:acknowledgeQuit', (_event, requestId) => {
  if (!quitRequestController.acknowledge(requestId)) {
    logStartup(`Ignored stale quit acknowledgement request=${String(requestId || '')}`);
    return;
  }
  logStartup(`Quit request acknowledged by renderer request=${requestId}`);
});

ipcMain.on('app:holdQuit', (_event, requestId) => {
  if (!quitRequestController.hold(requestId)) {
    logStartup(`Ignored stale quit hold request=${String(requestId || '')}`);
    return;
  }
  logStartup(`Quit request held for user dialog request=${requestId}`);
});

ipcMain.on('app:resumeQuit', (_event, payload = {}) => {
  const requestId = String(payload?.requestId || payload || '');
  const resumeMs = Number.isFinite(payload?.resumeMs) ? payload.resumeMs : 2500;
  if (!quitRequestController.resume(requestId, resumeMs)) {
    logStartup(`Ignored stale quit resume request=${requestId}`);
    return;
  }
  logStartup(`Quit request hard deadline resumed request=${requestId} resumeMs=${resumeMs}`);
});

ipcMain.on('app:cancelQuit', (_event, payload = {}) => {
  const requestId = String(payload?.requestId || '');
  if (!quitRequestController.cancel(requestId)) {
    logStartup(`Ignored stale quit cancellation request=${requestId}`);
    return;
  }
  logStartup(
    `Quit request cancelled request=${requestId} reason=${redactDiagnosticText(payload?.reason || 'unspecified')}`,
  );
});

const CODEBUDDY_REQUEST_TIMEOUT_MS = 30000;
const codebuddyStreams = new Map();

function createTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timeoutId = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  return {
    signal: controller.signal,
    cleanup() {
      if (timeoutId) clearTimeout(timeoutId);
    },
  };
}

// 已注册的允许 Git 工作目录（M1 安全面：主进程信任集是唯一真相源。
// git:registerWorkspaces 的 dirs 只做交集提示，不能扩大白名单。）
let gitAllowedWorkspaces = new Set();

function gitTrustAllowlist() {
  return workspaceTrust.listTrustedDirs();
}

ipcMain.handle('git:registerWorkspaces', (event, payload = {}) => {
  if (!isTrustedGitSender(event.sender, mainWindow)) {
    return { ok: false, error: 'forbidden: untrusted sender' };
  }
  const trusted = gitTrustAllowlist();
  const dirs = Array.isArray(payload?.dirs) ? payload.dirs : [];
  const requested = normalizeDirList(dirs);
  if (requested.size === 0) {
    gitAllowedWorkspaces = trusted;
  } else {
    gitAllowedWorkspaces = new Set([...requested].filter((dir) => trusted.has(dir)));
  }
  return { ok: true, count: gitAllowedWorkspaces.size };
});

ipcMain.handle('git:run', async (event, payload = {}) => {
  if (!isTrustedGitSender(event.sender, mainWindow)) {
    return { ok: false, error: 'forbidden: untrusted sender' };
  }
  const { args, cwd } = normalizeGitRequest(payload);
  const validationError = validateGitArgs(args);
  if (validationError) return { ok: false, error: validationError };
  if (!cwd || !path.isAbsolute(cwd)) return { ok: false, error: 'git cwd must be an absolute project path' };
  if (!isAllowedGitCwd(cwd, gitTrustAllowlist())) {
    return { ok: false, error: 'git cwd is not an allowed project directory' };
  }
  const resolvedCwd = path.resolve(cwd);
  try {
    if (!fs.statSync(resolvedCwd).isDirectory()) throw new Error('not a directory');
  } catch (_) {
    return { ok: false, error: `git cwd does not exist or is not accessible: ${resolvedCwd}` };
  }

  const isNetworkCommand = ['fetch', 'pull', 'push'].includes(args[0]);
  try {
    const result = await runCapturedProcess('git', args, {
      cwd: resolvedCwd,
      timeoutMs: isNetworkCommand ? 5 * 60 * 1000 : 60 * 1000,
      maxOutputBytes: 16 * 1024 * 1024,
      timeoutMessage: `Git ${args[0]} 执行超时，已停止命令`,
    });
    if (result.stdoutTruncated || result.stderrTruncated) {
      return { ok: false, error: 'Git 输出超过 16MB，已停止在界面中加载；请在终端中执行该操作' };
    }
    return { ok: true, output: result.stdout || result.stderr || '' };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

function parseSseMessagesFromBuffer(buffer) {
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() || '';
  const messages = [];
  let parseErrorCount = 0;
  for (const part of parts) {
    const lines = part.split(/\r?\n/);
    const eventType = lines
      .find((line) => line.startsWith('event:'))
      ?.slice(6)
      .trim();
    // SSE spec: multi-line `data:` fields join with \n; only strip the single
    // optional leading space and a trailing \r. Trimming every line corrupts
    // multi-line JSON payloads (a string split across data: lines would lose
    // its interior whitespace/line breaks).
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, '').replace(/\r$/, ''))
      .join('\n');
    if (!data) continue;
    try {
      const message = JSON.parse(data);
      messages.push(
        eventType && eventType !== 'message' && message && typeof message === 'object' && !message.type
          ? { ...message, type: eventType }
          : message,
      );
    } catch (error) {
      parseErrorCount += 1;
      logStartup(`codebuddy stream JSON parse failed: ${error.message}`);
    }
  }
  return { messages, rest, parseErrorCount };
}

ipcMain.handle('codebuddy:openStream', async (event, request = {}) => {
  const streamId = String(request.streamId || '');
  const url = String(request.url || '');
  const method = String(request.method || 'GET').toUpperCase();
  const timeoutMs = Number.isFinite(Number(request.timeoutMs))
    ? Number(request.timeoutMs)
    : CODEBUDDY_REQUEST_TIMEOUT_MS;
  if (!streamId) return { ok: false, error: 'missing streamId' };
  if (!isAllowedLocalRuntimeUrl(url, { allowDevPort: true })) {
    return { ok: false, error: 'Only localhost CodeBuddy streams are allowed' };
  }

  const controller = new AbortController();
  codebuddyStreams.set(streamId, controller);
  let timeoutId = null;
  let timedOut = false;
  const armTimeout = () => {
    if (timeoutId) clearTimeout(timeoutId);
    if (timeoutMs <= 0) return;
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  };
  armTimeout();
  try {
    const response = await net.fetch(
      url,
      codeBuddyFetchOptions({
        method,
        headers: request.headers || {},
        body: method === 'GET' || method === 'HEAD' ? undefined : request.body,
        signal: controller.signal,
      }),
    );
    if (!response.ok) {
      if (timeoutId) clearTimeout(timeoutId);
      codebuddyStreams.delete(streamId);
      event.sender.send('codebuddy:streamError', {
        streamId,
        error: `ACP stream failed: ${response.status}`,
        status: response.status,
        kind: 'http',
      });
      return { ok: false, status: response.status };
    }
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (method !== 'GET' && contentType.includes('application/json')) {
      const text = await response.text();
      codebuddyStreams.delete(streamId);
      if (timeoutId) clearTimeout(timeoutId);
      try {
        const message = JSON.parse(text);
        if (!event.sender.isDestroyed()) {
          event.sender.send('codebuddy:streamMessage', { streamId, message });
          event.sender.send('codebuddy:streamEnd', {
            streamId,
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
          });
        }
        return { ok: true };
      } catch (error) {
        event.sender.send('codebuddy:streamError', {
          streamId,
          error: `ACP JSON response parse failed: ${error.message}`,
          status: null,
          kind: 'parse',
        });
        return { ok: false, error: error.message };
      }
    }

    const reader = response.body?.getReader?.();
    if (!reader) {
      const text = await response.text().catch(() => '');
      codebuddyStreams.delete(streamId);
      if (timeoutId) clearTimeout(timeoutId);
      if (method !== 'GET' && !event.sender.isDestroyed()) {
        const parsed = parseSseMessagesFromBuffer(`${text}\n\n`).messages;
        if (!parsed.length && text.trim()) {
          try {
            parsed.push(JSON.parse(text));
          } catch (_) {}
        }
        for (const message of parsed) event.sender.send('codebuddy:streamMessage', { streamId, message });
        event.sender.send('codebuddy:streamEnd', {
          streamId,
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
        });
        return { ok: true };
      }
      event.sender.send('codebuddy:streamError', {
        streamId,
        error: 'ACP stream body unavailable',
        status: null,
        kind: 'network',
      });
      return { ok: false, error: 'stream body unavailable' };
    }

    const decoder = new TextDecoder();
    let buffer = '';
    // Bound the partial-event buffer: a drip-feed stream that never emits an
    // event boundary (`\n\n`) would otherwise grow main-process memory without
    // limit until the stream ends (armTimeout resets on every chunk by design).
    const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;
    const sender = event.sender;
    // A single sender-level listener fans out to all in-flight streams. This
    // avoids adding one EventEmitter listener per concurrent stream/request.
    const unregisterSenderAbort = registerSenderAbort(sender, controller, streamId);
    (async () => {
      // M-perf: batch stream messages in a 33ms window so high-frequency output
      // (terminal logs, progress bars, chat chunks) is one IPC round-trip per
      // window instead of one per SSE event. Terminal/error events flush the
      // batch immediately so the stream always terminates promptly and in order.
      let batchBuffer = [];
      let batchTimer = null;
      const isTerminalMessage = (message) => {
        const type = message?.type || message?.event;
        return type === 'done' || type === 'error' || type === 'stream_end' || type === 'end';
      };
      const flushBatch = () => {
        if (batchTimer) {
          clearTimeout(batchTimer);
          batchTimer = null;
        }
        if (!batchBuffer.length) return;
        const messages = batchBuffer;
        batchBuffer = [];
        for (const message of messages) {
          if (!sender.isDestroyed()) sender.send('codebuddy:streamMessage', { streamId, message });
        }
      };
      const emitMessages = (messages) => {
        for (const message of messages) {
          if (isTerminalMessage(message)) {
            flushBatch();
            if (!sender.isDestroyed()) sender.send('codebuddy:streamMessage', { streamId, message });
            continue;
          }
          batchBuffer.push(message);
          if (!batchTimer) batchTimer = setTimeout(flushBatch, 33);
        }
      };
      let streamError = null;
      let parseErrorCount = 0;
      try {
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            if (buffer.trim()) {
              const parsed = parseSseMessagesFromBuffer(`${buffer}\n\n`);
              buffer = parsed.rest;
              parseErrorCount += parsed.parseErrorCount;
              emitMessages(parsed.messages);
            }
            flushBatch();
            break;
          }
          armTimeout();
          buffer += decoder.decode(value, { stream: true });
          if (Buffer.byteLength(buffer, 'utf8') > MAX_SSE_BUFFER_BYTES) {
            streamError = 'ACP stream exceeded the 8MB partial-event buffer';
            controller.abort();
            break;
          }
          const parsed = parseSseMessagesFromBuffer(buffer);
          buffer = parsed.rest;
          parseErrorCount += parsed.parseErrorCount;
          emitMessages(parsed.messages);
        }
      } catch (error) {
        if (!controller.signal.aborted || timedOut)
          streamError = timedOut ? `CodeBuddy stream timed out after ${timeoutMs}ms` : error.message;
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        unregisterSenderAbort();
        try {
          reader.releaseLock?.();
        } catch (_) {}
        codebuddyStreams.delete(streamId);
        if (!sender.isDestroyed()) {
          flushBatch();
          if (streamError) {
            // 读循环 armTimeout 触发的是 chunk 空闲超时（长任务可恢复），不是硬连接超时。
            sender.send('codebuddy:streamError', {
              streamId,
              error: streamError,
              status: null,
              kind: timedOut ? 'idle-timeout' : 'network',
            });
          } else if (method !== 'GET' && !controller.signal.aborted) {
            sender.send('codebuddy:streamEnd', {
              streamId,
              ok: response.ok,
              status: response.status,
              statusText: response.statusText,
              parseErrorCount,
            });
          } else if (parseErrorCount > 0) {
            sender.send('codebuddy:streamError', {
              streamId,
              error: `ACP stream contained ${parseErrorCount} invalid event(s)`,
              status: null,
              kind: 'parse',
            });
          } else if (method === 'GET' && !controller.signal.aborted) {
            sender.send('codebuddy:streamError', {
              streamId,
              error: 'ACP stream closed',
              status: null,
              kind: 'closed',
            });
          }
        }
      }
    })();
    return { ok: true };
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);
    codebuddyStreams.delete(streamId);
    event.sender.send('codebuddy:streamError', {
      streamId,
      error: timedOut ? `CodeBuddy stream timed out after ${timeoutMs}ms` : error.message,
      status: null,
      // openStream 的 timeout 用于 chunk 空闲窗口；长任务应归 idle，不拆连接。
      kind: timedOut ? 'idle-timeout' : 'network',
    });
    return { ok: false, error: error.message };
  }
});

ipcMain.on('codebuddy:closeStream', (_event, streamId) => {
  const controller = codebuddyStreams.get(String(streamId || ''));
  if (controller) {
    controller.abort();
    codebuddyStreams.delete(String(streamId || ''));
  }
});

/**
 * Read a response body up to `maxBytes` bytes, cancelling the stream and
 * marking `truncated` when the cap is hit. Keeps non-SSE responses on the same
 * memory bound as the SSE read loop (a mislabelled content-type could otherwise
 * stream an unbounded body into the main process).
 */
async function readBoundedBody(response, maxBytes, decode) {
  const reader = response.body?.getReader?.();
  if (!reader) return { data: decode(await response.arrayBuffer()), truncated: false };
  const decoder = new TextDecoder();
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decode === 'bytes' ? Buffer.from(value) : decoder.decode(value, { stream: true });
      // Count bytes (not UTF-16 chars) so the text bound matches the SSE loop.
      total += decode === 'bytes' ? chunk.length : Buffer.byteLength(chunk, 'utf8');
      if (total > maxBytes) {
        truncated = true;
        try {
          reader.cancel();
        } catch (_) {}
        break;
      }
      chunks.push(chunk);
    }
    if (decode !== 'bytes') chunks.push(decoder.decode());
  } finally {
    try {
      reader.releaseLock?.();
    } catch (_) {}
  }
  const data = decode === 'bytes' ? Buffer.concat(chunks) : chunks.join('');
  return { data, truncated };
}

async function readBoundedBodyBytes(response, maxBytes) {
  return readBoundedBody(response, maxBytes, 'bytes');
}

async function readBoundedBodyText(response, maxBytes) {
  return readBoundedBody(response, maxBytes, 'text');
}

ipcMain.handle('codebuddy:request', async (event, request = {}) => {
  // timeoutMs 由前端透传：session/prompt 等长请求使用 idle 窗口（默认 10min，有 chunk 会重置），普通 REST 使用 30000ms。
  const timeoutMs = Number.isFinite(Number(request.timeoutMs))
    ? Number(request.timeoutMs)
    : CODEBUDDY_REQUEST_TIMEOUT_MS;
  const timeout = createTimeoutSignal(timeoutMs);
  // Keep a sender reference so we can abort the SSE read loop if the renderer
  // that issued the request is destroyed mid-stream. Without this, a long SSE
  // response keeps accumulating into `body` until the timeout fires, even after
  // the renderer is gone — wasting main-process memory and CPU. Mirrors the
  // pattern used by codebuddy:openStream (sender.once('destroyed') → abort).
  const sender = event.sender;
  const unregisterSenderAbort = registerSenderAbort(sender, timeout.controller);
  // Cap the accumulated SSE body so a runaway/malicious stream cannot grow
  // main-process memory without bound (the only other bound is the timeout).
  const MAX_SSE_BODY_BYTES = 8 * 1024 * 1024;
  try {
    const method = request.method || 'GET';
    const url = String(request.url || '');
    if (!isAllowedLocalRuntimeUrl(url, { allowDevPort: true })) {
      return {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        body: 'Only localhost CodeBuddy requests are allowed',
      };
    }
    const response = await net.fetch(
      url,
      codeBuddyFetchOptions({
        method,
        headers: request.headers || {},
        body: request.body,
        signal: timeout.signal,
      }),
    );
    // SSE 流式：net.fetch 的 AbortSignal 对流读取不一定生效，这里改成主动读流 + 超 timeout 强切
    const contentType = response.headers.get('content-type') || '';
    const isSse = contentType.includes('text/event-stream');
    let body = '';
    let bodyBase64 = null;
    let truncated = false; // SSE 超时截断标记：前端据此识别"流中断"而非"流自然结束"
    if (isSse && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const tMax = Date.now() + timeoutMs;
      while (true) {
        // Stop as soon as the issuing renderer is gone or the deadline passes.
        if ((sender && sender.isDestroyed()) || Date.now() > tMax) {
          truncated = true;
          try {
            reader.cancel();
          } catch (_) {}
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        body += chunk;
        // Bound accumulated body size; a drip-feed stream could otherwise grow
        // `body` for the full timeout window.
        if (Buffer.byteLength(body) > MAX_SSE_BODY_BYTES) {
          truncated = true;
          try {
            reader.cancel();
          } catch (_) {}
          break;
        }
      }
      body += decoder.decode();
    } else if (contentType.startsWith('image/')) {
      // Bound image responses too (16MB raw): a mislabelled content-type could
      // otherwise stream an unbounded body into main-process memory.
      const bytes = await readBoundedBodyBytes(response, 16 * 1024 * 1024);
      if (bytes.truncated) truncated = true;
      bodyBase64 = bytes.data.toString('base64');
    } else {
      const text = await readBoundedBodyText(response, MAX_SSE_BODY_BYTES);
      if (text.truncated) truncated = true;
      body = text.data;
    }
    if (/\/api\/v1\/auth\/status(?:\?|$)/.test(url)) {
      logStartup(`CodeBuddy auth status response status=${response.status} body=${redactSecrets(body)}`);
    }
    if (/\/api\/v1\/acp(?:\/connect)?(?:\?|$)/.test(url)) {
      let rpcMethod = '';
      try {
        rpcMethod = JSON.parse(String(request.body || '{}'))?.method || '';
      } catch (_) {}
      const hasAuthorization = Boolean(request.headers?.Authorization || request.headers?.authorization);
      const hasRpcError = /"error"\s*:/.test(body);
      const errorSummary = !response.ok || hasRpcError ? ` body=${redactSecrets(body).slice(0, 1000)}` : '';
      logStartup(
        `CodeBuddy ACP response path=${new URL(url).pathname} rpc=${rpcMethod || '-'} status=${response.status} authorization=${hasAuthorization}${errorSummary}`,
      );
    }
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      body,
      bodyBase64,
      truncated, // SSE 流被 timeout 截断时为 true；前端 parseEventStreamMessages 据此判中断
      headers: Object.fromEntries(response.headers.entries()),
    };
  } catch (error) {
    const isTimeout = error?.name === 'AbortError' || /aborted/i.test(error.message || '');
    return {
      ok: false,
      status: isTimeout ? 408 : 0,
      statusText: isTimeout ? 'Request Timeout' : error.message,
      body: isTimeout ? `CodeBuddy request timed out after ${timeoutMs}ms` : error.message,
    };
  } finally {
    timeout.cleanup();
    unregisterSenderAbort();
  }
});
ipcMain.on('window:minimize', () => {
  if (mainWindow) mainWindow.minimize();
});
ipcMain.on('window:maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window:close', () => {
  if (mainWindow) mainWindow.close();
});
ipcMain.on('window:reload', () => {
  if (mainWindow) mainWindow.webContents.reload();
});

// 工作区选择：弹原生目录选择对话框，返回所选绝对路径或 null（用户取消）
ipcMain.handle('workspace:choose', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: '选择工作区目录',
  });
  if (result.canceled || !result.filePaths.length) return null;
  const chosen = result.filePaths[0];
  workspaceTrust.registerChosen(chosen);
  return chosen;
});
const ATTACHMENT_IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const ATTACHMENT_IMAGE_EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};
const CLIPBOARD_ATTACHMENT_DIR = path.join(app.getPath('userData'), 'clipboard-attachments');
const CLIPBOARD_ATTACHMENT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const ATTACHMENT_TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.json',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.css',
  '.html',
  '.xml',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.py',
  '.java',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.go',
  '.rs',
  '.sh',
  '.ps1',
  '.sql',
  '.csv',
  '.log',
  '.env',
  '.lock',
  '.vue',
  '.svelte',
  '.rb',
  '.php',
  '.kt',
  '.kts',
  '.swift',
  '.lua',
  '.r',
  '.graphql',
  '.gql',
  '.proto',
  '.dart',
  '.scala',
  '.cs',
  '.fs',
  '.fsx',
  '.vb',
  '.gradle',
  '.properties',
  '.conf',
  '.cfg',
  '.bat',
  '.cmd',
]);
const ATTACHMENT_TEXT_FILE_NAMES = new Set([
  'dockerfile',
  'makefile',
  'license',
  'notice',
  'readme',
  '.gitignore',
  '.gitattributes',
  '.gitmodules',
  '.npmrc',
  '.editorconfig',
  '.prettierrc',
  '.eslintrc',
]);

async function pruneClipboardAttachments() {
  try {
    const entries = await fs.promises.readdir(CLIPBOARD_ATTACHMENT_DIR, { withFileTypes: true });
    const cutoff = Date.now() - CLIPBOARD_ATTACHMENT_MAX_AGE_MS;
    await Promise.allSettled(
      entries.map(async (entry) => {
        if (!entry.isFile()) return;
        const filePath = path.join(CLIPBOARD_ATTACHMENT_DIR, entry.name);
        const stat = await fs.promises.stat(filePath);
        if (stat.mtimeMs < cutoff) await fs.promises.rm(filePath, { force: true });
      }),
    );
  } catch (error) {
    if (error?.code !== 'ENOENT') logStartup(`Clipboard attachment cleanup failed: ${error.message}`);
  }
}

// H7: track attachment paths the user explicitly chose via attachment:choose or
// drag-drop so attachment:read can scope reads to those or to active project
// workspaces, blocking renderer-driven arbitrary local file reads.
const attachmentScope = createAttachmentScope({ loadProductState: () => productStateStore.load() });
const registerChosenAttachmentPaths = (filePaths) => attachmentScope.register(filePaths);
function allowAttachmentRead(filePath) {
  return attachmentScope.allow(filePath);
}

async function readAttachmentFiles(filePaths) {
  const attachments = [];
  const uniquePaths = [
    ...new Set(
      (Array.isArray(filePaths) ? filePaths : []).filter((filePath) => typeof filePath === 'string' && filePath.trim()),
    ),
  ];
  for (const filePath of uniquePaths) {
    const name = path.basename(filePath);
    try {
      const stat = await fs.promises.stat(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const base = { name, path: filePath, size: stat.size };
      if (!stat.isFile()) {
        attachments.push({ ...base, kind: 'unsupported', error: '所选路径不是文件' });
        continue;
      }
      // H7: scope reads to paths the user actively chose (via attachment:choose or
      // drag-drop) or that live inside an active project workspace. Without this a
      // renderer XSS could exfiltrate arbitrary .env/config/source files from
      // anywhere the Electron user can read.
      const allowReason = allowAttachmentRead(filePath);
      if (allowReason !== 'chosen' && allowReason !== 'workspace') {
        attachments.push({
          ...base,
          kind: 'unsupported',
          error: '该路径不在已选附件或当前项目工作区内，拒绝读取',
        });
        continue;
      }
      if (ATTACHMENT_IMAGE_TYPES[ext]) {
        if (stat.size > 10 * 1024 * 1024) {
          attachments.push({ ...base, kind: 'unsupported', error: '图片不能超过 10MB' });
          continue;
        }
        const data = await fs.promises.readFile(filePath);
        attachments.push({
          ...base,
          kind: 'image',
          mimeType: ATTACHMENT_IMAGE_TYPES[ext],
          data: data.toString('base64'),
        });
        continue;
      }
      const extensionlessText = !ext && ATTACHMENT_TEXT_FILE_NAMES.has(name.toLowerCase());
      if (!ATTACHMENT_TEXT_EXTENSIONS.has(ext) && !extensionlessText) {
        attachments.push({ ...base, kind: 'unsupported', error: '该文件类型无法作为文本发送' });
        continue;
      }
      if (stat.size > 1 * 1024 * 1024) {
        attachments.push({ ...base, kind: 'unsupported', error: '文件不能超过 1MB' });
        continue;
      }
      const content = await fs.promises.readFile(filePath, 'utf8');
      attachments.push({ ...base, kind: 'text', mimeType: 'text/plain', text: content });
    } catch (error) {
      attachments.push({ name, path: filePath, size: 0, kind: 'unsupported', error: error.message || '读取文件失败' });
    }
  }
  return attachments;
}

ipcMain.handle('attachment:choose', async (_event, options = {}) => {
  if (!mainWindow || mainWindow.isDestroyed()) return [];
  const dialogOptions = buildAttachmentChooseDialogOptions(options);
  const result = await dialog.showOpenDialog(mainWindow, dialogOptions);
  if (result.canceled) return [];
  registerChosenAttachmentPaths(result.filePaths);
  return readAttachmentFiles(result.filePaths);
});
ipcMain.handle('attachment:read', (_event, filePaths) => {
  // H7: readAttachments (explicit renderer call) is scoped to chosen/workspace
  // paths only. Drag-drop uses the dedicated attachment:readDropped channel so
  // the main process can register the resolved paths as chosen before reading.
  return readAttachmentFiles(filePaths);
});
ipcMain.handle('attachment:readDropped', (_event, filePaths) => {
  // H7: drag-drop paths are resolved in the preload via webUtils.getPathForFile
  // (which the renderer cannot forge), so register them as chosen before reading.
  registerChosenAttachmentPaths(filePaths);
  return readAttachmentFiles(filePaths);
});
ipcMain.handle('attachment:saveClipboardImage', async (_event, payload = {}) => {
  const mimeType = String(payload.mimeType || '').toLowerCase();
  const extension = ATTACHMENT_IMAGE_EXTENSIONS[mimeType];
  if (!extension) throw new Error('剪贴板图片格式不受支持');
  const encoded = String(payload.dataBase64 || '').replace(/^data:[^;]+;base64,/, '');
  if (encoded.length > 14 * 1024 * 1024) throw new Error('剪贴板图片超过 10MB 限制');
  const data = Buffer.from(encoded, 'base64');
  if (!data.length) throw new Error('剪贴板图片为空');
  if (data.length > 10 * 1024 * 1024) throw new Error('剪贴板图片超过 10MB 限制');
  await fs.promises.mkdir(CLIPBOARD_ATTACHMENT_DIR, { recursive: true });
  await pruneClipboardAttachments();
  const fileName = `clipboard-image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extension}`;
  const filePath = path.join(CLIPBOARD_ATTACHMENT_DIR, fileName);
  await fs.promises.writeFile(filePath, data, { flag: 'wx' });
  registerChosenAttachmentPaths([filePath]);
  const [attachment] = await readAttachmentFiles([filePath]);
  if (!attachment || attachment.kind === 'unsupported') {
    await fs.promises.rm(filePath, { force: true }).catch(() => {});
    throw new Error(attachment?.error || '剪贴板图片读取失败');
  }
  return attachment;
});

ipcMain.handle('productState:load', () => productStateStore.load());

// M-perf: coalesce product-state saves in an 800ms window. Bursts of persist
// triggers (typing pauses, stream pauses, terminal output) produce one disk
// write instead of N — and, crucially, the main-process event loop is never
// blocked by a synchronous writeFileSync while other IPC (keystrokes, route
// switches) is queued. Only the freshest snapshot of a window is kept; the
// returned promise resolves when the batch containing this snapshot has landed.
ipcMain.handle('productState:save', (_event, state) =>
  productStateSaveController.request(sanitizeProductStateSnapshot(state)),
);

ipcMain.on('productState:saveSync', (event, state) => {
  event.returnValue = productStateSaveController.saveSync(sanitizeProductStateSnapshot(state));
});
ipcMain.on('window:openDevTools', () => {
  // L2: only allow DevTools in development; production builds ignore the IPC.
  if (!isDev) return;
  if (mainWindow) mainWindow.webContents.openDevTools({ mode: 'detach' });
});

// 未捕获异常处理（P0-4）：写 crash log 到 userData，dialog 提示用户
function writeCrashLog(type, err) {
  try {
    const logPath = path.join(app.getPath('userData'), 'crash.log');
    try {
      const stats = fs.statSync(logPath);
      if (stats.size > 1024 * 1024) {
        const tail = fs.readFileSync(logPath);
        fs.writeFileSync(logPath, tail.slice(-200 * 1024));
      }
    } catch (_) {
      /* 文件不存在或轮转失败不阻塞崩溃记录 */
    }
    const ts = new Date().toISOString();
    const stack = redactDiagnosticText(err?.stack || String(err));
    fs.appendFileSync(logPath, `\n[${ts}] ${type}: ${stack}\n`);
  } catch (_) {
    /* 写失败不阻塞 */
  }
}
process.on('uncaughtException', (err) => {
  writeCrashLog('uncaughtException', err);
  try {
    dialog.showErrorBox(
      'CodeBuddy Desktop 发生异常',
      `程序遇到未捕获异常:\n\n${err?.message || err}\n\n崩溃日志已写入 userData/crash.log，重启应用前建议反馈给开发者。`,
    );
  } catch (_) {}
  // H6: continuing after an uncaughtException leaves the main process in an
  // inconsistent state (mid-flight IPC, half-written maps, leaked timers). Show
  // the dialog, then begin the final-exit sequence (which has its own force-delay
  // fallback) so the app restarts clean instead of limping on.
  setTimeout(() => {
    try { beginFinalApplicationExit('uncaughtException'); } catch (_) {}
  }, 100);
});
process.on('unhandledRejection', (reason) => {
  writeCrashLog('unhandledRejection', reason);
});

// 单实例锁（P0-2）：避免多开实例 spawn 多个 codebuddy --serve 抢端口/资源
const gotLock = app.requestSingleInstanceLock();
logStartup(`single instance lock acquired=${gotLock}`);
if (!gotLock) {
  app.exit(0);
} else {
  app.on('second-instance', (_event, commandLine = []) => {
    if (commandLine.includes('--request-quit')) {
      requestApplicationQuit().catch((error) => logStartup(`Command-line quit request failed: ${error.message}`));
      return;
    }
    // 二次启动可能发生在首个实例仍初始化静态服务器时（双击两次是常见行为）。
    // showOrCreateMainWindow 此时返回 null 会吞掉请求——记下并在就绪后补显示。
    if (!app.isReady() || (!isDev && !prodServerPort)) {
      pendingShowRequested = true;
      logStartup('Second instance arrived before window readiness; deferring show');
      return;
    }
    showOrCreateMainWindow();
  });
}

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('com.codebuddy.gui.cathead');

  // 注入 Content-Security-Policy：覆盖 dev/prod 双路，消除 Electron 安全告警
  // - 'wasm-unsafe-eval' 足 monaco-editor wasm，不开 'unsafe-eval'（Electron 告警源）
  // - connect-src：渲染层 REST/SSE 请求全部经 IPC（window.electronAPI.requestCodeBuddy → 主进程
  //   net.fetch，不受 CSP 约束），故不再放 http://127.0.0.1:* 通配，收紧本机横向越权面
  // - 仅保留 ws://127.0.0.1:* 供 PTY WebSocket（pty.js 渲染层直连，端口随 --serve 随机分配）
  // - style-src 'unsafe-inline' 足 React 内联样式；Google Fonts 域名放开
  const CSP = [
    "default-src 'self'",
    // dev: Vite HMR client + @vitejs/plugin-react preamble 需 inline script；生产构建无 inline，更严
    `script-src ${isDev ? "'self' 'wasm-unsafe-eval' 'unsafe-inline'" : "'self' 'wasm-unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "connect-src 'self' ws://127.0.0.1:*",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
  logStartup(`CSP injected: ${isDev ? 'dev(unsafe-inline)' : 'prod(strict)'} script-src`);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: Object.assign({}, details.responseHeaders, {
        'Content-Security-Policy': [CSP],
      }),
    });
  });

  // 启动本地 HTTP 服务器，从 out/dist 目录服务生产构建
  const distPath = path.join(__dirname, '..', 'out', 'dist');
  const staticApp = express();
  staticApp.use(
    express.static(distPath, {
      etag: true,
      maxAge: isDev ? 0 : '1h',
      setHeaders(res, filePath) {
        if (/\.[a-f0-9]{8,}\./i.test(path.basename(filePath))) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', isDev ? 'no-store' : 'public, max-age=3600');
        }
      },
    }),
  );
  const staticServerInstance = await new Promise((resolve) => {
    const s = staticApp.listen(0, '127.0.0.1', () => resolve(s));
  });
  staticServer = staticServerInstance;
  prodServerPort = staticServer.address().port;
  logStartup(`Static server on http://127.0.0.1:${prodServerPort}`);

  // 静态服务器就绪后再创建窗口；CodeBuddy 运行时由渲染进程按当前项目惰性启动。
  showOrCreateMainWindow();
  // 二次启动在就绪前到达时补显示（see second-instance handler）。
  if (pendingShowRequested) {
    pendingShowRequested = false;
    showOrCreateMainWindow();
  }

  // Tray 图标：关窗口不退出，最小化到系统托盘，用户从托盘菜单退出才真 quit
  try {
    const trayIconPath = path.join(__dirname, '..', 'build', 'icon.png');
    tray = new Tray(trayIconPath);
    tray.setToolTip('CodeBuddy Desktop');
    tray.on('click', showOrCreateMainWindow);
    tray.on('balloon-click', showOrCreateMainWindow);
    const menu = Menu.buildFromTemplate([
      { label: '打开 CodeBuddy Desktop', click: showOrCreateMainWindow },
      { type: 'separator' },
      {
        label: '完全退出',
        click: () => requestApplicationQuit().catch((error) => logStartup(`Quit request failed: ${error.message}`)),
      },
    ]);
    tray.setContextMenu(menu);
    logStartup('Tray icon created');
  } catch (err) {
    logStartup(`Tray creation failed: ${err.message}`);
  }

  // cookie 跨 session 校验：主进程 net.fetch 认证后写 default session cookie，
  // 渲染进程 fetch 也走 default session —— 理论上共享。加日志给后续诊断真证据。
  // 真发 session/prompt 时若认证失效，渲染进程 store.bootstrap 会自己 fetch 认证兜底
});

// 真退出前树杀 codebuddy 子进程：shell:true spawn 出来的 node.exe 不会随 Electron 退
// 不树杀会变孤儿进程占 stdout + 占端口，下次启动端口冲突（实测残留过 PID 42940/18192）
app.on('before-quit', () => {
  reallyQuitting = true;
  flushStartupLog();
  if (exitCleanupStarted) return;
  exitCleanupStarted = true;
  logStartup('Electron before-quit cleanup started');
  const pendingQuitRequestId = quitRequestController.currentRequestId();
  if (pendingQuitRequestId) quitRequestController.cancel(pendingQuitRequestId);
  // 显式关闭 express 静态服务器：OS 虽会随进程退出回收端口，但显式 close 避免单实例锁失败场景的端口短暂残留
  if (staticServer) {
    try {
      staticServer.close();
    } catch (_) {}
    staticServer = null;
  }
  for (const notification of activeTaskNotifications) {
    try {
      notification.close();
    } catch (_) {}
  }
  activeTaskNotifications.clear();
  pendingNotificationTarget = null;
  for (const controller of codebuddyStreams.values()) {
    try {
      controller.abort();
    } catch (_) {}
  }
  codebuddyStreams.clear();
  if (mobileRemoteHost) {
    mobileRemoteHost.stop().catch((error) => logStartup(`mobileRemote stop failed: ${error.message}`));
  }
  runtimeManager.stopAll().catch((error) => logStartup(`Runtime shutdown failed: ${error.message}`));
  destroyTrayIcon('before-quit');
});

app.on('quit', (_event, exitCode) => {
  finalExitController.complete();
  logStartup(`Electron quit completed exitCode=${exitCode}`);
});

// 关窗口不退出；托盘退出先由渲染进程处理未保存内容，确认后才进入 Electron 退出链。
// window-all-closed 在退出链中只是被动确认，非 darwin 的 app.quit() 调用保持幂等。
// darwin 不在这里重复退出，交给 activate 生命周期处理。
app.on('window-all-closed', () => {
  if (!reallyQuitting && tray) return;
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  showOrCreateMainWindow();
});
