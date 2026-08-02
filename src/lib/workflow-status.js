import { currentGoal, goalList, goalsFromTimeline } from './goal-state';

const ACTIVE_STATUSES = new Set(['working', 'running', 'in_progress', 'pending', 'planning', 'waiting']);

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
  if (['working', 'running', 'in_progress', 'in-progress', 'planning', 'executing'].includes(raw)) return 'running';
  return raw;
}

function isActive(status) {
  return ACTIVE_STATUSES.has(normalizeStatus(status));
}

function normalizeProgress(value) {
  if (value == null) return null;
  const source = typeof value === 'object' ? value : { type: value };
  const currentRaw = firstValue(source.current, source.completed, source.done, source.completedCount);
  const totalRaw = firstValue(source.total, source.count, source.totalCount);
  const percentRaw = firstValue(source.percent, source.percentage);
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
    message: firstValue(source.message, source.detail, source.label, source.description) || '',
  };
}

function normalizeMember(member, index, fallbackStatus) {
  const source = member && typeof member === 'object' ? member : { name: member };
  const status = normalizeStatus(firstValue(source.status, source.state, source.phase), fallbackStatus);
  return {
    id: firstValue(source.id, source.agentId, source.subagentId, source.taskId, source.sessionId, source.name, `member-${index + 1}`),
    name: firstValue(source.name, source.agentName, source.displayName, source.role, `Member ${index + 1}`),
    role: firstValue(source.role, source.agentType, source.kind, ''),
    task: firstValue(
      source.task,
      source.currentTask,
      source.prompt,
      source.description,
      source.message,
      source.title,
      '',
    ),
    description: firstValue(source.description, source.task, source.prompt, ''),
    color: firstValue(source.color, source.agentColor, null),
    taskId: firstValue(source.taskId, null),
    sessionId: firstValue(source.sessionId, null),
    status,
    progress: normalizeProgress(source.progress ?? source),
    startedAt: Number(firstValue(source.startedAt, source.createdAt)) || null,
    completedAt: Number(firstValue(source.completedAt, source.finishedAt, source.endedAt)) || null,
    tokenUsage: source.tokenUsage && typeof source.tokenUsage === 'object' ? { ...source.tokenUsage } : null,
    toolCallCount: Number.isFinite(Number(source.toolCallCount)) ? Number(source.toolCallCount) : 0,
    historyAvailable: false,
  };
}

function memberList(teamState) {
  if (!teamState || typeof teamState !== 'object') return [];
  const members = teamState.members || teamState.agents || teamState.subagents;
  return Array.isArray(members) ? members : [];
}

function currentTurnEntries(timeline, promptStartedAt) {
  const entries = Array.isArray(timeline) ? timeline : [];
  const startedAt = Number(promptStartedAt);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return entries;
  let start = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const item = entries[index];
    if (item?.type !== 'message' || item?.role !== 'user') continue;
    const createdAt = Number(item.createdAt);
    if (!Number.isFinite(createdAt) || createdAt >= startedAt) {
      start = index;
      break;
    }
  }
  return entries.slice(start + 1);
}

function toolStep(item, index) {
  const payload = item?.meta || item?.raw || item || {};
  const input = item?.rawInput;
  const summary = typeof input === 'string'
    ? input.replace(/\s+/g, ' ').trim()
    : firstValue(
        input?.command,
        input?.path,
        input?.file_path,
        input?.filePath,
        input?.pattern,
        input?.query,
        input?.description,
        payload.message,
        '',
      );
  return {
    id: firstValue(item?.toolCallId, item?.id, `tool-${index + 1}`),
    name: firstValue(item?.title, item?.toolName, item?.name, item?.kind, 'Tool'),
    task: summary,
    status: normalizeStatus(item?.status, 'running'),
    progress: null,
    startedAt: Number(item?.createdAt) || null,
    completedAt: Number(item?.completedAt) || null,
    kind: 'tool',
  };
}

