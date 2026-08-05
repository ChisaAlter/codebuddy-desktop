#!/usr/bin/env node
'use strict';

/**
 * Production performance gates — real packaged Electron window.
 *
 * Launches the packaged desktop app (dist/win-unpacked) seeded with the
 * 300-entry transcript fixture and measures, through CDP:
 *
 *  - first-interactive of the 300-entry chat (boot hydrate + 5 stream-replay
 *    load samples through the REAL reducer path);
 *  - per-key typing latency with REAL Input.dispatchKeyEvent key events on an
 *    empty transcript, on the 300-entry transcript, and while a chunk stream
 *    is being appended via appendThreadTimelineEvent (no patchThreadRuntime
 *    timeline rebuilds — the old synthetic flood is gone);
 *  - long-task budget inside the 10s typing/streaming window;
 *  - keep-alive route-return latency (terminal/editor/settings → chat);
 *  - draft debounce, keep-alive draft survival, terminal output batching,
 *    keydown handler storage reads;
 *  - chunk flood does not rebuild threadsById, unrelated thread runtimes or
 *    hidden keep-alive views.
 *
 * Evidence: out/perf-report.json (full envelope) + screenshots under
 * gui-test-screenshots/perf-<stamp>/.
 *
 * Usage:
 *   npm run build:dir
 *   node scripts/test/manual-perf-gui.cjs --packaged
 */

const fs = require('node:fs');
const path = require('node:path');
const fixtures = require('./perf-fixtures.cjs');
const reportLib = require('./perf-report.cjs');
const {
  cleanupOwned,
  cleanupRuntimeDir,
  connectCdp,
  createRuntimeLayout,
  findRendererTarget,
  launchDesktop,
  seedProductState,
  waitForRendererValue,
} = require('./e2e-driver.cjs');

const projectRoot = path.resolve(__dirname, '..', '..');
const packagedExe = path.join(projectRoot, 'dist', 'win-unpacked', 'CodeBuddy Desktop.exe');
const screenshotDir = path.join(projectRoot, 'gui-test-screenshots');
const runStamp = `perf-${Date.now()}`;
let runtimeOwnership = createRuntimeLayout({ projectRoot, runStamp, label: 'perf' });
let { runtimeRoot, runtimeDir, userDataDir } = runtimeOwnership;
const results = [];
const failures = [];
const sampleControllers = [];
let ownershipController = null;

// Fixed gate thresholds (plan §3.1). Never relaxed to mask a regression; a
// real failure is reported and the plan mandates a product fix (or a separate
// documented baseline change), not a threshold bump.
const THRESHOLDS = {
  emptyTypingP95Ms: 35,
  emptyTypingMaxMs: 100,
  transcriptTypingP95Ms: 50,
  streamingTypingP95Ms: 50,
  firstInteractiveMedianMs: 1500,
  routeReturnP95Ms: 150,
  longTaskOver100MsMax: 0,
  longTaskOver50MsMax: 2,
};

const EMPTY_THREAD_ID = 'thread-e2e';
const FIXTURE_THREAD_ID = 'thread-fixture';
const TYPE_CHARS = 'abcdefghijklmnopqrstuvwxyz'; // per-key latency samples
const MEASURED_KEYS = 25;
const WARMUP_KEYS = 5;

function check(name, ok, detail = '') {
  const result = { name, ok: Boolean(ok), detail: String(detail || '') };
  results.push(result);
  console.log(`${result.ok ? 'PASS' : 'FAIL'} ${name}${result.detail ? ` — ${result.detail}` : ''}`);
  return result.ok;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function capture(client, name) {
  fs.mkdirSync(path.join(screenshotDir, runStamp), { recursive: true });
  const file = path.join(screenshotDir, runStamp, `${name}.png`);
  try {
    const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`SHOT ${file}`);
    return file;
  } catch (error) {
    console.warn(`capture failed ${name}:`, error?.message || error);
    return null;
  }
}

/** Record failure evidence: screenshot + route/DOM diagnostics. */
async function recordFailure(client, label, detail) {
  const evidence = { label, detail: String(detail || ''), at: new Date().toISOString() };
  const shot = await capture(client, `perf-fail-${results.filter((r) => !r.ok).length}-${label}`);
  if (shot) evidence.screenshot = shot;
  try {
    evidence.diagnostics = await client.evaluate(`(() => {
      const api = window.__CODEBUDDY_STORE__;
      const state = api?.getState ? api.getState() : null;
      return {
        route: state?.route || null,
        activeThreadId: state?.activeThreadId || null,
        timelineEntries: state?.threadRuntimeById?.[state?.activeThreadId]?.timeline?.length ?? null,
        textareaValueLength: document.querySelector('textarea')?.value?.length ?? null,
        domNodes: document.querySelectorAll('*').length,
        bodyTextLength: document.body.innerText.length,
      };
    })()`);
  } catch (error) {
    evidence.diagnosticsError = String(error?.message || error);
  }
  failures.push(evidence);
}

// ─────────────────────────── measurement helpers ───────────────────────────

/** Expression that waits until the fixture chat is interactive. */
function chatMarkerExpr(lastEntryPrefix) {
  return `(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return false;
    return document.body.innerText.includes(${JSON.stringify(lastEntryPrefix)});
  })()`;
}

