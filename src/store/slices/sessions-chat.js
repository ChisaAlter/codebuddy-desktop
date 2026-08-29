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
  mergeWorkflowProgressEvent,
  subagentMetadata,
  teamUpdateFromPayload,
  workflowProgressEventFromPayload,
  workflowStateFromPayload,
  goalEventFromPayload,
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
import { isFileEditTool } from '../../lib/file-edit-tools';
import {
  hasCompletePromptResponse,
  hasPromptRunActivity,
  hasUsableAssistantBody,
  hasUsableGoalTurn,
  hasUsableMemberConclusions,
} from '../helpers/prompt-completion';
import {
  emptyThreadRuntime,
  resolveThreadTimeline,
  responseTerminalRuntimePatch,
  sessionActionItemMatches,
  ACTIVE_THREAD_RUNTIME_KEYS,
} from '../helpers/thread-runtime';
import {
  normalizeGoalEvent,
  mergeGoalEvent,
  emptyGoalState,
  isGoalPrompt,
  seedGoalStateFromPrompt,
} from '../../lib/goal-state';
import { collectSubagentReports } from '../../lib/subagent-report';
import { busySendModeFromSettings, shouldQueueBusyPrompt } from '../../lib/busy-send';
import {
  fetchGoalSnapshot,
  pauseGoal,
  resumeGoal,
  clearGoal,
  activeGoalFromSnapshot,
  normalizeGoalRecap,
} from '../../lib/goal-api';
import { appendTurnMetrics, showTurnDurationFromSettings } from '../../lib/turn-metrics';
import { buildPromptContentBlocks } from '../../lib/prompt-content';
import { deriveWorkflowView, DISMISS_WINDOW_MS, shouldWorkflowAutoOpen } from '../../lib/workflow-status';
import { resetProjectRuntimeViews } from '../helpers/terminal-workspace-state';

