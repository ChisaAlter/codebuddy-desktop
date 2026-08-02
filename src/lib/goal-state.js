const ACTIVE_STATUSES = new Set(['working', 'running', 'in_progress', 'in-progress', 'pending', 'planning', 'executing']);

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '');
}

function normalizeStatus(value, fallback = 'running') {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['complete', 'completed', 'done', 'success', 'succeeded'].includes(raw)) return 'completed';
  if (['failed', 'failure', 'error'].includes(raw)) return 'failed';
  if (['cancelled', 'canceled', 'aborted'].includes(raw)) return 'cancelled';
  if (['waiting', 'blocked', 'paused'].includes(raw)) return 'waiting';
  if (['pending', 'queued'].includes(raw)) return 'pending';
  if (ACTIVE_STATUSES.has(raw)) return 'running';
  return raw;
}

function normalizeProgress(value) {
  if (value == null) return { current: null, total: null, percent: null, message: '' };
  const source = typeof value === 'object' ? value : { percent: value };
  const currentRaw = firstValue(source.current, source.completed, source.done, source.completedCount);
  const totalRaw = firstValue(source.total, source.count, source.totalCount);
  const percentRaw = firstValue(source.percent, source.percentage, source.progress);
  const current = Number(currentRaw);
  const total = Number(totalRaw);
  let percent = Number(percentRaw);
  if (!Number.isFinite(percent) && Number.isFinite(current) && Number.isFinite(total) && total > 0) {
    percent = (current / total) * 100;
  }
  if (Number.isFinite(percent)) percent = Math.max(0, Math.min(100, percent));
  return {
    current: Number.isFinite(current) ? current : null,
    total: Number.isFinite(total) ? total : null,
    percent: Number.isFinite(percent) ? percent : null,
    message: String(firstValue(source.message, source.detail, source.label, source.description, '') || ''),
  };
}

export function normalizeGoalEvent(payload, eventType = null) {
  const source = payload && typeof payload === 'object' ? payload : { message: payload };
  const progressSource = source.progress ?? source;
  const progress = normalizeProgress(progressSource);
  const goalId = String(firstValue(
    source.goalId,
    source.goal_id,
    source.goal?.id,
    source.id,
    source.key,
    source.name,
    source.title,
    'default',
  ));
  const status = normalizeStatus(firstValue(source.status, source.state, source.goal?.status), eventType === 'goal-status' ? 'completed' : 'running');
  const sequenceRaw = firstValue(source.sequence, source.seq, source.version, source.revision);
  const sequence = Number(sequenceRaw);
  const eventId = firstValue(source.eventId, source.event_id, source.updateId, source.update_id, null);
  const runId = firstValue(source.runId, source.run_id, source.promptRunId, source.prompt_run_id, null);
  const title = String(firstValue(
    source.title,
    source.name,
    source.goal?.title,
    source.goal?.name,
    source.description,
    source.message,
    `Goal ${goalId}`,
  ));
  const message = String(firstValue(source.message, source.detail, source.description, '') || '');
  const updatedAt = Number(firstValue(source.updatedAt, source.updated_at, source.timestamp, source.createdAt)) || Date.now();
  const normalizedType = eventType || source.type || 'goal-progress';
  return {
    ...source,
    type: normalizedType,
    goalId,
    title,
    message,
    status,
    progress,
    runId: runId ? String(runId) : null,
    eventId: eventId ? String(eventId) : null,
    sequence: Number.isFinite(sequence) ? sequence : null,
    updatedAt,
    eventKey: firstValue(
      eventId ? `event:${eventId}` : null,
      Number.isFinite(sequence) ? `${goalId}:sequence:${sequence}` : null,
      `${goalId}:${normalizedType}:${status}:${progress.percent ?? ''}:${message}`,
    ),
  };
}

export function emptyGoalState(mode = null) {
  return {
    mode,
    goalsById: {},
    activeGoalId: null,
    eventCount: 0,
    lastEventAt: 0,
    runId: null,
    updatedAt: 0,
  };
}

export function goalEventKey(payload, eventType = null) {
  return normalizeGoalEvent(payload, eventType).eventKey;
}

function stateGoals(state) {
  return state && typeof state === 'object' && state.goalsById && typeof state.goalsById === 'object'
    ? state.goalsById
    : {};
}

export function mergeGoalEvent(current, payload, eventType = null) {
  const event = payload?.goalId && payload?.eventKey
    ? payload
    : normalizeGoalEvent(payload, eventType);
  const previous = current && typeof current === 'object' ? current : emptyGoalState();
  const existing = stateGoals(previous)[event.goalId];
  // Sequence-bearing events are monotonic. Keep the latest state when a replayed
  // notification arrives out of order, while still allowing status/progress events
  // without a sequence to update the projection.
  if (existing?.lastSequence != null && event.sequence != null && event.sequence < existing.lastSequence) return previous;
  if (existing?.lastEventKey === event.eventKey && previous.eventCount > 0) return previous;
  const nextGoal = {
    ...(existing || {}),
    ...event,
    lastSequence: event.sequence ?? existing?.lastSequence ?? null,
    lastEventKey: event.eventKey,
  };
  const nextGoals = { ...stateGoals(previous), [event.goalId]: nextGoal };
  const terminal = ['completed', 'failed', 'cancelled'].includes(event.status);
  const activeGoalId = terminal && previous.activeGoalId === event.goalId
    ? null
    : (event.status === 'running' || event.status === 'waiting' || !previous.activeGoalId ? event.goalId : previous.activeGoalId);
  return {
    ...emptyGoalState(previous.mode || null),
    ...previous,
    goalsById: nextGoals,
    activeGoalId,
    eventCount: Number(previous.eventCount || 0) + 1,
    lastEventAt: event.updatedAt || Date.now(),
    updatedAt: event.updatedAt || Date.now(),
    runId: event.runId || previous.runId || null,
  };
}

export function goalsFromTimeline(timeline, initialState = null) {
  let state = initialState || emptyGoalState();
  for (const item of Array.isArray(timeline) ? timeline : []) {
    if (!['goal-progress', 'goal-status'].includes(item?.type)) continue;
    const payload = item?.meta || item?.raw || item;
    const event = normalizeGoalEvent(payload, item.type);
    // Older persisted events may not have eventKey; include the timeline id so
    // repeated snapshots do not collapse all updates into one event.
    const withIdentity = item?.id && !payload?.eventId && !payload?.sequence
      ? { ...event, eventKey: `timeline:${item.id}` }
      : event;
    state = mergeGoalEvent(state, withIdentity);
  }
  return state;
}

export function goalList(state) {
  return Object.values(stateGoals(state)).sort((a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0));
}

export function currentGoal(state) {
  const list = goalList(state);
  return state?.activeGoalId && stateGoals(state)[state.activeGoalId]
    ? stateGoals(state)[state.activeGoalId]
    : list[list.length - 1] || null;
}

export function isGoalActive(goal) {
  return Boolean(goal && !['completed', 'failed', 'cancelled'].includes(normalizeStatus(goal.status)));
}

export { normalizeStatus, normalizeProgress };
