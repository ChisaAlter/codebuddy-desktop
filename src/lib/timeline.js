import { subagentMetadata } from './acp-workflow-events.js';

// 这里不能再按文本去重，否则模型合法输出连续相同文本时会丢字。
const MAX_DEDUPE_SCOPES = 100;
const MAX_EVENTS_PER_SCOPE = 2000;
const _seenHistoryEventsByScope = new Map();

export function resetSeenContent(scope) {
  if (scope === undefined || scope === null) {
    _seenHistoryEventsByScope.clear();
    return;
  }
  _seenHistoryEventsByScope.delete(String(scope));
}

function seenHistoryEventsForScope(scope) {
  const key = String(scope || 'global');
  let seen = _seenHistoryEventsByScope.get(key);
  if (seen) return seen;
  if (_seenHistoryEventsByScope.size >= MAX_DEDUPE_SCOPES) {
    _seenHistoryEventsByScope.delete(_seenHistoryEventsByScope.keys().next().value);
  }
  seen = new Set();
  _seenHistoryEventsByScope.set(key, seen);
  return seen;
}

function isDuplicateHistoryChunk(scope, payload, messageId) {
  const history = payload?._meta?.['codebuddy.ai'];
  if (history?.mode !== 'history' || history.offset === undefined || !messageId) return false;
  const key = `${messageId}:${history.offset}:${payload?.sessionUpdate || payload?.type || ''}`;
  const seen = seenHistoryEventsForScope(scope);
  if (seen.has(key)) return true;
  if (seen.size >= MAX_EVENTS_PER_SCOPE) seen.delete(seen.values().next().value);
  seen.add(key);
  return false;
}

function getText(c) {
  if (typeof c === 'string') return c;
  if (c === null || c === undefined) return '';
  // 处理 ContentBlock 数组: [{type:'text', text:'hello'}, ...]
  if (Array.isArray(c)) {
    return c.map((block) => {
      if (typeof block === 'string') return block;
      if (typeof block === 'object' && block !== null) {
        return (block.type === 'text' ? (block.text || block.content || '') : (block.text || block.content || ''));
      }
      return String(block);
    }).join('');
  }
  // 处理单个 ContentBlock: {type:'text', text:'hello'}
  if (typeof c === 'object') {
    return c.text || c.content || '';
  }
  return String(c);
}

function isRepeatedHistoryChunk(target, payload, content) {
  if (!target || !content) return false;
  const mode = payload?._meta?.['codebuddy.ai']?.mode;
  return mode === 'history' && (target.content === content || target.content.endsWith(content));
}

export function createTimelineEntry(partial = {}) {
  return {
    id: partial.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: partial.type || 'message',
    role: partial.role || 'assistant',
    content: getText(partial.content),
    streaming: Boolean(partial.streaming),
    createdAt: partial.createdAt ?? Date.now(),
    completedAt: partial.completedAt ?? null,
    raw: partial.raw || null,
    meta: partial.meta || {},
    messageId: partial.messageId || null,
    toolCallId: partial.toolCallId || null,
    status: partial.status || null,
    title: partial.title || null,
    kind: partial.kind || null,
    rawInput: partial.rawInput || null,
    rawOutput: partial.rawOutput || null,
    locations: partial.locations || null,
    attachments: Array.isArray(partial.attachments) ? partial.attachments : null,
    isSubAgent: Boolean(partial.isSubAgent),
    subagentType: partial.subagentType || null,
    agentId: partial.agentId || null,
    subagentId: partial.subagentId || null,
    taskId: partial.taskId || null,
    sessionId: partial.sessionId || null,
    description: partial.description || null,
    isBackground: Boolean(partial.isBackground),
    memberName: partial.memberName || null,
    parentToolCallId: partial.parentToolCallId || null,
    children: Array.isArray(partial.children) ? partial.children : [],
    subagentTimeline: Array.isArray(partial.subagentTimeline) ? partial.subagentTimeline : [],
  };
}

