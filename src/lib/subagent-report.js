import {
  extractPathList,
  formatToolCollapsedSummary,
  isPathHeavyText,
  normalizeToolResult,
  truncateOneLine,
} from './tool-output-format';

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
  return String(
    firstValue(
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
    ),
  );
}

/** Timestamp-ish agent ids like `1785720595825-gc8kb5` must not be the only visible title. */
export function isBareAgentIdentity(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  if (/^\d{10,}[-_][a-z0-9]{4,}$/i.test(text)) return true;
  if (/^(agent|task|tool|member|session)[-_]?\d+/i.test(text) && text.length > 12) return true;
  return false;
}

function displayNameFor(source, fallback) {
  const candidate = firstValue(
    source?.name,
    source?.memberName,
    source?.agentName,
    source?.displayName,
    source?.role,
    source?.subagentType,
    source?.description,
    fallback,
  );
  if (candidate && !isBareAgentIdentity(candidate)) return String(candidate);
  const role = firstValue(source?.role, source?.subagentType, '');
  if (role && !isBareAgentIdentity(role)) return String(role);
  return '';
}

// M3：迭代式展平 + 深度/访问上限（防深链栈溢出与超深嵌套 DoS；结构事件驱动，非热路径）
const FLATTEN_MAX_DEPTH = 64;
const FLATTEN_MAX_VISIT = 100000;

function flattenTools(items) {
  const output = [];
  const stack = (Array.isArray(items) ? items : []).map((item) => ({ item, depth: 0 }));
  let guard = 0;
  while (stack.length > 0 && guard < FLATTEN_MAX_VISIT) {
    const { item, depth } = stack.pop();
    guard += 1;
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'tool_call') output.push(item);
    if (depth < FLATTEN_MAX_DEPTH) {
      const children = item.children;
      if (Array.isArray(children)) {
        for (let index = children.length - 1; index >= 0; index -= 1) {
          stack.push({ item: children[index], depth: depth + 1 });
        }
      }
    }
  }
  return output;
}

function textFrom(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(textFrom).filter(Boolean).join(' ').trim();
  if (value && typeof value === 'object') {
    return textFrom(value.text || (typeof value.content === 'string' ? value.content : '') || value.message || '');
  }
  return '';
}

function isAssistantHistoryItem(item) {
  if (!item || typeof item !== 'object') return false;
  const role = String(item.role || item.speaker || '').toLowerCase();
  const type = String(item.type || '').toLowerCase();
  if (role === 'assistant' || role === 'agent') return true;
  if (type === 'message' && role !== 'user') return true;
  if (type === 'assistant' || type === 'assistant_message') return true;
  // Explicit content without tool markers
  if ((item.content || item.message) && !item.toolCallId && type !== 'tool_call') {
    if (role === 'user') return false;
    return true;
  }
  return false;
}

function isNoisyConclusionText(text) {
  if (!text) return true;
  if (text.length > 4000) return true;
  if (isPathHeavyText(text)) return true;
  const pathList = extractPathList(text);
  if (pathList && pathList.count >= 5) return true;
  // Pure JSON array/object dumps
  const trimmed = text.trim();
  if (trimmed.length > 200 && trimmed.startsWith('[') && trimmed.includes('\\\\')) return true;
  return false;
}

/**
 * Build a structured conclusion from history / tools.
 * Never returns an unclamped path wall as conclusion text.
 */
