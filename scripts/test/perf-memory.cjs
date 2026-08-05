#!/usr/bin/env node
'use strict';

/**
 * Heap / DOM / listener soak (production perf gates, plan §3.2).
 *
 * Launches the packaged renderer with the 300-entry fixture and:
 *
 *  - collects baseline metrics (forced GC → Runtime.getHeapUsage,
 *    Memory.getDOMCounters) after the fixture chat hydrates;
 *  - visits ALL routes once, forces GC and collects retained metrics;
 *  - repeats the core 4-route cycle 10 times, recording per round:
 *    route ready latency, JS heap used/total, DOM nodes/documents/listeners;
 *  - FIRST RUN (--collect-baseline): collect only, no pass/fail — writes
 *    scripts/test/perf-memory-baseline.json as the committed baseline;
 *  - LATER RUNS: judge against the baseline with fixed rules:
 *      heap slope        <= 1 MiB per round (10 rounds, GC'd)
 *      retained delta    <= 80 MiB vs baseline (full-route visit + GC)
 *      DOM nodes         <= baseline × 1.25
 *      jsEventListeners  final − first <= 100 AND no 3-round monotonic growth
 *
 * Unsupported CDP metrics are never silently skipped: a fallback sampler
 * (performance.memory + manual DOM count) is tried, and if neither works the
 * run reports a blocking failure.
 *
 * Usage:
 *   node scripts/test/perf-memory.cjs --collect-baseline   # first run
 *   node scripts/test/perf-memory.cjs                      # gate run
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
const baselinePath = path.join(__dirname, 'perf-memory-baseline.json');
const runStamp = `perf-memory-${Date.now()}`;
const runtimeOwnership = createRuntimeLayout({ projectRoot, runStamp, label: 'perf-memory' });
const { runtimeRoot, runtimeDir, userDataDir } = runtimeOwnership;
const results = [];
let ownershipController = null;

// Fixed rules (plan §3.2 initial targets; if a baseline lands far from them
// the reason is recorded in the report — thresholds are never silently bumped).
const RULES = {
  heapSlopeMiBPerRound: 1,
  retainedDeltaMiB: 80,
  domGrowthFactor: 1.25,
  listenerDeltaMax: 100,
  listenerMonotonicStreakMax: 2,
};

const CORE_ROUTES = ['chat', 'terminal', 'editor', 'settings'];

function check(name, ok, detail = '') {
  const result = { name, ok: Boolean(ok), detail: String(detail || '') };
  results.push(result);
  console.log(`${result.ok ? 'PASS' : 'FAIL'} ${name}${result.detail ? ` — ${result.detail}` : ''}`);
  return result.ok;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * GC then sample heap (Runtime.getHeapUsage) + DOM counters
 * (Memory.getDOMCounters with in-page fallback). Never silently skips:
 * returns { source } identifying the sampler used.
 */
async function collectMetrics(client) {
  let gcError = null;
  try {
    await client.send('HeapProfiler.collectGarbage');
  } catch (error) {
    gcError = String(error?.message || error);
  }
  await wait(200); // GC settle
  let heap = null;
  try {
    heap = await client.send('Runtime.getHeapUsage');
  } catch (error) {
    heap = { error: String(error?.message || error) };
  }
  let dom = null;
  let domError = null;
  try {
    dom = await client.send('Memory.getDOMCounters');
  } catch (error) {
    domError = String(error?.message || error);
  }
  let fallback = null;
  if (!dom || !heap?.usedSize) {
    fallback = await client.evaluate(`(() => ({
      nodes: document.querySelectorAll('*').length,
      documents: document.readyState !== 'loading' ? 1 : 0,
      performanceMemory: performance.memory
        ? { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize }
        : null,
    }))()`).catch(() => null);
  }
  const route = await client.evaluate(`window.__CODEBUDDY_STORE__.getState().route`).catch(() => null);
  return {
    route,
    heapUsed: heap?.usedSize ?? fallback?.performanceMemory?.usedJSHeapSize ?? null,
    heapTotal: heap?.totalSize ?? fallback?.performanceMemory?.totalJSHeapSize ?? null,
    nodes: dom?.nodes ?? fallback?.nodes ?? null,
    documents: dom?.documents ?? fallback?.documents ?? null,
    listeners: dom?.jsEventListeners ?? null,
    source: dom ? 'cdp:Memory.getDOMCounters' : fallback ? 'fallback:performance.memory+DOM count' : 'none',
    gcError,
    domError,
    blocking: !dom && !fallback,
  };
}

