import {
  setAcpSessionToken,
  isAcpAuthenticationError,
  LATE_PROMPT_CORRELATION_MS,
} from '../../lib/acp';
import { closeAssistantStream, pushUserMessage, reduceAcpEvent, resetSeenContent, mergeMemberTimeline } from '../../lib/timeline';
import {
  appendRawExtensionEvent,
  completedTeamSnapshot,
  memberEventName,
  subagentMetadata,
  teamUpdateFromPayload,
} from '../../lib/acp-workflow-events';
import {
  activeProject,
  activeThread,
  createThreadRecord,
} from '../../lib/product-state';
import { visibleProjectThreads } from '../../lib/session-sidebar';
import { deleteSession as apiDeleteSession, renameSession as apiRenameSession } from '../../lib/ops';
import { saveGuiSettings } from '../../lib/gui-settings';
import { classifyPromptRefusal, normalizeLastAccountUser } from '../../lib/account-auth';
import { isCliPermissionBypassMode } from '../../lib/session-mode-labels';
import {
  hasCompletePromptResponse,
  hasPromptRunActivity,
  hasUsableAssistantBody,
} from '../helpers/prompt-completion';
import {
  emptyThreadRuntime,
  resolveThreadTimeline,
  responseTerminalRuntimePatch,
  sessionActionItemMatches,
  ACTIVE_THREAD_RUNTIME_KEYS,
} from '../helpers/thread-runtime';
import { resetProjectRuntimeViews } from '../helpers/terminal-workspace-state';

/**
 * Session lifecycle, conversation events, permissions, and prompt pipeline.
 */
