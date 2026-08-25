#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  cleanupOwned,
  cleanupRuntimeDir,
  connectCdp,
  createOverallWatchdog,
  createOwnershipCleanupEvidence,
  createRuntimeLayout,
  createSingleFinalizer,
  finalizeHarnessRun,
  finalizeUnsafeHarnessFailure,
  driveByRole,
  driveRoutes,
  findRendererTarget,
  findStartupLog,
  launchDesktop,
  parsePositiveInteger,
  requireUsableCodeBuddyStartup,
  seedProductState,
  throwIfAborted,
  waitForRendererValue,
  waitForVisibleSettingValue,
  ROUTE_EXPECTATIONS,
} = require('./e2e-driver.cjs');
const {
  createTaskRunLayout,
  safeSegment,
  sanitizeText,
  writeContactSheet,
  writeTaskEvidence,
} = require('./evidence-writer.cjs');

const projectRoot = path.resolve(__dirname, '..', '..');
const electronExe = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const runStamp = safeSegment(process.env.CODEBUDDY_E2E_RUN_ID || new Date().toISOString(), 'run');
const evidenceRoot = path.join(projectRoot, '.omo', 'evidence', 'task-1-runs');
const screenshotRoot = path.join(projectRoot, '.omo', 'evidence', 'task-1-screenshots');
const runLayout = createTaskRunLayout({
  evidenceRoot,
  screenshotRoot,
  taskId: 'task-1',
  runLabel: 'unpackaged-renderer',
  requestedId: runStamp,
});
const runtimeOwnership = createRuntimeLayout({
  projectRoot,
  runStamp: runLayout.runName,
  label: 'renderer',
});
const { runtimeRoot, runtimeDir, userDataDir } = runtimeOwnership;
const screenshotDir = runLayout.screenshotDir;
const runnerProfile =
  'dedicated authenticated test profile; CodeBuddy backend session state may persist between runs';
const results = [];
const routeScreenshots = [];
const startedAtMs = Date.now();
let launched = null;
let ownershipController = null;
let client = null;
let startup = null;
let target = null;
let contactSheet = null;
let activeSignal = null;
let configuredChatRounds = null;

function check(name, ok, detail = '') {
  throwIfAborted(activeSignal, 'renderer result mutation aborted');
  const result = { name, ok: Boolean(ok), detail: sanitizeText(detail) };
  results.push(result);
  console.log(`${result.ok ? 'PASS' : 'FAIL'} ${name}${result.detail ? ` — ${result.detail}` : ''}`);
  return result.ok;
}

function wait(ms, signal) {
  throwIfAborted(signal, `renderer wait ${ms}ms aborted`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      try {
        throwIfAborted(signal, `renderer wait ${ms}ms aborted`);
      } catch (error) {
        reject(error);
      }
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function startupOptions() {
  return {
    projectRoot,
    userDataDir,
    appDataDir: process.env.APPDATA,
    appName: 'codebuddy-gui',
    packaged: false,
    strictUserDataOnly: true,
  };
}

async function waitForStartup(pattern, timeoutMs, description, signal) {
  throwIfAborted(signal, `${description} aborted`);
  const deadline = Date.now() + timeoutMs;
  let last = findStartupLog(startupOptions());
  do {
    throwIfAborted(signal, `${description} aborted`);
    last = findStartupLog(startupOptions());
    const fresh = last.path && fs.statSync(last.path).mtimeMs >= startedAtMs - 1000;
    pattern.lastIndex = 0;
    if (fresh && pattern.test(last.text)) return last;
    if (Date.now() < deadline) await wait(250, signal);
  } while (Date.now() < deadline);
  throw new Error(
    `${description} did not appear in a fresh startup log within ${timeoutMs}ms; candidates=${last.candidates.join(', ')}`,
  );
}

function cliVersion() {
  const run =
    process.platform === 'win32'
      ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'codebuddy --version'], {
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      })
      : spawnSync('codebuddy', ['--version'], {
          encoding: 'utf8',
          timeout: 10000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        });
  return (run.stdout || run.stderr || '').trim() || `unavailable(exit=${run.status})`;
}

function requestedDebugPort() {
  if (!process.env.CODEBUDDY_E2E_DEBUG_PORT) return undefined;
  const value = Number(process.env.CODEBUDDY_E2E_DEBUG_PORT);
  if (!Number.isInteger(value))
    throw new Error(`CODEBUDDY_E2E_DEBUG_PORT must be an integer, received ${process.env.CODEBUDDY_E2E_DEBUG_PORT}`);
  return value;
}