function findLastByMessageId(timeline, type, messageId) {
  if (!messageId) return null;
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const item = timeline[i];
    if (item.type === type && item.messageId === messageId) return item;
  }
  return null;
}

function findLocalUserHistoryTarget(timeline, content) {
  if (!content) return null;
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const item = timeline[i];
    if (item.type !== 'message' || item.role !== 'user' || item.messageId) continue;
    if (item.content === content || item.content.startsWith(content)) return item;
  }
  return null;
}

function finalizeThinkingEntry(item, completedAt = Date.now()) {
  if (!item || item.type !== 'thinking') return item;
  if (item.streaming) {
    return { ...item, streaming: false, completedAt };
  }
  const existingCompletedAt = Number(item.completedAt);
  if (Number.isFinite(existingCompletedAt) && existingCompletedAt > 0) {
    return item.streaming === false ? item : { ...item, streaming: false };
  }
  const startedAt = Number(item.createdAt);
  return {
    ...item,
    streaming: false,
    completedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : completedAt,
  };
}

export function closeAssistantStream(timeline) {
  const completedAt = Date.now();
  return timeline.map((item) =>
    item.type === 'message' && item.role === 'assistant'
      ? { ...item, streaming: false }
      : item.type === 'thinking'
        ? finalizeThinkingEntry(item, completedAt)
        : item,
  );
}

function closeThinkingStream(timeline) {
  const completedAt = Date.now();
  return timeline.map((item) =>
    item.type === 'thinking' && item.streaming ? finalizeThinkingEntry(item, completedAt) : item,
  );
}

export function pushUserMessage(timeline, content, createdAt = Date.now(), attachments = null) {
  const entry = {
    type: 'message',
    role: 'user',
    content,
    streaming: false,
    createdAt,
  };
  if (Array.isArray(attachments) && attachments.length > 0) {
    entry.attachments = attachments.map((attachment) => ({
      name: attachment?.name || attachment?.path || 'attachment',
      path: attachment?.path || null,
      kind: attachment?.kind === 'image' ? 'image' : 'text',
      mimeType: attachment?.mimeType || null,
      // Keep inline preview data when already loaded (not persisted long-term by design).
      data: attachment?.data || null,
      url: attachment?.url || null,
    }));
  }
  return [...timeline, createTimelineEntry(entry)];
}

export function pushSystemEvent(timeline, type, payload) {
  return [
    ...timeline,
    createTimelineEntry({
      type,
      role: 'system',
      raw: payload,
      meta: payload,
      content: typeof payload === 'string' ? payload : payload?.message || '',
      streaming: false,
    }),
  ];
}

const EXECUTION_EVENT_TYPES = new Set([
  'tool_call',
  'checkpoint',
  'taskCreated',
  'taskStatus',
  'goal-progress',
  'goal-status',
  'question_answered',
]);

function isExecutionEvent(item) {
  if (EXECUTION_EVENT_TYPES.has(item?.type)) return true;
  if (item?.type !== 'artifact') return false;
  const payload = item.meta || item.raw || {};
  const artifact = payload.artifact && typeof payload.artifact === 'object' ? payload.artifact : payload;
  return Array.isArray(artifact.tasks);
}

function mergeConsecutiveThinkingEntries(parts) {
  const entries = Array.isArray(parts) ? parts.filter(Boolean) : [];
  if (entries.length === 0) return null;
  if (entries.length === 1) return entries[0];

  const first = entries[0];
  const last = entries[entries.length - 1];
  const contentParts = entries
    .map((item) => String(item?.content || '').trimEnd())
    .filter((text) => text.length > 0);
  const streaming = entries.some((item) => item?.streaming);
  let completedAt = null;
  if (!streaming) {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const value = Number(entries[i]?.completedAt);
      if (Number.isFinite(value) && value > 0) {
        completedAt = value;
        break;
      }
    }
  }

  return {
    ...first,
    id: `thinking-group-${first.id || entries.length}`,
    type: 'thinking',
    role: 'assistant',
    content: contentParts.join('\n\n'),
    streaming,
    createdAt: first.createdAt,
    completedAt,
    messageId: first.messageId ?? last.messageId ?? null,
    items: entries,
    meta: { ...(first.meta || {}), groupedThinkingCount: entries.length },
  };
}

