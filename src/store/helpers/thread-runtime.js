export function emptyThreadRuntime() {
  return {
    connectionState: 'disconnected',
    timeline: [],
    permissionRequests: [],
    questions: [],
    usage: null,
    availableCommands: [],
    isAwaitingResponse: false,
    promptStartedAt: null,
    activePromptRunId: null,
    // H1: track the most recently finalized prompt run so late SSE content chunks
    // that arrive after `activePromptRunId` is cleared can still be correlated and
    // appended to the last assistant message instead of being dropped.
    lastPromptRunId: null,
    lastPromptRunAt: 0,
    backgroundDrainRunId: null,
    backgroundDrainUntil: 0,
    backgroundDrainMaxUntil: 0,
    promptDispatched: false,
    promptQueue: [],
    // P0-4: set while a queued prompt has been popped from promptQueue but its
    // session/prompt dispatch has not completed. sendPrompt's busy check treats
    // this as busy, closing the "queue item popped, isAwaitingResponse not yet
    // set" window where a second sendPrompt could double-dispatch.
    promptDispatchInFlight: false,
    pendingAttachments: [],
    promptSuggestion: null,
    teamState: null,
    lastTeamState: null,
    memberHistoriesByName: {},
    subagentToolCalls: {},
    workflowState: null,
    lastWorkflowState: null,
    goalState: null,
    lastGoalState: null,
    subagentReports: [],
    lastSubagentReports: [],
    rawExtensionEvents: [],
    agentPhase: null,
    progress: null,
    // compact 流程状态：null | 'compacting' | 'compacted' | 'cancelled'。
    // compacting 由 codebuddy.ai/progress.type==='compacting' 置位，终态由
    // progress 转非 compacting 或 codebuddy.ai/compact-cancelled 写入时间线后清空。
    compactState: null,
    compactCancelled: false,
    historyReplayActive: false,
    // 压缩完成后若 turn 仍忙，session/load 用量刷新推迟到终态。
    usageRefreshPending: false,
    sessionRestoreNeeded: false,
    models: [],
    modes: [],
    currentModel: null,
    currentMode: 'default',
    thoughtLevel: null,
    thoughtLevelOptions: [],
    capabilities: {},
  };
}

function isUserTimelineMessage(item) {
  return item?.type === 'message' && item?.role === 'user';
}

function countUserTimelineMessages(timeline) {
  if (!Array.isArray(timeline) || timeline.length === 0) return 0;
  let count = 0;
  for (const item of timeline) {
    if (isUserTimelineMessage(item)) count += 1;
  }
  return count;
}

function timelineEntryIdentity(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.id) return `id:${item.id}`;
  if (item.messageId) return `mid:${item.role || ''}:${item.messageId}`;
  if (isUserTimelineMessage(item)) {
    return `user:${Number(item.createdAt) || 0}:${String(item.content || '')}`;
  }
  return null;
}

function mergeMissingUserMessages(runtime, thread) {
  const seen = new Set();
  for (const item of runtime) {
    const key = timelineEntryIdentity(item);
    if (key) seen.add(key);
    if (isUserTimelineMessage(item)) {
      seen.add(`user-content:${String(item.content || '')}`);
    }
  }

  const missing = [];
  for (const item of thread) {
    if (!isUserTimelineMessage(item)) continue;
    const key = timelineEntryIdentity(item);
    if (key && seen.has(key)) continue;
    const contentKey = `user-content:${String(item.content || '')}`;
    if (seen.has(contentKey)) continue;
    missing.push(item);
    if (key) seen.add(key);
    seen.add(contentKey);
  }
  if (!missing.length) return runtime;

  return [...runtime, ...missing].sort(
    (a, b) => Number(a?.createdAt || 0) - Number(b?.createdAt || 0),
  );
}

