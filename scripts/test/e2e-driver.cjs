'use strict';

const { execFile, spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROUTE_EXPECTATIONS = Object.freeze([
  // chat has no dedicated sidebar nav item; driveRoutes treats it as already-active when on #/chat.
  { route: 'chat', navLabel: '对话', expected: { role: 'textbox', name: '从一个想法开始...' } },
  { route: 'instances', navLabel: '实例列表', navGroup: '桌面扩展', expected: { role: 'button', name: '添加项目' } },
  { route: 'remote-control', navLabel: '远程控制', expected: { role: 'textbox', name: '企微 botId' } },
  { route: 'tasks', navLabel: '任务', navGroup: '工作区', expected: { role: 'textbox', name: '0 9 * * *' } },
  { route: 'archived', navLabel: '已归档', navGroup: '桌面扩展', expected: { role: 'heading', name: '已归档' } },
  { route: 'terminal', navLabel: '终端', navGroup: '工作区', expected: { role: 'button', name: '右分' } },
  { route: 'editor', navLabel: '编辑器', navGroup: '工作区', expected: { role: 'textbox', name: '搜索文件名' } },
  { route: 'changes', navLabel: '变更', navGroup: '工作区', expected: { role: 'textbox', name: '输入提交信息...' } },
  { route: 'plugins', navLabel: '插件', navGroup: '工作区', expected: { role: 'textbox', name: '搜索插件名称或描述...' } },
  { route: 'skills', navLabel: '技能', navGroup: '桌面扩展', expected: { role: 'heading', name: '技能' } },
  { route: 'agents', navLabel: 'Agents', navGroup: '桌面扩展', expected: { role: 'heading', name: 'Agents' } },
  { route: 'mcp', navLabel: 'MCP', navGroup: '桌面扩展', expected: { role: 'textbox', name: '搜索名称、类型或地址...' } },
  { route: 'sandboxes', navLabel: 'Sandboxes', navGroup: '桌面扩展', expected: { role: 'textbox', name: '搜索 ID、别名、模板或项目路径...' } },
  { route: 'stats', navLabel: '统计', navGroup: '可观测', expected: { role: 'button', name: '刷新' } },
  { route: 'traces', navLabel: '链路', navGroup: '可观测', expected: { role: 'textbox', name: '搜索 Service 或 Trace ID…' } },
  { route: 'metrics', navLabel: '监控', navGroup: '可观测', expected: { role: 'button', name: '自动刷新' } },
  { route: 'logs', navLabel: '日志', navGroup: '可观测', expected: { role: 'textbox', name: '搜索日志...' } },
  {
    route: 'workers',
    navLabel: 'Agent 实例管理',
    navGroup: '桌面扩展',
    expected: { role: 'textbox', name: '搜索 Worker、目录、Endpoint 或主机...' },
  },
  // Custom models entry lives under Settings → 模型选择 (no standalone sidebar "模型" nav).
  // Settings page always shows appearance theme cycle + language; use a stable label.
  { route: 'settings', navLabel: '设置', expected: { role: 'heading', name: '连接状态' } },
  {
    route: 'keybindings',
    navLabel: '快捷键',
    expected: { role: 'textbox', name: '搜索快捷键、动作或上下文...' },
  },
]);

function abortError(signal, fallback = 'operation aborted') {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(signal?.reason ? String(signal.reason) : fallback);
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal, context = 'operation aborted') {
  if (signal?.aborted) throw abortError(signal, context);
}

function parsePositiveInteger(value, options = {}) {
  const { name = 'value', defaultValue } = options;
  const candidate = value === undefined ? defaultValue : value;
  const parsed =
    typeof candidate === 'number'
      ? candidate
      : typeof candidate === 'string' && candidate.trim() !== ''
        ? Number(candidate)
        : Number.NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function wait(ms, options = {}) {
  const signal = options?.signal;
  throwIfAborted(signal, `wait ${ms}ms aborted`);
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError(signal, `wait ${ms}ms aborted`));
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function createOverallWatchdog(options = {}) {
  const {
    timeoutMs = 10 * 60 * 1000,
    cancellationGraceMs = 5000,
    label = 'desktop E2E harness',
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  } = options;
  let timer = null;
  let graceTimer = null;
  let controller = null;
  let stopped = false;
  return {
    get signal() {
      return controller?.signal || null;
    },
    async run(task) {
      if (typeof task !== 'function') throw new Error('overall watchdog run(task) requires a function');
      if (controller) throw new Error('overall watchdog run(task) may only be called once');
      controller = new AbortController();
      const taskOutcome = Promise.resolve()
        .then(() => task(controller.signal))
        .then(
          (value) => ({ type: 'settled', status: 'fulfilled', value }),
          (error) => ({ type: 'settled', status: 'rejected', error }),
        );
      const deadline = new Promise((resolve) => {
        timer = setTimeoutImpl(
          () => {
            timer = null;
            resolve({ type: 'deadline' });
          },
          timeoutMs,
        );
      });
      const first = await Promise.race([taskOutcome, deadline]);
      if (first.type === 'settled') {
        if (timer) clearTimeoutImpl(timer);
        timer = null;
        if (first.status === 'rejected') throw first.error;
        return first.value;
      }

      const timeoutError = new Error(`${label} exceeded overall watchdog ${timeoutMs}ms`);
      timeoutError.code = 'E_WATCHDOG_TIMEOUT';
      timeoutError.finalizationSafe = true;
      controller.abort(timeoutError);
      const grace = new Promise((resolve) => {
        graceTimer = setTimeoutImpl(
          () => {
            graceTimer = null;
            resolve({ type: 'grace-expired' });
          },
          cancellationGraceMs,
        );
      });
      const afterAbort = await Promise.race([taskOutcome, grace]);
      if (afterAbort.type === 'settled') {
        if (graceTimer) clearTimeoutImpl(graceTimer);
        graceTimer = null;
        if (afterAbort.status === 'rejected' && afterAbort.error !== timeoutError) {
          timeoutError.cause = afterAbort.error;
        }
        throw timeoutError;
      }

      const hardFailure = new Error(
        `${label} did not settle within cancellation grace ${cancellationGraceMs}ms after watchdog abort`,
      );
      hardFailure.code = 'E_WATCHDOG_CANCELLATION_GRACE';
      hardFailure.finalizationSafe = false;
      throw hardFailure;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeoutImpl(timer);
      if (graceTimer) clearTimeoutImpl(graceTimer);
      timer = null;
      graceTimer = null;
    },
  };
}

function createSingleFinalizer(finalizer) {
  if (typeof finalizer !== 'function') throw new Error('createSingleFinalizer requires a function');
  let promise = null;
  return (...args) => {
    if (!promise) promise = Promise.resolve().then(() => finalizer(...args));
    return promise;
  };
}

function requireUsableCodeBuddyStartup(text) {
  const startupText = String(text || '');
  const runtimePort = Number(startupText.match(/CodeBuddy runtime ready project=\S+ port=(\d+)\b/)?.[1]);
  if (Number.isInteger(runtimePort)) return { state: 'ready', port: runtimePort };

  const port = Number(startupText.match(/Parsed CodeBuddy port from stdout: (\d+)\b/)?.[1]);
  const passwordParsed = /Parsed CodeBuddy password from (?:stdout|URL)/.test(startupText);
  const ready = /CodeBuddy port ready: \d+\b/.test(startupText);
  const timedOut = /CodeBuddy start timeout \(no port parsed from stdout\)/.test(startupText);
  const failed = startupText.match(/CodeBuddy start failed: ([^\r\n]+)/)?.[1];

  if (ready && Number.isInteger(port) && passwordParsed) {
    return { state: 'ready', port };
  }
  if (timedOut) throw new Error('CodeBuddy startup timed out before the runtime manager reported ready');
  if (failed) {
    throw new Error(`CodeBuddy startup failed before a usable port/password pair: ${failed}`);
  }
  throw new Error('CodeBuddy startup did not report a ready runtime');
}

function safeRuntimeSegment(value, fallback) {
  const cleaned = String(value || fallback)
    .replace(/[:.]/g, '-')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

const RUNTIME_OWNER_MARKER = '.codebuddy-e2e-runtime-owner';
const RUNTIME_OWNER_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

function sameCanonicalPath(left, right) {
  const normalize = (value) => process.platform === 'win32'
    ? path.resolve(value).toLowerCase()
    : path.resolve(value);
  return normalize(left) === normalize(right);
}

function descendantRelative(root, candidate, label, allowEqual = false) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if ((!allowEqual && !relative) || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} is outside the owned runtime root`);
  }
  return relative;
}

function canonicalRealPath(value) {
  return (fs.realpathSync.native || fs.realpathSync)(value);
}

function verifyProjectAnchor(projectRoot, projectRealRoot) {
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    throw new Error('runtime project root must be an existing directory');
  }
  const currentRealRoot = canonicalRealPath(projectRoot);
  if (!sameCanonicalPath(currentRealRoot, projectRealRoot)) {
    throw new Error('runtime project root canonical anchor changed');
  }
}

function verifyRuntimeDirectoryChain(options = {}) {
  const { projectRoot, projectRealRoot, targetPath, createMissing = false, allowMissing = false } = options;
  verifyProjectAnchor(projectRoot, projectRealRoot);
  const relative = descendantRelative(projectRoot, targetPath, 'runtime path');
  const segments = relative.split(path.sep).filter(Boolean);
  let current = projectRoot;
  let expectedReal = projectRealRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    expectedReal = path.join(expectedReal, segment);
    if (!fs.existsSync(current)) {
      if (!createMissing) {
        if (allowMissing) return { exists: false, path: current };
        throw new Error(`runtime path component is missing: ${segment}`);
      }
      fs.mkdirSync(current, { recursive: false, mode: 0o700 });
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`runtime path contains a reparse point or junction: ${segment}`);
    }
    if (!stat.isDirectory()) throw new Error(`runtime path component is not a directory: ${segment}`);
    const currentReal = canonicalRealPath(current);
    if (!sameCanonicalPath(currentReal, expectedReal)) {
      throw new Error(`runtime path canonical location changed at ${segment}`);
    }
  }
  return { exists: true, path: targetPath };
}

function lexicalRuntimePaths(options = {}) {
  const source = options.runtimeOwnership || options;
  const runtimeRoot = path.resolve(source.runtimeRoot || options.runtimeRoot || '');
  const runtimeDir = path.resolve(source.runtimeDir || options.runtimeDir || '');
  descendantRelative(runtimeRoot, runtimeDir, 'runtime directory');
  return { source, runtimeRoot, runtimeDir };
}

function verifyRuntimeSubtree(runtimeDir) {
  const pending = [runtimeDir];
  let inspected = 0;
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      inspected += 1;
      if (inspected > 100000) throw new Error('runtime subtree exceeds the validation entry limit');
      const entryPath = path.join(directory, entry.name);
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`runtime subtree contains a reparse point or junction: ${entry.name}`);
      }
      if (stat.isDirectory()) pending.push(entryPath);
      else if (!stat.isFile()) throw new Error(`runtime subtree contains an unsupported entry: ${entry.name}`);
    }
  }
}

function verifyRuntimeOwnership(options = {}, verification = {}) {
  const { source, runtimeRoot, runtimeDir } = lexicalRuntimePaths(options);
  const projectRoot = path.resolve(source.projectRoot || '');
  const projectRealRoot = path.resolve(source.projectRealRoot || '');
  const markerPath = path.resolve(source.markerPath || '');
  const markerToken = String(source.markerToken || '');
  if (!projectRoot || !projectRealRoot || !RUNTIME_OWNER_TOKEN_PATTERN.test(markerToken)) {
    throw new Error('runtime ownership metadata is incomplete');
  }
  if (!sameCanonicalPath(runtimeRoot, path.join(projectRoot, '.omo', 'e2e-runtime'))) {
    throw new Error('runtime root does not match the project ownership anchor');
  }
  if (!sameCanonicalPath(markerPath, path.join(runtimeDir, RUNTIME_OWNER_MARKER))) {
    throw new Error('runtime ownership marker path is invalid');
  }
  verifyRuntimeDirectoryChain({ projectRoot, projectRealRoot, targetPath: runtimeRoot });
  const runtimeStatus = verifyRuntimeDirectoryChain({
    projectRoot,
    projectRealRoot,
    targetPath: runtimeDir,
    allowMissing: verification.allowMissingRuntimeDir === true,
  });
  if (!runtimeStatus.exists) {
    return { projectRoot, projectRealRoot, runtimeRoot, runtimeDir, markerPath, markerToken, exists: false };
  }
  const markerStat = fs.lstatSync(markerPath);
  if (markerStat.isSymbolicLink() || !markerStat.isFile() || markerStat.size !== 33) {
    throw new Error('runtime ownership marker is not a regular bounded file');
  }
  if (fs.readFileSync(markerPath, 'utf8') !== `${markerToken}\n`) {
    throw new Error('runtime ownership marker token does not match in-memory ownership');
  }
  if (verification.verifySubtree === true) verifyRuntimeSubtree(runtimeDir);
  return { projectRoot, projectRealRoot, runtimeRoot, runtimeDir, markerPath, markerToken, exists: true };
}

function createRuntimeLayout(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const projectRealRoot = canonicalRealPath(projectRoot);
  const runStamp = safeRuntimeSegment(options.runStamp, new Date().toISOString());
  const label = safeRuntimeSegment(options.label, 'desktop');
  const runtimeRoot = path.join(projectRoot, '.omo', 'e2e-runtime');
  const runtimeDir = path.join(runtimeRoot, runStamp, label);
  verifyRuntimeDirectoryChain({ projectRoot, projectRealRoot, targetPath: runtimeDir, createMissing: true });
  const markerBytes = (options.randomBytesImpl || crypto.randomBytes)(16);
  if (!Buffer.isBuffer(markerBytes) || markerBytes.length !== 16) {
    throw new Error('runtime ownership token source must return exactly 16 bytes');
  }
  const markerToken = markerBytes.toString('hex');
  const markerPath = path.join(runtimeDir, RUNTIME_OWNER_MARKER);
  fs.writeFileSync(markerPath, `${markerToken}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return {
    projectRoot,
    projectRealRoot,
    runtimeRoot,
    runtimeDir,
    markerPath,
    markerToken,
    userDataDir: path.join(runtimeDir, 'user-data'),
  };
}

function seedProductState(options = {}) {
  const userDataDir = path.resolve(options.userDataDir || '');
  const projectRoot = path.resolve(options.projectRoot || '');
  if (!userDataDir || !projectRoot) throw new Error('seedProductState requires userDataDir and projectRoot');
  const now = new Date().toISOString();
  const projectId = 'project-e2e';
  const activeThreadId = options.activeThreadId || 'thread-e2e';
  // Perf runs seed the 300-entry fixture transcript via options.timeline on
  // 'thread-fixture'; the default thread-e2e stays empty for baseline typing.
  const threadTemplate = (id, title, timeline, modelId) => ({
    id,
    projectId,
    sessionId: null,
    title,
    draft: '',
    timeline: Array.isArray(timeline) ? timeline : [],
    status: 'idle',
    unread: false,
    pinned: false,
    archivedAt: null,
    modelId: modelId || null,
    modeId: 'default',
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    metadata: {},
  });
  const threadIds = [activeThreadId];
  const threadsById = {
    [activeThreadId]: threadTemplate(
      activeThreadId,
      activeThreadId === 'thread-fixture' ? '性能验证会话' : '新对话',
      activeThreadId === 'thread-fixture' ? options.timeline : [],
      activeThreadId === 'thread-fixture' ? options.modelId || 'perf-model' : null,
    ),
  };
  if (activeThreadId !== 'thread-e2e') {
    threadsById['thread-e2e'] = threadTemplate('thread-e2e', '新对话', [], null);
    threadIds.push('thread-e2e');
  }
  for (const extra of options.extraThreads || []) {
    if (threadsById[extra.id]) continue;
    threadsById[extra.id] = threadTemplate(extra.id, extra.title || '新对话', extra.timeline, extra.modelId || null);
    threadIds.push(extra.id);
  }
  const productState = {
    version: 1,
    guiSettings: {},
    projectsById: {
      [projectId]: {
        id: projectId,
        name: path.basename(projectRoot) || 'CodeBuddy E2E',
        workspacePath: projectRoot,
        createdAt: now,
        updatedAt: now,
        lastOpenedAt: now,
        runtimeStatus: 'idle',
        preferences: { sidebarExpanded: true },
      },
    },
    projectOrder: [projectId],
    threadsById,
    threadOrderByProject: { [projectId]: threadIds },
    activeProjectId: projectId,
    activeThreadId,
  };
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, 'product-state.json'), `${JSON.stringify(productState, null, 2)}\n`, 'utf8');
  return productState;
}