export function groupTimelineForDisplay(timeline) {
  const grouped = [];
  let turn = [];

  const flushTurn = () => {
    if (!turn.length) return;
    let index = 0;
    while (index < turn.length) {
      const item = turn[index];
      if (item?.type === 'thinking') {
        const cluster = [];
        while (index < turn.length && turn[index]?.type === 'thinking') {
          cluster.push(turn[index]);
          index += 1;
        }
        const merged = mergeConsecutiveThinkingEntries(cluster);
        // WebUI co-locates thinking on the assistant message (thinking block + markdown
        // in one unit). Attach when the next entry is that answer — not when tools
        // interrupt (those stay as a standalone thinking card before the execution group).
        const next = turn[index];
        if (
          merged &&
          next?.type === 'message' &&
          next?.role === 'assistant'
        ) {
          grouped.push({
            ...next,
            thinking: merged,
          });
          index += 1;
          continue;
        }
        if (merged) grouped.push(merged);
        continue;
      }
      if (!isExecutionEvent(item)) {
        grouped.push(item);
        index += 1;
        continue;
      }

      const cluster = [];
      const clusterStart = index;
      while (index < turn.length && isExecutionEvent(turn[index])) {
        cluster.push(turn[index]);
        index += 1;
      }
      const finalAnswerCompleted = turn.slice(index).some(
        (candidate) =>
          candidate?.type === 'message' &&
          candidate?.role === 'assistant' &&
          String(candidate.content || '').trim().length > 0 &&
          candidate.streaming !== true,
      );
      const first = cluster[0];
      grouped.push({
        id: `execution-${first.id || grouped.length}-${clusterStart}`,
        type: 'execution_group',
        role: 'system',
        createdAt: first.createdAt,
        items: cluster,
        autoCollapse: finalAnswerCompleted,
      });
    }
    turn = [];
  };

  for (const item of Array.isArray(timeline) ? timeline : []) {
    if (item?.type === 'message' && item?.role === 'user' && turn.length) flushTurn();
    turn.push(item);
  }
  flushTurn();
  return grouped;
}
export function executionGroupSummary(items) {
  const entries = Array.isArray(items) ? items : [];
  const toolCount = entries.filter((item) => item?.type === 'tool_call').length;
  const checkpointCount = entries.filter((item) => item?.type === 'checkpoint').length;
  const activityCount = Math.max(0, entries.length - toolCount - checkpointCount);
  const details = [];
  if (toolCount) details.push(`${toolCount} 个工具`);
  if (checkpointCount) details.push(`${checkpointCount} 个检查点`);
  if (activityCount) details.push(`${activityCount} 条动态`);

  const failed = entries.some((item) => ['failed', 'error'].includes(item?.status));
  const running = entries.some((item) => !['completed', 'done', 'failed', 'error'].includes(item?.status) && item?.type === 'tool_call');
  return {
    detail: details.join(' · ') || `${entries.length} 条记录`,
    status: failed ? '有失败项' : running ? '执行中' : '已完成',
    tone: failed ? 'error' : running ? 'running' : 'success',
  };
}