/** Longest strictly-increasing streak over a numeric series. */
function longestIncreasingStreak(values) {
  let best = 0;
  let current = 0;
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] > values[i - 1]) {
      current += 1;
      best = Math.max(best, current);
    } else {
      current = 0;
    }
  }
  return best;
}

/**
 * Pure comparison — baseline file + this run's measurements → verdicts.
 * Exported for unit tests.
 */
function evaluateMemoryVerdicts({ baseline, run }) {
  const baselineHeap = baseline?.baseline?.heapUsed ?? null;
  const baselineNodes = baseline?.baseline?.nodes ?? null;
  const heapPerRound = run.rounds.map((round) => round.heapUsed).filter((v) => v != null);
  const heapSlope = reportLib.slopePerRound(heapPerRound);
  const retainedHeap = run.retained?.heapUsed ?? null;
  const retainedDeltaMiB = baselineHeap != null && retainedHeap != null ? (retainedHeap - baselineHeap) / (1024 * 1024) : null;
  const nodesGrowth = baselineNodes != null && run.retained?.nodes != null ? run.retained.nodes / baselineNodes : null;
  const listenersSeries = run.rounds.map((round) => round.listeners).filter((v) => v != null);
  const listenerDelta = listenersSeries.length >= 2 ? listenersSeries[listenersSeries.length - 1] - listenersSeries[0] : null;
  const streak = longestIncreasingStreak(listenersSeries);

  const heapSlopeOk = heapSlope != null && Number.isFinite(heapSlope) && heapSlope <= RULES.heapSlopeMiBPerRound * 1024 * 1024;
  const retainedOk = retainedDeltaMiB != null && retainedDeltaMiB <= RULES.retainedDeltaMiB;
  const domOk = nodesGrowth != null && nodesGrowth <= RULES.domGrowthFactor;
  const listenerDeltaOk = listenerDelta != null && listenerDelta <= RULES.listenerDeltaMax;
  const listenerStreakOk = streak <= RULES.listenerMonotonicStreakMax;

  return [
    {
      name: "heap slope <= 1 MiB/round (10 GC'd rounds)",
      ok: heapSlopeOk,      detail: `slope=${heapSlope != null ? (heapSlope / (1024 * 1024)).toFixed(3) : 'n/a'} MiB/round over ${heapPerRound.length} rounds`,
    },
    {
      name: 'retained heap delta <= 80 MiB vs baseline',
      ok: retainedOk,
      detail: `delta=${retainedDeltaMiB != null ? retainedDeltaMiB.toFixed(1) : 'n/a'} MiB (baseline=${baselineHeap != null ? Math.round(baselineHeap / 1024 / 1024) : 'n/a'}MiB → retained=${retainedHeap != null ? Math.round(retainedHeap / 1024 / 1024) : 'n/a'}MiB)`,
    },
    {
      name: 'DOM nodes <= baseline × 1.25',
      ok: domOk,
      detail: `growth=${nodesGrowth != null ? `${(nodesGrowth * 100).toFixed(1)}%` : 'n/a'} (baseline=${baselineNodes ?? 'n/a'} → final=${run.retained?.nodes ?? 'n/a'})`,
    },
    {
      name: 'jsEventListeners final − first <= 100',
      ok: listenerDeltaOk,
      detail: `delta=${listenerDelta ?? 'n/a'} (first=${listenersSeries[0] ?? 'n/a'} → final=${listenersSeries[listenersSeries.length - 1] ?? 'n/a'})`,
    },
    {
      name: 'jsEventListeners no monotonic growth streak > 2 rounds',
      ok: listenerStreakOk,
      detail: `longest increasing streak=${streak} rounds`,
    },
  ];
}

