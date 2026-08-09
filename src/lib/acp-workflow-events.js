const TEAM_META_KEY = 'codebuddy.ai/teamUpdate';
const MEMBER_EVENT_META_KEY = 'codebuddy.ai/memberEvent';
const SUBAGENT_META_KEYS = {
  parentToolCallId: 'codebuddy.ai/parentToolCallId',
  isSubagent: 'codebuddy.ai/isSubAgent',
  subagentType: 'codebuddy.ai/subagentType',
  description: 'codebuddy.ai/description',
  isBackground: 'codebuddy.ai/isBackground',
  memberName: 'codebuddy.ai/memberName',
};
const MAX_RAW_EXTENSION_EVENTS = 100;
const WORKFLOW_META_KEYS = {
  state: 'codebuddy.ai/workflowState',
  update: 'codebuddy.ai/workflowUpdate',
};
const WORKFLOW_PROGRESS_META_KEYS = {
  kind: 'codebuddy.ai/workflowEventKind',
  runId: 'codebuddy.ai/workflowRunId',
  name: 'codebuddy.ai/workflowName',
  status: 'codebuddy.ai/workflowStatus',
  agentCount: 'codebuddy.ai/workflowAgentCount',
  cachedCount: 'codebuddy.ai/workflowCachedCount',
  phaseCount: 'codebuddy.ai/workflowPhaseCount',
  error: 'codebuddy.ai/workflowError',
  phase: 'codebuddy.ai/workflowPhase',
  agentKey: 'codebuddy.ai/workflowAgentKey',
  agentLabel: 'codebuddy.ai/workflowAgentLabel',
  agentPhase: 'codebuddy.ai/workflowAgentPhase',
  agentError: 'codebuddy.ai/workflowAgentError',
  agentTokens: 'codebuddy.ai/workflowAgentTokens',
};

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '');
}

function memberIdentity(member, index = 0) {
  return String(firstValue(
    member?.taskId,
    member?.sessionId,
    member?.id,
    member?.name,
    `member-${index + 1}`,
  ));
}

function normalizeMember(member, index = 0) {
  const source = member && typeof member === 'object' ? member : { name: member };
  return {
    ...source,
    id: memberIdentity(source, index),
    name: String(firstValue(
      source.name,
      source.agentName,
      source.displayName,
      source.role,
      `Member ${index + 1}`,
    )),
    color: firstValue(source.color, source.agentColor, null),
    description: firstValue(source.description, source.prompt, source.task, ''),
    status: firstValue(source.status, source.state, source.phase, 'pending'),
    taskId: firstValue(source.taskId, source.id, null),
    sessionId: firstValue(source.sessionId, null),
    agentId: firstValue(source.agentId, source.agent_id, null),
    subagentId: firstValue(source.subagentId, source.subagent_id, null),
    tokenUsage: source.tokenUsage && typeof source.tokenUsage === 'object'
      ? { ...source.tokenUsage }
      : null,
    toolCallCount: Number.isFinite(Number(source.toolCallCount))
      ? Number(source.toolCallCount)
      : 0,
  };
}

function mergeMembers(previous = [], incoming = []) {
  const result = new Map();
  for (const [index, member] of (Array.isArray(previous) ? previous : []).entries()) {
    const normalized = normalizeMember(member, index);
    result.set(memberIdentity(normalized, index), normalized);
  }
  for (const [index, member] of (Array.isArray(incoming) ? incoming : []).entries()) {
    const source = member && typeof member === 'object' ? member : { name: member };
    const normalized = normalizeMember(source, index);
    const key = memberIdentity(normalized, index);
    const previous = result.get(key) || {};
    result.set(key, {
      ...previous,
      ...normalized,
      ...(source.name || source.agentName || source.displayName || source.role
        ? { name: normalized.name }
        : previous.name ? { name: previous.name } : {}),
      ...(source.description || source.prompt || source.task
        ? { description: normalized.description }
        : previous.description ? { description: previous.description } : {}),
      ...(source.color || source.agentColor
        ? { color: normalized.color }
        : previous.color ? { color: previous.color } : {}),
      ...(source.sessionId ? { sessionId: normalized.sessionId } : previous.sessionId ? { sessionId: previous.sessionId } : {}),
      tokenUsage: normalized.tokenUsage || previous.tokenUsage || null,
      toolCallCount: Object.prototype.hasOwnProperty.call(source, 'toolCallCount')
        ? normalized.toolCallCount
        : previous.toolCallCount || 0,
    });
  }
  return Array.from(result.values());
}

