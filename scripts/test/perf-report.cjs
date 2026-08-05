'use strict';

/**
 * Phase A — report protocol for the production perf gates.
 *
 * Every perf script writes ONE JSON report with the same envelope so release
 * gate failures are locatable to a concrete scenario:
 *
 *   {
 *     meta:     commit / time / OS / Electron / Node / Vite / window size,
 *     fixture:  fixture hash / entry stats,
 *     scenario: route sequence + keep-alive state,
 *     samples:  raw samples + median / p95 / max per measurement,
 *     memory:   heap / DOM / listener baseline, per-round values, slope, verdict,
 *     longTasks: PerformanceObserver samples,
 *     capabilityProbe: reference to out/perf-capability-probe.json,
 *     cleanup:  process/job cleanup results,
 *     verdicts: [{ name, ok, detail }]
 *   }
 */

const fs = require('node:fs');
const path = require('node:path');

/** Percentile over a numeric array (sorted internally). */
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function median(values) {
  return percentile(values, 50);
}

function p95(values) {
  return percentile(values, 95);
}

function maxValue(values) {
  return values.length ? Math.max(...values) : NaN;
}

function mean(values) {
  if (!values.length) return NaN;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Least-squares slope (per round) over [index, value] pairs.
 * Returns bytes (or units) per round; NaN for < 2 samples.
 */
function slopePerRound(values) {
  if (!Array.isArray(values) || values.length < 2) return NaN;
  const n = values.length;
  const xs = values.map((_, i) => i);
  const xMean = (n - 1) / 2;
  const yMean = mean(values);
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i += 1) {
    numerator += (xs[i] - xMean) * (values[i] - yMean);
    denominator += (xs[i] - xMean) ** 2;
  }
  if (denominator === 0) return NaN;
  return numerator / denominator;
}

function describeTiming(values) {
  return {
    samples: values.length,
    medianMs: Number(median(values).toFixed(2)),
    p95Ms: Number(p95(values).toFixed(2)),
    maxMs: Number(maxValue(values).toFixed(2)),
  };
}

/** Environment + toolchain envelope (commit, OS, Electron, Node, Vite, window). */
function collectMeta(options = {}) {
  const { projectRoot = path.resolve(__dirname, '..', '..'), windowSize = { width: 1440, height: 900 } } = options;
  let commit = 'unknown';
  try {
    commit = require('node:child_process')
      .execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' })
      .trim();
  } catch (_) {
    /* not a git checkout */
  }
  let viteVersion = 'unknown';
  try {
    viteVersion = require(path.join(projectRoot, 'node_modules', 'vite', 'package.json')).version;
  } catch (_) {
    /* vite not installed */
  }
  return {
    commit,
    time: new Date().toISOString(),
    os: `${process.platform} ${process.arch}`,
    node: process.version,
    electron: process.versions.electron || 'packaged',
    vite: viteVersion,
    windowSize,
    script: path.basename(process.argv[1] || ''),
  };
}

/**
 * Build the full report envelope. `sections` is a plain object merged under
 * the fixed keys; `verdicts` is [{ name, ok, detail }].
 */
function buildReport({ meta, fixture, scenario, samples, memory, longTasks, capabilityProbe, cleanup, verdicts }) {
  return {
    meta: meta || null,
    fixture: fixture || null,
    scenario: scenario || null,
    samples: samples || {},
    memory: memory || null,
    longTasks: longTasks || [],
    capabilityProbe: capabilityProbe || null,
    cleanup: cleanup || null,
    verdicts: Array.isArray(verdicts) ? verdicts : [],
  };
}

function writeReport(reportPath, report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
}

module.exports = {
  buildReport,
  collectMeta,
  describeTiming,
  maxValue,
  mean,
  median,
  p95,
  percentile,
  slopePerRound,
  writeReport,
};
