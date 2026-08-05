import { describe, expect, it } from 'vitest';
import { evaluateMemoryVerdicts, longestIncreasingStreak } from '../../scripts/test/perf-memory.cjs';

const MiB = 1024 * 1024;

function flatRun({ heapMiB = 120, nodes = 5000, listeners = 200 } = {}) {
  return {
    retained: { heapUsed: heapMiB * MiB, nodes },
    rounds: Array.from({ length: 10 }, (_, i) => ({
      // tiny heap jitter keeps the slope ≈ 0; listeners/nodes stay FLAT so no
      // monotonic-growth rule fires
      heapUsed: heapMiB * MiB + (i % 2),
      nodes,
      listeners,
    })),
  };
}

const baseline = {
  baseline: { heapUsed: 100 * MiB, nodes: 4000 },
  retained: { heapUsed: 100 * MiB, nodes: 4000 },
};

describe('longestIncreasingStreak', () => {
  it('counts the longest strictly-increasing run', () => {
    expect(longestIncreasingStreak([1, 2, 3, 2, 3, 4, 5, 1])).toBe(3);
    expect(longestIncreasingStreak([5, 4, 3, 2, 1])).toBe(0);
    expect(longestIncreasingStreak([1, 1, 1, 1])).toBe(0);
    expect(longestIncreasingStreak([1, 2, 1, 2, 3, 4, 1, 2, 3, 4, 5])).toBe(4);
    expect(longestIncreasingStreak([])).toBe(0);
  });
});

describe('evaluateMemoryVerdicts (plan §3.2 rules)', () => {
  it('passes a flat run against the baseline', () => {
    const verdicts = evaluateMemoryVerdicts({ baseline, run: flatRun() });
    expect(verdicts.map((v) => [v.name, v.ok])).toEqual([
      ['heap slope <= 1 MiB/round (10 GC\'d rounds)', true],
      ['retained heap delta <= 80 MiB vs baseline', true],
      ['DOM nodes <= baseline × 1.25', true],
      ['jsEventListeners final − first <= 100', true],
      ['jsEventListeners no monotonic growth streak > 2 rounds', true],
    ]);
  });

  it('fails when the heap slope exceeds 1 MiB per round', () => {
    const run = flatRun();
    // +1.5 MiB every round → slope ≈ 1.5 MiB/round > 1 MiB
    run.rounds = run.rounds.map((round, i) => ({ ...round, heapUsed: 100 * MiB + i * 1.5 * MiB }));
    const verdicts = evaluateMemoryVerdicts({ baseline, run });
    expect(verdicts[0].ok).toBe(false);
    expect(verdicts[0].detail).toMatch(/1\.5\d* MiB\/round/);
  });

  it('fails when the retained heap delta exceeds 80 MiB', () => {
    const run = flatRun({ heapMiB: 200 }); // +100 MiB retained
    const verdicts = evaluateMemoryVerdicts({ baseline, run });
    expect(verdicts[1].ok).toBe(false);
    expect(verdicts[1].detail).toMatch(/delta=100\.0 MiB/);
  });

  it('fails when DOM nodes grow more than 25% over baseline', () => {
    const run = flatRun({ nodes: 5500 }); // 5500 / 4000 = 1.375
    const verdicts = evaluateMemoryVerdicts({ baseline, run });
    expect(verdicts[2].ok).toBe(false);
    expect(verdicts[2].detail).toMatch(/37\.5%/);
  });

  it('fails when jsEventListeners grow by more than 100', () => {
    const run = flatRun();
    // first 200 → last 335 → delta 135 > 100
    run.rounds = Array.from({ length: 10 }, (_, i) => ({ ...run.rounds[i], listeners: 200 + i * 15 }));
    const verdicts = evaluateMemoryVerdicts({ baseline, run });
    expect(verdicts[3].ok).toBe(false);
    expect(verdicts[3].detail).toMatch(/delta=135/);
  });

  it('fails when listeners grow monotonically for 3+ consecutive rounds', () => {
    const run = flatRun();
    run.rounds = Array.from({ length: 10 }, (_, i) => ({ ...run.rounds[i], listeners: 200 + i }));
    const verdicts = evaluateMemoryVerdicts({ baseline, run });
    expect(verdicts[4].ok).toBe(false);
    expect(verdicts[4].detail).toMatch(/streak=9/);
  });

  it('fails baseline-dependent verdicts (n/a) when the baseline file is unusable', () => {
    const verdicts = evaluateMemoryVerdicts({ baseline: null, run: flatRun() });
    // slope / listener rules are baseline-independent and still evaluate;
    // retained-delta and DOM-growth need the baseline → fail closed with n/a.
    expect(verdicts[0].ok).toBe(true);
    expect(verdicts[1].ok).toBe(false);
    expect(verdicts[1].detail).toMatch(/n\/a/);
    expect(verdicts[2].ok).toBe(false);
    expect(verdicts[2].detail).toMatch(/n\/a/);
    expect(verdicts[3].ok).toBe(true);
    expect(verdicts[4].ok).toBe(true);
  });

  it('tolerates missing samples (filtered to available rounds, fail-closed)', () => {
    const run = flatRun();
    run.rounds = [{ heapUsed: 100 * MiB, listeners: 200, nodes: 4000 }];
    const verdicts = evaluateMemoryVerdicts({ baseline, run });
    // slope needs >= 2 samples and listener delta needs first+last → fail closed
    expect(verdicts[0].ok).toBe(false);
    expect(verdicts[3].ok).toBe(false);
    expect(verdicts[3].detail).toMatch(/n\/a/);
  });
});
