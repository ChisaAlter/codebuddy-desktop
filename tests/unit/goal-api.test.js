// G2: goal bar 纯逻辑（快照归一、计时、recap 统计、/goal 设定判定）。
import { describe, expect, it } from 'vitest';
import {
  activeGoalFromSnapshot,
  goalElapsedMs,
  formatGoalElapsed,
  isGoalSetPrompt,
  formatGoalRecapStats,
  normalizeGoalRecap,
} from '../../src/lib/goal-api';

describe('activeGoalFromSnapshot', () => {
  it('returns null without an active condition', () => {
    expect(activeGoalFromSnapshot(null)).toBeNull();
    expect(activeGoalFromSnapshot({})).toBeNull();
    expect(activeGoalFromSnapshot({ active: { createdAt: 1 } })).toBeNull();
  });

  it('extracts condition, createdAt and paused state', () => {
    expect(activeGoalFromSnapshot({ active: { condition: 'tests pass', createdAt: 100 } })).toEqual({
      condition: 'tests pass',
      createdAt: 100,
      paused: false,
    });
    expect(activeGoalFromSnapshot({ active: { condition: 'x', createdAt: 100, pausedAt: 400 } })).toEqual({
      condition: 'x',
      createdAt: 100,
      pausedAt: 400,
      paused: true,
    });
  });
});

describe('goalElapsedMs / formatGoalElapsed', () => {
  it('freezes elapsed at pausedAt', () => {
    expect(goalElapsedMs({ createdAt: 1000, pausedAt: 4000 }, 99000)).toBe(3000);
    expect(goalElapsedMs({ createdAt: 1000 }, 5000)).toBe(4000);
  });

  it('formats WebUI-style elapsed labels', () => {
    expect(formatGoalElapsed(0)).toBe('1s');
    expect(formatGoalElapsed(59_000)).toBe('59s');
    expect(formatGoalElapsed(60_000)).toBe('1m');
    expect(formatGoalElapsed(61_000)).toBe('1m 1s');
    expect(formatGoalElapsed(3_600_000)).toBe('1h');
    expect(formatGoalElapsed(3_660_000)).toBe('1h 1m');
  });
});

describe('isGoalSetPrompt', () => {
  it('accepts /goal with a condition, rejects subcommands', () => {
    expect(isGoalSetPrompt('/goal all tests pass')).toBe(true);
    expect(isGoalSetPrompt('/goal clear')).toBe(false);
    expect(isGoalSetPrompt('/goal show')).toBe(false);
    expect(isGoalSetPrompt('/goal pause')).toBe(false);
    expect(isGoalSetPrompt('/goal resume')).toBe(false);
    expect(isGoalSetPrompt('/goal')).toBe(false);
    expect(isGoalSetPrompt('hello')).toBe(false);
  });
});

describe('goal recap', () => {
  const t = (key) => key.split('.').pop();

  it('normalizes active and latest payloads', () => {
    expect(normalizeGoalRecap({ active: { condition: 'x', paused: true, pausedAt: 5 } })).toEqual({
      active: { condition: 'x', paused: true, pausedAt: 5 },
    });
    expect(
      normalizeGoalRecap({ latest: { ok: true, condition: 'y', durationMs: 2500, turnCount: 2, tokenDelta: 1200 } }),
    ).toEqual({
      latest: { ok: true, condition: 'y', reason: null, durationMs: 2500, turnCount: 2, tokenDelta: 1200 },
    });
    expect(normalizeGoalRecap(null)).toBeNull();
    expect(normalizeGoalRecap({})).toBeNull();
  });

  it('formats recap stats with compact token counts', () => {
    expect(formatGoalRecapStats({ durationMs: 2500, turnCount: 2, tokenDelta: 1200 }, t)).toBe('3s · 2 turns · 1.2k tokens');
    expect(formatGoalRecapStats({ durationMs: 100, turnCount: 1, tokenDelta: 1 }, t)).toBe('1s · 1 turn · 1 token');
    expect(formatGoalRecapStats({ durationMs: 100, turnCount: 1, tokenDelta: 2_500_000 }, t)).toBe('1s · 1 turn · 2.5M tokens');
  });
});