const EMPTY_CHAT_MARKER = `(() => {
  const ta = document.querySelector('textarea');
  const state = window.__CODEBUDDY_STORE__?.getState?.();
  return Boolean(ta) && state?.activeThreadId === '${EMPTY_THREAD_ID}';
})()`;

/** Wait for the fixture chat to render the LAST transcript entry (real marker). */
async function waitForChatInteractive(client, lastEntryPrefix, timeoutMs = 120000, intervalMs = 40) {
  return waitForRendererValue(client, chatMarkerExpr(lastEntryPrefix), {
    timeoutMs,
    // 40ms poll: the marker wait is INSIDE route-return latency measurements,
    // so a coarse poll interval would add up to one full interval of noise to
    // the p95 (120ms previously made the terminal-return gate flaky).
    intervalMs,
    describe: 'fixture chat interactive',
    accept: (value) => value === true,
  });
}

/** Switch threads through the real product path (activateThread). */
async function activateThread(client, threadId) {
  return client.evaluate(
    `window.__CODEBUDDY_STORE__.getState().activateThread(${JSON.stringify(threadId)}).then(() => true).catch(() => false)`,
  );
}

/** Focus the composer textarea (real user precondition for typing). */
async function focusComposer(client) {
  return client.evaluate(`(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return false;
    ta.focus();
    return document.activeElement === ta;
  })()`);
}

const charSpec = (ch) => {
  const upper = ch.toUpperCase();
  return {
    key: ch,
    code: `Key${upper}`,
    windowsVirtualKeyCode: upper.charCodeAt(0),
    nativeVirtualKeyCode: upper.charCodeAt(0),
  };
};

/** Dispatch ONE real keystroke (rawKeyDown + char + keyUp, no modifiers). */
async function dispatchKey(client, ch) {
  const spec = charSpec(ch);
  await client.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
    nativeVirtualKeyCode: spec.nativeVirtualKeyCode,
    modifiers: 0,
  });
  // Text insertion happens on the char event (rawKeyDown with text alone does
  // not type into the focused editable in Chromium).
  await client.send('Input.dispatchKeyEvent', {
    type: 'char',
    key: spec.key,
    code: spec.code,
    text: ch,
    unmodifiedText: ch,
    windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
    nativeVirtualKeyCode: spec.nativeVirtualKeyCode,
    modifiers: 0,
  });
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
    nativeVirtualKeyCode: spec.nativeVirtualKeyCode,
    modifiers: 0,
  });
}

/**
 * Measure one keystroke end-to-end: in-page mark → real CDP key events
 * (batched fire-and-forget) → one animation frame (React commit visible) →
 * elapsed. `mark` is either a numeric performance.now() captured by the
 * PREVIOUS read, or an in-page expression evaluated at read time — the read
 * evaluate's own latency stays outside the window either way.
 */
async function measureKey(client, ch, mark) {
  const spec = charSpec(ch);
  const params = (type, extra = {}) => ({
    type,
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
    nativeVirtualKeyCode: spec.nativeVirtualKeyCode,
    modifiers: 0,
    ...extra,
  });
  await Promise.all([
    client.send('Input.dispatchKeyEvent', params('rawKeyDown')),
    client.send('Input.dispatchKeyEvent', params('char', { text: ch, unmodifiedText: ch })),
    client.send('Input.dispatchKeyEvent', params('keyUp')),
  ]);
  const markExpr = typeof mark === 'number' ? `${Number(mark)}` : `(${mark})`;
  return client.evaluate(`(async () => {
    await new Promise((r) => requestAnimationFrame(r));
    const elapsed = performance.now() - ${markExpr};
    const nextMark = performance.now();
    return { elapsed, nextMark };
  })()`);
}

/** Warmup + measured keystrokes; returns { samples, inserted } (raw ms). */
async function typeBurst(client, { warmup = WARMUP_KEYS, measured = MEASURED_KEYS, prefix = '' }) {
  // Total keystrokes dispatched = prefix + warmup + measured; the loops index
  // sequence[0 .. warmup+measured-1], so the expected text is the dispatched
  // slice, not the full sequence (the tail letters beyond measured are never
  // typed).
  const sequence = `${prefix}${TYPE_CHARS.repeat(Math.ceil((warmup + measured) / TYPE_CHARS.length)).slice(0, warmup + measured)}`;
  const before = await client.evaluate(`document.querySelector('textarea')?.value || ''`);
  for (let i = 0; i < warmup; i += 1) await dispatchKey(client, sequence[i]);
  let mark = await client.evaluate(`performance.now()`);
  const samples = [];
  for (let i = 0; i < measured; i += 1) {
    const result = await measureKey(client, sequence[warmup + i], mark);
    samples.push(Number(result.elapsed.toFixed(2)));
    mark = result.nextMark;
  }
  const after = await client.evaluate(`document.querySelector('textarea')?.value || ''`);
  const expected = `${before}${sequence.slice(0, warmup + measured)}`;
  const inserted = after === expected || (after.length > before.length && after.endsWith(sequence.slice(-8)));
  return { samples, inserted, typedLength: warmup + measured, beforeLength: before.length, afterLength: after.length };
}