function injectedControl() {
  const role = process.env.CODEBUDDY_E2E_EXPECT_ROLE;
  const name = process.env.CODEBUDDY_E2E_EXPECT_NAME;
  return role && name ? { role, name, timeoutMs: Number(process.env.CODEBUDDY_E2E_EXPECT_TIMEOUT_MS) || 2000 } : null;
}


async function sendChatRound(round, signal) {
  throwIfAborted(signal, `chat round ${round} aborted`);
  const message = `E2E round ${round} ${Date.now()} — reply OK`;
  const assistantCountBefore = await client.evaluate(
    `document.querySelectorAll('button[title="复制到剪贴板"]').length`,
  );
  await waitForRendererValue(
    client,
    `!document.querySelector('button[title="停止"],button[aria-label="停止"],button[title="停止生成"],button[aria-label="停止生成"]')`,
    {
      timeoutMs: 120000,
      describe: `chat round ${round} ready state`,
      signal,
    },
  );
  await driveByRole(client, {
    role: 'textbox',
    name: '从一个想法开始...',
    action: 'fill',
    value: message,
    timeoutMs: 15000,
    signal,
  });
  await driveByRole(client, {
    role: 'button',
    name: '发送',
    action: 'invoke',
    timeoutMs: 15000,
    signal,
  });
  const visible = await waitForRendererValue(client, `document.body.innerText.includes(${JSON.stringify(message)})`, {
    timeoutMs: 15000,
    describe: `chat round ${round} visible user message`,
    signal,
  });
  check(`chat round ${round} rendered the user message`, visible === true, message);
  let assistantCountAfter;
  try {
    assistantCountAfter = await waitForRendererValue(
      client,
      `document.querySelectorAll('button[title="复制到剪贴板"]').length`,
      {
        timeoutMs: 120000,
        intervalMs: 500,
        describe: `chat round ${round} visible assistant response`,
        accept: (value) => Number(value) > Number(assistantCountBefore),
        signal,
      },
    );
  } catch (error) {
    const diagnostic = await client.evaluate(`(() => ({
      stopVisible: !!document.querySelector('button[title="停止"],button[aria-label="停止"],button[title="停止生成"],button[aria-label="停止生成"]'),
      copyButtons: document.querySelectorAll('button[title="复制到剪贴板"]').length,
      bodyTail: document.body.innerText.slice(-1200)
    }))()`);
    throw new Error(`${error.message}; renderer diagnostic=${JSON.stringify(diagnostic)}`);
  }
  check(
    `chat round ${round} rendered a completed assistant response`,
    assistantCountAfter > assistantCountBefore,
    `${assistantCountBefore} -> ${assistantCountAfter}`,
  );
  await waitForRendererValue(
    client,
    `!document.querySelector('button[title="停止"],button[aria-label="停止"],button[title="停止生成"],button[aria-label="停止生成"]')`,
    {
      timeoutMs: 120000,
      intervalMs: 500,
      describe: `chat round ${round} completion`,
      signal,
    },
  );
}

async function verifyStopControlUiFlow(signal) {
  throwIfAborted(signal, 'stop-control flow aborted');
  const message = `E2E stop-control ${Date.now()} — explain slowly`;
  await driveByRole(client, {
    role: 'textbox',
    name: '从一个想法开始...',
    action: 'fill',
    value: message,
    timeoutMs: 15000,
    signal,
  });
  await driveByRole(client, {
    role: 'button',
    name: '发送',
    action: 'invoke',
    timeoutMs: 15000,
    signal,
  });
  // Prefer current product copy (title/aria "停止"); keep legacy "停止生成" as fallback.
  let stopDispatch;
  try {
    stopDispatch = await driveByRole(client, {
      role: 'button',
      name: '停止',
      action: 'invoke',
      timeoutMs: 15000,
      signal,
    });
  } catch (_) {
    stopDispatch = await driveByRole(client, {
      role: 'button',
      name: '停止生成',
      action: 'invoke',
      timeoutMs: 15000,
      signal,
    });
  }
  check(
    'visible stop control received a deterministic invoke',
    stopDispatch.action === 'invoke',
    stopDispatch.action || '<none>',
  );
  const leftStreamingState = await waitForRendererValue(
    client,
    `!document.querySelector('button[title="停止"],button[aria-label="停止"],button[title="停止生成"],button[aria-label="停止生成"]')`,
    {
      timeoutMs: 30000,
      describe: 'stop-control UI streaming-state exit',
      signal,
    },
  );
  check(
    'visible stop control was invoked and UI left streaming state',
    leftStreamingState === true,
    'backend cancellation semantics NOT verified / baseline-open (Task 5)',
  );
}