async function cleanupRuntimeDir(options = {}) {
  const ownership = verifyRuntimeOwnership(options, {
    allowMissingRuntimeDir: true,
    verifySubtree: true,
  });
  const { runtimeRoot, runtimeDir } = ownership;
  if (!ownership.exists) return { runtimeRoot, runtimeDir, removed: false };
  const quarantineDir = path.join(
    path.dirname(runtimeDir),
    `.codebuddy-e2e-quarantine-${ownership.markerToken}-${crypto.randomBytes(8).toString('hex')}`,
  );
  if (fs.existsSync(quarantineDir)) throw new Error('runtime quarantine path already exists');
  const renameImpl = options.renameImpl || fs.renameSync;
  const waitImpl = options.waitImpl || wait;
  const renameRetries = Number.isInteger(options.renameRetries) ? Math.max(0, options.renameRetries) : 30;
  const renameRetryDelayMs = Number.isInteger(options.renameRetryDelayMs)
    ? Math.max(1, options.renameRetryDelayMs)
    : 100;
  const transientRenameErrors = new Set(['EACCES', 'EBUSY', 'EPERM']);
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameImpl(runtimeDir, quarantineDir);
      break;
    } catch (error) {
      if (!transientRenameErrors.has(error?.code) || attempt >= renameRetries) throw error;
      await waitImpl(renameRetryDelayMs);
      verifyRuntimeOwnership(options, { verifySubtree: true });
    }
  }
  const quarantinedOwnership = {
    ...ownership,
    runtimeDir: quarantineDir,
    markerPath: path.join(quarantineDir, RUNTIME_OWNER_MARKER),
  };
  verifyRuntimeOwnership(quarantinedOwnership, { verifySubtree: true });
  const removeImpl = options.removeImpl || fs.rmSync;
  removeImpl(quarantineDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  // L16: distinguish "original runtime dir gone" from "quarantine dir fully removed".
  // A partial rm leaves a quarantine dir lingering; the caller can sweep stale
  // quarantine dirs at next harness start via sweepStaleQuarantineDirs.
  const removed = !fs.existsSync(runtimeDir);
  const quarantineRemoved = !fs.existsSync(quarantineDir);
  return { runtimeRoot, runtimeDir, removed, quarantineRemoved, quarantineDir };
}

/**
 * L16: sweep stale `.codebuddy-e2e-quarantine-*` directories left behind by a
 * previous run whose rmSync partially failed (AV/indexer lock). Best-effort,
 * never throws — a remaining dir will be retried on the next sweep.
 * @param {string} parentDir the directory that contains runtime dirs (and their quarantines)
 */
function sweepStaleQuarantineDirs(parentDir) {
  let entries = [];
  try { entries = fs.readdirSync(parentDir); } catch { return; }
  for (const name of entries) {
    if (!name.startsWith('.codebuddy-e2e-quarantine-')) continue;
    const qDir = path.join(parentDir, name);
    try {
      fs.rmSync(qDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* leave for next sweep */
    }
  }
}

const WINDOWS_JOB_NAME_PATTERN = /^CodeBuddyE2E-([0-9a-f]{32})$/;
const WINDOWS_JOB_STATE_BYTES = 16 * 1024;
const WINDOWS_JOB_CONFIG_BYTES = 512 * 1024;
const WINDOWS_JOB_SOURCE_BYTES = 256 * 1024;
const windowsJobScriptPath = path.join(__dirname, 'e2e-job-supervisor.ps1');
const windowsJobSourcePath = path.join(__dirname, 'e2e-job-supervisor.cs');
const windowsJobHostPath = path.join(__dirname, 'e2e-job-supervisor-host.cjs');

function runtimeChildPath(runtimeDir, basename) {
  const candidate = path.resolve(runtimeDir, basename);
  if (path.dirname(candidate) !== path.resolve(runtimeDir) || path.basename(candidate) !== basename) {
    throw new Error('Windows Job runtime file must be a direct child of the runtime directory');
  }
  return candidate;
}

function validateWindowsJobRuntime(runtimeOwnership, runtimeRootValue, runtimeDirValue) {
  if (!runtimeOwnership || !runtimeRootValue || !runtimeDirValue) {
    throw new Error('real Windows desktop launches require runtimeRoot and runtimeDir');
  }
  const resolvedRoot = path.resolve(runtimeRootValue);
  const resolvedDir = path.resolve(runtimeDirValue);
  const relative = path.relative(resolvedRoot, resolvedDir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Windows Job runtimeDir must be inside runtimeRoot');
  }
  const verified = verifyRuntimeOwnership({ runtimeOwnership });
  if (!sameCanonicalPath(verified.runtimeRoot, resolvedRoot) ||
      !sameCanonicalPath(verified.runtimeDir, resolvedDir)) {
    throw new Error('Windows Job runtime paths do not match runtime ownership metadata');
  }
  return verified;
}

function boundedWindowsJobEnvironment(baseEnvironment, overrides) {
  const entriesByName = new Map();
  const addEntries = (source) => {
    for (const [rawKey, rawValue] of Object.entries(source || {})) {
      if (rawValue == null) continue;
      const key = String(rawKey);
      const value = String(rawValue);
      if (!key || key.length > 32767 || key.includes('\0') || key.includes('=')) {
        throw new Error('Windows Job environment contains an invalid key');
      }
      if (value.length > 32767 || value.includes('\0')) {
        throw new Error(`Windows Job environment value for ${key} is outside its allowed bounds`);
      }
      entriesByName.set(key.toLowerCase(), { key, value });
    }
  };
  addEntries(baseEnvironment);
  addEntries({ ELECTRON_ENABLE_LOGGING: '1' });
  addEntries(overrides);
  if (entriesByName.size > 512) throw new Error('Windows Job environment exceeds 512 entries');
  const environment = {};
  let characters = 1;
  for (const { key, value } of entriesByName.values()) {
    characters += key.length + value.length + 2;
    if (characters > 32760) throw new Error('Windows Job environment exceeds 32760 characters');
    environment[key] = value;
  }
  return environment;
}

function validateWindowsJobLaunchValues(executable, launchArgs, projectRoot) {
  const executableValue = String(executable || '');
  const workingDirectory = path.resolve(projectRoot || process.cwd());
  if (!path.isAbsolute(executableValue) || !fs.existsSync(executableValue)) {
    throw new Error('real Windows desktop launch executable must be an existing absolute path');
  }
  if (!fs.statSync(executableValue).isFile() || executableValue.length > 32767 || executableValue.includes('\0')) {
    throw new Error('real Windows desktop launch executable is outside its allowed bounds');
  }
  if (!fs.existsSync(workingDirectory) || !fs.statSync(workingDirectory).isDirectory()) {
    throw new Error('real Windows desktop launch working directory must exist');
  }
  if (!Array.isArray(launchArgs) || launchArgs.length > 256) {
    throw new Error('real Windows desktop launch arguments exceed the allowed count');
  }
  let argumentCharacters = 0;
  const argumentsList = launchArgs.map((value) => {
    const text = String(value);
    if (text.length > 32767 || text.includes('\0')) {
      throw new Error('real Windows desktop launch argument is outside its allowed bounds');
    }
    argumentCharacters += text.length + 1;
    if (argumentCharacters > 32767) throw new Error('real Windows desktop launch arguments are too large');
    return text;
  });
  return { executable: executableValue, arguments: argumentsList, workingDirectory };
}

function writeAtomicOwnedFile(targetPath, content, maximumBytes, runtimeOwnership) {
  const ownership = verifyRuntimeOwnership({ runtimeOwnership });
  if (!sameCanonicalPath(path.dirname(targetPath), ownership.runtimeDir)) {
    throw new Error('owned runtime file is outside the verified runtime directory');
  }
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes < 1 || bytes > maximumBytes) {
    throw new Error(`owned runtime file ${path.basename(targetPath)} is outside its allowed size`);
  }
  const temporaryPath = runtimeChildPath(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  fs.writeFileSync(temporaryPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    verifyRuntimeOwnership({ runtimeOwnership });
    fs.renameSync(temporaryPath, targetPath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (_) {
      // The exact temporary path remains inside the owned runtime directory.
    }
    throw error;
  }
}

function normalizeWindowsJobState(value, expectedJobName) {
  if (!value || value.version !== 1 || value.kind !== 'windows-job' || value.jobName !== expectedJobName) {
    throw new Error('Windows Job state identity is invalid');
  }
  if (!WINDOWS_JOB_NAME_PATTERN.test(value.jobName)) throw new Error('Windows Job state name is invalid');
  const boolean = (name) => {
    if (typeof value[name] !== 'boolean') throw new Error(`Windows Job state ${name} is invalid`);
    return value[name];
  };
  const integer = (name, minimum, maximum) => {
    const candidate = Number(value[name]);
    if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
      throw new Error(`Windows Job state ${name} is invalid`);
    }
    return candidate;
  };
  const closeReasons = new Set([
    'starting',
    'running',
    'stdin-eof',
    'controller-close',
    'invalid-control',
    'supervisor-error',
    'supervisor-finally',
    'emergency-terminate',
  ]);
  if (typeof value.closeReason !== 'string' || !closeReasons.has(value.closeReason)) {
    throw new Error('Windows Job state closeReason is invalid');
  }
  return {
    version: 1,
    kind: 'windows-job',
    jobName: value.jobName,
    jobCreatedNew: boolean('jobCreatedNew'),
    collisionDetected: boolean('collisionDetected'),
    established: boolean('established'),
    rootCreatedSuspended: boolean('rootCreatedSuspended'),
    rootAssignedBeforeResume: boolean('rootAssignedBeforeResume'),
    rootResumed: boolean('rootResumed'),
    killOnJobClose: boolean('killOnJobClose'),
    rootPid: integer('rootPid', 0, 0xffffffff),
    activeProcessCount: integer('activeProcessCount', -1, 0x7fffffff),
    zeroVerified: boolean('zeroVerified'),
    jobClosed: boolean('jobClosed'),
    closeReason: value.closeReason,
    win32Error: integer('win32Error', 0, 0x7fffffff),
  };
}

function readWindowsJobState(statePath, jobName, runtimeOwnership) {
  const ownership = verifyRuntimeOwnership({ runtimeOwnership });
  if (!sameCanonicalPath(path.dirname(statePath), ownership.runtimeDir)) {
    throw new Error('Windows Job state is outside the verified runtime directory');
  }
  const stat = fs.statSync(statePath);
  if (!stat.isFile() || stat.size < 2 || stat.size > WINDOWS_JOB_STATE_BYTES) {
    throw new Error('Windows Job state file is outside its allowed size');
  }
  return normalizeWindowsJobState(JSON.parse(fs.readFileSync(statePath, 'utf8')), jobName);
}

function stateProvesOwnedEstablishedJob(state) {
  return state?.jobCreatedNew === true &&
    state?.collisionDetected === false &&
    state?.established === true &&
    state?.rootAssignedBeforeResume === true;
}

function stateProvesNoOwnedRoot(state) {
  return state?.jobCreatedNew === false &&
    state?.collisionDetected === true &&
    state?.rootCreatedSuspended === false &&
    state?.rootPid === 0;
}

function ownershipCleanupFromState(state, overrides = {}) {
  const noOwnedRoot = overrides.noOwnedRoot === true && stateProvesNoOwnedRoot(state);
  const activeCount = noOwnedRoot
    ? 0
    : Number.isInteger(overrides.activeProcessCount)
    ? overrides.activeProcessCount
    : state?.activeProcessCount;
  const zeroVerified = noOwnedRoot || overrides.zeroVerified === true || state?.zeroVerified === true;
  const verified = zeroVerified && activeCount === 0;
  return {
    ownershipBoundary: {
      kind: 'windows-job',
      jobCreatedNew: state?.jobCreatedNew === true,
      collisionDetected: state?.collisionDetected === true,
      established: state?.established === true,
      rootCreatedSuspended: state?.rootCreatedSuspended === true,
      rootAssignedBeforeResume: state?.rootAssignedBeforeResume === true,
      rootResumed: state?.rootResumed === true,
      killOnJobClose: state?.killOnJobClose === true,
      jobClosed: overrides.jobClosed === true || state?.jobClosed === true,
      closeReason: overrides.closeReason || state?.closeReason || 'supervisor-error',
      rootPid: Number.isInteger(state?.rootPid) && state.rootPid > 0 ? state.rootPid : null,
      win32Error: Number.isInteger(overrides.win32Error) ? overrides.win32Error : state?.win32Error || 0,
      supervisorReaped: overrides.supervisorReaped === true,
    },
    remainingVerifiedProcesses: {
      basis: noOwnedRoot ? 'controller-no-owned-root' : 'job-active-process-count',
      verified,
      count: Number.isInteger(activeCount) && activeCount >= 0 ? activeCount : null,
      empty: verified,
    },
  };
}

function sanitizeSecondaryCleanupText(value, replacements = []) {
  let text = String(value?.message || value || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\b(password|passwd|token|authorization|cookie|secret)\s*[:=]\s*[^\s;,]+/gi, '$1=[redacted]');
  for (const [rawPath, replacement] of replacements) {
    if (!rawPath) continue;
    text = text.replaceAll(String(rawPath), replacement);
    if (process.platform === 'win32') {
      const lowerPath = String(rawPath).toLowerCase();
      let index = text.toLowerCase().indexOf(lowerPath);
      while (index >= 0) {
        text = `${text.slice(0, index)}${replacement}${text.slice(index + lowerPath.length)}`;
        index = text.toLowerCase().indexOf(lowerPath, index + replacement.length);
      }
    }
  }
  return text.slice(0, 2000);
}

function safeOwnershipBoundary(value) {
  if (!value || value.kind !== 'windows-job') return null;
  const closeReasons = new Set([
    'starting',
    'running',
    'stdin-eof',
    'controller-close',
    'invalid-control',
    'supervisor-error',
    'supervisor-finally',
    'emergency-terminate',
  ]);
  return {
    kind: 'windows-job',
    jobCreatedNew: value.jobCreatedNew === true,
    collisionDetected: value.collisionDetected === true,
    established: value.established === true,
    rootCreatedSuspended: value.rootCreatedSuspended === true,
    rootAssignedBeforeResume: value.rootAssignedBeforeResume === true,
    rootResumed: value.rootResumed === true,
    killOnJobClose: value.killOnJobClose === true,
    jobClosed: value.jobClosed === true,
    closeReason: closeReasons.has(value.closeReason) ? value.closeReason : 'supervisor-error',
    rootPid: Number.isInteger(value.rootPid) && value.rootPid > 0 ? value.rootPid : null,
    win32Error: Number.isInteger(value.win32Error) && value.win32Error >= 0 ? value.win32Error : 0,
    supervisorReaped: value.supervisorReaped === true,
  };
}

function safeRemainingVerifiedProcesses(value) {
  const allowedBases = new Set(['job-active-process-count', 'controller-no-owned-root']);
  if (!value || !allowedBases.has(value.basis)) return null;
  const count = Number.isInteger(value.count) && value.count >= 0 ? value.count : null;
  const verified = value.verified === true && count === 0;
  return {
    basis: value.basis,
    verified,
    count,
    empty: verified && value.empty === true,
  };
}

function createOwnershipCleanupEvidence(options = {}) {
  const { error, launched, ownershipController, cleanup } = options;
  const sanitize = typeof options.sanitize === 'function'
    ? (value) => String(options.sanitize(value))
    : (value) => sanitizeSecondaryCleanupText(value);
  let controllerSnapshot = null;
  try {
    controllerSnapshot = ownershipController?.snapshot?.() || launched?.ownershipController?.snapshot?.() || null;
  } catch (_) {
    controllerSnapshot = null;
  }
  const ownershipBoundary = safeOwnershipBoundary(
    cleanup?.ownershipBoundary || error?.ownershipBoundary ||
      controllerSnapshot?.ownershipBoundary || launched?.ownershipBoundary,
  );
  const remainingVerifiedProcesses = safeRemainingVerifiedProcesses(
    cleanup?.remainingVerifiedProcesses || error?.remainingVerifiedProcesses ||
      controllerSnapshot?.remainingVerifiedProcesses,
  );
  const launchCleanupErrors = (error?.launchCleanupErrors || cleanup?.launchCleanupErrors || [])
    .map((entry) => sanitize(entry))
    .filter(Boolean)
    .slice(0, 64);
  const warnings = (cleanup?.warnings || []).map((entry) => sanitize(entry)).filter(Boolean).slice(0, 64);
  const errors = (cleanup?.errors || []).map((entry) => {
    if (entry && typeof entry === 'object') {
      return { ...(Number.isInteger(entry.pid) ? { pid: entry.pid } : {}), error: sanitize(entry.error || entry) };
    }
    return sanitize(entry);
  }).slice(0, 64);
  return {
    launchCleanupErrors,
    ownershipBoundary,
    remainingVerifiedProcesses,
    warnings,
    errors,
    ...(cleanup?.rootPid == null ? {} : { rootPid: cleanup.rootPid }),
    ...(Array.isArray(cleanup?.initialOwnedPids) ? { initialOwnedPids: cleanup.initialOwnedPids } : {}),
    ...(Array.isArray(cleanup?.attemptedPids) ? { attemptedPids: cleanup.attemptedPids } : {}),
    ...(Array.isArray(cleanup?.remainingPids) ? { remainingPids: cleanup.remainingPids } : {}),
  };
}

function freezeEmergencySnapshot(value, sanitize, depth = 0) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return sanitize(value).slice(0, 4000);
  if (depth >= 8) return '[bounded]';
  if (Array.isArray(value)) {
    return Object.freeze(value.slice(0, 64).map((entry) => freezeEmergencySnapshot(entry, sanitize, depth + 1)));
  }
  if (typeof value === 'object') {
    const entries = [];
    for (const [key, entry] of Object.entries(value).slice(0, 64)) {
      if (/commandLine|environment/i.test(key)) continue;
      entries.push([key, freezeEmergencySnapshot(entry, sanitize, depth + 1)]);
    }
    return Object.freeze(Object.fromEntries(entries));
  }
  return sanitize(String(value)).slice(0, 4000);
}