/** Install a live long-task observer collecting entries on window.__perfLongTasks. */
async function installLongTaskObserver(client) {
  return client.evaluate(`(() => {
    window.__perfLongTasks = [];
    if (typeof PerformanceObserver !== 'function') return false;
    try {
      window.__perfLongTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__perfLongTasks.push({ startTime: entry.startTime, duration: entry.duration });
        }
      });
      window.__perfLongTaskObserver.observe({ type: 'longtask', buffered: false });
      return true;
    } catch (error) {
      return false;
    }
  })()`);
}

async function readLongTasks(client) {
  return client.evaluate(`(() => window.__perfLongTasks || [])()`);
}

/** Route → chat return latency (marker-gated, warmup + measured samples). */
async function measureRouteReturn(client, route, lastEntryPrefix) {
  await client.evaluate(`window.__CODEBUDDY_STORE__.getState().setRoute('chat')`);
  await waitForChatInteractive(client, lastEntryPrefix, 30000);
  await client.evaluate(`window.__CODEBUDDY_STORE__.getState().setRoute(${JSON.stringify(route)})`);
  await waitForRendererValue(client, fixtures.ROUTE_READY_MARKERS[route], {
    timeoutMs: 45000,
    intervalMs: 120,
    describe: `${route} ready`,
    accept: (value) => value === true,
  });
  await client.evaluate(`window.__perfRouteReturnMark = performance.now()`);
  await client.evaluate(`window.__CODEBUDDY_STORE__.getState().setRoute('chat')`);
  await waitForChatInteractive(client, lastEntryPrefix, 30000);
  return client.evaluate(`performance.now() - window.__perfRouteReturnMark`);
}

/** Tag hidden keep-alive view containers so remounts are detectable. */
async function tagKeepAliveViews(client) {
  return client.evaluate(`(() => {
    window.__perfKeepAlive = window.__perfKeepAlive || {};
    let tagged = 0;
    for (const el of document.querySelectorAll('[aria-hidden="true"]')) {
      if (!el.textContent || el.children.length === 0) continue;
      const tag = 'keepalive-' + tagged;
      el.setAttribute('__perfTag', tag);
      window.__perfKeepAlive[tag] = true;
      tagged += 1;
    }
    return tagged;
  })()`);
}

async function verifyKeepAliveViews(client) {
  return client.evaluate(`(() => {
    const tags = window.__perfKeepAlive || {};
    const names = Object.keys(tags);
    const alive = [];
    for (const tag of names) {
      const el = document.querySelector('[__perfTag="' + tag + '"]');
      alive.push({ tag, connected: Boolean(el?.isConnected) });
    }
    return { tagged: names.length, alive };
  })()`);
}

// ───────────────────────────────── main ────────────────────────────────────

/** App shell visible (auth/CLI gate passed) — the transcript load starts here. */
const APP_SHELL_MARKER = `Boolean(document.querySelector('aside[role="navigation"]'))`;

