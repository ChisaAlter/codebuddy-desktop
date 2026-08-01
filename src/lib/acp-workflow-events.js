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

export function memberEventName(payload) {
  return firstValue(payload?._meta?.[MEMBER_EVENT_META_KEY], payload?.memberName, null);
}

export function subagentMetadata(payload) {
  const meta = payload?._meta && typeof payload._meta === 'object' ? payload._meta : {};
  const value = (key) => meta[SUBAGENT_META_KEYS[key]];
  const parentToolCallId = firstValue(value('parentToolCallId'), meta.parentToolCallId, null);
  const isSubagent = value('isSubagent') === true || meta.isSubagent === true || Boolean(parentToolCallId);
  if (!isSubagent && !value('subagentType') && !value('memberName')) return null;
  return {
    isSubagent,
    parentToolCallId,
    subagentType: firstValue(value('subagentType'), meta.subagentType, null),
    description: firstValue(value('description'), meta.description, ''),
    isBackground: value('isBackground') === true || meta.isBackground === true,
    memberName: firstValue(value('memberName'), meta.memberName, null),
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
  MAX_RAW_EXTENSION_EVENTS,
  normalizeMember,
  mergeMembers,
};