async function finalizeHarnessRun(options = {}) {
  const branch = options.error?.finalizationSafe === false ? 'unsafe' : 'normal';
  const finalizer = branch === 'unsafe' ? options.unsafeFinalizer : options.normalFinalizer;
  if (typeof finalizer !== 'function') {
    return Object.freeze({
      branch,
      result: null,
      finalizerError: new TypeError(`${branch} harness finalizer is required`),
    });
  }
  try {
    return Object.freeze({ branch, result: await finalizer(options.error), finalizerError: null });
  } catch (finalizerError) {
    return Object.freeze({ branch, result: null, finalizerError });
  }
}

function unsafeStderrFailureText(entry, sanitize) {
  let value = entry;
  let prefix = '';
  if (entry && typeof entry === 'object') {
    value = entry.error ?? entry.message ?? '';
    if (Number.isInteger(entry.pid)) prefix = `pid ${entry.pid}: `;
  }
  if (value == null || value === '') return '';
  return sanitize(`${prefix}${value}`).slice(0, 2000);
}

function collectUnsafeStderrFailures(options = {}) {
  const { cleanup, secondaryErrors, evidenceWriteError, sanitize } = options;
  const failures = [];
  const seen = new Set();
  const add = (entry) => {
    const text = unsafeStderrFailureText(entry, sanitize);
    if (!text || seen.has(text) || failures.length >= 256) return;
    seen.add(text);
    failures.push(text);
  };
  for (const entry of cleanup?.launchCleanupErrors || []) add(entry);
  for (const entry of cleanup?.errors || []) add(entry);
  for (const entry of secondaryErrors || []) add(entry);
  add(evidenceWriteError);
  return Object.freeze(failures);
}

function boundedPromise(task, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([Promise.resolve().then(task), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function finalizeUnsafeHarnessFailure(options = {}) {
  const {
    error,
    ownershipController,
    runtimeOwnership,
    runtimeRoot,
    runtimeDir,
    evidenceOptions = {},
    writeEvidence,
  } = options;
  const replacements = [
    [runtimeDir, '[runtime-dir]'],
    [runtimeRoot, '[runtime-root]'],
    [evidenceOptions.pathRoot, '[project-root]'],
    [os.homedir(), '[user-home]'],
    [process.env.USERPROFILE, '[user-home]'],
    [process.env.HOME, '[user-home]'],
  ];
  const requestedSanitize = typeof options.sanitize === 'function'
    ? (value) => String(options.sanitize(value))
    : (value) => value;
  const sanitize = (value) => sanitizeSecondaryCleanupText(requestedSanitize(value), replacements).slice(0, 4000);
  const secondaryErrors = [];
  let emergencyCleanup = null;

  try {
    emergencyCleanup = ownershipController?.emergencyClose?.() || null;
    if (!emergencyCleanup) secondaryErrors.push('ownership controller unavailable during unsafe finalization');
  } catch (emergencyError) {
    secondaryErrors.push(`emergency ownership cleanup failed: ${sanitize(emergencyError)}`);
    try {
      emergencyCleanup = ownershipController?.snapshot?.() || null;
    } catch (snapshotError) {
      secondaryErrors.push(`emergency ownership snapshot failed: ${sanitize(snapshotError)}`);
    }
  }

  const redactionMap = Object.freeze(
    Object.fromEntries(Object.entries(evidenceOptions.redactionMap || {}).slice(0, 64)),
  );
  const frozenEvidenceOptions = Object.freeze({
    runDir: evidenceOptions.runDir ? path.resolve(evidenceOptions.runDir) : '',
    pathRoot: path.resolve(evidenceOptions.pathRoot || process.cwd()),
    redactionMap,
    taskId: sanitize(evidenceOptions.taskId || 'task-1').slice(0, 128),
    runLabel: sanitize(evidenceOptions.runLabel || 'unsafe-finalization').slice(0, 128),
    timestamp: sanitize(evidenceOptions.timestamp || new Date().toISOString()).slice(0, 128),
    context: freezeEmergencySnapshot(evidenceOptions.context || {}, sanitize),
    command: sanitize(evidenceOptions.command || 'unsafe harness finalization').slice(0, 512),
  });
  const initialCleanup = createOwnershipCleanupEvidence({
    error,
    launched: null,
    ownershipController,
    cleanup: emergencyCleanup,
    sanitize,
  });
  const frozenInitialCleanup = freezeEmergencySnapshot(initialCleanup, sanitize);
  const errorCode = String(error?.code || 'E_UNSAFE_FINALIZATION')
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .slice(0, 128);
  const errorMessage = sanitize(error?.message || error || 'unsafe harness finalization');
  const runtimeRemoval = { attempted: true, removed: false };

  try {
    const removed = await cleanupRuntimeDir({ runtimeOwnership, runtimeRoot, runtimeDir });
    runtimeRemoval.removed = removed.removed === true || !fs.existsSync(path.resolve(runtimeDir || ''));
    if (!runtimeRemoval.removed) throw new Error('owned runtime directory still exists after cleanup');
  } catch (runtimeError) {
    secondaryErrors.push(`runtime cleanup failed: ${sanitize(runtimeError)}`);
  }

  const frozenRuntimeRemoval = Object.freeze({ ...runtimeRemoval });
  const frozenSecondaryErrors = Object.freeze(secondaryErrors.map((entry) => sanitize(entry)).slice(0, 64));
  const cleanupEvidence = Object.freeze({
    ...frozenInitialCleanup,
    launchCleanupErrors: Object.freeze([
      ...(frozenInitialCleanup.launchCleanupErrors || []),
      ...frozenSecondaryErrors,
    ].slice(0, 64)),
    warnings: Object.freeze([...(frozenInitialCleanup.warnings || [])].slice(0, 64)),
    errors: Object.freeze([...(frozenInitialCleanup.errors || [])].slice(0, 64)),
  });
  const failure = Object.freeze({
    kind: 'unsafe-finalization',
    code: errorCode,
    message: errorMessage,
    finalizationSafe: false,
    runtimeRemoval: frozenRuntimeRemoval,
    secondaryErrors: frozenSecondaryErrors,
  });
  const zeroVerified = cleanupEvidence.remainingVerifiedProcesses?.verified === true &&
    cleanupEvidence.remainingVerifiedProcesses?.count === 0;
  const evidencePayload = Object.freeze({
    runDir: frozenEvidenceOptions.runDir,
    pathRoot: frozenEvidenceOptions.pathRoot,
    redactionMap: frozenEvidenceOptions.redactionMap,
    taskId: frozenEvidenceOptions.taskId || 'task-1',
    runLabel: frozenEvidenceOptions.runLabel || 'unsafe-finalization',
    timestamp: frozenEvidenceOptions.timestamp,
    status: 'FAIL',
    context: frozenEvidenceOptions.context || Object.freeze({}),
    commands: Object.freeze([
      Object.freeze({ command: frozenEvidenceOptions.command || 'unsafe harness finalization', exitCode: 1 }),
    ]),
    assertions: Object.freeze([
      Object.freeze({ name: 'hard watchdog failure recorded', ok: false, detail: `${errorCode}: ${errorMessage}` }),
      Object.freeze({
        name: 'emergency ownership cleanup verified zero active members',
        ok: zeroVerified,
        detail: `active=${cleanupEvidence.remainingVerifiedProcesses?.count ?? '<unverified>'}`,
      }),
      Object.freeze({
        name: 'isolated runtime removed during unsafe finalization',
        ok: frozenRuntimeRemoval.removed,
        detail: frozenRuntimeRemoval.removed ? 'removed' : 'not removed',
      }),
    ]),
    screenshots: Object.freeze([]),
    logs: Object.freeze([]),
    failure,
    cleanup: cleanupEvidence,
  });

  let evidencePaths = null;
  let evidenceWriteError = null;
  try {
    if (typeof writeEvidence !== 'function') throw new Error('unsafe finalization requires writeEvidence');
    const written = await boundedPromise(
      () => writeEvidence(evidencePayload),
      Number.isInteger(options.evidenceTimeoutMs) ? options.evidenceTimeoutMs : 10000,
      'unsafe failure evidence write',
    );
    if (!written?.jsonPath || !written?.reportPath ||
        !fs.existsSync(written.jsonPath) || !fs.existsSync(written.reportPath)) {
      throw new Error('unsafe failure evidence files were not created');
    }
    evidencePaths = Object.freeze({
      runDir: written.runDir,
      jsonPath: written.jsonPath,
      reportPath: written.reportPath,
    });
  } catch (writeError) {
    evidenceWriteError = sanitize(`unsafe failure evidence write failed: ${writeError?.message || writeError}`);
  }

  const stderrFailures = collectUnsafeStderrFailures({
    cleanup: cleanupEvidence,
    secondaryErrors: frozenSecondaryErrors,
    evidenceWriteError,
    sanitize,
  });

  return Object.freeze({
    cleanup: cleanupEvidence,
    runtimeRemoval: frozenRuntimeRemoval,
    failure,
    evidencePaths,
    evidenceWriteError,
    stderrFailures,
  });
}

function windowsJobPowerShellArgs(mode, metadata) {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    windowsJobScriptPath,
    '-Mode',
    mode,
    '-RuntimeDir',
    metadata.runtimeDir,
    '-ConfigPath',
    metadata.configPath,
    '-StatePath',
    metadata.statePath,
    '-SourcePath',
    metadata.sourcePath,
    '-SourceSha256',
    metadata.sourceSha256,
    '-JobName',
    metadata.jobName,
    '-ControlPipeName',
    metadata.controlPipeName,
    '-ControlPipeToken',
    metadata.controlPipeToken,
    '-ProjectRoot',
    metadata.runtimeOwnership.projectRoot,
    '-ProjectRealRoot',
    metadata.runtimeOwnership.projectRealRoot,
    '-MarkerPath',
    metadata.runtimeOwnership.markerPath,
    '-MarkerToken',
    metadata.runtimeOwnership.markerToken,
  ];
}

async function createWindowsJobControlListener(pipeName) {
  if (!/^CodeBuddyE2E-Control-[0-9a-f]{32}$/.test(pipeName)) {
    throw new Error('Windows Job control pipe name is invalid');
  }
  const pipePath = `\\\\.\\pipe\\${pipeName}`;
  const server = net.createServer();
  server.maxConnections = 1;
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(pipePath);
  });
  return { server, pipePath };
}

