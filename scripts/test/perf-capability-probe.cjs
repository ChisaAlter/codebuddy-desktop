#!/usr/bin/env node
'use strict';

/**
 * Phase 0 — CDP capability probe (production performance gates).
 *
 * Launches the packaged Electron renderer and probes which Chromium CDP
 * metrics are available on this platform/build, so that downstream soak
 * scripts (heap/DOM/listener) never silently skip an unsupported metric.
 *
 * Probes:
 *  - Memory.enable / Memory.getDOMCounters        (documents/nodes/jsEventListeners)
 *  - HeapProfiler.enable / HeapProfiler.collectGarbage
 *  - Runtime.getHeapUsage                         (usedSize/totalSize)
 *  - performance.memory (Chromium-only, in-page)
 *  - manual DOM count via document.querySelectorAll('*').length
 *  - globalThis.gc availability (--js-flags=--expose-gc)
 *  - PerformanceObserver longtask/event-timing support (in-page)
 *
 * Evidence: out/perf-capability-probe.json. Probe output is input to the
 * phase-C threshold baseline, never a pass/fail gate by itself.
 *
 * Usage:
 *   npm run build:dir
 *   node scripts/test/perf-capability-probe.cjs
 */

const fs = require('node:fs');
const path = require('node:path');
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
const runStamp = `perf-probe-${Date.now()}`;
const runtimeOwnership = createRuntimeLayout({ projectRoot, runStamp, label: 'perf-probe' });
const { runtimeRoot, runtimeDir, userDataDir } = runtimeOwnership;

/**
 * Probe one CDP command, recording supported/value/error without throwing.
 */
async function probeCommand(client, name, method, params = {}) {
  try {
    const value = await client.send(method, params);
    return { name, supported: true, value, error: null };
  } catch (error) {
    return { name, supported: false, value: null, error: String(error?.message || error) };
  }
}

/**
 * Probe the in-page side: performance.memory, manual DOM count, gc,
 * PerformanceObserver longtask/event-timing support.
 */
async function probeInPage(client) {
  try {
    const value = await client.evaluate(`(async () => {
      const out = { userAgent: navigator.userAgent };
      // 1. Chromium-only performance.memory
      try {
        out.performanceMemory = performance.memory
          ? {
              usedJSHeapSize: performance.memory.usedJSHeapSize,
              totalJSHeapSize: performance.memory.totalJSHeapSize,
              jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
            }
          : null;
      } catch (error) { out.performanceMemory = { error: String(error) }; }
      // 2. Manual DOM count
      out.domCount = document.querySelectorAll('*').length;
      out.documentCount = document.readyState !== 'loading' ? 1 : 0;
      // 3. Explicit GC availability
      out.exposeGc = typeof globalThis.gc === 'function';
      // 4. PerformanceObserver longtask / event timing support
      out.longtaskSupported = typeof PerformanceObserver === 'function' &&
        typeof performance.getEntriesByType === 'function' &&
        performance.getEntriesByType('longtask') !== undefined;
      out.eventTimingSupported = typeof PerformanceObserver === 'function' &&
        typeof performance.getEntriesByType === 'function' &&
        performance.getEntriesByType('event') !== undefined;
      const observerResults = {};
      for (const type of ['longtask', 'event']) {
        try {
          const support = await new Promise((resolve) => {
            const observer = new PerformanceObserver((list) => {
              observer.disconnect();
              resolve({ ok: true, entries: list.getEntries().length });
            });
            try {
              observer.observe({ type, buffered: true });
            } catch (error) {
              observer.disconnect();
              resolve({ ok: false, error: String(error) });
            }
            setTimeout(() => resolve({ ok: false, error: 'no callback within 1500ms' }), 1500);
          });
          observerResults[type] = support;
        } catch (error) {
          observerResults[type] = { ok: false, error: String(error) };
        }
      }
      out.performanceObserver = observerResults;
      return out;
    })()`);
    return { name: 'in-page metrics', supported: true, value, error: null };
  } catch (error) {
    return { name: 'in-page metrics', supported: false, value: null, error: String(error?.message || error) };
  }
}

async function runProbe() {
  if (!fs.existsSync(packagedExe)) {
    throw new Error(`Packaged Electron binary missing: ${packagedExe}. Run npm run build:dir first.`);
  }

  seedProductState({ userDataDir, projectRoot });

  let launched = null;
  let client = null;
  let ownershipController = null;
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
    console.log(`packaged renderer target: ${target.url}`);
    client = await connectCdp(target, { commandTimeoutMs: 30000, connectTimeoutMs: 30000 });
    await waitForRendererValue(client, `Boolean(document.querySelector('textarea'))`, {
      timeoutMs: 30000,
      describe: 'packaged textarea ready',
      accept: (value) => value === true,
    });

    const probes = [];
    probes.push(await probeCommand(client, 'Memory.enable', 'Memory.enable'));
    probes.push(await probeCommand(client, 'Memory.getDOMCounters', 'Memory.getDOMCounters'));
    probes.push(await probeCommand(client, 'HeapProfiler.enable', 'HeapProfiler.enable'));
    probes.push(await probeCommand(client, 'HeapProfiler.collectGarbage', 'HeapProfiler.collectGarbage'));
    probes.push(await probeCommand(client, 'Runtime.getHeapUsage', 'Runtime.getHeapUsage'));
    probes.push(await probeCommand(client, 'Runtime.getHeapUsage after GC', 'Runtime.getHeapUsage'));
    probes.push(await probeInPage(client));

    const report = {
      generatedAt: new Date().toISOString(),
      electron: { executable: packagedExe },
      probes,
      summary: Object.fromEntries(
        probes.map((probe) => [probe.name, probe.supported ? 'supported' : 'unsupported']),
      ),
    };
    const outDir = path.join(projectRoot, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const reportPath = path.join(outDir, 'perf-capability-probe.json');
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`REPORT ${reportPath}`);
    for (const probe of probes) {
      console.log(`${probe.supported ? 'SUPPORTED' : 'UNSUPPORTED'} ${probe.name}${probe.error ? ` — ${probe.error}` : ''}`);
    }
    return reportPath;
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
  }
}

if (require.main === module) {
  runProbe().catch((error) => {
    console.error('probe failed:', error?.stack || error?.message || error);
    process.exitCode = 1;
  });
}

module.exports = { runProbe };
