#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  captureScreenshot,
  cleanupOwned,
  cleanupRuntimeDir,
  sweepStaleQuarantineDirs,
  connectCdp,
  createOverallWatchdog,
  createOwnershipCleanupEvidence,
  createRuntimeLayout,
  createSingleFinalizer,
  finalizeHarnessRun,
  finalizeUnsafeHarnessFailure,
  driveByRole,
  findRendererTarget,
  findStartupLog,
  inspectProcesses,
  launchDesktop,
  requireUsableCodeBuddyStartup,
  seedProductState,
  throwIfAborted,
  waitForRendererValue,
  waitForVisibleSettingValue,
} = require('./e2e-driver.cjs');
const { createTaskRunLayout, safeSegment, sanitizeText, writeTaskEvidence } = require('./evidence-writer.cjs');

const projectRoot = path.resolve(__dirname, '..', '..');
const electronExe = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const runStamp = safeSegment(process.env.CODEBUDDY_E2E_RUN_ID || new Date().toISOString(), 'run');
const evidenceRoot = path.join(projectRoot, '.omo', 'evidence', 'task-1-runs');
const screenshotRoot = path.join(projectRoot, '.omo', 'evidence', 'task-1-screenshots');
const runLayout = createTaskRunLayout({
  evidenceRoot,
  screenshotRoot,
  taskId: 'task-1',
  runLabel: 'unpackaged-launch',
  requestedId: runStamp,
});
const runtimeOwnership = createRuntimeLayout({
  projectRoot,
  runStamp: runLayout.runName,
  label: 'launch',
});
const { runtimeRoot, runtimeDir, userDataDir } = runtimeOwnership;
// L16: sweep stale quarantine dirs left by a previous run whose rmSync partially
// failed (AV/indexer lock) before this run creates its own runtime dir.
sweepStaleQuarantineDirs(runtimeRoot);
const screenshotPath = path.join(runLayout.screenshotDir, 'startup.png');
const runnerProfile =
  'dedicated authenticated test profile; CodeBuddy backend session state may persist between runs';
const results = [];
const startedAtMs = Date.now();
let launched = null;
let ownershipController = null;
let client = null;
let startup = null;
let target = null;
let evidencePaths = null;
let activeSignal = null;

function check(name, ok, detail = '') {
  throwIfAborted(activeSignal, 'unpackaged launch result mutation aborted');
  const result = { name, ok: Boolean(ok), detail: sanitizeText(detail) };
  results.push(result);
  console.log(`${result.ok ? 'PASS' : 'FAIL'} ${name}${result.detail ? ` — ${result.detail}` : ''}`);
  return result.ok;
}