function waitForWindowsJobControlConnection(listener, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      listener.server.removeListener('connection', onConnection);
      listener.server.removeListener('error', onError);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const closeListener = () => {
      if (listener.server.listening) listener.server.close();
    };
    const onConnection = (socket) => {
      cleanup();
      closeListener();
      socket.on('error', () => {});
      resolve(socket);
    };
    const onError = (error) => {
      cleanup();
      closeListener();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      closeListener();
      reject(abortError(signal, 'Windows Job control pipe connection aborted'));
    };
    listener.server.once('connection', onConnection);
    listener.server.once('error', onError);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      closeListener();
      reject(new Error(`Windows Job control pipe connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

function waitForChildSpawn(child, timeoutMs, signal, label) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      child.removeListener?.('spawn', onSpawn);
      child.removeListener?.('error', onError);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError(signal, `${label} aborted before spawn completed`));
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${label} spawn event timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      child.removeListener?.('exit', onExit);
      child.removeListener?.('error', onError);
    };
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    child.once('exit', onExit);
    child.once('error', onError);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Windows Job supervisor exit timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

function parseEmergencyJobResult(stdout, jobName) {
  const line = String(stdout || '').split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean).at(-1);
  if (!line || Buffer.byteLength(line, 'utf8') > 4096) {
    throw new Error('Windows Job emergency termination returned no bounded result');
  }
  const value = JSON.parse(line);
  if (value?.version !== 1 || value?.kind !== 'windows-job' || value?.jobName !== jobName) {
    throw new Error('Windows Job emergency termination returned an invalid identity');
  }
  const activeProcessCount = Number(value.activeProcessCount);
  const win32Error = Number(value.win32Error);
  if (!Number.isInteger(activeProcessCount) || activeProcessCount < -1 ||
      !Number.isInteger(win32Error) || win32Error < 0 || typeof value.zeroVerified !== 'boolean') {
    throw new Error('Windows Job emergency termination returned invalid proof fields');
  }
  return { activeProcessCount, win32Error, zeroVerified: value.zeroVerified === true };
}

function removeExactControllerFile(filePath, runtimeDir, expectedBasename, runtimeOwnership) {
  const ownership = verifyRuntimeOwnership({ runtimeOwnership });
  if (!sameCanonicalPath(ownership.runtimeDir, runtimeDir)) {
    throw new Error('refusing to remove a Windows Job controller file from an unverified runtime');
  }
  if (filePath !== runtimeChildPath(runtimeDir, expectedBasename)) {
    throw new Error('refusing to remove an unvalidated Windows Job controller file');
  }
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function createWindowsJobController(options) {
  const { supervisor, metadata, spawnSyncImpl = spawnSync } = options;
  let latestState = null;
  let closePromise = null;
  let completedCleanup = null;

  supervisor.stdin?.on?.('error', () => {});

  const refreshState = () => {
    try {
      latestState = readWindowsJobState(metadata.statePath, metadata.jobName, metadata.runtimeOwnership);
    } catch (_) {
      // An atomic state update may not exist yet; the previous verified snapshot remains authoritative.
    }
    return latestState;
  };

  const snapshot = () => completedCleanup || ownershipCleanupFromState(refreshState());

  const emergencyClose = () => {
    if (completedCleanup?.remainingVerifiedProcesses?.empty) return completedCleanup;
    refreshState();
    if (!stateProvesOwnedEstablishedJob(latestState)) {
      try {
        supervisor.stdin?.destroy?.();
      } catch (_) {
        // Closing this controller's pipe cannot affect a foreign Job.
      }
      const cleanup = ownershipCleanupFromState(latestState, {
        noOwnedRoot: stateProvesNoOwnedRoot(latestState),
        supervisorReaped: supervisor.exitCode != null || supervisor.signalCode != null,
      });
      completedCleanup = cleanup;
      return cleanup;
    }
    let proof = null;
    let emergencyError = null;
    try {
      const run = spawnSyncImpl('powershell.exe', windowsJobPowerShellArgs('Terminate', metadata), {
        cwd: metadata.runtimeDir,
        encoding: 'utf8',
        timeout: 15000,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
        windowsHide: true,
      });
      if (run.error) throw run.error;
      proof = parseEmergencyJobResult(run.stdout, metadata.jobName);
      if (run.status !== 0 || !proof.zeroVerified || proof.activeProcessCount !== 0) {
        throw new Error(`Windows Job emergency termination did not verify zero members (status=${run.status})`);
      }
    } catch (error) {
      emergencyError = error;
    } finally {
      try {
        supervisor.stdin?.destroy?.();
      } catch (_) {
        // The owned control pipe may already be closed.
      }
    }
    const cleanup = ownershipCleanupFromState(latestState, {
      activeProcessCount: proof?.activeProcessCount,
      zeroVerified: proof?.zeroVerified,
      jobClosed: proof?.zeroVerified,
      closeReason: 'emergency-terminate',
      win32Error: proof?.win32Error,
      supervisorReaped: false,
    });
    if (emergencyError) {
      cleanup.errors = [{ error: sanitizeSecondaryCleanupText(emergencyError) }];
    }
    completedCleanup = cleanup;
    return cleanup;
  };

  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      let cleanup = null;
      let primaryError = null;
      try {
        if (supervisor.exitCode == null && supervisor.signalCode == null &&
            supervisor.stdin && !supervisor.stdin.destroyed) {
          supervisor.stdin.end('CLOSE\n');
        }
        const exit = await waitForChildExit(supervisor, 15000);
        latestState = readWindowsJobState(
          metadata.statePath,
          metadata.jobName,
          metadata.runtimeOwnership,
        );
        const noOwnedRoot = stateProvesNoOwnedRoot(latestState);
        cleanup = ownershipCleanupFromState(latestState, { noOwnedRoot, supervisorReaped: true });
        if (!noOwnedRoot && (exit.code !== 0 || !cleanup.ownershipBoundary.jobClosed ||
            !cleanup.remainingVerifiedProcesses.verified || cleanup.remainingVerifiedProcesses.count !== 0)) {
          throw new Error(
            `Windows Job supervisor cleanup was not verified (exit=${exit.code}, ` +
              `active=${cleanup.remainingVerifiedProcesses.count})`,
          );
        }
      } catch (error) {
        primaryError = error;
        cleanup = emergencyClose();
        if (!cleanup.remainingVerifiedProcesses.verified || cleanup.remainingVerifiedProcesses.count !== 0) {
          const failure = new Error('Windows Job cleanup failed to verify zero active members');
          failure.cause = primaryError;
          failure.ownershipBoundary = cleanup.ownershipBoundary;
          failure.remainingVerifiedProcesses = cleanup.remainingVerifiedProcesses;
          throw failure;
        }
      } finally {
        try {
          removeExactControllerFile(
            metadata.configPath,
            metadata.runtimeDir,
            `e2e-job-${metadata.token}.config.json`,
            metadata.runtimeOwnership,
          );
        } catch (error) {
          if (!primaryError) primaryError = error;
        }
        try {
          removeExactControllerFile(
            metadata.statePath,
            metadata.runtimeDir,
            `e2e-job-${metadata.token}.state.json`,
            metadata.runtimeOwnership,
          );
        } catch (error) {
          if (!primaryError) primaryError = error;
        }
      }
      completedCleanup = cleanup;
      if (primaryError && !cleanup?.remainingVerifiedProcesses?.verified) throw primaryError;
      return cleanup;
    })();
    return closePromise;
  };

  const waitUntilReady = async (timeoutMs, signal) => {
    const deadline = Date.now() + timeoutMs;
    do {
      throwIfAborted(signal, 'Windows Job launch aborted while waiting for ownership proof');
      const state = refreshState();
      if (stateProvesOwnedEstablishedJob(state) && state.rootCreatedSuspended &&
          state.rootResumed && state.killOnJobClose && state.rootPid > 0) {
        return state;
      }
      if (supervisor.exitCode != null || supervisor.signalCode != null) {
        throw new Error(
          `Windows Job supervisor exited before ownership was established ` +
            `(exit=${supervisor.exitCode}, win32=${state?.win32Error ?? 0})`,
        );
      }
      if (Date.now() < deadline) await wait(25, { signal });
    } while (Date.now() < deadline);
    throw new Error(`Windows Job ownership proof timed out after ${timeoutMs}ms`);
  };

  return {
    kind: 'windows-job',
    authoritative: true,
    close,
    emergencyClose,
    snapshot,
    waitUntilReady,
  };
}

function createDiagnosticRootTracker(rootIdentity) {
  const snapshot = () => [{ ...rootIdentity }];
  return {
    authoritative: false,
    basis: 'diagnostic-root-snapshot',
    warnings: [],
    snapshot,
    async start() {
      return snapshot();
    },
    async stop() {
      return snapshot();
    },
  };
}

function findAvailablePort(hostOrOptions = '127.0.0.1', providedOptions = {}) {
  const options = typeof hostOrOptions === 'object' ? hostOrOptions : providedOptions;
  const host = typeof hostOrOptions === 'string' ? hostOrOptions : '127.0.0.1';
  const signal = options.signal;
  throwIfAborted(signal, 'available-port selection aborted');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    const cleanup = () => signal?.removeEventListener?.('abort', onAbort);
    const onAbort = () => {
      cleanup();
      server.close(() => reject(abortError(signal, 'available-port selection aborted')));
    };
    server.once('error', (error) => {
      cleanup();
      reject(error);
    });
    server.listen(0, host, () => {
      const address = server.address();
      server.close((error) => {
        cleanup();
        if (error) reject(error);
        else resolve(address.port);
      });
    });
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function portIsAvailable(port, hostOrOptions = '127.0.0.1', providedOptions = {}) {
  const options = typeof hostOrOptions === 'object' ? hostOrOptions : providedOptions;
  const host = typeof hostOrOptions === 'string' ? hostOrOptions : '127.0.0.1';
  const signal = options.signal;
  throwIfAborted(signal, 'port-availability check aborted');
  return new Promise((resolve) => {
    const server = net.createServer();
    const cleanup = () => signal?.removeEventListener?.('abort', onAbort);
    const onAbort = () => {
      cleanup();
      server.close(() => resolve(false));
    };
    server.once('error', () => {
      cleanup();
      resolve(false);
    });
    server.listen(port, host, () => server.close(() => {
      cleanup();
      resolve(true);
    }));
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

async function launchDesktopWithWindowsJob(options) {
  const {
    executable,
    launchArgs,
    projectRoot,
    env,
    windowsHide,
    spawnTimeoutMs,
    identityTimeoutMs,
    listProcesses,
    runtimeRoot,
    runtimeDir,
    runtimeOwnership,
    signal,
    onOwnershipController,
    debugPort,
    randomBytesImpl,
  } = options;
  let layout = null;
  let supervisor = null;
  let ownershipController = null;
  let metadata = null;
  let controlListener = null;
  let controlConnectionPromise = null;
  let controlSocket = null;
  const launchCleanupErrors = [];
  const replacements = [
    [runtimeDir, '[runtime-dir]'],
    [runtimeRoot, '[runtime-root]'],
    [projectRoot, '[project-root]'],
  ];

  try {
    layout = validateWindowsJobRuntime(runtimeOwnership, runtimeRoot, runtimeDir);
    if (!fs.existsSync(windowsJobScriptPath) || !fs.existsSync(windowsJobSourcePath) ||
        !fs.existsSync(windowsJobHostPath)) {
      throw new Error('Windows Job supervisor sources are missing');
    }
    const tokenBytes = randomBytesImpl(16);
    if (!Buffer.isBuffer(tokenBytes) || tokenBytes.length !== 16) {
      throw new Error('Windows Job random token source must return exactly 16 bytes');
    }
    const token = tokenBytes.toString('hex');
    const jobName = `CodeBuddyE2E-${token}`;
    const controlTokenBytes = crypto.randomBytes(16);
    const controlPipeToken = controlTokenBytes.toString('hex');
    const controlPipeName = `CodeBuddyE2E-Control-${controlPipeToken}`;
    const configPath = runtimeChildPath(layout.runtimeDir, `e2e-job-${token}.config.json`);
    const statePath = runtimeChildPath(layout.runtimeDir, `e2e-job-${token}.state.json`);
    const sourcePath = runtimeChildPath(layout.runtimeDir, `e2e-job-${token}.cs`);
    const source = fs.readFileSync(windowsJobSourcePath, 'utf8');
    if (Buffer.byteLength(source, 'utf8') > WINDOWS_JOB_SOURCE_BYTES) {
      throw new Error('Windows Job supervisor source exceeds its allowed size');
    }
    const sourceSha256 = crypto.createHash('sha256').update(source, 'utf8').digest('hex');
    writeAtomicOwnedFile(sourcePath, source, WINDOWS_JOB_SOURCE_BYTES, layout);
    const environment = boundedWindowsJobEnvironment(process.env, env);
    const config = validateWindowsJobLaunchValues(executable, launchArgs, projectRoot);
    const configText = `${JSON.stringify({ version: 2, jobName, ...config })}\n`;
    writeAtomicOwnedFile(configPath, configText, WINDOWS_JOB_CONFIG_BYTES, layout);
    metadata = {
      token,
      jobName,
      runtimeDir: layout.runtimeDir,
      configPath,
      statePath,
      sourcePath,
      sourceSha256,
      controlPipeName,
      controlPipeToken,
      runtimeOwnership: layout,
    };

    controlListener = await createWindowsJobControlListener(controlPipeName);
    controlConnectionPromise = waitForWindowsJobControlConnection(controlListener, spawnTimeoutMs, signal);
    controlConnectionPromise.catch(() => {});

    supervisor = spawn(process.execPath, [windowsJobHostPath, ...windowsJobPowerShellArgs('Supervise', metadata)], {
      cwd: layout.runtimeDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: windowsHide !== false,
      detached: true,
      env: environment,
    });
    if (!supervisor || typeof supervisor.once !== 'function') {
      throw new Error('Windows Job launch did not receive a ChildProcess-like supervisor');
    }
    const stdout = [];
    const stderr = [];
    let captureOutput = !signal?.aborted;
    const stopOutputCapture = () => {
      captureOutput = false;
    };
    signal?.addEventListener?.('abort', stopOutputCapture, { once: true });
    supervisor.stdout?.on?.('data', (chunk) => {
      if (captureOutput) stdout.push(String(chunk));
    });
    supervisor.stderr?.on?.('data', (chunk) => {
      if (captureOutput) stderr.push(String(chunk));
    });

    await waitForChildSpawn(supervisor, spawnTimeoutMs, signal, 'Windows Job supervisor');
    controlSocket = await controlConnectionPromise;
    supervisor.stdin = controlSocket;
    if (supervisor.stdin !== controlSocket) {
      throw new Error('Windows Job supervisor control pipe could not be attached');
    }
    ownershipController = createWindowsJobController({ supervisor, metadata });
    if (typeof onOwnershipController === 'function') onOwnershipController(ownershipController);
    const readyState = await ownershipController.waitUntilReady(spawnTimeoutMs, signal);
    const rootPid = readyState.rootPid;
    let rootIdentity = null;
    const identityDeadline = Date.now() + identityTimeoutMs;
    do {
      throwIfAborted(signal, 'desktop launch aborted during Job root identity discovery');
      const listed = (await listProcesses()).map(normalizeProcessEntry);
      const candidate = listed.find((entry) => entry.pid === rootPid);
      if (candidate && isVerifiableProcessIdentity(candidate)) {
        rootIdentity = candidate;
        break;
      }
      if (Date.now() < identityDeadline) await wait(100, { signal });
    } while (Date.now() < identityDeadline);
    if (!rootIdentity) {
      throw new Error(`launchDesktop could not establish a stable Job root identity for PID ${rootPid}`);
    }

    const processTracker = createDiagnosticRootTracker(rootIdentity);
    const ownershipBoundary = ownershipController.snapshot().ownershipBoundary;
    const ownership = {
      rootPid,
      executable,
      startedAt: rootIdentity.creationTime,
      rootIdentity,
      boundary: ownershipBoundary,
    };
    return {
      process: supervisor,
      rootPid,
      rootIdentity,
      processTracker,
      ownershipController,
      ownershipBoundary,
      debugPort,
      launchArgs,
      ownership,
      stdout,
      stderr,
    };
  } catch (error) {
    let cleanup = null;
    if (controlListener?.server?.listening) controlListener.server.close();
    if (ownershipController) {
      try {
        cleanup = await ownershipController.close();
      } catch (cleanupError) {
        launchCleanupErrors.push(sanitizeSecondaryCleanupText(cleanupError, replacements));
        try {
          cleanup = ownershipController.snapshot();
        } catch (snapshotError) {
          launchCleanupErrors.push(sanitizeSecondaryCleanupText(snapshotError, replacements));
        }
      }
    } else if (supervisor) {
      try {
        controlSocket?.destroy?.();
        await waitForChildExit(supervisor, 15000);
      } catch (reapError) {
        launchCleanupErrors.push(sanitizeSecondaryCleanupText(reapError, replacements));
      }
    } else {
      controlSocket?.destroy?.();
    }
    if (cleanup?.ownershipBoundary) error.ownershipBoundary = cleanup.ownershipBoundary;
    if (cleanup?.remainingVerifiedProcesses) {
      error.remainingVerifiedProcesses = cleanup.remainingVerifiedProcesses;
    }
    if (layout) {
      try {
        await cleanupRuntimeDir(layout);
      } catch (runtimeError) {
        launchCleanupErrors.push(sanitizeSecondaryCleanupText(runtimeError, replacements));
      }
    }
    if (launchCleanupErrors.length) error.launchCleanupErrors = launchCleanupErrors.slice(0, 64);
    throw error;
  }
}

async function launchDesktop(options = {}) {
  const {
    executable,
    appArgs = [],
    projectRoot = process.cwd(),
    debugPort,
    userDataDir,
    env = {},
    spawnImpl = spawn,
    pickPort = findAvailablePort,
    isPortAvailable = portIsAvailable,
    windowsHide = false,
    spawnTimeoutMs = 10000,
    identityTimeoutMs = 10000,
    listProcesses = listSystemProcesses,
    processTrackerFactory = createOwnedProcessTracker,
    cleanupOwnedImpl = cleanupOwned,
    runtimeRoot,
    runtimeDir,
    runtimeOwnership,
    onOwnershipController,
    signal,
    randomBytesImpl = crypto.randomBytes,
  } = options;

  throwIfAborted(signal, 'desktop launch aborted');
  if (!executable) throw new Error('launchDesktop requires an executable');

  const selectedPort = debugPort ?? (await pickPort({ signal }));
  throwIfAborted(signal, 'desktop launch aborted after port selection');
  if (!Number.isInteger(selectedPort) || selectedPort < 1 || selectedPort > 65535) {
    throw new Error(`launchDesktop received an invalid CDP port: ${selectedPort}`);
  }
  if (debugPort != null && !(await isPortAvailable(selectedPort, { signal }))) {
    throwIfAborted(signal, 'desktop launch aborted during port validation');
    throw new Error(`Forced CDP port ${selectedPort} is unavailable; choose an unused port or omit the override`);
  }

  const launchArgs = [
    ...appArgs,
    `--remote-debugging-port=${selectedPort}`,
    ...(userDataDir ? [`--user-data-dir=${userDataDir}`] : []),
  ];
  if (process.platform === 'win32' && spawnImpl === spawn) {
    return launchDesktopWithWindowsJob({
      executable,
      launchArgs,
      projectRoot,
      env,
      windowsHide,
      spawnTimeoutMs,
      identityTimeoutMs,
      listProcesses,
      runtimeRoot,
      runtimeDir,
      runtimeOwnership,
      signal,
      onOwnershipController,
      debugPort: selectedPort,
      randomBytesImpl,
    });
  }
  const child = spawnImpl(executable, launchArgs, {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide,
    detached: false,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1', ...env },
  });
  let rootIdentity = null;
  let processTracker = null;

  try {
    if (!child || typeof child.once !== 'function') {
      throw new Error('launchDesktop did not receive a ChildProcess-like object');
    }
    await new Promise((resolve, reject) => {
      let timer = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        child.removeListener?.('spawn', onSpawn);
        child.removeListener?.('error', onError);
        signal?.removeEventListener?.('abort', onAbort);
      };
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        cleanup();
        reject(abortError(signal, 'desktop launch aborted before spawn completed'));
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`launchDesktop spawn event timed out after ${spawnTimeoutMs}ms`));
      }, spawnTimeoutMs);
    });

    if (!Number.isInteger(child.pid)) {
      throw new Error('launchDesktop could not determine the spawned process PID');
    }

    const identityDeadline = Date.now() + identityTimeoutMs;
    do {
      throwIfAborted(signal, 'desktop launch aborted during process identity discovery');
      const listed = (await listProcesses()).map(normalizeProcessEntry);
      throwIfAborted(signal, 'desktop launch aborted during process identity discovery');
      const candidate = listed.find((entry) => entry.pid === child.pid);
      if (candidate && isVerifiableProcessIdentity(candidate)) {
        rootIdentity = candidate;
        break;
      }
      if (Date.now() < identityDeadline) await wait(100, { signal });
    } while (Date.now() < identityDeadline);
    if (!rootIdentity) {
      throw new Error(`launchDesktop could not establish a stable process identity for PID ${child.pid}`);
    }

    processTracker = processTrackerFactory({ rootIdentity, listProcesses });
    await processTracker.start();
    throwIfAborted(signal, 'desktop launch aborted after ownership tracker start');
    const stdout = [];
    const stderr = [];
    let captureOutput = !signal?.aborted;
    const stopOutputCapture = () => {
      captureOutput = false;
    };
    signal?.addEventListener?.('abort', stopOutputCapture, { once: true });
    child.stdout?.on?.('data', (chunk) => {
      if (captureOutput) stdout.push(String(chunk));
    });
    child.stderr?.on?.('data', (chunk) => {
      if (captureOutput) stderr.push(String(chunk));
    });

    const ownership = {
      rootPid: child.pid,
      executable,
      startedAt: rootIdentity.creationTime,
      rootIdentity,
    };

    return {
      process: child,
      rootPid: child.pid,
      rootIdentity,
      processTracker,
      debugPort: selectedPort,
      launchArgs,
      ownership,
      stdout,
      stderr,
    };
  } catch (error) {
    const launchCleanupErrors = [];
    if (rootIdentity) {
      let trackedProcesses = [rootIdentity];
      if (processTracker) {
        try {
          const stoppedProcesses = await processTracker.stop();
          if (Array.isArray(stoppedProcesses)) trackedProcesses = stoppedProcesses;
        } catch (trackerError) {
          launchCleanupErrors.push(`process tracker stop failed: ${trackerError.message}`);
          try {
            const snapshot = processTracker.snapshot?.();
            if (Array.isArray(snapshot)) trackedProcesses = snapshot;
          } catch (snapshotError) {
            launchCleanupErrors.push(`process tracker snapshot failed: ${snapshotError.message}`);
          }
        }
      }
      try {
        const cleanup = await cleanupOwnedImpl({ rootPid: child.pid, trackedProcesses, listProcesses });
        for (const cleanupError of cleanup?.errors || []) {
          launchCleanupErrors.push(`pid ${cleanupError.pid}: ${cleanupError.error}`);
        }
      } catch (cleanupError) {
        launchCleanupErrors.push(cleanupError.message);
      }
    } else {
      try {
        child?.kill?.();
      } catch (killError) {
        launchCleanupErrors.push(`spawned process fallback kill failed: ${killError.message}`);
      }
    }
    if (runtimeRoot && runtimeDir) {
      try {
        await cleanupRuntimeDir({ runtimeOwnership, runtimeRoot, runtimeDir });
      } catch (runtimeError) {
        launchCleanupErrors.push(`runtime cleanup failed: ${runtimeError.message}`);
      }
    }
    if (launchCleanupErrors.length) {
      error.launchCleanupErrors = launchCleanupErrors;
    }
    throw error;
  }
}

function startupLogCandidates(options = {}) {
  const {
    projectRoot = process.cwd(),
    appDataDir = process.env.APPDATA,
    appName = 'codebuddy-gui',
    userDataDir,
    strictUserDataOnly = false,
  } = options;
  const candidates = [];
  if (userDataDir) {
    candidates.push({ path: path.join(userDataDir, 'electron-startup.log'), source: 'userData' });
  }
  if (strictUserDataOnly) return candidates;
  if (appDataDir && appName) {
    candidates.push({ path: path.join(appDataDir, appName, 'electron-startup.log'), source: 'userData' });
  }
  const projectCandidate = { path: path.join(projectRoot, 'electron-startup.log'), source: 'projectRoot' };
  candidates.push(projectCandidate);
  return candidates.filter(
    (candidate, index, array) =>
      array.findIndex((entry) => path.resolve(entry.path) === path.resolve(candidate.path)) === index,
  );
}

function findStartupLog(options = {}) {
  const candidates = startupLogCandidates(options);
  const existing = candidates
    .filter((candidate) => fs.existsSync(candidate.path))
    .map((candidate) => ({ ...candidate, stats: fs.statSync(candidate.path) }));
  if (!existing.length) {
    return { path: null, source: null, text: '', candidates: candidates.map((candidate) => candidate.path) };
  }
  const selected = existing[0];
  return {
    path: selected.path,
    source: selected.source,
    text: fs.readFileSync(selected.path, 'utf8'),
    modifiedAt: selected.stats.mtime.toISOString(),
    candidates: candidates.map((candidate) => candidate.path),
  };
}

function getJson(url, timeoutOrOptions = 2000, providedOptions = {}) {
  const timeoutMs = typeof timeoutOrOptions === 'number' ? timeoutOrOptions : 2000;
  const options = typeof timeoutOrOptions === 'object' ? timeoutOrOptions : providedOptions;
  const signal = options.signal;
  throwIfAborted(signal, `GET ${url} aborted`);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      callback(value);
    };
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          finish(reject, new Error(`GET ${url} returned ${response.statusCode}`));
          return;
        }
        try {
          finish(resolve, JSON.parse(body));
        } catch (error) {
          finish(reject, new Error(`GET ${url} returned invalid JSON: ${error.message}`));
        }
      });
    });
    const onAbort = () => request.destroy(abortError(signal, `GET ${url} aborted`));
    request.on('timeout', () => request.destroy(new Error(`GET ${url} timed out`)));
    request.on('error', (error) => finish(reject, error));
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function urlMatches(url, expectedUrl) {
  if (!expectedUrl) return !String(url || '').startsWith('devtools://');
  if (typeof expectedUrl === 'function') return Boolean(expectedUrl(url));
  if (expectedUrl instanceof RegExp) {
    expectedUrl.lastIndex = 0;
    return expectedUrl.test(String(url || ''));
  }
  return String(url || '').includes(String(expectedUrl));
}

async function findRendererTarget(options = {}) {
  const {
    port,
    expectedUrl,
    timeoutMs = 30000,
    intervalMs = 250,
    signal,
    listTargets = (_port, options = {}) => getJson(`http://127.0.0.1:${port}/json/list`, { signal: options.signal }),
  } = options;

  throwIfAborted(signal, 'renderer target discovery aborted');
  if (!Number.isInteger(port)) throw new Error('findRendererTarget requires a numeric CDP port');

  const deadline = Date.now() + timeoutMs;
  let lastTargets = [];
  let lastError = null;
  do {
    try {
      throwIfAborted(signal, 'renderer target discovery aborted');
      const listed = await listTargets(port, { signal });
      throwIfAborted(signal, 'renderer target discovery aborted');
      lastTargets = Array.isArray(listed) ? listed : [];
      const target = lastTargets.find(
        (candidate) =>
          candidate?.type === 'page' && candidate.webSocketDebuggerUrl && urlMatches(candidate.url, expectedUrl),
      );
      if (target) return { ...target, debugPort: port };
    } catch (error) {
      lastError = error;
    }
    if (Date.now() < deadline) await wait(intervalMs, { signal });
  } while (Date.now() < deadline);

  const seen = lastTargets
    .filter((target) => target?.type === 'page')
    .map((target) => `${target.title || '<untitled>'}=${target.url || '<no-url>'}`)
    .join(', ');
  const expected = expectedUrl ? ` matching ${String(expectedUrl)}` : '';
  const transport = lastError ? ` Last CDP error: ${lastError.message}.` : '';
  throw new Error(
    `No renderer page target${expected} was found on CDP port ${port}.` +
      ` Seen page targets: ${seen || '<none>'}.${transport}`,
  );
}

async function connectCdp(target, options = {}) {
  const WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
  const connectTimeoutMs = options.connectTimeoutMs || 10000;
  const commandTimeoutMs = options.commandTimeoutMs || 15000;
  const signal = options.signal;
  throwIfAborted(signal, 'CDP connection aborted');
  if (typeof WebSocketImpl !== 'function') {
    throw new Error('connectCdp requires a WebSocket implementation (Node 24+ provides one)');
  }
  if (!target?.webSocketDebuggerUrl) {
    throw new Error('connectCdp requires a target.webSocketDebuggerUrl');
  }

  const socket = new WebSocketImpl(target.webSocketDebuggerUrl);
  let socketClosed = false;
  const closeSocket = () => {
    if (socketClosed) return;
    socketClosed = true;
    try {
      socket.close();
    } catch (_) {}
  };
  await new Promise((resolve, reject) => {
    let timer = null;
    let settled = false;
    function cleanup() {
      if (timer) clearTimeout(timer);
      timer = null;
      socket.removeEventListener?.('open', onOpen);
      socket.removeEventListener?.('error', onError);
      signal?.removeEventListener?.('abort', onAbort);
    }
    function settle(callback, value, close = false) {
      if (settled) return;
      settled = true;
      cleanup();
      if (close) closeSocket();
      callback(value);
    }
    function onOpen() {
      settle(resolve);
    }
    function onError(event) {
      settle(reject, new Error(`CDP WebSocket error: ${event?.message || 'unknown error'}`), true);
    }
    function onAbort() {
      settle(reject, abortError(signal, 'CDP connection aborted'), true);
    }
    timer = setTimeout(
      () => settle(reject, new Error(`CDP WebSocket open timed out after ${connectTimeoutMs}ms`), true),
      connectTimeoutMs,
    );
    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('error', onError, { once: true });
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  const onAbort = () => {
    const error = abortError(signal, 'CDP command aborted');
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    closeSocket();
  };
  signal?.addEventListener?.('abort', onAbort, { once: true });
  socket.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      if (!message.id || !pending.has(message.id)) return;
      const request = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error)
        request.reject(
          new Error(`CDP ${request.method} failed: ${message.error.message || JSON.stringify(message.error)}`),
        );
      else request.resolve(message.result || {});
    } catch (_) {}
  });
  socket.addEventListener('close', () => {
    socketClosed = true;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(`CDP WebSocket closed while waiting for ${request.method}`));
    }
    pending.clear();
  });

  const client = {
    target,
    socket,
    send(method, params = {}) {
      throwIfAborted(signal, `CDP ${method} aborted`);
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method} timed out after ${commandTimeoutMs}ms`));
        }, commandTimeoutMs);
        pending.set(id, { method, resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    async evaluate(expression) {
      throwIfAborted(signal, 'renderer evaluation aborted');
      const result = await client.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      throwIfAborted(signal, 'renderer evaluation aborted');
      if (result.exceptionDetails) {
        const detail =
          result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text ||
          'unknown renderer exception';
        throw new Error(`Renderer evaluation failed: ${detail}`);
      }
      return result.result?.value;
    },
    close() {
      signal?.removeEventListener?.('abort', onAbort);
      closeSocket();
    },
  };

  try {
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

function roleActionInPage(options) {
  const normalize = (value) =>
    String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  const implicitRole = (element) => {
    const explicit = normalize(element.getAttribute('role'));
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'a' && element.hasAttribute('href')) return 'link';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'option') return 'option';
    if (tag === 'input') {
      const type = String(element.type || 'text').toLowerCase();
      if (['button', 'submit', 'reset'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      return 'textbox';
    }
    return '';
  };
  const accessibleName = (element) => {
    const labelledBy = normalize(element.getAttribute('aria-labelledby'));
    const labelledText = labelledBy
      ? labelledBy
          .split(' ')
          .map((id) => document.getElementById(id)?.textContent || '')
          .join(' ')
      : '';
    const labelFor = element.id
      ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent || ''
      : '';
    const wrappedLabel = element.closest('label')?.textContent || '';
    return normalize(
      element.getAttribute('aria-label') ||
        labelledText ||
        labelFor ||
        wrappedLabel ||
        element.getAttribute('alt') ||
        element.getAttribute('title') ||
        element.getAttribute('placeholder') ||
        (['button', 'submit', 'reset'].includes(String(element.type || '').toLowerCase()) ? element.value : '') ||
        element.textContent,
    );
  };
  const visibilityProblem = (element) => {
    for (let current = element; current; current = current.parentElement) {
      if (current.hidden || current.getAttribute('aria-hidden') === 'true') return 'hidden by ancestor';
      if (current.inert || current.hasAttribute('inert')) return 'inert';
      const style = window.getComputedStyle(current);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        style.opacity === '0'
      ) {
        return 'not visibly rendered';
      }
      if (style.pointerEvents === 'none') return 'pointer-events is none';
    }
    const rect = element.getBoundingClientRect();
    const clientRects = element.getClientRects();
    if (!rect || rect.width <= 0 || rect.height <= 0 || !clientRects || clientRects.length === 0) {
      return 'zero-size or no client rect';
    }
    return '';
  };
  const interactionProblem = (element) => {
    const visibility = visibilityProblem(element);
    if (visibility) return visibility;
    if (element.disabled || element.getAttribute('aria-disabled') === 'true') return 'disabled';
    if (
      options.action === 'fill' &&
      (element.readOnly || element.hasAttribute('readonly') || element.getAttribute('aria-readonly') === 'true')
    ) {
      return 'readonly';
    }
    return '';
  };

  const root = options.root ? document.querySelector(options.root) : document;
  if (!root) {
    return { ok: false, diagnostic: `root ${options.root} was not found`, available: [] };
  }
  const candidates = Array.from(root.querySelectorAll('*')).filter((element) => implicitRole(element) === options.role);
  const named = candidates.map((element) => ({ element, name: accessibleName(element) }));
  const wanted = normalize(options.name);
  const matchesName = ({ name }) =>
    options.exact === false ? name.toLocaleLowerCase().includes(wanted.toLocaleLowerCase()) : name === wanted;
  const matching = named.filter(matchesName);
  const match = matching.find(({ element }) => !visibilityProblem(element)) || matching[0];

  if (!match) {
    return {
      ok: false,
      diagnostic: `${options.role} named ${JSON.stringify(wanted)} was not found`,
      available: named.map(({ name }) => name || '<unnamed>').slice(0, 20),
    };
  }

  const { element, name } = match;
  const problem = interactionProblem(element);
  if (problem) {
    return {
      ok: false,
      matched: true,
      diagnostic: `${options.role} named ${JSON.stringify(name)} is not interactable: ${problem}`,
      available: named.map(({ name: candidateName }) => candidateName || '<unnamed>').slice(0, 20),
    };
  }

  element.scrollIntoView?.({ block: 'center', inline: 'center' });
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  if (options.action === 'click' && typeof document.elementFromPoint === 'function') {
    const hit = document.elementFromPoint(x, y);
    if (!hit || (hit !== element && !element.contains(hit))) {
      return {
        ok: false,
        matched: true,
        diagnostic: `${options.role} named ${JSON.stringify(name)} is not interactable: center is covered`,
        available: named.map(({ name: candidateName }) => candidateName || '<unnamed>').slice(0, 20),
      };
    }
  }

  document.querySelectorAll('[data-codebuddy-e2e-target]').forEach((candidate) => {
    candidate.removeAttribute('data-codebuddy-e2e-target');
    candidate.removeAttribute('data-codebuddy-e2e-click-token');
    candidate.removeAttribute('data-codebuddy-e2e-click-ack');
  });
  const targetId = String(options.targetId || 'target');
  element.setAttribute('data-codebuddy-e2e-target', targetId);

  if (options.action === 'click') {
    const clickAckToken = String(options.clickAckToken || '');
    if (!clickAckToken) {
      return { ok: false, diagnostic: 'click preparation requires an acknowledgment token', available: [] };
    }
    element.setAttribute('data-codebuddy-e2e-click-token', clickAckToken);
    element.removeAttribute('data-codebuddy-e2e-click-ack');
    document.documentElement?.removeAttribute('data-codebuddy-e2e-click-ack');
    element.addEventListener(
      'click',
      (event) => {
        if (!event.isTrusted || element.getAttribute('data-codebuddy-e2e-click-token') !== clickAckToken) return;
        element.setAttribute('data-codebuddy-e2e-click-ack', clickAckToken);
        document.documentElement?.setAttribute('data-codebuddy-e2e-click-ack', clickAckToken);
      },
      { capture: true, once: true },
    );
  }

  if (options.action === 'invoke') {
    element.click();
  } else if (options.action === 'fill') {
    element.focus();
    const prototype =
      element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (!setter) return { ok: false, diagnostic: `${options.role} does not support fill`, available: [] };
    setter.call(element, String(options.value ?? ''));
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (options.action === 'press') {
    const key = String(options.key || 'Enter');
    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        ctrlKey: Boolean(options.ctrlKey),
        metaKey: Boolean(options.metaKey),
        shiftKey: Boolean(options.shiftKey),
        altKey: Boolean(options.altKey),
      }),
    );
    element.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
  }

  return {
    ok: true,
    role: options.role,
    name,
    action: options.action || 'assert',
    tag: element.tagName.toLowerCase(),
    disabled: Boolean(element.disabled),
    targetId,
    x,
    y,
    width: rect.width,
    height: rect.height,
    value: 'value' in element ? element.value : undefined,
  };
}

function clickAcknowledgmentInPage(options) {
  const target = Array.from(document.querySelectorAll('[data-codebuddy-e2e-target]')).find(
    (candidate) => candidate.getAttribute('data-codebuddy-e2e-target') === String(options.targetId),
  );
  const clickAckToken = String(options.clickAckToken || '');
  const acknowledged =
    target?.getAttribute('data-codebuddy-e2e-click-ack') === clickAckToken ||
    document.documentElement?.getAttribute('data-codebuddy-e2e-click-ack') === clickAckToken;
  return {
    clickAcknowledged: acknowledged,
    trustedClick: acknowledged,
    targetPresent: Boolean(target),
  };
}

async function driveByRole(client, options = {}) {
  if (!client || typeof client.evaluate !== 'function') {
    throw new Error('driveByRole requires a CDP client with evaluate(expression)');
  }
  const {
    role,
    name,
    timeoutMs = 5000,
    intervalMs = 100,
    clickAckTimeoutMs = 1000,
    clickAckIntervalMs = 25,
    signal,
  } = options;
  throwIfAborted(signal, 'role action aborted');
  if (!role || typeof name !== 'string') {
    throw new Error('driveByRole requires both role and string name');
  }

  const deadline = Date.now() + timeoutMs;
  let lastResult = null;
  const targetId = crypto.randomUUID();
  const clickAckToken = crypto.randomUUID();
  do {
    throwIfAborted(signal, 'role action aborted');
    const expression = `(${roleActionInPage.toString()})(${JSON.stringify({
      exact: true,
      action: 'assert',
      ...options,
      targetId,
      clickAckToken,
      timeoutMs: undefined,
      intervalMs: undefined,
      clickAckTimeoutMs: undefined,
      clickAckIntervalMs: undefined,
      signal: undefined,
    })})`;
    lastResult = await client.evaluate(expression);
    throwIfAborted(signal, 'role action aborted');
    if (lastResult?.ok) {
      if (options.action === 'click') {
        if (typeof client.send !== 'function') {
          throw new Error('driveByRole click requires a CDP client with send(method, params)');
        }
        const common = { x: lastResult.x, y: lastResult.y, button: 'left', clickCount: 1 };
        await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: common.x, y: common.y });
        throwIfAborted(signal, 'native click aborted');
        await client.send('Input.dispatchMouseEvent', { ...common, type: 'mousePressed' });
        throwIfAborted(signal, 'native click aborted');
        await client.send('Input.dispatchMouseEvent', { ...common, type: 'mouseReleased' });
        throwIfAborted(signal, 'native click aborted');
        const acknowledgementDeadline = Date.now() + clickAckTimeoutMs;
        let lastAcknowledgement = null;
        do {
          throwIfAborted(signal, 'trusted click acknowledgment aborted');
          const acknowledgement = await client.evaluate(
            `(${clickAcknowledgmentInPage.toString()})(${JSON.stringify({ targetId, clickAckToken })})`,
          );
          lastAcknowledgement = acknowledgement;
          throwIfAborted(signal, 'trusted click acknowledgment aborted');
          if (acknowledgement?.clickAcknowledged === true && acknowledgement?.trustedClick === true) {
            return {
              ...lastResult,
              dispatched: true,
              dispatch: 'cdp-native',
              clickAcknowledged: true,
              trustedClick: true,
            };
          }
          if (Date.now() < acknowledgementDeadline) await wait(clickAckIntervalMs, { signal });
        } while (Date.now() < acknowledgementDeadline);
        throw new Error(
          `Native CDP click on ${role} ${JSON.stringify(name)} did not receive a trusted click acknowledgment; ` +
            `target=${JSON.stringify(lastResult)} acknowledgement=${JSON.stringify(lastAcknowledgement)}`,
        );
      }
      return lastResult;
    }
    if (Date.now() < deadline) await wait(intervalMs, { signal });
  } while (Date.now() < deadline);

  const available =
    Array.isArray(lastResult?.available) && lastResult.available.length
      ? ` Available visible ${role} names: ${lastResult.available.map((value) => JSON.stringify(value)).join(', ')}.`
      : ` No visible ${role} controls were reported.`;
  throw new Error(
    `Visible ${role} control named ${JSON.stringify(name)} was not found within ${timeoutMs}ms.` +
      `${available}${lastResult?.diagnostic ? ` ${lastResult.diagnostic}.` : ''}`,
  );
}

function visibleSettingValueInPage(label) {
  const normalize = (value) =>
    String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  const isVisible = (element) => {
    for (let current = element; current; current = current.parentElement) {
      if (current.hidden || current.getAttribute('aria-hidden') === 'true') return false;
      const style = window.getComputedStyle(current);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        style.opacity === '0'
      ) {
        return false;
      }
    }
    return true;
  };
  const wanted = normalize(label);
  const row = Array.from(document.querySelectorAll('.settings-row')).find(
    (candidate) =>
      isVisible(candidate) && normalize(candidate.querySelector('.settings-label')?.textContent) === wanted,
  );
  return row ? normalize(row.querySelector('.settings-control')?.textContent) : '';
}

async function waitForVisibleSettingValue(client, label, options = {}) {
  if (!client || typeof client.evaluate !== 'function') {
    throw new Error('waitForVisibleSettingValue requires a CDP client with evaluate(expression)');
  }
  if (typeof label !== 'string' || !label.trim()) {
    throw new Error('waitForVisibleSettingValue requires a non-empty string label');
  }
  const {
    timeoutMs = 30000,
    intervalMs = 100,
    accept = (value) => Boolean(value),
    signal,
  } = options;
  throwIfAborted(signal, 'visible setting wait aborted');
  const deadline = Date.now() + timeoutMs;
  let lastValue = '';
  do {
    throwIfAborted(signal, 'visible setting wait aborted');
    lastValue = await client.evaluate(
      `(${visibleSettingValueInPage.toString()})(${JSON.stringify(label)})`,
    );
    throwIfAborted(signal, 'visible setting wait aborted');
    if (accept(lastValue)) return lastValue;
    if (Date.now() < deadline) await wait(intervalMs, { signal });
  } while (Date.now() < deadline);
  throw new Error(
    `Visible setting ${JSON.stringify(label)} did not provide an accepted value within ${timeoutMs}ms; ` +
      `last value: ${JSON.stringify(lastValue)}`,
  );
}

async function waitForRendererValue(client, expression, options = {}) {
  const {
    timeoutMs = 15000,
    intervalMs = 100,
    describe = 'renderer condition',
    accept = (value) => Boolean(value),
    signal,
  } = options;
  throwIfAborted(signal, `${describe} aborted`);
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  do {
    throwIfAborted(signal, `${describe} aborted`);
    lastValue = await client.evaluate(expression);
    throwIfAborted(signal, `${describe} aborted`);
    if (accept(lastValue)) return lastValue;
    if (Date.now() < deadline) await wait(intervalMs, { signal });
  } while (Date.now() < deadline);
  throw new Error(`${describe} was not satisfied within ${timeoutMs}ms; last value: ${JSON.stringify(lastValue)}`);
}

async function driveRoutes(client, options = {}) {
  const { routes = ROUTE_EXPECTATIONS, screenshotDir, routeTimeoutMs = 15000, expectedControl, onRoute, signal } = options;
  throwIfAborted(signal, 'route drive aborted');
  const results = [];

  for (const route of routes) {
    throwIfAborted(signal, `route ${route.route} aborted`);
    const currentRoute = await client.evaluate(`(() => ({ hash: window.location.hash }))()`);
    const routeAlreadyActive = currentRoute?.hash === `#/${route.route}`
      || (route.route === 'chat' && !currentRoute?.hash);
    if (!routeAlreadyActive && route.navGroup) {
      const groupExpanded = await client.evaluate(`(() => document.querySelector('aside[role="navigation"] button[aria-label$="${route.navGroup}"]')?.getAttribute('aria-expanded') === 'true')()`);
      if (!groupExpanded) {
        await driveByRole(client, {
          role: 'button',
          name: `展开${route.navGroup}`,
          action: 'invoke',
          root: 'aside[role="navigation"]',
          timeoutMs: routeTimeoutMs,
          signal,
        });
      }
    }
    let navigation;
    if (routeAlreadyActive) {
      navigation = { ok: true, role: 'button', name: route.navLabel, action: 'already-active' };
    } else if (route.route === 'chat') {
      // Primary nav intentionally omits "对话"; open chat via hash.
      await client.evaluate(`location.hash = '#/chat'`);
      navigation = { ok: true, role: 'location', name: 'chat', action: 'hash' };
    } else {
      navigation = await driveByRole(client, {
        role: 'button',
        name: route.navLabel,
        action: 'invoke',
        root: 'aside[role="navigation"]',
        timeoutMs: routeTimeoutMs,
        signal,
      });
    }
    const state = await waitForRendererValue(
      client,
      `(() => ({
      hash: window.location.hash,
      status: document.querySelector('[role="banner"]')?.textContent?.replace(/\\s+/g, ' ').trim() || ''
    }))()`,
      {
        timeoutMs: routeTimeoutMs,
        describe: `route ${route.route} state after clicking ${route.navLabel}`,
        accept: (value) => {
          const hashMatches = value?.hash === `#/${route.route}` || (route.route === 'chat' && !value?.hash);
          // Banner shows route title; chat is already active without a nav click and still
          // carries "对话" in ROUTE_TITLES, so include either label match or chat default.
          if (!hashMatches) return false;
          if (route.route === 'chat') return true;
          return value.status.includes(route.navLabel);
        },
        signal,
      },
    );
    const control = await driveByRole(client, {
      ...route.expected,
      action: 'assert',
      timeoutMs: routeTimeoutMs,
      signal,
    });
    const screenshot = screenshotDir
      ? await captureScreenshot(client, path.join(screenshotDir, `${route.route}.png`), { signal })
      : null;
    throwIfAborted(signal, `route ${route.route} result mutation aborted`);
    const result = { ...route, navigation, state, control, screenshot };
    results.push(result);
    if (onRoute) await onRoute(result);
  }

  if (expectedControl?.role && expectedControl?.name) {
    await driveByRole(client, {
      role: expectedControl.role,
      name: expectedControl.name,
      action: 'assert',
      timeoutMs: expectedControl.timeoutMs || 2000,
      signal,
    });
  }

  return results;
}

