// G2: WebUI 2.138 Goal Bar 的 REST 契约（/api/v1/goal*）与纯展示逻辑。
// 快照形如 { active: { condition, createdAt, paused?, pausedAt? } | null }。

import { fetchJson } from './acp';

function unwrap(payload) {
  return payload?.data ?? payload ?? null;
}

export async function fetchGoalSnapshot(sessionId) {
  if (!sessionId) return null;
  return unwrap(await fetchJson(`/api/v1/goal?sessionId=${encodeURIComponent(sessionId)}`));
}

async function postGoalAction(action, sessionId) {
  const payload = await fetchJson(`/api/v1/goal/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  return unwrap(payload);
}

export function pauseGoal(sessionId) {
  return postGoalAction('pause', sessionId);
}

export function resumeGoal(sessionId) {
  return postGoalAction('resume', sessionId);
}

export function clearGoal(sessionId) {
  return postGoalAction('clear', sessionId);
}

/** WebUI aR：从快照提取 goal bar 状态；无 active.condition 时返回 null。 */
export function activeGoalFromSnapshot(snapshot) {
  const active = snapshot?.active;
  if (!active?.condition) return null;
  return {
    condition: String(active.condition),
    createdAt: Number(active.createdAt) || Date.now(),
    ...(typeof active.pausedAt === 'number' ? { pausedAt: active.pausedAt } : {}),
    paused: active.paused === true || typeof active.pausedAt === 'number',
  };
}

/** WebUI j4：暂停后计时冻结在 pausedAt。 */
export function goalElapsedMs(goal, now = Date.now()) {
  if (!goal) return 0;
  const end = typeof goal.pausedAt === 'number' ? goal.pausedAt : now;
  return Math.max(0, end - (Number(goal.createdAt) || now));
}

/** WebUI P4：1s 起步的 `Ns` / `Nm Ns` / `Nh Nm` 计时文本。 */
export function formatGoalElapsed(ms) {
  const totalSeconds = Math.max(1, Math.floor(Math.max(0, ms) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
}

/** WebUI L4：`/goal <条件>`（且不是 clear/show/pause/resume 子命令）才是设定目标。 */
export function isGoalSetPrompt(text) {
  const trimmed = String(text || '').trim();
  if (!/^\/goal\s+\S/i.test(trimmed)) return false;
  const first = trimmed.replace(/^\/goal\s+/i, '').trim().split(/\s+/)[0]?.toLowerCase();
  return first !== 'clear' && first !== 'show' && first !== 'pause' && first !== 'resume';
}

/** WebUI recap 统计行：`3s · 2 turns · 1.2k tokens`。 */
export function formatGoalRecapStats(recapLatest, t) {
  if (!recapLatest) return '';
  const seconds = Math.max(1, Math.round((Number(recapLatest.durationMs) || 0) / 1000));
  const turns = Number(recapLatest.turnCount) || 0;
  const tokens = Number(recapLatest.tokenDelta) || 0;
  const turnLabel = t(turns === 1 ? 'goal.recap.stats.turn' : 'goal.recap.stats.turns');
  const tokenLabel = t(tokens === 1 ? 'goal.recap.stats.token' : 'goal.recap.stats.tokens');
  const compactTokens =
    !Number.isFinite(tokens) || tokens < 0
      ? '0'
      : tokens < 1e3
        ? String(tokens)
        : tokens < 1e6
          ? `${(tokens / 1e3).toFixed(1)}k`
          : `${(tokens / 1e6).toFixed(1)}M`;
  return `${seconds}s · ${turns} ${turnLabel} · ${compactTokens} ${tokenLabel}`;
}

/** 归一 codebuddy.ai/goalRecap 元数据（active 或 latest 终态其一）。 */
export function normalizeGoalRecap(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.active?.condition) {
    return {
      active: {
        condition: String(payload.active.condition),
        paused: payload.active.paused === true,
        ...(typeof payload.active.createdAt === 'number' ? { createdAt: payload.active.createdAt } : {}),
        ...(typeof payload.active.pausedAt === 'number' ? { pausedAt: payload.active.pausedAt } : {}),
      },
    };
  }
  if (payload.latest && typeof payload.latest === 'object') {
    return {
      latest: {
        ok: payload.latest.ok === true,
        condition: String(payload.latest.condition || ''),
        reason: payload.latest.reason != null ? String(payload.latest.reason) : null,
        durationMs: Number(payload.latest.durationMs) || 0,
        turnCount: Number(payload.latest.turnCount) || 0,
        tokenDelta: Number(payload.latest.tokenDelta) || 0,
      },
    };
  }
  return null;
}