const BACKGROUND_DRAIN_WINDOW_MS = 60_000;
const BACKGROUND_DRAIN_MAX_MS = 120_000;
const BACKGROUND_DRAIN_EXTENSION_MS = 15_000;
const WORKFLOW_PROGRESS_POLL_MS = 500;
const WORKFLOW_PROGRESS_IDLE_GRACE_MS = 5_000;
const WORKFLOW_PROGRESS_MAX_MS = 12 * 60 * 60 * 1_000;
// 压缩完成后 CLI 未必推送新的 usage_update；延迟到 turn 终态（activePromptRunId
// 清理）后轻量 session/load 一次刷新用量。覆盖终态收尾 + 迟到重放窗口。
const COMPACT_USAGE_REFRESH_DELAY_MS = 2_000;
const workflowProgressMonitors = new Map();
// M-perf: 已识别的 codebuddy.ai/* 私有键。旧实现在 handleThreadSessionUpdate 内
// 每条 session/update（即每个流式 token）都重建这 35 项 Set，纯 GC churn。
const KNOWN_PRIVATE_METADATA_KEYS = new Set([
  'codebuddy.ai/promptSuggestion',
  'codebuddy.ai/teamUpdate',
  'codebuddy.ai/agentPhase',
  'codebuddy.ai/progress',
  'codebuddy.ai/historyReplay',
  'codebuddy.ai/goalProgress',
  'codebuddy.ai/goalStatus',
  'codebuddy.ai/goalMode',
  'codebuddy.ai/goalRecap',
  'codebuddy.ai/workflowState',
  'codebuddy.ai/workflowUpdate',
  'codebuddy.ai/workflowEventKind',
  'codebuddy.ai/workflowRunId',
  'codebuddy.ai/workflowName',
  'codebuddy.ai/workflowStatus',
  'codebuddy.ai/workflowAgentCount',
  'codebuddy.ai/workflowCachedCount',
  'codebuddy.ai/workflowPhaseCount',
  'codebuddy.ai/workflowError',
  'codebuddy.ai/workflowPhase',
  'codebuddy.ai/workflowAgentKey',
  'codebuddy.ai/workflowAgentLabel',
  'codebuddy.ai/workflowAgentPhase',
  'codebuddy.ai/workflowAgentError',
  'codebuddy.ai/workflowAgentTokens',
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
// agentCheckpointPathsById 只增不减会随会话累积泄漏；键为 checkpoint id 无法反查
// 线程，改为有界容量（保留最新条目，超出淘汰最旧）。
const AGENT_CHECKPOINT_PATHS_LIMIT = 400;

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
  startWorkflowProgressMonitor({ threadId, projectId, sessionId, startedAfter }) {
    const readWorkflowProgress = window.electronAPI?.readWorkflowProgress;
    if (!threadId || !projectId || !sessionId || typeof readWorkflowProgress !== 'function') return false;
    const token = {};
    workflowProgressMonitors.set(threadId, token);
    const cutoff = Number(startedAfter) || Date.now();

    void (async () => {
      let foundWorkflow = false;
      let idleSince = 0;
      let observedRunId = null;
      try {
        while (workflowProgressMonitors.get(threadId) === token) {
          const currentThread = get().threadsById[threadId];
          const currentRuntime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
          const currentSessionId = currentThread?.sessionId || currentRuntime.sessionId;
          if (currentThread?.projectId !== projectId || currentSessionId !== sessionId) break;

          let snapshot = null;
          try {
            snapshot = await readWorkflowProgress({
              projectId,
              sessionId,
              startedAfter: cutoff,
              ...(observedRunId ? { runId: observedRunId } : {}),
            });
          } catch {
            snapshot = null;
          }
          if (workflowProgressMonitors.get(threadId) !== token) break;

          if (snapshot?.runId) {
            foundWorkflow = true;
            observedRunId = snapshot.runId;
            idleSince = 0;
            const status = String(snapshot.status || '').toLowerCase();
            const terminal = snapshot.active === false || ['completed', 'failed', 'cancelled'].includes(status);
            const normalized = {
              ...snapshot,
              status: status || (terminal ? 'completed' : 'running'),
              active: !terminal,
              updatedAt: Number(snapshot.updatedAt) || Date.now(),
            };
            const now = Date.now();
            // M-perf: 进度文件未变化时跳过 patch —— patchThreadRuntime 每次都生成
            // 新 runtime 引用，会让所有浅比较订阅者（App 状态栏/面板）以 2Hz 空转
            // 重渲染长达数小时。快照为小对象，签名对比成本可忽略。
            const prevWorkflow = currentRuntime.workflowState;
            const workflowUnchanged =
              prevWorkflow &&
              typeof prevWorkflow === 'object' &&
              JSON.stringify(prevWorkflow) === JSON.stringify(normalized);
            if (!workflowUnchanged) {
              get().patchThreadRuntime(threadId, {
                workflowState: normalized,
                ...(terminal
                  ? {
                      lastWorkflowState: normalized,
                      backgroundDrainRunId: normalized.runId,
                      backgroundDrainUntil: now + BACKGROUND_DRAIN_WINDOW_MS,
                      backgroundDrainMaxUntil: now + BACKGROUND_DRAIN_MAX_MS,
                    }
                  : {}),
              });

              if (get().activeThreadId === threadId) {
                const latestRuntime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
                const latestThread = get().threadsById[threadId];
                const view = deriveWorkflowView({
                  runtime: latestRuntime,
                  threadStatus: latestThread?.status || 'idle',
                  timeline: latestRuntime.timeline,
                });
                const currentPanel = get().workflowFloatingPanel;
                if (
                  currentPanel?.payload?.runId !== normalized.runId &&
                  shouldWorkflowAutoOpen(view, {
                    dismissed: get().workflowPanelDismissed,
                    runId: normalized.runId,
                  })
                ) {
                  get().openWorkflowPanel({ projectId, threadId, runId: normalized.runId });
                }
              }
            }
            if (terminal) break;
          } else if (!foundWorkflow) {
            const latestThread = get().threadsById[threadId];
            const latestRuntime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
            const promptActive = Boolean(
              latestRuntime.activePromptRunId ||
              latestRuntime.isAwaitingResponse ||
              ['connecting', 'running', 'waiting'].includes(latestThread?.status)
            );
            if (promptActive) {
              idleSince = 0;
            } else if (!idleSince) {
              idleSince = Date.now();
            } else if (Date.now() - idleSince >= WORKFLOW_PROGRESS_IDLE_GRACE_MS) {
              break;
            }
          }

          if (Date.now() - cutoff >= WORKFLOW_PROGRESS_MAX_MS) break;
          await new Promise((resolve) => setTimeout(resolve, WORKFLOW_PROGRESS_POLL_MS));
        }
      } finally {
        if (workflowProgressMonitors.get(threadId) === token) workflowProgressMonitors.delete(threadId);
      }
    })();
    return true;
  },

  applySessionConfigUpdate(
    configOptions = [],
    { preserveModel = false, preserveMode = false, preserveThoughtLevel = false, previousModels = [] } = {},
  ) {
    const next = {};
    for (const option of configOptions) {
      if (option.id === 'model') {
        if (!preserveModel) next.currentModel = option.currentValue;
        // config_option 的 choices 不带 _meta（倍率/上下文窗口），从已知模型列表回填。
        const models = normalizeModels(configOptionChoices(option), previousModels);
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
      const patch = get().applySessionConfigUpdate(update.configOptions || [], {
        ...selectionProtection,
        previousModels: get().models,
      });
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
    const workflowProgressEvent = workflowProgressEventFromPayload(update);
    const workflowState = workflowStateFromPayload(update);
    if (workflowProgressEvent) {
      const previousWorkflow = runtime.workflowState || (
        runtime.lastWorkflowState?.runId === workflowProgressEvent.runId
          ? runtime.lastWorkflowState
          : null
      );
      runtimePatch.workflowState = mergeWorkflowProgressEvent(previousWorkflow, workflowProgressEvent);
      if (workflowProgressEvent.kind === 'workflow_run_started') {
        runtimePatch.backgroundDrainRunId = null;
        runtimePatch.backgroundDrainUntil = 0;
        runtimePatch.backgroundDrainMaxUntil = 0;
      } else if (workflowProgressEvent.kind === 'workflow_run_finished') {
        const drainStartedAt = Date.now();
        runtimePatch.backgroundDrainRunId = workflowProgressEvent.runId || runtimePatch.workflowState?.runId || null;
        runtimePatch.backgroundDrainUntil = drainStartedAt + BACKGROUND_DRAIN_WINDOW_MS;
        runtimePatch.backgroundDrainMaxUntil = drainStartedAt + BACKGROUND_DRAIN_MAX_MS;
      }
    } else if (workflowState) {
      runtimePatch.workflowState = {
        ...workflowState,
        active: workflowState.active !== false,
        updatedAt: Number(workflowState.updatedAt) || Date.now(),
        runId: workflowState.runId || runtime.activePromptRunId || null,
      };
    }
    const goalPayload = goalEventFromPayload(update);
    if (goalPayload) {
      const existingGoals = runtime.goalState || emptyGoalState(update._meta?.['codebuddy.ai/goalMode'] || null);
      const normalizedGoal = normalizeGoalEvent(goalPayload.payload, goalPayload.type);
      runtimePatch.goalState = mergeGoalEvent(existingGoals, normalizedGoal);
      runtimePatch.progress = normalizedGoal.progress?.percent != null
        ? normalizedGoal.progress
        : runtime.progress;
    }
    // G2: codebuddy.ai/goalRecap → recap 卡片 + goal bar 同步（active → bar，latest 终态 → bar 清空）。
    if (Object.prototype.hasOwnProperty.call(metadata, 'codebuddy.ai/goalRecap')) {
      const recap = normalizeGoalRecap(metadata['codebuddy.ai/goalRecap']);
      runtimePatch.goalRecap = recap;
      if (recap?.active) {
        runtimePatch.goalBar = {
          condition: recap.active.condition,
          createdAt: recap.active.createdAt ?? runtime.goalBar?.createdAt ?? Date.now(),
          ...(typeof recap.active.pausedAt === 'number' ? { pausedAt: recap.active.pausedAt } : {}),
          paused: recap.active.paused === true || typeof recap.active.pausedAt === 'number',
        };
      } else if (recap?.latest) {
        runtimePatch.goalBar = null;
      }
    }
    const memberEvent = Boolean(memberName && contentEvent);
    const workflowActivity = Boolean(
      teamUpdateFromPayload(update) || workflowProgressEvent || workflowState || goalPayload || subagent || memberName
    );
    if (memberEvent) {
      runtimePatch.memberHistoriesByName = mergeMemberTimeline(
        runtime.memberHistoriesByName,
        memberName,
        su,
        update,
        threadId,
      );
      if (subagent?.parentToolCallId && update.toolCallId) {
        runtimePatch.subagentToolCalls = {
          ...(runtime.subagentToolCalls || {}),
          [update.toolCallId]: {
            toolCallId: update.toolCallId,
            parentToolCallId: subagent.parentToolCallId,
            memberName,
            subagentType: subagent.subagentType,
            status: update.status || null,
            updatedAt: Date.now(),
          },
        };
      }
    } else if (contentEvent && subagent?.parentToolCallId && update.toolCallId) {
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
    const unknownPrivateKey = privateKeys.find((key) => !KNOWN_PRIVATE_METADATA_KEYS.has(key));
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
    // Compact transitions from session/load history must not drive UI or schedule
    // another usage refresh. Only a live turn or an explicit history replay is
    // authoritative (usage-refresh / rebind never reach this path).
    const liveTurn = Boolean(runtime.activePromptRunId || runtime.historyReplayActive);
    if (liveTurn && Object.prototype.hasOwnProperty.call(metadata, 'codebuddy.ai/compact-cancelled')) {
      runtimePatch.compactCancelled = true;
      runtimePatch.compactState = 'cancelled';
      compactTimelinePayload = { phase: 'cancelled' };
    } else if (liveTurn && progressType === 'compacting') {
      if (prevCompactState !== 'compacting') {
        runtimePatch.compactState = 'compacting';
        compactTimelinePayload = { phase: 'compacting' };
      }
    } else if (liveTurn && prevCompactState === 'compacting' && progressType && progressType !== 'compacting') {
      // progress 转为其他类型且此前在 compacting → 视为完成。
      runtimePatch.compactState = 'compacted';
      runtimePatch.usageRefreshPending = true;
      compactTimelinePayload = { phase: 'compacted' };
      // 压缩完成后 CLI 未必主动推送新的 usage_update，上下文用量环可能停留在
      // 旧值。延迟轻量 session/load（mode=usage-refresh）；turn 仍忙则终态再刷。
      const compactedThreadId = threadId;
      setTimeout(() => {
        void get().refreshUsageAfterCompact(compactedThreadId).catch(() => {});
      }, COMPACT_USAGE_REFRESH_DELAY_MS);
    }
    if (Object.keys(runtimePatch).length) get().patchThreadRuntime(threadId, runtimePatch);
    if (workflowActivity || subagent || memberName) {
      // M-perf: pure content chunks (agent_message/thought/user_message with a
      // member) only grow memberHistoriesByName — rebuilding the full subagent
      // report on every chunk is O(timeline + members + history) per token.
      // Defer to structural events (tool_call/update, teamState, goal, workflow);
      // the turn's terminal event recomputes the report anyway.
      const pureContentMemberChunk =
        memberEvent &&
        (su === 'agent_message_chunk' || su === 'agent_thought_chunk' || su === 'user_message_chunk');
      if (!pureContentMemberChunk) {
        const latest = get().threadRuntimeById[threadId] || runtime;
        runtimePatch.subagentReports = collectSubagentReports({
          timeline: latest.timeline,
          teamState: latest.teamState,
          lastTeamState: latest.lastTeamState,
          memberHistoriesByName: latest.memberHistoriesByName,
          subagentToolCalls: latest.subagentToolCalls,
        });
        get().patchThreadRuntime(threadId, { subagentReports: runtimePatch.subagentReports });
      }
    }
    if (get().activeThreadId === threadId) {
      // Auto-open only for real orchestration (team/goal/workflow/explicit subagent), not TaskCreate spam.
      const latestForPanel = get().threadRuntimeById[threadId] || runtime;
      // M-perf: 纯内容 chunk（消息/思考 token）不会新增编排信号——team/goal/workflow
      // 状态、member 历史、subagent 工具调用都由结构化事件写入 runtime。无信号时
      // deriveWorkflowView 的自动打开判定与上一条事件一致；而 normalizeWorkflowStatus
      // 的缓存按 runtime 引用记忆化，patchThreadRuntime 每 chunk 都换引用导致缓存必
      // 然失效，因此这里按信号短路，避免每 token 一次 O(当前回合条目) 派生。
      const pureContentChunk =
        su === 'agent_message_chunk' || su === 'agent_thought_chunk' || su === 'user_message_chunk';
      const goalStateHasContent = (state) =>
        Boolean(state) &&
        (Number(state.eventCount) > 0 ||
          Boolean(state.activeGoalId) ||
          Object.keys(state.goalsById || {}).length > 0);
      const orchestrationSignal = Boolean(
        workflowActivity ||
        runtimePatch.workflowState || runtimePatch.goalState ||
        runtimePatch.teamState || runtimePatch.lastTeamState ||
        latestForPanel.workflowState || latestForPanel.lastWorkflowState ||
        latestForPanel.teamState || latestForPanel.lastTeamState ||
        goalStateHasContent(latestForPanel.goalState) || goalStateHasContent(latestForPanel.lastGoalState) ||
        (latestForPanel.subagentReports && latestForPanel.subagentReports.length) ||
        (latestForPanel.memberHistoriesByName && Object.keys(latestForPanel.memberHistoriesByName).length) ||
        (latestForPanel.subagentToolCalls && Object.keys(latestForPanel.subagentToolCalls).length)
      );
      if (!pureContentChunk || orchestrationSignal) {
        const view = deriveWorkflowView({
          runtime: latestForPanel,
          threadStatus: get().threadsById[threadId]?.status || 'idle',
          timeline: latestForPanel.timeline,
        });
        const runId = view.runId || runtimePatch.workflowState?.runId || runtimePatch.goalState?.runId || runtime.activePromptRunId;
        const currentPanel = get().workflowFloatingPanel;
        if (
          !view.empty &&
          shouldWorkflowAutoOpen(view, { dismissed: get().workflowPanelDismissed, runId }) &&
          currentPanel == null
        ) {
          get().openWorkflowPanel({
            projectId: get().activeProjectId || null,
            threadId,
            runId,
          });
        }
      }
    }
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
      const normalizedGoal = normalizeGoalEvent(goalEvent, eventType);
      const currentTimeline = get().threadRuntimeById[threadId]?.timeline || runtime.timeline;
      const duplicate = currentTimeline.some((item) => {
        if (item.type !== eventType) return false;
        const existing = normalizeGoalEvent(item.meta || item.raw || item, eventType);
        return existing.eventKey === normalizedGoal.eventKey || (normalizedGoal.eventId && existing.eventId === normalizedGoal.eventId);
      });
      if (!duplicate) get().appendThreadTimelineEvent(threadId, eventType, { ...goalEvent, type: eventType });
    }

    // Member messages are kept in their per-agent history. Shared metadata above
    // has already been applied, so do not duplicate the content in the leader timeline.
    if (memberEvent) return;

    if (su === 'config_option_update') {
      const selectionProtection = threadSelectionProtection(get(), threadId);
      const patch = get().applySessionConfigUpdate(update.configOptions || [], {
        ...selectionProtection,
        previousModels: get().threadRuntimeById[threadId]?.models,
      });
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
      // 终态准入门控：回合已失败/取消（error/cancelled）且无活动 run 时，迟到的中断事件
      // 不得复活线程或追加权限卡片——否则失败/取消后残留的 permissionRequests 会让
      // deriveWorkflowView 判定 waiting_for_permission，且线程状态被回写成 waiting，
      // 导致发送键卡死在终止态、Allow 按钮点不动。标记为 expired 后丢弃。
      // idle 不拦截：idle 是正常的等待状态，新会话首次权限请求时线程也是 idle。
      const gateRuntime = get().threadRuntimeById[threadId] || runtime;
      const gateStatus = get().threadsById[threadId]?.status || 'idle';
      const hasLiveRun = Boolean(
        gateRuntime.activePromptRunId || gateRuntime.isAwaitingResponse || gateRuntime.promptDispatchInFlight,
      );
      const isFailedOrCancelled = ['error', 'cancelled'].includes(gateStatus);
      if (isFailedOrCancelled && !hasLiveRun) {
        get().appendThreadTimelineEvent(threadId, su, { ...update, _expiredLate: true, status: 'expired' });
        return;
      }
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
      if (autoAllowFileEdits && toolName !== 'AskUserQuestion' && isFileEditTool(toolName)) {
        const autoInterruptionId = update.interruptionId || requestIds[0] || null;
        const autoToolCallId = update.toolCallId || null;
        // Append a brief timeline entry so the auto-allow is visible, then resolve.
        get().appendThreadTimelineEvent(threadId, su, { ...update, _autoAllowed: true });
        queueMicrotask(() => {
          get().respondToInterruption(autoInterruptionId, 'allow', autoToolCallId, threadId).catch(() => null);
        });
        return;
      }
      get().patchThreadRuntime(threadId, { permissionRequests: [...runtime.permissionRequests, update] });
      get().appendThreadTimelineEvent(threadId, su, update);
      get().updateThreadRecord(threadId, { status: 'waiting', unread: get().activeThreadId !== threadId });
      return;
    }
    if (su === 'question_request') {
      // 终态准入门控：同 interruption_request，迟到问答事件不得复活已失败/取消线程。
      // idle 不拦截：idle 是正常的等待状态。
      const gateRuntime = get().threadRuntimeById[threadId] || runtime;
      const gateStatus = get().threadsById[threadId]?.status || 'idle';
      const hasLiveRun = Boolean(
        gateRuntime.activePromptRunId || gateRuntime.isAwaitingResponse || gateRuntime.promptDispatchInFlight,
      );
      const isFailedOrCancelled = ['error', 'cancelled'].includes(gateStatus);
      if (isFailedOrCancelled && !hasLiveRun) {
        get().appendThreadTimelineEvent(threadId, su, { ...update, _expiredLate: true, status: 'expired' });
        return;
      }
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
      const statusGateRuntime = get().threadRuntimeById[threadId] || runtime;
      const statusGateLocal = get().threadsById[threadId]?.status || 'idle';
      const statusHasLiveRun = Boolean(
        statusGateRuntime.activePromptRunId
          || statusGateRuntime.isAwaitingResponse
          || statusGateRuntime.promptDispatchInFlight,
      );
      if (!statusHasLiveRun && ['idle', 'cancelled', 'error'].includes(statusGateLocal)) {
        return;
      }
      let finalStatus = normalizedStatus;
      if (['idle', 'error', 'cancelled'].includes(normalizedStatus)) {
        const latestRuntime = get().threadRuntimeById[threadId] || runtime;
        const client = conversations.peek(threadId) || get().getThreadClient(threadId);
        const sessionId = get().threadsById[threadId]?.sessionId || latestRuntime.sessionId;
        const requestStillActive = Boolean(
          latestRuntime.activePromptRunId && client?.hasActivePrompt?.(sessionId),
        );
        if (!requestStillActive) {
          // A local user cancellation is terminal. Late backend status events may
          // report idle/error after the stream was closed, but must not resurrect
          // or recolor the cancelled turn.
          if (get().threadsById[threadId]?.status === 'cancelled' && normalizedStatus !== 'cancelled') {
            return;
          }
          // 权限/问答未决时不做 terminal 清理（保留 permissionRequests），并在下方
          // 把 finalStatus 改为 waiting，防止 Allow 按钮因 respondToInterruption
          // 前置条件拒绝而死锁。cancelled 不受保护（取消路径已显式清空权限/问答）。
          const hasPendingInteraction =
            (latestRuntime.permissionRequests || []).some(
              (item) => !['resolved', 'expired', 'cancelled'].includes(item?.status),
            ) ||
            (latestRuntime.questions || []).some(
              (item) => !['answered', 'expired', 'cancelled'].includes(item?.status),
            );
          if (hasPendingInteraction && ['idle', 'error'].includes(normalizedStatus)) {
            // 跳过 terminal 清理：保留 permissionRequests/questions 不被 responseTerminalRuntimePatch 清空
          } else {
            get().flushThreadTimelineCoalesce?.(threadId);
            const flushedRuntime = get().threadRuntimeById[threadId] || latestRuntime;
            const terminalPatch = responseTerminalRuntimePatch({
              timeline: cancelPendingTimelineActions(closeAssistantStream(flushedRuntime.timeline)),
              lastWorkflowState: flushedRuntime.workflowState || flushedRuntime.lastWorkflowState || null,
              lastGoalState: flushedRuntime.goalState || flushedRuntime.lastGoalState || null,
            });
            if (flushedRuntime.teamState) {
              terminalPatch.lastTeamState = completedTeamSnapshot(
                flushedRuntime.teamState,
                { type: 'team_deleted', status: normalizedStatus === 'error' ? 'failed' : normalizedStatus === 'cancelled' ? 'cancelled' : 'completed' },
              );
            }
            terminalPatch.lastSubagentReports = collectSubagentReports({
              timeline: flushedRuntime.timeline,
              teamState: flushedRuntime.teamState,
              lastTeamState: terminalPatch.lastTeamState || flushedRuntime.lastTeamState,
              memberHistoriesByName: flushedRuntime.memberHistoriesByName,
              subagentToolCalls: flushedRuntime.subagentToolCalls,
            });
            get().patchThreadRuntime(
              threadId,
              terminalPatch,
            );
          }
        }
      }
      // 权限/问答未决时保留 waiting，不覆盖为 idle/error
      if (['idle', 'error'].includes(normalizedStatus)) {
        const beforeStatusRuntime = get().threadRuntimeById[threadId] || runtime;
        const hasPendingInteraction =
          (beforeStatusRuntime.permissionRequests || []).some(
            (item) => !['resolved', 'expired', 'cancelled'].includes(item?.status),
          ) ||
          (beforeStatusRuntime.questions || []).some(
            (item) => !['answered', 'expired', 'cancelled'].includes(item?.status),
          );
        if (hasPendingInteraction) finalStatus = 'waiting';
      }
      get().updateThreadRecord(threadId, {
        status: finalStatus,
        unread: get().activeThreadId !== threadId && ['idle', 'error', 'cancelled'].includes(finalStatus),
      });
      if (['idle', 'error', 'cancelled'].includes(finalStatus)) {
        get().flushPendingUsageRefresh(threadId);
      }
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
      // 会话已判定失效时不再打 restore 标记，避免与 session_invalid 重复报错。
      const sessionInvalid =
        detail?.sessionInvalid === true || thread?.metadata?.sessionInvalid === true;
      if (!sessionInvalid && detail?.sessionBound === false && thread?.sessionId) {
        // 重连成功但会话未绑定：无论是否有 active turn，都必须打标。
        // 有 active turn 时延后 rebind；无 active turn 时立刻补 session/load。
        get().patchThreadRuntime(threadId, { sessionRestoreNeeded: true });
        const latestRuntime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
        if (!latestRuntime.activePromptRunId) {
          void get().rebindSessionAfterTurn(threadId).catch(() => {});
        }
      } else if (detail?.sessionBound === true) {
        const latestRuntime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
        if (latestRuntime.sessionRestoreNeeded) {
          get().patchThreadRuntime(threadId, { sessionRestoreNeeded: false });
        }
      }
      return;
    }
    if (type === 'session_restored') {
      const latestRuntime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      get().patchThreadRuntime(threadId, { sessionRestoreNeeded: false });
      if (!latestRuntime.activePromptRunId && get().activeThreadId === threadId) {
        set({ sessionToken: client?.sessionToken || null, error: null });
      }
      return;
    }
    if (type === 'session_invalid') {
      const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      // 会话已判定失效：清掉 restore 标记，避免反复 load；引导用户新建会话。
      get().patchThreadRuntime(threadId, {
        connectionState: 'connected',
        sessionRestoreNeeded: false,
      });
      get().updateThreadRecord(threadId, {
        status: runtime.activePromptRunId ? 'running' : 'idle',
        metadata: {
          ...(thread?.metadata || {}),
          lastError: '会话已失效（服务端重启或连接重建），请新建会话继续',
          sessionInvalid: true,
        },
      });
      if (get().activeThreadId === threadId) {
        set({ error: '会话已失效（服务端重启或连接重建），请新建会话继续' });
      }
      return;
    }
    if (type === 'reconnect_failed') {
      get().flushThreadTimelineCoalesce?.(threadId);
      const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      const hasActiveTurn = Boolean(runtime.activePromptRunId || runtime.isAwaitingResponse);
      // 有进行中的 turn 时只标连接错误，禁止 responseTerminalRuntimePatch 清 run id。
      if (hasActiveTurn) {
        get().patchThreadRuntime(threadId, { connectionState: 'error' });
        const current = get().threadsById[threadId];
        if (current) {
          get().updateThreadRecord(threadId, {
            unread: get().activeThreadId !== threadId,
            metadata: {
              ...(current.metadata || {}),
              lastTransportError: '连接恢复失败，当前回复可能已中断',
            },
          });
        }
        return;
      }
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
      const clientMode = detail?._client?.mode || 'live';
      const serverRequestId = String(detail?._client?.requestId || '').trim();
      const serverInitiated = detail?._client?.serverInitiated === true;
      const sessionUpdate = update.sessionUpdate || update.session_update || update.type;
      if (clientMode === 'usage-refresh') {
        if (sessionUpdate === 'usage_update') get().handleThreadSessionUpdate(threadId, update);
        return;
      }
      if (clientMode === 'rebind') {
        return;
      }
      const historyMode = update?._meta?.['codebuddy.ai']?.mode === 'history';
      const promptContentEvent = PROMPT_CONTENT_SESSION_UPDATES.has(sessionUpdate);
      if (
        historyMode &&
        promptContentEvent &&
        !runtime.historyReplayActive &&
        clientMode !== 'history-replay'
      ) {
        return;
      }
      const promptTerminalEvent = sessionUpdate === 'session_end';
      const now = Date.now();
      let backgroundDrainRunId = runtime.backgroundDrainRunId || null;
      let backgroundDrainActive = Boolean(
        runtime.backgroundDrainRunId &&
        Number(runtime.backgroundDrainUntil) >= now &&
        Number(runtime.backgroundDrainMaxUntil) >= now
      );
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
      if (promptContentEvent && serverInitiated) {
        if (!serverRequestId || promptRunId || runtime.activePromptRunId || runtime.isAwaitingResponse) return;
        const nextDrainRunId = `server:${serverRequestId}`;
        const serverDrainActive = backgroundDrainActive && String(backgroundDrainRunId || '').startsWith('server:');
        if (serverDrainActive && backgroundDrainRunId !== nextDrainRunId) return;
        if (!serverDrainActive) {
          const preserveExistingDrainDeadline = backgroundDrainActive;
          const workflowEvidence = Boolean(
            (runtime.workflowState?.runId && runtime.workflowState.active !== false) ||
            (backgroundDrainActive && !String(backgroundDrainRunId || '').startsWith('server:'))
          );
          if (!workflowEvidence) return;
          backgroundDrainRunId = nextDrainRunId;
          backgroundDrainActive = true;
          get().patchThreadRuntime(threadId, {
            backgroundDrainRunId: nextDrainRunId,
            ...(!preserveExistingDrainDeadline
              ? {
                  backgroundDrainUntil: now + BACKGROUND_DRAIN_WINDOW_MS,
                  backgroundDrainMaxUntil: now + BACKGROUND_DRAIN_MAX_MS,
                }
              : {}),
          });
        }
      }
      if (promptTerminalEvent && serverInitiated) {
        const expectedDrainRunId = serverRequestId ? `server:${serverRequestId}` : null;
        if (
          !expectedDrainRunId ||
          promptRunId ||
          runtime.activePromptRunId ||
          runtime.isAwaitingResponse ||
          !backgroundDrainActive ||
          backgroundDrainRunId !== expectedDrainRunId
        ) {
          return;
        }
        get().flushThreadTimelineCoalesce?.(threadId);
        const latestRuntime = get().threadRuntimeById[threadId] || runtime;
        get().patchThreadRuntime(threadId, {
          timeline: closeAssistantStream(latestRuntime.timeline),
          backgroundDrainUntil: 0,
          backgroundDrainMaxUntil: 0,
        });
        return;
      }
      if (
        promptContentEvent &&
        backgroundDrainActive &&
        String(backgroundDrainRunId || '').startsWith('server:') &&
        backgroundDrainRunId !== `server:${serverRequestId}`
      ) {
        return;
      }
      if (promptContentEvent && !promptRunId && runtime.activePromptRunId && !runtime.historyReplayActive) {
        // H1: same idea — a chunk without a run id that matches the just-finished run
        // is still useful (transport correlates by recency), so accept it while the
        // late-correlation window is open.
        const recentUnmarked =
          runtime.lastPromptRunId &&
          Date.now() - runtime.lastPromptRunAt < LATE_PROMPT_CORRELATION_MS;
        if (!recentUnmarked && !backgroundDrainActive) return;
      }
      if (
        promptContentEvent &&
        !promptRunId &&
        !runtime.activePromptRunId &&
        !runtime.isAwaitingResponse &&
        !runtime.historyReplayActive &&
        !backgroundDrainActive &&
        !['connecting', 'running', 'waiting'].includes(thread?.status)
      ) {
        return;
      }
      get().handleThreadSessionUpdate(threadId, update);
      if (promptContentEvent && backgroundDrainActive) {
        const latestRuntime = get().threadRuntimeById[threadId] || runtime;
        const extendedUntil = Math.min(
          Number(latestRuntime.backgroundDrainMaxUntil) || now,
          now + BACKGROUND_DRAIN_EXTENSION_MS,
        );
        if (extendedUntil > Number(latestRuntime.backgroundDrainUntil || 0)) {
          get().patchThreadRuntime(threadId, { backgroundDrainUntil: extendedUntil });
        }
      }
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
          agentCheckpointPathsById: (() => {
            const merged = {
              ...(state.agentCheckpointPathsById || {}),
              [id]: paths,
            };
            const keys = Object.keys(merged);
            if (keys.length <= AGENT_CHECKPOINT_PATHS_LIMIT) return merged;
            return Object.fromEntries(keys.slice(keys.length - AGENT_CHECKPOINT_PATHS_LIMIT));
          })(),
        }));
      }
      return;
    }
    if (type === 'interaction_requests_invalidated') {
      const interruptionIds = new Set(detail?.interruptionIds || []);
      const questionToolCallIds = new Set(detail?.questionToolCallIds || []);
      // 先 flush 再读 runtime：否则 coalesce 折叠会把这里的 expired 标记整个覆盖掉。
      get().flushThreadTimelineCoalesce?.(threadId);
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
        models: normalizeModels(detail?.availableModels || runtime.models, runtime.models),
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
        { previousModels: threadRuntime.models },
      );
      const availableModels =
        loaded?.models?.availableModels ||
        init?.models?.availableModels ||
        init?.agentCapabilities?.availableModels ||
        configPatch.models ||
        threadRuntime.models;
      const normalizedModels = normalizeModels(availableModels, threadRuntime.models);
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
        // metadata 展开必须用最新读取（latestThread）：connect/await 期间并发写入的
        // promptQueue、authRequired、sessionResetAt 等字段会被 session 级
        // updateThreadRecord 的整字段覆盖，旧快照展开等于丢字段。
        metadata: recoveryError
          ? {
              ...(latestThread.metadata || {}),
              previousSessionId: requestedSessionId,
              recoveryError,
              recoveredAt: new Date().toISOString(),
              lastError: null,
            }
          : { ...(latestThread.metadata || {}), lastError: null },
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
      // Transport timeouts are retriable — always try session/load first. Do NOT treat idle timeout as session death.
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
        const message = String(error?.message || error || '');
        const transportFailure =
          error?.type === 'timeout' ||
          error?.sessionRecoverable === true ||
          /idle timeout|timeout|ECONNREFUSED|network|fetch failed|408|502|503|504/i.test(message);
        const sessionInvalid =
          error?.sessionInvalid === true ||
          /session not found|invalid session|unknown session|no such session|session.*expired/i.test(message);
        // Only create a new session when the old one is explicitly unusable — not on transport blips.
        if (sessionInvalid && !transportFailure) {
          try {
            const loaded = await client.request('session/new', { cwd: project.workspacePath || '.', mcpServers: [] });
            return await applyInitializedSession(null, loaded, error.message);
          } catch (_) {}
        }
      }
      const stillActive = isScopedRequestCurrent(request, get());
      if (stillActive) set({ error: error.message, connectionState: 'error' });
      get().patchThreadRuntime(thread.id, { connectionState: 'error' });
      await get().updateThreadRecord(thread.id, {
        status: 'error',
        metadata: {
          ...(thread.metadata || {}),
          lastError: error.message,
          lastTransportError:
            error?.type === 'timeout' || /idle timeout|timeout/i.test(String(error?.message || ''))
              ? error.message
              : thread.metadata?.lastTransportError || null,
        },
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
        // M-perf: these persist calls update in-memory state synchronously while
        // the full disk write is fire-and-forget — a switch must never be blocked
        // by a full product-state serialization+write (the persist chain in
        // product-persist coalesces the three snapshots into one final write).
        get().persistActiveProjectWorkspaceState({ discardDirty: true }).catch(() => {});
        if (!isProjectNavigationCurrent(navigation)) return false;
        get().persistActiveProjectTerminalState().catch(() => {});
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
      // M2：切换确定后关闭面板（面板绑定数据已失效；放在确认对话框之后，取消切换不误关）
      get().closeWorkflowPanelIfBound?.();
      if (projectChanged) get().loadProjectTerminalState(project.id);
      get().activateThreadRuntime(thread.id);
      // M-perf: fire-and-forget — a failed disk write must not roll back an
      // already-applied UI switch (the next persist or the quit flush retries).
      get().persistProductState({ silent: true }).catch(() => {});
      if (!isProjectNavigationCurrent(navigation)) return false;
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
      // M2：面板绑定被删线程时关闭（幂等）
      if (get().workflowFloatingPanel?.payload?.threadId === threadId) get().closeWorkflowPanel?.();
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
      // Close any previous-thread workflow shell so a blank session never inherits
      // "completed / running" chrome or a blue topbar highlight.
      try {
        get().closeWorkflowPanel?.();
      } catch (_) {}
      set((state) => ({
        threadsById: { ...state.threadsById, [thread.id]: thread },
        threadOrderByProject: {
          ...state.threadOrderByProject,
          // 新会话插入到最前面，便于用户立刻看到并继续工作
          [projectId]: [thread.id, ...(state.threadOrderByProject[projectId] || [])],
        },
        activeThreadId: thread.id,
        workflowFloatingPanel: null,
        workflowPanelDismissed: null,
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
    // 先 flush 再读 runtime：否则 coalesce 折叠会把这里的 resolved 标记整个覆盖掉。
    get().flushThreadTimelineCoalesce?.(threadId);
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

  async respondToInterruption(interruptionId, decision = 'allow', toolCallId = null, boundThreadId = null) {
    const state = get();
    const threadId = boundThreadId || state.activeThreadId;
    const thread = state.threadsById[threadId];
    const runtimeHint = state.threadRuntimeById[threadId] || emptyThreadRuntime();
    const projectId = thread?.projectId || (threadId === state.activeThreadId ? state.activeProjectId : null);
    const sessionId =
      thread?.sessionId ||
      runtimeHint.sessionId ||
      (threadId === state.activeThreadId ? state.sessionId : null);
    if (!projectId || !threadId || !sessionId || !interruptionId) return false;
    set({ error: null });
    return runUniqueSessionAction(threadId + ':interruption:' + interruptionId, async () => {
      const thread = get().threadsById[threadId];
      const liveSession =
        thread?.sessionId || (get().threadRuntimeById[threadId] || emptyThreadRuntime()).sessionId;
      if (!thread || thread.projectId !== projectId || liveSession !== sessionId) return false;
      const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      // 放宽前置：status_change 竞态可能把线程改成 idle 但 permissionRequests 仍有匹配项。
      // 只要存在匹配的待处理项且有 client，就允许响应，避免权限卡片死锁。
      const hasMatchingPending = runtime.permissionRequests.some((item) =>
        sessionActionItemMatches(item, interruptionId),
      );
      if (!['running', 'waiting'].includes(thread.status) && !hasMatchingPending) return false;
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
      try {
        get().getThreadClient(threadId)?.resumeActivePromptIdle?.(sessionId);
      } catch (_) {}
      await get().persistProductState();
      return true;
    });
  },

  applyQuestionResolution(threadId, toolCallId, status, answers = null) {
    // 先 flush 再读 runtime：否则 coalesce 折叠会把这里的 answered 标记整个覆盖掉。
    get().flushThreadTimelineCoalesce?.(threadId);
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
        try {
          get().getThreadClient(threadId)?.resumeActivePromptIdle?.(sessionId);
        } catch (_) {}
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
      const preflightOnly =
        hadPlannedRun &&
        !currentRuntime.promptDispatched &&
        !hadActiveRequest &&
        !currentRuntime.isAwaitingResponse &&
        currentThread.status === 'running';
      const backendMayBeRunning =
        !preflightOnly &&
        (currentRuntime.promptDispatched || hadActiveRequest || responseBusy || currentRuntime.isAwaitingResponse);

      // The local stop path must never wait for disk persistence or the remote
      // session/cancel acknowledgement. Close the renderer stream first, then
      // publish the terminal state synchronously so the Stop button disappears.
      client.cancelActivePrompt?.(sessionId);
      client.invalidateInteractiveRequests?.('session-cancelled');
      get().flushThreadTimelineCoalesce?.(threadId);
      const latestRuntime = get().threadRuntimeById[threadId] || currentRuntime;
      const cancelledTimeline = cancelPendingTimelineActions(closeAssistantStream(latestRuntime.timeline));
      const timeline = reduceAcpEvent(
        cancelledTimeline,
        'status_change',
        { status: 'cancelled', role: 'system' },
        threadId,
      );
      get().patchThreadRuntime(
        threadId,
        responseTerminalRuntimePatch({
          lastPromptRunId: currentRuntime.activePromptRunId || null,
          lastPromptRunAt: currentRuntime.activePromptRunId ? Date.now() : 0,
          lastWorkflowState: currentRuntime.workflowState || currentRuntime.lastWorkflowState || null,
          lastGoalState: currentRuntime.goalState || currentRuntime.lastGoalState || null,
          lastSubagentReports: collectSubagentReports({
            timeline,
            teamState: currentRuntime.teamState,
            lastTeamState: currentRuntime.lastTeamState,
            memberHistoriesByName: currentRuntime.memberHistoriesByName,
            subagentToolCalls: currentRuntime.subagentToolCalls,
          }),
          permissionRequests: [],
          questions: [],
          promptQueue: [],
          timeline,
        }),
      );
      void get().persistThreadPromptQueue(threadId, []).catch(() => {});
      set((state) => ({
        threadsById: {
          ...state.threadsById,
          [threadId]: {
            ...state.threadsById[threadId],
            status: 'cancelled',
            timeline: timeline.slice(-300),
            updatedAt: new Date().toISOString(),
            metadata: {
              ...(state.threadsById[threadId]?.metadata || {}),
              lastError: null,
              cancelWarning: null,
            },
          },
        },
        ...(state.activeThreadId === threadId ? { error: null } : {}),
      }));

      // Persistence is important, but it is not part of the user-visible stop
      // critical path. `silent` prevents a slow/failed save from creating a red
      // error banner immediately after a successful cancellation.
      void get().persistProductState({ silent: true }).catch(() => {});
      get().flushPendingUsageRefresh(threadId);

      if (backendMayBeRunning && client.notify && client.sessionCancelSupported !== false) {
        let cancelPromise;
        try {
          // Invoke immediately so the backend receives the cancellation even
          // though the local action returns without awaiting its response.
          cancelPromise = client.notify('session/cancel', { sessionId });
        } catch (error) {
          cancelPromise = Promise.reject(error);
        }
        Promise.resolve(cancelPromise)
          .then(() => {
            client.sessionCancelSupported = true;
          })
          .catch((error) => {
            if (isMethodNotFoundError(error)) {
              client.sessionCancelSupported = false;
              return;
            }
            const backendCancelWarning = `后端取消确认失败，已关闭本地请求流: ${error?.message || '未知错误'}`;
            const latest = get().threadsById[threadId];
            if (!latest || latest.sessionId !== sessionId || latest.status !== 'cancelled') return;
            set((state) => ({
              threadsById: {
                ...state.threadsById,
                [threadId]: {
                  ...state.threadsById[threadId],
                  metadata: {
                    ...(state.threadsById[threadId]?.metadata || {}),
                    cancelWarning: backendCancelWarning,
                  },
                },
              },
            }));
            void get().persistProductState({ silent: true }).catch(() => {});
          });
      }

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
      // G3: busySendMode=immediate（WebUI Hk）——非斜杠命令直接注入当前回合；
      // steer 被 CLI 拒绝或失败时回退到原有排队路径。
      const busyMode = busySendModeFromSettings(get().settings);
      if (!shouldQueueBusyPrompt(busyMode, content) && runtime.promptQueue.length === 0) {
        const steerResult = await get().steerPromptIntoCurrentTurn(threadId, content, attachments);
        if (steerResult.steered) {
          get().patchThreadRuntime(threadId, { pendingAttachments: [], promptSuggestion: null });
          await get().updateThreadRecord(threadId, { draft: '' });
          return { steered: true };
        }
      }
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
    get().patchThreadRuntime(threadId, { pendingAttachments: [], promptSuggestion: null, subagentReports: [] });
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
    // 折叠先落地：隐藏窗口下 coalesce 缓冲里的 chunk 不 base 在 stale runtime 上，
    // 否则 patchThreadRuntime 的折叠会用原始缓冲覆盖掉刚 push 的用户消息气泡。
    get().flushThreadTimelineCoalesce?.(threadId);
    const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
    const requestSessionId =
      thread.sessionId || runtime.sessionId || (get().activeThreadId === threadId ? get().sessionId : null);
    if (!requestSessionId) {
      set({ error: '当前会话尚未完成连接' });
      return false;
    }
    const project = get().projectsById[thread.projectId];
    const promptStartedAt = Date.now();
    workflowProgressMonitors.delete(threadId);
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
    const goalPrompt = isGoalPrompt(content);
    const nextGoalState = goalPrompt
      ? seedGoalStateFromPrompt(content, activePromptRunId)
      : { ...emptyGoalState(), mode: null };
    get().patchThreadRuntime(threadId, {
      timeline,
      isAwaitingResponse: true,
      promptStartedAt,
      activePromptRunId,
      backgroundDrainRunId: null,
      backgroundDrainUntil: 0,
      backgroundDrainMaxUntil: 0,
      promptDispatched: false,
      promptDispatchInFlight: false,
      teamState: null,
      lastTeamState: null,
      memberHistoriesByName: {},
      subagentToolCalls: {},
      workflowState: null,
      lastWorkflowState: null,
      goalState: nextGoalState,
      lastGoalState: null,
      rawExtensionEvents: [],
    });
    // `/goal` should surface the right panel immediately (optimistic seed), not only
    // after the first CLI goal-progress event — otherwise the turn looks dead.
    if (goalPrompt && get().activeThreadId === threadId) {
      const dismissed = get().workflowPanelDismissed;
      const suppressed =
        dismissed &&
        (Number.isFinite(dismissed.at)
          ? Date.now() - dismissed.at < DISMISS_WINDOW_MS || dismissed.runId === activePromptRunId
          : dismissed.runId === activePromptRunId);
      if (!suppressed) {
        get().openWorkflowPanel({ projectId: get().activeProjectId || null, threadId, runId: activePromptRunId });
      }
    }
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

    // Stop can finish locally while the initial persistence is still in flight.
    // That persistence may have written `running` after cancellation; restore the
    // terminal state before returning so the stale send cannot leave the UI stuck.
    if (!runIsCurrent()) {
      const latestThread = get().threadsById[threadId];
      const latestRuntime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      if (latestThread?.status === 'running' && latestRuntime.activePromptRunId !== activePromptRunId) {
        set((state) => ({
          threadsById: {
            ...state.threadsById,
            [threadId]: {
              ...state.threadsById[threadId],
              status: 'cancelled',
              updatedAt: new Date().toISOString(),
            },
          },
        }));
        void get().persistProductState({ silent: true }).catch(() => {});
      }
      return { ok: false, reason: 'cancelled' };
    }

    const hasFinalResponse = () =>
      hasCompletePromptResponse(get().threadRuntimeById[threadId]?.timeline, promptEntryId, promptStartedAt);
    const hasUsableBody = () =>
      hasUsableAssistantBody(get().threadRuntimeById[threadId]?.timeline, promptEntryId, promptStartedAt);
    const hasUsableGoal = () => {
      const latest = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      return hasUsableGoalTurn(latest.timeline, promptEntryId, promptStartedAt, latest.goalState || latest.lastGoalState);
    };
    const hasUsableOrchestration = () => {
      const latest = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      const hasTeam = Boolean(latest.teamState?.members?.length || latest.lastTeamState?.members?.length);
      const hasGoal = hasUsableGoal();
      if (!hasTeam && !hasGoal) return false;
      return hasUsableMemberConclusions(latest.memberHistoriesByName);
    };
    const recoverPromptHistory = async () => {
      if (!runIsCurrent()) return false;
      // 传输失败后连接可能已被 markConnectionBroken 置为断开：先恢复传输 + 协议，
      // 再 session/load 拉历史。恢复失败直接返回 false（走草稿恢复 + 错误卡）。
      // 仅显式 connected===false 才触发恢复（mock/未定义状态不误判）。
      if (client.connected === false || client.initialized === false) {
        const restored = await client
          .reconnect?.({
            sessionId: requestSessionId,
            cwd: project?.workspacePath || '.',
          })
          .catch(() => false);
        // reconnect 成功需协议已恢复；sessionBound 可随后由 session/load 补齐。
        if (!restored || client.connected === false || client.initialized === false) return false;
      }
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
          { promptRunId: activePromptRunId, historyReplay: true, mode: 'history-replay' },
        );
      } finally {
        const latestRuntime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
        if (latestRuntime.activePromptRunId === activePromptRunId) {
          get().patchThreadRuntime(threadId, { historyReplayActive: false });
        }
      }
      // History may only restore the pre-tool narrative; treat that as recovered too.
      // Goal-only turns recover when goal projection / timeline events are present.
      return hasFinalResponse() || hasUsableBody() || hasUsableGoal();
    };
    try {
      if (!runIsCurrent() || ['cancelled', 'cancelling'].includes(get().threadsById[threadId]?.status)) {
        return { ok: false, reason: 'cancelled' };
      }
      const prompt = buildPromptContentBlocks(content, attachments);
      get().patchThreadRuntime(threadId, { promptDispatched: true });
      get().startWorkflowProgressMonitor?.({
        threadId,
        projectId: thread.projectId,
        sessionId: requestSessionId,
        startedAfter: promptStartedAt,
      });
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
        if (!runIsCurrent()) return { ok: false, reason: 'cancelled' };
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
      if (!runIsCurrent()) return { ok: false, reason: 'cancelled' };

      if (result?.stopReason === 'cancelled') {
        get().flushThreadTimelineCoalesce?.(threadId);
        const cancelledRuntime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
        const cancelledTimeline = cancelPendingTimelineActions(closeAssistantStream(cancelledRuntime.timeline));
        const cancelledReports = collectSubagentReports({
          timeline: cancelledTimeline,
          teamState: cancelledRuntime.teamState,
          lastTeamState: cancelledRuntime.lastTeamState,
          memberHistoriesByName: cancelledRuntime.memberHistoriesByName,
          subagentToolCalls: cancelledRuntime.subagentToolCalls,
        });
        get().patchThreadRuntime(
          threadId,
          responseTerminalRuntimePatch({
            timeline: cancelledTimeline,
            lastWorkflowState: cancelledRuntime.workflowState || cancelledRuntime.lastWorkflowState || null,
            lastGoalState: cancelledRuntime.goalState || cancelledRuntime.lastGoalState || null,
            lastSubagentReports: cancelledReports,
          }),
        );
        await get().updateThreadRecord(threadId, {
          status: 'cancelled',
          timeline: cancelledTimeline.slice(-300),
        });
        return { ok: false, reason: 'cancelled' };
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
          const truncatedTimeline = cancelPendingTimelineActions(closeAssistantStream([
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
          ]));
          get().patchThreadRuntime(
            threadId,
            responseTerminalRuntimePatch({
              timeline: truncatedTimeline,
              lastWorkflowState: truncatedRuntime.workflowState || truncatedRuntime.lastWorkflowState || null,
              lastGoalState: truncatedRuntime.goalState || truncatedRuntime.lastGoalState || null,
            }),
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
        !hasUsableGoal() &&
        !hasUsableOrchestration() &&
        Date.now() < graceDeadline
      ) {
        await waitForMilliseconds(25);
      }

      // Prefer a post-tool final answer. If only pre-tool narrative is present, skip history
      // reload (user already sees the body). Reload only when the turn has no usable text.
      // `/goal` / team turns may finish with goal metadata or member conclusions only.
      if (runIsCurrent() && !hasFinalResponse() && !hasUsableBody() && !hasUsableGoal() && !hasUsableOrchestration()) {
        await recoverPromptHistory();
      }
      if (!runIsCurrent()) return { ok: false, reason: 'cancelled' };
      if (!hasFinalResponse() && !hasUsableBody() && !hasUsableGoal() && !hasUsableOrchestration()) {
        const incompleteError = new Error('回复已结束，但最终正文未送达；自动历史恢复也未找到完整回答。');
        incompleteError.promptAccepted = true;
        throw incompleteError;
      }

      get().flushThreadTimelineCoalesce?.(threadId);
      // H3: re-check current-ness right before the terminal patch; a cancel that
      // arrived after the runIsCurrent() guard at line 2061 must not be overwritten
      // with `idle`/`success`.
      if (!runIsCurrent()) return { ok: false, reason: 'cancelled' };
      const completedRuntime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      // G7: 回合成功终态补 turn-metrics（CLI showTurnDuration，默认开）。
      const completedTimeline = showTurnDurationFromSettings(get().settings)
        ? appendTurnMetrics(
            cancelPendingTimelineActions(closeAssistantStream(completedRuntime.timeline)),
            promptStartedAt,
          )
        : cancelPendingTimelineActions(closeAssistantStream(completedRuntime.timeline));
      const completedReports = collectSubagentReports({
        timeline: completedTimeline,
        teamState: completedRuntime.teamState,
        lastTeamState: completedRuntime.lastTeamState,
        memberHistoriesByName: completedRuntime.memberHistoriesByName,
        subagentToolCalls: completedRuntime.subagentToolCalls,
      });
      get().patchThreadRuntime(
        threadId,
        responseTerminalRuntimePatch({
          lastWorkflowState: completedRuntime.workflowState || completedRuntime.lastWorkflowState || null,
          lastGoalState: completedRuntime.goalState || completedRuntime.lastGoalState || null,
          lastSubagentReports: completedReports,
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
      get().flushPendingUsageRefresh(threadId);
      // turn 终态：若重连后会话未绑定，补一次 session/load rebind（不阻塞，失败保留标记）。
      void get().rebindSessionAfterTurn(threadId).catch(() => {});
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
          const cancelledReports = collectSubagentReports({
            timeline: flushedFailed.timeline,
            teamState: flushedFailed.teamState,
            lastTeamState: flushedFailed.lastTeamState,
            memberHistoriesByName: flushedFailed.memberHistoriesByName,
            subagentToolCalls: flushedFailed.subagentToolCalls,
          });
          get().patchThreadRuntime(
            threadId,
            responseTerminalRuntimePatch({
              timeline: cancelPendingTimelineActions(closeAssistantStream(flushedFailed.timeline)),
              lastSubagentReports: cancelledReports,
            }),
          );
        }
        return { ok: false, reason: 'cancelled' };
      }
      if (!runIsCurrent()) return { ok: false, reason: 'cancelled' };

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
      const failedTimeline = cancelPendingTimelineActions(closeAssistantStream(
        reduceAcpEvent(flushedFailedRuntime.timeline, 'error', { message: error.message, type: 'error' }, threadId),
      ));
      const failedReports = collectSubagentReports({
        timeline: failedTimeline,
        teamState: flushedFailedRuntime.teamState,
        lastTeamState: flushedFailedRuntime.lastTeamState,
        memberHistoriesByName: flushedFailedRuntime.memberHistoriesByName,
        subagentToolCalls: flushedFailedRuntime.subagentToolCalls,
      });
      get().patchThreadRuntime(
        threadId,
        responseTerminalRuntimePatch({
          timeline: failedTimeline,
          lastSubagentReports: failedReports,
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
      get().flushPendingUsageRefresh(threadId);
      // turn 终态（失败）：同样补一次会话 rebind（不阻塞，失败保留标记）。
      void get().rebindSessionAfterTurn(threadId).catch(() => {});
      return false;
    }
  },
  // turn 终态后的 delayed rebind：重连成功但会话未绑定（sessionRestoreNeeded）时，
  // 在 active turn 结束后执行 session/load 确认会话并 emit session_restored。
  // 事件在终态后被 handleConversationEvent 666-675 行门控丢弃，不会污染 timeline。
  async rebindSessionAfterTurn(threadId) {
    const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
    const thread = get().threadsById[threadId];
    const sessionId = thread?.sessionId || runtime.sessionId;
    if (!runtime.sessionRestoreNeeded || runtime.activePromptRunId || !sessionId) return false;
    const client = get().getThreadClient(threadId);
    const project = thread ? get().projectsById[thread.projectId] : null;
    if (!client || typeof client.request !== 'function') return false;
    try {
      // 不带 promptRunId 的 session/load：历史重放事件在终态后会被丢弃，
      // 仅用 RPC result 确认会话存在并绑定。
      await client.request(
        'session/load',
        { sessionId, cwd: project?.workspacePath || '.', mcpServers: [] },
        { mode: 'rebind' },
      );
      if (typeof client.markSessionBound === 'function') {
        client.markSessionBound(sessionId, project?.workspacePath || '.');
      } else {
        get().patchThreadRuntime(threadId, { sessionRestoreNeeded: false });
      }
      return true;
    } catch (error) {
      const message = String(error?.message || error || '');
      const sessionInvalid =
        error?.sessionInvalid === true ||
        /session not found|invalid session|unknown session|no such session|session.*expired/i.test(message);
      if (sessionInvalid) {
        // 明确会话失效：停止重试 restore，给用户可见错误。
        get().patchThreadRuntime(threadId, { sessionRestoreNeeded: false });
        await get().updateThreadRecord(threadId, {
          metadata: {
            ...(get().threadsById[threadId]?.metadata || {}),
            lastError: '会话已失效（服务端重启或连接重建），请新建会话继续',
            sessionInvalid: true,
          },
        });
        if (get().activeThreadId === threadId) {
          set({ error: '会话已失效（服务端重启或连接重建），请新建会话继续' });
        }
        return false;
      }
      // 传输类失败：保留标记，下次操作再试；不阻塞当前 turn。
      return false;
    }
  },

  // 压缩完成后刷新上下文用量：轻量 session/load（不带 promptRunId）让 CLI
  // 重新推送 usage_update。重放的历史 chunk 会被终态门控丢弃，仅用量事件
  // 生效；失败静默，后续自然推送的 usage_update 仍会刷新。
  async refreshUsageAfterCompact(threadId) {
    const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
    const thread = get().threadsById[threadId];
    const sessionId = thread?.sessionId || runtime.sessionId;
    if (!sessionId) return false;
    if (
      runtime.activePromptRunId ||
      runtime.isAwaitingResponse ||
      runtime.promptDispatchInFlight
    ) {
      get().patchThreadRuntime(threadId, { usageRefreshPending: true });
      return false;
    }
    if (runtime.usageRefreshPending) {
      get().patchThreadRuntime(threadId, { usageRefreshPending: false });
    }
    const client = get().getThreadClient(threadId);
    const project = thread ? get().projectsById?.[thread.projectId] : null;
    if (!client || typeof client.request !== 'function') return false;
    try {
      await client.request(
        'session/load',
        { sessionId, cwd: project?.workspacePath || '.', mcpServers: [] },
        { mode: 'usage-refresh' },
      );
      return true;
    } catch (_) {
      return false;
    }
  },

  flushPendingUsageRefresh(threadId) {
    const runtime = get().threadRuntimeById[threadId];
    if (!runtime?.usageRefreshPending) return false;
    void get().refreshUsageAfterCompact(threadId).catch(() => {});
    return true;
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

  // G3: WebUI session/steer — 忙碌时把消息注入当前回合而非排队。
  // 只有存在活跃 prompt run 时才尝试；CLI 拒绝（steered!==true）由调用方回退排队。
  async steerPromptIntoCurrentTurn(threadId, content, attachments = []) {
    const thread = get().threadsById[threadId];
    const client = get().getThreadClient(threadId);
    if (!thread || !client) return { steered: false, reason: 'no-client' };
    const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
    const sessionId =
      thread.sessionId || runtime.sessionId || (get().activeThreadId === threadId ? get().sessionId : null);
    const liveTurn =
      Boolean(runtime.activePromptRunId) &&
      (Boolean(runtime.isAwaitingResponse) || Boolean(sessionId && client.hasActivePrompt?.(sessionId)));
    if (!sessionId || !liveTurn) return { steered: false, reason: 'no-live-turn' };
    let result;
    try {
      result = await client.request('session/steer', {
        sessionId,
        contentBlocks: buildPromptContentBlocks(content, attachments),
      });
    } catch (error) {
      return { steered: false, reason: error?.message || 'steer-failed' };
    }
    if (result?.steered !== true) return { steered: false, reason: result?.reason || 'rejected' };
    // 展示与 WebUI addQueuedUserMessage 一致：注入的消息以用户气泡追加到当前时间线。
    get().flushThreadTimelineCoalesce?.(threadId);
    const latest = get().threadRuntimeById[threadId] || emptyThreadRuntime();
    const timelineAttachments = (attachments || []).map((attachment) => ({
      name: attachment.name || attachment.path,
      path: attachment.path || null,
      kind: attachment.kind === 'image' ? 'image' : 'text',
      mimeType: attachment.mimeType || null,
      data: attachment.data || null,
    }));
    const timeline = pushUserMessage(latest.timeline, content, Date.now(), timelineAttachments);
    get().patchThreadRuntime(threadId, { timeline });
    await get().updateThreadRecord(threadId, { timeline: timeline.slice(-300) });
    return { steered: true };
  },

  // G3: 队列条目「立即发送」。有活跃回合 → steer 注入并移出队列；
  // 空闲（no-live-turn）→ 提到队首并触发正常派发。
  async sendQueuedPromptNow(threadId, promptId) {
    if (!threadId || !promptId) return { steered: false, reason: 'invalid' };
    return queuePromptQueueOperation(threadId, async () => {
      const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      const item = runtime.promptQueue.find((entry) => entry.id === promptId);
      if (!item) return { steered: false, reason: 'not-found' };
      const steerResult = await get().steerPromptIntoCurrentTurn(threadId, item.text, item.attachments || []);
      if (steerResult.steered) {
        const latestRuntime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
        const promptQueue = latestRuntime.promptQueue.filter((entry) => entry.id !== promptId);
        get().patchThreadRuntime(threadId, { promptQueue });
        await get().persistThreadPromptQueue(threadId, promptQueue);
        return { steered: true };
      }
      if (steerResult.reason === 'no-live-turn') {
        const promptQueue = [item, ...runtime.promptQueue.filter((entry) => entry.id !== promptId)];
        get().patchThreadRuntime(threadId, { promptQueue });
        await get().persistThreadPromptQueue(threadId, promptQueue);
        setTimeout(() => get().drainThreadPromptQueue(threadId), 0);
        return { steered: false, queued: true, reason: 'no-live-turn' };
      }
      return steerResult;
    });
  },

  // ===== G2: Goal Bar（WebUI /api/v1/goal REST 对齐）=====
  // 快照 → runtime.goalBar；pause 先本地乐观置暂停并取消当前回合（与 WebUI Je 一致）。

  async refreshGoalBar(threadId) {
    const thread = get().threadsById[threadId];
    const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
    const sessionId =
      thread?.sessionId || runtime.sessionId || (get().activeThreadId === threadId ? get().sessionId : null);
    if (!sessionId) return null;
    try {
      const goalBar = activeGoalFromSnapshot(await fetchGoalSnapshot(sessionId));
      if (get().threadsById[threadId]) get().patchThreadRuntime(threadId, { goalBar });
      return goalBar;
    } catch {
      return null;
    }
  },

  async pauseGoalBar(threadId) {
    const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
    const previous = runtime.goalBar;
    if (!previous) return false;
    const thread = get().threadsById[threadId];
    const sessionId =
      thread?.sessionId || runtime.sessionId || (get().activeThreadId === threadId ? get().sessionId : null);
    if (!sessionId) return false;
    get().patchThreadRuntime(threadId, { goalBar: { ...previous, paused: true, pausedAt: Date.now() } });
    if (get().activeThreadId === threadId && (runtime.activePromptRunId || runtime.isAwaitingResponse)) {
      void get().cancelSession().catch(() => {});
    }
    try {
      const goalBar = activeGoalFromSnapshot(await pauseGoal(sessionId));
      if (get().threadsById[threadId] && goalBar) get().patchThreadRuntime(threadId, { goalBar });
      return true;
    } catch {
      if (get().threadsById[threadId]) get().patchThreadRuntime(threadId, { goalBar: previous });
      return false;
    }
  },

  async resumeGoalBar(threadId) {
    const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
    const previous = runtime.goalBar;
    if (!previous) return false;
    const thread = get().threadsById[threadId];
    const sessionId =
      thread?.sessionId || runtime.sessionId || (get().activeThreadId === threadId ? get().sessionId : null);
    if (!sessionId) return false;
    // WebUI ft：恢复时计时从暂停位置继续（createdAt 前移暂停时长）。
    const pausedSpan = typeof previous.pausedAt === 'number' ? Math.max(0, previous.pausedAt - previous.createdAt) : 0;
    const optimistic = { condition: previous.condition, createdAt: Date.now() - pausedSpan, paused: false };
    get().patchThreadRuntime(threadId, { goalBar: optimistic });
    try {
      const goalBar = activeGoalFromSnapshot(await resumeGoal(sessionId));
      if (get().threadsById[threadId] && goalBar) get().patchThreadRuntime(threadId, { goalBar });
      return true;
    } catch {
      // WebUI 回退路径：REST 失败时重新以 /goal <条件> 设定目标。
      const sent = await get()
        .sendPrompt(`/goal ${previous.condition}`)
        .catch(() => false);
      if (!sent && get().threadsById[threadId]) get().patchThreadRuntime(threadId, { goalBar: previous });
      return Boolean(sent);
    }
  },

  async clearGoalBar(threadId) {
    const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
    const previous = runtime.goalBar;
    const thread = get().threadsById[threadId];
    const sessionId =
      thread?.sessionId || runtime.sessionId || (get().activeThreadId === threadId ? get().sessionId : null);
    if (!sessionId) return false;
    get().patchThreadRuntime(threadId, { goalBar: null, goalRecap: null });
    try {
      await clearGoal(sessionId);
      return true;
    } catch {
      // WebUI Ye 回退：REST 失败时走 /goal clear 斜杠命令。
      const sent = await get()
        .sendPrompt('/goal clear')
        .catch(() => false);
      if (!sent && previous && get().threadsById[threadId]) get().patchThreadRuntime(threadId, { goalBar: previous });
      return Boolean(sent);
    }
  },

  /** 编辑目标：发送 `/goal <条件>`（走正常 prompt/队列语义）。 */
  async saveGoalEdit(threadId, condition) {
    const trimmed = String(condition || '').trim();
    if (!trimmed) return false;
    return get().sendPrompt(`/goal ${trimmed}`);
  },

  dismissGoalRecap(threadId) {
    if (!get().threadsById[threadId]) return;
    get().patchThreadRuntime(threadId, { goalRecap: null });
  },

  // ===== G9: 会话历史浏览器 =====

  setSessionHistoryOpen(open) {
    set({ sessionHistoryOpen: Boolean(open) });
  },

  /**
   * 把一段 CLI 历史会话恢复为当前项目的新线程（session/load 回放历史）。
   * 已有绑定同 sessionId 的线程时直接切换过去，避免重复线程。
   */
  async restoreHistorySession(sessionId, label = '') {
    const normalized = String(sessionId || '').trim();
    if (!normalized) return false;
    const projectId = get().activeProjectId;
    if (!projectId) return false;
    const existing = (get().threadOrderByProject[projectId] || [])
      .map((id) => get().threadsById[id])
      .find((thread) => thread?.sessionId === normalized && !thread?.archivedAt);
    if (existing) {
      return get().activateThread(existing.id);
    }
    if (get().newSessionBusy || get().projectNavigationBusy) return false;
    const previousThreadId = get().activeThreadId;
    set({ newSessionBusy: true, newSessionProjectId: projectId, newSessionError: null, error: null });
    try {
      const thread = createThreadRecord(projectId, {
        sessionId: normalized,
        title: String(label || '').trim() || '历史会话',
      });
      try {
        get().closeWorkflowPanel?.();
      } catch (_) {}
      set((state) => ({
        threadsById: { ...state.threadsById, [thread.id]: thread },
        threadOrderByProject: {
          ...state.threadOrderByProject,
          [projectId]: [thread.id, ...(state.threadOrderByProject[projectId] || [])],
        },
        activeThreadId: thread.id,
        workflowFloatingPanel: null,
        workflowPanelDismissed: null,
      }));
      const persisted = await get().persistProductState();
      if (!persisted) {
        set((state) => {
          const threadsById = { ...state.threadsById };
          delete threadsById[thread.id];
          return {
            threadsById,
            threadOrderByProject: {
              ...state.threadOrderByProject,
              [projectId]: (state.threadOrderByProject[projectId] || []).filter((id) => id !== thread.id),
            },
            activeThreadId: state.activeThreadId === thread.id ? previousThreadId : state.activeThreadId,
          };
        });
        return false;
      }
      if (get().activeProjectId !== projectId || get().activeThreadId !== thread.id) return true;
      return await get().initializeActiveThread(normalized);
    } catch (error) {
      set({ newSessionError: error?.message || '恢复历史会话失败' });
      return false;
    } finally {
      set({ newSessionBusy: false });
    }
  },

  // ===== 鉴权 action（对照源 viewState/login/logout）=====
  };
}