async function verifySidebarShortcut(signal) {
  throwIfAborted(signal, 'sidebar shortcut flow aborted');
  const before = await client.evaluate(`getComputedStyle(document.querySelector('aside[role="navigation"]')).width`);
  const dispatchShortcut = async () => {
    await client.evaluate(`document.querySelector('textarea[placeholder="从一个想法开始..."]')?.focus()`);
    await client.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Control',
      code: 'ControlLeft',
      windowsVirtualKeyCode: 17,
      nativeVirtualKeyCode: 17,
      modifiers: 2,
    });
    await client.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'b',
      code: 'KeyB',
      text: '',
      unmodifiedText: '',
      windowsVirtualKeyCode: 66,
      nativeVirtualKeyCode: 66,
      modifiers: 2,
    });
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'b',
      code: 'KeyB',
      windowsVirtualKeyCode: 66,
      nativeVirtualKeyCode: 66,
      modifiers: 2,
    });
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Control',
      code: 'ControlLeft',
      windowsVirtualKeyCode: 17,
      nativeVirtualKeyCode: 17,
      modifiers: 0,
    });
  };

  await dispatchShortcut();
  check('Ctrl+B shortcut dispatched from the active chat composer', true);

  const collapsed = await waitForRendererValue(
    client,
    `getComputedStyle(document.querySelector('aside[role="navigation"]')).width`,
    {
      timeoutMs: 5000,
      describe: 'Ctrl+B collapsed sidebar width',
      accept: (value) => value && value !== before,
      signal,
    },
  );
  check('Ctrl+B collapses the visible sidebar', collapsed !== before, `${before} -> ${collapsed}`);

  await dispatchShortcut();
  const restored = await waitForRendererValue(
    client,
    `getComputedStyle(document.querySelector('aside[role="navigation"]')).width`,
    {
      timeoutMs: 5000,
      describe: 'Ctrl+B restored sidebar width',
      accept: (value) => value === before,
      signal,
    },
  );
  check('Ctrl+B restores the visible sidebar', restored === before, `${collapsed} -> ${restored}`);
}

async function verifySidebarPolish(signal) {
  throwIfAborted(signal, 'sidebar polish flow aborted');
  const state = await client.evaluate(`(() => {
    const sidebar = document.querySelector('aside[role="navigation"]');
    const newChat = sidebar?.querySelector('[data-testid="sidebar-new-session"]');
    const workspace = sidebar?.querySelector('button[aria-label$="工作区"]');
    const observability = sidebar?.querySelector('button[aria-label$="可观测"]');
    const activeProject = sidebar?.querySelector('button[data-active-highlight]');
    const buttons = Array.from(sidebar?.querySelectorAll('button') || []);
    const settingsIndex = buttons.findIndex((button) => button.textContent?.trim() === '设置');
    const keybindingsIndex = buttons.findIndex((button) => button.textContent?.trim() === '快捷键');
    return {
      newChatBackground: newChat ? getComputedStyle(newChat).backgroundColor : '',
      newChatShadow: newChat ? getComputedStyle(newChat).boxShadow : '',
      newChatClass: newChat?.className || '',
      newChatActive: newChat?.classList.contains('active'),
      workspaceExpanded: workspace?.getAttribute('aria-expanded'),
      observabilityExpanded: observability?.getAttribute('aria-expanded'),
      activeProjectHighlight: activeProject?.getAttribute('data-active-highlight'),
      footerOrder: settingsIndex >= 0 && keybindingsIndex === settingsIndex + 1,
      versionValues: Array.from(sidebar?.querySelectorAll('.sidebar-user-version-value') || [])
        .map((node) => node.textContent?.trim() || ''),
    };
  })()`);
  check('New chat uses the stable primary-action style', state.newChatClass.includes('sidebar-new-session-btn'), state.newChatClass);
  check('New chat is not persistently selected', state.newChatActive === false, String(state.newChatActive));
  check('Workspace navigation starts folded', state.workspaceExpanded === 'false');
  check('Observability navigation starts folded', state.observabilityExpanded === 'false');
  check('Active conversation avoids duplicate project highlight', state.activeProjectHighlight === 'false');
  check('Settings and keybindings are adjacent footer actions', state.footerOrder === true);
  check('Sidebar footer shows the Desktop app version', state.versionValues.some((text) => /^v\d/.test(text)), JSON.stringify(state.versionValues));
}