function taskStep(item, index) {
  const payload = item?.meta || item?.raw || item || {};
  const task = payload.task && typeof payload.task === 'object' ? payload.task : payload;
  return {
    id: firstValue(task.id, item?.id, `task-${index + 1}`),
    name: firstValue(task.title, task.name, task.subject, 'Task'),
    task: firstValue(task.content, task.description, task.message, task.condition, ''),
    status: normalizeStatus(firstValue(task.status, item?.status), item?.type === 'taskCreated' ? 'pending' : 'running'),
    progress: normalizeProgress(task.progress ?? task),
    startedAt: Number(firstValue(task.startedAt, item?.createdAt)) || null,
    completedAt: Number(firstValue(task.completedAt, task.finishedAt, item?.completedAt)) || null,
    kind: 'task',
  };
}

function fallbackSteps(entries) {
  const steps = [];
  const taskIndex = new Map();
  for (const [index, item] of entries.entries()) {
    if (item?.type === 'tool_call') {
      steps.push(toolStep(item, index));
      continue;
    }
    if (!['taskCreated', 'taskStatus', 'goal-progress', 'goal-status'].includes(item?.type)) continue;
    const step = taskStep(item, index);
    const existingIndex = taskIndex.get(step.id);
    if (existingIndex === undefined) {
      taskIndex.set(step.id, steps.length);
      steps.push(step);
    } else {
      steps[existingIndex] = { ...steps[existingIndex], ...step };
    }
  }
  return steps;
}

function phaseValue(agentPhase, progress) {
  const phase = typeof agentPhase === 'string' ? agentPhase : agentPhase?.phase || agentPhase?.type;
  const progressType = typeof progress === 'string' ? progress : progress?.type;
  return firstValue(progressType, phase, '') || '';
}

