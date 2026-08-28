import { create } from 'zustand';
import {
  getApiBase,
  setApiBase,
  fetchJson,
  requestCodeBuddy,
  getAcpSessionToken,
  getAuthToken,
  setAcpSessionToken,
  checkAuth as apiCheckAuth,
  authLogin as apiAuthLogin,
  authLogout as apiAuthLogout,
  setAuthToken,
} from './lib/acp';
import { parseHashRoute, setHashRoute } from './lib/routes';
import { createGitWorkspaceRegistrar } from './lib/git-workspace-registry';
import {
  fsList,
  fsSearchContent,
  fsSearchFiles,
  createWatcher,
  pollWatcher,
  removeWatcher,
  downloadFile,
  fsMkdir,
  fsMove,
  fsRemove,
  fsWrite,
} from './lib/fs';
import {
  fetchSessionStats,
  fetchStats as fetchStatsApi,
  fetchScheduledTasks,
  createScheduledTask,
  deleteScheduledTask,
  fetchTraceList,
  fetchWorkerLogs as fetchWorkerLogsApi,
  updateSettingByKey as updateSettingByKeyApi,
  fetchTaskTemplates as apiFetchTaskTemplates,
  refreshTaskTemplates as apiRefreshTaskTemplates,
  uninstallPlugin as apiUninstallPlugin,
  enablePlugin as apiEnablePlugin,
  disablePlugin as apiDisablePlugin,
  installPlugin as apiInstallPlugin,
  addMarketplace as apiAddMarketplace,
  removeMarketplace as apiRemoveMarketplace,
  fetchMarketplaces as apiFetchMarketplaces,
  setMarketplaceAutoUpdate as apiSetMarketplaceAutoUpdate,
  updatePluginHttp as apiUpdatePluginHttp,
  updateMarketplace as apiUpdateMarketplace,
} from './lib/ops';
import { normalizePluginRecord, qualifyPluginId } from './lib/plugins-list';
import {
  normalizeWorkspaceDirList,
  normalizeWorkspaceDirPath,
  addWorkspaceDir as apiAddWorkspaceDir,
  removeWorkspaceDir as apiRemoveWorkspaceDir,
  syncWorkspaceDirs as apiSyncWorkspaceDirs,
} from './lib/workspace-dirs';
import { updateInstalledPlugin as cliUpdateInstalledPlugin } from './lib/plugin-maintenance';
import { closeAssistantStream } from './lib/timeline';
import {
  activeProject,
  createThreadRecord,
  emptyProductState,
} from './lib/product-state';
import { ConversationManager } from './lib/conversation-manager';
import { mergeCodeBuddyTeamState } from './lib/acp-workflow-events';
import {
  isGuiSettingKey,
  loadGuiSettings,
  saveGuiSettings,
  SETTINGS_CACHE_KEY,
  stripGuiSettings,
} from './lib/gui-settings';
import {
  accountLoginSiteFromAuthMethodId,
  classifyPromptRefusal,
  formatCustomModelAuthFailureMessage,
  formatNetworkOrProxyFailureMessage,
  isCloudAuthFailureMessage,
  isNetworkOrProxyFailureMessage,
  normalizeAccountLoginSite,
  normalizeLastAccountUser,
  pickAuthMethodId,
} from './lib/account-auth';
import { runtimeAuthScopeChanged } from './store/helpers/runtime-auth';
import {
  ACTIVE_THREAD_RUNTIME_KEYS,
  emptyThreadRuntime,
  resolveThreadTimeline,
} from './store/helpers/thread-runtime';
import { createQueueHelpers } from './store/helpers/queues';
import {
  makePane,
  terminalStateFromProject,
  terminalStateSnapshot,
  workspaceStateFromProject,
  workspaceStateSnapshot,
} from './store/helpers/terminal-workspace-state';
import { createProductPersistSlice } from './store/slices/product-persist';
import { createProjectsRuntimeSlice } from './store/slices/projects-runtime';
import { createSessionsChatSlice } from './store/slices/sessions-chat';

export {
  hasCompletePromptResponse,
  hasUsableAssistantBody,
  hasUsableGoalTurn,
} from './store/helpers/prompt-completion';
export { runtimeAuthScopeChanged } from './store/helpers/runtime-auth';
export {
  formatCodeBuddyAccountLabel,
  accountFooterPresentation,
  normalizeAccountLoginSite,
  pickAuthMethodId,
  preferredAuthMethodIdsForSite,
  classifyPromptRefusal,
  formatCustomModelAuthFailureMessage,
  formatNetworkOrProxyFailureMessage,
  isCloudAuthFailureMessage,
  isCustomModelAuthFailureMessage,
  isNetworkOrProxyFailureMessage,
  unwrapPromptErrorPayload,
} from './lib/account-auth';

const conversations = new ConversationManager();
let bootstrapOperation = null;
let routeListenerBound = false;
let conversationEventsBound = false;
let runtimeListenerBound = false;
let authFailureListenerBound = false;
const threadTimelinePersistTimers = new Map();
/** Pending coalesced stream chunks per thread (timer + reduced timeline). */
const threadTimelineCoalesce = new Map();
const threadDraftPersistTimers = new Map();
const terminalStatePersistTimers = new Map();
// M-perf: fixed-cadence anchor for terminal state persistence. scheduleTerminalStatePersist
// pins the timer to lastPersistAt + WINDOW instead of restarting a full window per chunk,
// so a steady output stream (npm install, log spam) cannot starve persistence forever.
const lastTerminalStatePersistAt = new Map();
const workspaceStatePersistTimers = new Map();
// M-perf: pending terminal output chunks are merged on a 50ms window so
// high-frequency output (npm install, log spam) rebuilds terminalPanes once per
// window instead of once per chunk. xterm rendering stays per-chunk (live); only
// the store mirror + persistence are throttled.
const TERMINAL_OUTPUT_FLUSH_MS = 50;
const TERMINAL_STATE_PERSIST_MS = 5000;
const paneOutputPending = new Map();
let paneOutputFlushTimer = null;
let fileDirectoryRequestId = 0;
let filePreviewRequestId = 0;
let fileSearchRequestId = 0;
let fileNameSearchRequestId = 0;
let fileSaveRequestId = 0;
let fileDiskSyncRequestId = 0;
let fileWatcherRequestId = 0;
let projectNavigationVersion = 0;
let authRequestVersion = 0;
let productStateSaveChain = Promise.resolve(true);
const scopedRequestVersions = new Map();
const settingWriteVersions = new Map();
const settingWriteChains = new Map();
const confirmedSettingValues = new Map();
/** WebUI A.current — user-scope settings snapshot for nested PUT merge. */
const userSettingsBaselineByProject = new Map();
const runtimeOperationChains = new Map();
const sessionSettingChains = new Map();
const threadMutationChains = new Map();
const sessionActionOperations = new Map();
const promptQueueOperationChains = new Map();
let dirtyFileConfirmationResolve = null;
const DELETED_SESSION_HISTORY_LIMIT = 200;
// Cap the live runtime.timeline to the same length persisted to disk (300
// entries). Without this, runtime.timeline grows unboundedly across many turns
// on a long-lived thread that is never reconnected (reconnection is the only
// other place that trims). The persisted copy is sliced to 300 in
// product-persist.js; keeping the live mirror in sync bounds memory.
const TIMELINE_MAX = 300;

const {
  beginProjectNavigation,
  isProjectNavigationCurrent,
  finishProjectNavigation,
  isProjectMutationNavigation,
  beginScopedRequest,
  isScopedRequestCurrent,
  queueProjectRuntimeOperation,
  queueSessionSettingOperation,
  queueThreadMutation,
  runUniqueSessionAction,
  queuePromptQueueOperation,
} = createQueueHelpers({
  runtimeOperationChains,
  sessionSettingChains,
  threadMutationChains,
  sessionActionOperations,
  promptQueueOperationChains,
  scopedRequestVersions,
  getProjectNavigationVersion: () => projectNavigationVersion,
  incrementProjectNavigationVersion: () => {
    projectNavigationVersion += 1;
    return projectNavigationVersion;
  },
});

function deletedSessionIdsForProject(project) {
  const ids = project?.preferences?.deletedSessionIds;
  return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id) : [];
}

function projectWithDeletedSession(project, sessionId) {
  if (!project || !sessionId) return project;
  const deletedSessionIds = deletedSessionIdsForProject(project).filter((id) => id !== sessionId);
  deletedSessionIds.push(sessionId);
  return {
    ...project,
    preferences: {
      ...(project.preferences || {}),
      deletedSessionIds: deletedSessionIds.slice(-DELETED_SESSION_HISTORY_LIMIT),
    },
    updatedAt: new Date().toISOString(),
  };
}

async function connectActiveProjectRuntime(set, get, projectId, runtime) {
  if (projectId !== get().activeProjectId) return false;
  const nextBase = `http://127.0.0.1:${runtime.port}`;
  const previousBase = get().apiBase;
  setApiBase(nextBase);
  set({ apiBase: nextBase });
  if (runtimeAuthScopeChanged(previousBase, nextBase)) {
    setAcpSessionToken(null);
    setAuthToken(null);
  }
  if (!runtime.password) return true;

  try {
    await requestCodeBuddy(`${nextBase}/?password=${encodeURIComponent(runtime.password)}`, {
      headers: { 'X-CodeBuddy-Request': '1' },
      credentials: 'include',
    });
    const loginResult = await apiAuthLogin(runtime.password, {
      baseUrl: nextBase,
      persistToken: false,
    });
    if (projectId !== get().activeProjectId) return false;
    if (!loginResult?.success) throw new Error(loginResult?.error || '运行时登录失败');
    setAuthToken(loginResult.token || null);
    set({ authViewState: 'authenticated', authError: null });
    return true;
  } catch (error) {
    if (projectId !== get().activeProjectId) return false;
    throw error;
  }
}

