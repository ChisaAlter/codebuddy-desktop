#!/usr/bin/env node
'use strict';

/**
 * Bundle budget gate — absolute sizes + historical baseline growth.
 *
 * Absolute budgets (plan §3.3 baseline schema v1):
 *   main entry / workspace route / terminal route → maxBytes
 *
 * Historical growth (plan §3.3):
 *   - baseline JSON keyed by LABEL (pattern is only used to find the chunk in
 *     the current build output; hashes are never compared);
 *   - raw size fails when growth > 10% AND > 50KB simultaneously;
 *   - gzip size fails when growth > 10% AND > 10KB simultaneously;
 *   - a label whose pattern matches no file fails ("chunk missing");
 *   - an incompatible baseline schema fails;
 *   - the baseline is NEVER auto-updated — only explicit
 *     `npm run test:bundle-budget:update` (--update-baseline or
 *     BUNDLE_BUDGET_UPDATE_BASELINE=1) rewrites it, after human review.
 *
 * Usage:
 *   npm run build:dir
 *   node scripts/test/bundle-budget.cjs
 *   node scripts/test/bundle-budget.cjs --update-baseline   # human-reviewed only
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const projectRoot = path.resolve(__dirname, '..', '..');
const distRoot = path.join(projectRoot, 'out', 'dist', 'assets');
const baselinePath = path.join(__dirname, 'bundle-baseline.json');
const budgets = [
  { label: 'main entry', pattern: /^index-[^/]+\.js$/, maxBytes: 1_550_000 },
  { label: 'workspace route', pattern: /^ReplicaWorkspaceView-[^/]+\.js$/, maxBytes: 3_800_000 },
  { label: 'terminal route', pattern: /^ReplicaTerminalView-[^/]+\.js$/, maxBytes: 330_000 },
];

// Growth rules (plan §3.3): both conditions must hold to fail.
const RAW_GROWTH_PCT = 0.10;
const RAW_GROWTH_BYTES = 50 * 1024;
const GZIP_GROWTH_PCT = 0.10;
const GZIP_GROWTH_BYTES = 10 * 1024;

function gzipSize(filePath) {
  return zlib.gzipSync(fs.readFileSync(filePath), { level: 9 }).length;
}

function currentToolchain() {
  const read = (rel) => {
    try {
      return require(path.join(projectRoot, 'node_modules', rel, 'package.json')).version;
    } catch (_) {
      return 'unknown';
    }
  };
  let commit = 'unknown';
  try {
    commit = require('node:child_process')
      .execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' })
      .trim();
  } catch (_) {}
  return { vite: read('vite'), node: process.version, electron: 'packaged', commit };
}

/** Parse + validate the baseline file; throws with a human-readable reason. */
function loadBaseline(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`bundle baseline unreadable at ${filePath}: ${error.message}`);
  }
  if (!parsed || parsed.schemaVersion !== 1) {
    throw new Error(`bundle baseline schema incompatible: schemaVersion=${parsed?.schemaVersion} (expected 1)`);
  }
  if (!parsed.entries || typeof parsed.entries !== 'object') {
    throw new Error('bundle baseline schema incompatible: missing entries map');
  }
  for (const label of budgets.map((b) => b.label)) {
    const entry = parsed.entries[label];
    if (!entry || typeof entry !== 'object') {
      throw new Error(`bundle baseline schema incompatible: missing entry for label "${label}"`);
    }
    for (const field of ['pattern', 'rawBytes', 'gzipBytes']) {
      if (typeof entry[field] === 'undefined') {
        throw new Error(`bundle baseline schema incompatible: entry "${label}" missing "${field}"`);
      }
    }
    if (!Number.isFinite(entry.rawBytes) || !Number.isFinite(entry.gzipBytes)) {
      throw new Error(`bundle baseline schema incompatible: entry "${label}" has non-numeric sizes`);
    }
    try {
      new RegExp(entry.pattern);
    } catch (error) {
      throw new Error(`bundle baseline schema incompatible: entry "${label}" pattern invalid: ${error.message}`);
    }
  }
  return parsed;
}

/** Measure the current build against absolute budgets; returns per-label results. */
function measureBuild(files, budgetList = budgets) {
  return budgetList.map(({ label, pattern, maxBytes }) => {
    const name = files.find((candidate) => pattern.test(candidate));
    if (!name) return { label, ok: false, error: 'chunk not found', bytes: null, gzipBytes: null, maxBytes };
    const filePath = path.join(distRoot, name);
    const bytes = fs.statSync(filePath).size;
    const gzipBytes = gzipSize(filePath);
    return { label, name, bytes, gzipBytes, maxBytes, ok: bytes <= maxBytes };
  });
}

/**
 * Compare current measurements against the committed baseline (plan §3.3).
 * Returns per-label verdicts; a growth verdict only fails when BOTH the
 * percentage and the absolute delta thresholds are exceeded.
 */