function applyScreenshotPrivacyMaskInPage(input = {}) {
  const token = String(input.token || '');
  const sensitiveValues = Array.isArray(input.sensitiveValues)
    ? input.sensitiveValues.map((value) => String(value || '')).filter(Boolean).sort((a, b) => b.length - a.length)
    : [];
  const registryKey = '__codeBuddyScreenshotPrivacyMasks';
  const registry = window[registryKey] || (window[registryKey] = Object.create(null));
  const mutations = [];
  let redactedNodes = 0;
  let redactedAttributes = 0;
  let redactedRanges = 0;

  const replaceSensitive = (value) => {
    let output = String(value ?? '');
    let replacements = 0;
    for (const sensitive of sensitiveValues) {
      const escaped = sensitive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      output = output.replace(new RegExp(escaped, 'gi'), () => {
        replacements += 1;
        return '[redacted]';
      });
    }
    for (const pattern of [
      /[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,
      /\b[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}\b/gi,
      /\b[A-Za-z]:\\(?:[^\\\s"'<>|]+\\)*[^\\\s"'<>|]*/g,
    ]) {
      output = output.replace(pattern, () => {
        replacements += 1;
        return '[redacted]';
      });
    }
    redactedRanges += replacements;
    return output;
  };

  for (const element of document.querySelectorAll(
    '[data-session-history], .sidebar-user-section, .log-output',
  )) {
    for (const attribute of [...element.attributes]) {
      if (['class', 'role', 'aria-label', 'data-session-history'].includes(attribute.name)) continue;
      mutations.push({ kind: 'attribute', node: element, name: attribute.name, value: attribute.value });
      element.setAttribute(attribute.name, '[redacted]');
      redactedAttributes += 1;
      redactedRanges += 1;
    }
    mutations.push({ kind: 'html', node: element, value: element.innerHTML });
    element.textContent = '[redacted]';
    redactedNodes += 1;
    redactedRanges += 1;
  }

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const masked = replaceSensitive(node.nodeValue);
    if (masked !== node.nodeValue) {
      mutations.push({ kind: 'text', node, value: node.nodeValue });
      node.nodeValue = masked;
      redactedNodes += 1;
    }
  }

  for (const element of document.body.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      const masked = replaceSensitive(attribute.value);
      if (masked !== attribute.value) {
        mutations.push({ kind: 'attribute', node: element, name: attribute.name, value: attribute.value });
        element.setAttribute(attribute.name, masked);
        redactedAttributes += 1;
      }
    }
    for (const property of ['value', 'placeholder', 'title']) {
      if (!(property in element) || typeof element[property] !== 'string') continue;
      const masked = replaceSensitive(element[property]);
      if (masked !== element[property]) {
        mutations.push({ kind: 'property', node: element, name: property, value: element[property] });
        element[property] = masked;
        redactedAttributes += 1;
      }
    }
  }

  const remainingText = [
    document.body.innerHTML,
    ...[...document.querySelectorAll('input, textarea, select, option')].flatMap((element) => [
      element.value,
      element.placeholder,
      element.title,
    ]),
  ].join('\n');
  let remaining = sensitiveValues.filter((value) => remainingText.toLowerCase().includes(value.toLowerCase())).length;
  remaining += (remainingText.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) || []).length;
  remaining += (remainingText.match(/\b[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}\b/gi) || []).length;
  registry[token] = mutations;
  return { privacyVerified: remaining === 0, redactedNodes, redactedAttributes, redactedRanges, remaining };
}