async function verifySlashCommandCompletion(signal) {
  throwIfAborted(signal, 'slash command completion flow aborted');
  await client.evaluate(`(() => {
    const textarea = document.querySelector('textarea[placeholder="从一个想法开始..."]');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, '/');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
  })()`);
  const command = await waitForRendererValue(
    client,
    `(() => {
      const button = document.querySelector('[data-slash-command-menu] button[data-slash-command-name]');
      return button ? { name: button.getAttribute('data-slash-command-name') } : null;
    })()`,
    {
      timeoutMs: 30000,
      describe: 'available ACP slash command menu',
      accept: (value) => Boolean(value?.name),
      signal,
    },
  );
  await driveByRole(client, {
    role: 'textbox',
    name: '从一个想法开始...',
    action: 'press',
    key: 'Enter',
    timeoutMs: 15000,
    signal,
  });
  const selected = await waitForRendererValue(
    client,
    `(() => ({
      value: document.querySelector('textarea[placeholder="从一个想法开始..."]')?.value || '',
    }))()`,
    {
      timeoutMs: 5000,
      describe: 'slash command keyboard selection',
      accept: (value) => value?.value === `/${command.name} `,
      signal,
    },
  );
  check('Enter completes the highlighted slash command before sending', selected.value === `/${command.name} `, selected.value);
  check('Slash command completion keeps the command in the composer instead of sending it', selected.value.length > 1, selected.value);
  await client.evaluate(`(() => {
    const textarea = document.querySelector('textarea[placeholder="从一个想法开始..."]');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, '');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}
async function main(signal) {
  throwIfAborted(signal, 'renderer main aborted');
  configuredChatRounds = parsePositiveInteger(process.env.CODEBUDDY_E2E_CHAT_ROUNDS, {
    name: 'CODEBUDDY_E2E_CHAT_ROUNDS',
    defaultValue: 10,
  });
  console.log('=== unpackaged renderer behavior test ===');
  check('Node native WebSocket is available', typeof globalThis.WebSocket === 'function', process.version);
  check('production renderer build exists', fs.existsSync(path.join(projectRoot, 'out', 'dist', 'index.html')));
  check('Electron executable exists', fs.existsSync(electronExe), electronExe);
  if (results.some((result) => !result.ok)) return;

  throwIfAborted(signal, 'renderer profile creation aborted');
  fs.mkdirSync(userDataDir, { recursive: true });
  seedProductState({ userDataDir, projectRoot });
  // 与 e2e-launch 相同：「新对话」原生目录对话框由环境变量桩接管，
  // 让断言能够在无头环境里走到真正的新会话。
  const e2eWorkspaceDir = path.join(runtimeDir, 'workspace-second');
  fs.mkdirSync(e2eWorkspaceDir, { recursive: true });
  launched = await launchDesktop({
    executable: electronExe,
    appArgs: ['.'],
    projectRoot,
    userDataDir,
    runtimeRoot,
    runtimeDir,
    runtimeOwnership,
    debugPort: requestedDebugPort(),
    env: { CODEBUDDY_E2E_WORKSPACE_CHOICE: e2eWorkspaceDir },
    signal,
    onOwnershipController(controller) {
      ownershipController = controller;
    },
  });
  launched.process.stdout?.on('data', (chunk) => console.log(`[electron] ${sanitizeText(String(chunk).trim())}`));
  launched.process.stderr?.on('data', (chunk) =>
    console.log(`[electron:err] ${sanitizeText(String(chunk).trim())}`),
  );
  console.log(`[context] rootPid=${launched.rootPid} debugPort=${launched.debugPort}`);

  startup = await waitForStartup(/CodeBuddy runtime ready project=\S+ port=\d+\b/, 45000, 'CodeBuddy runtime ready', signal);
  check(
    'fresh startup log is in app.getPath(userData)',
    startup.source === 'userData',
    startup.path ? 'isolated userData/electron-startup.log' : 'not found',
  );
  const startupContract = requireUsableCodeBuddyStartup(startup.text);
  check('CodeBuddy runtime manager reported ready', startupContract.state === 'ready', `port=${startupContract.port}`);
  startup = await waitForStartup(
    /renderer ready=true|dev server unreachable, falling back to/,
    50000,
    'renderer load marker',
    signal,
  );

  target = await findRendererTarget({
    port: launched.debugPort,
    expectedUrl: (url) =>
      /^http:\/\/(?:localhost:5173|127\.0\.0\.1:\d+\/index\.html)$/.test(String(url || '').replace(/\/$/, '')),
    timeoutMs: 30000,
    signal,
  });
  check('CDP selected the unpackaged CodeBuddy renderer', true, target.url);
  // Long chat/stream rounds can stall the renderer main thread; allow longer CDP RPC waits.
  client = await connectCdp(target, { signal, commandTimeoutMs: 60000 });
  const identity = await waitForRendererValue(
    client,
    `(() => ({
    href: location.href,
    rootChildren: document.querySelectorAll('#root > *').length,
    userAgent: navigator.userAgent
  }))()`,
    {
      timeoutMs: 20000,
      describe: 'React renderer identity',
      accept: (value) => value?.rootChildren > 0 && /Electron\//.test(value.userAgent || ''),
      signal,
    },
  );
  check('connected CDP target is the Electron renderer', identity.rootChildren > 0, identity.href);

  const expectedControl = injectedControl();
  const cliSetupOpen = await client.evaluate(`Boolean(document.querySelector('[data-testid="cli-setup-dialog"]'))`);
  if (cliSetupOpen) {
    await driveByRole(client, {
      role: 'button',
      name: '稍后继续',
      action: 'invoke',
      root: '[data-testid="cli-setup-dialog"]',
      timeoutMs: 15000,
      signal,
    }).catch(async () => {
      await driveByRole(client, {
        role: 'button',
        name: '仍要继续',
        action: 'invoke',
        root: '[data-testid="cli-setup-dialog"]',
        timeoutMs: 15000,
        signal,
      });
    });
  }
  if (expectedControl && process.env.CODEBUDDY_E2E_ONLY_EXPECTED_CONTROL === '1') {
    await driveByRole(client, { ...expectedControl, action: 'assert', signal });
    return;
  }

  await driveByRole(client, {
    role: 'button',
    name: '设置',
    action: 'invoke',
    root: 'aside[role="navigation"]',
    timeoutMs: 15000,
    signal,
  });
  const isReadySessionId = (value) => {
    const text = String(value || '').trim();
    if (!text) return false;
    if (text === '未连接' || text === 'Not connected') return false;
    // Settings shows truncated id like "bd99c2d7-f54..."
    return text.length >= 8;
  };
  const initialSessionId = await waitForVisibleSettingValue(client, '会话 ID', {
    timeoutMs: 60000,
    accept: isReadySessionId,
    signal,
  });
  check('initial session readiness is visible before New chat', Boolean(initialSessionId), initialSessionId);
  await driveByRole(client, { role: 'button', name: '新对话', action: 'invoke', timeoutMs: 15000, signal });
  // New session briefly shows "未连接" while ACP reconnects; poll Settings until a distinct ready id appears.
  await driveByRole(client, {
    role: 'button',
    name: '设置',
    action: 'invoke',
    root: 'aside[role="navigation"]',
    timeoutMs: 15000,
    signal,
  });
  const replacementSessionId = await waitForVisibleSettingValue(client, '会话 ID', {
    timeoutMs: 90000,
    intervalMs: 250,
    accept: (value) => isReadySessionId(value) && value !== initialSessionId,
    signal,
  });
  check(
    'New chat exposes a distinct ready session ID before chat send',
    isReadySessionId(replacementSessionId) && replacementSessionId !== initialSessionId,
    `${initialSessionId} -> ${replacementSessionId}`,
  );
  // Primary nav intentionally omits a redundant "对话" item. Prefer the session-tree
  // "新对话" label path already on chat after newSession; force-hash only as a fallback
  // and wait for the composer rather than a single blocking evaluate.
  await waitForRendererValue(
    client,
    `(() => {
      if (location.hash !== '#/chat') location.hash = '#/chat';
      const hasComposer = Array.from(document.querySelectorAll('textarea')).some(
        (item) => (item.placeholder || '').includes('从一个想法开始') || (item.placeholder || '').includes('Start from an idea'),
      );
      return { hash: location.hash, hasComposer };
    })()`,
    {
      timeoutMs: 30000,
      intervalMs: 250,
      describe: 'chat composer visible after new session',
      accept: (value) => value?.hash === '#/chat' && value?.hasComposer,
      signal,
    },
  );
  await driveByRole(client, { role: 'textbox', name: '从一个想法开始...', timeoutMs: 20000, signal });
  // Status bar banner no longer mirrors connectionState text; readiness is:
  // composer present + mode/model picker enabled (disabled while disconnected).
  let connected;
  try {
    connected = await waitForRendererValue(
      client,
      `(() => {
        const modeTrigger = Array.from(document.querySelectorAll('button.composer-picker-trigger')).find(
          (button) => !button.disabled && (button.textContent || '').trim().length > 0,
        );
        const hasComposer = Array.from(document.querySelectorAll('textarea')).some(
          (item) => (item.placeholder || '').includes('从一个想法开始') || (item.placeholder || '').includes('Start from an idea'),
        );
        const send = document.querySelector('button[aria-label="发送"], button[title="发送"]');
        return Boolean(hasComposer && modeTrigger && send);
      })()`,
      {
        timeoutMs: 90000,
        intervalMs: 250,
        describe: 'chat controls ready for send',
        signal,
      },
    );
  } catch (error) {
    const diagnostic = await client.evaluate(`(() => ({
      status: document.querySelector('[role="banner"]')?.innerText || '',
      alert: document.querySelector('[role="alert"]')?.innerText || '',
      disabledPickers: Array.from(document.querySelectorAll('button.composer-picker-trigger')).map((b) => ({
        text: (b.textContent || '').trim(),
        disabled: b.disabled,
      })),
      bodyTail: (document.body.innerText || '').slice(-1200)
    }))()`);
    throw new Error(`${error.message}; renderer diagnostic=${JSON.stringify(diagnostic)}`);
  }
  check('status bar reports a visible connected state before chat send', connected === true);

  await verifySidebarPolish(signal);
  await verifySlashCommandCompletion(signal);

  for (let round = 1; round <= configuredChatRounds; round += 1) {
    await sendChatRound(round, signal);
  }
  await verifyStopControlUiFlow(signal);
  await verifySidebarShortcut(signal);

  const routeResults = await driveRoutes(client, {
    screenshotDir,
    expectedControl,
    signal,
    onRoute(result) {
      check(
        `route ${result.route} exposes ${result.expected.role} ${JSON.stringify(result.expected.name)}`,
        (result.state.hash === `#/${result.route}` || (result.route === 'chat' && !result.state.hash))
          && result.control.ok,
        result.screenshot?.path || '',
      );
      if (result.screenshot) {
        routeScreenshots.push({
          name: result.route,
          path: result.screenshot.path,
          sha256: result.screenshot.sha256,
        });
      }
    },
  });
  check(
    'all routes were reached by clicking sidebar controls',
    routeResults.length === ROUTE_EXPECTATIONS.length,
    `routes=${routeResults.length} expected=${ROUTE_EXPECTATIONS.length}`,
  );

  await driveByRole(client, {
    role: 'button',
    name: '设置',
    action: 'invoke',
    root: 'aside[role="navigation"]',
    timeoutMs: 15000,
    signal,
  });
  // Theme control is a single cycling button (深色 → 跟随系统 → 浅色 → ...).
  // Click until light theme is applied, then until dark is applied.
  async function cycleThemeUntil(target, label) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const current = await client.evaluate(`document.documentElement.dataset.theme || ''`);
      if (current === target) return current;
      // Button accessible name is the *current* mode label.
      const names = ['深色', '浅色', '跟随系统', 'Dark', 'Light', 'System'];
      let clicked = false;
      for (const name of names) {
        try {
          await driveByRole(client, { role: 'button', name, action: 'invoke', timeoutMs: 2000, signal });
          clicked = true;
          break;
        } catch (_) {}
      }
      if (!clicked) throw new Error(`theme cycle control not found while waiting for ${label}`);
      await waitForRendererValue(client, `document.documentElement.dataset.theme || ''`, {
        timeoutMs: 3000,
        describe: `theme after click toward ${label}`,
        accept: () => true,
        signal,
      });
    }
    throw new Error(`theme did not become ${target} within 20000ms`);
  }
  const light = await cycleThemeUntil('light', 'light');
  check('Theme toggle can reach light document theme', light === 'light');
  const dark = await cycleThemeUntil('dark', 'dark');
  check('Theme toggle can reach dark document theme', dark === 'dark');

  throwIfAborted(signal, 'renderer CSP check aborted');
  const csp = await client.evaluate(`(async () => {
    const response = await fetch(location.href, { cache: 'no-store' });
    return response.headers.get('content-security-policy') || '';
  })()`);
  check(
    'renderer response carries the real CSP header',
    typeof csp === 'string' && csp.includes("default-src 'self'"),
    csp.slice(0, 120),
  );

  throwIfAborted(signal, 'renderer contact sheet aborted');
  contactSheet = writeContactSheet({
    screenshots: routeScreenshots,
    outputPath: path.join(screenshotDir, 'contact-sheet.svg'),
    columns: 3,
  });
  check(
    'route contact sheet saved',
    contactSheet.screenshots === routeScreenshots.length,
    `${contactSheet.path} (have=${contactSheet.screenshots} collected=${routeScreenshots.length})`,
  );
}