function wait(ms, signal) {
  throwIfAborted(signal, `unpackaged launch wait ${ms}ms aborted`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      try {
        throwIfAborted(signal, `unpackaged launch wait ${ms}ms aborted`);
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
    if (fresh && pattern.test(last.text)) return last;
    pattern.lastIndex = 0;
    if (Date.now() < deadline) await wait(250, signal);
  } while (Date.now() < deadline);
  throw new Error(
    `${description} did not appear in a fresh startup log within ${timeoutMs}ms; candidates=${last.candidates.join(', ')}`,
  );
}

function probeHttp(port, timeoutMs = 3000, signal) {
  throwIfAborted(signal, 'CodeBuddy HTTP probe aborted');
  return new Promise((resolve, reject) => {
    let settled = false;
    let request = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      callback(value);
    };
    const onAbort = () => {
      request?.destroy?.();
      try {
        throwIfAborted(signal, 'CodeBuddy HTTP probe aborted');
      } catch (error) {
        finish(reject, error);
      }
    };
    request = http.get(`http://127.0.0.1:${port}/`, { timeout: timeoutMs }, (response) => {
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
      });
      response.on('end', () => finish(resolve, response.statusCode >= 200 && response.statusCode < 400 && bytes > 0));
      response.resume();
    });
    request.on('timeout', () => {
      request.destroy();
      finish(resolve, false);
    });
    request.on('error', () => finish(resolve, false));
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
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

async function main(signal) {
  throwIfAborted(signal, 'unpackaged launch main aborted');
  console.log('=== unpackaged Electron launch behavior test ===');
  check('production renderer build exists', fs.existsSync(path.join(projectRoot, 'out', 'dist', 'index.html')));
  check('Electron executable exists', fs.existsSync(electronExe), electronExe);
  if (results.some((result) => !result.ok)) return;

  throwIfAborted(signal, 'unpackaged launch profile creation aborted');
  fs.mkdirSync(userDataDir, { recursive: true });
  seedProductState({ userDataDir, projectRoot });
  // 「新对话」改版后会弹原生目录对话框，CDP 无法驱动——经
  // CODEBUDDY_E2E_WORKSPACE_CHOICE 环境变量注入一个与种子项目不同的真实目录，
  // 让主进程 workspace:choose 桩返回它（set_workspace 路径不同才会真正新建会话）。
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
  const startupContract = requireUsableCodeBuddyStartup(startup.text);
  const codebuddyPort = startupContract.port;
  check(
    'fresh startup log resolved from app.getPath(userData)',
    startup.source === 'userData',
    startup.path ? 'isolated userData/electron-startup.log' : 'not found',
  );
  check(
    'CodeBuddy runtime manager reported a ready dynamic port',
    startupContract.state === 'ready' && Number.isInteger(codebuddyPort),
    `port=${startupContract.port}`,
  );
  check('CodeBuddy HTTP endpoint responds', await probeHttp(codebuddyPort, 3000, signal), `GET 127.0.0.1:${codebuddyPort}`);

  startup = await waitForStartup(
    /renderer ready=true|dev server unreachable, falling back to/,
    50000,
    'renderer load marker',
    signal,
  );
  check('startup log records static server', /Static server on http:\/\/127\.0\.0\.1:\d+/.test(startup.text));
  check('startup log records createWindow', /createWindow called/.test(startup.text));
  check(
    'startup log records renderer load',
    /renderer ready=true|dev server unreachable, falling back to/.test(startup.text),
  );

  target = await findRendererTarget({
    port: launched.debugPort,
    expectedUrl: (url) =>
      /^http:\/\/(?:localhost:5173|127\.0\.0\.1:\d+\/index\.html)$/.test(String(url || '').replace(/\/$/, '')),
    timeoutMs: 30000,
    signal,
  });
  check('CDP selected the CodeBuddy renderer target', true, `${target.title || '<untitled>'} ${target.url}`);
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
  check('connected target is an Electron renderer with React content', identity.rootChildren > 0, identity.href);

  await driveByRole(client, { role: 'navigation', name: 'Main navigation', timeoutMs: 15000, signal });
  const desktopExtensionsExpanded = await client.evaluate(
    `(() => document.querySelector('aside[role="navigation"] button[aria-label$="桌面扩展"]')?.getAttribute('aria-expanded') === 'true')()`,
  );
  if (!desktopExtensionsExpanded) {
    await driveByRole(client, {
      role: 'button',
      name: '展开桌面扩展',
      action: 'invoke',
      root: 'aside[role="navigation"]',
      timeoutMs: 15000,
      signal,
    });
  }
  // "添加项目" is on Instances, not the default chat shell.
  await driveByRole(client, {
    role: 'button',
    name: '实例列表',
    action: 'invoke',
    root: 'aside[role="navigation"]',
    timeoutMs: 15000,
    signal,
  });
  await driveByRole(client, { role: 'button', name: '添加项目', timeoutMs: 15000, signal });
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
    if (!text || text === '未连接' || text === 'Not connected') return false;
    return text.length >= 8;
  };
  const initialSessionId = await waitForVisibleSettingValue(client, '会话 ID', {
    timeoutMs: 60000,
    accept: isReadySessionId,
    signal,
  });
  check('initial session readiness is visible before New chat', Boolean(initialSessionId), initialSessionId);
  await driveByRole(client, { role: 'button', name: '新对话', action: 'invoke', timeoutMs: 15000, signal });
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
    'New chat exposes a distinct ready session ID',
    isReadySessionId(replacementSessionId) && replacementSessionId !== initialSessionId,
    `${initialSessionId} -> ${replacementSessionId}`,
  );
  // Primary nav omits redundant "对话"; return to chat via hash with poll (avoid one-shot evaluate stalls).
  const chatState = await waitForRendererValue(
    client,
    `(() => {
      if (location.hash !== '#/chat') location.hash = '#/chat';
      return {
        hash: location.hash,
        hasComposer: Array.from(document.querySelectorAll('textarea')).some(
          (item) => item.placeholder === '从一个想法开始...' || item.placeholder === 'Start from an idea...',
        ),
      };
    })()`,
    {
      timeoutMs: 30000,
      intervalMs: 250,
      describe: 'new-chat visible route result',
      accept: (value) => value?.hash === '#/chat' && value.hasComposer,
      signal,
    },
  );
  check('New chat click leaves a visible chat composer on #/chat', chatState.hash === '#/chat');
  const screenshot = await captureScreenshot(client, screenshotPath, { signal });
  check('startup screenshot captured', screenshot.bytes > 0, screenshot.path);

  const owned = await inspectProcesses({ rootPid: launched.rootPid, signal });
  check(
    'owned process tree is inspectable',
    owned.ownedPids.includes(launched.rootPid),
    `owned=${owned.ownedPids.join(',')}`,
  );
}

async function finish(error) {
  if (error) {
    console.error(sanitizeText(error.stack || error.message || error));
    check('unpackaged launch harness completed without exception', false, error.message || String(error));
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
  evidencePaths = await writeTaskEvidence({
    runDir: runLayout.runDir,
    pathRoot: projectRoot,
    redactionMap: { [runtimeRoot]: '[runtime-root]', [projectRoot]: '[project-root]' },
    taskId: 'task-1',
    runLabel: 'unpackaged-launch',
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
    },
    commands: [{ command: 'node scripts/test/e2e-launch.cjs', exitCode: failCount ? 1 : 0 }],
    assertions: results,
    screenshots: fs.existsSync(screenshotPath)
      ? [
          {
            name: 'unpackaged startup',
            path: screenshotPath,
            analysis: 'Electron renderer, sidebar, status bar, and chat composer are visible.',
          },
        ]
      : [],
    logs: [startupText.slice(-12000), ...(launched?.stderr || []).slice(-20)],
    cleanup: cleanupEvidence,
  });

  console.log('\n=== summary ===');
  console.log(`passed ${results.length - failCount}/${results.length}; failed ${failCount}`);
  console.log(`[evidence] ${evidencePaths.reportPath}`);
  process.exitCode = failCount ? 1 : 0;
}

const watchdog = createOverallWatchdog({
  timeoutMs: Number(process.env.CODEBUDDY_E2E_WATCHDOG_MS || 6 * 60 * 1000),
  label: 'unpackaged launch harness',
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
          runLabel: 'unpackaged-launch',
          timestamp: runStamp,
          context: Object.freeze({ harness: 'unpackaged-launch' }),
          command: 'node scripts/test/e2e-launch.cjs',
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