export function normalizeTeamUpdate(update) {
  if (!update || typeof update !== 'object') return null;
  return {
    ...update,
    type: update.type || 'member_status_change',
    teamName: firstValue(update.teamName, update.name, null),
    isAutoTeam: update.isAutoTeam === true,
    members: Array.isArray(update.members)
      ? update.members
      : undefined,
  };
}

export function mergeCodeBuddyTeamState(current, update, now = Date.now()) {
  const next = normalizeTeamUpdate(update);
  if (!next) return current || null;
  if (next.type === 'team_deleted') return null;

  const previous = current && typeof current === 'object' ? current : {};
  const members = next.members === undefined
    ? Array.isArray(previous.members) ? previous.members : []
    : mergeMembers(previous.members, next.members);
  const teamName = next.teamName || previous.teamName || previous.name || null;
  const lifecycleStatus = next.type === 'team_created'
    ? firstValue(next.status, 'running')
    : firstValue(next.status, previous.status, 'running');

  return {
    ...previous,
    ...next,
    ...(teamName ? { teamName } : {}),
    members,
    status: lifecycleStatus,
    active: true,
    updatedAt: now,
  };
}

export function completedTeamSnapshot(current, update, now = Date.now()) {
  const normalized = normalizeTeamUpdate(update) || {};
  const previous = current && typeof current === 'object' ? current : {};
  const previousStatus = String(previous.status || '').toLowerCase();
  const finalStatus = normalized.status || (['failed', 'error', 'cancelled', 'canceled', 'killed'].includes(previousStatus)
    ? previous.status
    : 'completed');
  const members = (normalized.members === undefined
    ? Array.isArray(previous.members) ? previous.members : []
    : mergeMembers(previous.members, normalized.members)).map((member) => {
      if (finalStatus !== 'completed') return member;
      const status = String(member.status || '').toLowerCase();
      return ['running', 'working', 'pending', 'queued', 'waiting', 'in_progress'].includes(status)
        ? { ...member, status: 'completed' }
        : member;
    });
  return {
    ...previous,
    ...normalized,
    ...(normalized.teamName || previous.teamName || previous.name
      ? { teamName: normalized.teamName || previous.teamName || previous.name }
      : {}),
    type: 'team_deleted',
    members,
    status: finalStatus,
    active: false,
    updatedAt: now,
  };
}

export function teamUpdateFromPayload(update) {
  return normalizeTeamUpdate(update?._meta?.[TEAM_META_KEY]);
}
export function workflowStateFromPayload(update) {
  const metadata = update?._meta && typeof update._meta === 'object' ? update._meta : {};
  const explicit = metadata[WORKFLOW_META_KEYS.state] || metadata[WORKFLOW_META_KEYS.update];
  if (explicit && typeof explicit === 'object') return explicit;
  const type = update?.sessionUpdate || update?.session_update || update?.type;
  if (!['workflow_update', 'workflow_state', 'state_update'].includes(type)) return null;
  const payload = update?.workflow || update?.workflowState || update?.state || update;
  return payload && typeof payload === 'object' ? payload : null;
}

export function workflowProgressEventFromPayload(update) {
  const metadata = update?._meta && typeof update._meta === 'object' ? update._meta : {};
  const kind = metadata[WORKFLOW_PROGRESS_META_KEYS.kind];
  if (!kind) return null;
  const numberValue = (key) => {
    const value = Number(metadata[WORKFLOW_PROGRESS_META_KEYS[key]]);
    return Number.isFinite(value) ? value : undefined;
  };
  return {
    kind: String(kind),
    runId: firstValue(metadata[WORKFLOW_PROGRESS_META_KEYS.runId], null),
    name: firstValue(metadata[WORKFLOW_PROGRESS_META_KEYS.name], null),
    status: firstValue(metadata[WORKFLOW_PROGRESS_META_KEYS.status], null),
    agentCount: numberValue('agentCount'),
    cachedCount: numberValue('cachedCount'),
    phaseCount: numberValue('phaseCount'),
    error: firstValue(metadata[WORKFLOW_PROGRESS_META_KEYS.error], null),
    phase: metadata[WORKFLOW_PROGRESS_META_KEYS.phase],
    agentKey: firstValue(metadata[WORKFLOW_PROGRESS_META_KEYS.agentKey], null),
    agentLabel: firstValue(metadata[WORKFLOW_PROGRESS_META_KEYS.agentLabel], null),
    agentPhase: metadata[WORKFLOW_PROGRESS_META_KEYS.agentPhase],
    agentError: firstValue(metadata[WORKFLOW_PROGRESS_META_KEYS.agentError], null),
    agentTokens: numberValue('agentTokens'),
  };
}

function workflowAgentStatus(event) {
  if (event.agentError) return 'failed';
  if (event.kind === 'workflow_agent_started') return 'running';
  return 'completed';
}