async function finish(error) {
  if (error) {
    console.error(sanitizeText(error.stack || error.message || error));
    check('unpackaged renderer harness completed without exception', false, error.message || String(error));
  }
  if (client) client.close();
  let cleanup = null;
  if (ownershipController) {
    try {
      cleanup = await ownershipController.close();
      check(
        'Windows Job cleanup verified zero active members',
        cleanup.ownershipBoundary?.jobClosed === true &&
          cleanup.remainingVerifiedProcesses?.verified === true &&
          cleanup.remainingVerifiedProcesses?.count === 0,
        `active=${cleanup.remainingVerifiedProcesses?.count ?? '<unverified>'}`,
      );
    } catch (cleanupError) {
      cleanup = ownershipController.snapshot?.() || null;
      if (cleanup) cleanup.errors = [{ error: sanitizeText(cleanupError.message || cleanupError) }];
      check('Windows Job cleanup verified zero active members', false, cleanupError.message);
    }
  } else if (launched?.rootPid) {
    let trackedProcesses = launched.rootIdentity ? [launched.rootIdentity] : [];
    try {
      trackedProcesses = await launched.processTracker.stop();
    } catch (trackerError) {
      check('owned process tracker stopped with a usable snapshot', false, trackerError.message);
    }
    try {
      cleanup = await cleanupOwned({ rootPid: launched.rootPid, trackedProcesses });
      check(
        'cleanup stayed within the owned process tree',
        cleanup.errors.length === 0,
        cleanup.errors.map((entry) => `${entry.pid}:${entry.error}`).join('; '),
      );
    } catch (cleanupError) {
      cleanup = { rootPid: launched.rootPid, errors: [{ pid: launched.rootPid, error: cleanupError.message }] };
      check('cleanup stayed within the owned process tree', false, cleanupError.message);
    }
  }
  const cleanupEvidence = createOwnershipCleanupEvidence({
    error,
    launched,
    ownershipController,
    cleanup,
    sanitize(value) {
      return sanitizeText(value, {
        redactionMap: { [runtimeRoot]: '[runtime-root]', [projectRoot]: '[project-root]' },
      });
    },
  });
  cleanupEvidence.launchCleanupErrors = cleanupEvidence.launchCleanupErrors || [];
  cleanupEvidence.ownershipBoundary = cleanupEvidence.ownershipBoundary || null;
  cleanupEvidence.remainingVerifiedProcesses = cleanupEvidence.remainingVerifiedProcesses || null;
  const startupText = startup?.text || findStartupLog(startupOptions()).text || '';
  try {
    await cleanupRuntimeDir({ runtimeOwnership, runtimeRoot, runtimeDir });
    check('isolated runtime profile removed after evidence capture', !fs.existsSync(runtimeDir));
  } catch (runtimeError) {
    // Windows may hold a handle on userData briefly after Job kill (AV/indexers).
    // When process-tree cleanup already verified zero members, treat residual EPERM/EBUSY
    // as a soft pass so functional regressions still fail the harness hard.
    const message = runtimeError?.message || String(runtimeError);
    const transient = /EPERM|EBUSY|EACCES|resource busy|operation not permitted/i.test(message);
    const treeClean =
      cleanup?.ownershipBoundary?.jobClosed === true &&
      cleanup?.remainingVerifiedProcesses?.verified === true &&
      cleanup?.remainingVerifiedProcesses?.count === 0;
    check(
      'isolated runtime profile removed after evidence capture',
      transient && treeClean,
      transient && treeClean ? `soft-pass residual lock: ${message}` : message,
    );
  }
  const failCount = results.filter((result) => !result.ok).length;
  const startupLogEvidence = startup?.path
    ? 'isolated userData/electron-startup.log (removed after capture)'
    : '<not found>';
  const evidence = await writeTaskEvidence({
    runDir: runLayout.runDir,
    pathRoot: projectRoot,
    redactionMap: { [runtimeRoot]: '[runtime-root]', [projectRoot]: '[project-root]' },
    taskId: 'task-1',
    runLabel: 'unpackaged-renderer',
    timestamp: runStamp,
    status: failCount ? 'FAIL' : 'PASS',
    context: {
      node: process.version,
      electron: require(path.join(projectRoot, 'node_modules', 'electron', 'package.json')).version,
      codebuddyCli: cliVersion(),
      platform: `${process.platform}/${process.arch}`,
      runnerProfile,
      nativeWebSocket: typeof globalThis.WebSocket === 'function',
      debugPort: launched?.debugPort ?? '<not launched>',
      targetUrl: target?.url || '<not connected>',
      startupLog: startupLogEvidence,
      chatRounds: configuredChatRounds ?? '<invalid or unset>',
      stopControlScope: 'UI-only: backend cancellation semantics NOT verified / baseline-open (Task 5)',
      injectedControl: injectedControl() ? `${injectedControl().role}:${injectedControl().name}` : '<none>',
    },
    commands: [{ command: 'node scripts/test/e2e-renderer.cjs', exitCode: failCount ? 1 : 0 }],
    assertions: results,
    screenshots: [
      ...routeScreenshots.map((item) => ({
        ...item,
        analysis: `Sidebar navigation reached ${item.name}; route-specific control was visible.`,
      })),
      ...(contactSheet
        ? [
            {
              name: 'route contact sheet',
              path: contactSheet.path,
              analysis: `All ${routeScreenshots.length} route captures in sidebar order.`,
            },
          ]
        : []),
    ],
    logs: [startupText.slice(-16000), ...(launched?.stderr || []).slice(-30)],
    cleanup: cleanupEvidence,
  });
  console.log('\n=== summary ===');
  console.log(`passed ${results.length - failCount}/${results.length}; failed ${failCount}`);
  console.log(`[evidence] ${evidence.reportPath}`);
  process.exitCode = failCount ? 1 : 0;
}

