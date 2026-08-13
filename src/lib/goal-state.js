import { firstValue, normalizeStatus } from './workflow-normalize';

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
    source.condition,
    `Goal ${goalId}`,
  ));
  const message = String(firstValue(source.message, source.detail, '') || '');
  const condition = firstValue(source.condition, source.goal?.condition, source.criteria, null);
  const reason = firstValue(source.reason, source.goal?.reason, source.cause, null);
  const kind = firstValue(source.kind, source.statusKind, source.goalKind, source.code, null);
  const turnCountRaw = firstValue(source.turnCount, source.turns, source.turn_count, null);
  const turnCount = Number(turnCountRaw);
  const updatedAt = Number(firstValue(source.updatedAt, source.updated_at, source.timestamp, source.createdAt)) || Date.now();
  const normalizedType = eventType || source.type || 'goal-progress';
  return {
    ...source,
    type: normalizedType,
    goalId,
    title,
    // Avoid duplicating title into message when CLI only sent one field.
    message: message && message !== title ? message : String(firstValue(source.detail, '') || ''),
    condition: condition != null ? String(condition) : null,
    reason: reason != null ? String(reason) : null,
    kind: kind != null ? String(kind).toLowerCase() : null,
    turnCount: Number.isFinite(turnCount) ? turnCount : null,
    status,
    progress,
    runId: runId ? String(runId) : null,
    eventId: eventId ? String(eventId) : null,
    sequence: Number.isFinite(sequence) ? sequence : null,
    updatedAt,
    eventKey: firstValue(
      eventId ? `event:${eventId}` : null,
      Number.isFinite(sequence) ? `${goalId}:sequence:${sequence}` : null,
      `${goalId}:${normalizedType}:${status}:${progress.percent ?? ''}:${message}:${condition || ''}`,
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

/** True when the prompt text is a `/goal` slash command (with or without args). */
export function isGoalPrompt(content) {
  return /^\/goal(?:\s|$)/i.test(String(content || '').trim());
}

/** Strip the `/goal` prefix so the remainder can seed the goal title. */
export function goalTitleFromPrompt(content) {
  const text = String(content || '').trim();
  const stripped = text.replace(/^\/goal(?:\s+|$)/i, '').trim();
  return stripped || text || 'Goal';
}

/**
 * Optimistic goal projection for a freshly sent `/goal …` prompt.
 * Gives the right panel something to show before the CLI emits progress events.
 */
export function seedGoalStateFromPrompt(content, runId = null) {
  const title = goalTitleFromPrompt(content);
  const goalId = 'local-seed';
  const now = Date.now();
  const event = normalizeGoalEvent(
    {
      goalId,
      title,
      // message left empty so UI can show localized "waiting for progress"
      message: '',
      status: 'running',
      runId,
      eventId: `seed:${runId || now}`,
      updatedAt: now,
      seeded: true,
      kind: 'active',
    },
    'goal-progress',
  );
  return {
    ...emptyGoalState('goal'),
    goalsById: {
      [goalId]: {
        ...event,
        lastSequence: null,
        lastEventKey: event.eventKey,
      },
    },
    activeGoalId: goalId,
    eventCount: 1,
    lastEventAt: now,
    updatedAt: now,
    runId: runId ? String(runId) : null,
  };
}

/** True when goal state has real CLI progress (not only an empty mode seed). */
export function hasGoalTurnActivity(goalState) {
  if (!goalState || typeof goalState !== 'object') return false;
  if (Number(goalState.eventCount || 0) > 0) return true;
  return Object.keys(stateGoals(goalState)).length > 0;
}

export { normalizeStatus, normalizeProgress };