function mergeUserChunk(timeline, payload, dedupeScope) {
  const next = [...timeline];
  const messageId = payload?.messageId || null;
  const historyMode = payload?._meta?.['codebuddy.ai']?.mode === 'history';
  const content = getText(payload?.content);
  let target = findLastByMessageId(next, 'message', messageId);
  if (!target && historyMode) {
    target = findLocalUserHistoryTarget(next, content);
    if (target) {
      const index = next.lastIndexOf(target);
      next[index] = {
        ...target,
        messageId,
        raw: payload,
        meta: { ...(target.meta || {}), ...(payload || {}), localHistoryContentComplete: true },
      };
      return next;
    }
  }
  if (target && target.role === 'user') {
    if (historyMode && target.meta?.localHistoryContentComplete) return next;
    if (isRepeatedHistoryChunk(target, payload, content)) return next;
    if (isDuplicateHistoryChunk(dedupeScope, payload, messageId)) return next;
    const index = next.lastIndexOf(target);
    next[index] = {
      ...target,
      content: target.content + content,
      meta: { ...(target.meta || {}), ...(payload || {}) },
    };
    return next;
  }
  next.push(
    createTimelineEntry({
      type: 'message',
      role: 'user',
      content: getText(payload?.content),
      streaming: false,
      raw: payload,
      meta: payload,
      messageId,
    }),
  );
  return next;
}

function mergeAssistantChunk(timeline, payload, dedupeScope) {
  const next = closeThinkingStream(timeline);
  const messageId = payload?.messageId || null;
  const target = findLastByMessageId(next, 'message', messageId);
  if (target && target.role === 'assistant') {
    const content = getText(payload?.content);
    if (isRepeatedHistoryChunk(target, payload, content)) return next;
    if (isDuplicateHistoryChunk(dedupeScope, payload, messageId)) return next;
    const index = next.lastIndexOf(target);
    const executionFollowedTarget = next
      .slice(index + 1)
      .some(
        (item) =>
          isExecutionEvent(item) || item?.type === 'interruption' || item?.type === 'question',
      );
    if (executionFollowedTarget && content) {
      next.push(
        createTimelineEntry({
          type: 'message',
          role: 'assistant',
          content,
          streaming: true,
          raw: payload,
          meta: payload,
          messageId,
        }),
      );
      return next;
    }
    next[index] = {
      ...target,
      content: target.content + content,
      streaming: true,
      meta: { ...(target.meta || {}), ...(payload || {}) },
    };
    return next;
  }
  next.push(
    createTimelineEntry({
      type: 'message',
      role: 'assistant',
      content: getText(payload?.content),
      streaming: true,
      raw: payload,
      meta: payload,
      messageId,
    }),
  );
  return next;
}

function findLastOpenThinking(timeline) {
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const item = timeline[i];
    if (item?.type === 'thinking' && item.streaming) return item;
  }
  return null;
}

function findLastContiguousThinking(timeline) {
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const item = timeline[i];
    if (item?.type === 'thinking') return item;
    if (
      isExecutionEvent(item) ||
      item?.type === 'interruption' ||
      item?.type === 'question' ||
      (item?.type === 'message' && item?.role === 'assistant')
    ) {
      return null;
    }
  }
  return null;
}

// WebUI LIVE: thinking clock starts at the first agent_thought_chunk, not at prompt send.
// (Desktop previously back-dated createdAt to promptStartedAt, inflating "用时 N 秒".)
function mergeThinkingChunk(timeline, payload, dedupeScope) {
  const next = [...timeline];
  const messageId = payload?.messageId || null;
  const content = getText(payload?.content) || (typeof payload?.message === 'string' ? payload.message : '');
  let target = findLastByMessageId(next, 'thinking', messageId);
  // No messageId: keep appending into the open (or last contiguous) thinking block so
  // fragmented agent_thought_chunk events do not become one "已思考" card per sentence.
  if (!target && !messageId) {
    target = findLastOpenThinking(next) || findLastContiguousThinking(next);
  }
  if (target) {
    if (isRepeatedHistoryChunk(target, payload, content)) return next;
    if (isDuplicateHistoryChunk(dedupeScope, payload, messageId)) return next;
    const index = next.lastIndexOf(target);
    const executionFollowedTarget = next
      .slice(index + 1)
      .some(
        (item) =>
          isExecutionEvent(item) || item?.type === 'interruption' || item?.type === 'question',
      );
    if (executionFollowedTarget && content) {
      const resumedAt = Date.now();
      next.push(
        createTimelineEntry({
          type: 'thinking',
          role: 'assistant',
          content,
          streaming: true,
          createdAt: resumedAt,
          raw: payload,
          meta: payload,
          messageId,
        }),
      );
      return next;
    }
    next[index] = {
      ...target,
      content: (target.content || '') + content,
      streaming: true,
      completedAt: null,
      meta: { ...(target.meta || {}), ...(payload || {}) },
      messageId: target.messageId || messageId || null,
    };
    return next;
  }
  if (isDuplicateHistoryChunk(dedupeScope, payload, messageId)) return next;
  const receivedAt = Date.now();
  next.push(
    createTimelineEntry({
      type: 'thinking',
      role: 'assistant',
      content: content || getText(payload?.content) || payload?.message || '',
      streaming: true,
      createdAt: receivedAt,
      raw: payload,
      meta: payload,
      messageId,
    }),
  );
  return next;
}

