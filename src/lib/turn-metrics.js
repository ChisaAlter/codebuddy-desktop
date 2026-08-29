// G7: 回合耗时（CLI 2.138 turn-metrics 记录 + showTurnDuration 设置，默认开）。
// CLI 在 TUI/session 历史里落 {type:'turn-metrics', durationMs, tokenDelta}；
// Desktop 在回合成功终态本地补一条等价时间线记录。

export function showTurnDurationFromSettings(settings) {
  return settings?.showTurnDuration !== false;
}

/** 由 promptStartedAt 推导一条 turn-metrics 时间线记录；无有效起点时返回 null。 */
export function turnMetricsEntry(promptStartedAt, endedAt = Date.now()) {
  const startedAt = Number(promptStartedAt);
  if (!Number.isFinite(startedAt) || startedAt <= 0 || endedAt < startedAt) return null;
  return {
    id: `turn-metrics-${endedAt}`,
    type: 'turn-metrics',
    durationMs: Math.max(0, endedAt - startedAt),
    createdAt: endedAt,
  };
}

/** 回合终态把 turn-metrics 追加到时间线（避免与紧邻的重复记录叠加）。 */
export function appendTurnMetrics(timeline, promptStartedAt, endedAt = Date.now()) {
  const base = Array.isArray(timeline) ? timeline : [];
  const entry = turnMetricsEntry(promptStartedAt, endedAt);
  if (!entry) return base;
  const last = base[base.length - 1];
  if (last?.type === 'turn-metrics') return base;
  return [...base, entry];
}

/** CLI TUI 同款 `Worked for …` 时长文本（秒起步）。 */
export function formatTurnDuration(ms) {
  const totalSeconds = Math.max(1, Math.round(Math.max(0, Number(ms) || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
}