export function mergeWorkflowProgressEvent(current, event, now = Date.now()) {
  if (!event || typeof event !== 'object' || !event.kind) return current || null;
  const sameRun = current && (!event.runId || !current.runId || String(current.runId) === String(event.runId));
  const previous = sameRun ? current : {};
  const next = {
    ...previous,
    ...(event.runId ? { runId: event.runId } : {}),
    ...(event.name ? { name: event.name } : {}),
    ...(event.status ? { status: event.status } : {}),
    ...(event.agentCount !== undefined ? { agentCount: event.agentCount } : {}),
    ...(event.cachedCount !== undefined ? { cachedAgentCount: event.cachedCount } : {}),
    ...(event.phaseCount !== undefined ? { phaseCount: event.phaseCount } : {}),
    ...(event.error ? { error: event.error } : {}),
    updatedAt: now,
  };

  if (event.kind === 'workflow_run_started') {
    next.active = true;
    next.status = event.status || 'running';
    next.startedAt = Number(previous.startedAt) || now;
    next.completedAt = null;
    next.agents = Array.isArray(previous.agents) ? previous.agents : [];
  } else if (event.kind === 'workflow_run_finished') {
    next.active = false;
    next.status = event.status || (event.error ? 'failed' : 'completed');
    next.completedAt = now;
    next.agents = (Array.isArray(previous.agents) ? previous.agents : []).map((agent) => {
      if (!['running', 'pending', 'waiting'].includes(String(agent.status || '').toLowerCase())) return agent;
      return { ...agent, status: next.status === 'completed' ? 'completed' : next.status, completedAt: now };
    });
  } else if (event.kind === 'workflow_phase_started' || event.kind === 'workflow_phase_finished') {
    next.active = true;
    next.status = previous.status || 'running';
    next.phase = event.phase ?? previous.phase ?? null;
    next.phaseStatus = event.kind === 'workflow_phase_started' ? 'running' : 'completed';
  } else if (
    event.kind === 'workflow_agent_started' ||
    event.kind === 'workflow_agent_finished' ||
    event.kind === 'workflow_agent_cached'
  ) {
    const existingAgents = Array.isArray(previous.agents) ? previous.agents : [];
    const key = String(firstValue(event.agentKey, event.agentLabel, `agent-${existingAgents.length + 1}`));
    const agents = [...existingAgents];
    const index = agents.findIndex((agent) => String(agent.id || agent.key) === key);
    const existing = index >= 0 ? agents[index] : {};
    const phase = event.agentPhase ?? existing.phase ?? null;
    const agent = {
      ...existing,
      id: key,
      key,
      name: String(firstValue(event.agentLabel, existing.name, key)),
      ...(phase != null ? { phase, description: typeof phase === 'string' ? phase : firstValue(phase.title, phase.name, '') } : {}),
      status: workflowAgentStatus(event),
      ...(event.agentError ? { error: event.agentError, conclusion: event.agentError } : {}),
      ...(event.agentTokens !== undefined ? { tokens: event.agentTokens } : {}),
      cached: event.kind === 'workflow_agent_cached' || existing.cached === true,
      startedAt: Number(existing.startedAt) || now,
      updatedAt: now,
      ...((event.kind === 'workflow_agent_finished' || event.kind === 'workflow_agent_cached') ? { completedAt: now } : {}),
    };
    if (index >= 0) agents[index] = agent;
    else agents.push(agent);
    next.agents = agents;
    next.active = true;
    next.status = previous.status || 'running';
  }
  return next;
}

export function goalEventFromPayload(update) {
  const source = update && typeof update === 'object' ? update : {};
  const metadata = source._meta && typeof source._meta === 'object' ? source._meta : {};
  if (metadata['codebuddy.ai/goalProgress'] && typeof metadata['codebuddy.ai/goalProgress'] === 'object') {
    return { type: 'goal-progress', payload: metadata['codebuddy.ai/goalProgress'] };
  }
  if (metadata['codebuddy.ai/goalStatus'] && typeof metadata['codebuddy.ai/goalStatus'] === 'object') {
    return { type: 'goal-status', payload: metadata['codebuddy.ai/goalStatus'] };
  }
  const type = source.sessionUpdate || source.session_update || source.type;
  if (type === 'goal-progress' || type === 'goal-status') {
    const payload = source.goal && typeof source.goal === 'object'
      ? source.goal
      : source.payload && typeof source.payload === 'object'
        ? source.payload
        : source;
    return { type, payload };
  }
  return null;
}

export function memberEventName(payload) {
  return firstValue(payload?._meta?.[MEMBER_EVENT_META_KEY], payload?.memberName, null);
}

