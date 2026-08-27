// G9: 会话历史数据归一与相对时间。
import { describe, expect, it } from 'vitest';
import { formatHistoryRelativeTime, normalizeHistoryCandidate } from '../../src/lib/session-history';

describe('normalizeHistoryCandidate', () => {
  it('normalizes candidate fields with fallbacks', () => {
    expect(normalizeHistoryCandidate(null)).toBeNull();
    expect(normalizeHistoryCandidate({})).toBeNull();
    expect(
      normalizeHistoryCandidate({ sessionId: 'sess-1234567890', label: '  修复登录  ', updatedAt: 42, messageCount: '7', attached: true }),
    ).toEqual({ sessionId: 'sess-1234567890', label: '修复登录', updatedAt: 42, messageCount: 7, attached: true });
    expect(normalizeHistoryCandidate({ sessionId: 'sess-abcdefgh' })).toMatchObject({
      label: 'sess-abc',
      updatedAt: 0,
      messageCount: null,
      attached: false,
    });
  });
});

describe('formatHistoryRelativeTime', () => {
  const now = new Date('2026-08-27T12:00:00Z').getTime();

  it('formats zh buckets', () => {
    expect(formatHistoryRelativeTime(now - 30_000, 'zh', now)).toBe('刚刚');
    expect(formatHistoryRelativeTime(now - 5 * 60_000, 'zh', now)).toBe('5 分钟前');
    expect(formatHistoryRelativeTime(now - 3 * 3_600_000, 'zh', now)).toBe('3 小时前');
    expect(formatHistoryRelativeTime(now - 2 * 86_400_000, 'zh', now)).toBe('2 天前');
  });

  it('formats en buckets and handles invalid input', () => {
    expect(formatHistoryRelativeTime(now - 30_000, 'en', now)).toBe('Just now');
    expect(formatHistoryRelativeTime(now - 5 * 60_000, 'en', now)).toBe('5m ago');
    expect(formatHistoryRelativeTime(now - 3 * 3_600_000, 'en', now)).toBe('3h ago');
    expect(formatHistoryRelativeTime(null, 'en', now)).toBe('');
  });
});