function restoreScreenshotPrivacyMaskInPage(token) {
  const registry = window.__codeBuddyScreenshotPrivacyMasks;
  const mutations = registry?.[token] || [];
  for (let index = mutations.length - 1; index >= 0; index -= 1) {
    const mutation = mutations[index];
    if (mutation.kind === 'html') mutation.node.innerHTML = mutation.value;
    else if (mutation.kind === 'text') mutation.node.nodeValue = mutation.value;
    else if (mutation.kind === 'attribute') mutation.node.setAttribute(mutation.name, mutation.value);
    else if (mutation.kind === 'property') mutation.node[mutation.name] = mutation.value;
  }
  if (registry) delete registry[token];
  return true;
}

async function captureScreenshot(client, outputPath, options = {}) {
  if (!client || typeof client.send !== 'function') {
    throw new Error('captureScreenshot requires a CDP client with send(method, params)');
  }
  if (!outputPath) throw new Error('captureScreenshot requires an output path');
  const signal = options.signal;
  throwIfAborted(signal, 'screenshot capture aborted');
  const privacyOptions = options.privacy;
  const privacyToken = privacyOptions
    ? `mask-${crypto.randomBytes(16).toString('hex')}`
    : null;
  let privacy = null;
  if (privacyToken) {
    if (typeof client.evaluate !== 'function') {
      throw new Error('privacy-preserving screenshot capture requires client.evaluate(expression)');
    }
    privacy = await client.evaluate(
      `(${applyScreenshotPrivacyMaskInPage.toString()})(${JSON.stringify({
        token: privacyToken,
        sensitiveValues: privacyOptions.sensitiveValues || [],
      })})`,
    );
    if (!privacy?.privacyVerified) {
      await client.evaluate(`(${restoreScreenshotPrivacyMaskInPage.toString()})(${JSON.stringify(privacyToken)})`);
      throw new Error(`screenshot privacy verification failed with ${privacy?.remaining ?? 'unknown'} remaining values`);
    }
  }

  let response;
  try {
    response = await client.send('Page.captureScreenshot', {
      format: options.format || 'png',
      fromSurface: options.fromSurface !== false,
      captureBeyondViewport: options.captureBeyondViewport !== false,
      ...(options.quality == null ? {} : { quality: options.quality }),
    });
  } finally {
    if (privacyToken) {
      await client.evaluate(`(${restoreScreenshotPrivacyMaskInPage.toString()})(${JSON.stringify(privacyToken)})`);
    }
  }
  throwIfAborted(signal, 'screenshot capture aborted');
  if (!response?.data) throw new Error('CDP Page.captureScreenshot returned no image data');

  const bytes = Buffer.from(response.data, 'base64');
  throwIfAborted(signal, 'screenshot write aborted');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, bytes);
  return {
    path: outputPath,
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    ...(privacy ? { privacy } : {}),
  };
}