async function main() {
  const collectBaseline = process.argv.includes('--collect-baseline');
  if (!fs.existsSync(packagedExe)) {
    throw new Error(`Packaged Electron binary missing: ${packagedExe}. Run npm run build:dir first.`);
  }

  // Read the Phase-0 capability probe so unsupported metrics are documented.
  let capabilityProbe = null;
  try {
    capabilityProbe = JSON.parse(fs.readFileSync(path.join(projectRoot, 'out', 'perf-capability-probe.json'), 'utf8'));
  } catch (_) {
    capabilityProbe = { missing: true, note: 'run perf-capability-probe.cjs first' };
  }

  const fixtureEvents = fixtures.generateTranscriptEvents({ count: 300 });
  const fixtureTimeline = await fixtures.hydrateTranscript(fixtureEvents);
  const fixtureHash = fixtures.fixtureHash(fixtureEvents);
  seedProductState({
    userDataDir,
    projectRoot,
    activeThreadId: 'thread-fixture',
    timeline: fixtureTimeline,
    modelId: 'perf-model',
  });

  const meta = reportLib.collectMeta({ projectRoot });
  let launched = null;
  let client = null;
  let baseline = null;
  let runData = null;
  try {
    launched = await launchDesktop({
      executable: packagedExe,
      projectRoot,
      userDataDir,
      runtimeRoot,
      runtimeDir,
      runtimeOwnership,
      onOwnershipController(controller) {
        ownershipController = controller;
      },
      env: { CODEBUDDY_E2E: '1' },
    });
    console.log(`launched packaged pid=${launched.rootPid || launched.pid} cdp=${launched.debugPort}`);
    const target = await findRendererTarget({
      port: launched.debugPort,
      expectedUrl: (url) => /^http:\/\/127\.0\.0\.1:\d+\/index\.html$/.test(String(url || '')),
      timeoutMs: 90000,
    });
    client = await connectCdp(target, { commandTimeoutMs: 60000, connectTimeoutMs: 30000 });
    await waitForRendererValue(client, `Boolean(document.querySelector('textarea'))`, {
      timeoutMs: 60000,
      describe: 'packaged textarea ready',
      accept: (value) => value === true,
    });

    const lastEntryPrefix = String(fixtureTimeline[fixtureTimeline.length - 1]?.content || '').slice(0, 60);
    const chatMarker = `(() => {
      const ta = document.querySelector('textarea');
      if (!ta) return false;
      return document.body.innerText.includes(${JSON.stringify(lastEntryPrefix)});
    })()`;

    const readyOnRoute = async (route, timeoutMs) => {
      const t0 = performance.now();
      await client.evaluate(`window.__CODEBUDDY_STORE__.getState().setRoute(${JSON.stringify(route)})`);
      await waitForRendererValue(client, fixtures.ROUTE_READY_MARKERS[route], {
        timeoutMs,
        intervalMs: 120,
        describe: `${route} ready`,
        accept: (value) => value === true,
      });
      return Math.round(performance.now() - t0);
    };

    // ── baseline: fixture chat hydrated, GC'd ──
    await waitForRendererValue(client, chatMarker, { timeoutMs: 120000, intervalMs: 120, describe: 'fixture chat interactive', accept: (v) => v === true });
    const baselineMetrics = await collectMetrics(client);
    check(
      'memory metrics sampler available',
      !baselineMetrics.blocking,
      `source=${baselineMetrics.source}${baselineMetrics.domError ? ` domError=${baselineMetrics.domError}` : ''}`,
    );

    // ── full-route visit + GC → retained ──
    for (const route of ['terminal', 'editor', 'settings', 'chat']) {
      await readyOnRoute(route, 45000);
    }
    const retainedMetrics = await collectMetrics(client);

    // ── 10 rounds of the core 4-route cycle ──
    const rounds = [];
    for (let round = 1; round <= 10; round += 1) {
      const routes = [];
      for (const route of CORE_ROUTES) {
        const readyMs = await readyOnRoute(route, 45000);
        const metrics = await collectMetrics(client);
        routes.push({ route, readyMs, ...metrics });
      }
      rounds.push({
        round,
        heapUsed: routes[routes.length - 1].heapUsed,
        heapTotal: routes[routes.length - 1].heapTotal,
        nodes: routes[routes.length - 1].nodes,
        documents: routes[routes.length - 1].documents,
        listeners: routes[routes.length - 1].listeners,
        routes,
      });
      console.log(`round ${round}: heap=${Math.round((rounds[rounds.length - 1].heapUsed || 0) / 1024 / 1024)}MiB nodes=${rounds[rounds.length - 1].nodes} listeners=${rounds[rounds.length - 1].listeners}`);
    }

    runData = {
      baseline: {
        heapUsed: baselineMetrics.heapUsed,
        heapTotal: baselineMetrics.heapTotal,
        nodes: baselineMetrics.nodes,
        documents: baselineMetrics.documents,
        listeners: baselineMetrics.listeners,
      },
      retained: {
        heapUsed: retainedMetrics.heapUsed,
        heapTotal: retainedMetrics.heapTotal,
        nodes: retainedMetrics.nodes,
        documents: retainedMetrics.documents,
        listeners: retainedMetrics.listeners,
      },
      rounds,
      metricsSource: baselineMetrics.source,
      blocking: baselineMetrics.blocking || retainedMetrics.blocking,
    };

    if (collectBaseline) {
      baseline = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        commit: meta.commit,
        toolchain: { node: meta.node, electron: meta.electron, vite: meta.vite },
        fixture: { hash: fixtureHash, entryCount: fixtureTimeline.length },
        metricsSource: runData.metricsSource,
        baseline: runData.baseline,
        retained: runData.retained,
        rounds,
      };
      fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
      check('baseline collected (collect-only run)', true, `BASELINE ${baselinePath} heap=${Math.round((runData.baseline.heapUsed || 0) / 1024 / 1024)}MiB nodes=${runData.baseline.nodes} listeners=${runData.baseline.listeners}`);
    } else {
      try {
        baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
        if (baseline.schemaVersion !== 1) throw new Error(`schemaVersion=${baseline.schemaVersion}`);
      } catch (error) {
        check(
          'memory baseline available',
          false,
          `no usable baseline at ${baselinePath} — run perf-memory.cjs --collect-baseline first (${error.message})`,
        );
        baseline = null;
      }
      if (baseline) {
        const verdicts = evaluateMemoryVerdicts({ baseline, run: runData });
        for (const verdict of verdicts) check(verdict.name, verdict.ok && !runData.blocking, verdict.detail);
      }
      if (runData.blocking) {
        check('memory metrics sampler not blocking', false, `source=${runData.metricsSource}`);
      }
    }
  } catch (error) {
    console.error('memory soak failed:', error?.stack || error?.message || error);
    check('memory soak completed without fatal error', false, String(error?.message || error));
  } finally {
    if (client) {
      try { await client.close(); } catch (_) {}
    }
    if (ownershipController) {
      try { await ownershipController.close(); } catch (error) {
        console.warn('ownership controller cleanup failed:', error?.message || error);
      }
    } else if (launched) {
      try {
        await cleanupOwned({
          rootPid: launched.rootPid,
          trackedProcesses: launched.rootIdentity ? [launched.rootIdentity] : [],
        });
      } catch (error) {
        console.warn('cleanupOwned failed:', error?.message || error);
      }
    }
    try { await cleanupRuntimeDir({ runtimeOwnership, runtimeRoot, runtimeDir }); } catch (error) {
      console.warn('runtime dir cleanup failed:', error?.message || error);
    }

    const report = {
      meta,
      capabilityProbe: { path: 'out/perf-capability-probe.json', supported: capabilityProbe.summary || null, missing: capabilityProbe.missing || false },
      fixture: { hash: fixtureHash, entryCount: fixtureTimeline.length },
      mode: collectBaseline ? 'collect-baseline' : 'gate',
      baselinePath: collectBaseline ? null : baselinePath,
      baseline: collectBaseline ? null : baseline,
      run: runData,
      verdicts: results,
    };
    const reportPath = path.join(projectRoot, 'out', 'perf-memory-report.json');
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`REPORT ${reportPath}`);
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      console.error(`${failed.length} memory check(s) failed`);
      process.exitCode = 1;
    } else {
      console.log(`ALL ${results.length} MEMORY CHECKS ${collectBaseline ? 'COLLECTED' : 'PASSED'}`);
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('fatal:', error?.stack || error?.message || error);
    process.exitCode = 1;
  });
}

module.exports = { RULES, evaluateMemoryVerdicts, longestIncreasingStreak };