function findToolCallLocation(timeline, toolCallId, prefix = []) {
  if (!toolCallId) return null;
  for (let index = 0; index < timeline.length; index += 1) {
    const item = timeline[index];
    if (item?.type !== 'tool_call') continue;
    const path = [...prefix, index];
    if (item.toolCallId === toolCallId) return path;
    const childPath = findToolCallLocation(item.children || [], toolCallId, path.concat('children'));
    if (childPath) return childPath;
  }
  return null;
}

function updateToolAtPath(timeline, path, updater) {
  if (!path?.length) return timeline;
  const [index, ...rest] = path;
  const next = timeline.slice();
  const item = next[index];
  if (!item) return timeline;
  if (rest[0] === 'children') {
    next[index] = {
      ...item,
      children: updateToolAtPath(item.children || [], rest.slice(1), updater),
    };
    return next;
  }
  next[index] = updater(item);
  return next;
}

function findToolByPath(timeline, path) {
  let list = timeline;
  let item = null;
  for (const part of path || []) {
    if (part === 'children') {
      list = item?.children || [];
      continue;
    }
    item = list?.[part] || null;
  }
  return item;
}

function attachChildTool(timeline, child) {
  const parentId = child?.parentToolCallId;
  if (!parentId || !child?.toolCallId || parentId === child.toolCallId) return timeline;
  const parentPath = findToolCallLocation(timeline, parentId);
  const childPath = findToolCallLocation(timeline, child.toolCallId);
  if (!parentPath || !childPath || childPath.length !== 1) return timeline;
  const parent = findToolByPath(timeline, parentPath);
  const childItem = findToolByPath(timeline, childPath);
  if (!parent || !childItem) return timeline;
  const children = (parent.children || []).filter((item) => item?.toolCallId !== child.toolCallId);
  const withoutChild = timeline.filter((_, index) => index !== childPath[0]);
  const adjustedParentPath = parentPath[0] > childPath[0]
    ? [parentPath[0] - 1, ...parentPath.slice(1)]
    : parentPath;
  return updateToolAtPath(withoutChild, adjustedParentPath, (current) => ({
    ...current,
    children: [...children, childItem],
  }));
}

function attachChildTools(timeline) {
  let next = timeline;
  let changed = true;
  while (changed) {
    changed = false;
    for (const child of next) {
      if (!child?.parentToolCallId || child.type !== 'tool_call') continue;
      const attached = attachChildTool(next, child);
      if (attached !== next) {
        next = attached;
        changed = true;
        break;
      }
    }
  }
  return next;
}