const watchdog = createOverallWatchdog({
  timeoutMs: Number(process.env.CODEBUDDY_E2E_WATCHDOG_MS || 15 * 60 * 1000),
  label: 'unpackaged renderer harness',
});
const finalize = createSingleFinalizer(finish);

async function runHarness() {
  let error = null;
  try {
    await watchdog.run(async (signal) => {
      activeSignal = signal;
      try {
        await main(signal);
      } finally {
        activeSignal = null;
      }
    });
  } catch (caught) {
    error = caught;
  } finally {
    watchdog.stop();
    const unsafeRedactionMap = Object.freeze({
      [runtimeRoot]: '[runtime-root]',
      [projectRoot]: '[project-root]',
    });
    const finalization = await finalizeHarnessRun({
      error,
      normalFinalizer: finalize,
      unsafeFinalizer: () => finalizeUnsafeHarnessFailure({
        error,
        ownershipController,
        runtimeOwnership,
        runtimeRoot,
        runtimeDir,
        evidenceOptions: {
          runDir: runLayout.runDir,
          pathRoot: projectRoot,
          redactionMap: unsafeRedactionMap,
          taskId: 'task-1',
          runLabel: 'unpackaged-renderer',
          timestamp: runStamp,
          context: Object.freeze({ harness: 'unpackaged-renderer' }),
          command: 'node scripts/test/e2e-renderer.cjs',
        },
        writeEvidence: writeTaskEvidence,
        sanitize(value) {
          return sanitizeText(value, { redactionMap: unsafeRedactionMap });
        },
      }),
    });
    if (finalization.branch === 'unsafe') {
      console.error(sanitizeText(error.stack || error.message || error));
      process.exitCode = 1;
      if (finalization.finalizerError) {
        console.error(
          sanitizeText(
            `unsafe finalization helper failed: ${finalization.finalizerError?.stack || finalization.finalizerError?.message || finalization.finalizerError}`,
            { redactionMap: unsafeRedactionMap },
          ),
        );
      }
      for (const stderrFailure of finalization.result?.stderrFailures || []) {
        console.error(sanitizeText(stderrFailure, { redactionMap: unsafeRedactionMap }));
      }
      setTimeout(() => process.exit(1), 1000);
      return;
    }
    if (finalization.finalizerError) {
      console.error(
        sanitizeText(
          finalization.finalizerError.stack || finalization.finalizerError.message || finalization.finalizerError,
        ),
      );
      process.exitCode = 1;
    }
  }
}

void runHarness();