function execFileAsync(file, args, options = {}) {
  const { execFileImpl = execFile, ...providedOptions } = options;
  const boundedOptions = {
    encoding: 'utf8',
    timeout: 15000,
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    ...providedOptions,
  };
  return new Promise((resolve, reject) => {
    execFileImpl(file, args, boundedOptions, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function normalizeProcessEntry(entry = {}) {
  const creationValue = entry.creationTime ?? entry.CreationDate ?? entry.startedAt ?? '';
  let creationTime = '';
  if (creationValue instanceof Date) creationTime = creationValue.toISOString();
  else if (creationValue) {
    const parsed = new Date(creationValue);
    creationTime = Number.isNaN(parsed.getTime()) ? String(creationValue) : parsed.toISOString();
  }
  return {
    ...entry,
    pid: Number(entry.pid ?? entry.ProcessId),
    parentPid: Number(entry.parentPid ?? entry.ParentProcessId),
    name: String(entry.name ?? entry.Name ?? ''),
    executablePath: String(entry.executablePath ?? entry.ExecutablePath ?? ''),
    commandLine: String(entry.commandLine ?? entry.CommandLine ?? ''),
    creationTime,
  };
}

function comparablePath(value) {
  const normalized = String(value || '').replace(/\//g, '\\').trim();
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function comparableCommandLine(value) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isVerifiableProcessIdentity(entry) {
  const normalized = normalizeProcessEntry(entry);
  return (
    Number.isInteger(normalized.pid) &&
    normalized.pid > 0 &&
    Boolean(normalized.creationTime) &&
    Boolean(normalized.name) &&
    Boolean(normalized.executablePath || normalized.commandLine)
  );
}

function sameProcessIdentity(expectedEntry, actualEntry) {
  const expected = normalizeProcessEntry(expectedEntry);
  const actual = normalizeProcessEntry(actualEntry);
  if (!isVerifiableProcessIdentity(expected) || !isVerifiableProcessIdentity(actual)) return false;
  if (expected.pid !== actual.pid || expected.creationTime !== actual.creationTime) return false;
  if (expected.name.toLowerCase() !== actual.name.toLowerCase()) return false;
  if (
    expected.executablePath &&
    comparablePath(expected.executablePath) !== comparablePath(actual.executablePath)
  ) {
    return false;
  }
  if (
    expected.commandLine &&
    comparableCommandLine(expected.commandLine) !== comparableCommandLine(actual.commandLine)
  ) {
    return false;
  }
  return true;
}

function createOwnedProcessTracker(options = {}) {
  const {
    rootIdentity,
    listProcesses = listSystemProcesses,
    intervalMs = 1000,
    maxTracked = 256,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  } = options;
  const normalizedRoot = normalizeProcessEntry(rootIdentity);
  if (!isVerifiableProcessIdentity(normalizedRoot)) {
    throw new Error('createOwnedProcessTracker requires a verifiable root process identity');
  }

  const tracked = new Map([[normalizedRoot.pid, normalizedRoot]]);
  const warnings = [];
  let timer = null;
  let started = false;
  let stopped = false;
  let sampleRunning = false;
  let inflight = Promise.resolve();
  let stopPromise = null;

  const snapshot = () => [...tracked.values()].map((entry) => ({ ...entry }));
  const sample = async () => {
    const listed = (await listProcesses()).map(normalizeProcessEntry);
    const byPid = new Map(listed.map((entry) => [entry.pid, entry]));
    const verifiedParents = [];
    for (const identity of tracked.values()) {
      const current = byPid.get(identity.pid);
      if (current && sameProcessIdentity(identity, current)) verifiedParents.push(identity.pid);
    }

    const queue = [...verifiedParents];
    const seen = new Set();
    while (queue.length) {
      const parentPid = queue.shift();
      if (seen.has(parentPid)) continue;
      seen.add(parentPid);
      for (const candidate of listed) {
        if (candidate.parentPid !== parentPid) continue;
        const existing = tracked.get(candidate.pid);
        if (existing && !sameProcessIdentity(existing, candidate)) continue;
        if (!existing) {
          if (!isVerifiableProcessIdentity(candidate)) continue;
          if (tracked.size >= maxTracked) {
            warnings.push(`ownership tracker limit ${maxTracked} reached; ignored pid ${candidate.pid}`);
            continue;
          }
          tracked.set(candidate.pid, candidate);
        }
        queue.push(candidate.pid);
      }
    }
    return snapshot();
  };
  const enqueueSample = () => {
    if (stopped || sampleRunning) return inflight;
    sampleRunning = true;
    inflight = sample()
      .catch((error) => {
        warnings.push(`ownership tracker sample failed: ${error.message}`);
        return snapshot();
      })
      .finally(() => {
        sampleRunning = false;
      });
    return inflight;
  };

  return {
    warnings,
    snapshot,
    async start() {
      if (started) return snapshot();
      started = true;
      await enqueueSample();
      if (!stopped) {
        timer = setIntervalImpl(() => {
          void enqueueSample();
        }, intervalMs);
        timer?.unref?.();
      }
      return snapshot();
    },
    async stop() {
      if (!stopPromise) {
        stopPromise = (async () => {
          stopped = true;
          if (timer) clearIntervalImpl(timer);
          timer = null;
          await inflight;
          try {
            await sample();
          } catch (error) {
            warnings.push(`ownership tracker final sample failed: ${error.message}`);
          }
          return snapshot();
        })();
      }
      return stopPromise;
    },
  };
}

async function listSystemProcesses(options = {}) {
  const platform = options.platform || process.platform;
  const execFileImpl = options.execFileImpl;
  const waitImpl = options.waitImpl || wait;
  const processListRetries = Number.isInteger(options.processListRetries)
    ? Math.max(0, options.processListRetries)
    : 4;
  const processListRetryDelayMs = Number.isInteger(options.processListRetryDelayMs)
    ? Math.max(1, options.processListRetryDelayMs)
    : 150;
  if (platform === 'win32') {
    const script =
      "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process" +
      " | Select-Object @{n='pid';e={[int]$_.ProcessId}},@{n='parentPid';e={[int]$_.ParentProcessId}},@{n='name';e={$_.Name}},@{n='executablePath';e={$_.ExecutablePath}},@{n='commandLine';e={$_.CommandLine}},@{n='creationTime';e={if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString('o')} else {''}}}" +
      ' | ConvertTo-Json -Compress';
    for (let attempt = 0; ; attempt += 1) {
      try {
        const { stdout } = await execFileAsync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', script],
          {
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
            windowsHide: true,
            ...(execFileImpl ? { execFileImpl } : {}),
          },
        );
        const parsed = stdout.trim() ? JSON.parse(stdout) : [];
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch (error) {
        if (attempt >= processListRetries) throw error;
        await waitImpl(processListRetryDelayMs);
      }
    }
  }

  const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,lstart=,comm=,args='], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...(execFileImpl ? { execFileImpl } : {}),
  });
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const match = line
        .trim()
        .match(/^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(\S+)\s*(.*)$/);
      return match
        ? {
            pid: Number(match[1]),
            parentPid: Number(match[2]),
            creationTime: new Date(match[3]).toISOString(),
            name: path.basename(match[4]),
            executablePath: match[4],
            commandLine: match[5],
          }
        : null;
    })
    .filter(Boolean);
}

async function inspectProcesses(options = {}) {
  const { rootPid, listProcesses = listSystemProcesses, signal } = options;
  throwIfAborted(signal, 'process inspection aborted');
  if (!Number.isInteger(rootPid) || rootPid < 1) {
    throw new Error(`inspectProcesses requires a positive rootPid, received ${rootPid}`);
  }

  const listed = await listProcesses();
  throwIfAborted(signal, 'process inspection aborted');
  const processes = (Array.isArray(listed) ? listed : [])
    .map(normalizeProcessEntry)
    .filter((entry) => Number.isInteger(entry.pid) && Number.isInteger(entry.parentPid));
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const children = new Map();
  for (const entry of processes) {
    if (!children.has(entry.parentPid)) children.set(entry.parentPid, []);
    children.get(entry.parentPid).push(entry.pid);
  }

  const queue = [rootPid];
  const seen = new Set();
  const ownedPids = [];
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (byPid.has(pid)) ownedPids.push(pid);
    for (const childPid of children.get(pid) || []) queue.push(childPid);
  }

  return {
    rootPid,
    rootPresent: byPid.has(rootPid),
    ownedPids,
    processes: ownedPids.map((pid) => byPid.get(pid)),
  };
}

const WINDOWS_TERMINATE_VERIFIED_SCRIPT = String.raw`
param(
  [int]$pidValue,
  [long]$expectedStartMs,
  [string]$expectedNameHash,
  [string]$expectedExecutableHash,
  [string]$expectedCommandHash
)
$ErrorActionPreference = 'Stop'
function Write-Result([string]$Status, [string]$Field = '') {
  @{ status = $Status; field = $Field } | ConvertTo-Json -Compress
}
function Get-Hash([string]$Value) {
  if ($null -eq $Value) { $Value = '' }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}
function Normalize-Path([string]$Value) {
  if ($null -eq $Value) { return '' }
  return $Value.Replace('/', '\').Trim().ToLowerInvariant()
}
function Normalize-CommandLine([string]$Value) {
  if ($null -eq $Value) { return '' }
  return (($Value -replace '\s+', ' ').Trim().ToLowerInvariant())
}

try {
  $process = [System.Diagnostics.Process]::GetProcessById($pidValue)
  $null = $process.Handle
} catch [System.ArgumentException] {
  Write-Result 'not-found'
  return
}

try {
  if ($process.HasExited) {
    Write-Result 'not-found'
    return
  }
  $heldStartMs = ([System.DateTimeOffset]$process.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
  $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue"
  if ($null -eq $cim) {
    Write-Result 'not-found'
    return
  }
  $cimStartMs = ([System.DateTimeOffset]$cim.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()
  if ($heldStartMs -ne $cimStartMs) {
    Write-Result 'unsafe-identity-swap' 'creationTime'
    return
  }
  if ($heldStartMs -ne $expectedStartMs) {
    Write-Result 'identity-mismatch' 'creationTime'
    return
  }
  if ((Get-Hash ([string]$cim.Name).ToLowerInvariant()) -ne $expectedNameHash) {
    Write-Result 'identity-mismatch' 'name'
    return
  }
  if ($expectedExecutableHash) {
    if (-not $cim.ExecutablePath) {
      Write-Result 'unverifiable' 'executablePath'
      return
    }
    if ((Get-Hash (Normalize-Path ([string]$cim.ExecutablePath))) -ne $expectedExecutableHash) {
      Write-Result 'identity-mismatch' 'executablePath'
      return
    }
  }
  if ($expectedCommandHash) {
    if (-not $cim.CommandLine) {
      Write-Result 'unverifiable' 'commandLine'
      return
    }
    if ((Get-Hash (Normalize-CommandLine ([string]$cim.CommandLine))) -ne $expectedCommandHash) {
      Write-Result 'identity-mismatch' 'commandLine'
      return
    }
  }
  if ($process.HasExited) {
    Write-Result 'not-found'
    return
  }
  $process.Kill()
  Write-Result 'terminated'
} catch {
  Write-Result 'error' $_.Exception.Message
}
`;

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function normalizeWindowsPath(value) {
  return String(value || '').replace(/\//g, '\\').trim().toLowerCase();
}

function normalizeWindowsCommandLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function buildWindowsTerminateCommand(binding) {
  const { pid, expectedStartMs, expectedNameHash, expectedExecutableHash, expectedCommandHash } = binding;
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) {
    throw new Error('Windows termination PID must be a positive 32-bit integer');
  }
  if (!Number.isSafeInteger(expectedStartMs) || expectedStartMs <= 0) {
    throw new Error('Windows termination start time must be a positive integer');
  }
  const requireHash = (value, label, optional = false) => {
    if (optional && value === '') return value;
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
      throw new Error(`Windows termination ${label} must be a lowercase SHA-256 hex digest`);
    }
    return value;
  };
  const nameHash = requireHash(expectedNameHash, 'name hash');
  const executableHash = requireHash(expectedExecutableHash, 'executable hash', true);
  const commandHash = requireHash(expectedCommandHash, 'command hash', true);
  return (
    `& {\n${WINDOWS_TERMINATE_VERIFIED_SCRIPT}\n} ` +
    `${pid} ${expectedStartMs} '${nameHash}' '${executableHash}' '${commandHash}'`
  );
}

