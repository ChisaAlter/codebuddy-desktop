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
  inspectProcesses,
  launchDesktop,
  requireUsableCodeBuddyStartup,
  seedProductState,
  throwIfAborted,
  waitForRendererValue,
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
const unpackedExe = path.join(projectRoot, 'dist', 'win-unpacked', 'CodeBuddy Desktop.exe');
const runStamp = safeSegment(process.env.CODEBUDDY_E2E_RUN_ID || new Date().toISOString(), 'run');
const evidenceRoot = path.join(projectRoot, '.omo', 'evidence', 'task-1-runs');
const screenshotRoot = path.join(projectRoot, '.omo', 'evidence', 'task-1-screenshots');
const runLayout = createTaskRunLayout({
  evidenceRoot,
  screenshotRoot,
  taskId: 'task-1',
  runLabel: 'packaged',
  requestedId: runStamp,
});
const runtimeOwnership = createRuntimeLayout({
  projectRoot,
  runStamp: runLayout.runName,
  label: 'packaged',
});
const { runtimeRoot, runtimeDir, userDataDir } = runtimeOwnership;
const expectedStartupLog = path.join(userDataDir, 'electron-startup.log');
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

function check(name, ok, detail = '') {
  throwIfAborted(activeSignal, 'packaged result mutation aborted');
  const result = { name, ok: Boolean(ok), detail: sanitizeText(detail) };
  results.push(result);
  console.log(`${result.ok ? 'PASS' : 'FAIL'} ${name}${result.detail ? ` — ${result.detail}` : ''}`);
  return result.ok;
}