export function buildSubagentConclusion({ history = [], tools = [], emptyLabel = '' } = {}) {
  // 1) Last assistant message in history
  for (const item of [...(Array.isArray(history) ? history : [])].reverse()) {
    if (!isAssistantHistoryItem(item)) continue;
    const text = textFrom(item?.content || item?.message);
    if (!text) continue;
    const pathList = extractPathList(text);
    if (pathList && pathList.count >= 2) {
      return {
        conclusion: '',
        conclusionKind: 'path_list',
        pathList,
        summary: `${pathList.count} paths`,
        noisy: false,
      };
    }
    if (isNoisyConclusionText(text)) {
      return {
        conclusion: truncateOneLine(text, 160),
        conclusionKind: 'summary',
        pathList: null,
        summary: truncateOneLine(text, 80),
        noisy: true,
      };
    }
    return {
      conclusion: text,
      conclusionKind: 'text',
      pathList: null,
      summary: truncateOneLine(text, 80),
      noisy: false,
    };
  }

  // 2) Structured fields on tools
  for (const tool of [...(Array.isArray(tools) ? tools : [])].reverse()) {
    const structured = textFrom(tool?.conclusion || tool?.summary || tool?.meta?.conclusion);
    if (structured && !isNoisyConclusionText(structured)) {
      return {
        conclusion: structured,
        conclusionKind: 'text',
        pathList: null,
        summary: truncateOneLine(structured, 80),
        noisy: false,
      };
    }
  }

  // 3) Path-list tool answers (keep count — do not silent-drop)
  for (const tool of [...(Array.isArray(tools) ? tools : [])].reverse()) {
    const pathList = extractPathList(tool?.rawOutput) || extractPathList(normalizeToolResult(tool?.rawOutput));
    if (pathList && pathList.count >= 2) {
      return {
        conclusion: '',
        conclusionKind: 'path_list',
        pathList,
        summary: `${pathList.count} paths`,
        noisy: false,
      };
    }
  }

  // 4) Tool histogram summary
  const toolItems = Array.isArray(tools) ? tools : [];
  if (toolItems.length) {
    const counts = new Map();
    for (const tool of toolItems) {
      const name = String(tool?.toolName || tool?.title || tool?.kind || 'tool').replace(/Tool$/i, '');
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    const hist = Array.from(counts.entries())
      .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
      .join(' · ');
    return {
      conclusion: '',
      conclusionKind: 'tool_summary',
      pathList: null,
      summary: hist,
      toolHistogram: hist,
      noisy: false,
    };
  }

  return {
    conclusion: emptyLabel || '',
    conclusionKind: 'empty',
    pathList: null,
    summary: emptyLabel || '',
    noisy: false,
  };
}

export function collectSubagentReports({
  timeline = [],
  teamState = null,
  lastTeamState = null,
  memberHistoriesByName = {},
  subagentToolCalls = {},
  emptyConclusionLabel = '',
} = {}) {
  const reports = new Map();
  const toolsByKey = new Map();

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
      conclusionKind: 'empty',
      pathList: null,
      summary: '',
      noisy: false,
      toolIds: new Set(),
      updatedAt: 0,
    };
    const nextName = displayNameFor(source, prior.name || '');
    const next = {
      ...prior,
      role: firstValue(source?.role, source?.subagentType, prior.role, ''),
      name: nextName || prior.name || '',
      status: normalizeStatus(source?.status || prior.status),
      description: firstValue(source?.description, source?.task, source?.prompt, prior.description, ''),
      agentId: firstValue(source?.agentId, source?.subagentId, source?.taskId, source?.sessionId, prior.agentId, key),
      updatedAt: Math.max(prior.updatedAt, Number(source?.updatedAt) || Number(source?.completedAt) || 0),
    };
    reports.set(key, next);
    return next;
  };

  const members = [
    ...(Array.isArray(teamState?.members) ? teamState.members : []),
    ...(Array.isArray(lastTeamState?.members) ? lastTeamState.members : []),
  ];

  for (const member of members) ensure(member, `member-${reports.size + 1}`);

  const rememberTool = (report, tool) => {
    if (!toolsByKey.has(report.id)) toolsByKey.set(report.id, []);
    toolsByKey.get(report.id).push(tool);
  };

  for (const item of flattenTools(timeline)) {
    // Require explicit subagent signals — parent-only orphans without member/type still nest under tools,
    // but bare TaskCreate rows with only an agent id must not become report cards.
    if (!item.isSubAgent && !item.memberName && !item.subagentType) continue;
    if (item.parentToolCallId && !item.isSubAgent && !item.memberName && !item.subagentType) continue;
    // Children with parent are attributed to parent identity when possible
    const matchingMember = members.find(
      (member) => member?.name === item.memberName || member?.agentName === item.memberName,
    );
    const report = matchingMember
      ? ensure(matchingMember, `member-${reports.size + 1}`)
      : ensure(item, `tool-${item.toolCallId || reports.size + 1}`);
    if (item.toolCallId) report.toolIds.add(item.toolCallId);
    report.toolCallCount = Math.max(report.toolCallCount, report.toolIds.size);
    rememberTool(report, item);
    if (item.status) report.status = normalizeStatus(item.status);
  }

  for (const [toolCallId, item] of Object.entries(subagentToolCalls || {})) {
    const matchingMember = members.find(
      (member) => member?.name === item?.memberName || member?.agentName === item?.memberName,
    );
    const report = matchingMember
      ? ensure(matchingMember, `member-${reports.size + 1}`)
      : ensure(item, `tool-${toolCallId}`);
    report.toolIds.add(toolCallId);
    report.toolCallCount = Math.max(report.toolCallCount, report.toolIds.size);
    rememberTool(report, { ...item, toolCallId });
  }

  for (const report of reports.values()) {
    const history = memberHistoriesByName?.[report.name] || [];
    const tools = toolsByKey.get(report.id) || [];
    const built = buildSubagentConclusion({
      history,
      tools,
      emptyLabel: emptyConclusionLabel,
    });
    report.conclusion = built.conclusion;
    report.conclusionKind = built.conclusionKind;
    report.pathList = built.pathList;
    report.summary =
      built.summary ||
      report.description ||
      formatToolCollapsedSummary(tools[tools.length - 1] || {}) ||
      '';
    report.noisy = Boolean(built.noisy);
    report.toolHistogram = built.toolHistogram || '';

    const member = members.find(
      (candidate) => candidate?.name === report.name || identityFor(candidate, '') === report.id,
    );
    if (member) {
      report.toolCallCount = Math.max(report.toolCallCount, Number(member.toolCallCount) || 0);
      report.status = normalizeStatus(member.status || report.status);
      report.agentId = firstValue(member.agentId, member.subagentId, member.taskId, member.sessionId, report.agentId);
    }
    delete report.toolIds;
  }

  return Array.from(reports.values())
    .filter((report) => {
      const titled = (report.name && !isBareAgentIdentity(report.name)) || (report.role && !isBareAgentIdentity(report.role));
      const useful =
        Boolean(report.conclusion && String(report.conclusion).trim()) ||
        report.conclusionKind === 'text' ||
        report.conclusionKind === 'path_list' ||
        (report.toolCallCount > 0 && report.description);
      // Drop pure id shells with no human title and no useful body (TaskCreate noise).
      return titled || useful;
    })
    .map((report) => {
      if (!report.name || isBareAgentIdentity(report.name)) {
        report.name = firstValue(report.role, report.description, report.summary, 'Subagent');
      }
      return report;
    })
    .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
}

export { isAssistantHistoryItem, isNoisyConclusionText };