async function terminateVerifiedProcess(identity, options = {}) {
  const normalized = normalizeProcessEntry(identity);
  const {
    platform = process.platform,
    execFileImpl = execFile,
    listProcesses = listSystemProcesses,
    killImpl = process.kill.bind(process),
  } = options;
  if (!isVerifiableProcessIdentity(normalized)) {
    return { pid: normalized.pid, status: 'unverifiable', field: 'identity' };
  }

  if (platform === 'win32') {
    const expectedStartMs = new Date(normalized.creationTime).getTime();
    const command = buildWindowsTerminateCommand({
      pid: normalized.pid,
      expectedStartMs,
      expectedNameHash: sha256Text(normalized.name.toLowerCase()),
      expectedExecutableHash: normalized.executablePath
        ? sha256Text(normalizeWindowsPath(normalized.executablePath))
        : '',
      expectedCommandHash: normalized.commandLine
        ? sha256Text(normalizeWindowsCommandLine(normalized.commandLine))
        : '',
    });
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command,
    ];
    const { stdout } = await execFileAsync('powershell.exe', args, {
      execFileImpl,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const line = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1);
    const parsed = line ? JSON.parse(line) : { status: 'error', field: 'missing-result' };
    return { pid: normalized.pid, status: parsed.status, field: parsed.field || '' };
  }

  const current = (await listProcesses()).map(normalizeProcessEntry).find((entry) => entry.pid === normalized.pid);
  if (!current) return { pid: normalized.pid, status: 'not-found' };
  if (!sameProcessIdentity(normalized, current)) {
    return { pid: normalized.pid, status: 'identity-mismatch' };
  }
  killImpl(normalized.pid, 'SIGKILL');
  return { pid: normalized.pid, status: 'terminated' };
}

async function cleanupOwned(options = {}) {
  const {
    rootPid,
    trackedProcesses = [],
    listProcesses = listSystemProcesses,
    terminateProcess = terminateVerifiedProcess,
    settleMs = 300,
  } = options;
  const inspected = await inspectProcesses({ rootPid, listProcesses });
  const suppliedTracked = (Array.isArray(trackedProcesses) ? trackedProcesses : [])
    .map(normalizeProcessEntry)
    .filter((entry) => Number.isInteger(entry.pid));
  const warnings = [];
  const errors = [];
  const errorKeys = new Set();
  const addError = (pid, error) => {
    const key = `${pid}:${error}`;
    if (errorKeys.has(key)) return;
    errorKeys.add(key);
    errors.push({ pid, error });
  };
  const trustedByPid = new Map();
  for (const identity of suppliedTracked) {
    if (!trustedByPid.has(identity.pid)) trustedByPid.set(identity.pid, identity);
  }
  const currentByPid = new Map(inspected.processes.map((entry) => [entry.pid, entry]));
  const trackedRoot = trustedByPid.get(rootPid);
  const currentRoot = currentByPid.get(rootPid);
  if (currentRoot) {
    if (!trackedRoot || !isVerifiableProcessIdentity(trackedRoot)) {
      addError(rootPid, 'unverifiable ownership: current root identity was not previously tracked');
    } else if (!sameProcessIdentity(trackedRoot, currentRoot)) {
      addError(rootPid, 'ownership mismatch: root PID now belongs to a different process identity');
    } else {
      for (const candidate of inspected.processes) {
        if (trustedByPid.has(candidate.pid)) continue;
        let current = candidate;
        const seen = new Set();
        let safe = true;
        while (current.pid !== rootPid) {
          if (seen.has(current.pid)) {
            safe = false;
            break;
          }
          seen.add(current.pid);
          if (!isVerifiableProcessIdentity(current)) {
            addError(candidate.pid, 'unverifiable late descendant: process identity is incomplete');
            safe = false;
            break;
          }
          current = currentByPid.get(current.parentPid);
          if (!current) {
            safe = false;
            break;
          }
        }
        if (!safe || current.pid !== rootPid) {
          if (!errors.some((entry) => entry.pid === candidate.pid)) {
            addError(candidate.pid, 'unverifiable late descendant: ancestry to tracked root is incomplete');
          }
          continue;
        }
        trustedByPid.set(candidate.pid, candidate);
      }
    }
  }
  const trusted = [...trustedByPid.values()];
  const initialOwnedPids = trusted.map((entry) => entry.pid);
  const attemptedPids = [];

  if (!trusted.length && !inspected.rootPresent) {
    addError(rootPid, 'unverifiable ownership: root missing and no tracked process identity is available');
    return {
      ...inspected,
      ownedPids: [],
      processes: [],
      initialOwnedPids,
      attemptedPids,
      warnings,
      remainingPids: [],
      errors,
    };
  }

  const depthFor = (identity) => {
    let depth = 0;
    let current = identity;
    const seen = new Set();
    while (trustedByPid.has(current.parentPid) && !seen.has(current.parentPid)) {
      seen.add(current.parentPid);
      current = trustedByPid.get(current.parentPid);
      depth += 1;
    }
    return depth;
  };
  const killOrder = [...trusted].sort((a, b) => depthFor(b) - depthFor(a) || b.pid - a.pid);

  for (const identity of killOrder) {
    if (!isVerifiableProcessIdentity(identity)) {
      addError(identity.pid, 'unverifiable ownership: tracked process identity is incomplete');
      continue;
    }
    try {
      const termination = await terminateProcess(identity);
      if (termination?.status === 'terminated') {
        attemptedPids.push(identity.pid);
      } else if (termination?.status === 'identity-mismatch') {
        addError(identity.pid, 'ownership mismatch: PID now belongs to a different process identity');
      } else if (termination?.status === 'unsafe-identity-swap') {
        addError(identity.pid, 'unsafe termination refused: held process identity no longer matched the PID snapshot');
      } else if (termination?.status === 'unverifiable') {
        addError(
          identity.pid,
          `unverifiable termination: held process ${termination.field || 'identity'} could not be verified`,
        );
      } else if (termination?.status === 'error') {
        addError(identity.pid, `verified termination failed: ${termination.field || 'unknown error'}`);
      } else if (termination?.status !== 'not-found') {
        addError(identity.pid, `verified termination returned unexpected status: ${termination?.status || '<missing>'}`);
      }
    } catch (error) {
      warnings.push(`pid ${identity.pid}: ${error.message}`);
    }
  }

  if (settleMs > 0) await wait(settleMs);
  const finalList = (await listProcesses()).map(normalizeProcessEntry);
  const remainingPids = [];
  for (const identity of trusted) {
    const current = finalList.find((entry) => entry.pid === identity.pid);
    if (!current) continue;
    if (!sameProcessIdentity(identity, current)) {
      addError(identity.pid, 'ownership mismatch: PID now belongs to a different process identity');
      continue;
    }
    remainingPids.push(identity.pid);
    addError(identity.pid, 'owned process still running after cleanup');
  }

  return {
    ...inspected,
    ownedPids: initialOwnedPids,
    processes: trusted,
    initialOwnedPids,
    attemptedPids,
    warnings,
    remainingPids,
    errors,
  };
}

module.exports = {
  ROUTE_EXPECTATIONS,
  connectCdp,
  findStartupLog,
  findAvailablePort,
  getJson,
  listSystemProcesses,
  launchDesktop,
  createRuntimeLayout,
  seedProductState,
  cleanupRuntimeDir,
  sweepStaleQuarantineDirs,
  portIsAvailable,
  startupLogCandidates,
  findRendererTarget,
  driveByRole,
  driveRoutes,
  captureScreenshot,
  inspectProcesses,
  cleanupOwned,
  terminateVerifiedProcess,
  parsePositiveInteger,
  execFileAsync,
  createOverallWatchdog,
  createSingleFinalizer,
  createOwnershipCleanupEvidence,
  finalizeHarnessRun,
  finalizeUnsafeHarnessFailure,
  throwIfAborted,
  normalizeProcessEntry,
  sameProcessIdentity,
  createOwnedProcessTracker,
  requireUsableCodeBuddyStartup,
  waitForRendererValue,
  waitForVisibleSettingValue,
};