function compareGrowth(baseline, current) {
  const entries = baseline.entries || {};
  return current.map((measure) => {
    const base = entries[measure.label];
    if (!base) return { label: measure.label, ok: false, rule: 'baseline entry missing', detail: 'label not in baseline' };
    if (!measure.name) {
      return { label: measure.label, ok: false, rule: 'chunk missing', detail: 'pattern matched no file in current build' };
    }
    const rawDelta = measure.bytes - base.rawBytes;
    const gzipDelta = measure.gzipBytes - base.gzipBytes;
    const rawPct = base.rawBytes > 0 ? rawDelta / base.rawBytes : 0;
    const gzipPct = base.gzipBytes > 0 ? gzipDelta / base.gzipBytes : 0;
    const rawOver = rawDelta > RAW_GROWTH_BYTES && rawPct > RAW_GROWTH_PCT;
    const gzipOver = gzipDelta > GZIP_GROWTH_BYTES && gzipPct > GZIP_GROWTH_PCT;
    return {
      label: measure.label,
      ok: !rawOver && !gzipOver,
      rule: rawOver || gzipOver ? `growth: raw+${rawDelta}B(+${(rawPct * 100).toFixed(1)}%) gzip+${gzipDelta}B(+${(gzipPct * 100).toFixed(1)}%)` : 'within baseline',
      baselineRawBytes: base.rawBytes,
      baselineGzipBytes: base.gzipBytes,
      currentRawBytes: measure.bytes,
      currentGzipBytes: measure.gzipBytes,
      rawDelta,
      gzipDelta,
      rawPct: Number(rawPct.toFixed(4)),
      gzipPct: Number(gzipPct.toFixed(4)),
    };
  });
}

/** Write a fresh baseline from the current (already-passing) build. */
function writeBaseline(filePath, current, toolchain) {
  const entries = {};
  for (const measure of current) {
    if (!measure.name) throw new Error(`cannot update baseline: chunk "${measure.label}" not found in current build`);
    const pattern = budgets.find((b) => b.label === measure.label)?.pattern;
    entries[measure.label] = { pattern: pattern ? pattern.source : measure.name, rawBytes: measure.bytes, gzipBytes: measure.gzipBytes };
  }
  const baseline = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    toolchain: { vite: toolchain.vite, node: toolchain.node, electron: toolchain.electron },
    commit: toolchain.commit,
    entries,
  };
  fs.writeFileSync(filePath, `${JSON.stringify(baseline, null, 2)}\n`);
  return baseline;
}

function main() {
  const updateBaseline = process.argv.includes('--update-baseline') || process.env.BUNDLE_BUDGET_UPDATE_BASELINE === '1';
  if (!fs.existsSync(distRoot)) {
    console.error(`Build output not found: ${distRoot}`);
    console.error('Run npm run build:dir or npm run build first.');
    process.exitCode = 1;
    return;
  }

  const files = fs.readdirSync(distRoot);
  const current = measureBuild(files);

  let baseline = null;
  let growth = null;
  if (updateBaseline) {
    const toolchain = currentToolchain();
    baseline = writeBaseline(baselinePath, current, toolchain);
    console.log(`BASELINE UPDATED ${baselinePath} (commit ${toolchain.commit.slice(0, 8)}) — review the diff before committing`);
  } else {
    try {
      baseline = loadBaseline(baselinePath);
      growth = compareGrowth(baseline, current);
    } catch (error) {
      console.error(`FAIL baseline: ${error.message}`);
      growth = current.map((measure) => ({
        label: measure.label,
        ok: false,
        rule: 'baseline error',
        detail: error.message,
        baselineRawBytes: null,
        baselineGzipBytes: null,
        currentRawBytes: measure.bytes,
        currentGzipBytes: measure.gzipBytes,
        rawDelta: null,
        gzipDelta: null,
        rawPct: null,
        gzipPct: null,
      }));
    }
  }

  for (const measure of current) {
    const absOk = measure.ok;
    const growthVerdict = growth?.find((g) => g.label === measure.label);
    const growthOk = updateBaseline ? true : growthVerdict?.ok;
    if (absOk && (updateBaseline || growthOk)) {
      console.log(
        `PASS ${measure.label}: ${measure.bytes} bytes raw, ${measure.gzipBytes} gzip (${measure.name})` +
          (growthVerdict ? ` — ${growthVerdict.rule}` : ''),
      );
    } else {
      console.error(
        `FAIL ${measure.label}: ${measure.error || `${measure.bytes} > ${measure.maxBytes} bytes`}` +
          (growthVerdict && !growthVerdict.ok ? ` | ${growthVerdict.rule}` : ''),
      );
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    toolchain: currentToolchain(),
    baselinePath: updateBaseline ? null : baselinePath,
    baseline: updateBaseline ? null : baseline,
    results: current,
    growth: updateBaseline ? null : growth,
    rules: {
      absolute: 'bytes <= maxBytes',
      rawGrowth: `fail when delta > ${RAW_GROWTH_BYTES}B AND pct > ${(RAW_GROWTH_PCT * 100).toFixed(0)}%`,
      gzipGrowth: `fail when delta > ${GZIP_GROWTH_BYTES}B AND pct > ${(GZIP_GROWTH_PCT * 100).toFixed(0)}%`,
      baselineUpdate: 'explicit --update-baseline / BUNDLE_BUDGET_UPDATE_BASELINE only',
    },
  };
  const reportPath = path.join(projectRoot, 'out', 'bundle-budget-report.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`REPORT ${reportPath}`);
  if (current.some((result) => !result.ok) || (!updateBaseline && growth?.some((g) => !g.ok))) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  RAW_GROWTH_BYTES,
  RAW_GROWTH_PCT,
  GZIP_GROWTH_BYTES,
  GZIP_GROWTH_PCT,
  budgets,
  compareGrowth,
  loadBaseline,
  measureBuild,
  writeBaseline,
};