function mergeToolCall(timeline, payload, isUpdate = false) {
  const next = closeThinkingStream(timeline);
  const toolCallId = payload?.toolCallId || null;
  const subagent = subagentMetadata(payload);
  const parentToolCallId = subagent?.parentToolCallId || payload?._meta?.['codebuddy.ai/parentToolCallId'] || null;
  const targetPath = findToolCallLocation(next, toolCallId);
  const metadataPatch = subagent
    ? {
        isSubAgent: subagent.isSubagent,
        subagentType: subagent.subagentType,
        role: subagent.role || null,
        agentId: subagent.agentId || null,
        subagentId: subagent.subagentId || null,
        taskId: subagent.taskId || null,
        sessionId: subagent.sessionId || null,
        description: subagent.description || null,
        isBackground: subagent.isBackground,
        memberName: subagent.memberName,
        parentToolCallId,
      }
    : {};
  if (targetPath) {
    const updatedTimeline = updateToolAtPath(next, targetPath, (target) => ({
      ...target,
      status: payload?.status || target.status,
      title: payload?.title || target.title,
      kind: payload?.kind || target.kind,
      content: payload?.content != null ? getText(payload.content) : target.content,
      rawInput: payload?.rawInput ?? target.rawInput,
      rawOutput: payload?.rawOutput ?? target.rawOutput,
      locations: payload?.locations ?? target.locations,
      meta: { ...(target.meta || {}), ...(payload || {}) },
      raw: payload,
      ...metadataPatch,
    }));
    return attachChildTools(updatedTimeline);
  }
  const entry = createTimelineEntry({
    type: 'tool_call',
    role: 'assistant',
    raw: payload,
    meta: payload,
    messageId: payload?.messageId || null,
    toolCallId,
    status: payload?.status || (isUpdate ? 'update' : 'created'),
    title: payload?.title || null,
    kind: payload?.kind || null,
    content: getText(payload?.content),
    rawInput: payload?.rawInput || null,
    rawOutput: payload?.rawOutput || null,
    locations: payload?.locations || null,
    ...metadataPatch,
  });
  next.push(entry);
  return attachChildTools(next);
}


export function mergeMemberTimeline(memberHistories, memberName, eventType, payload, dedupeScope) {
  const key = String(memberName || '').trim();
  if (!key) return memberHistories || {};
  const current = Array.isArray(memberHistories?.[key]) ? memberHistories[key] : [];
  return {
    ...(memberHistories || {}),
    [key]: reduceAcpEvent(current, eventType, payload, `${dedupeScope || 'global'}:member:${key}`).slice(-300),
  };
}