function serializePromptQueue(queue) {
  return (Array.isArray(queue) ? queue : [])
    .filter((item) => item && typeof item.text === 'string')
    .map((item) => ({
      id: item.id || `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: item.text,
      draftText: typeof item.draftText === 'string' ? item.draftText : item.text,
      createdAt: Number(item.createdAt) || Date.now(),
      attachments: (Array.isArray(item.attachments) ? item.attachments : [])
        .filter((attachment) => attachment && typeof attachment.path === 'string')
        .map((attachment) => ({
          name: attachment.name || attachment.path,
          path: attachment.path,
          size: Number(attachment.size) || 0,
          kind: attachment.kind === 'image' ? 'image' : 'text',
          mimeType: attachment.mimeType || null,
        })),
    }));
}

function mergeAttachmentSelection(runtime, selection) {
  const imageSupported = Boolean(
    runtime.capabilities?.promptCapabilities?.image || runtime.capabilities?.prompt_capabilities?.image,
  );
  const MAX_IMAGES = 5;
  const MAX_FILES = 10;
  const accepted = [];
  const rejected = [];
  for (const attachment of selection || []) {
    if (attachment.kind === 'unsupported') rejected.push(`${attachment.name}: ${attachment.error}`);
    else if (attachment.kind === 'image' && !imageSupported)
      rejected.push(`${attachment.name}: 当前运行时未声明图片输入能力`);
    else accepted.push(attachment);
  }
  const pendingAttachments = [...runtime.pendingAttachments];
  const currentImageCount = pendingAttachments.filter((item) => item.kind === 'image').length;
  const currentFileCount = pendingAttachments.filter((item) => item.kind !== 'image').length;
  let nextImageCount = currentImageCount;
  let nextFileCount = currentFileCount;
  const added = [];
  for (const attachment of accepted) {
    const duplicate = pendingAttachments.some((item) => item.path === attachment.path && item.kind === attachment.kind);
    if (duplicate) continue;
    if (attachment.kind === 'image') {
      if (nextImageCount >= MAX_IMAGES) {
        rejected.push(`${attachment.name}: 最多添加 ${MAX_IMAGES} 张图片`);
        continue;
      }
      nextImageCount += 1;
    } else {
      if (nextFileCount >= MAX_FILES) {
        rejected.push(`${attachment.name}: 最多添加 ${MAX_FILES} 个文件`);
        continue;
      }
      nextFileCount += 1;
    }
    pendingAttachments.push(attachment);
    added.push(attachment);
  }
  return { pendingAttachments, added, rejected };
}

function mergeTeamState(current, update) {
  return mergeCodeBuddyTeamState(current, update);
}

const RESPONSE_BUSY_STATUSES = new Set(['running', 'waiting', 'cancelling']);
const PROMPT_CONTENT_SESSION_UPDATES = new Set([
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
]);
// Wait for late agent_message_chunk that may only arrive on GET SSE after RPC end_turn.
// 250ms was too short for multi-tool turns where the final summary trails the result frame.
const FINAL_RESPONSE_GRACE_MS = 1500;

function threadResponseInProgress(state, threadId) {
  const thread = state.threadsById[threadId];
  const runtime = state.threadRuntimeById[threadId] || emptyThreadRuntime();
  return Boolean(RESPONSE_BUSY_STATUSES.has(thread?.status) || runtime.isAwaitingResponse || runtime.activePromptRunId || runtime.promptDispatchInFlight);
}

function threadSelectionProtection(state, threadId) {
  const runtime = threadId ? state.threadRuntimeById[threadId] || emptyThreadRuntime() : null;
  const preserveReplaySelection = Boolean(runtime?.historyReplayActive);
  // ultracode 是 UI 侧复合模式（/effort ultracode 写的是 session.meta.workflowEffortLevel，
  // 服务端 thought_level 字段仍是进入前的档位）。任何 config_option_update（切模式/模型触发）
  // 都会把本地 ultracode 覆盖回旧档位，因此当前为 ultracode 时保护 thoughtLevel。
  const preserveThoughtLevel = runtime?.thoughtLevel === 'ultracode';
  return {
    preserveModel: preserveReplaySelection,
    preserveMode: preserveReplaySelection,
    preserveThoughtLevel,
  };
}

function selectionMatchKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^custom-local:/, '');
}

function resolveAvailableSelection(choices, selectionId) {
  if (!selectionId) return null;
  const normalized = Array.isArray(choices) ? choices : [];
  if (normalized.length === 0) return selectionId;
  const exact = normalized.find((item) => (item.id || item.modelId || item.modeId) === selectionId);
  if (exact) return exact.id || exact.modelId || exact.modeId;
  const selectionKey = selectionMatchKey(selectionId);
  const alias = normalized.find((item) => {
    const id = item.id || item.modelId || item.modeId;
    return selectionMatchKey(id) === selectionKey || selectionMatchKey(item.name || item.label) === selectionKey;
  });
  return alias ? alias.id || alias.modelId || alias.modeId : null;
}


function waitForMilliseconds(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isMethodNotFoundError(error) {
  return error?.code === -32601 || /method not found/i.test(String(error?.message || ''));
}

function cancelPendingTimelineActions(timeline) {
  const cancelledAt = Date.now();
  return (Array.isArray(timeline) ? timeline : []).map((item) => {
    const pendingInterruption = item?.type === 'interruption' && !['resolved', 'expired', 'cancelled'].includes(item.status);
    const pendingQuestion = item?.type === 'question' && !['answered', 'expired', 'cancelled'].includes(item.status);
    if (!pendingInterruption && !pendingQuestion) return item;
    return {
      ...item,
      status: 'cancelled',
      meta: { ...(item.meta || {}), cancelledAt },
    };
  });
}
function promptResultErrorMessage(result) {
  const classified = classifyPromptRefusal(result);
  let raw = classified.message || '';
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      raw =
        parsed?.message ||
        parsed?.error?.message ||
        parsed?.data?.details ||
        parsed?.details ||
        raw;
    } catch (_) {
      /* keep raw */
    }
  }
  if (classified.kind === 'custom_model_auth') {
    return formatCustomModelAuthFailureMessage(raw || result?.errorMessage || '', {
      statusCode: classified.statusCode,
    });
  }
  if (classified.kind === 'auth' || isCloudAuthFailureMessage(raw)) {
    return 'CodeBuddy 云端账号未登录或登录已失效。请在应用内完成一次登录（浏览器授权），完成后会话会自动恢复。';
  }
  if (classified.kind === 'network' || isNetworkOrProxyFailureMessage(raw) || isNetworkOrProxyFailureMessage(result?.errorMessage)) {
    // Prefer compact host/proxy summary over raw "Network error: …html…" dumps.
    return formatNetworkOrProxyFailureMessage(raw || result?.errorMessage || '', {
      statusCode: classified.statusCode,
    });
  }
  if (raw) {
    // Strip giant HTML error pages from proxy/nginx for readable UI.
    if (/<\s*html/i.test(raw) || raw.length > 500) {
      return formatNetworkOrProxyFailureMessage(raw, { statusCode: classified.statusCode });
    }
    return raw;
  }
  if (String(result?.stopReason || '').toLowerCase() === 'refusal') {
    // Prefer any residual CLI detail already classified; generic fallback last.
    const residual = String(result?.errorMessage || result?.message || '').trim();
    if (residual && /unknown provider for model/i.test(residual)) {
      return formatNetworkOrProxyFailureMessage(residual, { statusCode: classified.statusCode });
    }
    if (residual && /custom_model_auth|Authentication failed.*for model/i.test(residual)) {
      return formatCustomModelAuthFailureMessage(residual, { statusCode: classified.statusCode });
    }
    return '模型未能完成本轮回复（请求被拒绝）。请重试；若持续失败请检查网络与模型配置。';
  }
  return '模型未能完成本轮回复';
}

function normalizeSessions(payload) {
  const data = payload?.data ?? payload ?? {};
  return Array.isArray(data.sessions) ? data.sessions : [];
}

function normalizeWorkers(payload) {
  const data = payload?.data ?? payload ?? [];
  return Array.isArray(data) ? data : [];
}

function settingScopeKey(projectId, key) {
  return `${projectId || 'global'}:${key}`;
}

function normalizePlugins(payload) {
  const data = payload?.data ?? payload ?? [];
  if (Array.isArray(data)) return data.map((plugin) => normalizePluginRecord(plugin) || plugin).filter(Boolean);
  if (Array.isArray(data?.plugins)) return data.plugins.map((plugin) => normalizePluginRecord(plugin) || plugin).filter(Boolean);
  if (data && typeof data === 'object' && data.name) return [normalizePluginRecord(data) || data];
  return [];
}

// 对照 WebUI 2.138：模型 meta（credits 计费倍率 / maxInputTokens 上下文窗口）来自
// ACP availableModels 的 _meta；config_option 通道的 choices 不携带 _meta，因此
// 归一化时允许从 previousModels（已知模型列表）按 id 回填，避免倍率被覆盖丢失。
function normalizeModels(models = [], previousModels = []) {
  const previousById = new Map();
  for (const prev of Array.isArray(previousModels) ? previousModels : []) {
    const prevId = prev?.id || prev?.modelId;
    if (prevId) previousById.set(prevId, prev);
  }
  return (Array.isArray(models) ? models : [])
    .map((model) => {
      if (typeof model === 'string') {
        const previous = previousById.get(model);
        return {
          id: model,
          name: model,
          credits: previous?.credits ?? null,
          contextWindow: previous?.contextWindow ?? null,
        };
      }
      const id = model?.modelId || model?.id || model?.value;
      if (!id) return null;
      const meta = model?._meta && typeof model._meta === 'object' ? model._meta : {};
      const previous = previousById.get(id);
      return {
        id,
        name: model?.name || model?.label || id,
        credits: meta.credits ?? model?.credits ?? previous?.credits ?? null,
        contextWindow:
          meta.maxInputTokens ??
          model?.contextWindow ??
          model?.maxInputTokens ??
          previous?.contextWindow ??
          null,
      };
    })
    .filter(Boolean);
}

function normalizeModes(modes = []) {
  return (Array.isArray(modes) ? modes : [])
    .map((mode) => {
      if (typeof mode === 'string') return { id: mode, name: mode };
      const id = mode?.modeId || mode?.id || mode?.value;
      return id ? { id, name: mode?.name || mode?.label || id } : null;
    })
    .filter(Boolean);
}

function configOptionChoices(option) {
  for (const value of [option?.options, option?.values, option?.availableValues, option?.choices, option?.enum]) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function readSettingPath(settings, path) {
  return String(path || '')
    .split('.')
    .reduce((value, key) => value?.[key], settings);
}

function settingsCacheSnapshot(settings) {
  const next = stripGuiSettings(settings);
  delete next['gateway.auth'];
  if (next.gateway && typeof next.gateway === 'object' && !Array.isArray(next.gateway)) {
    const gateway = { ...next.gateway };
    delete gateway.auth;
    next.gateway = gateway;
  }
  return next;
}

function persistSettingsCache(settings) {
  try {
    localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(settingsCacheSnapshot(settings)));
  } catch (_) {}
}

function writeSettingPath(settings, path, value, remove = false) {
  const keys = String(path || '')
    .split('.')
    .filter(Boolean);
  const next = { ...(settings || {}) };
  if (!keys.length) return next;
  let cursor = next;
  for (const key of keys.slice(0, -1)) {
    const current = cursor[key];
    cursor[key] = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
    cursor = cursor[key];
  }
  const leaf = keys[keys.length - 1];
  if (remove) delete cursor[leaf];
  else cursor[leaf] = value;
  return next;
}
function requestDirtyFileConfirmation(set, get, actionLabel = '继续操作') {
  const state = get();
  if (!state.fileDirty || !state.selectedFile) return Promise.resolve(true);

  if (dirtyFileConfirmationResolve) dirtyFileConfirmationResolve(false);

  return new Promise((resolve) => {
    dirtyFileConfirmationResolve = resolve;
    set({
      dirtyFileConfirmation: { filePath: state.selectedFile, actionLabel },
    });
  });
}

function resetFileWorkspace(path) {
  fileDirectoryRequestId += 1;
  filePreviewRequestId += 1;
  fileSearchRequestId += 1;
  fileNameSearchRequestId += 1;
  fileSaveRequestId += 1;
  fileDiskSyncRequestId += 1;
  return {
    fileCwd: path || '.',
    fileEntries: [],
    fileLoading: false,
    selectedFile: null,
    filePreview: '',
    fileSavedContent: '',
    fileDirty: false,
    fileSaving: false,
    fileExternalChange: null,
    filePreviewLoading: false,
    fileSearchQuery: '',
    fileSearchResults: [],
    fileSearching: false,
    fileNameQuery: '',
    fileNameResults: [],
    fileNameSearching: false,
  };
}

export const useStore = create((set, get) => {
  const productPersist = createProductPersistSlice(set, get, {
    threadTimelinePersistTimers,
    threadTimelineCoalesce,
    threadDraftPersistTimers,
    terminalStatePersistTimers,
    workspaceStatePersistTimers,
    getProductStateSaveChain: () => productStateSaveChain,
    setProductStateSaveChain: (value) => {
      productStateSaveChain = value;
    },
    serializePromptQueue,
  });

  const projectsRuntime = createProjectsRuntimeSlice(set, get, {
    conversations,
    connectActiveProjectRuntime,
    beginProjectNavigation,
    isProjectNavigationCurrent,
    finishProjectNavigation,
    isProjectMutationNavigation,
    queueProjectRuntimeOperation,
    requestDirtyFileConfirmation,
    resetFileWorkspace,
  });

  const sessionsChat = createSessionsChatSlice(set, get, {
    conversations,
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
    serializePromptQueue,
    mergeAttachmentSelection,
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
  });

  return {
  ...emptyProductState(),
  productStateLoaded: false,
  threadRuntimeById: {},
  apiBase: getApiBase(),
  route: typeof window === 'undefined' ? 'chat' : parseHashRoute(),
  connectionState: 'connecting',
  // 鉴权态：对照源 viewState ∈ loading|login|authenticated
  authViewState: 'loading',
  authError: null,
  authSubmitting: false,
  codeBuddyAccountAuthState: 'unknown',
  codeBuddyAccountAuthUrl: null,
  codeBuddyAccountAuthError: null,
  codeBuddyAccountUser: null,
  codeBuddyAccountAuthMethods: [],
  _accountAuthGeneration: 0,
  sessionId: null,
  sessionToken: null,
  currentModel: null,
  models: [],
  modes: [],
  currentMode: 'default',
  newSessionBusy: false,
  newSessionProjectId: null,
  newSessionError: null,
  projectNavigationBusy: false,
  projectNavigationTargetId: null,
  projectNavigationError: null,
  info: null,
  settings: null,
  guiSettings: loadGuiSettings(),
  infoLoaded: false,
  settingsLoaded: false,
  sessionTitle: null,
  usage: null,
  availableCommands: [],
  sessions: [],
  workers: [],
  workersError: null,
  plugins: [],
  marketplaces: [],
  pluginError: null,
  marketplaceError: null,
  pluginBusy: null, // 当前操作中的插件名/动作，避免 UI 重入
  workspaceExtraDirs: [],
  workspaceDirsBusy: false,
  workspaceDirsError: null,
  /** Absolute file paths from ACP `_codebuddy.ai/checkpoint` events, keyed by checkpoint id. */
  agentCheckpointPathsById: {},
  timeline: [],
  // 发消息后等 agent 首 SSE 块期间：UI 需立即显"思考中"态（发送键变终止键）
  // 收到 agent_message_chunk/agent_thought_chunk/tool_call 等真内容事件时清
  isAwaitingResponse: false,
  promptStartedAt: null,
  activePromptRunId: null,
  sidebarCollapsed: false,
  rightPanel: null,
  workflowFloatingPanel: null,
  // M2 dismissed 竞态：{ runId: string|null, at: number } | null（时间窗 + 同 run 抑制自动重开）
  workflowPanelDismissed: null,
  changesCount: 0,
  leftTab: 'chat',
  terminalSessions: [],
  ptySessionId: null,
  terminalPanes: [makePane()],
  activePaneId: null,
  traces: [],
  metrics: null,
  metricsError: null,
  stats: null, // 全局 stats（对照源 GET /api/v1/stats）
  sessionStats: null, // 当前会话 stats（对照源 GET /api/v1/stats/session?sessionId=）
  statsError: null,
  statsLoading: false,
  scheduledTasks: [],
  scheduledTasksError: null,
  taskTemplates: [],
  taskTemplatesError: null,
  taskTemplatesLoading: false,
  error: null,
  toasts: [],
  promptSuggestion: null,
  permissionRequests: [],
  questions: [],
  teamState: null,
  lastTeamState: null,
  memberHistoriesByName: {},
  subagentToolCalls: {},
  workflowState: null,
  lastWorkflowState: null,
  subagentReports: null,
  lastSubagentReports: null,
  rawExtensionEvents: [],
  agentPhase: null,
  progress: null,
  historyReplayActive: false,
  fileCwd: '.',
  // 工作区路径：决定 ACP 会话 agent 工具调用目录、Git cwd、文件树根的统一来源
  // 通过 setWorkspace(path) 切换 = 用新 cwd 起新会话；持久化在 localStorage
  workspacePath: null,
  fileEntries: [],
  fileLoading: false,
  // P0-8: last file-tree load failure (per-directory). Kept separate from the
  // global `error` banner so the FileTree can render a real error state with a
  // retry action instead of pretending the directory is empty.
  fileLoadError: null,
  fileSearchQuery: '',
  fileSearchResults: [],
  fileSearching: false,
  // 文件名搜索（对照源 GET /api/v1/fs/search?query&limit，补全/打开文件面板）
  fileNameQuery: '',
  fileNameResults: [],
  fileNameSearching: false,
  watcherId: null,
  selectedFile: null,
  filePreview: '',
  fileSavedContent: '',
  fileDirty: false,
  fileSaving: false,
  fileExternalChange: null,
  filePreviewLoading: false,
  dirtyFileConfirmation: null,

  getThreadClient(threadId = get().activeThreadId) {
    const thread = get().threadsById[threadId];
    const project = thread ? get().projectsById[thread.projectId] : null;
    if (!thread || !project?.runtimePort) return null;
    const client = conversations.getClient(threadId, `http://127.0.0.1:${project.runtimePort}`);
    // 传输自动重连 kill switch：每次获取 client 时同步最新 GUI 设置。
    if (client && typeof client.setAutoReconnectEnabled === 'function') {
      client.setAutoReconnectEnabled(get().guiSettings?.transportAutoReconnect !== false);
    }
    return client;
  },

  resolveDirtyFileConfirmation(confirmed) {
    const resolve = dirtyFileConfirmationResolve;
    dirtyFileConfirmationResolve = null;
    set({ dirtyFileConfirmation: null });
    resolve?.(Boolean(confirmed));
  },

  confirmDirtyFileAction(actionLabel) {
    return requestDirtyFileConfirmation(set, get, actionLabel);
  },

  patchThreadRuntime(threadId, patch) {
    if (!threadId) return;
    // Defensive guard: if the thread has been deleted (e.g. via deleteThread or
    // removeProject), do not resurrect a zombie threadRuntimeById entry. A
    // hidden-window coalesce timer that fires just after deletion, or a late
    // stream event, would otherwise write a runtime entry for a thread that no
    // longer exists — leaking memory and producing stale timeline writes.
    if (!get().threadsById[threadId]) {
      const entry = threadTimelineCoalesce.get(threadId);
      if (entry) {
        if (entry.timer) clearTimeout(entry.timer);
        threadTimelineCoalesce.delete(threadId);
      }
      return;
    }
    // M-st6: when an external timeline patch arrives while the window is hidden
    // and stream chunks are coalesced, fold the coalesced chunks into the patch
    // instead of dropping them. The coalesced entry.timeline is a superset of the
    // stale runtime.timeline the caller used to build their patch (e.g.
    // closeAssistantStream ran over runtime.timeline missing the hidden chunks),
    // so prefer entry.timeline as the base and let the patch's non-timeline
    // fields (status, lastPromptRunId, etc.) pass through unchanged.
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'timeline')) {
      const entry = threadTimelineCoalesce.get(threadId);
      if (entry) {
        if (entry.timer) clearTimeout(entry.timer);
        threadTimelineCoalesce.delete(threadId);
        patch = { ...patch, timeline: entry.timeline };
      }
    }
    set((state) => {
      let nextRuntime = {
        ...emptyThreadRuntime(),
        ...(state.threadRuntimeById[threadId] || {}),
        ...patch,
      };
      // Bound runtime.timeline so a long-lived thread never accumulates an
      // unbounded in-memory timeline (the persisted copy is already capped at
      // TIMELINE_MAX in product-persist.js; this keeps the live mirror aligned).
      if (Array.isArray(nextRuntime.timeline) && nextRuntime.timeline.length > TIMELINE_MAX) {
        nextRuntime = { ...nextRuntime, timeline: nextRuntime.timeline.slice(-TIMELINE_MAX) };
      }
      const result = {
        threadRuntimeById: { ...state.threadRuntimeById, [threadId]: nextRuntime },
      };
      if (state.activeThreadId === threadId) {
        for (const key of ACTIVE_THREAD_RUNTIME_KEYS) result[key] = nextRuntime[key];
      }
      return result;
    });
  },

  activateThreadRuntime(threadId) {
    const prior = get().threadRuntimeById[threadId] || {};
    const runtime = { ...emptyThreadRuntime(), ...prior };
    const thread = get().threadsById[threadId];
    // Empty / user-less runtime.timeline must not hide persisted thread history.
    const priorTimeline = Array.isArray(prior.timeline) ? prior.timeline : [];
    const resolvedTimeline = resolveThreadTimeline(runtime.timeline, thread?.timeline);
    runtime.timeline = resolvedTimeline;
    const patch = {};
    for (const key of ACTIVE_THREAD_RUNTIME_KEYS) patch[key] = runtime[key];
    const client = conversations.peek(threadId);
    patch.sessionToken = client?.sessionToken || null;
    setAcpSessionToken(patch.sessionToken);
    // Keep threadRuntimeById in sync when we healed timeline from disk
    // (empty live, or live missing user bubbles).
    const healed =
      threadId &&
      resolvedTimeline.length > 0 &&
      (resolvedTimeline !== priorTimeline &&
        (priorTimeline.length === 0 ||
          resolvedTimeline.length !== priorTimeline.length ||
          resolvedTimeline[0]?.id !== priorTimeline[0]?.id));
    if (healed) {
      patch.threadRuntimeById = {
        ...get().threadRuntimeById,
        [threadId]: { ...runtime },
      };
    }
    set(patch);
  },

  ...productPersist,

  async updateActiveThread(patch) {
    return get().updateThreadRecord(get().activeThreadId, patch);
  },

  setThreadDraft(value, threadId = get().activeThreadId) {
    if (!threadId) return;
    const next = String(value || '');
    const current = get().threadsById[threadId]?.draft || '';
    // 值短路：打字时 onChange 可能传入与当前 draft 相同的值（如 IME 组合、
    // 焦点事件等）。跳过无意义的 store 写入，避免触发全应用 selector fan-out。
    if (current === next) return;
    set((state) => ({
      threadsById: {
        ...state.threadsById,
        [threadId]: {
          ...state.threadsById[threadId],
          draft: next,
          updatedAt: new Date().toISOString(),
        },
      },
    }));
    get().scheduleThreadDraftPersist(threadId);
  },

  clearPromptSuggestion(threadId = get().activeThreadId) {
    if (!threadId || !get().threadsById[threadId]) return false;
    get().patchThreadRuntime(threadId, { promptSuggestion: null });
    return true;
  },

  async chooseAttachments(options = {}) {
    const state = get();
    const projectId = state.activeProjectId;
    const threadId = state.activeThreadId;
    if (!threadId || !state.threadsById[threadId]) {
      set({ error: '请先创建或选择一个会话' });
      return [];
    }
    if (!window.electronAPI?.chooseAttachments) {
      set({ error: '附件选择不可用' });
      return [];
    }
    set({ error: null });
    try {
      const selected = await window.electronAPI.chooseAttachments(options);
      const thread = get().threadsById[threadId];
      if (!thread || thread.projectId !== projectId) return [];
      const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      const { pendingAttachments, added, rejected } = mergeAttachmentSelection(runtime, selected);
      get().patchThreadRuntime(threadId, { pendingAttachments });
      if (rejected.length && get().activeProjectId === projectId && get().activeThreadId === threadId) {
        set({ error: rejected.join('\n') });
      }
      return added;
    } catch (error) {
      if (get().activeProjectId === projectId && get().activeThreadId === threadId) {
        set({ error: error.message || '选择附件失败' });
      }
      return [];
    }
  },

  async addDroppedAttachments(files) {
    const state = get();
    const projectId = state.activeProjectId;
    const threadId = state.activeThreadId;
    if (!threadId || !state.threadsById[threadId]) {
      const message = '请先创建或选择一个会话';
      set({ error: message });
      return { added: [], error: message };
    }
    if (!window.electronAPI?.readDroppedAttachments) {
      const message = '附件拖放接口不可用';
      set({ error: message });
      return { added: [], error: message };
    }
    set({ error: null });
    try {
      const selected = await window.electronAPI.readDroppedAttachments(files);
      const thread = get().threadsById[threadId];
      if (!thread || thread.projectId !== projectId) return { added: [], error: null };
      const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      const { pendingAttachments, added, rejected } = mergeAttachmentSelection(runtime, selected);
      get().patchThreadRuntime(threadId, { pendingAttachments });
      const message = rejected.length ? rejected.join('\n') : null;
      if (message && get().activeProjectId === projectId && get().activeThreadId === threadId) {
        set({ error: message });
      }
      return { added, error: message };
    } catch (error) {
      const message = error.message || '读取拖放附件失败';
      if (get().activeProjectId === projectId && get().activeThreadId === threadId) {
        set({ error: message });
      }
      return { added: [], error: message };
    }
  },

  async addClipboardImageAttachment(payload) {
    const state = get();
    const projectId = state.activeProjectId;
    const threadId = state.activeThreadId;
    if (!threadId || !state.threadsById[threadId]) {
      set({ error: '请先创建或选择一个会话' });
      return [];
    }
    if (!state.guiSettings?.enablePasteImageFromClipboard) {
      set({ error: '剪贴板贴图未启用，请先在设置中开启' });
      return [];
    }
    const runtime = state.threadRuntimeById[threadId] || emptyThreadRuntime();
    const imageSupported = Boolean(
      runtime.capabilities?.promptCapabilities?.image || runtime.capabilities?.prompt_capabilities?.image,
    );
    if (!imageSupported) {
      set({ error: '当前运行时未声明图片输入能力' });
      return [];
    }
    if (!window.electronAPI?.saveClipboardImage) {
      set({ error: '剪贴板图片保存接口不可用' });
      return [];
    }
    set({ error: null });
    try {
      const attachment = await window.electronAPI.saveClipboardImage(payload);
      const thread = get().threadsById[threadId];
      if (!thread || thread.projectId !== projectId || get().activeThreadId !== threadId) return [];
      if (!attachment || attachment.kind === 'unsupported') {
        set({ error: attachment?.error || '剪贴板图片读取失败' });
        return [];
      }
      const currentRuntime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      const pendingAttachments = [...currentRuntime.pendingAttachments, attachment];
      get().patchThreadRuntime(threadId, { pendingAttachments });
      return [attachment];
    } catch (error) {
      if (get().activeProjectId === projectId && get().activeThreadId === threadId) {
        set({ error: error.message || '粘贴图片失败' });
      }
      return [];
    }
  },

  removePendingAttachment(attachmentPath) {
    const threadId = get().activeThreadId;
    const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
    get().patchThreadRuntime(threadId, {
      pendingAttachments: runtime.pendingAttachments.filter((item) => item.path !== attachmentPath),
    });
  },

  setRoute(route) {
    setHashRoute(route);
    set({ route });
  },

  clearError() {
    set({ error: null });
  },

  pushToast(toast) {
    const message = String(toast?.message || '').trim();
    if (!message) return null;
    const id = toast?.id || `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const type = ['success', 'error', 'info'].includes(toast?.type) ? toast.type : 'info';
    const durationMs = Number.isFinite(Number(toast?.durationMs)) ? Number(toast.durationMs) : 4200;
    const entry = { id, type, message, createdAt: Date.now() };
    set((state) => ({
      toasts: [...(Array.isArray(state.toasts) ? state.toasts : []), entry].slice(-5),
    }));
    if (durationMs > 0 && typeof window !== 'undefined') {
      window.setTimeout(() => {
        const dismiss = useStore.getState().dismissToast;
        if (typeof dismiss === 'function') dismiss(id);
      }, durationMs);
    }
    return id;
  },

  dismissToast(id) {
    if (!id) return;
    set((state) => ({
      toasts: (Array.isArray(state.toasts) ? state.toasts : []).filter((item) => item.id !== id),
    }));
  },

  notifyThreadResult(threadId, outcome) {
    const state = get();
    if (!state.guiSettings?.desktopNotificationsEnabled || state.guiSettings?.doNotDisturb || !window.electronAPI?.showTaskNotification) return false;
    const thread = state.threadsById[threadId];
    const project = thread ? state.projectsById[thread.projectId] : null;
    if (!thread) return false;
    const failed = outcome === 'error';
    const context = [project?.name, thread.title || '新对话'].filter(Boolean).join(' · ');
    const body = `${context}\n${failed ? '后台任务失败，点击进入应用查看详情。' : '后台任务已完成，点击进入应用查看结果。'}`;
    window.electronAPI
      .showTaskNotification({
        projectId: thread.projectId,
        threadId,
        title: failed ? 'CodeBuddy 任务失败' : 'CodeBuddy 任务已完成',
        body,
        outcome,
      })
      .catch(() => null);
    return true;
  },

  getModelDisplayName() {
    const { currentModel, models } = get();
    return models.find((m) => m.id === currentModel || m.modelId === currentModel)?.name || currentModel || '';
  },

  setSidebarCollapsed(value) {
    set({ sidebarCollapsed: value });
  },

  openRightPanel(type, payload = null) {
    if (type === 'workflow') return get().openWorkflowPanel(payload);
    // surfaces = chooser; files/browser/terminal/diff all live in the right host.
    const allowed = new Set(['surfaces', 'files', 'browser', 'terminal', 'diff']);
    if (!allowed.has(type)) return false;
    set({
      rightPanel: { type, payload: payload && typeof payload === 'object' ? payload : null },
    });
    return true;
  },

  closeRightPanel() {
    set({ rightPanel: null });
    return true;
  },

  toggleRightPanel(type, payload = null) {
    if (type === 'workflow') return get().toggleWorkflowPanel(payload);
    const current = get().rightPanel;
    if (current?.type === type) return get().closeRightPanel();
    return get().openRightPanel(type, payload);
  },

  openWorkflowPanel(payload = null) {
    const clean = payload && typeof payload === 'object' ? payload : null;
    set({
      workflowFloatingPanel: {
        payload: clean
          ? {
              projectId: typeof clean.projectId === 'string' ? clean.projectId : null,
              threadId: typeof clean.threadId === 'string' ? clean.threadId : null,
              runId: typeof clean.runId === 'string' ? clean.runId : null,
            }
          : null,
      },
      // 手动打开 = 清 dismiss 窗（M2：用户主动打开后允许后续自动打开）
      workflowPanelDismissed: null,
    });
    return true;
  },

  closeWorkflowPanel() {
    const current = get().workflowFloatingPanel;
    // M2：禁用 lastPromptRunId fallback——runId 无法确定时记录 null（仅时间窗抑制）。
    // 不回退 activePromptRunId：关闭动作不应把“当前正在跑的任务”误绑定为被关闭
    // 面板的 runId（契约 §1：payload 无 runId 时禁用 fallback）。
    const runId = current?.payload?.runId ?? null;
    set({
      workflowFloatingPanel: null,
      workflowPanelDismissed: { runId, at: Date.now() },
    });
    return true;
  },

  /**
   * M2 幂等关闭：仅当面板存在且（未绑定线程 或 绑定该线程）时关闭。
   * 用于 activateThread / activateProject / deleteThread 等生命周期切换。
   */
  closeWorkflowPanelIfBound(threadId = null) {
    const panel = get().workflowFloatingPanel;
    if (!panel) return false;
    if (threadId != null && panel.payload?.threadId && panel.payload.threadId !== threadId) return false;
    return get().closeWorkflowPanel();
  },

  toggleWorkflowPanel(payload = null) {
    if (get().workflowFloatingPanel) return get().closeWorkflowPanel();
    return get().openWorkflowPanel(payload);
  },

  setActivePane(paneId) {
    set({ activePaneId: paneId });
    get().scheduleTerminalStatePersist();
  },

  setFileSearchQuery(value) {
    set({ fileSearchQuery: value });
  },

  setFilePreview(value) {
    set((state) => ({
      filePreview: value,
      fileDirty: Boolean(state.selectedFile) && value !== state.fileSavedContent,
    }));
    get().scheduleWorkspaceStatePersist();
  },

  ...sessionsChat,

  ...projectsRuntime,

  async initializeWorkspace() {
    const project = activeProject(get());
    if (!project?.workspacePath) return false;
    const saved = workspaceStateFromProject(project);
    let opened = await get().openDirectory(saved.fileCwd, { skipDirtyCheck: true, skipWorkspacePersist: true });
    if (!opened && saved.fileCwd !== project.workspacePath) {
      opened = await get().openDirectory(project.workspacePath, { skipDirtyCheck: true, skipWorkspacePersist: true });
    }
    if (!opened) return false;
    if (!saved.selectedFile) {
      get().scheduleWorkspaceStatePersist();
      return true;
    }
    if (saved.fileDirty) {
      set({
        selectedFile: saved.selectedFile,
        filePreview: saved.filePreview,
        fileSavedContent: saved.fileSavedContent,
        fileDirty: true,
        fileSaving: false,
        fileExternalChange: null,
        filePreviewLoading: false,
      });
      get().scheduleWorkspaceStatePersist();
      return true;
    }
    const restored = await get().openFile(saved.selectedFile, { skipDirtyCheck: true, skipWorkspacePersist: true });
    if (!restored) {
      get().setSelectedFile(null);
      return true;
    }
    get().scheduleWorkspaceStatePersist();
    return true;
  },

  async openDirectory(path, options = {}) {
    if (!options.skipDirtyCheck && get().fileDirty) {
      const confirmed = await requestDirtyFileConfirmation(set, get, '打开其他目录');
      if (!confirmed) return false;
      await get().persistActiveProjectWorkspaceState({ discardDirty: true });
    }
    const requestId = ++fileDirectoryRequestId;
    fileSaveRequestId += 1;
    fileDiskSyncRequestId += 1;
    const projectId = get().activeProjectId;
    set({
      fileLoading: true,
      fileCwd: path,
      selectedFile: null,
      filePreview: '',
      fileSavedContent: '',
      fileDirty: false,
      fileSaving: false,
      fileExternalChange: null,
      filePreviewLoading: false,
    });
    try {
      const entries = await fsList(path, 1);
      if (requestId !== fileDirectoryRequestId || projectId !== get().activeProjectId) return false;
      set({ fileEntries: entries, fileLoading: false, fileLoadError: null });
      if (!options.skipWorkspacePersist) get().scheduleWorkspaceStatePersist();
      return true;
    } catch (error) {
      if (requestId !== fileDirectoryRequestId || projectId !== get().activeProjectId) return false;
      set({ fileEntries: [], fileLoading: false, fileLoadError: error.message, error: error.message });
      return false;
    }
  },

  async openFile(path, options = {}) {
    if (!options.skipDirtyCheck && path !== get().selectedFile && get().fileDirty) {
      const confirmed = await requestDirtyFileConfirmation(set, get, '打开其他文件');
      if (!confirmed) return false;
      await get().persistActiveProjectWorkspaceState({ discardDirty: true });
    }
    const requestId = ++filePreviewRequestId;
    fileSaveRequestId += 1;
    fileDiskSyncRequestId += 1;
    const projectId = get().activeProjectId;
    set({
      selectedFile: path,
      filePreviewLoading: true,
      filePreview: '',
      fileSavedContent: '',
      fileDirty: false,
      fileSaving: false,
      fileExternalChange: null,
    });
    try {
      const content = await downloadFile(path);
      if (requestId !== filePreviewRequestId || projectId !== get().activeProjectId) return false;
      set({ filePreview: content, fileSavedContent: content, fileDirty: false, filePreviewLoading: false });
      if (!options.skipWorkspacePersist) get().scheduleWorkspaceStatePersist();
      return true;
    } catch (error) {
      if (requestId !== filePreviewRequestId || projectId !== get().activeProjectId) return false;
      set({ filePreview: `读取失败: ${error.message}`, filePreviewLoading: false, error: error.message });
      return false;
    }
  },

  setSelectedFile(file) {
    fileSaveRequestId += 1;
    fileDiskSyncRequestId += 1;
    set({
      selectedFile: file,
      filePreviewLoading: !!file,
      filePreview: '',
      fileSavedContent: '',
      fileDirty: false,
      fileSaving: false,
      fileExternalChange: null,
    });
    get().scheduleWorkspaceStatePersist();
  },

  async runFileSearch() {
    const query = get().fileSearchQuery.trim();
    if (!query) return;
    const requestId = ++fileSearchRequestId;
    const projectId = get().activeProjectId;
    set({ fileSearching: true });
    try {
      const results = await fsSearchContent({ query, cwd: get().fileCwd || '.' });
      if (requestId !== fileSearchRequestId || projectId !== get().activeProjectId) return;
      set({ fileSearchResults: results, fileSearching: false });
    } catch (error) {
      if (requestId !== fileSearchRequestId || projectId !== get().activeProjectId) return;
      set({ fileSearchResults: [], fileSearching: false, error: error.message });
    }
  },

  setFileNameQuery(value) {
    set({ fileNameQuery: String(value || '') });
    // 轻输入：清空即清结果，非空时由调用方决定何时触发（避免每键都打后端）
    if (!String(value || '').trim()) set({ fileNameResults: [], fileNameSearching: false });
  },

  // 文件名搜索（对照源 GET /api/v1/fs/search?query&limit=15）
  // 用途：打开文件面板的实时名匹配补全；不同于 runFileSearch 的内容搜索
  async runFileNameSearch() {
    const query = get().fileNameQuery.trim();
    if (!query) {
      set({ fileNameResults: [], fileNameSearching: false });
      return;
    }
    const requestId = ++fileNameSearchRequestId;
    const projectId = get().activeProjectId;
    set({ fileNameSearching: true });
    try {
      const items = await fsSearchFiles(query, { limit: 15 });
      if (requestId !== fileNameSearchRequestId || projectId !== get().activeProjectId) return;
      set({ fileNameResults: items, fileNameSearching: false });
    } catch (error) {
      if (requestId !== fileNameSearchRequestId || projectId !== get().activeProjectId) return;
      set({ fileNameResults: [], fileNameSearching: false, error: error.message });
    }
  },

  async startWatcher(path = null) {
    const target = path || get().fileCwd || '.';
    const requestId = ++fileWatcherRequestId;
    const projectId = get().activeProjectId;
    const previousWatcherId = get().watcherId;
    if (previousWatcherId) {
      set({ watcherId: null });
      try {
        await removeWatcher(previousWatcherId);
      } catch (_) {}
    }
    try {
      const data = await createWatcher(target, true);
      const watcherId = data.watcherId || data.id || null;
      if (!watcherId) return null;
      if (requestId !== fileWatcherRequestId || projectId !== get().activeProjectId || target !== get().fileCwd) {
        try {
          await removeWatcher(watcherId);
        } catch (_) {}
        return null;
      }
      set({ watcherId });
      return watcherId;
    } catch (_) {
      if (requestId === fileWatcherRequestId && projectId === get().activeProjectId) set({ watcherId: null });
      return null;
    }
  },

  async pollWatcher() {
    const watcherId = get().watcherId;
    const projectId = get().activeProjectId;
    if (!watcherId) return [];
    try {
      const events = await pollWatcher(watcherId);
      if (watcherId !== get().watcherId || projectId !== get().activeProjectId) return [];
      return Array.isArray(events) ? events : [];
    } catch (_) {
      if (watcherId === get().watcherId) set({ watcherId: null });
      return [];
    }
  },

  async stopWatcher() {
    fileWatcherRequestId += 1;
    const watcherId = get().watcherId;
    if (!watcherId) return;
    set((state) => (state.watcherId === watcherId ? { watcherId: null } : {}));
    try {
      await removeWatcher(watcherId);
    } catch (_) {}
  },

  async persistProjectWorkspaceState(projectId, snapshot) {
    const project = get().projectsById[projectId];
    if (!project || !snapshot) return false;
    set((state) => ({
      projectsById: {
        ...state.projectsById,
        [projectId]: {
          ...state.projectsById[projectId],
          preferences: { ...(state.projectsById[projectId].preferences || {}), workspaceState: snapshot },
          updatedAt: new Date().toISOString(),
        },
      },
    }));
    return get().persistProductState();
  },

  scheduleWorkspaceStatePersist() {
    const projectId = get().activeProjectId;
    if (!projectId) return;
    const previous = workspaceStatePersistTimers.get(projectId);
    if (previous) clearTimeout(previous.timer || previous);
    const snapshot = workspaceStateSnapshot(get(), projectId, false);
    const timer = setTimeout(() => {
      workspaceStatePersistTimers.delete(projectId);
      get().persistProjectWorkspaceState(projectId, snapshot);
    }, 500);
    workspaceStatePersistTimers.set(projectId, { timer, snapshot });
  },

  async persistActiveProjectWorkspaceState(options = {}) {
    const projectId = get().activeProjectId;
    if (!projectId) return true;
    const pending = workspaceStatePersistTimers.get(projectId);
    if (pending) {
      clearTimeout(pending.timer || pending);
      workspaceStatePersistTimers.delete(projectId);
    }
    return get().persistProjectWorkspaceState(
      projectId,
      workspaceStateSnapshot(get(), projectId, options.discardDirty === true),
    );
  },

  loadProjectTerminalState(projectId) {
    const project = get().projectsById[projectId];
    const terminalState = terminalStateFromProject(project, false);
    set({
      terminalPanes: terminalState.panes,
      activePaneId: terminalState.activePaneId,
      terminalSessions: [],
      ptySessionId: null,
    });
  },

  async persistProjectTerminalState(projectId, snapshot) {
    const project = get().projectsById[projectId];
    if (!project) return false;
    const terminalState = snapshot || terminalStateSnapshot(projectId, get().terminalPanes, get().activePaneId);
    set((state) => ({
      projectsById: {
        ...state.projectsById,
        [projectId]: {
          ...state.projectsById[projectId],
          preferences: {
            ...(state.projectsById[projectId].preferences || {}),
            terminalState: {
              activePaneId: terminalState.activePaneId,
              panes: terminalState.panes,
            },
          },
          updatedAt: new Date().toISOString(),
        },
      },
    }));
    await get().persistProductState();
    return true;
  },

  scheduleTerminalStatePersist() {
    const projectId = get().activeProjectId;
    if (!projectId) return;
    const now = Date.now();
    const previous = terminalStatePersistTimers.get(projectId);
    if (previous) clearTimeout(previous.timer || previous);
    // Fixed cadence: schedule at the anchor + WINDOW, not now + WINDOW. With a
    // naive reset-per-call, chunks arriving faster than WINDOW (steady terminal
    // output) would never let the timer fire; the only save would be the quit
    // backstop, losing all output on a crash/kill. The anchor is set on the
    // FIRST schedule of a burst and only moves forward when a persist fires (or
    // the boundary passes, or the clock moved backwards) — so a burst re-pins to
    // the same deadline instead of pushing it out forever.
    const lastAt = lastTerminalStatePersistAt.get(projectId);
    const elapsed = lastAt == null ? null : now - lastAt;
    let remaining;
    if (lastAt == null || elapsed >= TERMINAL_STATE_PERSIST_MS || elapsed < 0) {
      lastTerminalStatePersistAt.set(projectId, now);
      remaining = TERMINAL_STATE_PERSIST_MS;
    } else {
      remaining = TERMINAL_STATE_PERSIST_MS - elapsed;
    }
    const entry = { projectId, timer: null };
    entry.timer = setTimeout(() => {
      if (terminalStatePersistTimers.get(projectId) !== entry) return;
      terminalStatePersistTimers.delete(projectId);
      lastTerminalStatePersistAt.set(projectId, Date.now());
      if (get().activeProjectId !== projectId) return;
      get().flushPendingPaneOutputs();
      const snapshot = terminalStateSnapshot(projectId, get().terminalPanes, get().activePaneId);
      get().persistProjectTerminalState(projectId, snapshot);
    }, remaining);
    terminalStatePersistTimers.set(projectId, entry);
  },

  async persistActiveProjectTerminalState() {
    const projectId = get().activeProjectId;
    if (!projectId) return false;
    const pending = terminalStatePersistTimers.get(projectId);
    if (pending) {
      clearTimeout(pending.timer || pending);
      terminalStatePersistTimers.delete(projectId);
    }
    // A manual flush is a cadence point: anchor the next scheduled persist to now
    // so an immediate follow-up chunk does not trigger a second persist within
    // the same 5s window.
    lastTerminalStatePersistAt.set(projectId, Date.now());
    // Capture EARLY so a project switch during the cwd lookups cannot leak the
    // new project's panes into this project's snapshot.
    get().flushPendingPaneOutputs();
    const captured = terminalStateSnapshot(projectId, get().terminalPanes, get().activePaneId);

    const cwdByPaneId = new Map();
    await Promise.all(
      captured.panes.map(async (pane) => {
        if (!pane.sessionId) return;
        const cwd = await get().fetchPtyCwd(pane.sessionId);
        if (cwd) cwdByPaneId.set(pane.id, cwd);
      }),
    );
    // M-fix: if we are still on the same project, re-flush and re-snapshot so
    // terminal output that arrived during the cwd lookups is NOT overwritten by
    // the stale `captured` (the old flow re-persisted a withCwd derived from the
    // stale snapshot, losing those lines). If a project switch happened, keep
    // the early capture (the switch owns the new panes).
    let latest = captured;
    if (get().activeProjectId === projectId) {
      get().flushPendingPaneOutputs();
      latest = terminalStateSnapshot(projectId, get().terminalPanes, get().activePaneId);
    }
    const withCwd = cwdByPaneId.size
      ? {
          ...latest,
          panes: latest.panes.map((pane) =>
            cwdByPaneId.has(pane.id) ? { ...pane, cwd: cwdByPaneId.get(pane.id) } : pane,
          ),
        }
      : latest;
    await get().persistProjectTerminalState(projectId, withCwd);
    return true;
  },

  initializeTerminal() {
    const panes = get().terminalPanes;
    if (!panes.length) {
      const pane = makePane();
      set({ terminalPanes: [pane], activePaneId: pane.id });
      get().scheduleTerminalStatePersist();
      return;
    }
    if (!get().activePaneId) {
      set({ activePaneId: panes[0].id });
      get().scheduleTerminalStatePersist();
    }
  },

  splitPane(paneId, direction) {
    if (get().terminalPanes.length >= 2) return false;
    set((state) => {
      const next = {
        ...makePane(direction === 'right' ? 'Terminal Split Right' : 'Terminal Split Down'),
        split: direction === 'down' ? 'down' : 'right',
      };
      return {
        terminalPanes: [...state.terminalPanes, next],
        activePaneId: next.id,
      };
    });
    get().scheduleTerminalStatePersist();
    return true;
  },

  closePane(paneId) {
    if (get().terminalPanes.length === 1) return false;
    if (!get().terminalPanes.some((pane) => pane.id === paneId)) return false;
    set((state) => {
      const nextPanes = state.terminalPanes.filter((pane) => pane.id !== paneId);
      return {
        terminalPanes: nextPanes,
        activePaneId: state.activePaneId === paneId ? nextPanes[0]?.id || null : state.activePaneId,
      };
    });
    get().scheduleTerminalStatePersist();
    return true;
  },

  bindPtyToPane(paneId, sessionId, projectId = get().activeProjectId, cwd = undefined) {
    if (projectId !== get().activeProjectId) return false;
    const nextCwd = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : undefined;
    set((state) => ({
      terminalPanes: state.terminalPanes.map((pane) =>
        pane.id === paneId
          ? {
              ...pane,
              sessionId,
              ...(nextCwd !== undefined ? { cwd: nextCwd } : {}),
            }
          : pane,
      ),
      ptySessionId: sessionId,
    }));
    get().scheduleTerminalStatePersist();
    return true;
  },

  setPaneCwd(paneId, cwd, projectId = get().activeProjectId) {
    if (projectId !== get().activeProjectId) return false;
    const nextCwd = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : null;
    set((state) => ({
      terminalPanes: state.terminalPanes.map((pane) =>
        pane.id === paneId ? { ...pane, cwd: nextCwd } : pane,
      ),
    }));
    get().scheduleTerminalStatePersist();
    return true;
  },

  setPaneStatus(paneId, status, projectId = get().activeProjectId) {
    if (projectId !== get().activeProjectId) return false;
    set((state) => ({
      terminalPanes: state.terminalPanes.map((pane) => (pane.id === paneId ? { ...pane, status } : pane)),
    }));
    get().scheduleTerminalStatePersist();
    return true;
  },

  setPaneSession(paneId, sessionId, projectId = get().activeProjectId) {
    if (projectId !== get().activeProjectId) return false;
    set((state) => ({
      terminalPanes: state.terminalPanes.map((pane) => (pane.id === paneId ? { ...pane, sessionId } : pane)),
    }));
    get().scheduleTerminalStatePersist();
    return true;
  },

  appendPaneOutput(paneId, chunk, projectId = get().activeProjectId) {
    if (projectId !== get().activeProjectId) return false;
    const entry = paneOutputPending.get(paneId);
    if (entry) entry.push(chunk);
    else paneOutputPending.set(paneId, [chunk]);
    if (!paneOutputFlushTimer) {
      paneOutputFlushTimer = setTimeout(() => {
        paneOutputFlushTimer = null;
        get().flushPendingPaneOutputs();
      }, TERMINAL_OUTPUT_FLUSH_MS);
    }
    get().scheduleTerminalStatePersist();
    return true;
  },

  flushPendingPaneOutputs() {
    if (paneOutputFlushTimer) {
      clearTimeout(paneOutputFlushTimer);
      paneOutputFlushTimer = null;
    }
    if (!paneOutputPending.size) return;
    const pending = new Map(paneOutputPending);
    paneOutputPending.clear();
    set((state) => ({
      terminalPanes: state.terminalPanes.map((pane) => {
        const chunks = pending.get(pane.id);
        if (!chunks || !chunks.length) return pane;
        return { ...pane, output: `${pane.output || ''}${chunks.join('')}`.slice(-200000) };
      }),
    }));
  },

  appendTimelineEvent(eventType, payload) {
    get().appendThreadTimelineEvent(get().activeThreadId, eventType, payload);
  },

  closeAssistantStream() {
    const threadId = get().activeThreadId;
    get().flushThreadTimelineCoalesce?.(threadId);
    const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
    get().patchThreadRuntime(threadId, { timeline: closeAssistantStream(runtime.timeline) });
  },

  handleThreadSessionReset(threadId, newSessionId) {
    const normalizedSessionId = String(newSessionId || '').trim();
    if (!threadId || !normalizedSessionId) return Promise.resolve(false);
    return queueThreadMutation(threadId, async () => {
      const initialState = get();
      const thread = initialState.threadsById[threadId];
      const project = thread ? initialState.projectsById[thread.projectId] : null;
      if (!thread || !project) return false;
      const existingRuntime = initialState.threadRuntimeById[threadId] || emptyThreadRuntime();
      if (thread.sessionId === normalizedSessionId && existingRuntime.connectionState === 'connected') return true;
      // Keep prompts queued before the reset: wiping them silently drops user
      // input that was pending when the backend rebuilt the session. The queue
      // is re-dispatched on the fresh session once it is connected (below).
      const preservedPromptQueue =
        existingRuntime.promptQueue && existingRuntime.promptQueue.length
          ? existingRuntime.promptQueue
          : thread.metadata?.promptQueue || [];

      const previousSessionId = thread.sessionId || null;
      const resetAt = new Date().toISOString();
      const resetRuntime = {
        ...emptyThreadRuntime(),
        sessionId: normalizedSessionId,
        promptQueue: preservedPromptQueue,
        connectionState: 'connecting',
        availableCommands: existingRuntime.availableCommands,
        models: existingRuntime.models,
        modes: existingRuntime.modes,
        currentModel: existingRuntime.currentModel || thread.modelId || null,
        currentMode: existingRuntime.currentMode || thread.modeId || 'default',
        capabilities: existingRuntime.capabilities,
        historyReplayActive: true,
      };

      set((state) => {
        const current = state.threadsById[threadId];
        if (!current || current.projectId !== project.id) return {};
        return {
          threadsById: {
            ...state.threadsById,
            [threadId]: {
              ...current,
              sessionId: normalizedSessionId,
              title: '新对话',
              draft: '',
              timeline: [],
              status: 'connecting',
              unread: false,
              metadata: {
                ...(current.metadata || {}),
                promptQueue: preservedPromptQueue,
                previousSessionId,
                sessionResetAt: resetAt,
                sessionResetLoadError: null,
                lastError: null,
              },
              updatedAt: resetAt,
            },
          },
          ...(state.activeThreadId === threadId
            ? {
                sessionId: normalizedSessionId,
                sessionTitle: '新对话',
                error: null,
              }
            : {}),
        };
      });
      // 丢弃旧会话遗留的隐藏窗口 coalesce 缓冲：resetRuntime 携带 timeline:[]（清空
      // 语义），不先消费掉条目的话 patchThreadRuntime 的折叠会把旧会话的 chunk
      // 重新写进"新对话"的 runtime。flush 先落地随后即被 [] 覆盖，语义正确。
      get().flushThreadTimelineCoalesce?.(threadId);
      get().patchThreadRuntime(threadId, resetRuntime);
      await get().persistProductState();

      const client = conversations.peek(threadId) || get().getThreadClient(threadId);
      if (!client?.connected) {
        const message = 'CodeBuddy 已重置会话，但 ACP 连接不可用，请重新连接。';
        get().patchThreadRuntime(threadId, { connectionState: 'error', historyReplayActive: false });
        await get().updateThreadRecord(threadId, {
          status: 'error',
          metadata: {
            ...(get().threadsById[threadId]?.metadata || {}),
            sessionResetLoadError: message,
            lastError: message,
          },
        });
        if (get().activeThreadId === threadId) set({ connectionState: 'error', error: message });
        return false;
      }

      try {
        const loaded = await client.request('session/load', {
          sessionId: normalizedSessionId,
          cwd: project.workspacePath || '.',
          mcpServers: [],
        });
        const currentThread = get().threadsById[threadId];
        if (!currentThread || currentThread.sessionId !== normalizedSessionId) return true;
        const currentRuntime = get().threadRuntimeById[threadId] || resetRuntime;
        const configPatch = get().applySessionConfigUpdate(loaded?.configOptions || [], {
          previousModels: currentRuntime.models,
        });
        const models = normalizeModels(loaded?.models?.availableModels || currentRuntime.models, currentRuntime.models);
        const modes = normalizeModes(loaded?.modes?.availableModes || currentRuntime.modes);
        const persistedModel = currentRuntime.currentModel || currentThread.modelId;
        const cliCurrentModel = loaded?.models?.currentModelId || configPatch.currentModel || null;
        let currentModel =
          resolveAvailableSelection(models, persistedModel) ||
          resolveAvailableSelection(models, cliCurrentModel) ||
          cliCurrentModel;
        const persistedMode = currentRuntime.currentMode || currentThread.modeId;
        const cliCurrentMode = loaded?.modes?.currentModeId || configPatch.currentMode || null;
        let currentMode =
          resolveAvailableSelection(modes, persistedMode) ||
          resolveAvailableSelection(modes, cliCurrentMode) ||
          cliCurrentMode ||
          'default';
        const title = loaded?.title || loaded?.name || '新对话';
        // 会话重置后 CLI 可能回到 default；GUI 保留的 mode/model 必须写回 CLI。
        if (currentMode && currentMode !== cliCurrentMode) {
          try {
            await client.request('session/set_mode', {
              sessionId: normalizedSessionId,
              modeId: currentMode,
            });
          } catch (modeError) {
            console.warn(
              `[session-reset] failed to sync mode ${currentMode} to CLI:`,
              modeError?.message || modeError,
            );
            currentMode = cliCurrentMode || 'default';
          }
        }
        if (currentModel && currentModel !== cliCurrentModel) {
          try {
            await client.request('session/set_model', {
              sessionId: normalizedSessionId,
              modelId: currentModel,
            });
          } catch (modelError) {
            console.warn(
              `[session-reset] failed to sync model ${currentModel} to CLI:`,
              modelError?.message || modelError,
            );
            currentModel = cliCurrentModel || currentModel;
          }
        }
        get().patchThreadRuntime(threadId, {
          connectionState: 'connected',
          models,
          modes,
          currentModel,
          currentMode,
          historyReplayActive: false,
          agentPhase: null,
          progress: null,
          ...(configPatch.thoughtLevel != null ? { thoughtLevel: configPatch.thoughtLevel } : {}),
          ...(configPatch.thoughtLevelOptions
            ? { thoughtLevelOptions: configPatch.thoughtLevelOptions }
            : {}),
        });
        set((state) => {
          const current = state.threadsById[threadId];
          if (!current || current.sessionId !== normalizedSessionId) return {};
          return {
            threadsById: {
              ...state.threadsById,
              [threadId]: {
                ...current,
                title,
                modelId: currentModel || null,
                modeId: currentMode,
                status: 'idle',
                metadata: { ...(current.metadata || {}), sessionResetLoadError: null, lastError: null },
                updatedAt: new Date().toISOString(),
              },
            },
            ...(state.activeThreadId === threadId
              ? {
                  sessionId: normalizedSessionId,
                  sessionTitle: title,
                  currentModel,
                  currentMode,
                  connectionState: 'connected',
                  error: null,
                  ...(configPatch.thoughtLevel != null ? { thoughtLevel: configPatch.thoughtLevel } : {}),
                  ...(configPatch.thoughtLevelOptions
                    ? { thoughtLevelOptions: configPatch.thoughtLevelOptions }
                    : {}),
                }
              : {}),
          };
        });
        await get().persistProductState();
        if (preservedPromptQueue.length) {
          // Re-dispatch prompts that were queued when the session reset hit;
          // drainThreadPromptQueue guards busy/connecting states itself.
          setTimeout(() => get().drainThreadPromptQueue(threadId), 0);
        }
        if (get().activeProjectId === project.id)
          await get()
            .refreshSessions()
            .catch(() => false);
        return true;
      } catch (error) {
        const currentThread = get().threadsById[threadId];
        if (!currentThread || currentThread.sessionId !== normalizedSessionId) return false;
        const message = 'CodeBuddy 会话已重置，但刷新新会话信息失败: ' + (error?.message || '未知错误');
        get().patchThreadRuntime(threadId, {
          connectionState: 'connected',
          historyReplayActive: false,
          agentPhase: null,
          progress: null,
        });
        get().appendThreadTimelineEvent(threadId, 'error', { type: 'error', message });
        set((state) => {
          const current = state.threadsById[threadId];
          if (!current || current.sessionId !== normalizedSessionId) return {};
          return {
            threadsById: {
              ...state.threadsById,
              [threadId]: {
                ...current,
                status: 'idle',
                metadata: { ...(current.metadata || {}), sessionResetLoadError: message, lastError: message },
                updatedAt: new Date().toISOString(),
              },
            },
            ...(state.activeThreadId === threadId
              ? {
                  sessionId: normalizedSessionId,
                  sessionTitle: current.title || '新对话',
                  connectionState: 'connected',
                  error: message,
                }
              : {}),
          };
        });
        await get().persistProductState();
        return false;
      }
    });
  },

  bootstrap() {
    if (bootstrapOperation) return bootstrapOperation;
    const operation = (async () => {
      const authRequest = ++authRequestVersion;
      // Before starting runtime: align site with disk OAuth (e.g. www.codebuddy.cn → cn).
      await get().syncAccountLoginSiteFromDiskAuth?.().catch?.(() => null);
      if (authRequest !== authRequestVersion) return false;
      if (!routeListenerBound) {
        routeListenerBound = true;
        window.addEventListener('hashchange', () => {
          set({ route: parseHashRoute() });
        });
      }
      if (!authFailureListenerBound) {
        authFailureListenerBound = true;
        window.addEventListener('codebuddy:auth-required', () => {
          authRequestVersion += 1;
          setAcpSessionToken(null);
          setAuthToken(null);
          conversations.disposeAll().catch(() => null);
          set({
            authViewState: 'login',
            authSubmitting: false,
            authError: '登录已失效，请重新登录',
            sessionId: null,
            sessionToken: null,
            connectionState: 'disconnected',
          });
          const projectId = get().activeProjectId;
          if (projectId)
            get()
              .disconnectProjectThreads(projectId)
              .catch(() => null);
        });
      }

      // 1. 先恢复本地产品状态，再按活动项目惰性启动对应运行时。
      get().loadSettingsFromStorage();
      if (!get().productStateLoaded) await get().hydrateProductState();
      if (authRequest !== authRequestVersion) return false;
      if (!runtimeListenerBound && window.electronAPI?.onProjectRuntimeStatus) {
        runtimeListenerBound = true;
        window.electronAPI.onProjectRuntimeStatus((runtime) => get().applyProjectRuntimeStatus(runtime));
      }
      const projectId = get().activeProjectId;
      if (projectId) {
        const runtime = await get().ensureProjectRuntime(projectId);
        if (authRequest !== authRequestVersion || get().activeProjectId !== projectId) return false;
        if (!runtime) {
          set({ authViewState: 'authenticated' });
          return false;
        }
      } else {
        set({ authViewState: 'authenticated', connectionState: 'disconnected' });
        return true;
      }

      // 2. 鉴权态：运行时就绪后再检查当前项目服务。
      //      若后端启用鉴权且当前未通过，App.jsx 渲染登录页；通过后才连 AcpClient
      let authState;
      try {
        authState = await apiCheckAuth();
      } catch (error) {
        if (authRequest === authRequestVersion && get().activeProjectId === projectId) {
          set({
            authViewState: 'error',
            authError: error?.message || '无法检查 CodeBuddy 登录状态',
            connectionState: 'error',
          });
        }
        return false;
      }
      if (authRequest !== authRequestVersion || get().activeProjectId !== projectId) return false;
      set({ authViewState: authState, authError: null });
      if (authState === 'login') {
        await get()
          .refreshInfo()
          .catch(() => false);
        // 等登录成功后再继续；App 登录页会调 store.login() 并重触发 bootstrap
        return false;
      }

      if (!conversationEventsBound) {
        conversationEventsBound = true;
        conversations.onEvent((event) => get().handleConversationEvent(event));
      }

      try {
        const isCurrent = () => authRequest === authRequestVersion && get().activeProjectId === projectId;
        const querySessionId = new URLSearchParams(window.location.search).get('sessionId');
        if (!get().activeProjectId || !get().activeThreadId) {
          set({ connectionState: 'disconnected', sessionId: null });
          await Promise.allSettled([
            get().refreshInfo(),
            get().refreshSettings(),
            get().refreshPlugins(),
            get().refreshMetrics(),
            get().refreshStats(),
            get().refreshTraces(),
          ]);
          return isCurrent();
        }
        if (querySessionId) {
          await get().updateActiveThread({ sessionId: querySessionId });
          if (!isCurrent()) return false;
        }
        const initialized = await get().initializeActiveThread(querySessionId || undefined);
        if (!isCurrent() || !initialized) return false;
        await get().initializeWorkspace();
        if (!isCurrent()) return false;
        await get().refreshProjectViews();
        const readyState = get();
        console.info(
          `[bootstrap] connected project=${projectId} thread=${readyState.activeThreadId || ''} models=${readyState.models.length} currentModel=${readyState.currentModel || ''}`,
        );
        return isCurrent();
      } catch (error) {
        if (authRequest === authRequestVersion && get().activeProjectId === projectId) {
          set({ error: error.message, connectionState: 'error' });
        }
        console.warn(`[bootstrap] failed project=${projectId || ''}: ${error?.message || error}`);
        return false;
      }
    })();
    const tracked = operation.finally(() => {
      if (bootstrapOperation === tracked) bootstrapOperation = null;
    });
    bootstrapOperation = tracked;
    return tracked;
  },

  async refreshProjectViews() {
    await Promise.allSettled([
      get().refreshInfo(),
      get().refreshSettings(),
      get().refreshSessions(),
      get().refreshWorkers(),
      get().refreshPlugins(),
      get().refreshMarketplaces(),
      get().refreshMetrics(),
      get().refreshStats(),
      get().refreshTasks(),
      get().refreshTraces(),
      get().syncWorkspaceExtraDirs(),
    ]);
  },

  async setAccountLoginSite(site) {
    const normalized = normalizeAccountLoginSite(site);
    if (get().guiSettings?.accountLoginSite === normalized) return true;
    return get().updateGuiSetting('accountLoginSite', normalized);
  },

  /**
   * Align GUI site preference with on-disk CLI OAuth domain (www.codebuddy.cn → cn).
   * Prevents spawn env fighting the token product environment.
   */
  async syncAccountLoginSiteFromDiskAuth() {
    if (!window.electronAPI?.getCliDiskAuth) return null;
    try {
      const disk = await window.electronAPI.getCliDiskAuth();
      const site =
        disk?.site === 'cn' || disk?.site === 'global'
          ? disk.site
          : disk?.resolvedSite === 'cn' || disk?.resolvedSite === 'global'
            ? disk.resolvedSite
            : null;
      if (!site) return null;
      if (get().guiSettings?.accountLoginSite !== site) {
        await get().setAccountLoginSite(site);
      }
      if (disk?.nickname || disk?.userId) {
        const lastAccountUser = normalizeLastAccountUser({
          userNickname: disk.nickname,
          userId: disk.userId,
        });
        if (lastAccountUser) {
          const nextGui = saveGuiSettings({
            ...get().guiSettings,
            accountLoginSite: site,
            lastAccountUser,
          });
          set({ guiSettings: nextGui });
        }
      }
      return site;
    } catch (_) {
      return null;
    }
  },

  async authenticateCodeBuddyAccount(options = {}) {
    if (get().codeBuddyAccountAuthState === 'authenticating') return false;
    const projectId = get().activeProjectId;
    const threadId = get().activeThreadId;
    const requestedSite =
      options?.site != null ? normalizeAccountLoginSite(options.site) : null;
    // Prefer explicit menu choice; otherwise align with disk OAuth before deciding env.
    if (!requestedSite) {
      await get().syncAccountLoginSiteFromDiskAuth();
    }
    const previousSite = normalizeAccountLoginSite(get().guiSettings?.accountLoginSite);
    const authGeneration = (get()._accountAuthGeneration || 0) + 1;
    set({
      codeBuddyAccountAuthState: 'authenticating',
      codeBuddyAccountAuthUrl: null,
      codeBuddyAccountAuthError: null,
      _accountAuthGeneration: authGeneration,
      error: null,
    });
    const isAuthCurrent = () =>
      get()._accountAuthGeneration === authGeneration &&
      get().codeBuddyAccountAuthState === 'authenticating';
    const failAuth = (message, state = 'error') => {
      if (!isAuthCurrent() && get()._accountAuthGeneration !== authGeneration) return false;
      set({
        codeBuddyAccountAuthState: state,
        codeBuddyAccountAuthError: message || null,
        codeBuddyAccountAuthUrl: null,
      });
      return false;
    };
    const markAuthenticatedFromDisk = (disk, accountLoginSite, authMethods = []) => {
      const lastAccountUser = normalizeLastAccountUser({
        userNickname: disk?.nickname,
        userName: disk?.nickname,
        userId: disk?.userId,
      });
      const nextGui = saveGuiSettings({
        ...get().guiSettings,
        accountLoginSite,
        ...(lastAccountUser ? { lastAccountUser } : {}),
      });
      set({
        codeBuddyAccountAuthState: 'authenticated',
        codeBuddyAccountAuthUrl: null,
        codeBuddyAccountAuthError: null,
        codeBuddyAccountUser: lastAccountUser
          ? {
              userNickname: lastAccountUser.userNickname || lastAccountUser.userName,
              userName: lastAccountUser.userName || lastAccountUser.userNickname,
              userId: lastAccountUser.userId,
            }
          : get().codeBuddyAccountUser,
        codeBuddyAccountAuthMethods: authMethods,
        guiSettings: nextGui,
      });
      return lastAccountUser;
    };
    try {
      if (!projectId || !threadId) throw new Error('请先选择一个项目和会话');
      if (requestedSite) {
        await get().setAccountLoginSite(requestedSite);
      }
      if (!isAuthCurrent()) return false;
      let accountLoginSite = normalizeAccountLoginSite(
        requestedSite || get().guiSettings?.accountLoginSite || previousSite,
      );
      // 仅站点真正变化（或 force）时才重启进程，写入 CODEBUDDY_INTERNET_ENVIRONMENT。
      // 站点未变时不要 kill 进程：authenticate 写入的 token 在当前 serve 进程内。
      const siteChanged = requestedSite != null && requestedSite !== previousSite;
      if (siteChanged || options.forceRuntimeRestart) {
        const restartedForSite = await get().restartProjectRuntime(projectId, {
          deferInitializationUntilAuth: true,
          accountLoginSite,
        });
        if (!isAuthCurrent()) return false;
        if (!restartedForSite) throw new Error(get().error || '切换登录站点后运行时重启失败');
      }

      // Soft recover: 磁盘已有有效 OAuth 且未强制重新登录时，先 dispose+bootstrap 复用 token，
      // 不要调 authenticate（CLI 会 "User already logged in, logging out first" 毁掉会话）。
      const forceBrowserLogin = options.forceBrowserLogin === true || siteChanged;
      if (!forceBrowserLogin && window.electronAPI?.getCliDiskAuth) {
        try {
          const disk = await window.electronAPI.getCliDiskAuth();
          const diskSite =
            disk?.site === 'cn' || disk?.site === 'global'
              ? disk.site
              : disk?.resolvedSite === 'cn' || disk?.resolvedSite === 'global'
                ? disk.resolvedSite
                : null;
          if (diskSite && (disk?.nickname || disk?.userId || disk?.domain)) {
            if (diskSite) accountLoginSite = diskSite;
            markAuthenticatedFromDisk(disk, accountLoginSite, []);
            const thread = get().threadsById[threadId];
            if (thread?.metadata?.authRequired || thread?.metadata?.lastError) {
              await get().updateThreadRecord(threadId, {
                metadata: {
                  ...(thread.metadata || {}),
                  authRequired: false,
                  lastError: null,
                },
              });
            }
            await conversations.disposeAll();
            const connected = await get().bootstrap();
            if (!isAuthCurrent() && get()._accountAuthGeneration !== authGeneration) return false;
            if (connected && get().codeBuddyAccountAuthState !== 'required') {
              set({
                codeBuddyAccountAuthState: 'authenticated',
                codeBuddyAccountAuthError: null,
              });
              return true;
            }
            // bootstrap 仍报鉴权失败：继续走浏览器登录。
            if (!isAuthCurrent()) {
              set({
                codeBuddyAccountAuthState: 'authenticating',
                codeBuddyAccountAuthError: null,
              });
            }
          }
        } catch (_) {
          /* fall through to browser authenticate */
        }
      }

      let client = conversations.peek(threadId) || get().getThreadClient(threadId);
      if (!client) throw new Error('内置 CodeBuddy CLI 尚未就绪');
      if (!client.connected) await client.connect();
      if (!isAuthCurrent()) return false;
      if (!client.initialized) await client.initialize();
      if (!isAuthCurrent()) return false;
      if (projectId !== get().activeProjectId || threadId !== get().activeThreadId) {
        return failAuth('登录已取消（会话已切换）', 'required');
      }

      const authMethods = Array.isArray(client.authMethods) ? client.authMethods : [];
      // 国内站优先 internal；国外站优先 external。method 成功后以 method 校正站点偏好。
      const methodId = pickAuthMethodId(authMethods, accountLoginSite);
      const result = await client.authenticate(methodId);
      if (!isAuthCurrent()) return false;
      if (projectId !== get().activeProjectId || threadId !== get().activeThreadId) {
        return failAuth('登录已取消（会话已切换）', 'required');
      }
      const methodSite = accountLoginSiteFromAuthMethodId(methodId);
      if (methodSite) accountLoginSite = methodSite;
      // 登录成功后立刻与磁盘 auth 对齐（domain=www.codebuddy.cn → cn）
      const diskSite = await get().syncAccountLoginSiteFromDiskAuth();
      if (diskSite) accountLoginSite = diskSite;

      const userinfo = result?._meta?.['codebuddy.ai/userinfo'] || result?.userinfo || null;
      const lastAccountUser = normalizeLastAccountUser(userinfo);
      const nextGui = saveGuiSettings({
        ...get().guiSettings,
        accountLoginSite,
        lastAccountUser,
      });
      set({
        codeBuddyAccountAuthState: 'authenticated',
        codeBuddyAccountAuthUrl: null,
        codeBuddyAccountAuthError: null,
        codeBuddyAccountUser: userinfo,
        codeBuddyAccountAuthMethods: authMethods,
        guiSettings: nextGui,
      });
      // 清掉会话上的鉴权失败标记，避免恢复后仍显示旧 lastError
      const thread = get().threadsById[threadId];
      if (thread?.metadata?.authRequired || thread?.metadata?.lastError) {
        await get().updateThreadRecord(threadId, {
          metadata: {
            ...(thread.metadata || {}),
            authRequired: false,
            lastError: null,
          },
        });
      }
      // 登录成功后：若站点相对登录前变化，必须重启 runtime 才能让后续 prompt 读到正确 env + token。
      // 站点未变则只 dispose ACP 连接并 bootstrap，避免无谓 kill。
      await conversations.disposeAll();
      const needRuntimeRestartForSite =
        siteChanged ||
        options.forceRuntimeRestart ||
        (methodSite && methodSite !== previousSite) ||
        (diskSite && diskSite !== previousSite);
      if (needRuntimeRestartForSite) {
        const restarted = await get().restartProjectRuntime(projectId, {
          deferInitializationUntilAuth: true,
          accountLoginSite,
        });
        if (!restarted) throw new Error(get().error || '登录成功后运行时重启失败');
      }
      const connected = await get().bootstrap();
      if (!connected) {
        const state = get();
        if (state.codeBuddyAccountAuthState === 'required') {
          // 会话恢复仍要登录：保留刚拿到的用户缓存，方便侧栏展示「上次登录」
          if (lastAccountUser) {
            const kept = saveGuiSettings({
              ...get().guiSettings,
              accountLoginSite,
              lastAccountUser,
            });
            set({
              guiSettings: kept,
              codeBuddyAccountUser: userinfo || get().codeBuddyAccountUser,
            });
          }
          return false;
        }
        throw new Error(state.error || 'CodeBuddy 登录成功，但会话恢复失败');
      }
      // bootstrap 可能把 auth 清成 unknown；若未再要求登录则保持 authenticated
      if (get().codeBuddyAccountAuthState !== 'required' && get().codeBuddyAccountAuthState !== 'error') {
        set({
          codeBuddyAccountAuthState: 'authenticated',
          codeBuddyAccountAuthError: null,
          codeBuddyAccountUser: userinfo || get().codeBuddyAccountUser,
        });
      }
      return get().codeBuddyAccountAuthState === 'authenticated';
    } catch (error) {
      if (get()._accountAuthGeneration !== authGeneration) return false;
      const cancelled =
        /cancelled by user|登录已取消|ACP request cancelled/i.test(String(error?.message || ''));
      const message = cancelled
        ? '已取消登录'
        : error?.type === 'timeout' || /idle timeout|timeout: authenticate/i.test(String(error?.message || ''))
          ? 'CodeBuddy 登录等待超时，请重新发起登录'
          : error?.message || 'CodeBuddy 登录失败';
      set({
        codeBuddyAccountAuthState: cancelled ? 'required' : 'error',
        codeBuddyAccountAuthError: cancelled ? null : message,
        codeBuddyAccountAuthUrl: null,
      });
      return false;
    }
  },

  cancelCodeBuddyAccountAuth() {
    const generation = (get()._accountAuthGeneration || 0) + 1;
    const threadId = get().activeThreadId;
    const client = threadId
      ? conversations.peek(threadId) || get().getThreadClient?.(threadId)
      : null;
    try {
      client?.cancelAllActivePrompts?.();
    } catch (_) {
      /* best-effort */
    }
    set({
      _accountAuthGeneration: generation,
      codeBuddyAccountAuthState: 'required',
      codeBuddyAccountAuthError: null,
      codeBuddyAccountAuthUrl: null,
    });
    return true;
  },

  /**
   * 处理 CLI 的 ACP 扩展通知 `_codebuddy.ai/authUrl`（登录链接推送）。
   * 真实 Desktop 也依赖此机制打开登录页；Windows 上 CLI 自带的
   * `rundll32 url,OpenURL` 打开浏览器会静默失败（退出码 0 但无窗口），
   * 所以必须由 GUI 用 shell.openExternal 打开，并在侧栏保留可点击兜底链接。
   * 仅登录进行中（authenticating）处理，避免把 /upgrade 等其他外部链接
   * 误当成登录页打开。
   */
  handleAccountAuthUrl(detail = {}) {
    const authUrl = String(detail?.authUrl || detail?.url || '').trim();
    if (!/^https?:\/\//i.test(authUrl)) return false;
    if (get().codeBuddyAccountAuthState !== 'authenticating') return false;
    const previous = get().codeBuddyAccountAuthUrl;
    set({
      codeBuddyAccountAuthUrl: authUrl,
      codeBuddyAccountAuthError: null,
    });
    // 同一 URL 重复推送不重复开浏览器（重试/通知重连时避免多开标签页）；
    // 打开失败时侧栏仍有可点击的登录链接兜底。
    if (authUrl !== previous && window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(authUrl).catch(() => {});
    }
    return true;
  },

  async refreshInfo() {
    const request = beginScopedRequest('info', get());
    let payloadInfo = null;
    try {
      const payload = await fetchJson('/api/v1/info');
      if (!isScopedRequestCurrent(request, get())) return false;
      payloadInfo = payload.data || payload || null;
    } catch (_) {
      payloadInfo = null;
    }

    const runtimeVersion =
      payloadInfo &&
      typeof payloadInfo === 'object' &&
      payloadInfo.version != null &&
      String(payloadInfo.version).trim()
        ? String(payloadInfo.version).trim()
        : null;

    if (runtimeVersion) {
      set({ info: payloadInfo, infoLoaded: true });
      return true;
    }

    // 运行时 info 失败或无 version（未鉴权常见）时，用本机 CLI --version 回落。
    let cliVersion = null;
    if (window.electronAPI?.getCliMaintenanceInfo) {
      try {
        const cliInfo = await window.electronAPI.getCliMaintenanceInfo();
        if (!isScopedRequestCurrent(request, get())) return false;
        cliVersion = cliInfo?.version || null;
      } catch (_) {
        /* keep previous version if any */
      }
    }

    if (!isScopedRequestCurrent(request, get())) return false;
    set((state) => ({
      info: {
        ...(state.info || {}),
        ...(payloadInfo && typeof payloadInfo === 'object' ? payloadInfo : {}),
        version: cliVersion || state.info?.version || null,
      },
      infoLoaded: true,
    }));
    return true;
  },

  async refreshSettings() {
    const request = beginScopedRequest('settings', get());
    // WebUI 2.124: dual GET — effective settings for UI (v) + user scope baseline (A.current).
    const [effectivePayload, userPayload] = await Promise.all([
      fetchJson('/api/v1/settings'),
      fetchJson('/api/v1/settings?scope=user').catch(() => null),
    ]);
    if (!isScopedRequestCurrent(request, get())) return false;
    const loaded = stripGuiSettings(effectivePayload?.data || effectivePayload || {});
    const userBaseline = stripGuiSettings(
      userPayload == null ? {} : (userPayload.data || userPayload || {}),
    );
    const projectKey = request.projectId || 'global';
    userSettingsBaselineByProject.set(projectKey, userBaseline);
    const projectPrefix = `${projectKey}:`;
    for (const storedKey of confirmedSettingValues.keys()) {
      if (storedKey.startsWith(projectPrefix)) confirmedSettingValues.delete(storedKey);
    }
    for (const [key, value] of Object.entries(loaded || {})) {
      confirmedSettingValues.set(settingScopeKey(request.projectId, key), value);
    }
    persistSettingsCache(loaded);
    set({ settings: loaded, settingsLoaded: true });
    return true;
  },

  loadSettingsFromStorage() {
    try {
      const raw = localStorage.getItem(SETTINGS_CACHE_KEY);
      if (raw) {
        const parsed = settingsCacheSnapshot(JSON.parse(raw));
        persistSettingsCache(parsed);
        set({ settings: parsed });
      }
    } catch (_) {}
  },

  async updateGuiSetting(key, value) {
    if (!isGuiSettingKey(key)) return false;
    try {
      const next = saveGuiSettings({ ...get().guiSettings, [key]: value });
      set({ guiSettings: next });
      if (window.electronAPI?.saveProductState) {
        const persisted = await get().persistProductState();
        if (!persisted) throw new Error(get().error || '产品状态保存失败');
      }
      return true;
    } catch (error) {
      set({ error: `GUI 设置保存失败: ${error.message}` });
      return false;
    }
  },

  // 乐观更新 UI，后端失败时回滚到最后一次确认值。版本号避免迟到响应覆盖更新的操作。
  async updateSetting(key, value) {
    // promptSuggestionEnabled is a CLI user setting in WebUI; keep local GUI flag
    // writable only via updateGuiSetting for backward compatibility.
    if (isGuiSettingKey(key) && key !== 'promptSuggestionEnabled') {
      return get().updateGuiSetting(key, value);
    }
    const state = get();
    const projectId = state.activeProjectId;
    const apiBase = state.apiBase;
    const requestContext = {
      authToken: getAuthToken(),
      acpSessionToken: getAcpSessionToken(),
    };
    const writeKey = settingScopeKey(projectId, key);
    const version = (settingWriteVersions.get(writeKey) || 0) + 1;
    settingWriteVersions.set(writeKey, version);
    if (!confirmedSettingValues.has(writeKey)) {
      confirmedSettingValues.set(writeKey, readSettingPath(state.settings, key));
    }

    set((state) => {
      const next = writeSettingPath(state.settings, key, value);
      persistSettingsCache(next);
      return { settings: next, settingsLoaded: true };
    });

    // WebUI: nested keys (memory.enabled) PUT root key with object merged from user baseline (A.current).
    const rootKey = String(key).split('.')[0];
    const projectKey = projectId || 'global';
    const baselineRoot = userSettingsBaselineByProject.get(projectKey) || {};
    const apiValue = key.includes('.')
      ? writeSettingPath(
          { [rootKey]: baselineRoot[rootKey] && typeof baselineRoot[rootKey] === 'object' && !Array.isArray(baselineRoot[rootKey])
            ? { ...baselineRoot[rootKey] }
            : {} },
          key,
          value,
        )[rootKey]
      : value;

    const previousWrite = settingWriteChains.get(writeKey) || Promise.resolve();
    const operation = previousWrite
      .catch(() => {})
      .then(async () => {
        try {
          // Nested: re-merge from latest user baseline so concurrent nested writes race cleanly.
          let payloadValue = value;
          if (key.includes('.')) {
            const liveBaseline = userSettingsBaselineByProject.get(projectKey) || {};
            payloadValue = writeSettingPath(
              {
                [rootKey]:
                  liveBaseline[rootKey] && typeof liveBaseline[rootKey] === 'object' && !Array.isArray(liveBaseline[rootKey])
                    ? { ...liveBaseline[rootKey] }
                    : {},
              },
              key,
              value,
            )[rootKey];
          }
          await updateSettingByKeyApi(rootKey, payloadValue ?? apiValue, 'user', apiBase, requestContext);
          // Keep A.current in sync with successful user-scope write (WebUI A.current[ee]=re).
          const nextBaseline = { ...(userSettingsBaselineByProject.get(projectKey) || {}) };
          nextBaseline[rootKey] = key.includes('.') ? payloadValue : value;
          userSettingsBaselineByProject.set(projectKey, nextBaseline);
          confirmedSettingValues.set(writeKey, value);
          if (settingWriteVersions.get(writeKey) === version && projectId === get().activeProjectId) {
            set((current) => {
              const next = writeSettingPath(current.settings, key, value);
              persistSettingsCache(next);
              return { settings: next, settingsLoaded: true };
            });
          }
          // 用户默认模型 / 推理努力：在已连接会话上同步到当前 ACP 会话，避免「设了但不生效」。
          // 失败不回滚用户 settings（用户级已成功），仅 best-effort。
          if (projectId === get().activeProjectId && get().sessionId && get().connectionState === 'connected') {
            if (key === 'model' && value) {
              try {
                await get().setModel(String(value));
              } catch (_) {
                /* session may be busy */
              }
            }
            if (key === 'reasoningEffort' && value) {
              const level = String(value);
              const options = get().thoughtLevelOptions || [];
              const known =
                options.some((item) => (item.id || item.value) === level) ||
                ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'disabled', 'enabled'].includes(level);
              if (known) {
                try {
                  await get().setThoughtLevel(level);
                } catch (_) {
                  /* session may be busy or option unsupported */
                }
              }
            }
          }
          return true;
        } catch (err) {
          if (settingWriteVersions.get(writeKey) === version && projectId === get().activeProjectId) {
            const confirmedValue = confirmedSettingValues.get(writeKey);
            set((state) => {
              const next = writeSettingPath(state.settings, key, confirmedValue, confirmedValue === undefined);
              persistSettingsCache(next);
              return {
                settings: next,
                settingsLoaded: true,
                error: `设置保存失败，已恢复原值: ${err.message}`,
              };
            });
          }
          return false;
        }
      });
    settingWriteChains.set(writeKey, operation);

    try {
      return await operation;
    } finally {
      if (settingWriteChains.get(writeKey) === operation) settingWriteChains.delete(writeKey);
      if (settingWriteVersions.get(writeKey) === version) settingWriteVersions.delete(writeKey);
    }
  },

  async refreshSessions() {
    const request = beginScopedRequest('sessions', get());
    const projectId = request.projectId;
    const payload = await fetchJson('/api/v1/sessions');
    if (!isScopedRequestCurrent(request, get())) return false;
    const sessions = normalizeSessions(payload);
    if (!projectId) {
      set({ sessions });
      return true;
    }
    set((state) => {
      const deletedSessionIds = new Set(deletedSessionIdsForProject(state.projectsById[projectId]));
      const visibleSessions = sessions.filter((session) => !deletedSessionIds.has(session.id || session.sessionId));
      const threadsById = { ...state.threadsById };
      const order = [...(state.threadOrderByProject[projectId] || [])];
      // M-perf: index this project's threads by sessionId once — the previous
      // per-session Object.values(...).find(...) was O(sessions × threads).
      const threadBySessionId = new Map();
      for (const thread of Object.values(threadsById)) {
        if (thread.projectId === projectId && thread.sessionId) {
          threadBySessionId.set(thread.sessionId, thread);
        }
      }
      for (const session of visibleSessions) {
        const sessionId = session.id || session.sessionId;
        if (!sessionId) continue;
        let thread = threadBySessionId.get(sessionId);
        if (!thread) {
          thread = createThreadRecord(projectId, {
            sessionId,
            title: session.name || session.title || sessionId,
          });
          threadsById[thread.id] = thread;
          threadBySessionId.set(sessionId, thread);
          order.push(thread.id);
        } else if ((session.name || session.title) && thread.title !== (session.name || session.title)) {
          threadsById[thread.id] = {
            ...thread,
            title: session.name || session.title,
            updatedAt: new Date().toISOString(),
          };
        }
      }
      return {
        sessions: visibleSessions,
        threadsById,
        threadOrderByProject: { ...state.threadOrderByProject, [projectId]: order },
      };
    });
    get().persistProductState();
    return true;
  },

  async refreshWorkers() {
    const request = beginScopedRequest('workers', get());
    try {
      const payload = await fetchJson('/api/v1/workers');
      if (!isScopedRequestCurrent(request, get())) return false;
      set({ workers: normalizeWorkers(payload), workersError: null });
      return true;
    } catch (error) {
      if (!isScopedRequestCurrent(request, get())) return false;
      set({ workersError: error.message || '加载 Worker 失败' });
      return false;
    }
  },

  async refreshPlugins() {
    const request = beginScopedRequest('plugins', get());
    try {
      const payload = await fetchJson('/api/v1/plugins');
      if (!isScopedRequestCurrent(request, get())) return false;
      set({ plugins: normalizePlugins(payload), pluginError: null });
      return true;
    } catch (error) {
      if (!isScopedRequestCurrent(request, get())) return false;
      set({ pluginError: error?.message || '加载插件失败' });
      return false;
    }
  },

  async refreshMarketplaces() {
    const request = beginScopedRequest('marketplaces', get());
    try {
      const list = await apiFetchMarketplaces();
      if (!isScopedRequestCurrent(request, get())) return false;
      set({ marketplaces: Array.isArray(list) ? list : [], marketplaceError: null });
      return true;
    } catch (error) {
      if (!isScopedRequestCurrent(request, get())) return false;
      set({ marketplaceError: error?.message || '加载插件市场失败' });
      return false;
    }
  },

  async installPluginByName(pluginId, marketplace, options = {}) {
    const qualifiedPlugin = qualifyPluginId(pluginId, marketplace);
    const projectId = get().activeProjectId;
    const busyKey = `install:${qualifiedPlugin}`;
    set({ pluginBusy: busyKey, pluginError: null });
    try {
      await apiInstallPlugin(pluginId, marketplace, options);
      if (projectId === get().activeProjectId) await get().refreshPlugins();
      if (projectId === get().activeProjectId && get().pluginBusy === busyKey) set({ pluginBusy: null });
      return true;
    } catch (err) {
      if (projectId === get().activeProjectId && get().pluginBusy === busyKey) {
        set({ pluginBusy: null, pluginError: err?.message || '安装插件失败' });
      }
      return false;
    }
  },

  async uninstallPluginByName(pluginName, marketplace) {
    const projectId = get().activeProjectId;
    const busyKey = `uninstall:${pluginName}`;
    set({ pluginBusy: busyKey, pluginError: null });
    try {
      await apiUninstallPlugin(pluginName, marketplace);
      if (projectId === get().activeProjectId) await get().refreshPlugins();
      if (projectId === get().activeProjectId && get().pluginBusy === busyKey) set({ pluginBusy: null });
      return true;
    } catch (err) {
      if (projectId === get().activeProjectId && get().pluginBusy === busyKey) {
        set({ pluginBusy: null, pluginError: err?.message || '卸载插件失败' });
      }
      return false;
    }
  },

  async togglePluginByName(pluginName, enabled, marketplace) {
    const projectId = get().activeProjectId;
    const busyKey = `toggle:${pluginName}`;
    set({ pluginBusy: busyKey, pluginError: null });
    try {
      if (enabled) await apiEnablePlugin(pluginName, marketplace);
      else await apiDisablePlugin(pluginName, marketplace);
      if (projectId === get().activeProjectId) await get().refreshPlugins();
      if (projectId === get().activeProjectId && get().pluginBusy === busyKey) set({ pluginBusy: null });
      return true;
    } catch (err) {
      if (projectId === get().activeProjectId && get().pluginBusy === busyKey) {
        set({ pluginBusy: null, pluginError: err?.message || (enabled ? '启用插件失败' : '禁用插件失败') });
      }
      return false;
    }
  },

  async addMarketplaceById(id, config) {
    const projectId = get().activeProjectId;
    const busyKey = `addMkt:${id}`;
    set({ pluginBusy: busyKey, marketplaceError: null });
    try {
      const payload = { ...(config || {}) };
      if (payload.autoUpdate === undefined) payload.autoUpdate = false;
      await apiAddMarketplace(id, payload);
      if (projectId === get().activeProjectId) await get().refreshMarketplaces();
      if (projectId === get().activeProjectId && get().pluginBusy === busyKey) set({ pluginBusy: null });
      return true;
    } catch (err) {
      if (projectId === get().activeProjectId && get().pluginBusy === busyKey) {
        set({ pluginBusy: null, marketplaceError: err?.message || '新增市场失败' });
      }
      return false;
    }
  },

  async removeMarketplaceById(id) {
    const projectId = get().activeProjectId;
    const busyKey = `rmMkt:${id}`;
    set({ pluginBusy: busyKey, marketplaceError: null });
    try {
      await apiRemoveMarketplace(id);
      if (projectId === get().activeProjectId) await get().refreshMarketplaces();
      if (projectId === get().activeProjectId && get().pluginBusy === busyKey) set({ pluginBusy: null });
      return true;
    } catch (err) {
      if (projectId === get().activeProjectId && get().pluginBusy === busyKey) {
        set({ pluginBusy: null, marketplaceError: err?.message || '删除市场失败' });
      }
      return false;
    }
  },

  async updateMarketplaceById(id, force = false) {
    const marketplaceId = String(id || '').trim();
    if (!marketplaceId) return false;
    const projectId = get().activeProjectId;
    const busyKey = `updateMkt:${marketplaceId}`;
    set({ pluginBusy: busyKey, marketplaceError: null });
    try {
      await apiUpdateMarketplace(marketplaceId, force);
      if (projectId === get().activeProjectId) await get().refreshMarketplaces();
      if (projectId === get().activeProjectId && get().pluginBusy === busyKey) set({ pluginBusy: null });
      return true;
    } catch (err) {
      if (projectId === get().activeProjectId && get().pluginBusy === busyKey) {
        set({ pluginBusy: null, marketplaceError: err?.message || '同步市场失败' });
      }
      return false;
    }
  },
  async syncMarketplaces(force = true) {
    const projectId = get().activeProjectId;
    const list = Array.isArray(get().marketplaces) ? get().marketplaces : [];
    const ids = list.map((item) => item?.id || item?.marketplaceId || item?.name || item?.source).filter(Boolean);
    if (!ids.length) return true;
    const busyKey = 'syncMkt:all';
    set({ pluginBusy: busyKey, marketplaceError: null });
    try {
      const results = await Promise.allSettled(ids.map((id) => apiUpdateMarketplace(id, force)));
      const failed = results.filter((result) => result.status === 'rejected');
      if (failed.length === results.length) throw failed[0]?.reason || new Error('同步市场失败');
      if (projectId === get().activeProjectId) await get().refreshMarketplaces();
      if (projectId === get().activeProjectId && get().pluginBusy === busyKey) set({ pluginBusy: null });
      return failed.length === 0;
    } catch (err) {
      if (projectId === get().activeProjectId && get().pluginBusy === busyKey) {
        set({ pluginBusy: null, marketplaceError: err?.message || '同步市场失败' });
      }
      return false;
    }
  },
  async setMarketplaceAutoUpdateById(id, autoUpdate) {
    const marketplaceId = String(id || '').trim();
    if (!marketplaceId) return false;
    const projectId = get().activeProjectId;
    const busyKey = `autoMkt:${marketplaceId}`;
    set({ pluginBusy: busyKey, marketplaceError: null });
    try {
      await apiSetMarketplaceAutoUpdate(marketplaceId, autoUpdate);
      if (projectId === get().activeProjectId) await get().refreshMarketplaces();
      if (projectId === get().activeProjectId && get().pluginBusy === busyKey) set({ pluginBusy: null });
      return true;
    } catch (err) {
      if (projectId === get().activeProjectId && get().pluginBusy === busyKey) {
        set({ pluginBusy: null, marketplaceError: err?.message || '更新市场自动更新失败' });
      }
      return false;
    }
  },


  /**
   * Update plugin: HTTP first, then CLI fallback (plan T2).
   * @returns {{ ok: boolean, via?: 'http'|'cli', output?: string, truncated?: boolean, error?: string }}
   */
  async updatePluginByName(pluginId, options = {}) {
    const plugin = qualifyPluginId(pluginId, options.marketplace);
    if (!plugin) return { ok: false, error: '插件 ID 不能为空' };
    const projectId = get().activeProjectId;
    const busyKey = `update:${plugin}`;
    set({ pluginBusy: busyKey, pluginError: null });
    const scope = options.scope || 'user';
    const cwd = options.cwd || get().projectsById[projectId]?.workspacePath || '';
    try {
      try {
        await apiUpdatePluginHttp(plugin, {
          scope,
          waitForApply: options.waitForApply,
        });
        if (projectId === get().activeProjectId) await get().refreshPlugins();
        if (projectId === get().activeProjectId && get().pluginBusy === busyKey) set({ pluginBusy: null });
        return { ok: true, via: 'http', output: 'HTTP 更新已完成' };
      } catch (httpError) {
        if (!cwd) throw httpError;
        const result = await cliUpdateInstalledPlugin({ plugin, scope, cwd });
        if (projectId === get().activeProjectId) await get().refreshPlugins();
        if (projectId === get().activeProjectId && get().pluginBusy === busyKey) set({ pluginBusy: null });
        return {
          ok: true,
          via: 'cli',
          output: result?.output || '',
          truncated: Boolean(result?.truncated),
        };
      }
    } catch (err) {
      const message = err?.message || '更新插件失败';
      if (projectId === get().activeProjectId && get().pluginBusy === busyKey) {
        set({ pluginBusy: null, pluginError: message });
      }
      return { ok: false, error: message };
    }
  },

  _readWorkspaceExtraDirsFromProject(projectId) {
    const project = get().projectsById[projectId];
    return normalizeWorkspaceDirList(project?.preferences?.workspaceExtraDirs);
  },

  async _persistWorkspaceExtraDirs(projectId, dirs) {
    const list = normalizeWorkspaceDirList(dirs);
    const project = get().projectsById[projectId];
    if (!project) return false;
    set((state) => ({
      workspaceExtraDirs: list,
      projectsById: {
        ...state.projectsById,
        [projectId]: {
          ...state.projectsById[projectId],
          preferences: {
            ...(state.projectsById[projectId].preferences || {}),
            workspaceExtraDirs: list,
          },
          updatedAt: new Date().toISOString(),
        },
      },
    }));
    return get().persistProductState();
  },

  async syncWorkspaceExtraDirs(projectId = get().activeProjectId) {
    if (!projectId) {
      set({ workspaceExtraDirs: [], workspaceDirsError: null, workspaceDirsBusy: false });
      return true;
    }
    const dirs = get()._readWorkspaceExtraDirsFromProject(projectId);
    set({
      workspaceExtraDirs: dirs,
      workspaceDirsBusy: true,
      workspaceDirsError: null,
    });
    try {
      const synced = await apiSyncWorkspaceDirs(dirs);
      if (get().activeProjectId !== projectId) return false;
      const next = normalizeWorkspaceDirList(synced);
      set({ workspaceExtraDirs: next, workspaceDirsBusy: false, workspaceDirsError: null });
      if (JSON.stringify(next) !== JSON.stringify(dirs)) {
        await get()._persistWorkspaceExtraDirs(projectId, next);
      }
      return true;
    } catch (error) {
      if (get().activeProjectId !== projectId) return false;
      set({
        workspaceDirsBusy: false,
        workspaceDirsError: error?.message || '同步附加工作目录失败',
      });
      return false;
    }
  },

  async addWorkspaceExtraDir(dirPath) {
    const projectId = get().activeProjectId;
    if (!projectId) return false;
    const path = normalizeWorkspaceDirPath(dirPath);
    if (!path) {
      set({ workspaceDirsError: '工作目录路径不能为空' });
      return false;
    }
    const current = normalizeWorkspaceDirList(get().workspaceExtraDirs);
    if (current.some((item) => item.toLowerCase() === path.toLowerCase())) return true;
    const next = [...current, path];
    set({ workspaceDirsBusy: true, workspaceDirsError: null, workspaceExtraDirs: next });
    try {
      await apiAddWorkspaceDir(path);
      if (get().activeProjectId !== projectId) return false;
      await get()._persistWorkspaceExtraDirs(projectId, next);
      if (get().activeProjectId === projectId) set({ workspaceDirsBusy: false });
      return true;
    } catch (error) {
      if (get().activeProjectId !== projectId) return false;
      set({
        workspaceExtraDirs: current,
        workspaceDirsBusy: false,
        workspaceDirsError: error?.message || '添加附加工作目录失败',
      });
      return false;
    }
  },

  async removeWorkspaceExtraDir(dirPath) {
    const projectId = get().activeProjectId;
    if (!projectId) return false;
    const path = normalizeWorkspaceDirPath(dirPath);
    if (!path) return false;
    const current = normalizeWorkspaceDirList(get().workspaceExtraDirs);
    const next = current.filter((item) => item.toLowerCase() !== path.toLowerCase());
    if (next.length === current.length) return true;
    set({ workspaceDirsBusy: true, workspaceDirsError: null, workspaceExtraDirs: next });
    try {
      await apiRemoveWorkspaceDir(path);
      if (get().activeProjectId !== projectId) return false;
      await get()._persistWorkspaceExtraDirs(projectId, next);
      if (get().activeProjectId === projectId) set({ workspaceDirsBusy: false });
      return true;
    } catch (error) {
      if (get().activeProjectId !== projectId) return false;
      set({
        workspaceExtraDirs: current,
        workspaceDirsBusy: false,
        workspaceDirsError: error?.message || '移除附加工作目录失败',
      });
      return false;
    }
  },

  async chooseAndAddWorkspaceExtraDir() {
    if (!window.electronAPI?.chooseWorkspace) {
      set({ workspaceDirsError: '目录选择不可用（IPC 缺失）' });
      return false;
    }
    let path = null;
    try {
      path = await window.electronAPI.chooseWorkspace();
    } catch (error) {
      set({ workspaceDirsError: error?.message || '目录选择失败' });
      return false;
    }
    if (!path) return null;
    return get().addWorkspaceExtraDir(path);
  },

  async refreshMetrics() {
    const request = beginScopedRequest('metrics', get());
    try {
      const payload = await fetchJson('/api/v1/metrics');
      if (!isScopedRequestCurrent(request, get())) return false;
      set({ metrics: payload.data || payload, metricsError: null });
      return true;
    } catch (error) {
      if (!isScopedRequestCurrent(request, get())) return false;
      set({ metricsError: error?.message || '加载监控数据失败' });
      return false;
    }
  },

  async refreshStats() {
    const request = beginScopedRequest('stats', get());
    set({ statsLoading: true, statsError: null });
    try {
      const stats = await fetchStatsApi();
      if (!isScopedRequestCurrent(request, get())) return false;
      set({ stats, statsLoading: false });
    } catch (err) {
      if (!isScopedRequestCurrent(request, get())) return false;
      set({ statsLoading: false, statsError: err?.message || '加载全局统计失败' });
    }
    // 同时刷新当前会话的会话级统计（失败不阻塞全局）
    get().refreshSessionStats?.();
    return true;
  },

  async refreshSessionStats() {
    const request = beginScopedRequest('sessionStats', get(), 'thread');
    try {
      const sessionStats = await fetchSessionStats(request.sessionId);
      if (!isScopedRequestCurrent(request, get())) return false;
      set({ sessionStats });
    } catch (_) {
      if (!isScopedRequestCurrent(request, get())) return false;
      set({ sessionStats: null });
    }
    return true;
  },

  async refreshTasks() {
    const request = beginScopedRequest('tasks', get(), 'thread');
    try {
      const tasks = await fetchScheduledTasks(request.sessionId);
      if (!isScopedRequestCurrent(request, get())) return false;
      set({ scheduledTasks: tasks, scheduledTasksError: null });
    } catch (error) {
      if (!isScopedRequestCurrent(request, get())) return false;
      set({ scheduledTasksError: error.message || '加载定时任务失败' });
    }
    // 同时刷任务模板（失败不阻塞定时任务）
    get().refreshTaskTemplates?.();
    return true;
  },

  async refreshTaskTemplates() {
    const request = beginScopedRequest('taskTemplates', get(), 'thread');
    set({ taskTemplatesLoading: true, taskTemplatesError: null });
    try {
      const result = await apiFetchTaskTemplates(request.sessionId);
      if (!isScopedRequestCurrent(request, get())) return false;
      set({
        taskTemplates: result.templates || [],
        taskTemplatesError: result.error || null,
        taskTemplatesLoading: false,
      });
    } catch (err) {
      if (!isScopedRequestCurrent(request, get())) return false;
      set({ taskTemplatesLoading: false, taskTemplatesError: err?.message || '加载任务模板失败' });
    }
    return true;
  },

  async refreshTaskTemplatesNow() {
    const request = beginScopedRequest('taskTemplates', get(), 'thread');
    set({ taskTemplatesLoading: true, taskTemplatesError: null });
    try {
      const result = await apiRefreshTaskTemplates(request.sessionId);
      if (!isScopedRequestCurrent(request, get())) return false;
      set({
        taskTemplates: result.templates || [],
        taskTemplatesError: result.error || null,
        taskTemplatesLoading: false,
      });
      return true;
    } catch (err) {
      if (!isScopedRequestCurrent(request, get())) return false;
      set({ taskTemplatesLoading: false, taskTemplatesError: err?.message || '刷新任务模板失败' });
      return false;
    }
  },

  async createTask(cron, prompt) {
    const state = get();
    const projectId = state.activeProjectId;
    const threadId = state.activeThreadId;
    const sessionId = state.sessionId;
    if (!sessionId) throw new Error('当前会话尚未连接');
    if (!String(cron || '').trim()) throw new Error('Cron 表达式不能为空');
    if (!String(prompt || '').trim()) throw new Error('提示词不能为空');
    try {
      set({ error: null });
      await createScheduledTask(sessionId, cron, prompt);
      if (projectId === get().activeProjectId && threadId === get().activeThreadId && sessionId === get().sessionId) {
        await get().refreshTasks();
      }
      return true;
    } catch (error) {
      if (projectId === get().activeProjectId && threadId === get().activeThreadId && sessionId === get().sessionId) {
        set({ error: error.message });
      }
      throw error;
    }
  },

  async deleteTask(taskId) {
    if (!taskId) throw new Error('任务 ID 缺失');
    const state = get();
    const projectId = state.activeProjectId;
    const threadId = state.activeThreadId;
    const sessionId = state.sessionId;
    if (!sessionId) throw new Error('当前会话尚未连接');
    try {
      set({ error: null });
      await deleteScheduledTask(taskId, sessionId);
      if (projectId === get().activeProjectId && threadId === get().activeThreadId && sessionId === get().sessionId) {
        await get().refreshTasks();
      }
      return true;
    } catch (error) {
      if (projectId === get().activeProjectId && threadId === get().activeThreadId && sessionId === get().sessionId) {
        set({ error: error.message });
      }
      throw error;
    }
  },

  async refreshTraces() {
    const request = beginScopedRequest('traces', get());
    try {
      const traces = await fetchTraceList();
      if (!isScopedRequestCurrent(request, get())) return false;
      set({ traces });
      return true;
    } catch (_) {
      if (!isScopedRequestCurrent(request, get())) return false;
      return false;
    }
  },

  async loadWorkerLogs(workerPid, type = 'stdout', tail = 200) {
    const projectId = get().activeProjectId;
    try {
      return await fetchWorkerLogsApi(workerPid, type, tail);
    } catch (error) {
      if (projectId === get().activeProjectId) set({ error: error.message });
      throw error;
    }
  },

  async fsMkdir(path) {
    const projectId = get().activeProjectId;
    const cwd = get().fileCwd;
    try {
      await fsMkdir(path);
      if (projectId === get().activeProjectId && cwd === get().fileCwd) await get().refreshFileEntries();
      return true;
    } catch (error) {
      if (projectId === get().activeProjectId && cwd === get().fileCwd) set({ error: error.message });
      return false;
    }
  },

  async fsMove(source, destination) {
    const projectId = get().activeProjectId;
    const cwd = get().fileCwd;
    try {
      await fsMove(source, destination);
      if (projectId === get().activeProjectId && cwd === get().fileCwd) await get().refreshFileEntries();
      return true;
    } catch (error) {
      if (projectId === get().activeProjectId && cwd === get().fileCwd) set({ error: error.message });
      return false;
    }
  },

  async fsRemove(path) {
    const projectId = get().activeProjectId;
    const cwd = get().fileCwd;
    try {
      await fsRemove(path);
      if (projectId === get().activeProjectId && cwd === get().fileCwd) await get().refreshFileEntries();
      return true;
    } catch (error) {
      if (projectId === get().activeProjectId && cwd === get().fileCwd) set({ error: error.message });
      return false;
    }
  },

  async fsWrite(path, content) {
    const projectId = get().activeProjectId;
    const cwd = get().fileCwd;
    try {
      await fsWrite(path, content);
      if (projectId === get().activeProjectId && cwd === get().fileCwd) await get().refreshFileEntries();
      return true;
    } catch (error) {
      if (projectId === get().activeProjectId && cwd === get().fileCwd) set({ error: error.message });
      return false;
    }
  },

  async saveSelectedFile() {
    const state = get();
    const path = state.selectedFile;
    if (!path || !state.fileDirty || state.fileSaving) return false;
    const projectId = state.activeProjectId;
    const content = state.filePreview;
    const requestId = ++fileSaveRequestId;
    set({ fileSaving: true, fileExternalChange: null });
    try {
      await fsWrite(path, content);
    } catch (error) {
      if (requestId === fileSaveRequestId && projectId === get().activeProjectId && path === get().selectedFile) {
        set({ fileSaving: false, error: error.message });
      }
      return false;
    }

    if (requestId === fileSaveRequestId && projectId === get().activeProjectId && path === get().selectedFile) {
      set((current) => ({
        fileSavedContent: content,
        fileDirty: current.filePreview !== content,
        fileSaving: false,
        fileExternalChange: null,
      }));
      await get().refreshFileEntries();
      get().scheduleWorkspaceStatePersist();
    }
    return true;
  },

  async checkSelectedFileForExternalChanges() {
    const state = get();
    const path = state.selectedFile;
    if (!path || state.filePreviewLoading || state.fileSaving) return false;
    const projectId = state.activeProjectId;
    const requestId = ++fileDiskSyncRequestId;
    try {
      const content = await downloadFile(path);
      if (requestId !== fileDiskSyncRequestId || projectId !== get().activeProjectId || path !== get().selectedFile)
        return false;
      set((current) => {
        if (content === current.fileSavedContent) {
          return current.fileExternalChange?.path === path ? { fileExternalChange: null } : {};
        }
        if (current.fileDirty) {
          return { fileExternalChange: { path, content, error: null } };
        }
        return {
          filePreview: content,
          fileSavedContent: content,
          fileDirty: false,
          fileExternalChange: null,
        };
      });
      get().scheduleWorkspaceStatePersist();
      return true;
    } catch (error) {
      if (requestId !== fileDiskSyncRequestId || projectId !== get().activeProjectId || path !== get().selectedFile)
        return false;
      set({
        fileExternalChange: {
          path,
          content: null,
          error: error.message || '无法读取磁盘上的文件',
        },
      });
      return false;
    }
  },

  reloadExternalFileContent() {
    const change = get().fileExternalChange;
    if (!change || change.path !== get().selectedFile || typeof change.content !== 'string') return false;
    fileDiskSyncRequestId += 1;
    set({
      filePreview: change.content,
      fileSavedContent: change.content,
      fileDirty: false,
      fileExternalChange: null,
    });
    get().scheduleWorkspaceStatePersist();
    return true;
  },

  keepCurrentFileContent() {
    const change = get().fileExternalChange;
    if (!change || change.path !== get().selectedFile) return false;
    fileDiskSyncRequestId += 1;
    set((current) => ({
      fileSavedContent: typeof change.content === 'string' ? change.content : current.fileSavedContent,
      fileDirty:
        typeof change.content === 'string' ? current.filePreview !== change.content : Boolean(current.selectedFile),
      fileExternalChange: null,
    }));
    get().scheduleWorkspaceStatePersist();
    return true;
  },

  async refreshFileEntries(options = {}) {
    const cwd = get().fileCwd;
    const requestId = ++fileDirectoryRequestId;
    const projectId = get().activeProjectId;
    if (!options.silent) set({ fileLoading: true });
    try {
      const entries = await fsList(cwd, 1);
      if (requestId !== fileDirectoryRequestId || projectId !== get().activeProjectId) return false;
      set({ fileEntries: entries, fileLoading: false, fileLoadError: null });
      return true;
    } catch (error) {
      if (requestId !== fileDirectoryRequestId || projectId !== get().activeProjectId) return false;
      if (options.silent) return false;
      set({ fileEntries: [], fileLoading: false, fileLoadError: error.message, error: error.message });
      return false;
    }
  },

  async createPty(cols = 120, rows = 32, cwd = null) {
    const state = get();
    const projectId = state.activeProjectId;
    const apiBase = state.apiBase;
    const authToken = getAuthToken();
    const acpSessionToken = getAcpSessionToken();
    const headers = {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...(acpSessionToken ? { 'acp-session-token': acpSessionToken } : {}),
    };
    const body = { cols, rows };
    const initialCwd = typeof cwd === 'string' ? cwd.trim() : '';
    if (initialCwd) body.cwd = initialCwd;
    try {
      const payload = await fetchJson(`${apiBase}/api/v1/pty`, {
        method: 'POST',
        headers,
        omitAuthToken: true,
        omitAcpSessionToken: true,
        body: JSON.stringify(body),
      });
      const data = payload.data || payload;
      if (projectId !== get().activeProjectId || apiBase !== get().apiBase) {
        if (data?.sessionId) {
          await requestCodeBuddy(`${apiBase}/api/v1/pty/${encodeURIComponent(data.sessionId)}`, {
            method: 'DELETE',
            headers,
            omitAuthToken: true,
            omitAcpSessionToken: true,
            timeoutMs: 10000,
          }).catch(() => null);
        }
        return null;
      }
      const session = {
        ...data,
        cwd: typeof data?.cwd === 'string' && data.cwd.trim() ? data.cwd.trim() : initialCwd || '',
      };
      set((current) => ({
        ptySessionId: session.sessionId,
        terminalSessions: [
          ...current.terminalSessions.filter((item) => item.sessionId !== session.sessionId),
          session,
        ],
      }));
      return session;
    } catch (error) {
      if (projectId === get().activeProjectId && apiBase === get().apiBase) set({ error: error.message });
      return null;
    }
  },

  /**
   * Read the live shell cwd for a PTY session (WebUI parity: GET /api/v1/pty/:id).
   * Used before close/reconnect so the next session can reopen in the same directory.
   */
  async fetchPtyCwd(sessionId) {
    if (!sessionId) return null;
    const state = get();
    const projectId = state.activeProjectId;
    const apiBase = state.apiBase;
    const authToken = getAuthToken();
    const acpSessionToken = getAcpSessionToken();
    const headers = {
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...(acpSessionToken ? { 'acp-session-token': acpSessionToken } : {}),
    };
    try {
      const payload = await fetchJson(`${apiBase}/api/v1/pty/${encodeURIComponent(sessionId)}`, {
        method: 'GET',
        headers,
        omitAuthToken: true,
        omitAcpSessionToken: true,
        timeoutMs: 8000,
      });
      if (projectId !== get().activeProjectId || apiBase !== get().apiBase) return null;
      const data = payload?.data || payload;
      const cwd = typeof data?.cwd === 'string' ? data.cwd.trim() : '';
      return cwd || null;
    } catch (_) {
      return null;
    }
  },

  async releasePty(sessionId) {
    if (!sessionId) return false;
    const state = get();
    const projectId = state.activeProjectId;
    const apiBase = state.apiBase;
    const authToken = getAuthToken();
    const acpSessionToken = getAcpSessionToken();
    const headers = {
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...(acpSessionToken ? { 'acp-session-token': acpSessionToken } : {}),
    };
    try {
      const response = await requestCodeBuddy(`${apiBase}/api/v1/pty/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        headers,
        omitAuthToken: true,
        omitAcpSessionToken: true,
        timeoutMs: 10000,
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`PTY 释放失败: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      if (projectId === get().activeProjectId && apiBase === get().apiBase)
        set({ error: error.message || 'PTY 释放失败' });
      return false;
    }
    if (projectId !== get().activeProjectId || apiBase !== get().apiBase) return true;
    set((current) => ({
      terminalSessions: current.terminalSessions.filter((item) => item.sessionId !== sessionId),
      ptySessionId: current.ptySessionId === sessionId ? null : current.ptySessionId,
    }));
    return true;
  },

  async login(password) {
    if (get().authSubmitting) return false;
    const authRequest = ++authRequestVersion;
    const projectId = get().activeProjectId;
    const apiBase = getApiBase();
    const isCurrent = () =>
      authRequest === authRequestVersion && get().activeProjectId === projectId && getApiBase() === apiBase;
    set({ authSubmitting: true, authError: null });
    try {
      const result = await apiAuthLogin(String(password || ''), { baseUrl: apiBase, persistToken: false });
      if (!isCurrent()) {
        if (authRequest === authRequestVersion) set({ authSubmitting: false });
        return false;
      }
      if (result?.success) {
        setAuthToken(result.token || null);
        set({ authViewState: 'authenticated', authSubmitting: false, authError: null });
        // 重触发 bootstrap 继续 AcpClient 连接与非关键数据加载
        get()
          .bootstrap()
          .catch((error) => console.error('bootstrap after login failed:', error));
        return true;
      }
      set({ authSubmitting: false, authError: result?.error || 'login.error.incorrect' });
      return false;
    } catch (error) {
      if (!isCurrent()) {
        if (authRequest === authRequestVersion) set({ authSubmitting: false });
        return false;
      }
      set({ authSubmitting: false, authError: 'app.connectFailed' });
      console.warn('[auth] Login request failed:', error);
      return false;
    }
  },

  async logout() {
    authRequestVersion += 1;
    beginScopedRequest('initializeActiveThread', get(), 'threadId');
    setAcpSessionToken(null);
    apiAuthLogout();
    set({
      authViewState: 'login',
      authSubmitting: false,
      authError: null,
      sessionId: null,
      sessionToken: null,
      timeline: [],
    });
    await conversations.disposeAll();
  },

  async refreshAuth() {
    const authRequest = ++authRequestVersion;
    const projectId = get().activeProjectId;
    const apiBase = getApiBase();
    set({ authViewState: 'loading', authError: null });
    let authState;
    try {
      authState = await apiCheckAuth();
    } catch (error) {
      if (authRequest === authRequestVersion && get().activeProjectId === projectId && getApiBase() === apiBase) {
        set({ authViewState: 'error', authError: error?.message || '无法检查 CodeBuddy 登录状态' });
      }
      return false;
    }
    if (authRequest !== authRequestVersion || get().activeProjectId !== projectId || getApiBase() !== apiBase)
      return false;
    set({ authViewState: authState, authError: null });
    if (authState === 'authenticated') {
      get()
        .bootstrap()
        .catch((error) => console.error('bootstrap after refreshAuth failed:', error));
    }
    return true;
  },
  };
});

if (typeof window !== 'undefined' && import.meta.env.DEV) {
  window.__sendPrompt = (text) => useStore.getState().sendPrompt(text);
  window.__ZUSTAND_STORE = useStore;
}

// M1 安全面：向主进程注册允许的 Git 工作目录（集合变化时才上报，避免流式期间高频 IPC）。
if (typeof window !== 'undefined' && window.electronAPI?.registerGitWorkspaces) {
  const notifyGitWorkspaces = createGitWorkspaceRegistrar({
    getState: () => useStore.getState(),
    register: (payload) => {
      window.electronAPI.registerGitWorkspaces(payload).catch(() => {});
    },
  });
  useStore.subscribe(notifyGitWorkspaces);
  notifyGitWorkspaces();
}
export { conversations };