export function createSessionsChatSlice(set, get, ctx) {
  const {
    conversations,
    // queues / helpers
    queueThreadMutation,
    queueSessionSettingOperation,
    runUniqueSessionAction,
    queuePromptQueueOperation,
    beginScopedRequest,
    isScopedRequestCurrent,
    beginProjectNavigation,
    isProjectNavigationCurrent,
    finishProjectNavigation,
    isProjectMutationNavigation,
    requestDirtyFileConfirmation,
    resetFileWorkspace,
    // pure helpers from store module
    serializePromptQueue,
    mergeTeamState,
    normalizeModels,
    normalizeModes,
    configOptionChoices,
    resolveAvailableSelection,
    threadResponseInProgress,
    threadSelectionProtection,
    cancelPendingTimelineActions,
    promptResultErrorMessage,
    waitForMilliseconds,
    isMethodNotFoundError,
    projectWithDeletedSession,
    RESPONSE_BUSY_STATUSES,
    PROMPT_CONTENT_SESSION_UPDATES,
    FINAL_RESPONSE_GRACE_MS,
  } = ctx;

  return {
  applySessionConfigUpdate(configOptions = [], { preserveModel = false, preserveMode = false, preserveThoughtLevel = false } = {}) {
    const next = {};
    for (const option of configOptions) {
      if (option.id === 'model') {
        if (!preserveModel) next.currentModel = option.currentValue;
        const models = normalizeModels(configOptionChoices(option));
        if (models.length) next.models = models;
      }
      if (option.id === 'mode') {
        if (!preserveMode) next.currentMode = option.currentValue;
        const modes = normalizeModes(configOptionChoices(option));
        if (modes.length) next.modes = modes;
      }
      if (option.id === 'thought_level') {
        if (!preserveThoughtLevel) next.thoughtLevel = option.currentValue;
        const opts = configOptionChoices(option);
        if (Array.isArray(opts) && opts.length) {
          next.thoughtLevelOptions = opts
            .map((o) => {
              const id = o?.value ?? o?.id;
              return id ? { id, name: o?.name || o?.label || id } : null;
            })
            .filter(Boolean);
        }
      }
    }
    return next;
  },

  handleSessionUpdate(update) {
    const su = update.sessionUpdate || update.session_update || update.type;
    if (!su) return;

    if (su === 'config_option_update') {
      const selectionProtection = threadSelectionProtection(get(), get().activeThreadId);
      const patch = get().applySessionConfigUpdate(update.configOptions || [], selectionProtection);
      set(patch);
      get().updateActiveThread({
        ...(patch.currentModel ? { modelId: patch.currentModel } : {}),
        ...(patch.currentMode ? { modeId: patch.currentMode } : {}),
      });
      return;
    }

    if (su === 'session_info_update') {
      const title = update.title || get().sessionTitle;
      set({ sessionTitle: title });
      if (title) get().updateActiveThread({ title });
      return;
    }

    if (su === 'usage_update') {
      const meta = update._meta || null;
      set({
        usage: {
          used: update.used,
          size: update.size,
          cost: update.cost ?? null,
          meta,
          usageByCategory: meta?.['codebuddy.ai/usageByCategory'] ?? null,
          updatedAt: Date.now(),
        },
      });
      return;
    }

    if (su === 'available_commands_update') {
      set({ availableCommands: update.availableCommands || [] });
      return;
    }

    if (su === 'interruption_request') {
      set((state) => ({ permissionRequests: [...state.permissionRequests, update] }));
      get().appendTimelineEvent(su, update);
      return;
    }

    if (su === 'question_request') {
      set((state) => ({ questions: [...state.questions, update] }));
      get().appendTimelineEvent(su, update);
      return;
    }

    // 内容事件：agent_message_chunk, agent_thought_chunk, tool_call, tool_call_update, status_change 等
    get().appendTimelineEvent(su || 'session/update', update);
  },

  handleThreadSessionUpdate(threadId, update) {
    const su = update.sessionUpdate || update.session_update || update.type;
    if (!su) return;
    const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
    const metadata = update._meta && typeof update._meta === 'object' ? update._meta : {};
    const contentEvent = ['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk', 'tool_call', 'tool_call_update'].includes(su);
    const memberName = memberEventName(update);
    const subagent = subagentMetadata(update);
    if (contentEvent && get().threadsById[threadId]?.status === 'cancelled') return;
    const runtimePatch = {};
    if (memberName && contentEvent) {
      const memberHistoriesByName = mergeMemberTimeline(
        runtime.memberHistoriesByName,
        memberName,
        su,
        update,
        threadId,
      );
      const subagentToolCalls = subagent?.parentToolCallId && update.toolCallId
        ? {
            ...(runtime.subagentToolCalls || {}),
            [update.toolCallId]: {
              toolCallId: update.toolCallId,
              parentToolCallId: subagent.parentToolCallId,
              memberName,
              subagentType: subagent.subagentType,
              status: update.status || null,
              updatedAt: Date.now(),
            },
          }
        : runtime.subagentToolCalls;
      get().patchThreadRuntime(threadId, { memberHistoriesByName, subagentToolCalls });
      return;
    }
    if (contentEvent && subagent?.parentToolCallId && update.toolCallId) {
      runtimePatch.subagentToolCalls = {
        ...(runtime.subagentToolCalls || {}),
        [update.toolCallId]: {
          toolCallId: update.toolCallId,
          parentToolCallId: subagent.parentToolCallId,
          memberName: subagent.memberName,
          subagentType: subagent.subagentType,
          status: update.status || null,
          updatedAt: Date.now(),
        },
      };
    }

    if (Object.prototype.hasOwnProperty.call(metadata, 'codebuddy.ai/promptSuggestion')) {
      runtimePatch.promptSuggestion = metadata['codebuddy.ai/promptSuggestion'] || null;
    }
    const teamUpdate = teamUpdateFromPayload(update);
    if (teamUpdate) {
      if (teamUpdate.type === 'team_deleted') {
        runtimePatch.lastTeamState = completedTeamSnapshot(runtime.teamState || runtime.lastTeamState, teamUpdate);
        runtimePatch.teamState = null;
      } else {
        runtimePatch.teamState = mergeTeamState(runtime.teamState, teamUpdate);
      }
    }
    if (Object.prototype.hasOwnProperty.call(metadata, 'codebuddy.ai/agentPhase')) {
      runtimePatch.agentPhase = metadata['codebuddy.ai/agentPhase'] || null;
    }
    if (Object.prototype.hasOwnProperty.call(metadata, 'codebuddy.ai/progress')) {
      runtimePatch.progress = metadata['codebuddy.ai/progress'] || null;
    }
    const privateKeys = Object.keys(metadata).filter((key) => key.startsWith('codebuddy.ai/'));
    const knownPrivateKeys = new Set([
      'codebuddy.ai/promptSuggestion',
      'codebuddy.ai/teamUpdate',
      'codebuddy.ai/agentPhase',
      'codebuddy.ai/progress',
      'codebuddy.ai/historyReplay',
      'codebuddy.ai/goalProgress',
      'codebuddy.ai/goalStatus',
      'codebuddy.ai/permissionResolved',
      'codebuddy.ai/toolCallId',
      'codebuddy.ai/compact-cancelled',
      'codebuddy.ai/interruptionRequest',
      'codebuddy.ai/memberEvent',
      'codebuddy.ai/parentToolCallId',
      'codebuddy.ai/isSubAgent',
      'codebuddy.ai/subagentType',
      'codebuddy.ai/description',
      'codebuddy.ai/isBackground',
      'codebuddy.ai/memberName',
    ]);
    const unknownPrivateKey = privateKeys.find((key) => !knownPrivateKeys.has(key));
    if (unknownPrivateKey) {
      runtimePatch.rawExtensionEvents = appendRawExtensionEvent(
        runtime.rawExtensionEvents,
        unknownPrivateKey,
        { key: unknownPrivateKey, value: metadata[unknownPrivateKey], update },
      );
    }
    if (metadata['codebuddy.ai/historyReplay'] === 'start') runtimePatch.historyReplayActive = true;
    if (metadata['codebuddy.ai/historyReplay'] === 'end') runtimePatch.historyReplayActive = false;

    // compact 流程：progress.type==='compacting' 进入压缩中；progress 转非 compacting
    // 且当前为 compacting → 压缩完成；codebuddy.ai/compact-cancelled → 取消。
    // 时间线条目由 reduceAcpEvent('compact', ...) 去重追加。
    const progressMeta = metadata['codebuddy.ai/progress'];
    const progressType = typeof progressMeta === 'string' ? progressMeta : progressMeta?.type;
    const prevCompactState = runtime.compactState;
    let compactTimelinePayload = null;
    if (Object.prototype.hasOwnProperty.call(metadata, 'codebuddy.ai/compact-cancelled')) {
      runtimePatch.compactCancelled = true;
      runtimePatch.compactState = 'cancelled';
      compactTimelinePayload = { phase: 'cancelled' };
    } else if (progressType === 'compacting') {
      if (prevCompactState !== 'compacting') {
        runtimePatch.compactState = 'compacting';
        compactTimelinePayload = { phase: 'compacting' };
      }
    } else if (prevCompactState === 'compacting' && progressType && progressType !== 'compacting') {
      // progress 转为其他类型且此前在 compacting → 视为完成。
      runtimePatch.compactState = 'compacted';
      compactTimelinePayload = { phase: 'compacted' };
    }
    if (Object.keys(runtimePatch).length) get().patchThreadRuntime(threadId, runtimePatch);
    if (compactTimelinePayload) {
      get().appendThreadTimelineEvent(threadId, 'compact', compactTimelinePayload);
    }

    if (metadata['codebuddy.ai/sessionReset'] && metadata['codebuddy.ai/newSessionId']) {
      get()
        .handleThreadSessionReset(threadId, metadata['codebuddy.ai/newSessionId'])
        .catch((error) => {
          console.warn('Failed to synchronize reset CodeBuddy session:', error);
        });
      return;
    }

    if (metadata['codebuddy.ai/permissionResolved']) {
      const interruptionId = metadata['codebuddy.ai/toolCallId'];
      const decision = metadata['codebuddy.ai/decision'];
      if (interruptionId && decision && get().applyInterruptionResolution(threadId, interruptionId, decision)) {
        get().persistProductState();
      }
    }

    for (const [metadataKey, eventType] of [
      ['codebuddy.ai/goalProgress', 'goal-progress'],
      ['codebuddy.ai/goalStatus', 'goal-status'],
    ]) {
      const goalEvent = metadata[metadataKey];
      if (!goalEvent || typeof goalEvent !== 'object') continue;
      const currentTimeline = get().threadRuntimeById[threadId]?.timeline || runtime.timeline;
      const duplicate =
        goalEvent.id &&
        currentTimeline.some(
          (item) => item.type === eventType && (item.meta?.id === goalEvent.id || item.raw?.id === goalEvent.id),
        );
      if (!duplicate) get().appendThreadTimelineEvent(threadId, eventType, { ...goalEvent, type: eventType });
    }

    if (su === 'config_option_update') {
      const selectionProtection = threadSelectionProtection(get(), threadId);
      const patch = get().applySessionConfigUpdate(update.configOptions || [], selectionProtection);
      get().patchThreadRuntime(threadId, patch);
      get().updateThreadRecord(threadId, {
        ...(patch.currentModel ? { modelId: patch.currentModel } : {}),
        ...(patch.currentMode ? { modeId: patch.currentMode } : {}),
      });
      return;
    }
    if (su === 'session_info_update') {
      if (update.title) get().updateThreadRecord(threadId, { title: update.title });
      if (get().activeThreadId === threadId) set({ sessionTitle: update.title || get().sessionTitle });
      return;
    }
    if (su === 'usage_update') {
      const meta = update._meta || null;
      get().patchThreadRuntime(threadId, {
        usage: {
          used: update.used,
          size: update.size,
          cost: update.cost ?? null,
          meta,
          usageByCategory: meta?.['codebuddy.ai/usageByCategory'] ?? null,
          updatedAt: Date.now(),
        },
      });
      return;
    }
    if (su === 'available_commands_update') {
      get().patchThreadRuntime(threadId, { availableCommands: update.availableCommands || [] });
      return;
    }
    if (su === 'interruption_request') {
      // CLI 2.125 surfaces AskUserQuestion as interruption_request (WebUI parity):
      // map to a question card so cancel uses resolveInterruption(deny) / cancelled outcome,
      // never session/cancel.
      const toolName = update.toolName || update.toolTitle || '';
      if (toolName === 'AskUserQuestion') {
        const rawQuestions =
          (Array.isArray(update.toolInput?.questions) && update.toolInput.questions) ||
          (Array.isArray(update.toolInput?.schema?.questions) && update.toolInput.schema.questions) ||
          [];
        const questions = rawQuestions.map((question, index) => ({
          id: question.id || `q_${index}`,
          question: question.question || '',
          header: question.header || '',
          options: (question.options || [])
            .map((option) =>
              typeof option === 'string'
                ? { label: option, value: option, description: '' }
                : {
                    label: option.label || option.value || option.id || '',
                    value: option.value || option.id || option.label || '',
                    description: option.description || '',
                  },
            )
            .filter((option) => option.value),
          multiSelect: Boolean(question.multiSelect),
        }));
        const questionUpdate = {
          sessionUpdate: 'question_request',
          toolCallId: update.toolCallId || update.interruptionId,
          sessionId: update.sessionId || null,
          questions,
          responseMode: 'interruption',
          source: 'interruption',
          interruptionId: update.interruptionId || null,
        };
        const requestId = questionUpdate.toolCallId;
        if (requestId && runtime.questions.some((item) => sessionActionItemMatches(item, requestId))) return;
        get().patchThreadRuntime(threadId, { questions: [...runtime.questions, questionUpdate] });
        get().appendThreadTimelineEvent(threadId, 'question_request', questionUpdate);
        get().updateThreadRecord(threadId, { status: 'waiting', unread: get().activeThreadId !== threadId });
        return;
      }
      const requestIds = [update.interruptionId, update.toolCallId].filter(Boolean);
      if (
        requestIds.some((requestId) =>
          runtime.permissionRequests.some((item) => sessionActionItemMatches(item, requestId)),
        )
      )
        return;
      // 本会话自动通过文件编辑权限：当 GUI 设置开启且该中断属于文件编辑类工具时，
      // 直接以 allow 响应，不弹出权限对话框（与 WebUI「本会话自动通过文件编辑权限」语义一致）。
      const autoAllowFileEdits = get().guiSettings?.sessionAutoAllowFileEdits === true;
      if (autoAllowFileEdits && toolName !== 'AskUserQuestion') {
        const lowerTool = String(toolName || '').toLowerCase();
        const isFileEdit = /edit|write|create|str_replace|file|apply.*patch|update.*file/.test(lowerTool);
        if (isFileEdit) {
          const autoInterruptionId = update.interruptionId || requestIds[0] || null;
          const autoToolCallId = update.toolCallId || null;
          // Append a brief timeline entry so the auto-allow is visible, then resolve.
          get().appendThreadTimelineEvent(threadId, su, { ...update, _autoAllowed: true });
          queueMicrotask(() => {
            get().respondToInterruption(autoInterruptionId, 'allow', autoToolCallId).catch(() => null);
          });
          return;
        }
      }
      get().patchThreadRuntime(threadId, { permissionRequests: [...runtime.permissionRequests, update] });
      get().appendThreadTimelineEvent(threadId, su, update);
      get().updateThreadRecord(threadId, { status: 'waiting', unread: get().activeThreadId !== threadId });
      return;
    }
    if (su === 'question_request') {
      const requestId = update.toolCallId;
      if (requestId && runtime.questions.some((item) => sessionActionItemMatches(item, requestId))) return;
      get().patchThreadRuntime(threadId, { questions: [...runtime.questions, update] });
      get().appendThreadTimelineEvent(threadId, su, update);
      get().updateThreadRecord(threadId, { status: 'waiting', unread: get().activeThreadId !== threadId });
      return;
    }
    if (su === 'status_change') {
      const rawStatus = update.status || update.state || '';
      const normalizedStatus = ['completed', 'complete', 'idle', 'ready'].includes(rawStatus)
        ? 'idle'
        : ['cancelled', 'canceled'].includes(rawStatus)
          ? 'cancelled'
          : ['error', 'failed'].includes(rawStatus)
            ? 'error'
            : rawStatus || 'running';
      if (['idle', 'error', 'cancelled'].includes(normalizedStatus)) {
        const latestRuntime = get().threadRuntimeById[threadId] || runtime;
        const client = conversations.peek(threadId) || get().getThreadClient(threadId);
        const sessionId = get().threadsById[threadId]?.sessionId || latestRuntime.sessionId;
        const requestStillActive = Boolean(
          latestRuntime.activePromptRunId && client?.hasActivePrompt?.(sessionId),
        );
        if (!requestStillActive) {
          get().flushThreadTimelineCoalesce?.(threadId);
          const flushedRuntime = get().threadRuntimeById[threadId] || latestRuntime;
          const terminalPatch = responseTerminalRuntimePatch({ timeline: closeAssistantStream(flushedRuntime.timeline) });
          if (flushedRuntime.teamState) {
            terminalPatch.lastTeamState = completedTeamSnapshot(
              flushedRuntime.teamState,
              { type: 'team_deleted', status: normalizedStatus === 'error' ? 'failed' : normalizedStatus === 'cancelled' ? 'cancelled' : 'completed' },
            );
          }
          get().patchThreadRuntime(
            threadId,
            terminalPatch,
          );
        }
      }
      get().updateThreadRecord(threadId, {
        status: normalizedStatus,
        unread: get().activeThreadId !== threadId && ['idle', 'error', 'cancelled'].includes(normalizedStatus),
      });
    }
    get().appendThreadTimelineEvent(threadId, su, update);
  },

  handleConversationEvent({ threadId, type, detail }) {
    const thread = get().threadsById[threadId];
    const eventSessionId = detail?.sessionId || null;
    if (eventSessionId && thread?.sessionId && eventSessionId !== thread.sessionId) return;

    const client = conversations.peek(threadId);
    if (type === 'connected') {
      get().patchThreadRuntime(threadId, {
        connectionState: 'connected',
        agentPhase: null,
        progress: null,
        historyReplayActive: false,
      });
      if (get().activeThreadId === threadId) {
        set({ sessionToken: client?.sessionToken || null, error: null });
        setAcpSessionToken(client?.sessionToken || null);
      }
      return;
    }
    if (type === 'reconnecting') {
      get().patchThreadRuntime(threadId, { connectionState: 'reconnecting' });
      return;
    }
    if (type === 'reconnected') {
      get().patchThreadRuntime(threadId, { connectionState: 'connected' });
      return;
    }
    if (type === 'reconnect_failed') {
      get().flushThreadTimelineCoalesce?.(threadId);
      const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      get().patchThreadRuntime(
        threadId,
        responseTerminalRuntimePatch({
          connectionState: 'error',
          timeline: closeAssistantStream(runtime.timeline),
        }),
      );
      get().updateThreadRecord(threadId, { status: 'error', unread: get().activeThreadId !== threadId });
      return;
    }
    if (type === 'session/update') {
      const update = (detail || {}).update || {};
      const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      const promptRunId = detail?._client?.promptRunId || null;
      const sessionUpdate = update.sessionUpdate || update.session_update || update.type;
      const promptContentEvent = PROMPT_CONTENT_SESSION_UPDATES.has(sessionUpdate);
      const memberContentEvent = promptContentEvent && Boolean(memberEventName(update));
      if (memberContentEvent && runtime.teamState) {
        get().handleThreadSessionUpdate(threadId, update);
        return;
      }
      if (promptContentEvent && promptRunId && promptRunId !== runtime.activePromptRunId) {
        // H1: accept late content chunks for the just-finalized run. After a prompt
        // succeeds/is cancelled, `activePromptRunId` is cleared but the transport
        // layer keeps correlating late SSE chunks to that run id for up to
        // LATE_PROMPT_CORRELATION_MS. Without this, the tail of the assistant
        // answer (or post-cancel final tokens) is silently dropped.
        const recent =
          runtime.lastPromptRunId &&
          promptRunId === runtime.lastPromptRunId &&
          Date.now() - runtime.lastPromptRunAt < LATE_PROMPT_CORRELATION_MS;
        if (!recent) return;
      }
      if (promptContentEvent && !promptRunId && runtime.activePromptRunId && !runtime.historyReplayActive) {
        // H1: same idea — a chunk without a run id that matches the just-finished run
        // is still useful (transport correlates by recency), so accept it while the
        // late-correlation window is open.
        const recentUnmarked =
          runtime.lastPromptRunId &&
          Date.now() - runtime.lastPromptRunAt < LATE_PROMPT_CORRELATION_MS;
        if (!recentUnmarked) return;
      }
      if (
        promptContentEvent &&
        !promptRunId &&
        !runtime.activePromptRunId &&
        !runtime.isAwaitingResponse &&
        !runtime.historyReplayActive &&
        !['connecting', 'running', 'waiting'].includes(thread?.status)
      ) {
        return;
      }
      get().handleThreadSessionUpdate(threadId, update);
      return;
    }
    if (type === 'initialized') {
      get().patchThreadRuntime(threadId, { capabilities: detail?.agentCapabilities || detail || {} });
      return;
    }
    if (type === 'interruption_request' || type === 'question_request') {
      get().handleThreadSessionUpdate(threadId, { ...(detail || {}), sessionUpdate: type });
      return;
    }
    if (type === '_codebuddy.ai/authUrl') {
      // CLI 推送登录链接（ACP 扩展通知）：Windows 上 CLI 自身的
      // rundll32 url,OpenURL 静默失败，必须由 GUI 打开浏览器。
      get().handleAccountAuthUrl(detail || {});
      return;
    }
    if (type === 'checkpoint') {
      // Live 2.125: checkpoint list may omit files[]; events carry absolute uri list.
      const payload = detail || {};
      const checkpoint = payload.checkpoint || payload;
      const id = checkpoint?.id || payload.checkpointId || '';
      const rawFiles =
        checkpoint?.fileChanges?.files ||
        checkpoint?.files ||
        checkpoint?.paths ||
        [];
      const paths = (Array.isArray(rawFiles) ? rawFiles : [])
        .map((item) => {
          if (typeof item === 'string') return item;
          return item?.uri || item?.path || item?.filePath || item?.file || '';
        })
        .map((p) => String(p || '').trim())
        .filter(Boolean);
      if (id && paths.length) {
        set((state) => ({
          agentCheckpointPathsById: {
            ...(state.agentCheckpointPathsById || {}),
            [id]: paths,
          },
        }));
      }
      return;
    }
    if (type === 'interaction_requests_invalidated') {
      const interruptionIds = new Set(detail?.interruptionIds || []);
      const questionToolCallIds = new Set(detail?.questionToolCallIds || []);
      const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      const invalidatedAt = Date.now();
      // M-st3: avoid re-allocating an array from the id Sets on every timeline
      // item. Iterate the Sets directly with for...of, which is O(|set|) per item
      // but does not allocate an array each time.
      const matchesAnyId = (item, idSet) => {
        if (!idSet.size) return false;
        for (const id of idSet) {
          if (sessionActionItemMatches(item, id)) return true;
        }
        return false;
      };
      const invalidates = (item) =>
        (item.type === 'interruption' && matchesAnyId(item, interruptionIds)) ||
        (item.type === 'question' && matchesAnyId(item, questionToolCallIds));
      const timeline = runtime.timeline.map((item) =>
        invalidates(item) && !['resolved', 'answered', 'cancelled', 'expired'].includes(item.status)
          ? {
              ...item,
              status: 'expired',
              meta: {
                ...(item.meta || {}),
                invalidatedAt,
                invalidationReason: detail?.reason || 'connection-replaced',
              },
            }
          : item,
      );
      const permissionRequests = runtime.permissionRequests.filter(
        (item) => !matchesAnyId(item, interruptionIds),
      );
      const questions = runtime.questions.filter(
        (item) => !matchesAnyId(item, questionToolCallIds),
      );
      const changed =
        permissionRequests.length !== runtime.permissionRequests.length ||
        questions.length !== runtime.questions.length ||
        timeline.some((item, index) => item !== runtime.timeline[index]);
      if (!changed) return;
      get().patchThreadRuntime(threadId, { permissionRequests, questions, timeline });
      // P1-2: for a user-initiated project stop (or runtime loss) the pending
      // requests simply expire — do NOT turn the thread into `error` with a
      // misleading "连接已更换" lastError. `disconnectProjectThreads` marks the
      // thread disconnected right after this. The genuine "connection replaced"
      // case (switching projects / reconnecting) keeps the error marking.
      const stoppedLike = detail?.reason === 'project-stopped' || detail?.reason === 'runtime-lost';
      if (stoppedLike) return;
      const message = '连接已更换，之前待处理的权限或问题请求已失效。';
      set((state) => {
        const record = state.threadsById[threadId];
        if (!record) return {};
        return {
          threadsById: {
            ...state.threadsById,
            [threadId]: {
              ...record,
              timeline: timeline.slice(-300),
              status: record.status === 'waiting' ? 'error' : record.status,
              metadata: { ...(record.metadata || {}), lastError: message },
              updatedAt: new Date().toISOString(),
            },
          },
          ...(state.activeThreadId === threadId ? { error: message } : {}),
        };
      });
      get().persistProductState();
      return;
    }
    if (type === 'model_update') {
      const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      const { preserveModel } = threadSelectionProtection(get(), threadId);
      const currentModel = preserveModel ? runtime.currentModel : detail?.currentModelId || runtime.currentModel;
      get().patchThreadRuntime(threadId, {
        models: normalizeModels(detail?.availableModels || runtime.models),
        currentModel,
      });
      if (!preserveModel) get().updateThreadRecord(threadId, { modelId: currentModel });
      return;
    }
    if (type === 'mode_update' || type === 'current_mode_update') {
      const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      const { preserveMode } = threadSelectionProtection(get(), threadId);
      const currentMode = preserveMode ? runtime.currentMode : detail?.currentModeId || runtime.currentMode;
      get().patchThreadRuntime(threadId, {
        ...(type === 'mode_update' ? { modes: normalizeModes(detail?.availableModes || runtime.modes) } : {}),
        currentMode,
      });
      if (!preserveMode) get().updateThreadRecord(threadId, { modeId: currentMode });
      return;
    }
    if (type === 'promptSuggestion') {
      get().patchThreadRuntime(threadId, { promptSuggestion: detail });
      return;
    }
    if (type === 'teamUpdate') {
      const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      const teamUpdate = teamUpdateFromPayload({ _meta: { 'codebuddy.ai/teamUpdate': detail } }) || detail;
      if (teamUpdate?.type === 'team_deleted') {
        get().patchThreadRuntime(threadId, {
          teamState: null,
          lastTeamState: completedTeamSnapshot(runtime.teamState || runtime.lastTeamState, teamUpdate),
        });
      } else {
        get().patchThreadRuntime(threadId, { teamState: mergeTeamState(runtime.teamState, teamUpdate) });
      }
      return;
    }
    if (type === 'raw_extension') {
      const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      get().patchThreadRuntime(threadId, {
        rawExtensionEvents: appendRawExtensionEvent(
          runtime.rawExtensionEvents,
          detail?.method || 'raw_extension',
          detail?.params || detail,
          'codebuddy-private',
        ),
      });
      return;
    }
    get().appendThreadTimelineEvent(threadId, type === '_codebuddy.ai/artifact' ? 'artifact' : type, detail);
  },

  async initializeActiveThread(sessionIdOverride) {
    const project = activeProject(get());
    const thread = activeThread(get());
    if (!project || !thread) {
      set({ connectionState: 'disconnected' });
      return false;
    }
    const request = beginScopedRequest('initializeActiveThread', get(), 'threadId');

    const existingClient = conversations.peek(thread.id);
    if (existingClient?.connected && existingClient?.initialized && thread.sessionId) {
      get().activateThreadRuntime(thread.id);
      set({
        sessionId: thread.sessionId,
        sessionTitle: thread.title,
        workspacePath: project.workspacePath,
        connectionState: existingClient.connectionState,
      });
      // 复用已连接 client 时若没有进行中的 prompt，清掉磁盘/异常残留的 busy 态
      const sessionStillBusy = Boolean(existingClient.hasActivePrompt?.(thread.sessionId));
      if (!sessionStillBusy) {
        get().flushThreadTimelineCoalesce?.(thread.id);
        const latestRuntime = get().threadRuntimeById[thread.id] || emptyThreadRuntime();
        get().patchThreadRuntime(
          thread.id,
          responseTerminalRuntimePatch({
            timeline: closeAssistantStream(latestRuntime.timeline),
            connectionState: existingClient.connectionState || 'connected',
          }),
        );
      }
      // 复用连接时 CLI 可能已漂移（登录/重启后）：把 GUI 会话偏好重新写回 CLI。
      if (typeof existingClient.request === 'function' && !sessionStillBusy) {
        const latestRuntime = get().threadRuntimeById[thread.id] || emptyThreadRuntime();
        const modeId = latestRuntime.currentMode || thread.modeId || null;
        const modelId = latestRuntime.currentModel || thread.modelId || null;
        const thoughtLevel = latestRuntime.thoughtLevel || get().thoughtLevel || null;
        const sessionId = thread.sessionId;
        if (modeId) {
          try {
            await existingClient.request('session/set_mode', { sessionId, modeId });
          } catch (modeError) {
            console.warn(
              `[session] reassert mode ${modeId} failed:`,
              modeError?.message || modeError,
            );
          }
        }
        if (modelId) {
          try {
            await existingClient.request('session/set_model', { sessionId, modelId });
          } catch (modelError) {
            console.warn(
              `[session] reassert model ${modelId} failed:`,
              modelError?.message || modelError,
            );
          }
        }
        // ultracode 是 GUI 复合态，不是 CLI thought_level 字面量。
        if (thoughtLevel && thoughtLevel !== 'ultracode') {
          try {
            await existingClient.request('session/set_config_option', {
              sessionId,
              configId: 'thought_level',
              value: thoughtLevel,
            });
          } catch (thoughtError) {
            console.warn(
              `[session] reassert thought_level ${thoughtLevel} failed:`,
              thoughtError?.message || thoughtError,
            );
          }
        }
      }
      await get().updateThreadRecord(thread.id, {
        unread: false,
        lastOpenedAt: new Date().toISOString(),
        ...(sessionStillBusy ? {} : { status: 'idle' }),
      });
      return isScopedRequestCurrent(request, get());
    }

    const client = get().getThreadClient(thread.id);
    if (!client) {
      set({ connectionState: 'error', error: '项目运行时尚未就绪' });
      return false;
    }

    resetSeenContent(thread.id);
    const requestedSessionId = sessionIdOverride === undefined ? thread.sessionId : sessionIdOverride;
    const preservedRuntime = get().threadRuntimeById[thread.id] || emptyThreadRuntime();
    // Prefer non-empty runtime timeline; empty [] must not hide persisted thread history
    // (user bubbles vanish if we keep runtime.timeline || thread.timeline).
    const restoredTimeline = resolveThreadTimeline(preservedRuntime.timeline, thread.timeline);
    set({
      sessionId: requestedSessionId || null,
      timeline: closeAssistantStream(restoredTimeline),
      permissionRequests: [],
      questions: [],
      sessionTitle: thread.title || null,
      usage: null,
      availableCommands: [],
      workspacePath: project.workspacePath,
      connectionState: 'connecting',
    });
    const preservedPromptQueue = preservedRuntime.promptQueue?.length
      ? preservedRuntime.promptQueue
      : serializePromptQueue(thread.metadata?.promptQueue);
    get().patchThreadRuntime(thread.id, {
      ...emptyThreadRuntime(),
      timeline: closeAssistantStream(restoredTimeline.slice(-300)),
      promptQueue: preservedPromptQueue,
      pendingAttachments: preservedRuntime.pendingAttachments || [],
      promptSuggestion: preservedRuntime.promptSuggestion || null,
      connectionState: 'connecting',
      currentModel: thread.modelId || null,
      currentMode: thread.modeId || 'default',
    });
    await get().updateActiveThread({ status: 'connecting', lastOpenedAt: new Date().toISOString() });

    const applyInitializedSession = async (init, loaded, recoveryError = null) => {
      const threadRuntime = get().threadRuntimeById[thread.id] || emptyThreadRuntime();
      const configPatch = get().applySessionConfigUpdate(
        loaded?.configOptions || init?.configOptions || init?.agentCapabilities?.configOptions || [],
      );
      const availableModels =
        loaded?.models?.availableModels ||
        init?.models?.availableModels ||
        init?.agentCapabilities?.availableModels ||
        configPatch.models ||
        threadRuntime.models;
      const normalizedModels = normalizeModels(availableModels);
      const persistedModel = thread.modelId || threadRuntime.currentModel;
      const cliCurrentModel =
        loaded?.models?.currentModelId || init?.models?.currentModelId || configPatch.currentModel || null;
      const currentModel =
        resolveAvailableSelection(normalizedModels, persistedModel) ||
        resolveAvailableSelection(normalizedModels, cliCurrentModel) ||
        cliCurrentModel;
      const availableModes =
        loaded?.modes?.availableModes || init?.modes?.availableModes || configPatch.modes || threadRuntime.modes;
      const normalizedModes = normalizeModes(availableModes);
      const persistedMode = thread.modeId || threadRuntime.currentMode;
      const cliCurrentMode =
        loaded?.modes?.currentModeId || init?.modes?.currentModeId || configPatch.currentMode || null;
      // 优先沿用会话已保存的 mode（如 fullAccess），否则用 CLI 当前 mode。
      let currentMode =
        resolveAvailableSelection(normalizedModes, persistedMode) ||
        resolveAvailableSelection(normalizedModes, cliCurrentMode) ||
        cliCurrentMode ||
        'default';
      let appliedModel = currentModel;
      let appliedMode = currentMode;
      const resolvedSessionId = loaded?.sessionId || (recoveryError ? null : requestedSessionId) || null;
      const resolvedTitle = loaded?.title || loaded?.name || thread.title || '新对话';
      const stillActive = isScopedRequestCurrent(request, get());
      const thoughtLevel = configPatch.thoughtLevel ?? threadRuntime.thoughtLevel ?? null;
      const thoughtLevelOptions =
        configPatch.thoughtLevelOptions || threadRuntime.thoughtLevelOptions || [];

      // 权限/模型以 CLI 为准：本地偏好与 CLI 不一致时写回；失败则 UI 回落到 CLI 值。
      if (stillActive && resolvedSessionId && typeof client?.request === 'function') {
        if (appliedMode && appliedMode !== cliCurrentMode) {
          try {
            await client.request('session/set_mode', {
              sessionId: resolvedSessionId,
              modeId: appliedMode,
            });
          } catch (modeError) {
            console.warn(
              `[session] failed to sync mode ${appliedMode} to CLI:`,
              modeError?.message || modeError,
            );
            appliedMode = cliCurrentMode || 'default';
            if (isCliPermissionBypassMode(currentMode)) {
              set({
                error: `无法将权限模式切换为「${currentMode}」，已回落为 CLI 当前模式。请重试切换。`,
              });
            }
          }
        }
        if (appliedModel && appliedModel !== cliCurrentModel) {
          try {
            await client.request('session/set_model', {
              sessionId: resolvedSessionId,
              modelId: appliedModel,
            });
          } catch (modelError) {
            console.warn(
              `[session] failed to sync model ${appliedModel} to CLI:`,
              modelError?.message || modelError,
            );
            appliedModel = cliCurrentModel || appliedModel;
          }
        }
        // 会话级思考档：若 runtime 仍有非 ultracode 偏好且与 CLI config 不同，写回。
        const preferredThought =
          threadRuntime.thoughtLevel && threadRuntime.thoughtLevel !== 'ultracode'
            ? threadRuntime.thoughtLevel
            : null;
        const cliThought = configPatch.thoughtLevel ?? null;
        if (preferredThought && preferredThought !== cliThought) {
          try {
            await client.request('session/set_config_option', {
              sessionId: resolvedSessionId,
              configId: 'thought_level',
              value: preferredThought,
            });
          } catch (thoughtError) {
            console.warn(
              `[session] failed to sync thought_level ${preferredThought} to CLI:`,
              thoughtError?.message || thoughtError,
            );
          }
        }
      }
      currentMode = appliedMode;
      const resolvedModel = appliedModel;

      // P0-2: re-evaluate currency right before the global mirror `set()`. The
      // `stillActive` computed above predates up to 3 awaited sync RPCs
      // (set_mode/set_model/set_config_option); if the user switched threads
      // while those were in flight, writing the OLD thread's sessionId/title/
      // model/connectionState into the global active state would pollute the new
      // active thread's UI. Thread-keyed state (threadRuntimeById / records) is
      // safe — only the global mirror needs the fresh check.
      if (isScopedRequestCurrent(request, get())) {
        // 会话 ACP 连接/加载成功：若此前误标 required/error，可清掉。
        // session/new|load 成功本身说明云端鉴权对当前 CLI 可用，优先恢复 authenticated
        //（尤其磁盘已有 lastAccountUser 时），避免侧栏一直「需要登录」。
        const authState = get().codeBuddyAccountAuthState;
        const clearAuthFailure = authState === 'required' || authState === 'error';
        const cachedUser =
          normalizeLastAccountUser(get().codeBuddyAccountUser) ||
          get().guiSettings?.lastAccountUser ||
          null;
        const restoreAuthenticated =
          clearAuthFailure ||
          authState === 'unknown' ||
          authState === 'authenticating';
        set({
          sessionId: resolvedSessionId,
          sessionTitle: resolvedTitle,
          currentModel: resolvedModel,
          models: normalizedModels,
          modes: normalizedModes,
          currentMode,
          ...(thoughtLevel != null ? { thoughtLevel } : {}),
          ...(thoughtLevelOptions.length ? { thoughtLevelOptions } : {}),
          connectionState: 'connected',
          ...(restoreAuthenticated
            ? {
                codeBuddyAccountAuthState: 'authenticated',
                codeBuddyAccountAuthUrl: null,
                codeBuddyAccountAuthError: null,
                ...(cachedUser && !get().codeBuddyAccountUser
                  ? { codeBuddyAccountUser: cachedUser }
                  : {}),
              }
            : {}),
        });
      }
      // Keep disk history if live runtime was emptied mid-connect (e.g. [] truthy overwrite).
      get().flushThreadTimelineCoalesce?.(thread.id);
      const latestThread = get().threadsById[thread.id] || thread;
      const flushedRuntime = get().threadRuntimeById[thread.id] || threadRuntime;
      const completedTimeline = closeAssistantStream(
        resolveThreadTimeline(flushedRuntime.timeline, latestThread.timeline),
      );
      get().patchThreadRuntime(thread.id, {
        sessionId: resolvedSessionId,
        connectionState: 'connected',
        currentModel: resolvedModel,
        models: normalizedModels,
        modes: normalizedModes,
        currentMode,
        ...(thoughtLevel != null ? { thoughtLevel } : {}),
        ...(thoughtLevelOptions.length ? { thoughtLevelOptions } : {}),
        capabilities: init?.agentCapabilities || threadRuntime.capabilities || {},
        timeline: completedTimeline,
        isAwaitingResponse: false,
        promptStartedAt: null,
        activePromptRunId: null,
        historyReplayActive: false,
        agentPhase: null,
        progress: null,
      });
      await get().updateThreadRecord(thread.id, {
        sessionId: resolvedSessionId,
        title: resolvedTitle,
        modelId: resolvedModel || null,
        modeId: currentMode || 'default',
        status: 'idle',
        unread: false,
        timeline: completedTimeline.slice(-300),
        metadata: recoveryError
          ? {
              ...(thread.metadata || {}),
              previousSessionId: requestedSessionId,
              recoveryError,
              recoveredAt: new Date().toISOString(),
              lastError: null,
            }
          : { ...(thread.metadata || {}), lastError: null },
      });
      if (recoveryError) {
        const currentTimeline = get().threadRuntimeById[thread.id]?.timeline || [];
        const warning = `原会话恢复失败，已创建新会话继续工作。${recoveryError}`;
        if (!currentTimeline.some((item) => item.content === warning))
          get().appendThreadTimelineEvent(thread.id, 'error', {
            type: 'error',
            message: warning,
          });
      }
      return isScopedRequestCurrent(request, get());
    };

    try {
      const knownRecoveryError = thread.metadata?.lastError || thread.metadata?.recoveryError || '';
      if (requestedSessionId && /(timeout|408)/i.test(knownRecoveryError)) {
        await client.connect();
        const init = await client.initialize();
        const loaded = await client.request('session/new', { cwd: project.workspacePath || '.', mcpServers: [] });
        return await applyInitializedSession(init, loaded, knownRecoveryError);
      }
      const { init, loaded } = await client.initializeSession(requestedSessionId || null, project.workspacePath || '.');
      return await applyInitializedSession(init, loaded);
    } catch (error) {
      if (isAcpAuthenticationError(error)) {
        const stillActive = isScopedRequestCurrent(request, get());
        const authMessage = error?.message || '需要登录 CodeBuddy 云端账号';
        if (stillActive) {
          // 不要清空 lastAccountUser：侧栏仍可显示「上次登录」用户名。
          const lastUser =
            normalizeLastAccountUser(get().codeBuddyAccountUser) ||
            get().guiSettings?.lastAccountUser ||
            null;
          const saved = lastUser
            ? saveGuiSettings({
                ...(get().guiSettings || {}),
                lastAccountUser: lastUser,
              })
            : get().guiSettings;
          set({
            // 保留连接以便应用内 authenticate；不要用 error 覆盖鉴权引导
            error: null,
            connectionState: client.connected ? 'connected' : 'disconnected',
            codeBuddyAccountAuthState: 'required',
            codeBuddyAccountAuthUrl: null,
            codeBuddyAccountAuthError: authMessage,
            codeBuddyAccountAuthMethods: client.authMethods || [],
            codeBuddyAccountUser: null,
            guiSettings: saved || get().guiSettings,
          });
        }
        get().patchThreadRuntime(thread.id, {
          connectionState: client.connected ? 'connected' : 'disconnected',
        });
        await get().updateThreadRecord(thread.id, {
          // idle + metadata，避免侧栏一堆“断开”且无法点选
          status: 'idle',
          metadata: { ...(thread.metadata || {}), lastError: authMessage, authRequired: true },
        });
        return false;
      }
      if (requestedSessionId) {
        try {
          const loaded = await client.request('session/new', { cwd: project.workspacePath || '.', mcpServers: [] });
          return await applyInitializedSession(null, loaded, error.message);
        } catch (_) {}
      }
      const stillActive = isScopedRequestCurrent(request, get());
      if (stillActive) set({ error: error.message, connectionState: 'error' });
      get().patchThreadRuntime(thread.id, { connectionState: 'error' });
      await get().updateThreadRecord(thread.id, {
        status: 'error',
        metadata: { ...(thread.metadata || {}), lastError: error.message },
      });
      return false;
    }
  },

  async activateThread(threadId) {
    if (isProjectMutationNavigation(get())) return false;
    const thread = get().threadsById[threadId];
    const project = thread ? get().projectsById[thread.projectId] : null;
    if (!thread || !project || thread.archivedAt) return false;
    if (threadId === get().activeThreadId) return true;
    const navigation = beginProjectNavigation(set, `thread:${threadId}`);
    try {
      const projectChanged = thread.projectId !== get().activeProjectId;
      if (projectChanged) {
        const confirmed = await requestDirtyFileConfirmation(set, get, '切换项目');
        if (!isProjectNavigationCurrent(navigation) || !confirmed) return false;
        await get().persistActiveProjectWorkspaceState({ discardDirty: true });
        if (!isProjectNavigationCurrent(navigation)) return false;
        await get().persistActiveProjectTerminalState();
        if (!isProjectNavigationCurrent(navigation)) return false;
      }
      const currentThread = get().threadsById[threadId];
      const currentProject = get().projectsById[project.id];
      if (!currentThread || !currentProject || currentThread.projectId !== project.id) return false;
      set({
        activeProjectId: project.id,
        activeThreadId: thread.id,
        workspacePath: project.workspacePath,
        ...(projectChanged ? resetProjectRuntimeViews() : {}),
        ...(projectChanged ? resetFileWorkspace(project.workspacePath) : {}),
      });
      if (projectChanged) get().loadProjectTerminalState(project.id);
      get().activateThreadRuntime(thread.id);
      const persisted = await get().persistProductState();
      if (!isProjectNavigationCurrent(navigation)) return false;
      if (!persisted) throw new Error(get().error || '保存会话状态失败');
      const runtime = await get().ensureProjectRuntime(project.id);
      if (!isProjectNavigationCurrent(navigation)) return false;
      if (!runtime) throw new Error(get().error || '项目运行时启动失败');
      if (projectChanged) {
        const opened = await get().initializeWorkspace();
        if (!isProjectNavigationCurrent(navigation)) return false;
        if (!opened) throw new Error(get().error || '恢复项目工作区失败');
      }
      const initialized = await get().initializeActiveThread(thread.sessionId);
      if (!isProjectNavigationCurrent(navigation)) return false;
      if (!initialized) {
        // 云端鉴权缺失时 initialize 返回 false，但会话行必须已切换；展示登录恢复区即可
        if (get().codeBuddyAccountAuthState === 'required') return true;
        throw new Error(get().error || get().codeBuddyAccountAuthError || '会话连接失败');
      }
      if (projectChanged) await get().refreshProjectViews();
      else await Promise.allSettled([get().refreshStats(), get().refreshTasks()]);
      return true;
    } catch (error) {
      if (isProjectNavigationCurrent(navigation)) {
        const message = error?.message || '切换会话失败';
        set({ error: message });
        finishProjectNavigation(set, navigation, message);
      }
      return false;
    } finally {
      finishProjectNavigation(set, navigation, get().projectNavigationError);
    }
  },

  async renameThread(threadId, name) {
    return queueThreadMutation(threadId, async () => {
      const thread = get().threadsById[threadId];
      const projectId = thread?.projectId;
      const title = String(name || '').trim();
      if (!thread || !title) return false;
      if (thread.sessionId) {
        if (projectId !== get().activeProjectId) return false;
        try {
          await apiRenameSession(thread.sessionId, title);
        } catch (error) {
          if (projectId === get().activeProjectId) set({ error: error.message || '重命名会话失败' });
          return false;
        }
      }
      if (!get().threadsById[threadId]) return false;
      set((state) => ({
        threadsById: {
          ...state.threadsById,
          [threadId]: { ...state.threadsById[threadId], title, updatedAt: new Date().toISOString() },
        },
        sessionTitle: state.activeThreadId === threadId ? title : state.sessionTitle,
        sessions: state.sessions.map((session) =>
          (session.id || session.sessionId) === thread.sessionId ? { ...session, name: title } : session,
        ),
      }));
      await get().persistProductState();
      return true;
    });
  },

  async setProjectSidebarExpanded(projectId, expanded) {
    const project = get().projectsById[projectId];
    if (!project) return false;
    const previous = project.preferences?.sidebarExpanded !== false;
    const nextExpanded = Boolean(expanded);
    if (previous === nextExpanded) return true;
    set((state) => ({
      projectsById: {
        ...state.projectsById,
        [projectId]: {
          ...state.projectsById[projectId],
          preferences: {
            ...(state.projectsById[projectId].preferences || {}),
            sidebarExpanded: nextExpanded,
          },
          updatedAt: new Date().toISOString(),
        },
      },
    }));
    const persisted = await get().persistProductState();
    if (persisted) return true;
    set((state) => {
      const current = state.projectsById[projectId];
      if (!current || current.preferences?.sidebarExpanded !== nextExpanded) return {};
      return {
        projectsById: {
          ...state.projectsById,
          [projectId]: {
            ...current,
            preferences: { ...(current.preferences || {}), sidebarExpanded: previous },
          },
        },
      };
    });
    return false;
  },

  async setThreadPinned(threadId, pinned) {
    return queueThreadMutation(threadId, async () => {
      const thread = get().threadsById[threadId];
      if (!thread || thread.archivedAt) return false;
      const previous = Boolean(thread.pinned);
      const nextPinned = Boolean(pinned);
      if (previous === nextPinned) return true;
      set((state) => ({
        threadsById: {
          ...state.threadsById,
          [threadId]: {
            ...state.threadsById[threadId],
            pinned: nextPinned,
            updatedAt: new Date().toISOString(),
          },
        },
      }));
      const persisted = await get().persistProductState();
      if (persisted) return true;
      set((state) => {
        const current = state.threadsById[threadId];
        if (!current || Boolean(current.pinned) !== nextPinned) return {};
        return {
          threadsById: {
            ...state.threadsById,
            [threadId]: { ...current, pinned: previous },
          },
        };
      });
      return false;
    });
  },

  async archiveThread(threadId) {
    return queueThreadMutation(threadId, async () => {
      const thread = get().threadsById[threadId];
      if (!thread || thread.archivedAt) return false;
      const archivedAt = new Date().toISOString();
      set((state) => ({
        threadsById: {
          ...state.threadsById,
          [threadId]: { ...state.threadsById[threadId], archivedAt, unread: false, updatedAt: archivedAt },
        },
      }));
      const persisted = await get().persistProductState();
      if (!persisted) {
        set((state) => {
          const current = state.threadsById[threadId];
          if (!current || current.archivedAt !== archivedAt) return {};
          return {
            threadsById: {
              ...state.threadsById,
              [threadId]: { ...current, archivedAt: null, unread: thread.unread },
            },
          };
        });
        return false;
      }
      if (get().activeThreadId === threadId) {
        const replacement = visibleProjectThreads(thread.projectId, get().threadOrderByProject, get().threadsById)[0];
        if (replacement) await get().activateThread(replacement.id);
        else await get().newSession();
      }
      return true;
    });
  },

  async restoreThread(threadId) {
    return queueThreadMutation(threadId, async () => {
      const thread = get().threadsById[threadId];
      if (!thread?.archivedAt) return false;
      const previousArchivedAt = thread.archivedAt;
      set((state) => ({
        threadsById: {
          ...state.threadsById,
          [threadId]: {
            ...state.threadsById[threadId],
            archivedAt: null,
            updatedAt: new Date().toISOString(),
          },
        },
      }));
      const persisted = await get().persistProductState();
      if (persisted) return true;
      set((state) => {
        const current = state.threadsById[threadId];
        if (!current || current.archivedAt !== null) return {};
        return {
          threadsById: {
            ...state.threadsById,
            [threadId]: { ...current, archivedAt: previousArchivedAt },
          },
        };
      });
      return false;
    });
  },

  async deleteThread(threadId) {
    return queueThreadMutation(threadId, async () => {
      const previousState = get();
      const thread = previousState.threadsById[threadId];
      const projectId = thread?.projectId;
      if (!thread) return false;
      const project = previousState.projectsById[projectId];
      if (!project) return false;
      const wasActive = previousState.activeThreadId === threadId;
      const order = (previousState.threadOrderByProject[projectId] || []).filter((id) => id !== threadId);
      const replacementId = order.find((id) => !previousState.threadsById[id]?.archivedAt) || null;
      const previousRuntime = previousState.threadRuntimeById[threadId] || null;
      const previousActiveRuntime = {};
      if (wasActive) {
        for (const key of ACTIVE_THREAD_RUNTIME_KEYS) previousActiveRuntime[key] = previousState[key];
      }

      // Drop any pending coalesced stream chunks before we tear down the thread.
      // Without this, a hidden-window coalesce timer (200ms) could fire after the
      // thread/runtime is deleted, and patchThreadRuntime would resurrect a zombie
      // threadRuntimeById entry that nobody references (memory leak + stale writes).
      get().flushThreadTimelineCoalesce(threadId);
      await conversations.dispose(threadId);
      set((state) => {
        const threadsById = { ...state.threadsById };
        const threadRuntimeById = { ...state.threadRuntimeById };
        const projectsById = { ...state.projectsById };
        delete threadsById[threadId];
        delete threadRuntimeById[threadId];
        if (thread.sessionId) {
          projectsById[projectId] = projectWithDeletedSession(state.projectsById[projectId], thread.sessionId);
        }
        return {
          projectsById,
          threadsById,
          threadRuntimeById,
          threadOrderByProject: { ...state.threadOrderByProject, [thread.projectId]: order },
          sessions: state.sessions.filter((session) => (session.id || session.sessionId) !== thread.sessionId),
          activeThreadId: wasActive ? null : state.activeThreadId,
          ...(wasActive
            ? {
                ...emptyThreadRuntime(),
                sessionId: null,
                sessionTitle: null,
                sessionToken: null,
              }
            : {}),
        };
      });
      if (wasActive) setAcpSessionToken(null);

      const persisted = await get().persistProductState();
      if (!persisted) {
        set((state) => {
          const threadRuntimeById = { ...state.threadRuntimeById };
          if (previousRuntime) threadRuntimeById[threadId] = previousRuntime;
          else delete threadRuntimeById[threadId];
          return {
            projectsById: { ...state.projectsById, [projectId]: project },
            threadsById: { ...state.threadsById, [threadId]: thread },
            threadRuntimeById,
            threadOrderByProject: {
              ...state.threadOrderByProject,
              [projectId]: previousState.threadOrderByProject[projectId] || [],
            },
            sessions: previousState.sessions,
            activeThreadId: previousState.activeThreadId,
            ...(wasActive
              ? {
                  ...previousActiveRuntime,
                  sessionId: previousState.sessionId,
                  sessionTitle: previousState.sessionTitle,
                  sessionToken: previousState.sessionToken,
                }
              : {}),
          };
        });
        if (wasActive) setAcpSessionToken(previousState.sessionToken || null);
        return false;
      }

      if (thread.sessionId && projectId === get().activeProjectId) {
        apiDeleteSession(thread.sessionId).catch((error) => {
          console.warn('Failed to delete CodeBuddy session after local removal:', error);
        });
      }

      if (wasActive) {
        queueMicrotask(async () => {
          if (get().activeThreadId || get().activeProjectId !== projectId) return;
          if (replacementId && get().threadsById[replacementId]) {
            await get().activateThread(replacementId);
          } else {
            await get().newSession();
          }
        });
      }
      return true;
    });
  },

  async setModel(modelId) {
    const state = get();
    const threadId = state.activeThreadId;
    const sessionId = state.sessionId;
    if (!threadId || !sessionId || !modelId) return false;
    if (threadResponseInProgress(state, threadId)) {
      set({ error: '当前回复进行中，请等待完成或停止后再切换模型' });
      return false;
    }
    return queueSessionSettingOperation(`${threadId}:model`, async () => {
      const target = get().threadsById[threadId];
      if (!target || target.sessionId !== sessionId) return false;
      if (threadResponseInProgress(get(), threadId)) {
        if (get().activeThreadId === threadId) set({ error: '当前回复进行中，请等待完成或停止后再切换模型' });
        return false;
      }
      const runtime = get().threadRuntimeById[threadId] || {};
      const previousModel = runtime.currentModel ?? get().currentModel;
      if (previousModel === modelId) return true;
      // 先乐观更新 pill，避免等 RPC / 磁盘持久化时卡住
      get().patchThreadRuntime(threadId, { currentModel: modelId });
      if (get().activeThreadId === threadId && get().sessionId === sessionId) set({ currentModel: modelId });
      try {
        const client = get().getThreadClient(threadId);
        if (!client) throw new Error('当前会话未连接');
        await client.request('session/set_model', { sessionId, modelId });
        const thread = get().threadsById[threadId];
        if (!thread || thread.sessionId !== sessionId) return false;
        void get().updateThreadRecord(threadId, { modelId });
        return true;
      } catch (error) {
        const thread = get().threadsById[threadId];
        if (thread && thread.sessionId === sessionId) {
          get().patchThreadRuntime(threadId, { currentModel: previousModel });
          if (get().activeThreadId === threadId && get().sessionId === sessionId) {
            set({ currentModel: previousModel, error: error.message });
          }
        } else if (get().activeThreadId === threadId && get().sessionId === sessionId) {
          set({ error: error.message });
        }
        return false;
      }
    });
  },

  async setMode(modeId) {
    const state = get();
    const threadId = state.activeThreadId;
    const sessionId = state.sessionId;
    if (!threadId || !sessionId || !modeId) return false;
    if (threadResponseInProgress(state, threadId)) {
      set({ error: '当前回复进行中，请等待完成或停止后再切换模式' });
      return false;
    }
    return queueSessionSettingOperation(`${threadId}:mode`, async () => {
      const target = get().threadsById[threadId];
      if (!target || target.sessionId !== sessionId) return false;
      if (threadResponseInProgress(get(), threadId)) {
        if (get().activeThreadId === threadId) set({ error: '当前回复进行中，请等待完成或停止后再切换模式' });
        return false;
      }
      const runtime = get().threadRuntimeById[threadId] || {};
      const previousMode = runtime.currentMode ?? get().currentMode;
      if (previousMode === modeId) return true;
      get().patchThreadRuntime(threadId, { currentMode: modeId });
      if (get().activeThreadId === threadId && get().sessionId === sessionId) set({ currentMode: modeId });
      try {
        const client = get().getThreadClient(threadId);
        if (!client) throw new Error('当前会话未连接');
        await client.request('session/set_mode', { sessionId, modeId });
        const thread = get().threadsById[threadId];
        if (!thread || thread.sessionId !== sessionId) return false;
        void get().updateThreadRecord(threadId, { modeId });
        return true;
      } catch (error) {
        const thread = get().threadsById[threadId];
        if (thread && thread.sessionId === sessionId) {
          get().patchThreadRuntime(threadId, { currentMode: previousMode });
          if (get().activeThreadId === threadId && get().sessionId === sessionId) {
            set({ currentMode: previousMode, error: error.message });
          }
        } else if (get().activeThreadId === threadId && get().sessionId === sessionId) {
          set({ error: error.message });
        }
        return false;
      }
    });
  },

  async setThoughtLevel(value) {
    const state = get();
    const threadId = state.activeThreadId;
    const sessionId = state.sessionId;
    if (!threadId || !sessionId || !value) return false;
    if (threadResponseInProgress(state, threadId)) {
      set({ error: '当前回复进行中，请等待完成或停止后再切换思考强度' });
      return false;
    }
    return queueSessionSettingOperation(`${threadId}:thought_level`, async () => {
      const target = get().threadsById[threadId];
      if (!target || target.sessionId !== sessionId) return false;
      if (threadResponseInProgress(get(), threadId)) {
        if (get().activeThreadId === threadId) set({ error: '当前回复进行中，请等待完成或停止后再切换思考强度' });
        return false;
      }
      const runtime = get().threadRuntimeById[threadId] || {};
      const previousLevel = runtime.thoughtLevel ?? get().thoughtLevel;
      if (previousLevel === value) return true;
      // thought_level 是会话级运行时状态，不持久化到会话记录（新会话回归默认）
      get().patchThreadRuntime(threadId, { thoughtLevel: value });
      if (get().activeThreadId === threadId && get().sessionId === sessionId) set({ thoughtLevel: value });
      try {
        const client = get().getThreadClient(threadId);
        if (!client) throw new Error('当前会话未连接');
        await client.request('session/set_config_option', {
          sessionId,
          configId: 'thought_level',
          value,
        });
        const thread = get().threadsById[threadId];
        if (!thread || thread.sessionId !== sessionId) return false;
        return true;
      } catch (error) {
        const thread = get().threadsById[threadId];
        if (thread && thread.sessionId === sessionId) {
          get().patchThreadRuntime(threadId, { thoughtLevel: previousLevel });
          if (get().activeThreadId === threadId && get().sessionId === sessionId) {
            set({ thoughtLevel: previousLevel, error: error.message });
          }
        } else if (get().activeThreadId === threadId && get().sessionId === sessionId) {
          set({ error: error.message });
        }
        return false;
      }
    });
  },

  async newSession() {
    const reportNewSessionError = (message) => {
      const text = String(message || '创建新会话失败').trim() || '创建新会话失败';
      set({ newSessionError: text });
      if (typeof get().pushToast === 'function') {
        get().pushToast({ type: 'error', message: text });
      }
    };

    if (get().projectNavigationBusy) {
      reportNewSessionError('请等待项目或会话切换完成');
      return false;
    }
    if (get().newSessionBusy) return false;
    const projectId = get().activeProjectId;
    const previousThreadId = get().activeThreadId;
    let thread = null;
    set({ newSessionBusy: true, newSessionProjectId: projectId, newSessionError: null, error: null });
    try {
      if (!projectId) {
        await get().chooseWorkspace();
        const created = Boolean(get().activeThreadId);
        if (!created) reportNewSessionError(get().error || '未能创建新会话');
        return created;
      }

      thread = createThreadRecord(projectId);
      set((state) => ({
        threadsById: { ...state.threadsById, [thread.id]: thread },
        threadOrderByProject: {
          ...state.threadOrderByProject,
          // 新会话插入到最前面，便于用户立刻看到并继续工作
          [projectId]: [thread.id, ...(state.threadOrderByProject[projectId] || [])],
        },
        activeThreadId: thread.id,
      }));

      const persisted = await get().persistProductState();
      if (!persisted) {
        let failureMessage = '保存新会话失败';
        set((state) => {
          const threadsById = { ...state.threadsById };
          delete threadsById[thread.id];
          failureMessage = state.error || failureMessage;
          return {
            threadsById,
            threadOrderByProject: {
              ...state.threadOrderByProject,
              [projectId]: (state.threadOrderByProject[projectId] || []).filter((id) => id !== thread.id),
            },
            activeThreadId: state.activeThreadId === thread.id ? previousThreadId : state.activeThreadId,
            newSessionError: failureMessage,
          };
        });
        if (typeof get().pushToast === 'function') {
          get().pushToast({ type: 'error', message: failureMessage });
        }
        return false;
      }

      if (get().activeProjectId !== projectId || get().activeThreadId !== thread.id) return true;
      const initialized = await get().initializeActiveThread(null);
      if (!initialized && get().activeProjectId === projectId && get().activeThreadId === thread.id) {
        reportNewSessionError(get().error || '新会话连接失败，请重试');
      }
      return initialized;
    } catch (error) {
      if (get().activeProjectId === projectId) reportNewSessionError(error?.message || '创建新会话失败');
      return false;
    } finally {
      set({ newSessionBusy: false });
    }
  },

  applyInterruptionResolution(threadId, interruptionId, decision, resolvedAt = Date.now()) {
    if (!threadId || !interruptionId) return false;
    const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
    let timelineChanged = false;
    const timeline = runtime.timeline.map((item) => {
      if (item.type !== 'interruption' || !sessionActionItemMatches(item, interruptionId)) return item;
      if (item.status === 'resolved' && item.meta?.resolution === decision) return item;
      timelineChanged = true;
      return {
        ...item,
        status: 'resolved',
        meta: { ...(item.meta || {}), resolution: decision, resolvedAt },
      };
    });
    const permissionRequests = runtime.permissionRequests.filter(
      (item) => !sessionActionItemMatches(item, interruptionId),
    );
    if (!timelineChanged && permissionRequests.length === runtime.permissionRequests.length) return false;
    get().patchThreadRuntime(threadId, { permissionRequests, timeline });
    set((state) => {
      const record = state.threadsById[threadId];
      if (!record) return {};
      const stillWaiting = permissionRequests.length > 0 || runtime.questions.length > 0;
      return {
        threadsById: {
          ...state.threadsById,
          [threadId]: {
            ...record,
            timeline: timeline.slice(-300),
            status: record.status === 'waiting' && !stillWaiting ? 'running' : record.status,
            updatedAt: new Date().toISOString(),
          },
        },
      };
    });
    return true;
  },

  async respondToInterruption(interruptionId, decision = 'allow', toolCallId = null) {
    const state = get();
    const projectId = state.activeProjectId;
    const threadId = state.activeThreadId;
    const sessionId = state.sessionId;
    if (!projectId || !threadId || !sessionId || !interruptionId) return false;
    set({ error: null });
    return runUniqueSessionAction(threadId + ':interruption:' + interruptionId, async () => {
      const thread = get().threadsById[threadId];
      if (
        !thread ||
        thread.projectId !== projectId ||
        thread.sessionId !== sessionId ||
        !['running', 'waiting'].includes(thread.status)
      )
        return false;
      const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      const target = runtime.timeline.find(
        (item) => item.type === 'interruption' && sessionActionItemMatches(item, interruptionId),
      );
      const resolvedToolCallId =
        toolCallId || target?.toolCallId || target?.meta?.toolCallId || target?.raw?.toolCallId || null;
      const client = get().getThreadClient(threadId);
      if (!client) {
        set({ error: '当前会话未连接' });
        return false;
      }
      const errors = [];
      let handled = false;
      try {
        handled = await client.respondToPermissionRequest(interruptionId, resolvedToolCallId, decision);
      } catch (error) {
        errors.push(error);
      }
      const extensionToolCallId = resolvedToolCallId || interruptionId;
      if (extensionToolCallId) {
        try {
          await client.request('_codebuddy.ai/resolveInterruption', {
            sessionId,
            toolCallId: extensionToolCallId,
            decision,
          });
          handled = true;
        } catch (error) {
          errors.push(error);
        }
      }
      if (!handled) {
        const error = errors[0] || new Error('权限请求已失效或无法响应');
        if (get().activeThreadId === threadId && get().sessionId === sessionId) set({ error: error.message });
        return false;
      }
      const currentThread = get().threadsById[threadId];
      if (!currentThread || currentThread.sessionId !== sessionId) return true;
      get().applyInterruptionResolution(threadId, interruptionId, decision);
      await get().persistProductState();
      return true;
    });
  },

  applyQuestionResolution(threadId, toolCallId, status, answers = null) {
    const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
    let timelineChanged = false;
    const timeline = runtime.timeline.map((item) => {
      if (item.type !== 'question' || !sessionActionItemMatches(item, toolCallId)) return item;
      timelineChanged = true;
      return {
        ...item,
        status,
        meta: {
          ...(item.meta || {}),
          ...(answers ? { submittedAnswers: answers } : {}),
          [status === 'answered' ? 'answeredAt' : 'cancelledAt']: Date.now(),
        },
      };
    });
    const questions = runtime.questions.filter((item) => !sessionActionItemMatches(item, toolCallId));
    if (!timelineChanged && questions.length === runtime.questions.length) return false;
    get().patchThreadRuntime(threadId, { questions, timeline });
    set((state) => {
      const record = state.threadsById[threadId];
      if (!record) return {};
      const stillWaiting = questions.length > 0 || runtime.permissionRequests.length > 0;
      return {
        threadsById: {
          ...state.threadsById,
          [threadId]: {
            ...record,
            timeline: timeline.slice(-300),
            status: record.status === 'waiting' && !stillWaiting ? 'running' : record.status,
            updatedAt: new Date().toISOString(),
          },
        },
      };
    });
    return true;
  },

  async submitQuestionAnswers(toolCallId, answers) {
    const state = get();
    const projectId = state.activeProjectId;
    const threadId = state.activeThreadId;
    const sessionId = state.sessionId;
    if (!projectId || !threadId || !sessionId || !toolCallId) return false;
    set({ error: null });
    return runUniqueSessionAction(threadId + ':question:' + toolCallId, async () => {
      const thread = get().threadsById[threadId];
      if (
        !thread ||
        thread.projectId !== projectId ||
        thread.sessionId !== sessionId ||
        !['running', 'waiting'].includes(thread.status)
      )
        return false;
      try {
        const client = get().getThreadClient(threadId);
        if (!client) throw new Error('当前会话未连接');
        const responded = await client.submitQuestionAnswers(toolCallId, answers);
        if (!responded) {
          await client.request('_codebuddy.ai/answerQuestion', { sessionId, toolCallId, answers });
        }
        const currentThread = get().threadsById[threadId];
        if (!currentThread || currentThread.sessionId !== sessionId) return true;
        get().applyQuestionResolution(threadId, toolCallId, 'answered', answers);
        await get().persistProductState();
        return true;
      } catch (error) {
        if (get().activeThreadId === threadId && get().sessionId === sessionId) set({ error: error.message });
        return false;
      }
    });
  },

  async cancelQuestionAnswers(toolCallId) {
    const state = get();
    const projectId = state.activeProjectId;
    const threadId = state.activeThreadId;
    const sessionId = state.sessionId;
    if (!projectId || !threadId || !sessionId || !toolCallId) return false;
    set({ error: null });
    return runUniqueSessionAction(threadId + ':question:' + toolCallId, async () => {
      const thread = get().threadsById[threadId];
      if (
        !thread ||
        thread.projectId !== projectId ||
        thread.sessionId !== sessionId ||
        !['running', 'waiting'].includes(thread.status)
      )
        return false;
      try {
        const client = get().getThreadClient(threadId);
        if (!client) throw new Error('当前会话未连接');
        // Prefer JSON-RPC result `{ outcome: 'cancelled' }` when `_codebuddy.ai/question` is pending.
        // CLI 2.125 often delivers AskUserQuestion as interruption only — WebUI cancel uses
        // resolveInterruption(toolCallId, 'deny') which server-side maps to skip_question + approve
        // (session continues; never session/cancel).
        let cancelled = false;
        try {
          cancelled = await client.cancelQuestionAnswers(toolCallId);
        } catch (_) {
          cancelled = false;
        }
        if (!cancelled) {
          await client.request('_codebuddy.ai/resolveInterruption', {
            sessionId,
            toolCallId,
            decision: 'deny',
          });
          cancelled = true;
        }
        const currentThread = get().threadsById[threadId];
        if (!currentThread || currentThread.sessionId !== sessionId) return true;
        get().applyQuestionResolution(threadId, toolCallId, 'cancelled');
        await get().persistProductState();
        return true;
      } catch (error) {
        if (get().activeThreadId === threadId && get().sessionId === sessionId) set({ error: error.message });
        return false;
      }
    });
  },

  async cancelSession() {
    const state = get();
    const projectId = state.activeProjectId;
    const threadId = state.activeThreadId;
    const thread = state.threadsById[threadId];
    const runtime = state.threadRuntimeById[threadId] || emptyThreadRuntime();
    const sessionId = thread?.sessionId || runtime.sessionId || state.sessionId;
    if (!projectId || !threadId || !sessionId || !thread) return false;
    set({ error: null });
    return runUniqueSessionAction(`${threadId}:cancel:${sessionId}`, async () => {
      const currentThread = get().threadsById[threadId];
      const currentRuntime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      if (!currentThread || currentThread.projectId !== projectId) return false;
      const currentSessionId = currentThread.sessionId || currentRuntime.sessionId || get().sessionId;
      if (currentSessionId !== sessionId) return false;
      const client = get().getThreadClient(threadId);
      if (!client) {
        set({ error: '当前会话未连接' });
        return false;
      }

      const hadPlannedRun = Boolean(currentRuntime.activePromptRunId);
      const hadActiveRequest = Boolean(client.hasActivePrompt?.(sessionId));
      const waitingForInput = currentThread.status === 'waiting';
      const responseBusy = RESPONSE_BUSY_STATUSES.has(currentThread.status);
      if (!hadPlannedRun && !hadActiveRequest && !waitingForInput && !responseBusy) return false;
      // H2: while `isAwaitingResponse` is true the POST stream may have already
      // landed on the backend even though `promptDispatched` has not been set yet.
      // Treat that window as backend-may-be-running so we always emit session/cancel
      // instead of leaving the turn silently executing (its later chunks would then
      // be dropped by the H1 guard above).
      const preflightOnly =
        hadPlannedRun &&
        !currentRuntime.promptDispatched &&
        !hadActiveRequest &&
        !currentRuntime.isAwaitingResponse &&
        currentThread.status === 'running';
      const backendMayBeRunning =
        !preflightOnly && (currentRuntime.promptDispatched || hadActiveRequest || responseBusy || currentRuntime.isAwaitingResponse);

      get().patchThreadRuntime(
        threadId,
        responseTerminalRuntimePatch({
          lastPromptRunId: currentRuntime.activePromptRunId || null,
          lastPromptRunAt: currentRuntime.activePromptRunId ? Date.now() : 0,
        }),
      );
      await get().updateThreadRecord(threadId, { status: 'cancelling' });

      client.cancelActivePrompt?.(sessionId);
      let backendCancelWarning = null;
      if (backendMayBeRunning && client.notify && client.sessionCancelSupported !== false) {
        try {
          await client.notify('session/cancel', { sessionId });
          client.sessionCancelSupported = true;
        } catch (error) {
          if (isMethodNotFoundError(error)) {
            client.sessionCancelSupported = false;
          } else {
            backendCancelWarning = `后端取消确认失败，已关闭本地请求流: ${error?.message || '未知错误'}`;
          }
        }
      }

      client.invalidateInteractiveRequests?.('session-cancelled');
      get().flushThreadTimelineCoalesce?.(threadId);
      const latestRuntime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      const cancelledTimeline = cancelPendingTimelineActions(closeAssistantStream(latestRuntime.timeline));
      const timeline = reduceAcpEvent(cancelledTimeline, 'status_change', {
        status: 'cancelled',
        role: 'system',
      }, threadId);
      get().patchThreadRuntime(
        threadId,
        responseTerminalRuntimePatch({
          permissionRequests: [],
          questions: [],
          timeline,
        }),
      );
      await get().updateThreadRecord(threadId, {
        status: 'cancelled',
        timeline: timeline.slice(-300),
        metadata: {
          ...(get().threadsById[threadId]?.metadata || {}),
          lastError: null,
          cancelWarning: backendCancelWarning,
        },
      });
      if (get().activeThreadId === threadId) set({ error: null });
      return true;
    });
  },
  setThreadPromptQueue(threadId, promptQueue, patch = {}) {
    const serializedQueue = serializePromptQueue(promptQueue);
    set((state) => {
      const thread = state.threadsById[threadId];
      if (!thread) return {};
      return {
        threadsById: {
          ...state.threadsById,
          [threadId]: {
            ...thread,
            ...patch,
            metadata: { ...(thread.metadata || {}), promptQueue: serializedQueue },
            updatedAt: new Date().toISOString(),
          },
        },
      };
    });
  },

  async persistThreadPromptQueue(threadId, promptQueue, patch = {}) {
    if (!get().threadsById[threadId]) return false;
    get().setThreadPromptQueue(threadId, promptQueue, patch);
    return get().persistProductState();
  },

  async sendPrompt(text) {
    const threadId = get().activeThreadId;
    const thread = get().threadsById[threadId];
    const client = get().getThreadClient(threadId);
    if (!thread || !client) {
      set({ error: '当前会话未连接' });
      return false;
    }
    let runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
    const attachments = runtime.pendingAttachments || [];
    const draftText = String(text || '');
    const content = String(text || '').trim() || (attachments.length ? '请查看附件。' : '');
    if (!content) return false;
    // 自愈：status=running/cancelling 但无 live prompt → 假 busy（常见于崩溃/重启残留），清掉再发。
    // waiting 是权限/问答等用户输入态，不能清。
    const sessionId = thread.sessionId || runtime.sessionId || get().sessionId;
    const liveBusy =
      Boolean(runtime.isAwaitingResponse) ||
      Boolean(runtime.activePromptRunId) ||
      Boolean(sessionId && client.hasActivePrompt?.(sessionId));
    if (
      (thread.status === 'running' || thread.status === 'cancelling') &&
      !liveBusy &&
      runtime.promptQueue.length === 0 &&
      !runtime.promptDispatchInFlight
    ) {
      get().patchThreadRuntime(
        threadId,
        (() => {
          get().flushThreadTimelineCoalesce?.(threadId);
          const flushed = get().threadRuntimeById[threadId] || runtime;
          return responseTerminalRuntimePatch({ timeline: closeAssistantStream(flushed.timeline) });
        })(),
      );
      await get().updateThreadRecord(threadId, { status: 'idle' });
      runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
    }
    const latestThread = get().threadsById[threadId] || thread;
    if (
      RESPONSE_BUSY_STATUSES.has(latestThread.status) ||
      runtime.isAwaitingResponse ||
      runtime.activePromptRunId ||
      runtime.promptDispatchInFlight ||
      runtime.promptQueue.length > 0
    ) {
      return queuePromptQueueOperation(threadId, async () => {
        const latestThread = get().threadsById[threadId];
        const latestRuntime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
        if (!latestThread) return false;
        const queuedPrompt = {
          id: `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          text: content,
          attachments,
          draftText,
          createdAt: Date.now(),
        };
        const promptQueue = [...latestRuntime.promptQueue, queuedPrompt];
        get().patchThreadRuntime(threadId, { promptQueue, pendingAttachments: [], promptSuggestion: null });
        const persisted = await get().persistThreadPromptQueue(threadId, promptQueue, { draft: '' });
        if (!persisted) {
          get().patchThreadRuntime(threadId, {
            promptQueue: latestRuntime.promptQueue,
            pendingAttachments: attachments,
            promptSuggestion: latestRuntime.promptSuggestion,
          });
          get().setThreadPromptQueue(threadId, latestRuntime.promptQueue, { draft: draftText });
          return false;
        }
        if (
          !RESPONSE_BUSY_STATUSES.has(latestThread.status) &&
          !latestRuntime.isAwaitingResponse &&
          !latestRuntime.promptDispatchInFlight
        ) {
          setTimeout(() => get().drainThreadPromptQueue(threadId), 0);
        }
        return { queued: true, id: queuedPrompt.id };
      });
    }
    get().patchThreadRuntime(threadId, { pendingAttachments: [], promptSuggestion: null });
    return get().runThreadPrompt(threadId, content, attachments, draftText);
  },

  async runThreadPrompt(threadId, content, attachments = [], draftText = content) {
    const thread = get().threadsById[threadId];
    const client = get().getThreadClient(threadId);
    if (!thread || !client) {
      const currentRuntime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      const restoredAttachments = [...attachments, ...(currentRuntime.pendingAttachments || [])].filter(
        (item, index, items) =>
          items.findIndex(
            (candidate) => candidate.path === item.path && candidate.name === item.name && candidate.kind === item.kind,
          ) === index,
      );
      get().patchThreadRuntime(threadId, { pendingAttachments: restoredAttachments });
      set({ error: '当前会话未连接' });
      return false;
    }
    const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
    const requestSessionId =
      thread.sessionId || runtime.sessionId || (get().activeThreadId === threadId ? get().sessionId : null);
    if (!requestSessionId) {
      set({ error: '当前会话尚未完成连接' });
      return false;
    }
    const project = get().projectsById[thread.projectId];
    const promptStartedAt = Date.now();
    // L1: prompt run id is identity-bearing for cancel/correlation; use a crypto
    // suffix (UUID or getRandomValues) instead of Math.random. The Date.now()
    // prefix is kept for human-readable ordering.
    const runSuffix = (() => {
      const u = globalThis.crypto?.randomUUID?.();
      if (u) return u.slice(0, 8);
      const c = globalThis.crypto;
      if (c?.getRandomValues) {
        const buf = new Uint8Array(4);
        c.getRandomValues(buf);
        return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
      }
      return Math.random().toString(36).slice(2, 8);
    })();
    const activePromptRunId = `run-${promptStartedAt}-${runSuffix}`;
    // WebUI shows images/files inside the user bubble; keep timeline text as the prompt body only.
    const timelineAttachments = (attachments || []).map((attachment) => ({
      name: attachment.name || attachment.path,
      path: attachment.path || null,
      kind: attachment.kind === 'image' ? 'image' : 'text',
      mimeType: attachment.mimeType || null,
      data: attachment.data || null,
    }));
    const timeline = pushUserMessage(runtime.timeline, content, promptStartedAt, timelineAttachments);
    const promptEntryId = timeline[timeline.length - 1]?.id || null;
    get().patchThreadRuntime(threadId, {
      timeline,
      isAwaitingResponse: true,
      promptStartedAt,
      activePromptRunId,
      promptDispatched: false,
      promptDispatchInFlight: false,
      teamState: null,
      lastTeamState: null,
      memberHistoriesByName: {},
      subagentToolCalls: {},
      workflowState: null,
      lastWorkflowState: null,
      rawExtensionEvents: [],
    });
    await get().updateThreadRecord(threadId, {
      status: 'running',
      draft: '',
      unread: false,
      timeline: timeline.slice(-300),
      metadata: { ...(thread.metadata || {}), lastError: null },
    });

    const runIsCurrent = () => {
      const latestThread = get().threadsById[threadId];
      const latestRuntime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      const latestSessionId = latestThread?.sessionId || latestRuntime.sessionId;
      // H3: a cancel that lands between the runIsCurrent() check and the final
      // terminal patch would otherwise let the success path overwrite status
      // `cancelled` with `idle` and notify success for a cancelled turn.
      return (
        latestRuntime.activePromptRunId === activePromptRunId &&
        latestSessionId === requestSessionId &&
        latestThread?.status !== 'cancelled' &&
        latestThread?.status !== 'cancelling'
      );
    };

    const hasFinalResponse = () =>
      hasCompletePromptResponse(get().threadRuntimeById[threadId]?.timeline, promptEntryId, promptStartedAt);
    const hasUsableBody = () =>
      hasUsableAssistantBody(get().threadRuntimeById[threadId]?.timeline, promptEntryId, promptStartedAt);
    const recoverPromptHistory = async () => {
      if (!runIsCurrent()) return false;
      get().patchThreadRuntime(threadId, { historyReplayActive: true });
      resetSeenContent(threadId);
      try {
        await client.request(
          'session/load',
          {
            sessionId: requestSessionId,
            cwd: project?.workspacePath || '.',
            mcpServers: [],
          },
          { promptRunId: activePromptRunId, historyReplay: true },
        );
      } finally {
        const latestRuntime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
        if (latestRuntime.activePromptRunId === activePromptRunId) {
          get().patchThreadRuntime(threadId, { historyReplayActive: false });
        }
      }
      // History may only restore the pre-tool narrative; treat that as recovered too.
      return hasFinalResponse() || hasUsableBody();
    };
    try {
      if (!runIsCurrent() || ['cancelled', 'cancelling'].includes(get().threadsById[threadId]?.status)) return false;
      const prompt = [{ type: 'text', text: content }];
      for (const attachment of attachments) {
        if (attachment.kind === 'image') {
          prompt.push({ type: 'image', data: attachment.data, mimeType: attachment.mimeType });
        } else if (attachment.kind === 'text') {
          const text = String(attachment.text || '');
          const clipped = text.length > 500000 ? `${text.slice(0, 500000)}\n\n[文件内容已截断]` : text;
          prompt.push({ type: 'text', text: `文件: ${attachment.name}\n路径: ${attachment.path}\n\n${clipped}` });
        }
      }
      get().patchThreadRuntime(threadId, { promptDispatched: true });
      let result;
      try {
        result = await client.request(
          'session/prompt',
          {
            sessionId: requestSessionId,
            prompt,
          },
          { promptRunId: activePromptRunId },
        );
      } catch (requestError) {
        if (!runIsCurrent()) return false;
        const transportAccepted = requestError.promptAccepted === true;
        const activityBeforeRecovery = hasPromptRunActivity(
          get().threadRuntimeById[threadId]?.timeline,
          promptEntryId,
          promptStartedAt,
        );
        let recovered = false;
        try {
          recovered = await recoverPromptHistory();
        } catch (recoveryError) {
          if (hasFinalResponse()) {
            recovered = true;
          } else {
            const promptAccepted =
              transportAccepted ||
              activityBeforeRecovery ||
              hasPromptRunActivity(get().threadRuntimeById[threadId]?.timeline, promptEntryId, promptStartedAt);
            if (promptAccepted) {
              recoveryError.promptAccepted = true;
              throw recoveryError;
            }
            requestError.promptAccepted = false;
            requestError.recoveryError = recoveryError?.message || null;
            throw requestError;
          }
        }
        if (!recovered) {
          requestError.promptAccepted =
            transportAccepted ||
            activityBeforeRecovery ||
            hasPromptRunActivity(get().threadRuntimeById[threadId]?.timeline, promptEntryId, promptStartedAt);
          throw requestError;
        }
        result = { stopReason: 'recovered' };
      }
      if (!runIsCurrent()) return false;

      if (result?.stopReason === 'cancelled') {
        get().flushThreadTimelineCoalesce?.(threadId);
        const cancelledRuntime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
        const cancelledTimeline = closeAssistantStream(cancelledRuntime.timeline);
        get().patchThreadRuntime(
          threadId,
          responseTerminalRuntimePatch({ timeline: cancelledTimeline }),
        );
        await get().updateThreadRecord(threadId, {
          status: 'cancelled',
          timeline: cancelledTimeline.slice(-300),
        });
        return false;
      }
      if (result?.stopReason === 'refusal') {
        const message = promptResultErrorMessage(result);
        // 必须显式鉴权类别/文案才算登录失效。网络 502/代理失败也是 refusal，绝不能踢登录。
        // CLI 常把 category 塞进 errorMessage JSON（无顶层 category），统一走 classify。
        const classifiedKind = classifyPromptRefusal(result).kind;
        // custom_model_auth = wrong/missing custom endpoint key; never kick cloud login.
        const refusalKind =
          classifiedKind === 'auth' ||
          classifiedKind === 'network' ||
          classifiedKind === 'custom_model_auth'
            ? classifiedKind
            : result?.category === 'custom_model_auth'
              ? 'custom_model_auth'
              : result?.category === 'auth'
                ? 'auth'
                : result?.category === 'network' || result?.category === 'proxy'
                  ? 'network'
                  : /自定义模型鉴权|custom_model_auth|Authentication failed.*for model|differs from the current product endpoint/i.test(
                        message,
                      )
                    ? 'custom_model_auth'
                    : /鉴权失败|authentication required|请.*登录|sign in to your account|auth-type:cli-external-link/i.test(
                          message,
                        )
                      ? 'auth'
                      : /502|503|504|ECONNREFUSED|代理|proxy|Bad Gateway|连接被拒绝|网络|模型请求失败/i.test(message)
                        ? 'network'
                        : 'refusal';
        const authFailed = refusalKind === 'auth';
        if (authFailed) {
          // 本地 ACP 已 connected，但云端 token 失效：只切到登录恢复。
          // 保留 lastAccountUser，侧栏显示「上次登录 · 用户名」而不是空白未登录。
          const lastUser =
            normalizeLastAccountUser(get().codeBuddyAccountUser) ||
            get().guiSettings?.lastAccountUser ||
            null;
          const saved = lastUser
            ? saveGuiSettings({
                ...(get().guiSettings || {}),
                lastAccountUser: lastUser,
              })
            : get().guiSettings;
          set({
            codeBuddyAccountAuthState: 'required',
            codeBuddyAccountAuthError: message,
            codeBuddyAccountUser: null,
            guiSettings: saved || get().guiSettings,
            error: null,
          });
          await get().updateThreadRecord(threadId, {
            status: 'idle',
            metadata: {
              ...(get().threadsById[threadId]?.metadata || {}),
              lastError: message,
              authRequired: true,
            },
          });
        } else {
          // 网络/模型拒绝：保留账号态，只记线程错误，允许直接重试发送。
          await get().updateThreadRecord(threadId, {
            status: 'error',
            metadata: {
              ...(get().threadsById[threadId]?.metadata || {}),
              lastError: message,
              authRequired: false,
            },
          });
        }
        const refusalError = new Error(message);
        // 鉴权拒绝时恢复草稿，避免用户以为消息已发出却无回复
        refusalError.promptAccepted = !authFailed;
        refusalError.category = authFailed ? 'auth' : refusalKind;
        throw refusalError;
      }

      // max_tokens: the model hit the token cap and the response was truncated.
      // The body is still usable, so this is NOT a hard error — append a notice
      // card to the timeline and complete the turn as idle (matches WebUI
      // chat.error.maxTokens behavior, which warns instead of failing).
      if (result?.stopReason === 'max_tokens' || result?.stopReason === 'maxTokens') {
        if (runIsCurrent()) {
          get().flushThreadTimelineCoalesce?.(threadId);
          const truncatedRuntime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
          const truncatedTimeline = closeAssistantStream([
            ...truncatedRuntime.timeline,
            {
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              type: 'notice',
              role: 'system',
              kind: 'max_tokens',
              content: '',
              streaming: false,
              createdAt: Date.now(),
              completedAt: Date.now(),
              raw: null,
              meta: {
                title: 'chat.maxTokens.title',
                message: 'chat.maxTokens.message',
              },
              messageId: null,
              toolCallId: null,
              status: null,
              title: null,
              rawInput: null,
              rawOutput: null,
              locations: null,
              attachments: null,
            },
          ]);
          get().patchThreadRuntime(
            threadId,
            responseTerminalRuntimePatch({ timeline: truncatedTimeline }),
          );
          await get().updateThreadRecord(threadId, {
            status: 'idle',
            unread: get().activeThreadId !== threadId,
            timeline: truncatedTimeline.slice(-300),
            metadata: { ...(get().threadsById[threadId]?.metadata || {}), lastError: null },
          });
        }
        return false;
      }

      const graceDeadline = Date.now() + FINAL_RESPONSE_GRACE_MS;
      while (
        runIsCurrent() &&
        !hasFinalResponse() &&
        !hasUsableBody() &&
        Date.now() < graceDeadline
      ) {
        await waitForMilliseconds(25);
      }

      // Prefer a post-tool final answer. If only pre-tool narrative is present, skip history
      // reload (user already sees the body). Reload only when the turn has no usable text.
      if (runIsCurrent() && !hasFinalResponse() && !hasUsableBody()) {
        await recoverPromptHistory();
      }
      if (!runIsCurrent()) return false;
      if (!hasFinalResponse() && !hasUsableBody()) {
        const incompleteError = new Error('回复已结束，但最终正文未送达；自动历史恢复也未找到完整回答。');
        incompleteError.promptAccepted = true;
        throw incompleteError;
      }

      get().flushThreadTimelineCoalesce?.(threadId);
      // H3: re-check current-ness right before the terminal patch; a cancel that
      // arrived after the runIsCurrent() guard at line 2061 must not be overwritten
      // with `idle`/`success`.
      if (!runIsCurrent()) return false;
      const completedRuntime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      const completedTimeline = closeAssistantStream(completedRuntime.timeline);
      get().patchThreadRuntime(
        threadId,
        responseTerminalRuntimePatch({
          timeline: completedTimeline,
          // H1: remember the just-finished run so late SSE chunks still arriving
          // within LATE_PROMPT_CORRELATION_MS are appended instead of dropped.
          lastPromptRunId: activePromptRunId,
          lastPromptRunAt: Date.now(),
        }),
      );
      await get().updateThreadRecord(threadId, {
        status: 'idle',
        unread: get().activeThreadId !== threadId,
        timeline: completedTimeline.slice(-300),
        metadata: { ...(get().threadsById[threadId]?.metadata || {}), lastError: null },
      });
      // Clear the late-correlation window after it expires so a stale run id can
      // never accept unrelated chunks far in the future.
      setTimeout(() => {
        const r = get().threadRuntimeById[threadId];
        if (r && r.lastPromptRunId === activePromptRunId) {
          get().patchThreadRuntime(threadId, { lastPromptRunId: null, lastPromptRunAt: 0 });
        }
      }, LATE_PROMPT_CORRELATION_MS + 500);
      if ((get().threadRuntimeById[threadId]?.promptQueue || []).length > 0) {
        setTimeout(() => get().drainThreadPromptQueue(threadId), 0);
      } else {
        get().notifyThreadResult(threadId, 'success');
      }
      return true;
    } catch (error) {
      const failedRuntime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      const currentThread = get().threadsById[threadId] || thread;
      const userCancelled =
        ['cancelled', 'cancelling'].includes(currentThread.status) ||
        /cancelled|canceled|aborted by user|用户取消|已取消/i.test(error.message || '');
      if (userCancelled) {
        if (failedRuntime.activePromptRunId === activePromptRunId) {
          get().flushThreadTimelineCoalesce?.(threadId);
          const flushedFailed = get().threadRuntimeById[threadId] || failedRuntime;
          get().patchThreadRuntime(
            threadId,
            responseTerminalRuntimePatch({ timeline: closeAssistantStream(flushedFailed.timeline) }),
          );
        }
        return false;
      }
      if (!runIsCurrent()) return false;

      const restoreInput = error.promptAccepted !== true;
      const failedDraft = restoreInput ? String(draftText || '').trim() : '';
      const currentDraft = String(currentThread.draft || '').trim();
      const restoredDraft = failedDraft && currentDraft ? `${failedDraft}\n\n${currentDraft}` : failedDraft || currentDraft;
      get().flushThreadTimelineCoalesce?.(threadId);
      const flushedFailedRuntime = get().threadRuntimeById[threadId] || failedRuntime;
      const restoredAttachments = restoreInput
        ? [...attachments, ...(flushedFailedRuntime.pendingAttachments || [])].filter(
            (item, index, items) =>
              items.findIndex(
                (candidate) =>
                  candidate.path === item.path && candidate.name === item.name && candidate.kind === item.kind,
              ) === index,
          )
        : flushedFailedRuntime.pendingAttachments || [];
      const failedTimeline = closeAssistantStream(
        reduceAcpEvent(flushedFailedRuntime.timeline, 'error', { message: error.message, type: 'error' }, threadId),
      );
      get().patchThreadRuntime(
        threadId,
        responseTerminalRuntimePatch({
          timeline: failedTimeline,
          pendingAttachments: restoredAttachments,
        }),
      );
      await get().updateThreadRecord(threadId, {
        status: 'error',
        unread: get().activeThreadId !== threadId,
        draft: restoredDraft,
        timeline: failedTimeline.slice(-300),
        metadata: { ...(currentThread.metadata || {}), lastError: error.message },
      });
      // Prompt failures already render as a timeline error card. Do NOT also set the
      // global fixed overlay (GlobalErrorNotice): long proxy/env dumps block the
      // composer send button and have no reliable close path for /compact etc.
      if (get().activeThreadId === threadId) set({ error: null });
      get().notifyThreadResult(threadId, 'error');
      return false;
    }
  },
  async drainThreadPromptQueue(threadId) {
    const prepared = await queuePromptQueueOperation(threadId, async () => {
      const thread = get().threadsById[threadId];
      const client = get().getThreadClient(threadId);
      const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      const [next, ...rest] = runtime.promptQueue;
      if (!thread || !client || !next) return null;
      if (RESPONSE_BUSY_STATUSES.has(thread.status) || runtime.isAwaitingResponse || runtime.activePromptRunId || runtime.promptDispatchInFlight) return null;

      let attachments = Array.isArray(next.attachments) ? next.attachments : [];
      const requiresReload = attachments.some(
        (attachment) =>
          (attachment.kind === 'image' && !attachment.data) ||
          (attachment.kind === 'text' && typeof attachment.text !== 'string'),
      );
      if (requiresReload) {
        if (!window.electronAPI?.readAttachments) {
          set({ error: '无法恢复待发送附件：桌面文件读取接口不可用' });
          return null;
        }
        const loaded = await window.electronAPI.readAttachments(attachments.map((attachment) => attachment.path));
        const currentThread = get().threadsById[threadId];
        if (!currentThread || currentThread.sessionId !== thread.sessionId) return null;
        const rejected = (loaded || []).filter((attachment) => attachment.kind === 'unsupported');
        if (rejected.length) {
          set({
            error: `无法恢复待发送附件：${rejected.map((attachment) => `${attachment.name}: ${attachment.error}`).join('；')}`,
          });
          return null;
        }
        const loadedByPath = new Map((loaded || []).map((attachment) => [attachment.path, attachment]));
        attachments = attachments.map((attachment) => loadedByPath.get(attachment.path)).filter(Boolean);
        if (attachments.length !== next.attachments.length) {
          set({ error: '无法恢复全部待发送附件，请确认文件仍在原位置' });
          return null;
        }
        const imageSupported = Boolean(
          runtime.capabilities?.promptCapabilities?.image || runtime.capabilities?.prompt_capabilities?.image,
        );
        if (!imageSupported && attachments.some((attachment) => attachment.kind === 'image')) {
          set({ error: '当前运行时未声明图片输入能力，无法继续发送队列中的图片' });
          return null;
        }
      }

      get().patchThreadRuntime(threadId, {
        promptQueue: rest,
        // P0-4: mark the dispatch window busy BEFORE the persist await below, so
        // a sendPrompt arriving while the pop→dispatch gap is open (queue already
        // empty, runThreadPrompt not yet started) queues instead of double-sending
        // a second session/prompt against the same thread.
        promptDispatchInFlight: true,
      });
      const persisted = await get().persistThreadPromptQueue(threadId, rest);
      if (!persisted) {
        get().patchThreadRuntime(threadId, {
          promptQueue: runtime.promptQueue,
          promptDispatchInFlight: false,
        });
        get().setThreadPromptQueue(threadId, runtime.promptQueue);
        return null;
      }
      return { next, attachments };
    });
    if (!prepared) return false;
    // H4: serialize the actual prompt dispatch per thread so two concurrent
    // drainThreadPromptQueue calls (one from the success-path setTimeout and one
    // from a queued sendPrompt, both of which pass the queue lock that only guards
    // the pop) cannot each call runThreadPrompt and double-send session/prompt.
    try {
      return await runUniqueSessionAction(`${threadId}:prompt`, () =>
        get().runThreadPrompt(
          threadId,
          prepared.next.text,
          prepared.attachments,
          prepared.next.draftText ?? prepared.next.text,
        ),
      );
    } finally {
      // The dispatch window is over (success or failure); runThreadPrompt's own
      // busy flags now cover the running prompt.
      get().patchThreadRuntime(threadId, { promptDispatchInFlight: false });
    }
  },

  async moveQueuedPrompt(threadId, promptId, direction) {
    if (!threadId || !promptId || !['up', 'down'].includes(direction)) return false;
    return queuePromptQueueOperation(threadId, async () => {
      const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      const index = runtime.promptQueue.findIndex((item) => item.id === promptId);
      if (index < 0) return false;
      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= runtime.promptQueue.length) return true;
      const promptQueue = [...runtime.promptQueue];
      [promptQueue[index], promptQueue[targetIndex]] = [promptQueue[targetIndex], promptQueue[index]];
      get().patchThreadRuntime(threadId, { promptQueue });
      const persisted = await get().persistThreadPromptQueue(threadId, promptQueue);
      if (!persisted) {
        get().patchThreadRuntime(threadId, { promptQueue: runtime.promptQueue });
        get().setThreadPromptQueue(threadId, runtime.promptQueue);
      }
      return persisted;
    });
  },

  async removeQueuedPrompt(threadId, promptId) {
    return queuePromptQueueOperation(threadId, async () => {
      const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      const promptQueue = runtime.promptQueue.filter((item) => item.id !== promptId);
      if (promptQueue.length === runtime.promptQueue.length) return true;
      get().patchThreadRuntime(threadId, { promptQueue });
      const persisted = await get().persistThreadPromptQueue(threadId, promptQueue);
      if (!persisted) {
        get().patchThreadRuntime(threadId, { promptQueue: runtime.promptQueue });
        get().setThreadPromptQueue(threadId, runtime.promptQueue);
      }
      return persisted;
    });
  },

  // ===== 鉴权 action（对照源 viewState/login/logout）=====
  };
}
