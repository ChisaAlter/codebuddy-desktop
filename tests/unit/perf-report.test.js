import { describe, expect, it } from 'vitest';
import {
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
} from '../../scripts/test/perf-report.cjs';

describe('perf-report statistics', () => {
  it('computes median / p95 / max over raw samples (nearest-rank)', () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 200, 300];
    expect(median(values)).toBe(60); // ceil(0.5*12)-1 = index 5
    expect(p95(values)).toBe(300); // ceil(0.95*12)-1 = index 11 (nearest-rank)
    expect(maxValue(values)).toBe(300);
    expect(mean(values)).toBeCloseTo(87.5);
  });

  it('percentile is stable for single-element arrays', () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([], 95)).toBeNaN();
  });

  it('slopePerRound fits a least-squares line', () => {
    // values grow by 10 per round ⇒ slope ≈ 10
    const values = [100, 110, 120, 130, 140, 150];
    expect(slopePerRound(values)).toBeCloseTo(10, 6);
    // flat series ⇒ slope ≈ 0
    expect(slopePerRound([5, 5, 5, 5])).toBeCloseTo(0, 6);
    // too few samples ⇒ NaN
    expect(slopePerRound([1])).toBeNaN();
    expect(slopePerRound([])).toBeNaN();
  });

  it('describeTiming summarizes raw samples', () => {
    const timing = describeTiming([1, 2, 3, 4, 5]);
    expect(timing.samples).toBe(5);
    expect(timing.medianMs).toBe(3);
    expect(timing.p95Ms).toBe(5);
    expect(timing.maxMs).toBe(5);
    const empty = describeTiming([]);
    expect(empty.samples).toBe(0);
    expect(Number.isNaN(empty.medianMs)).toBe(true);
  });
});

describe('perf-report envelope', () => {
  it('buildReport keeps the fixed schema keys and verdict list shape', () => {
    const report = buildReport({
      meta: { commit: 'abc' },
      fixture: { entryCount: 300 },
      scenario: { routes: ['chat'] },
      samples: { typing: [1, 2] },
      memory: { rounds: [] },
      longTasks: [{ duration: 120 }],
      capabilityProbe: 'out/perf-capability-probe.json',
      cleanup: { ok: true },
      verdicts: [{ name: 'x', ok: true, detail: '' }],
    });
    expect(Object.keys(report).sort()).toEqual([
      'capabilityProbe',
      'cleanup',
      'fixture',
      'longTasks',
      'memory',
      'meta',
      'samples',
      'scenario',
      'verdicts',
    ]);
    expect(report.verdicts).toEqual([{ name: 'x', ok: true, detail: '' }]);
  });

  it('writeReport creates the directory and persists JSON', () => {
    const os = require('node:os');
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-report-'));
    const file = path.join(dir, 'nested', 'report.json');
    const written = writeReport(file, { meta: { ok: true } });
    expect(written).toBe(file);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ meta: { ok: true } });
  });

  it('collectMeta reports commit, OS, node and vite versions', () => {
    const meta = collectMeta();
    expect(meta.commit).toBeTypeOf('string');
    expect(meta.commit.length).toBeGreaterThanOrEqual(7);
    expect(meta.os).toContain(process.platform);
    expect(meta.node).toMatch(/^v\d+/);
    expect(meta.vite).toMatch(/^\d+\./);
    expect(meta.windowSize).toEqual({ width: 1440, height: 900 });
  });
});