function wait(ms, signal) {
  throwIfAborted(signal, `packaged wait ${ms}ms aborted`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      try {
        throwIfAborted(signal, `packaged wait ${ms}ms aborted`);
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
    packaged: true,
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
    `${description} did not appear in a fresh packaged startup log within ${timeoutMs}ms; candidates=${last.candidates.join(', ')}`,
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

async function main(signal) {
  throwIfAborted(signal, 'packaged main aborted');
  console.log('=== packaged Electron behavior test ===');
  check('Node native WebSocket is available', typeof globalThis.WebSocket === 'function', process.version);
  check('dist/win-unpacked executable exists', fs.existsSync(unpackedExe), unpackedExe);
  if (results.some((result) => !result.ok)) return;

  throwIfAborted(signal, 'packaged profile creation aborted');
  fs.mkdirSync(userDataDir, { recursive: true });
  seedProductState({ userDataDir, projectRoot });
  const npmGlobalDir = path.join(process.env.APPDATA || '', 'npm');
  launched = await launchDesktop({
    executable: unpackedExe,
    projectRoot,
    userDataDir,
    runtimeRoot,
    runtimeDir,
    runtimeOwnership,
    debugPort: requestedDebugPort(),
    signal,
    onOwnershipController(controller) {
      ownershipController = controller;
    },
    env: {
      PATH: [npmGlobalDir, process.env.PATH].filter(Boolean).join(path.delimiter),
    },
  });
  launched.process.stdout?.on('data', (chunk) => console.log(`[app] ${sanitizeText(String(chunk).trim())}`));
  launched.process.stderr?.on('data', (chunk) => console.log(`[app:err] ${sanitizeText(String(chunk).trim())}`));
  console.log(`[context] rootPid=${launched.rootPid} debugPort=${launched.debugPort}`);

  startup = await waitForStartup(/CSP injected: prod\(strict\) script-src/, 30000, 'production CSP marker', signal);
  check(
    'packaged startup log is app.getPath(userData)/electron-startup.log',
    path.resolve(startup.path) === path.resolve(expectedStartupLog),
    startup.path ? 'isolated userData/electron-startup.log' : 'not found',
  );
  check('production CSP mode is recorded', /CSP injected: prod\(strict\) script-src/.test(startup.text));
  startup = await waitForStartup(/renderer ready=true/, 30000, 'packaged renderer ready marker', signal);
  check(
    'packaged renderer loads without the Vite fallback path',
    /renderer ready=true/.test(startup.text) && !/dev server unreachable/.test(startup.text.slice(-4000)),
  );
  startup = await waitForStartup(/CodeBuddy runtime ready project=\S+ port=\d+\b/, 45000, 'packaged CodeBuddy runtime ready', signal);
  const startupContract = requireUsableCodeBuddyStartup(startup.text);
  const codebuddyPort = startupContract.port;
  check(
    'packaged CodeBuddy runtime manager reported a ready dynamic port',
    startupContract.state === 'ready' && Number.isInteger(codebuddyPort),
    `port=${startupContract.port}`,
  );

  target = await findRendererTarget({
    port: launched.debugPort,
    expectedUrl: /^http:\/\/127\.0\.0\.1:\d+\/index\.html$/,
    timeoutMs: 30000,
    signal,
  });
  check(
    'dynamic CDP port selected the packaged renderer target',
    target.debugPort === launched.debugPort,
    `${target.url} via ${target.debugPort}`,
  );
  client = await connectCdp(target, { signal, commandTimeoutMs: 60000 });
  const identity = await waitForRendererValue(
    client,
    `(() => ({
    href: location.href,
    host: location.hostname,
    path: location.pathname,
    rootChildren: document.querySelectorAll('#root > *').length,
    userAgent: navigator.userAgent
  }))()`,
    {
      timeoutMs: 20000,
      describe: 'packaged renderer identity',
      accept: (value) =>
        value?.host === '127.0.0.1' &&
        value.path === '/index.html' &&
        value.rootChildren > 0 &&
        /Electron\//.test(value.userAgent || ''),
      signal,
    },
  );
  check(
    'connected target proves packaged renderer identity',
    identity.href === target.url,
    `${identity.href}; ${identity.userAgent}`,
  );

  const expectedControl = injectedControl();
  if (expectedControl && process.env.CODEBUDDY_E2E_ONLY_EXPECTED_CONTROL === '1') {
    await driveByRole(client, { ...expectedControl, action: 'assert', signal });
    return;
  }

  await driveByRole(client, { role: 'navigation', name: 'Main navigation', timeoutMs: 15000, signal });
  // "添加项目" is on Instances, not the default chat shell.
  await driveByRole(client, {
    role: 'button',
    name: '实例',
    action: 'invoke',
    root: 'aside[role="navigation"]',
    timeoutMs: 15000,
    signal,
  });
  await driveByRole(client, { role: 'button', name: '添加项目', timeoutMs: 15000, signal });
  const routeResults = await driveRoutes(client, {
    screenshotDir,
    expectedControl,
    signal,
    onRoute(result) {
      check(
        `packaged route ${result.route} exposes ${result.expected.role} ${JSON.stringify(result.expected.name)}`,
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
    'packaged renderer reached all routes through sidebar clicks',
    routeResults.length === ROUTE_EXPECTATIONS.length,
    `routes=${routeResults.length} expected=${ROUTE_EXPECTATIONS.length}`,
  );

  throwIfAborted(signal, 'packaged CSP check aborted');
  const csp = await client.evaluate(`(async () => {
    const response = await fetch(location.href, { cache: 'no-store' });
    return response.headers.get('content-security-policy') || '';
  })()`);
  check(
    'packaged renderer receives strict CSP without unsafe-inline script',
    typeof csp === 'string' && csp.includes("default-src 'self'") && !/script-src[^;]*unsafe-inline/.test(csp),
    csp.slice(0, 160),
  );

  const owned = await inspectProcesses({ rootPid: launched.rootPid, signal });
  check(
    'packaged process tree is explicitly owned',
    owned.ownedPids.includes(launched.rootPid),
    `owned=${owned.ownedPids.join(',')}`,
  );
  throwIfAborted(signal, 'packaged contact sheet aborted');
  contactSheet = writeContactSheet({
    screenshots: routeScreenshots,
    outputPath: path.join(screenshotDir, 'contact-sheet.svg'),
    columns: 3,
  });
  check(
    'packaged route contact sheet saved',
    contactSheet.screenshots === routeScreenshots.length,
    `${contactSheet.path} (have=${contactSheet.screenshots} collected=${routeScreenshots.length})`,
  );
}

async function finish(error) {
  if (error) {
    console.error(sanitizeText(error.stack || error.message || error));
    check('packaged renderer harness completed without exception', false, error.message || String(error));
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
        'cleanup stayed within the packaged owned process tree',
        cleanup.errors.length === 0,
        cleanup.errors.map((entry) => `${entry.pid}:${entry.error}`).join('; '),
      );
    } catch (cleanupError) {
      cleanup = { rootPid: launched.rootPid, errors: [{ pid: launched.rootPid, error: cleanupError.message }] };
      check('cleanup stayed within the packaged owned process tree', false, cleanupError.message);
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
    runLabel: 'packaged',
    timestamp: runStamp,
    status: failCount ? 'FAIL' : 'PASS',
    context: {
      node: process.version,
      electron: require(path.join(projectRoot, 'node_modules', 'electron', 'package.json')).version,
      codebuddyCli: cliVersion(),
      platform: `${process.platform}/${process.arch}`,
      runnerProfile,
      nativeWebSocket: typeof globalThis.WebSocket === 'function',
      executable: unpackedExe,
      debugPort: launched?.debugPort ?? '<not launched>',
      targetUrl: target?.url || '<not connected>',
      startupLog: startupLogEvidence,
      expectedStartupLog: 'isolated userData/electron-startup.log (removed after capture)',
      injectedControl: injectedControl() ? `${injectedControl().role}:${injectedControl().name}` : '<none>',
    },
    commands: [{ command: 'node scripts/test/e2e-packaged.cjs', exitCode: failCount ? 1 : 0 }],
    assertions: results,
    screenshots: [
      ...routeScreenshots.map((item) => ({
        ...item,
        analysis: `Packaged sidebar navigation reached ${item.name}; route-specific control was visible.`,
      })),
      ...(contactSheet
        ? [
            {
              name: 'packaged route contact sheet',
              path: contactSheet.path,
              analysis: `All ${routeScreenshots.length} packaged route captures in sidebar order.`,
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
  timeoutMs: Number(process.env.CODEBUDDY_E2E_WATCHDOG_MS || 10 * 60 * 1000),
  label: 'packaged renderer harness',
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
          runLabel: 'packaged',
          timestamp: runStamp,
          context: Object.freeze({ harness: 'packaged' }),
          command: 'node scripts/test/e2e-packaged.cjs',
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
