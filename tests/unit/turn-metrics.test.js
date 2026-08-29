// G7: 回合耗时纯逻辑。
import { describe, expect, it } from 'vitest';
import {
  appendTurnMetrics,
  formatTurnDuration,
  showTurnDurationFromSettings,
  turnMetricsEntry,
} from '../../src/lib/turn-metrics';

describe('showTurnDurationFromSettings', () => {
  it('defaults to true and honors an explicit false', () => {
    expect(showTurnDurationFromSettings(null)).toBe(true);
    expect(showTurnDurationFromSettings({})).toBe(true);
    expect(showTurnDurationFromSettings({ showTurnDuration: true })).toBe(true);
    expect(showTurnDurationFromSettings({ showTurnDuration: false })).toBe(false);
  });
});

describe('turnMetricsEntry / appendTurnMetrics', () => {
  it('derives durationMs from promptStartedAt', () => {
    expect(turnMetricsEntry(1000, 33_000)).toMatchObject({ type: 'turn-metrics', durationMs: 32_000 });
    expect(turnMetricsEntry(null, 33_000)).toBeNull();
    expect(turnMetricsEntry(5000, 1000)).toBeNull();
  });

  it('appends once and skips duplicate trailing metrics', () => {
    const timeline = [{ id: 'a', type: 'message', role: 'assistant', content: 'hi' }];
    const appended = appendTurnMetrics(timeline, 1000, 4000);
    expect(appended).toHaveLength(2);
    expect(appended[1]).toMatchObject({ type: 'turn-metrics', durationMs: 3000 });
    expect(appendTurnMetrics(appended, 1000, 5000)).toBe(appended);
    expect(appendTurnMetrics(timeline, null)).toBe(timeline);
  });
});

describe('formatTurnDuration', () => {
  it('formats seconds/minutes/hours', () => {
    expect(formatTurnDuration(0)).toBe('1s');
    expect(formatTurnDuration(32_000)).toBe('32s');
    expect(formatTurnDuration(90_000)).toBe('1m 30s');
    expect(formatTurnDuration(3_600_000)).toBe('1h');
  });
});