export function normalizeWorkflowStatus({ runtime = {}, threadStatus = 'idle', timeline, now = Date.now() } = {}) {
  const promptStartedAt = Number(runtime.promptStartedAt) || null;
  const entries = currentTurnEntries(timeline ?? runtime.timeline, promptStartedAt);
  const teamSnapshot = runtime.teamState || runtime.lastTeamState || null;
  const activeTeam = Boolean(runtime.teamState?.active !== false && runtime.teamState);
  const members = memberList(teamSnapshot).map((member, index) => {
    const normalized = normalizeMember(
      member,
      index,
      runtime.activePromptRunId || runtime.isAwaitingResponse || activeTeam ? 'running' : 'idle',
    );
    return {
      ...normalized,
      historyAvailable: Boolean(runtime.memberHistoriesByName?.[normalized.name]?.length),
    };
  });
  const steps = members.length ? [] : fallbackSteps(entries);
  const projectedGoals = runtime.goalState || runtime.lastGoalState || goalsFromTimeline(entries);
  const goals = goalList(projectedGoals);
  const projectedGoal = currentGoal(projectedGoals);
  if (!members.length && projectedGoal) {
    const goalStep = {
      id: `goal:${projectedGoal.goalId}`,
      name: projectedGoal.title,
      task: projectedGoal.message,
      status: normalizeStatus(projectedGoal.status),
      progress: projectedGoal.progress,
      startedAt: projectedGoal.updatedAt,
      completedAt: ['completed', 'failed', 'cancelled'].includes(projectedGoal.status) ? projectedGoal.updatedAt : null,
      kind: 'goal',
    };
    const existingGoalIndex = steps.findIndex((item) => item.id === goalStep.id);
    if (existingGoalIndex >= 0) steps[existingGoalIndex] = { ...steps[existingGoalIndex], ...goalStep };
    else steps.push(goalStep);
  }
  const items = members.length ? members : steps;
  const source = members.length
    ? 'team'
    : steps.length
      ? (projectedGoals.eventCount ? 'goal' : 'timeline')
      : runtime.teamState
        ? 'team'
        : runtime.workflowState
          ? 'workflow'
          : runtime.lastTeamState
            ? 'team'
            : null;
  const pendingPermission =
    (Array.isArray(runtime.permissionRequests) &&
      runtime.permissionRequests.some((item) => !['resolved', 'expired', 'cancelled'].includes(item?.status))) ||
    (Array.isArray(runtime.questions) &&
      runtime.questions.some((item) => !['answered', 'expired', 'cancelled'].includes(item?.status)));
  const explicitCount = Number(
    firstValue(teamSnapshot?.memberCount, teamSnapshot?.agentCount, teamSnapshot?.totalMembers, runtime.workflowState?.agentCount),
  );
  const reportedCount = Number.isFinite(explicitCount) && explicitCount > 0 ? explicitCount : items.length;
  const activeThread = ['running', 'waiting', 'cancelling'].includes(threadStatus);
  const activeItems = items.filter((item) => isActive(item.status));
  const failedCount = items.filter((item) => item.status === 'failed').length;
  const completedCount = items.filter((item) => item.status === 'completed').length;
  const progress = normalizeProgress(runtime.progress || runtime.workflowState?.progress || projectedGoal?.progress);
  const phase = pendingPermission ? 'waiting_for_permission' : phaseValue(runtime.agentPhase, runtime.progress || runtime.workflowState);
  const startedAt = Number(
    firstValue(
      teamSnapshot?.startedAt,
      runtime.workflowState?.startedAt,
      runtime.agentPhase?.startedAt,
      runtime.progress?.startedAt,
      promptStartedAt,
      items.find((item) => item.startedAt)?.startedAt,
    ),
  ) || null;
  const terminal = !activeThread && !runtime.activePromptRunId && !runtime.isAwaitingResponse && !pendingPermission;
  const visible = Boolean(
    source || phase || progress || runtime.historyReplayActive || pendingPermission || runtime.lastTeamState,
  ) && (!terminal || source === 'team' || runtime.lastTeamState);
  const memberStatuses = members.map((item) => item.status);
  const membersActive = memberStatuses.some((status) => isActive(status));
  const active = Boolean(
    runtime.historyReplayActive ||
      runtime.activePromptRunId ||
      runtime.isAwaitingResponse ||
      activeThread ||
      (activeTeam && (members.length === 0 || membersActive)) ||
      activeItems.length ||
      pendingPermission ||
      runtime.workflowState?.active,
  );
  const snapshotStatus = normalizeStatus(teamSnapshot?.status, 'completed');
  const status = failedCount > 0 || snapshotStatus === 'failed'
    ? 'failed'
    : snapshotStatus === 'cancelled'
      ? 'cancelled'
      : active
        ? threadStatus === 'waiting' || pendingPermission || items.some((item) => item.status === 'waiting')
          ? 'waiting'
          : 'running'
        : completedCount > 0 || phase === 'idle' || snapshotStatus === 'completed'
          ? 'completed'
          : 'idle';
  const tokenTotals = members.reduce((totals, member) => {
    totals.inputTokens += Number(member.tokenUsage?.inputTokens || 0);
    totals.outputTokens += Number(member.tokenUsage?.outputTokens || 0);
    return totals;
  }, { inputTokens: 0, outputTokens: 0 });
  const toolCallCount = members.reduce((count, member) => count + member.toolCallCount, 0);

  return {
    visible,
    active,
    status,
    phase,
    progress,
    source,
    items,
    members,
    steps,
    reportedCount,
    activeCount: activeItems.length,
    completedCount,
    failedCount,
    startedAt,
    durationMs: startedAt ? Math.max(0, (active ? now : Number(runtime.completedAt) || now) - startedAt) : 0,
    teamName: firstValue(teamSnapshot?.teamName, teamSnapshot?.name, runtime.workflowState?.name, ''),
    teamStatus: teamSnapshot?.status || null,
    runId: firstValue(runtime.workflowState?.runId, runtime.activePromptRunId, teamSnapshot?.runId, null),
    tokenTotals,
    toolCallCount,
    detailsAvailable: members.length > 0 || Boolean(runtime.memberHistoriesByName && Object.keys(runtime.memberHistoriesByName).length),
    inferred: source === 'timeline',
    capabilityMessage: source === 'workflow' && members.length === 0 ? 'aggregate-only' : null,
    goals,
    currentGoal: projectedGoal,
    goalMode: projectedGoals.mode || null,
    goalEventCount: Number(projectedGoals.eventCount || 0),
  };
}

export function workflowHasActivity(status) {
  return Boolean(status?.active && status?.visible);
}
