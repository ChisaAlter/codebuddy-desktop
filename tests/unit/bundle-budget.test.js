import { describe, expect, it } from 'vitest';
import {
  RAW_GROWTH_BYTES,
  compareGrowth,
  loadBaseline,
} from '../../scripts/test/bundle-budget.cjs';

const baseline = {
  schemaVersion: 1,
  generatedAt: '2026-01-01T00:00:00.000Z',
  toolchain: { vite: '5.0.0', node: 'v20.0.0', electron: 'packaged' },
  commit: 'abcdef0',
  entries: {
    'main entry': { pattern: '^index-[^/]+\\.js$', rawBytes: 1_000_000, gzipBytes: 300_000 },
    'workspace route': { pattern: '^ReplicaWorkspaceView-[^/]+\\.js$', rawBytes: 3_000_000, gzipBytes: 800_000 },
    'terminal route': { pattern: '^ReplicaTerminalView-[^/]+\\.js$', rawBytes: 300_000, gzipBytes: 70_000 },
  },
};

function measure(label, name, bytes, gzipBytes) {
  return { label, name, bytes, gzipBytes, maxBytes: 999_999_999, ok: true };
}

describe('bundle budget growth comparison (plan §3.3)', () => {
  it('passes when sizes match the baseline (hash may differ)', () => {
    const current = [
      measure('main entry', 'index-ABCDEF.js', 1_000_000, 300_000),
      measure('workspace route', 'ReplicaWorkspaceView-ABCDEF.js', 3_000_000, 800_000),
      measure('terminal route', 'ReplicaTerminalView-ABCDEF.js', 300_000, 70_000),
    ];
    const verdicts = compareGrowth(baseline, current);
    expect(verdicts.every((v) => v.ok)).toBe(true);
    // pattern matched a different hash → still passes (hash is never compared)
    expect(verdicts[0].rule).toBe('within baseline');
  });

  it('fails raw growth only when delta > 50KB AND pct > 10%', () => {
    // +150KB and +15% → fails
    const over = compareGrowth(baseline, [measure('main entry', 'index-X.js', 1_150_000, 300_000)]);
    expect(over[0].ok).toBe(false);
    expect(over[0].rule).toMatch(/raw\+150000B\(\+15\.0%\)/);
    // +40KB and +4% → passes (delta threshold not met)
    const deltaOnly = compareGrowth(baseline, [measure('main entry', 'index-X.js', 1_040_000, 300_000)]);
    expect(deltaOnly[0].ok).toBe(true);
    // +50KB and +5% → passes (delta not strictly > 50KB, pct not met)
    const pctOnly = compareGrowth(baseline, [measure('main entry', 'index-X.js', 1_050_000, 300_000)]);
    expect(pctOnly[0].ok).toBe(true);
    // +60KB and +6% → passes (pct threshold not met — the exact case the plan
    // distinguishes from a real regression)
    const pctOnly2 = compareGrowth(baseline, [measure('main entry', 'index-X.js', 1_060_000, 300_000)]);
    expect(pctOnly2[0].ok).toBe(true);
  });

  it('fails gzip growth only when delta > 10KB AND pct > 10%', () => {
    // gzip +50KB (+16.7%) → fails
    const over = compareGrowth(baseline, [measure('main entry', 'index-X.js', 1_000_000, 350_000)]);
    expect(over[0].ok).toBe(false);
    // gzip +8KB (+2.7%) → passes
    const under = compareGrowth(baseline, [measure('main entry', 'index-X.js', 1_000_000, 308_000)]);
    expect(under[0].ok).toBe(true);
    // gzip +12KB (+4%) with raw unchanged → passes (gzip pct not met)
    const both = compareGrowth(baseline, [measure('main entry', 'index-X.js', 1_000_000, 312_000)]);
    expect(both[0].ok).toBe(true);
    // raw AND gzip both over → fails
    const bothOver = compareGrowth(baseline, [measure('main entry', 'index-X.js', 1_200_000, 350_000)]);
    expect(bothOver[0].ok).toBe(false);
  });

  it('fails when a label matches no file in the current build (chunk missing)', () => {
    const current = [
      measure('main entry', 'index-X.js', 1_000_000, 300_000),
      measure('workspace route', 'ReplicaWorkspaceView-X.js', 3_000_000, 800_000),
      { label: 'terminal route', name: null, bytes: null, gzipBytes: null, maxBytes: 330_000, ok: false, error: 'chunk not found' },
    ];
    const verdicts = compareGrowth(baseline, current);
    expect(verdicts[2].ok).toBe(false);
    expect(verdicts[2].rule).toBe('chunk missing');
  });

  it('fails when the baseline schema is incompatible', () => {
    expect(() => loadBaselineFrom({ schemaVersion: 2, entries: {} })).toThrow(/schemaVersion/);
    expect(() => loadBaselineFrom({ schemaVersion: 1 })).toThrow(/entries/);
    expect(() =>
      loadBaselineFrom({ schemaVersion: 1, entries: { 'main entry': { pattern: 'x', rawBytes: 1 } } }),
    ).toThrow(/gzipBytes/);
    expect(() =>
      loadBaselineFrom({ schemaVersion: 1, entries: { 'main entry': { pattern: '[', rawBytes: 1, gzipBytes: 2 } } }),
    ).toThrow(/pattern invalid/);
  });

  it('reports a baseline error verdict for every label when the baseline file is broken', () => {
    // compareGrowth itself does not read the file — loadBaseline does; the CLI
    // converts a load failure into per-label failures. Verify compareGrowth
    // fails cleanly when an entry is missing entirely.
    const broken = { schemaVersion: 1, entries: { 'main entry': { pattern: 'x', rawBytes: 1, gzipBytes: 1 } } };
    const verdicts = compareGrowth(broken, [measure('terminal route', 'ReplicaTerminalView-X.js', 1, 1)]);
    expect(verdicts[0].ok).toBe(false);
    expect(verdicts[0].rule).toBe('baseline entry missing');
  });

  it('runs the bundle gate only after the release chain has produced a build', () => {
    // test:bundle-budget needs out/dist/assets from `vite build`; placing it
    // before the first build step made `npm run test:release` fail on a clean
    // checkout (or measure stale artifacts). Keep the ordering pinned.
    const pkg = require('../../package.json');
    const chain = pkg.scripts['test:release'];
    expect(chain.startsWith('npm run test:gate &&')).toBe(true);
    expect(chain).toContain('npm run test:e2e && npm run test:bundle-budget');
    expect(chain.indexOf('test:bundle-budget')).toBeGreaterThan(chain.indexOf('test:e2e'));
    expect(chain).toContain('npm run test:perf:memory');
  });
});

function loadBaselineFrom(value) {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-baseline-'));
  const file = path.join(dir, 'baseline.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return loadBaseline(file);
}