async function main() {
  if (!process.argv.includes('--packaged')) {
    throw new Error('manual-perf-gui.cjs requires --packaged (production gate runs the packaged build)');
  }
  if (!fs.existsSync(packagedExe)) {
    throw new Error(`Packaged Electron binary missing: ${packagedExe}. Run npm run build:dir first.`);
  }

  // ── fixture (deterministic; real reducer hydration) ──
  const fixtureEvents = fixtures.generateTranscriptEvents({ count: 300 });
  const fixtureTimeline = await fixtures.hydrateTranscript(fixtureEvents);
  const fixtureSummary = fixtures.summarizeFixture(fixtureEvents, fixtureTimeline);
  const lastEntry = fixtureTimeline[fixtureTimeline.length - 1];
  const lastEntryPrefix = String(lastEntry?.content || '').slice(0, 60);
  const fixtureHash = fixtures.fixtureHash(fixtureEvents);
  const streamChunks = fixtures.generateStreamChunks({ count: 120 });
  console.log(
    `fixture hash=${fixtureHash.slice(0, 12)} entries=${fixtureSummary.entryCount} ` +
      `markdown=${fixtureSummary.markdownCount} codeBlocks=${fixtureSummary.codeBlockCount} ` +
      `large=${fixtureSummary.largeMessageCount}`,
  );

  // Boot with the 300-entry fixture thread ACTIVE so the first load IS the
  // big-transcript hydrate (plan §3.1 first-interactive gate).
  seedProductState({
    userDataDir,
    projectRoot,
    activeThreadId: FIXTURE_THREAD_ID,
    timeline: fixtureTimeline,
    modelId: 'perf-model',
  });

  const meta = reportLib.collectMeta({ projectRoot });
  const samples = {};

  let launched = null;
  let client = null;
  try {
    // ── A. 300-entry chat first-interactive: 1 warmup + 5 formal samples, each
    // a REAL app launch with the fixture seeded (plan §3.1/Phase B: hydrate +
    // first load through seedProductState). The measured window starts after
    // CDP connect and ends when the composer is interactive AND the last
    // transcript entry has rendered (route-ready marker, no fixed sleeps).
    const firstInteractiveSamples = [];
    const bootToShellSamples = [];
    let bootLaunch = true;
    let consecutiveInvalidSamples = 0;
    for (let sample = 0; sample < 6; sample += 1) {
      // Each sample gets a FRESH runtime layout + user data dir: the Windows
      // Job harness derives the Job name from the runtime dir, so reusing one
      // layout across relaunches collides with the previous run's Job state.
      // A failed launch attempt may clean up its own layout, so retries build
      // a brand-new one.
      let sampleOwnership = createRuntimeLayout({ projectRoot, runStamp: `perf-${Date.now()}-s${sample}`, label: 'perf' });
      let sampleLaunched = null;
      for (let attempt = 1; attempt <= 3 && !sampleLaunched; attempt += 1) {
        seedProductState({
          userDataDir: sampleOwnership.userDataDir,
          projectRoot,
          activeThreadId: FIXTURE_THREAD_ID,
          timeline: fixtureTimeline,
          modelId: 'perf-model',
        });
        try {
          sampleLaunched = await launchDesktop({
            executable: packagedExe,
            projectRoot,
            userDataDir: sampleOwnership.userDataDir,
            runtimeRoot: sampleOwnership.runtimeRoot,
            runtimeDir: sampleOwnership.runtimeDir,
            runtimeOwnership: sampleOwnership,
            onOwnershipController(controller) {
              // Samples 0-4 close their own controller in the loop; the LAST
              // sample's launch continues into the interactive scenarios, so
              // its controller is owned by the shared finally-block cleanup.
              if (sample === 5) ownershipController = controller;
              else sampleControllers.push(controller);
            },
            env: {
              CODEBUDDY_E2E: '1',
              ELECTRON_ENABLE_LOGGING: '1',
            },
          });
        } catch (error) {
          console.warn(`sample ${sample} launch attempt ${attempt} failed: ${error?.message || error}`);
          if (attempt === 3) throw error;
          sampleOwnership = createRuntimeLayout({ projectRoot, runStamp: `perf-${Date.now()}-s${sample}-a${attempt}`, label: 'perf' });
          await wait(3000);
        }
      }
      launched = sampleLaunched;
      console.log(`launched packaged pid=${launched.rootPid || launched.pid} cdp=${launched.debugPort}`);
      launched.process?.stderr?.on('data', (chunk) => console.log(`[electron:err] ${String(chunk).trim()}`));

      const target = await findRendererTarget({
        port: launched.debugPort,
        expectedUrl: (url) => /^http:\/\/127\.0\.0\.1:\d+\/index\.html$/.test(String(url || '')),
        timeoutMs: 90000,
      });
      console.log(`packaged renderer target: ${target.url}`);
      client = await connectCdp(target, { commandTimeoutMs: 60000, connectTimeoutMs: 30000 });

      if (bootLaunch) {
        const identity = await waitForRendererValue(
          client,
          `(() => ({ href: location.href, path: location.pathname, userAgent: navigator.userAgent, root: document.querySelectorAll('#root > *').length }))()`,
          {
            timeoutMs: 30000,
            describe: 'packaged renderer identity',
            accept: (value) =>
              /^http:\/\/127\.0\.0\.1:\d+\/index\.html$/.test(value?.href || '') &&
              value?.path === '/index.html' &&
              value.root > 0 &&
              /Electron\//.test(value.userAgent || ''),
          },
        );
        check('packaged renderer identity', Boolean(identity?.root), JSON.stringify(identity));
        const longTaskObserverOk = await installLongTaskObserver(client);
        check('long-task observer installed', longTaskObserverOk === true);
      }

      // First-interactive window: app shell visible (auth/CLI gate passed,
      // recorded separately as boot latency) → chat interactive. This isolates
      // the transcript+UI render cost from the CLI/auth startup which is
      // identical regardless of transcript size. Marks are read NaN-safely:
      // if the page reloaded mid-sample (singleton/relaunch weirdness), the
      // read returns -1 and the sample is retried instead of corrupting the
      // median with a bogus value.
      await client.evaluate(`window.__perfBootMark = performance.now()`);
      await waitForRendererValue(client, APP_SHELL_MARKER, {
        timeoutMs: 60000,
        describe: `app shell visible (sample ${sample})`,
        accept: (value) => value === true,
      });
      const bootToShell = await client.evaluate(`(() => {
        const mark = window.__perfBootMark;
        return typeof mark === 'number' ? performance.now() - mark : -1;
      })()`);
      bootToShellSamples.push(Number(bootToShell.toFixed(2)));
      await client.evaluate(`window.__perfFirstLoadMark = performance.now()`);
      await waitForChatInteractive(client, lastEntryPrefix, 60000);
      const elapsed = await client.evaluate(`(() => {
        const mark = window.__perfFirstLoadMark;
        return typeof mark === 'number' ? performance.now() - mark : -1;
      })()`);
      firstInteractiveSamples.push(Number(elapsed.toFixed(2)));
      console.log(`first-load sample ${sample}: ${elapsed.toFixed(1)}ms (bootToShell=${bootToShell.toFixed(1)}ms)`);

      if (elapsed < 0 || bootToShell < 0) {
        // Page reloaded mid-sample (singleton/relaunch weirdness) — the marks
        // were wiped. Close this launch and redo the sample so the median is
        // never built from bogus values.
        consecutiveInvalidSamples += 1;
        if (consecutiveInvalidSamples > 3) {
          throw new Error('too many invalid first-load samples (page reload loop)');
        }
        console.warn(`sample ${sample} invalid (page reload mid-measurement), retrying`);
        try { await client.close(); } catch (_) {}
        const badController = sampleControllers[sampleControllers.length - 1];
        if (badController) {
          try { await badController.close(); } catch (error) {
            console.warn('invalid sample cleanup failed:', error?.message || error);
          }
        }
        sampleControllers.pop();
        firstInteractiveSamples.pop();
        bootToShellSamples.pop();
        client = null;
        launched = null;
        sample -= 1;
        continue;
      }
      consecutiveInvalidSamples = 0;

      if (sample < 5) {
        // Close this launch cleanly before the next sample.
        try { await client.close(); } catch (_) {}
        const controller = sampleControllers[sampleControllers.length - 1];
        if (controller) {
          try { await controller.close(); } catch (error) {
            console.warn('sample launch cleanup failed:', error?.message || error);
          }
        }
        try {
          await cleanupRuntimeDir({
            runtimeOwnership: sampleOwnership,
            runtimeRoot: sampleOwnership.runtimeRoot,
            runtimeDir: sampleOwnership.runtimeDir,
            // AV / process-teardown file locks can outlive the Job close by
            // seconds — retry longer than the harness default before giving up.
            renameRetries: 60,
            renameRetryDelayMs: 250,
          });
        } catch (error) {
          console.warn('sample runtime dir cleanup failed:', error?.message || error);
        }
        client = null;
        launched = null;
        await wait(2000);
      } else {
        // The final launch continues into the interactive scenarios; hand its
        // ownership to the shared cleanup path.
        runtimeOwnership = sampleOwnership;
        runtimeRoot = sampleOwnership.runtimeRoot;
        runtimeDir = sampleOwnership.runtimeDir;
        userDataDir = sampleOwnership.userDataDir;
      }
      bootLaunch = false;
    }
    samples.chatFirstInteractiveMs = firstInteractiveSamples;
    samples.bootToShellMs = bootToShellSamples;
    const firstInteractiveMedian = reportLib.median(firstInteractiveSamples);
    check(
      '300-entry chat first-interactive median <= 1.5s',
      firstInteractiveMedian <= THRESHOLDS.firstInteractiveMedianMs,
      `median=${firstInteractiveMedian.toFixed(1)}ms samples=${firstInteractiveSamples.map((v) => v.toFixed(0)).join(',')}ms`,
    );
    await capture(client, 'perf-01-fixture-loaded');

    // ── B. empty-transcript typing latency (real key events) ──
    await activateThread(client, EMPTY_THREAD_ID);
    await waitForRendererValue(client, EMPTY_CHAT_MARKER, {
      timeoutMs: 30000,
      describe: 'empty thread active',
      accept: (value) => value === true,
    });
    await focusComposer(client);
    // Spy localStorage.getItem while REAL rawKeyDown events are dispatched —
    // the keydown hot path must not touch storage per keystroke.
    await client.evaluate(`(() => {
      if (window.__perfStorageSpyInstalled) return;
      window.__perfStorageOriginal = localStorage.getItem;
      window.__perfStorageReads = 0;
      localStorage.getItem = function (...args) {
        window.__perfStorageReads += 1;
        return window.__perfStorageOriginal.apply(localStorage, args);
      };
      window.__perfStorageSpyInstalled = true;
    })()`);
    for (let i = 0; i < 10; i += 1) {
      const spec = charSpec(TYPE_CHARS[i]);
      await client.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: spec.key, code: spec.code,
        windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
        nativeVirtualKeyCode: spec.nativeVirtualKeyCode, modifiers: 0,
      });
    }
    const keydownStorageReads = await client.evaluate(`(() => {
      const reads = window.__perfStorageReads || 0;
      localStorage.getItem = window.__perfStorageOriginal;
      window.__perfStorageSpyInstalled = false;
      return reads;
    })()`);
    check('keydown handler does not read localStorage per keystroke (real key events)', keydownStorageReads === 0, `reads=${keydownStorageReads}`);

    const emptyTyping = await typeBurst(client, { prefix: 'empty' });
    samples.emptyTypingPerKeyMs = emptyTyping.samples;
    const emptyTypingP95 = reportLib.p95(emptyTyping.samples);
    const emptyTypingMax = reportLib.maxValue(emptyTyping.samples);
    check('typing insertion verified (empty transcript)', emptyTyping.inserted, JSON.stringify({ before: emptyTyping.beforeLength, after: emptyTyping.afterLength }));
    check(
      'empty-transcript typing p95 <= 35ms',
      emptyTyping.inserted && emptyTypingP95 <= THRESHOLDS.emptyTypingP95Ms,
      `p95=${emptyTypingP95.toFixed(1)}ms`,
    );
    check(
      'empty-transcript typing max <= 100ms',
      emptyTyping.inserted && emptyTypingMax <= THRESHOLDS.emptyTypingMaxMs,
      `max=${emptyTypingMax.toFixed(1)}ms`,
    );
    await capture(client, 'perf-02-empty-typing');

    // ── D/E. typing + streaming typing with the long-task window ──
    // Back to the 300-entry fixture thread (the empty-typing section switched
    // away); wait for the transcript to be interactive before measuring.
    await activateThread(client, FIXTURE_THREAD_ID);
    await waitForChatInteractive(client, lastEntryPrefix, 60000);
    await client.evaluate(`window.__perfLongWindowStart = performance.now()`);
    const transcriptTyping = await typeBurst(client, { prefix: 'transcript' });
    samples.transcriptTypingPerKeyMs = transcriptTyping.samples;
    const transcriptTypingP95 = reportLib.p95(transcriptTyping.samples);
    check('typing insertion verified (300-entry transcript)', transcriptTyping.inserted, JSON.stringify({ before: transcriptTyping.beforeLength, after: transcriptTyping.afterLength }));
    check(
      '300-entry transcript typing p95 <= 50ms',
      transcriptTyping.inserted && transcriptTypingP95 <= THRESHOLDS.transcriptTypingP95Ms,
      `p95=${transcriptTypingP95.toFixed(1)}ms`,
    );

    // Streaming typing: 25 real keys interleaved with 120 real reducer chunks.
    const streamingTyping = await (async () => {
      // Reference-stability probes: the store objects are huge (multi-MB), so
      // NEVER return them by value over CDP (the WebSocket frame kills the
      // connection) — capture refs in-page and compare in-page.
      await client.evaluate(`(() => {
        const s = window.__CODEBUDDY_STORE__.getState();
        window.__perfRefs = {
          threads: s.threadsById,
          otherRuntime: s.threadRuntimeById[${JSON.stringify(EMPTY_THREAD_ID)}],
          panes: s.terminalPanes,
        };
        return true;
      })()`);
      const beforeValue = await client.evaluate(`document.querySelector('textarea')?.value || ''`);
      const tagged = await tagKeepAliveViews(client);
      const perKey = [];
      let chunkIndex = 0;
      for (let i = 0; i < MEASURED_KEYS; i += 1) {
        // Between keys, append real stream chunks in BATCHES (≈5/keystroke,
        // 120 total) — all chunks of a batch go into ONE evaluate (one task,
        // React auto-batches the store updates into one render), mirroring the
        // main-process 33ms IPC batching. The key mark is captured at the END
        // of the batch evaluate — after its render — so chunk-render backlog
        // is never counted as key latency.
        const batch = streamChunks.slice(chunkIndex, chunkIndex + 5);
        chunkIndex += batch.length;
        const calls = batch
          .map((chunk) => {
            const args = JSON.stringify([FIXTURE_THREAD_ID, chunk.eventType, chunk.payload]);
            return `s.appendThreadTimelineEvent(${args.slice(1, -1)})`;
          })
          .join('; ');
        await client.evaluate(`(() => {
          const s = window.__CODEBUDDY_STORE__.getState();
          ${calls};
          window.__perfKeyMark = performance.now();
          return true;
        })()`);
        perKey.push(Number((await measureKey(client, TYPE_CHARS[i % TYPE_CHARS.length], 'window.__perfKeyMark')).elapsed.toFixed(2)));
      }
      const stability = await client.evaluate(`(() => {
        const s = window.__CODEBUDDY_STORE__.getState();
        const refs = window.__perfRefs || {};
        const streamingEntries = (s.threadRuntimeById[${JSON.stringify(FIXTURE_THREAD_ID)}]?.timeline || [])
          .filter((e) => e.streaming).length;
        s.closeAssistantStream();
        return {
          threadsByIdStable: refs.threads === s.threadsById,
          otherThreadRuntimeStable: refs.otherRuntime === s.threadRuntimeById[${JSON.stringify(EMPTY_THREAD_ID)}],
          terminalPanesStable: refs.panes === s.terminalPanes,
          streamingEntries,
          afterValue: document.querySelector('textarea')?.value || '',
        };
      })()`);
      const keepAlive = await verifyKeepAliveViews(client);
      return {
        perKey,
        chunkIndex,
        valueGrew: stability.afterValue.length - beforeValue.length === MEASURED_KEYS,
        threadsByIdStable: stability.threadsByIdStable,
        otherThreadRuntimeStable: stability.otherThreadRuntimeStable,
        terminalPanesStable: stability.terminalPanesStable,
        keepAliveViews: keepAlive,
        streamingEntriesDuring: stability.streamingEntries,
        tagged,
      };
    })();
    samples.streamingTypingPerKeyMs = streamingTyping.perKey;
    const streamingTypingP95 = reportLib.p95(streamingTyping.perKey);
    check('chunk flood appends through the real reducer path', streamingTyping.chunkIndex >= 100, `chunks=${streamingTyping.chunkIndex}`);
    check('chunk flood does not rebuild threadsById', streamingTyping.threadsByIdStable === true, 'threadsById reference stable');
    check('chunk flood does not rebuild unrelated thread runtime', streamingTyping.otherThreadRuntimeStable === true, 'thread-e2e runtime reference stable');
    check('chunk flood does not rebuild terminal panes', streamingTyping.terminalPanesStable === true, 'terminalPanes reference stable');
    check(
      'hidden keep-alive views survive the chunk flood (no remount)',
      streamingTyping.keepAliveViews.alive.every((entry) => entry.connected),
      `tagged=${streamingTyping.keepAliveViews.tagged} alive=${streamingTyping.keepAliveViews.alive.filter((e) => e.connected).length}`,
    );
    check('streaming typing insertion verified (real key events)', streamingTyping.valueGrew === true, `value +${streamingTyping.valueGrew === true ? MEASURED_KEYS : '?'} chars`);
    check(
      'streaming typing p95 <= 50ms',
      streamingTyping.valueGrew && streamingTypingP95 <= THRESHOLDS.streamingTypingP95Ms,
      `p95=${streamingTypingP95.toFixed(1)}ms chunks=${streamingTyping.chunkIndex} streamingEntries=${streamingTyping.streamingEntriesDuring}`,
    );

    // Long-task budget inside the 10s typing/streaming window.
    const longTaskReport = await (async () => {
      await client.evaluate(`window.__perfLongWindowEnd = performance.now()`);
      const end = await client.evaluate(`window.__perfLongWindowEnd`);
      const start = await client.evaluate(`window.__perfLongWindowStart`);
      const pad = Math.max(0, 10000 - (end - start));
      if (pad > 0) await wait(pad + 50);
      const tasks = await readLongTasks(client);
      const windowStart = start;
      const inWindow = tasks.filter((entry) => entry.startTime >= windowStart && entry.startTime < windowStart + 10000);
      return {
        windowMs: Math.round(end - start),
        over100: inWindow.filter((entry) => entry.duration > 100).length,
        over50: inWindow.filter((entry) => entry.duration > 50).length,
        total: inWindow.length,
        maxMs: inWindow.length ? reportLib.maxValue(inWindow.map((entry) => entry.duration)) : 0,
        samples: inWindow,
      };
    })();
    samples.longTasks = longTaskReport.samples;
    check(
      'no long task > 100ms in the 10s typing/streaming window',
      longTaskReport.over100 <= THRESHOLDS.longTaskOver100MsMax,
      JSON.stringify({ over100: longTaskReport.over100, maxMs: longTaskReport.maxMs, total: longTaskReport.total, windowMs: longTaskReport.windowMs }),
    );
    check(
      'at most 2 long tasks > 50ms in the 10s window',
      longTaskReport.over50 <= THRESHOLDS.longTaskOver50MsMax,
      JSON.stringify({ over50: longTaskReport.over50, total: longTaskReport.total }),
    );
    await capture(client, 'perf-04-streaming-typing');

    // ── F. route returns: terminal/editor/settings → chat p95 <= 150ms ──
    const routeReturns = {};
    for (const route of ['terminal', 'editor', 'settings']) {
      // 1 warmup (first mount includes the lazy chunk) + 5 measured samples.
      await measureRouteReturn(client, route, lastEntryPrefix);
      const values = [];
      for (let i = 0; i < 5; i += 1) {
        values.push(await measureRouteReturn(client, route, lastEntryPrefix));
      }
      routeReturns[route] = values;
      const p = reportLib.p95(values);
      check(
        `return to chat from ${route} p95 <= 150ms`,
        p <= THRESHOLDS.routeReturnP95Ms,
        `p95=${p.toFixed(1)}ms samples=${values.map((v) => v.toFixed(0)).join(',')}ms`,
      );
    }
    samples.routeReturns = routeReturns;

    // ── G. draft debounce (1500ms window) ──
    // Clear the STORE draft AND the composer's local text with real keys
    // (Ctrl+A + Delete), otherwise the earlier typing sections' composer text
    // re-persists after the clear and the assertion below cannot isolate the
    // debounce window.
    await client.evaluate(`window.__CODEBUDDY_STORE__.getState().setThreadDraft('')`);
    await focusComposer(client);
    await client.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Control', code: 'ControlLeft',
      windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2,
    });
    await client.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'a', code: 'KeyA',
      windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2,
    });
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'a', code: 'KeyA',
      windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2,
    });
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Control', code: 'ControlLeft',
      windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 0,
    });
    await client.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Backspace', code: 'Backspace',
      windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8, modifiers: 0,
    });
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Backspace', code: 'Backspace',
      windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8, modifiers: 0,
    });
    await wait(1600); // let the cleared composer's debounce settle
    await dispatchKey(client, 'd');
    await dispatchKey(client, 'e');
    await dispatchKey(client, 'b');
    await wait(1350);
    const draftInsideWindow = await client.evaluate(`window.__CODEBUDDY_STORE__.getState().threadsById[window.__CODEBUDDY_STORE__.getState().activeThreadId]?.draft || ''`);
    await wait(1500);
    const draftAfterDebounce = await client.evaluate(`window.__CODEBUDDY_STORE__.getState().threadsById[window.__CODEBUDDY_STORE__.getState().activeThreadId]?.draft || ''`);
    check('draft does not reach the store inside the 1500ms debounce window', draftInsideWindow === '', `draft='${draftInsideWindow}'`);
    check('draft persists once after the debounce expires', draftAfterDebounce === 'deb', `draft='${draftAfterDebounce}'`);

    // ── H. composer draft survives route switches (view kept alive) ──
    await typeBurst(client, { warmup: 0, measured: 6, prefix: 'keepalive' });
    const draftText = await client.evaluate(`document.querySelector('textarea')?.value || ''`);
    await client.evaluate(`window.__CODEBUDDY_STORE__.getState().setRoute('settings')`);
    await waitForRendererValue(client, fixtures.ROUTE_READY_MARKERS.settings, {
      timeoutMs: 30000, describe: 'settings ready', accept: (value) => value === true,
    });
    await client.evaluate(`window.__CODEBUDDY_STORE__.getState().setRoute('chat')`);
    await waitForChatInteractive(client, lastEntryPrefix, 30000);
    const draftAfterSwitch = await client.evaluate(`document.querySelector('textarea')?.value || ''`);
    check(
      'composer draft survives route switches (view kept alive)',
      draftAfterSwitch.startsWith(draftText.slice(0, 12)),
      `before='${draftText.slice(0, 20)}' after='${draftAfterSwitch.slice(0, 20)}'`,
    );
    await capture(client, 'perf-05-chat-return');

    // ── I. terminal output batching (50ms merge window) ──
    const terminalBatching = await client.evaluate(`(async () => {
      const api = window.__CODEBUDDY_STORE__;
      const paneId = 'pane-perf-' + Date.now();
      api.setState({ terminalPanes: [{ id: paneId, output: '', sessionId: null }], activePaneId: paneId });
      const before = api.getState().terminalPanes;
      for (let i = 0; i < 30; i += 1) api.getState().appendPaneOutput(paneId, 'x');
      const duringWindow = api.getState().terminalPanes;
      await new Promise((r) => setTimeout(r, 60));
      const afterWindow = api.getState().terminalPanes;
      const finalLen = String(api.getState().terminalPanes.find((p) => p.id === paneId)?.output || '').length;
      return {
        rebuiltDuringWindow: duringWindow !== before,
        rebuiltAfterWindow: afterWindow !== before,
        appendedChars: finalLen,
      };
    })()`);
    check(
      'terminal output flood merges chunks into one store write',
      terminalBatching.rebuiltDuringWindow === false,
      JSON.stringify(terminalBatching),
    );
    check(
      'terminal output eventually flushes all chunks to the store',
      terminalBatching.rebuiltAfterWindow === true && terminalBatching.appendedChars === 30,
      JSON.stringify(terminalBatching),
    );
  } catch (error) {
    console.error('perf verification failed:', error?.stack || error?.message || error);
    if (client) await recordFailure(client, 'fatal', error.message);
    check('script completed without fatal error', false, String(error?.message || error));
  } finally {
    if (client) {
      try { await client.close(); } catch (_) {}
    }
    let cleanupResult = null;
    if (ownershipController) {
      try {
        const cleanup = await ownershipController.close();
        cleanupResult = cleanup?.remainingVerifiedProcesses || {};
        check(
          'packaged process cleanup verified',
          cleanup?.ownershipBoundary?.jobClosed === true && cleanup?.remainingVerifiedProcesses?.count === 0,
          JSON.stringify(cleanup?.remainingVerifiedProcesses || {}),
        );
      } catch (error) {
        check('packaged process cleanup verified', false, error.message);
      }
    } else if (launched) {
      try {
        await cleanupOwned({
          rootPid: launched.rootPid,
          trackedProcesses: launched.rootIdentity ? [launched.rootIdentity] : [],
        });
        cleanupResult = { fallback: true };
        check('packaged process cleanup verified', true, 'fallback cleanupOwned');
      } catch (error) {
        check('packaged process cleanup verified', false, error.message);
      }
    }
    // Let the terminated process tree fully release file handles before
    // renaming the runtime profile away (AV/singleton teardown can lag the Job
    // close by a moment; retry longer than the harness default).
    await wait(2500);
    try {
      await cleanupRuntimeDir({
        runtimeOwnership,
        runtimeRoot,
        runtimeDir,
        renameRetries: 60,
        renameRetryDelayMs: 250,
      });
    } catch (error) {
      check('packaged runtime profile cleanup verified', false, error.message);
    }

    const report = reportLib.buildReport({
      meta,
      fixture: {
        hash: fixtureHash,
        summary: fixtureSummary,
        lastEntryType: lastEntry?.type || null,
        lastEntryRole: lastEntry?.role || null,
      },
      scenario: {
        routes: fixtures.routeSequence(),
        keepAlive: 'all-visited-routes-stay-mounted (App.jsx visitedRoutes)',
        bootThread: FIXTURE_THREAD_ID,
        emptyThread: EMPTY_THREAD_ID,
        input: 'Input.dispatchKeyEvent rawKeyDown+keyUp (real keyboard path)',
        streamAppend: 'appendThreadTimelineEvent → reduceAcpEvent + coalesce',
        thresholds: THRESHOLDS,
      },
      samples,
      longTasks: samples.longTasks || [],
      capabilityProbe: 'out/perf-capability-probe.json',
      cleanup: cleanupResult,
      verdicts: results,
      failures,
    });
    const reportPath = path.join(projectRoot, 'out', 'perf-report.json');
    reportLib.writeReport(reportPath, report);
    fs.mkdirSync(path.join(screenshotDir, runStamp), { recursive: true });
    fs.writeFileSync(
      path.join(screenshotDir, runStamp, 'perf-report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(`REPORT ${reportPath}`);
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      console.error(`${failed.length} perf check(s) failed`);
      process.exitCode = 1;
    } else {
      console.log(`ALL ${results.length} PERF CHECKS PASSED`);
    }
  }
}

main().catch((error) => {
  console.error('fatal:', error?.stack || error?.message || error);
  process.exitCode = 1;
});
