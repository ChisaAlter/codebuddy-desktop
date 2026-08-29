// G9: 会话历史浏览器数据层（WebUI history 面板契约）。
// 列表：GET /api/v1/jobs/resumable?cwd=…&includeAttached=…&offset=…&limit=…
//   → { candidates: [{sessionId,label,updatedAt,messageCount,…}], hasMore, nextOffset }
// 重命名/删除沿用 ops.js 的 /api/v1/sessions/:id 契约。

import { fetchJson } from './acp';

export function normalizeHistoryCandidate(raw) {
  if (!raw || typeof raw !== 'object' || !raw.sessionId) return null;
  const updatedAt = Number(raw.updatedAt ?? raw.lastActiveAt ?? raw.createdAt);
  const messageCount = Number(raw.messageCount ?? raw.messages);
  return {
    sessionId: String(raw.sessionId),
    label: String(raw.label || raw.title || raw.name || '').trim() || String(raw.sessionId).slice(0, 8),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    messageCount: Number.isFinite(messageCount) ? messageCount : null,
    attached: raw.attached === true,
  };
}

export async function fetchResumableSessions(cwd, { includeAttached = true, offset = 0, limit = 20 } = {}) {
  const params = new URLSearchParams();
  if (cwd) params.set('cwd', cwd);
  if (includeAttached) params.set('includeAttached', 'true');
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  const payload = await fetchJson(`/api/v1/jobs/resumable?${params.toString()}`);
  const data = payload?.data ?? payload ?? {};
  const rawCandidates = Array.isArray(data.candidates) ? data.candidates : [];
  const candidates = rawCandidates.map(normalizeHistoryCandidate).filter(Boolean);
  const nextOffset = Number(data.nextOffset);
  return {
    candidates,
    hasMore: data.hasMore === true,
    nextOffset: Number.isFinite(nextOffset) ? nextOffset : offset + candidates.length,
  };
}

/** WebUI g4：相对时间（刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期）。 */
export function formatHistoryRelativeTime(timestamp, locale = 'zh', now = Date.now()) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '';
  const diff = Math.max(0, now - value);
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (locale === 'zh') {
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes} 分钟前`;
    if (hours < 24) return `${hours} 小时前`;
    if (days < 30) return `${days} 天前`;
    return new Date(value).toLocaleDateString('zh-CN');
  }
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 30) return `${days}d ago`;
  return new Date(value).toLocaleDateString('en-US');
}
