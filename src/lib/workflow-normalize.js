/**
 * Shared normalization primitives for workflow/goal/member state.
 *
 * Single source for firstValue / normalizeStatus — the same status vocabulary
 * must not drift between goal-state.js, workflow-status.js, acp-workflow-events.js
 * and electron/workflow-progress.cjs (cross-process parity is guarded by
 * tests/unit/workflow-status-single-source.test.js).
 */

/** Raw statuses that normalizeStatus maps to 'running'. */
const RUNNING_ALIASES = new Set([
  'working',
  'running',
  'in_progress',
  'in-progress',
  'planning',
  'executing',
]);

/**
 * Canonical statuses considered "active". Only used by isActive-style callers;
 * normalizeStatus itself maps through RUNNING_ALIASES before this matters.
 */
export const ACTIVE_STATUSES = new Set(['running', 'pending', 'waiting']);

export function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '');
}

export function normalizeStatus(value, fallback = 'running') {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['complete', 'completed', 'done', 'success', 'succeeded'].includes(raw)) return 'completed';
  if (['failed', 'failure', 'error'].includes(raw)) return 'failed';
  if (['cancelled', 'canceled', 'aborted'].includes(raw)) return 'cancelled';
  if (['waiting', 'blocked', 'paused'].includes(raw)) return 'waiting';
  if (['pending', 'queued'].includes(raw)) return 'pending';
  if (RUNNING_ALIASES.has(raw)) return 'running';
  return raw;
}