/**
 * Pick the timeline to show for a thread.
 * Runtime `timeline: []` is truthy in JS, so `runtime.timeline || thread.timeline`
 * incorrectly prefers an empty live array over the persisted thread history and
 * hides user (and all other) messages after reconnect / re-init.
 *
 * Also: a non-empty runtime that lost user bubbles (reconnect / partial history
 * replay / assistant-only stream) must not hide disk user messages.
 */
export function resolveThreadTimeline(runtimeTimeline, threadTimeline) {
  const runtime = Array.isArray(runtimeTimeline) ? runtimeTimeline : [];
  const thread = Array.isArray(threadTimeline) ? threadTimeline : [];
  if (!runtime.length) return thread;
  if (!thread.length) return runtime;

  const runtimeUsers = countUserTimelineMessages(runtime);
  const threadUsers = countUserTimelineMessages(thread);

  // Degraded live timeline: tools/thinking/assistant only — prefer disk history.
  if (runtimeUsers === 0 && threadUsers > 0) return thread;

  // Always re-inject any disk user turns the live timeline lost (reconnect / partial
  // history / slice). Cheap no-op when both sides already share the same users.
  if (threadUsers > 0) {
    const merged = mergeMissingUserMessages(runtime, thread);
    if (merged !== runtime) return merged;
  }

  // Both healthy: prefer the longer sequence (usually the live runtime).
  if (thread.length > runtime.length && threadUsers >= runtimeUsers) return thread;
  return runtime;
}

export const ACTIVE_THREAD_RUNTIME_KEYS = [
  'connectionState',
  'timeline',
  'permissionRequests',
  'questions',
  'usage',
  'availableCommands',
  'isAwaitingResponse',
  'promptStartedAt',
  'activePromptRunId',
  'lastPromptRunId',
  'lastPromptRunAt',
  'backgroundDrainRunId',
  'backgroundDrainUntil',
  'backgroundDrainMaxUntil',
  'promptDispatched',
  'promptDispatchInFlight',
  'promptQueue',
  'pendingAttachments',
  'promptSuggestion',
  'teamState',
  'lastTeamState',
  'memberHistoriesByName',
  'subagentToolCalls',
  'workflowState',
  'lastWorkflowState',
  'goalState',
  'lastGoalState',
  'subagentReports',
  'lastSubagentReports',
  'rawExtensionEvents',
  'agentPhase',
  'progress',
  'compactState',
  'compactCancelled',
  'historyReplayActive',
  'usageRefreshPending',
  'models',
  'modes',
  'currentModel',
  'currentMode',
  'thoughtLevel',
  'thoughtLevelOptions',
  'capabilities',
];

export function responseTerminalRuntimePatch(patch = {}) {
  return {
    activePromptRunId: null,
    promptDispatchInFlight: false,
    promptDispatched: false,
    isAwaitingResponse: false,
    promptStartedAt: null,
    historyReplayActive: false,
    agentPhase: null,
    progress: null,
    compactState: null,
    compactCancelled: false,
    teamState: null,
    // A new prompt/session reset/disconnect explicitly clears these per-turn details.
    // The active team/workflow objects are cleared below; final snapshots remain readable.
    workflowState: null,
    goalState: null,
    subagentReports: null,
    // 终态回合必须一并清空未决的权限/问答请求：否则失败/取消后残留的 permissionRequests
    // 会让 deriveWorkflowView 把已终态线程判定为 waiting_for_permission，且迟到中断事件
    // 能据此把线程状态复活为 waiting。cancelSession/disconnect 已显式传 [] 覆盖，不冲突。
    permissionRequests: [],
    questions: [],
    // 终态保留最后一次 goal/workflow projection，供右侧面板查看结果。
    lastWorkflowState: null,
    lastGoalState: null,
    lastSubagentReports: null,
    ...patch,
  };
}

export function sessionActionItemMatches(item, id) {
  if (!id) return false;
  return [
    item?.interruptionId,
    item?.toolCallId,
    item?.meta?.interruptionId,
    item?.meta?.toolCallId,
    item?.raw?.interruptionId,
    item?.raw?.toolCallId,
  ].includes(id);
}
