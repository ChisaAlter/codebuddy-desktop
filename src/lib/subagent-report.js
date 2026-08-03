function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '');
}

function normalizeStatus(value) {
  const status = String(value || '').toLowerCase();
  if (['done', 'success', 'succeeded'].includes(status)) return 'completed';
  if (['error'].includes(status)) return 'failed';
  if (['canceled', 'killed', 'aborted'].includes(status)) return 'cancelled';
  if (['working', 'in_progress', 'queued'].includes(status)) return 'running';
  return status || 'pending';
}

function identityFor(source, fallback) {
  return String(firstValue(
    source?.agentId,
    source?.agent_id,
    source?.subagentId,
    source?.subagent_id,
    source?.taskId,
    source?.task_id,
    source?.sessionId,
    source?.session_id,
    source?.id,
    source?.name,
    fallback,
  ));
}

function flattenTools(items, output = []) {
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'tool_call') output.push(item);
    flattenTools(item.children, output);
  }
  return output;
}

function textFrom(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(textFrom).filter(Boolean).join(' ').trim();
  if (value && typeof value === 'object') return textFrom(value.text || value.content || value.message || '');
  return '';
}

function historyConclusion(history) {
  for (const item of [...(Array.isArray(history) ? history : [])].reverse()) {
    const text = textFrom(item?.content || item?.message || item?.rawOutput);
    if (text) return text;
  }
  return '';
}

export function collectSubagentReports({
  timeline = [],
  teamState = null,
  lastTeamState = null,
  memberHistoriesByName = {},
  subagentToolCalls = {},
} = {}) {
  const reports = new Map();
  const ensure = (source, fallback) => {
    const key = identityFor(source, fallback);
    const prior = reports.get(key) || {
      id: key,
      role: '',
      agentId: key,
      name: '',
      status: 'pending',
      description: '',
      toolCallCount: 0,
      conclusion: '',
      toolIds: new Set(),
      updatedAt: 0,
    };
    const next = {
      ...prior,
      role: firstValue(source?.role, source?.subagentType, prior.role, ''),
      name: firstValue(source?.name, source?.memberName, source?.agentName, prior.name, key),
      status: normalizeStatus(source?.status || prior.status),
      description: firstValue(source?.description, source?.task, source?.prompt, prior.description, ''),
      agentId: firstValue(source?.agentId, source?.subagentId, source?.taskId, source?.sessionId, prior.agentId, key),
      updatedAt: Math.max(prior.updatedAt, Number(source?.updatedAt) || 0),
    };
    reports.set(key, next);
    return next;
  };

  for (const member of [
    ...(Array.isArray(teamState?.members) ? teamState.members : []),
    ...(Array.isArray(lastTeamState?.members) ? lastTeamState.members : []),
  ]) ensure(member, `member-${reports.size + 1}`);

  for (const item of flattenTools(timeline)) {
    if (!item.isSubAgent && !item.memberName && !item.subagentType && !item.parentToolCallId) continue;
    const matchingMember = [
      ...(Array.isArray(teamState?.members) ? teamState.members : []),
      ...(Array.isArray(lastTeamState?.members) ? lastTeamState.members : []),
    ].find((member) => member?.name === item.memberName || member?.agentName === item.memberName);
    const report = matchingMember
      ? ensure(matchingMember, `member-${reports.size + 1}`)
      : ensure(item, `tool-${item.toolCallId || reports.size + 1}`);
    if (item.toolCallId) report.toolIds.add(item.toolCallId);
    report.toolCallCount = Math.max(report.toolCallCount, report.toolIds.size);
    if (item.rawOutput) report.conclusion = textFrom(item.rawOutput) || report.conclusion;
  }

  for (const [toolCallId, item] of Object.entries(subagentToolCalls || {})) {
    const matchingMember = [
      ...(Array.isArray(teamState?.members) ? teamState.members : []),
      ...(Array.isArray(lastTeamState?.members) ? lastTeamState.members : []),
    ].find((member) => member?.name === item?.memberName || member?.agentName === item?.memberName);
    const report = matchingMember
      ? ensure(matchingMember, `member-${reports.size + 1}`)
      : ensure(item, `tool-${toolCallId}`);
    report.toolIds.add(toolCallId);
    report.toolCallCount = Math.max(report.toolCallCount, report.toolIds.size);
  }

  for (const report of reports.values()) {
    const history = memberHistoriesByName?.[report.name];
    report.conclusion = historyConclusion(history) || report.conclusion;
    if (!report.conclusion) report.conclusion = '暂无结论';
    const member = [
      ...(Array.isArray(teamState?.members) ? teamState.members : []),
      ...(Array.isArray(lastTeamState?.members) ? lastTeamState.members : []),
    ].find((candidate) => candidate?.name === report.name || identityFor(candidate, '') === report.id);
    if (member) {
      report.toolCallCount = Math.max(report.toolCallCount, Number(member.toolCallCount) || 0);
      report.status = normalizeStatus(member.status || report.status);
      report.agentId = firstValue(member.agentId, member.subagentId, member.taskId, member.sessionId, report.agentId);
    }
    delete report.toolIds;
  }

  return Array.from(reports.values())
    .filter((report) => report.name || report.role)
    .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
}
