import { currentGoal, goalList, goalsFromTimeline } from './goal-state';
import { ACTIVE_STATUSES, firstValue, normalizeStatus } from './workflow-normalize';

// M4 单源状态文案：normalizeStatus 输出键 → i18n 键（组件 t() 渲染）。
// 与 STATUS_LABELS 同源，避免组件内另维护一份中文映射。
export const STATUS_LABELS = {
  pending: 'workflow.status.pending',
  running: 'workflow.status.running',
  working: 'workflow.status.working',
  in_progress: 'workflow.status.working',
  'in-progress': 'workflow.status.working',
  waiting: 'workflow.status.waiting',
  blocked: 'workflow.status.blocked',
  queued: 'workflow.status.pending',
  completed: 'workflow.status.completed',
  done: 'workflow.status.completed',
  success: 'workflow.status.completed',
  succeeded: 'workflow.status.completed',
  failed: 'workflow.status.failed',
  error: 'workflow.status.failed',
  cancelled: 'workflow.status.cancelled',
  canceled: 'workflow.status.cancelled',
  idle: 'workflow.status.idle',
};


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
    agentId: firstValue(source.agentId, source.agent_id, null),
    subagentId: firstValue(source.subagentId, source.subagent_id, null),
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
  let start = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const item = entries[index];
    if (item?.type !== 'message' || item?.role !== 'user') continue;
    const createdAt = Number(item.createdAt);
    if (
      !Number.isFinite(startedAt) ||
      startedAt <= 0 ||
      !Number.isFinite(createdAt) ||
      createdAt >= startedAt
    ) {
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
  // Prefer short toolName over long display titles that already embed paths.
  const toolName = firstValue(item?.toolName, item?.name, item?.kind, '');
  const title = firstValue(item?.title, toolName, 'Tool');
  const shortName = toolName
    ? String(toolName).replace(/Tool$/i, '')
    : String(title).split(/\s+/)[0] || 'Tool';
  return {
    id: firstValue(item?.toolCallId, item?.id, `tool-${index + 1}`),
    name: shortName,
    task: summary || (title !== shortName ? title : ''),
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
  const tools = [];
  for (const [index, item] of entries.entries()) {
    if (item?.type === 'tool_call') {
      tools.push(toolStep(item, index));
      continue;
    }
    // Only real task/goal bookkeeping counts as workflow "steps". Ordinary tools are tracked separately.
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
  return { steps, tools };
}

function hasExplicitSubagentActivity(entries) {
  return (Array.isArray(entries) ? entries : []).some(
    (item) =>
      item?.type === 'tool_call' &&
      (item?.isSubAgent || item?.memberName || item?.subagentType),
  );
}

function phaseValue(agentPhase, progress) {
  const phase = typeof agentPhase === 'string' ? agentPhase : agentPhase?.phase || agentPhase?.type;
  const progressType = typeof progress === 'string' ? progress : progress?.type;
  return firstValue(progressType, phase, '') || '';
}

// M3：normalizeWorkflowStatus 引用级记忆化——相同 (runtime, threadStatus, timeline)
// 引用直接返回上次结果，避免面板各子段重复派生同一输入（有界 Map 防泄漏）。
const NORMALIZE_VIEW_CACHE_LIMIT = 50;
const normalizeViewCache = new Map();

export function normalizeWorkflowStatus({ runtime = {}, threadStatus = 'idle', timeline, now = Date.now() } = {}) {
  const timelineKey = timeline ?? runtime.timeline ?? null;
  const cached = normalizeViewCache.get(runtime);
  if (cached && cached.threadStatus === threadStatus && cached.timeline === timelineKey) {
    return cached.result;
  }
  const result = computeWorkflowStatus(runtime, threadStatus, timelineKey, now);
  if (normalizeViewCache.size >= NORMALIZE_VIEW_CACHE_LIMIT) {
    // Map 迭代顺序 = 插入顺序：淘汰最旧条目
    normalizeViewCache.delete(normalizeViewCache.keys().next().value);
  }
  normalizeViewCache.set(runtime, { threadStatus, timeline: timelineKey, result });
  return result;
}

function computeWorkflowStatus(runtime, threadStatus, timeline, now) {
  const promptStartedAt = Number(runtime.promptStartedAt) || null;
  const entries = currentTurnEntries(timeline ?? runtime.timeline, promptStartedAt);
  const workflowSnapshot = runtime.workflowState || runtime.lastWorkflowState || null;
  const hasTeamSnapshot = Boolean(runtime.teamState || runtime.lastTeamState);
  const teamSnapshot = runtime.teamState || runtime.lastTeamState || workflowSnapshot || null;
  const activeTeam = Boolean(runtime.teamState?.active !== false && runtime.teamState);
  const activeWorkflow = runtime.workflowState?.active === true;
  const members = memberList(teamSnapshot).map((member, index) => {
    const normalized = normalizeMember(
      member,
      index,
      runtime.activePromptRunId || runtime.isAwaitingResponse || activeTeam || activeWorkflow ? 'running' : 'idle',
    );
    return {
      ...normalized,
      historyAvailable: Boolean(runtime.memberHistoriesByName?.[normalized.name]?.length),
    };
  });
  const fallback = members.length ? { steps: [], tools: [] } : fallbackSteps(entries);
  const steps = fallback.steps;
  const toolItems = fallback.tools;
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
  // Panel/activity items: members > real steps > (tools only as tools source, not fake workflow steps)
  const items = members.length ? members : steps;
  const explicitSubagent = hasExplicitSubagentActivity(entries);
  const source = members.length
    ? hasTeamSnapshot ? 'team' : 'workflow'
    : projectedGoal || Number(projectedGoals.eventCount || 0) > 0
      ? 'goal'
      : steps.length
        ? 'timeline'
        : toolItems.length
          ? 'tools'
          : runtime.teamState
            ? 'team'
            : runtime.workflowState
              ? 'workflow'
              : runtime.lastTeamState
                ? 'team'
                : explicitSubagent
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
  const activeThread = ['running', 'waiting', 'cancelling'].includes(threadStatus);
  // 终态回合：无活动 run、无等待权限。此时工具/条目一律不计为“运行中”，
  // 否则取消或中断后停在非终态的工具会残留「正在执行工具」活动标签。
  const terminal = !activeThread && !runtime.activePromptRunId && !runtime.isAwaitingResponse && !pendingPermission && !activeWorkflow;
  const toolsRunningCount = terminal ? 0 : toolItems.filter((item) => isActive(item.status)).length;
  const toolsFailedCount = toolItems.filter((item) => item.status === 'failed').length;
  const toolsCompletedCount = toolItems.filter((item) => item.status === 'completed').length;
  const activeItems = terminal ? [] : items.filter((item) => isActive(item.status));
  // When the panel falls back to tools-only, count tool terminal states — steps/members are empty.
  const usingToolsAsItems = !members.length && !steps.length && toolItems.length > 0;
  const failedCount = usingToolsAsItems
    ? toolsFailedCount
    : items.filter((item) => item.status === 'failed').length;
  const completedCount = usingToolsAsItems
    ? toolsCompletedCount
    : items.filter((item) => item.status === 'completed').length;
  const progress = normalizeProgress(runtime.progress || runtime.workflowState?.progress || projectedGoal?.progress);
  const phase = pendingPermission
    ? 'waiting_for_permission'
    : toolsRunningCount > 0 && !members.length && !steps.length
      ? 'tool_executing'
      : phaseValue(runtime.agentPhase, runtime.progress || runtime.workflowState);
  const startedAt = Number(
    firstValue(
      teamSnapshot?.startedAt,
      runtime.workflowState?.startedAt,
      runtime.agentPhase?.startedAt,
      runtime.progress?.startedAt,
      promptStartedAt,
      items.find((item) => item.startedAt)?.startedAt,
      toolItems.find((item) => item.startedAt)?.startedAt,
    ),
  ) || null;
  // Visible only with real orchestration signal — not a bare phase string / leftover empty objects.
  const visible = Boolean(
    (source && (members.length > 0 || steps.length > 0 || toolItems.length > 0 || projectedGoal || source === 'workflow')) ||
      pendingPermission ||
      runtime.historyReplayActive ||
      (source === 'team' && runtime.lastTeamState && members.length > 0) ||
      (source === 'goal' && projectedGoal),
  ) && (!terminal || source === 'team' || source === 'goal' || (source === 'workflow' && members.length > 0));
  const memberStatuses = members.map((item) => item.status);
  const membersActive = memberStatuses.some((status) => isActive(status));
  const hasOrchestration = Boolean(
    members.length > 0 ||
      steps.length > 0 ||
      toolItems.length > 0 ||
      projectedGoal ||
      pendingPermission ||
      runtime.historyReplayActive ||
      (source === 'workflow' && runtime.workflowState) ||
      explicitSubagent,
  );
  // "Active workflow" requires orchestration content — a running prompt alone is not a workflow.
  const active = Boolean(
    hasOrchestration &&
      (
        runtime.historyReplayActive ||
        runtime.activePromptRunId ||
        runtime.isAwaitingResponse ||
        activeThread ||
        (activeTeam && (members.length === 0 || membersActive)) ||
        activeItems.length ||
        toolsRunningCount > 0 ||
        pendingPermission ||
        runtime.workflowState?.active
      ),
  );
  // Auto-open only for real orchestration — not ordinary TaskCreate tool spam.
  const shouldAutoOpen = Boolean(
    (activeThread || activeWorkflow) &&
      (runtime.activePromptRunId || runtime.isAwaitingResponse || active) &&
      (
        (source === 'team' && members.length > 0) ||
        source === 'goal' ||
        (source === 'workflow' && Boolean(runtime.workflowState)) ||
        explicitSubagent
      ),
  );
  // Only read team snapshot status when a team actually exists. normalizeStatus(undefined, 'completed')
  // used to force empty panels into "已完成" + phase fallback "正在执行".
  const snapshotStatus = teamSnapshot
    ? normalizeStatus(teamSnapshot.status, active ? 'running' : 'completed')
    : null;
  const status = !hasOrchestration
    ? 'idle'
    : failedCount > 0 || snapshotStatus === 'failed'
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

  const reportedCount = Number.isFinite(explicitCount) && explicitCount > 0
    ? explicitCount
    : members.length || steps.length || toolItems.length;
  return {
    visible,
    active,
    shouldAutoOpen,
    status,
    phase,
    progress,
    source,
    // 回合是否已终态（无活动 run / 无等待权限）。终态时活动标签必须收敛为 null，
    // 防止「正在执行工具」等陈旧提示残留在输入框上方。
    terminal,
    items: members.length || steps.length ? items : toolItems,
    members,
    steps,
    tools: toolItems,
    toolsRunningCount,
    reportedCount,
    // Activity "count": members/steps when present; else running tools (never "N TaskCreates = N workflow steps").
    activeCount: members.length || steps.length ? activeItems.length : toolsRunningCount,
    completedCount,
    failedCount,
    toolsCompletedCount,
    toolsFailedCount,
    startedAt,
    durationMs: startedAt ? Math.max(0, (active ? now : Number(runtime.completedAt) || now) - startedAt) : 0,
    teamName: firstValue(teamSnapshot?.teamName, teamSnapshot?.name, runtime.workflowState?.name, ''),
    teamStatus: teamSnapshot?.status || null,
    runId: firstValue(runtime.workflowState?.runId, runtime.activePromptRunId, teamSnapshot?.runId, null),
    tokenTotals,
    toolCallCount: toolCallCount || toolItems.length,
    detailsAvailable: members.length > 0 || Boolean(runtime.memberHistoriesByName && Object.keys(runtime.memberHistoriesByName).length) || toolItems.length > 0,
    inferred: source === 'timeline' || source === 'tools',
    capabilityMessage: source === 'workflow' && members.length === 0 ? 'aggregate-only' : source === 'tools' ? 'tools-only' : null,
    goals,
    currentGoal: projectedGoal,
    goalMode: projectedGoals.mode || null,
    goalEventCount: Number(projectedGoals.eventCount || 0),
  };
}

export function workflowHasActivity(status) {
  return Boolean(status?.active && status?.visible);
}

/**
 * Single product view-model for topbar / floating panel / activity strip.
 * Empty-first + orchestration-only panel contract (hybrid A):
 * - kind==='empty' ⇒ no status chrome, no phase chrome, no topbar highlight
 * - never emit status='completed' with visible=false
 * - ordinary tools-only turns stay empty for the floating panel (process lives in chat)
 * - panel/topbar only light up for real orchestration: team / goal / workflow / task steps / permission / reports
 */
export function deriveWorkflowView({ runtime = {}, threadStatus = 'idle', timeline, now = Date.now() } = {}) {
  const base = normalizeWorkflowStatus({ runtime, threadStatus, timeline, now });
  const hasMembers = Array.isArray(base.members) && base.members.length > 0;
  const hasSteps = Array.isArray(base.steps) && base.steps.length > 0;
  const hasGoal = Boolean(base.currentGoal);
  const hasPermissionPhase = base.phase === 'waiting_for_permission';
  const reports = Array.isArray(runtime.subagentReports)
    ? runtime.subagentReports
    : Array.isArray(runtime.lastSubagentReports)
      ? runtime.lastSubagentReports
      : [];
  const hasReports = reports.length > 0;
  const hasWorkflowAggregate = base.source === 'workflow' || Boolean(runtime.workflowState || runtime.lastWorkflowState);

  // Panel kinds — tools-only is intentionally not a panel kind.
  let kind = 'empty';
  if (hasPermissionPhase) kind = 'permission';
  else if (base.source === 'team' && (hasMembers || hasReports || base.active)) kind = 'team';
  else if (base.source === 'goal' || hasGoal) kind = 'goal';
  else if (hasWorkflowAggregate) kind = 'workflow';
  else if (base.source === 'timeline' && hasSteps) kind = 'timeline';
  else if (hasReports) kind = 'team';
  else kind = 'empty';

  const empty = kind === 'empty';
  const resolvedKind = empty ? 'empty' : kind;

  // Hard invariants for chrome
  const status = empty ? 'idle' : base.status === 'idle' && base.active ? 'running' : base.status;
  const phase = empty ? '' : base.phase || '';
  const highlightTopbar = !empty && (
    base.active ||
    hasMembers ||
    hasGoal ||
    hasReports ||
    status === 'failed' ||
    kind === 'team' ||
    kind === 'goal' ||
    kind === 'workflow'
  );
  const showStatus = !empty && status && status !== 'idle';
  const showPhase = !empty && Boolean(phase);

  return {
    ...base,
    // Force consistent empty fields even if base drifts.
    visible: empty ? false : base.visible,
    active: empty ? false : base.active,
    status,
    phase,
    kind: resolvedKind,
    empty,
    // Surface tools-only for debugging/tests without treating it as panel content.
    toolsOnly: base.source === 'tools' || base.capabilityMessage === 'tools-only',
    highlightTopbar,
    showStatus,
    showPhase,
    shouldAutoOpen: empty ? false : base.shouldAutoOpen,
  };
}

/** Presenter: one-line chat activity label keys/params (caller translates). */
export function presentWorkflowActivity(status, t) {
  const model = status;
  if (!model) return null;
  // Chat activity may still describe tools-only process; the floating panel stays empty for that case.
  const toolsOnly = Boolean(
    model.toolsOnly ||
      model.source === 'tools' ||
      model.kind === 'tools' ||
      model.phase === 'tool_executing',
  );
  if (model.empty && !toolsOnly) return null;
  if (!model.empty && !toolsOnly && !workflowHasActivity(model)) return null;
  if (model.source === 'team' && (model.activeCount || model.members?.length)) {
    return t('workflow.activityAgents', { count: model.activeCount || model.members.length });
  }
  if (model.source === 'goal' || model.kind === 'goal') {
    const percent = model.progress?.percent;
    if (Number.isFinite(percent)) return t('workflow.activityGoalPercent', { percent: Math.round(percent) });
    return t('workflow.activityGoal');
  }
  if (toolsOnly) {
    // 终态回合（对话已完成/被取消）绝不下发「正在执行工具」——此时没有任何工具在运行。
    // 非终态且计数为 0（工具条目暂无 running 态）时保留通用标签，避免闪烁。
    if (model.terminal) return null;
    const count = model.toolsRunningCount || model.activeCount || 0;
    return count > 0 ? t('workflow.activityTools', { count }) : t('sessionActivity.tool');
  }
  if (model.source === 'timeline' && model.activeCount > 0) {
    return t('workflow.activitySteps', { count: model.activeCount });
  }
  return null;
}

/**
 * Presenter: whether the workflow panel should auto-open for this run.
 * M2 dismissed 竞态修复：dismissed 为 { runId, at } 结构
 * - 时间窗（DISMISS_WINDOW_MS 内）：任何自动打开都被抑制（防 closing 220ms 期闪回）
 * - 同 runId：永久不自动重开（用户手动关闭的意图）
 * - 超窗 + 不同 runId：允许自动打开
 */
export const DISMISS_WINDOW_MS = 3000;

export function shouldWorkflowAutoOpen(status, { dismissed = null, runId = null } = {}) {
  if (!status || status.empty || !status.shouldAutoOpen) return false;
  if (dismissed && Number.isFinite(dismissed.at)) {
    if (Date.now() - dismissed.at < DISMISS_WINDOW_MS) return false;
  }
  const id = runId || status.runId;
  if (id && dismissed?.runId && String(dismissed.runId) === String(id)) return false;
  return true;
}

/** Topbar highlight — same source as panel empty contract. */
export function shouldShowWorkflowTopbarHighlight(runtime = {}, threadStatus = 'idle', timeline) {
  return deriveWorkflowView({ runtime, threadStatus, timeline }).highlightTopbar;
}