export function subagentMetadata(payload) {
  const meta = payload?._meta && typeof payload._meta === 'object' ? payload._meta : {};
  const value = (key) => meta[SUBAGENT_META_KEYS[key]];
  const parentToolCallId = firstValue(value('parentToolCallId'), meta.parentToolCallId, null);
  const memberName = firstValue(value('memberName'), meta.memberName, null);
  const subagentType = firstValue(value('subagentType'), meta.subagentType, null);
  // Bare agentId/subagentId alone is NOT enough — TaskCreate often carries ids without being a subagent card.
  const explicitFlag =
    value('isSubagent') === true || meta.isSubagent === true || meta.isSubAgent === true;
  const isSubagent = explicitFlag || Boolean(parentToolCallId);
  if (!isSubagent && !subagentType && !memberName) return null;
  return {
    isSubagent: isSubagent || Boolean(subagentType || memberName),
    parentToolCallId,
    subagentType,
    role: firstValue(value('role'), meta.role, null),
    agentId: firstValue(value('agentId'), meta.agentId, meta.agent_id, null),
    subagentId: firstValue(value('subagentId'), meta.subagentId, meta.subagent_id, null),
    taskId: firstValue(value('taskId'), meta.taskId, null),
    sessionId: firstValue(value('sessionId'), meta.sessionId, null),
    description: firstValue(value('description'), meta.description, ''),
    isBackground: value('isBackground') === true || meta.isBackground === true,
    memberName,
  };
}

export function isPrivateExtensionKey(key) {
  return String(key || '').startsWith('codebuddy.ai/');
}

export function appendRawExtensionEvent(existing, eventType, payload, source = 'codebuddy-private') {
  const current = Array.isArray(existing) ? existing : [];
  const event = {
    id: `${eventType || 'extension'}:${payload?.id || payload?.requestId || Date.now()}:${current.length}`,
    type: eventType || 'extension',
    source,
    payload,
    receivedAt: Date.now(),
  };
  return [...current, event].slice(-MAX_RAW_EXTENSION_EVENTS);
}

export function classifyAcpUpdate(update = {}) {
  const sessionUpdate = update.sessionUpdate || update.session_update || update.type || '';
  const meta = update._meta && typeof update._meta === 'object' ? update._meta : {};
  if (meta[TEAM_META_KEY]) {
    return { kind: 'team', source: 'codebuddy-private', payload: meta[TEAM_META_KEY] };
  }
  const hasWorkflowMetadata = Boolean(
    meta[WORKFLOW_META_KEYS.state] ||
    meta[WORKFLOW_META_KEYS.update] ||
    meta[WORKFLOW_PROGRESS_META_KEYS.kind]
  );
  if (hasWorkflowMetadata || ['workflow_update', 'workflow_state', 'state_update'].includes(sessionUpdate)) {
    return {
      kind: 'workflow',
      source: hasWorkflowMetadata ? 'codebuddy-private' : 'acp-standard',
      payload: workflowProgressEventFromPayload(update) || workflowStateFromPayload(update),
    };
  }
  if (meta['codebuddy.ai/goalProgress'] || meta['codebuddy.ai/goalStatus'] || sessionUpdate === 'goal-progress' || sessionUpdate === 'goal-status') {
    const goal = goalEventFromPayload(update);
    return { kind: 'goal', source: 'codebuddy-private', payload: goal?.payload || update };
  }
  if (memberEventName(update)) {
    return {
      kind: 'member_message',
      source: 'codebuddy-private',
      memberName: memberEventName(update),
    };
  }
  const subagent = subagentMetadata(update);
  if (subagent) return { kind: 'subagent_tool', source: 'codebuddy-private', subagent };
  if (sessionUpdate === 'plan' || sessionUpdate === 'plan_update') {
    return { kind: 'plan', source: 'acp-standard', payload: update };
  }
  if (sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update') {
    return { kind: 'tool', source: 'acp-standard', payload: update };
  }
  if (sessionUpdate === 'state_update' || sessionUpdate === 'status_change') {
    return {
      kind: 'session_state',
      source: sessionUpdate === 'state_update' ? 'acp-standard' : 'codebuddy-private',
      payload: update,
    };
  }
  return {
    kind: sessionUpdate || 'extension',
    source: isPrivateExtensionKey(sessionUpdate) ? 'codebuddy-private' : 'acp-standard',
    payload: update,
  };
}

export {
  TEAM_META_KEY,
  MEMBER_EVENT_META_KEY,
  SUBAGENT_META_KEYS,
  WORKFLOW_META_KEYS,
  WORKFLOW_PROGRESS_META_KEYS,
  MAX_RAW_EXTENSION_EVENTS,
  normalizeMember,
  mergeMembers,
};