// context is accepted for call-site compatibility (e.g. tests); thinking duration no longer uses it.
export function reduceAcpEvent(timeline, eventType, payload, dedupeScope = 'global', _context = {}) {
  if (eventType === 'message') {
    if (payload?.messageId && payload?.content) {
      return mergeAssistantChunk(timeline, payload, dedupeScope);
    }
    return pushSystemEvent(timeline, 'message', payload);
  }

  if (eventType === 'agent_thought_chunk' || payload?.sessionUpdate === 'agent_thought_chunk') {
    return mergeThinkingChunk(timeline, payload, dedupeScope);
  }

  if (eventType === 'agent_message_chunk' || payload?.sessionUpdate === 'agent_message_chunk') {
    return mergeAssistantChunk(timeline, payload, dedupeScope);
  }

  if (eventType === 'user_message_chunk' || payload?.sessionUpdate === 'user_message_chunk') {
    return mergeUserChunk(timeline, payload, dedupeScope);
  }

  if (eventType === 'tool_call' || payload?.sessionUpdate === 'tool_call') {
    return mergeToolCall(timeline, payload, false);
  }

  if (eventType === 'tool_call_update' || payload?.sessionUpdate === 'tool_call_update') {
    return mergeToolCall(timeline, payload, true);
  }

  if (eventType === 'thinking' || payload?.type === 'thinking' || payload?.sessionUpdate === 'thinking') {
    return mergeThinkingChunk(timeline, payload, dedupeScope);
  }

  if (eventType === 'interruption_request' || payload?.sessionUpdate === 'interruption_request' || payload?.type === 'interruption') {
    return [
      ...timeline,
      createTimelineEntry({
        type: 'interruption',
        role: 'assistant',
        raw: payload,
        meta: payload,
        messageId: payload?.messageId || null,
        toolCallId: payload?.toolCallId || null,
      }),
    ];
  }

  if (eventType === 'question_request' || payload?.sessionUpdate === 'question_request' || payload?.type === 'question') {
    return [
      ...timeline,
      createTimelineEntry({
        type: 'question',
        role: 'assistant',
        raw: payload,
        meta: payload,
        messageId: payload?.messageId || null,
        toolCallId: payload?.toolCallId || null,
      }),
    ];
  }

  if (eventType === 'config_option_update' || payload?.sessionUpdate === 'config_option_update') {
    return pushSystemEvent(timeline, 'config_option_update', payload);
  }

  if (eventType === 'session_info_update' || payload?.sessionUpdate === 'session_info_update') {
    return pushSystemEvent(timeline, 'session_info_update', payload);
  }

  if (eventType === 'available_commands_update' || payload?.sessionUpdate === 'available_commands_update') {
    return pushSystemEvent(timeline, 'available_commands_update', payload);
  }

  if (eventType === 'usage_update' || payload?.sessionUpdate === 'usage_update') {
    return pushSystemEvent(timeline, 'usage_update', payload);
  }

  if (eventType === 'artifact' || payload?.type === 'artifact') {
    return pushSystemEvent(timeline, 'artifact', payload);
  }

  if (eventType === 'checkpoint' || payload?.type === 'checkpoint') {
    return pushSystemEvent(timeline, 'checkpoint', payload);
  }

  if (eventType === 'taskCreated' || eventType === 'taskStatus' || payload?.type === 'taskCreated' || payload?.type === 'taskStatus') {
    return pushSystemEvent(timeline, eventType, payload);
  }

  if (eventType === 'goal-progress' || eventType === 'goal-status' || payload?.type === 'goal-progress' || payload?.type === 'goal-status') {
    return pushSystemEvent(timeline, eventType, payload);
  }

  // compact 上下文压缩流程条目：payload.phase ∈ 'compacting' | 'compacted' | 'cancelled'。
  // compacting 去重：若时间线末尾已有 phase=compacting 的 compact 条目，不重复追加。
  if (eventType === 'compact' || payload?.type === 'compact') {
    const phase = payload?.phase || payload?.meta?.phase;
    if (phase === 'compacting') {
      const last = timeline[timeline.length - 1];
      if (last && last.type === 'compact' && last.meta?.phase === 'compacting') return timeline;
    }
    return pushSystemEvent(timeline, 'compact', { ...payload, type: 'compact', phase });
  }

  if (eventType === 'question_answered' || payload?.type === 'question_answered') {
    return [
      ...timeline,
      createTimelineEntry({
        type: 'question_answered',
        role: 'system',
        content: '已回答问题',
        raw: payload,
        meta: payload,
        streaming: false,
      }),
    ];
  }

  if (eventType === 'promptSuggestion' || payload?.type === 'promptSuggestion') {
    const suggestion = payload?.suggestion || (typeof payload === 'string' ? payload : '');
    return [
      ...timeline,
      createTimelineEntry({
        type: 'promptSuggestion',
        role: 'system',
        content: suggestion ? `建议: ${suggestion}` : '收到建议',
        raw: payload,
        meta: payload,
        streaming: false,
      }),
    ];
  }

  if (eventType === 'teamUpdate' || payload?.type === 'teamUpdate') {
    return [
      ...timeline,
      createTimelineEntry({
        type: 'teamUpdate',
        role: 'system',
        content: '团队更新',
        raw: payload,
        meta: payload,
        streaming: false,
      }),
    ];
  }

  if (eventType === 'initialized') return timeline; // 系统内部事件，不渲染到对话

  // 模式切换已在输入栏展示；不在对话记录里刷「模式更新」分隔线。
  if (eventType === 'mode_update' || eventType === 'current_mode_update') return timeline;

  if (eventType === 'session_end' || payload?.sessionUpdate === 'session_end') return timeline;

  // status_change drives thread.status elsewhere; model_update is chrome outside the stream.
  // Do not paint protocol separators in the chat timeline (WebUI has no "状态变更" lines).
  if (eventType === 'status_change' || eventType === 'model_update') return timeline;

  return pushSystemEvent(timeline, eventType, payload);
}
