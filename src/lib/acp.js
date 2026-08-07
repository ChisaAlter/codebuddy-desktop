import { name as appName, version as appVersion } from '../../package.json';

// 后端基址兜底值：仅当 Electron 主进程 IPC 不可达时使用。
// 正常运行时 store.bootstrap() 会按活动项目请求 Electron 运行时管理器，并用该项目的随机端口覆盖此值。
let _apiBase = 'http://127.0.0.1:63918';

const LONG_RUNNING_ACP_METHODS = new Set(['session/prompt', 'authenticate']);
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const LONG_REQUEST_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_INCOMING_EVENT_FINGERPRINTS = 4000;
const PROMPT_NOTIFICATION_FALLBACK_MS = 80;
// After session/prompt's POST stream settles, late GET-SSE chunks may still arrive.
// Keep the last promptRunId long enough for store grace + history recovery to correlate them.
export const LATE_PROMPT_CORRELATION_MS = 5000;
const PROMPT_CONTENT_SESSION_UPDATES = new Set([
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
]);
const PROMPT_TERMINAL_SESSION_UPDATES = new Set(['session_end']);
// Progress events that should reset long-running session/prompt idle timers (POST or GET-SSE).
const PROMPT_IDLE_TOUCH_UPDATES = new Set([
  ...PROMPT_CONTENT_SESSION_UPDATES,
  'user_message_chunk',
  'goal-progress',
  'goal-status',
  'plan',
  'plan_update',
  'status_change',
]);

export class AcpTimeoutError extends Error {
  constructor(method, { idleMs = LONG_REQUEST_IDLE_TIMEOUT_MS, kind = 'idle' } = {}) {
    super(`ACP request ${kind === 'idle' ? 'idle ' : ''}timeout: ${method}`);
    this.name = 'AcpTimeoutError';
    this.type = 'timeout';
    this.kind = kind;
    this.method = method;
    this.idleMs = idleMs;
    this.retriable = true;
    this.sessionRecoverable = true;
  }
}

/**
 * 归一化 IPC 流错误（preload 可能传字符串或 {message,status,kind}），
 * 供上层按 HTTP status / 错误种类分类。
 */
export function normalizeStreamError(error) {
  if (error instanceof Error) {
    return { message: error.message || String(error), status: error.status ?? null, kind: error.kind ?? null };
  }
  if (typeof error === 'string') {
    return { message: error, status: null, kind: null };
  }
  if (error && typeof error === 'object') {
    return {
      message: typeof error.message === 'string' ? error.message : String(error.message ?? error.error ?? ''),
      status: typeof error.status === 'number' ? error.status : null,
      kind: typeof error.kind === 'string' ? error.kind : null,
    };
  }
  return { message: String(error ?? ''), status: null, kind: null };
}

/**
 * 分类 ACP 请求/流失败：
 * - 'auth'          HTTP 401 —— 云端登录失效，走 announceAuthRequired，不拆连接
 * - 'client'        HTTP 4xx（非 401）—— 请求/会话/参数错误，不拆连接
 * - 'rate_limit'    HTTP 429 —— 限流，不拆连接
 * - 'upstream'      HTTP 5xx —— 守护进程上游错误，不拆连接（重连无益）
 * - 'transport'     真网络断开（status null + network/timeout/hard 超时）—— 拆连接并重连
 * - 'idle'          长任务 idle 超时 —— 会话可恢复，不拆连接
 * - 'rpc'           JSON-RPC 业务错误 —— 不拆连接
 */
export function classifyTransportFailure(info) {
  const { status, kind, isLongRunningIdleTimeout, isRpcError } = info || {};
  if (isRpcError) return 'rpc';
  if (isLongRunningIdleTimeout) return 'idle';
  if (typeof status === 'number') {
    if (status === 401) return 'auth';
    if (status === 429) return 'rate_limit';
    if (status >= 400 && status < 500) return 'client';
    if (status >= 500) return 'upstream';
    return 'transport';
  }
  // status null：
  // - idle-timeout：长任务读循环空闲超时，会话可恢复，不拆连接
  // - network / timeout：真断线或硬超时，拆连接
  // - parse / closed：协议/流结束类，不拆连接
  if (kind === 'idle-timeout') return 'idle';
  if (kind === 'network' || kind === 'timeout') return 'transport';
  if (kind === 'parse' || kind === 'closed') return 'client';
  return 'transport';
}

export function getApiBase() {
  return _apiBase;
}

export function setApiBase(base) {
  _apiBase = base;
}

let _acpSessionToken = null;
export function setAcpSessionToken(token) {
  _acpSessionToken = token;
}
export function getAcpSessionToken() {
  return _acpSessionToken;
}

// 鉴权 token：对照源 sessionStorage 持久化，所有请求带 Authorization: Bearer ${token}
let _authToken = null;
const AUTH_TOKEN_STORAGE_KEY = 'codebuddy-auth-token';
export function setAuthToken(token) {
  _authToken = token || null;
  try {
    if (token) sessionStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
    else sessionStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  } catch (_) {
    /* sessionStorage 不可达不阻塞 */
  }
}
export function getAuthToken() {
  if (_authToken) return _authToken;
  try {
    return sessionStorage.getItem(AUTH_TOKEN_STORAGE_KEY) || null;
  } catch (_) {
    return null;
  }
}
export function clearAuthToken() {
  setAuthToken(null);
}

function announceAuthRequired(url, status) {
  if (status !== 401 || typeof window === 'undefined') return;
  if (url.includes('/api/v1/auth/login') || url.includes('/api/v1/auth/status')) return;
  window.dispatchEvent(new CustomEvent('codebuddy:auth-required'));
}

function makeHeaders(extra = {}, includeAcpSessionToken = true, includeAuthToken = true) {
  const headers = {
    'X-CodeBuddy-Request': '1',
    ...extra,
  };
  if (includeAcpSessionToken && _acpSessionToken) {
    headers['acp-session-token'] = _acpSessionToken;
  }
  const bearer = includeAuthToken ? getAuthToken() : null;
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
  return headers;
}

export async function requestCodeBuddy(pathOrUrl, init = {}) {
  const baseUrl = String(init.baseUrl || _apiBase || '').replace(/\/$/, '');
  const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${baseUrl}${pathOrUrl}`;
  const timeoutMs = init.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const signal = init.signal;
  const request = {
    ...init,
    signal,
    headers: {
      ...makeHeaders({}, !init.omitAcpSessionToken, !init.omitAuthToken),
      ...(init.headers || {}),
    },
  };
  delete request.timeoutMs;
  delete request.omitAcpSessionToken;
  delete request.omitAuthToken;
  delete request.baseUrl;

  const controller = new AbortController();
  // 走 IPC 代理通道时由主进程统一管超时（避免前端 30s 抢盖主进程 120s 长响应）
  const viaIpc = typeof window !== 'undefined' && window.electronAPI?.requestCodeBuddy;
  const timeoutId = !viaIpc && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const onAbort = () => controller.abort();
  const cleanup = () => {
    if (timeoutId) clearTimeout(timeoutId);
    signal?.removeEventListener?.('abort', onAbort);
  };
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener?.('abort', onAbort, { once: true });

  if (viaIpc) {
    try {
      const proxied = await window.electronAPI.requestCodeBuddy({
        url,
        method: request.method || 'GET',
        headers: request.headers,
        body: request.body,
        timeoutMs,
      });
      if (controller.signal.aborted && !proxied?.ok) {
        throw new Error(`CodeBuddy request timeout: ${request.method || 'GET'} ${url}`);
      }
      const headers = new Headers(proxied?.headers || {});
      announceAuthRequired(url, proxied?.status || 0);
      const bodyBytes = proxied?.bodyBase64
        ? Uint8Array.from(atob(proxied.bodyBase64), (character) => character.charCodeAt(0))
        : null;
      const readText = () => (bodyBytes ? new TextDecoder().decode(bodyBytes) : proxied?.body || '');
      const readArrayBuffer = () => {
        const bytes = bodyBytes || new TextEncoder().encode(proxied?.body || '');
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      };
      return {
        ok: !!proxied?.ok,
        status: proxied?.status || 0,
        statusText: proxied?.statusText || 'CodeBuddy request failed',
        headers,
        text: async () => readText(),
        json: async () => (readText() ? JSON.parse(readText()) : null),
        blob: async () => new Blob([bodyBytes || proxied?.body || ''], { type: headers.get('content-type') || '' }),
        arrayBuffer: async () => readArrayBuffer(),
        truncated: Boolean(proxied?.truncated),
      };
    } finally {
      cleanup();
    }
  }

  try {
    const response = await fetch(url, { ...request, signal: controller.signal });
    announceAuthRequired(url, response.status);
    return response;
  } finally {
    cleanup();
  }
}

export function parseEventStreamMessages(text) {
  const chunks = text.split(/\r?\n\r?\n/).filter(Boolean);
  const messages = [];

  for (const chunk of chunks) {
    const dataLines = chunk
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());

    if (!dataLines.length) continue;
    // M-st10: per SSE spec, multiple `data:` lines within one event are joined
    // with `\n`, not the empty string. The empty-string join silently merged
    // cross-line JSON fragments and swallowed multi-line text payloads.
    const joined = dataLines.join('\n');
    try {
      messages.push(JSON.parse(joined));
    } catch (_) {
      console.warn('ACP SSE JSON parse failed:', _);
    }
  }

  if (messages.length === 0 && text.trim()) {
    try {
      const parsed = JSON.parse(text.trim());
      if (Array.isArray(parsed)) messages.push(...parsed);
      else messages.push(parsed);
    } catch (_) {}
  }

  return messages;
}

export class AcpRpcError extends Error {
  constructor(method, rpcError = {}) {
    super(rpcError.message || `ACP rpc error: ${method}`);
    this.name = 'AcpRpcError';
    this.method = method;
    this.code = rpcError.code ?? null;
    this.data = rpcError.data ?? null;
    this.category = rpcError.data?.category || null;
  }
}

export function isAcpAuthenticationError(error) {
  if (!error) return false;
  const message = String(error.message || error.errorMessage || '');
  // 网络/代理失败绝不能当成云端未登录（否则 GUI 会强制 re-auth 并 logout 有效 token）。
  if (
    error.category === 'network' ||
    error.data?.category === 'network' ||
    /\bECONNREFUSED\b|\b502\b|\b503\b|\b504\b|Bad Gateway|代理未启动|连接被拒绝/i.test(message)
  ) {
    return false;
  }
  if (error.category === 'auth' || error.data?.category === 'auth') return true;
  if (/authentication required|请.*登录|sign in to your account|auth-type:cli-external-link/i.test(message)) {
    return true;
  }
  // CLI 常以 -32000 + 401 文案返回鉴权失败
  if ((error.code === -32000 || error.code === 401) && /401|auth/i.test(message)) return true;
  return false;
}

function createAcpRpcError(method, rpcError) {
  return new AcpRpcError(method, rpcError);
}

function consumeEventStreamChunk(buffer, chunk, flush = false) {
  const combined = `${buffer}${chunk}`;
  const parts = combined.split(/\r?\n\r?\n/);
  let remainder = parts.pop() || '';
  if (flush && remainder.trim()) {
    parts.push(remainder);
    remainder = '';
  }
  return {
    buffer: remainder,
    messages: parts.flatMap((part) => parseEventStreamMessages(part)),
  };
}

function promptEventRequestId(message) {
  const metadata = message?.params?.update?._meta;
  return metadata?.['codebuddy.ai/requestId'] || metadata?.['codebuddy.ai']?.requestId || null;
}

function incomingEventFingerprint(message) {
  // M-st11: previously this stringified the entire message (including every
  // streaming token) on each event, costing CPU and storing up to 4000 long
  // string keys in incomingEventOccurrences. For session/update dedupe the
  // method + request id + sessionUpdate type + per-event identity (messageId /
  // toolCallId) uniquely identify a repeated notification (the same SSE event
  // arriving via both GET and POST), so hash only that structural subset.
  try {
    const params = message?.params || {};
    const update = params.update || params;
    const sessionUpdate = update?.sessionUpdate || update?.session_update || update?.type || null;
    const eventKey = update?.messageId || update?.toolCallId || update?.id || null;
    return JSON.stringify({
      m: message?.method || null,
      id: message?.id || null,
      su: sessionUpdate,
      e: eventKey,
    });
  } catch (_) {
    return null;
  }
}
export class AcpClient {
  constructor(options = {}) {
    this.apiBase = options.apiBase || getApiBase();
    this.connectionId = null;
    this.sessionToken = null;
    this.eventTarget = new EventTarget();
    this.connected = false;
    this.initialized = false;
    this.authMethods = [];
    this.requestCounter = 0;
    this.permissionRequestIds = new Map();
    this.permissionRequestToolCallIds = new Map();
    this.questionRequestIds = new Map();
    this.activePromptRequests = new Map();
    this.incomingEventOccurrences = new Map();
    this.pendingPromptNotifications = new Map();
    this.promptRunIdByRequestId = new Map();
    // sessionId → { promptRunId, expiresAt } for late SSE without requestId
    this.lastPromptContextBySession = new Map();
    this.sessionCancelSupported = null;

    // 重连相关
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1000;
    this.reconnecting = false;
    this._reconnectTimer = null;
    this._connecting = false;
    // 共享在飞 connect promise，供 reconnect()/并发调用真等待，而不是 setTimeout(0) 假等待。
    this._connectPromise = null;
    // 重连代际：markConnectionBroken 递增，connect() 在入口捕获、成功时校验，
    // 避免「在飞 connect 成功」复活刚被标记断开的连接（撕裂 FSM）。
    this._restoreGeneration = 0;
    // 最近一次成功绑定的会话上下文，供 restoreConnection 自动 session/load。
    this._lastSessionId = null;
    this._lastCwd = '.';
    // 会话是否已绑定到当前 connectionId。
    this.sessionBound = false;
    // kill switch：false 时 markConnectionBroken 只标断连，不调度自动重连。
    this.autoReconnectEnabled = true;

    // 心跳相关
    this._heartbeatTimer = null;
    this._heartbeatFailures = 0;
    this._maxHeartbeatFailures = 3;
    this._heartbeatInterval = 30000;

    // GET SSE 通知流：连接后保持 /api/v1/acp 长连接；通知流和 POST 内联 SSE 可能推送同一事件。
    this._sseAbortController = null;
    this._sseRetryAttempt = 0;
    this._sseBuffer = '';
    this._sseIpcStream = null;
  }

  get connectionState() {
    if (this.reconnecting) return 'reconnecting';
    if (this._connecting) return 'connecting';
    if (this.connected) return 'connected';
    if (this._connectionError) return 'error';
    return 'disconnected';
  }

  setApiBase(base) {
    if (base) this.apiBase = base;
  }

  // kill switch：关闭后 markConnectionBroken 只标断连，不调度自动重连。
  setAutoReconnectEnabled(enabled) {
    this.autoReconnectEnabled = enabled !== false;
  }

  // 会话绑定（turn 终态后的 delayed rebind）：连接已存在，仅确认会话并 emit
  // session_restored 供 store 清除 sessionRestoreNeeded。
  markSessionBound(sessionId, cwd = '.') {
    if (!sessionId) return false;
    this.sessionBound = true;
    this._lastSessionId = sessionId;
    this._lastCwd = cwd;
    this.emit('session_restored', { sessionId });
    return true;
  }

  requestHttp(pathOrUrl, init = {}) {
    const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${this.apiBase}${pathOrUrl}`;
    return requestCodeBuddy(url, {
      ...init,
      omitAcpSessionToken: true,
      headers: {
        ...(this.sessionToken ? { 'acp-session-token': this.sessionToken } : {}),
        ...(init.headers || {}),
      },
    });
  }

  async fetchJson(path, init = {}) {
    const response = await this.requestHttp(path, init);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
  }

  on(type, listener) {
    this.eventTarget.addEventListener(type, listener);
    return () => this.eventTarget.removeEventListener(type, listener);
  }

  emit(type, detail) {
    this.eventTarget.dispatchEvent(new CustomEvent(type, { detail }));
  }

  activePromptContext(sessionId) {
    const key = String(sessionId || '').trim();
    const handles = this.activePromptRequests.get(key);
    if (!handles?.size) return null;
    const handle = Array.from(handles).at(-1);
    return handle?.context || null;
  }

  cancelPendingPromptNotification(message) {
    const fingerprint = incomingEventFingerprint(message);
    if (!fingerprint) return false;
    const pending = this.pendingPromptNotifications.get(fingerprint);
    if (!pending) return false;
    pending.contexts.shift();
    if (pending.contexts.length > 0) return true;
    clearTimeout(pending.timer);
    this.pendingPromptNotifications.delete(fingerprint);
    return true;
  }

  queuePromptNotification(message) {
    const fingerprint = incomingEventFingerprint(message);
    if (!fingerprint) return;
    const sessionId = message?.params?.sessionId;
    const requestId = promptEventRequestId(message);
    const mappedPromptRunId = requestId ? this.promptRunIdByRequestId.get(requestId) : null;
    const queuedContext = mappedPromptRunId
      ? { promptRunId: mappedPromptRunId }
      : this.activePromptContext(sessionId);
    const existing = this.pendingPromptNotifications.get(fingerprint);
    if (existing) {
      existing.totalOccurrences += 1;
      existing.contexts.push(queuedContext);
      return;
    }
    const pending = {
      timer: null,
      totalOccurrences: 1,
      contexts: [queuedContext],
    };
    pending.timer = setTimeout(() => {
      this.pendingPromptNotifications.delete(fingerprint);
      for (let index = 0; index < pending.totalOccurrences; index += 1) {
        const context = pending.contexts[Math.min(index, pending.contexts.length - 1)] || null;
        this.handleIncomingRpc(message, 'notification-fallback', context);
      }
    }, PROMPT_NOTIFICATION_FALLBACK_MS);
    this.pendingPromptNotifications.set(fingerprint, pending);
  }

  clearPendingPromptNotifications() {
    for (const pending of this.pendingPromptNotifications.values()) clearTimeout(pending.timer);
    this.pendingPromptNotifications.clear();
  }
  shouldProcessIncomingEvent(message, source) {
    if (!source || message?.method !== 'session/update') return true;
    const fingerprint = incomingEventFingerprint(message);
    if (!fingerprint) return true;
    let state = this.incomingEventOccurrences.get(fingerprint);
    if (!state) {
      if (this.incomingEventOccurrences.size >= MAX_INCOMING_EVENT_FINGERPRINTS) {
        this.incomingEventOccurrences.delete(this.incomingEventOccurrences.keys().next().value);
      }
      state = { delivered: 0, counts: new Map() };
      this.incomingEventOccurrences.set(fingerprint, state);
    }
    const count = (state.counts.get(source) || 0) + 1;
    state.counts.set(source, count);
    if (count <= state.delivered) return false;
    state.delivered = count;
    return true;
  }

  handleIncomingRpc(message, source = null, context = null) {
    if (!message || typeof message !== 'object') return;
    const sessionId = message?.params?.sessionId;
    const sessionUpdate =
      message?.params?.update?.sessionUpdate ||
      message?.params?.update?.session_update ||
      message?.params?.update?.type;
    // GET-SSE progress must keep session/prompt idle alive (POST may be silent while tools run).
    if (sessionId && message?.method === 'session/update' && PROMPT_IDLE_TOUCH_UPDATES.has(sessionUpdate)) {
      this.touchActivePromptIdle(sessionId);
    }
    if (sessionId && (message?.method === 'session/request_permission' || message?.method === '_codebuddy.ai/question')) {
      this.pauseActivePromptIdle(sessionId);
    }
    const promptContentEvent =
      message?.method === 'session/update' && PROMPT_CONTENT_SESSION_UPDATES.has(sessionUpdate);
    const promptTerminalEvent =
      message?.method === 'session/update' && PROMPT_TERMINAL_SESSION_UPDATES.has(sessionUpdate);
    const promptRequestEvent = promptContentEvent || promptTerminalEvent;
    const requestId = promptRequestEvent ? promptEventRequestId(message) : null;
    const mappedPromptRunId = requestId ? this.promptRunIdByRequestId.get(requestId) : null;
    // Prefer explicit request mapping, then caller context, then last known run for this session
    // (covers late GET-SSE chunks without codebuddy.ai/requestId after POST settles).
    const eventContext = mappedPromptRunId
      ? { promptRunId: mappedPromptRunId }
      : context?.promptRunId
        ? context
        : requestId
          ? null
          : this.latePromptContext(sessionId);
    if (source === 'notification' && promptContentEvent) {
      if (this.hasActivePrompt(sessionId)) {
        // Always queue while a prompt is live. POST cancels the same fingerprint when it
        // already delivered the chunk. Previously only requestId-tagged notifications were
        // queued, so final agent_message_chunk on SSE-only (no requestId) were hard-dropped.
        this.queuePromptNotification(message);
        return;
      }
    }
    if (source === 'request' && promptContentEvent) {
      this.cancelPendingPromptNotification(message);
      if (requestId && context?.promptRunId) {
        if (this.promptRunIdByRequestId.size >= MAX_INCOMING_EVENT_FINGERPRINTS) {
          this.promptRunIdByRequestId.delete(this.promptRunIdByRequestId.keys().next().value);
        }
        this.promptRunIdByRequestId.set(requestId, context.promptRunId);
      }
      if (context?.promptRunId) this.rememberPromptContext(sessionId, context);
    }
    if (!this.shouldProcessIncomingEvent(message, source)) return;

    if (message.method && message.id !== undefined && message.id !== null) {
      if (message.method === 'session/request_permission') {
        this.handlePermissionRequest(message.id, message.params || {});
        return;
      }
      if (message.method === '_codebuddy.ai/question') {
        this.handleQuestionRequest(message.id, message.params || {});
        return;
      }
      return;
    }

    if (message.method === 'session/update') {
      const params = message.params || {};
      const update = params.update || {};
      const sessionUpdate = update.sessionUpdate;
      const clientSource = source === 'notification-fallback' ? 'notification' : source;
      const serverInitiated = Boolean(
        source === 'notification' &&
        promptRequestEvent &&
        requestId &&
        !eventContext?.promptRunId &&
        !this.hasActivePrompt(sessionId)
      );
      const eventParams = source && (promptRequestEvent || eventContext?.promptRunId)
        ? {
            ...params,
            _client: {
              source: clientSource,
              ...(requestId ? { requestId } : {}),
              ...(eventContext?.promptRunId ? { promptRunId: eventContext.promptRunId } : {}),
              ...(serverInitiated ? { serverInitiated: true } : {}),
            },
          }
        : params;
      this.emit('session/update', eventParams);
      const interruption = update._meta?.['codebuddy.ai/interruptionRequest'];
      if (interruption) {
        this.emit('interruption_request', {
          sessionUpdate: 'interruption_request',
          sessionId: params.sessionId,
          interruptionId: interruption.interruptionId || 'ir-' + interruption.toolCallId,
          reason: 'Tool requires approval',
          options: interruption.options || [],
          toolName: interruption.toolName,
          toolTitle: interruption.toolTitle,
          toolInput: interruption.toolInput,
          toolCallId: interruption.toolCallId,
          workflowSourceText: interruption.workflowSourceText,
          mcpUiIntercept: interruption.mcpUiIntercept === true,
          responseMode: 'extension',
        });
      }
      if (sessionUpdate) this.emit(sessionUpdate, update);
      return;
    }

    if (message.method === '_codebuddy.ai/checkpoint') {
      this.emit('checkpoint', message.params || {});
      return;
    }

    if (message.method) {
      if (String(message.method).startsWith('_codebuddy.ai/')) {
        this.emit('raw_extension', {
          method: message.method,
          params: message.params || {},
          source,
        });
      }
      this.emit(message.method, message.params || message);
    }
  }

  handlePermissionRequest(requestId, params) {
    const toolCall = params?.toolCall || {};
    const interruptionId = 'perm-' + String(requestId);
    const toolCallId = toolCall.toolCallId || null;
    const toolName = toolCall._meta?.['codebuddy.ai/toolName'] || toolCall.toolName || 'tool';
    this.permissionRequestIds.set(interruptionId, requestId);
    if (toolCallId) this.permissionRequestToolCallIds.set(toolCallId, interruptionId);
    this.emit('interruption_request', {
      sessionUpdate: 'interruption_request',
      sessionId: params?.sessionId || null,
      interruptionId,
      reason: 'Tool requires approval',
      options: (params?.options || []).map((option) => option?.optionId || option?.name || option).filter(Boolean),
      toolName,
      toolTitle: toolCall.title || toolName,
      toolInput: toolCall.rawInput,
      toolCallId,
      responseMode: 'json-rpc',
    });
  }

  handleQuestionRequest(requestId, params) {
    const toolCallId = params?.toolCallId || 'question-' + String(requestId);
    const questions = (params?.schema?.questions || []).map((question, index) => ({
      id: question.id || 'q_' + index,
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
    this.questionRequestIds.set(toolCallId, requestId);
    this.emit('question_request', {
      toolCallId,
      sessionId: params?.sessionId || null,
      questions,
      responseMode: 'json-rpc',
    });
  }

  invalidateInteractiveRequests(reason = 'connection-replaced') {
    const interruptionIds = Array.from(this.permissionRequestIds.keys());
    const questionToolCallIds = Array.from(this.questionRequestIds.keys());
    if (!interruptionIds.length && !questionToolCallIds.length) return false;
    this.permissionRequestIds.clear();
    this.permissionRequestToolCallIds.clear();
    this.questionRequestIds.clear();
    this.emit('interaction_requests_invalidated', { interruptionIds, questionToolCallIds, reason });
    return true;
  }

  async notify(method, params = {}) {
    if (!this.connected || !this.connectionId) throw new Error('ACP client is not connected');
    const response = await this.requestHttp('/api/v1/acp', {
      method: 'POST',
      headers: makeHeaders({
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'acp-connection-id': this.connectionId,
      }),
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    });
    if (!response.ok) {
      let detail = '';
      try {
        const payload = await response.json();
        detail = payload?.error?.message || payload?.message || '';
      } catch (_) {}
      throw new Error(detail || `ACP notification failed: ${response.status} ${response.statusText}`);
    }
    const responseText = await response.text();
    if (responseText.trim()) {
      const messages = parseEventStreamMessages(responseText);
      const rpcError = messages.find((message) => message?.error)?.error;
      if (rpcError) throw createAcpRpcError(method, rpcError);
    }
    return true;
  }
  async sendJsonRpcResult(requestId, result) {
    const response = await this.requestHttp('/api/v1/acp', {
      method: 'POST',
      headers: makeHeaders({
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'acp-connection-id': this.connectionId,
      }),
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId, result }),
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    });
    if (!response.ok) {
      let message = '';
      try {
        const payload = await response.json();
        message = payload?.error?.message || '';
      } catch (_) {}
      throw new Error(message || 'ACP response failed: ' + response.status + ' ' + response.statusText);
    }
  }

  mapPermissionDecisionToOptionId(decision) {
    if (decision === 'allowAll') return 'allow_always';
    if (decision === 'allow') return 'allow';
    if (decision === 'rejectAndExitPlan') return 'reject_and_exit_plan';
    return 'reject';
  }

  async respondToPermissionRequest(interruptionId, toolCallId, decision) {
    const mappedInterruptionId = this.permissionRequestIds.has(interruptionId)
      ? interruptionId
      : this.permissionRequestToolCallIds.get(toolCallId);
    if (!mappedInterruptionId) return false;
    const requestId = this.permissionRequestIds.get(mappedInterruptionId);
    if (requestId === undefined) return false;
    this.permissionRequestIds.delete(mappedInterruptionId);
    for (const [id, value] of this.permissionRequestToolCallIds.entries()) {
      if (value === mappedInterruptionId) this.permissionRequestToolCallIds.delete(id);
    }
    await this.sendJsonRpcResult(requestId, {
      outcome: { outcome: 'selected', optionId: this.mapPermissionDecisionToOptionId(decision) },
    });
    return true;
  }

  async submitQuestionAnswers(toolCallId, answers) {
    const requestId = this.questionRequestIds.get(toolCallId);
    if (requestId === undefined) return false;
    await this.sendJsonRpcResult(requestId, { outcome: 'submitted', answers });
    this.questionRequestIds.delete(toolCallId);
    return true;
  }

  async cancelQuestionAnswers(toolCallId) {
    const requestId = this.questionRequestIds.get(toolCallId);
    if (requestId === undefined) return false;
    await this.sendJsonRpcResult(requestId, { outcome: 'cancelled' });
    this.questionRequestIds.delete(toolCallId);
    return true;
  }

  rememberPromptContext(sessionId, context = null) {
    const key = String(sessionId || '').trim();
    const promptRunId = context?.promptRunId || null;
    if (!key || !promptRunId) return;
    this.lastPromptContextBySession.set(key, {
      promptRunId,
      expiresAt: Date.now() + LATE_PROMPT_CORRELATION_MS,
    });
  }

  latePromptContext(sessionId) {
    const key = String(sessionId || '').trim();
    if (!key) return null;
    const last = this.lastPromptContextBySession.get(key);
    if (!last) return null;
    if (Date.now() >= last.expiresAt) {
      this.lastPromptContextBySession.delete(key);
      return null;
    }
    return { promptRunId: last.promptRunId };
  }

  trackActivePrompt(sessionId, cancel, context = null) {
    const key = String(sessionId || '').trim();
    if (!key || typeof cancel !== 'function') return () => {};
    const handle = {
      cancel,
      context,
      touchIdle: null,
      pauseIdle: null,
      resumeIdle: null,
      paused: false,
    };
    const handles = this.activePromptRequests.get(key) || new Set();
    handles.add(handle);
    this.activePromptRequests.set(key, handles);
    this.rememberPromptContext(key, context);
    const unregister = () => {
      const current = this.activePromptRequests.get(key);
      if (!current) return;
      current.delete(handle);
      if (current.size === 0) this.activePromptRequests.delete(key);
      // Extend correlation window so post-stream SSE can still attach this run id.
      this.rememberPromptContext(key, context);
    };
    unregister.handle = handle;
    return unregister;
  }

  touchActivePromptIdle(sessionId) {
    const key = String(sessionId || '').trim();
    const handles = this.activePromptRequests.get(key);
    if (!handles?.size) return false;
    let touched = false;
    for (const handle of handles) {
      if (handle.paused) continue;
      if (typeof handle.touchIdle === 'function') {
        handle.touchIdle();
        touched = true;
      }
    }
    return touched;
  }

  pauseActivePromptIdle(sessionId) {
    const key = String(sessionId || '').trim();
    const handles = this.activePromptRequests.get(key);
    if (!handles?.size) return false;
    for (const handle of handles) {
      handle.paused = true;
      if (typeof handle.pauseIdle === 'function') handle.pauseIdle();
    }
    return true;
  }

  resumeActivePromptIdle(sessionId) {
    const key = String(sessionId || '').trim();
    const handles = this.activePromptRequests.get(key);
    if (!handles?.size) return false;
    for (const handle of handles) {
      handle.paused = false;
      if (typeof handle.resumeIdle === 'function') handle.resumeIdle();
      else if (typeof handle.touchIdle === 'function') handle.touchIdle();
    }
    return true;
  }

  hasActivePrompt(sessionId) {
    const key = String(sessionId || '').trim();
    return Boolean(this.activePromptRequests.get(key)?.size);
  }
  cancelActivePrompt(sessionId) {
    const key = String(sessionId || '').trim();
    const handles = this.activePromptRequests.get(key);
    if (!handles?.size) return false;
    for (const handle of Array.from(handles)) handle.cancel();
    return true;
  }

  cancelAllActivePrompts() {
    const handles = Array.from(this.activePromptRequests.values(), (items) => Array.from(items)).flat();
    for (const handle of handles) handle.cancel();
    return handles.length > 0;
  }

  async connect() {
    // M-st8: guard against concurrent connect() calls. Without this, two callers
    // (e.g. reconnect() + an explicit connect()) both pass the `connected` check,
    // each issues a /api/v1/acp/connect POST, and the second overwrites
    // connectionId/sessionToken while the first's heartbeat + SSE are still live —
    // leaving the client talking to a connection id the server doesn't know.
    if (this.connected) return;
    if (this._connectPromise) return this._connectPromise;

    this._connecting = true;
    this._connectionError = false;
    // NOTE: reconnectAttempts must NOT be reset here. The retry budget is owned
    // by the reconnect cycle (_triggerReconnect/markConnectionBroken/reconnect),
    // and connect() is also called by initializeSession for fresh connections.
    const generation = this._restoreGeneration;

    this._connectPromise = (async () => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const response = await this.requestHttp('/api/v1/acp/connect', {
          method: 'POST',
          headers: makeHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({}),
          signal: controller.signal,
          timeoutMs: 10000,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`ACP connect failed: ${response.status}`);
        }

        const payload = await response.json();
        // 连接被 markConnectionBroken 取代（在飞期间代际变化）：放弃应用新连接，
        // 释放刚拿到的 connection，让新的重连周期重新发起。
        if (generation !== this._restoreGeneration) {
          await this.releaseConnection(payload.connectionId).catch(() => null);
          const superseded = new Error('ACP connect superseded');
          superseded.name = 'AbortError';
          throw superseded;
        }
        const previousConnectionId = this.connectionId;
        this.connectionId = payload.connectionId;
        this.sessionToken = payload.sessionToken || null;
        this.connected = true;
        this.reconnecting = false;
        this._connectionError = false;
        this.sessionBound = false; // 新连接尚未绑定会话
        if (previousConnectionId && previousConnectionId !== this.connectionId) {
          this.invalidateInteractiveRequests('connection-replaced');
          this.releaseConnection(previousConnectionId);
          this.emit('connection/replaced', { previousConnectionId, connectionId: this.connectionId });
        }
        this.emit('connected', payload);

        // 连接成功后自动启用心跳 + GET SSE 通知流
        this.startHeartbeat();
        this.startNotificationStream();
      } catch (err) {
        this.connected = false;
        if (err.name === 'AbortError') {
          this._connectionError = true;
        }
        // 非重连触发的 connect() 失败也走重连流程；kill switch 关闭时不自动恢复。
        if (!this.reconnecting && this.autoReconnectEnabled) {
          this._triggerReconnect();
        }
        throw err;
      } finally {
        this._connecting = false;
        this._connectPromise = null;
      }
    })();

    return this._connectPromise;
  }

  async _triggerReconnect() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this._connectionError = false;
    this.reconnectAttempts = 0;
    this._scheduleReconnect(this.reconnectDelay);
  }

  // 传输层失败后立即把连接标记为断开并触发指数退避重连，而不必等 ~90s 的心跳兜底。
  // 复用 _triggerReconnect 的退避链路（1s→30s，最多 maxReconnectAttempts 次）。
  // 仅供请求路径判定为真传输失败（classifyTransportFailure === 'transport'）时调用。
  markConnectionBroken(reason = 'transport') {
    const wasConnected = this.connected;
    this._restoreGeneration += 1;
    this.connected = false;
    this.initialized = false;
    this.sessionBound = false;
    this._connectionError = true;
    this.stopHeartbeat();
    this.stopNotificationStream();
    if (!this.autoReconnectEnabled) {
      // kill switch：只标断连，不调度自动重连；由 UI/用户显式恢复。
      this.reconnecting = false;
      console.warn('[acp-restore] broken', {
        reason,
        autoReconnect: false,
        generation: this._restoreGeneration,
        sessionId: this._lastSessionId,
      });
      return wasConnected;
    }
    // 已在重连周期中再次 broken：升代际让在飞 restore 失效，并**保留** attempts
    // 预算、按当前指数退避尽快重排（不清零，否则有限重连 SLI 失效）。
    if (this.reconnecting) {
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        // 预算已耗尽：直接终态，不重排。
        this.reconnecting = false;
        this._connectionError = true;
        console.warn('[acp-restore] broken-rearm-exhausted', {
          reason,
          generation: this._restoreGeneration,
        });
        this.emit('reconnect_failed', { attempts: this.reconnectAttempts });
        return wasConnected;
      }
      const nextDelay = Math.min(this.reconnectDelay * 2 ** this.reconnectAttempts, 30000);
      console.warn('[acp-restore] broken-rearm', {
        reason,
        generation: this._restoreGeneration,
        attempt: this.reconnectAttempts,
        nextDelay,
        sessionId: this._lastSessionId,
      });
      this.emit('reconnecting', { attempt: this.reconnectAttempts, max: this.maxReconnectAttempts, reason });
      this._scheduleReconnect(nextDelay);
      return wasConnected;
    }
    // 立即通知 UI 进入"重连中"，与心跳兜底路径表现一致。
    this.reconnecting = true;
    this.reconnectAttempts = 0;
    console.warn('[acp-restore] broken', {
      reason,
      autoReconnect: true,
      generation: this._restoreGeneration,
      sessionId: this._lastSessionId,
    });
    this.emit('reconnecting', { attempt: 0, max: this.maxReconnectAttempts, reason });
    this._scheduleReconnect(this.reconnectDelay);
    return wasConnected;
  }

  _scheduleReconnect(delay) {
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (!this.reconnecting) return;

      this.emit('reconnecting', { attempt: this.reconnectAttempts, max: this.maxReconnectAttempts });

      const generation = this._restoreGeneration;
      try {
        const result = await this.restoreConnection({
          sessionId: this._lastSessionId,
          cwd: this._lastCwd,
        });
        if (generation !== this._restoreGeneration) return; // 被更新的 broken 取代
        if (this.connected && this.initialized) {
          this.reconnecting = false;
          const attempts = this.reconnectAttempts;
          this.reconnectAttempts = 0;
          console.warn('[acp-restore] reconnected', {
            attempts,
            sessionBound: this.sessionBound,
            sessionInvalid: result?.sessionInvalid === true,
            generation,
            sessionId: this._lastSessionId,
          });
          this.emit('reconnected', {
            attempts,
            sessionBound: this.sessionBound,
            sessionInvalid: result?.sessionInvalid === true,
          });
          return;
        }
      } catch (error) {
        // restoreConnection 内部已经设置了 _connectionError / 清理了半初始化状态
        console.warn('[acp-restore] attempt failed', {
          attempt: this.reconnectAttempts,
          error: error?.message || String(error),
        });
      }

      this.reconnectAttempts++;
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        this.reconnecting = false;
        this._connectionError = true;
        console.warn('[acp-restore] failed', { attempts: this.reconnectAttempts });
        this.emit('reconnect_failed', { attempts: this.reconnectAttempts });
        return;
      }

      // 指数退避，最大 30 秒
      const nextDelay = Math.min(delay * 2, 30000);
      this._scheduleReconnect(nextDelay);
    }, delay);
  }

  // 统一恢复入口：connect → initialize → session/load（无 active prompt 时）。
  // 任何一步失败都会清理半初始化状态并 throw。成功且（需要时）会话已绑定才返回。
  async restoreConnection({ sessionId = null, cwd = '.' } = {}) {
    const abortPartialRestore = async (error) => {
      // connect() 成功后可能已启动 heartbeat/SSE 并占用 connectionId；
      // initialize/session/load 失败时必须收回，避免半初始化连接被后续请求误用。
      const partialConnectionId = this.connectionId;
      this.connected = false;
      this.initialized = false;
      this.sessionBound = false;
      this._connectionError = true;
      this.stopHeartbeat();
      this.stopNotificationStream();
      this.connectionId = null;
      this.sessionToken = null;
      if (partialConnectionId) {
        await this.releaseConnection(partialConnectionId).catch(() => null);
      }
      throw error;
    };

    await this.connect();
    if (!this.connected) throw new Error('ACP reconnect failed: not connected');

    try {
      await this.initialize();
    } catch (error) {
      await abortPartialRestore(error);
    }

    // 有 active prompt 时不 session/load：重放的历史 chunk 会污染进行中的 turn，
    // 会话绑定推迟到 turn 结束后（由 store 的 session_restored 逻辑补齐）。
    const hasActive = sessionId ? this.hasActivePrompt?.(sessionId) : false;
    if (sessionId && !hasActive) {
      try {
        const loaded = await this.request('session/load', { sessionId, cwd, mcpServers: [] });
        this.sessionBound = true;
        this._lastSessionId = sessionId;
        this._lastCwd = cwd;
        this.emit('session_restored', { sessionId });
        return { loaded };
      } catch (error) {
        const message = String(error?.message || '');
        const sessionInvalid =
          error?.sessionInvalid === true ||
          /session not found|invalid session|unknown session|no such session|session.*expired/i.test(message);
        const transport =
          error?.type === 'timeout' ||
          error?.sessionRecoverable === true ||
          /idle timeout|timeout|ECONNREFUSED|network|fetch failed|408|502|503|504/i.test(message);
        if (sessionInvalid && !transport) {
          // 协议已恢复，但会话不可用：保留连接，明确告知上层。
          this.sessionBound = false;
          this.emit('session_invalid', { sessionId });
          return { sessionInvalid: true };
        }
        await abortPartialRestore(error);
      }
    } else if (sessionId) {
      // 有 active prompt：仅协议恢复，会话绑定状态未知。
      this.sessionBound = false;
    } else {
      this.sessionBound = false;
    }
    return { loaded: null };
  }

  async reconnect(options = {}) {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this.reconnecting = true;
    this.connected = false;
    this.initialized = false;
    this.reconnectAttempts = 0;
    this.stopHeartbeat();
    this.stopNotificationStream();

    // 有在飞的 connect()：等待共享 promise 真正结束，而不是 setTimeout(0) 假等待。
    if (this._connectPromise) {
      try {
        await this._connectPromise;
      } catch (_) {
        // 在飞 connect 失败由原调用方处理；这里继续走 restoreConnection。
      }
    }

    try {
      const result = await this.restoreConnection(options);
      // 显式 reconnect 的成功语义：协议已恢复；会话绑定由调用方/sessionBound 判断。
      if (!(this.connected && this.initialized)) return false;
      // 会话已失效：session_invalid 事件已发出（错误可见），此处干净地返回失败。
      if (result?.sessionInvalid === true) return false;
      return result && typeof result === 'object' ? result : { ok: true };
    } catch (_) {
      this._scheduleReconnect(this.reconnectDelay);
      return false;
    }
  }

  startHeartbeat(intervalMs = 30000) {
    this.stopHeartbeat();
    this._heartbeatInterval = intervalMs;
    this._heartbeatFailures = 0;
    this._heartbeatTimer = setInterval(async () => {
      try {
        await this.fetchJson('/api/v1/health');
        this._heartbeatFailures = 0;
      } catch (_) {
        this._heartbeatFailures++;
        if (this._heartbeatFailures >= this._maxHeartbeatFailures) {
          this.stopHeartbeat();
          this.connected = false;
          this._triggerReconnect();
        }
      }
    }, this._heartbeatInterval);
  }

  stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    this._heartbeatFailures = 0;
  }

  startNotificationStream(resetRetry = true) {
    this.stopNotificationStream();
    if (!this.connectionId) return;
    if (resetRetry) this._sseRetryAttempt = 0;
    this._sseAbortController = new AbortController();

    const onMessage = (message) => {
      this._sseRetryAttempt = 0;
      this.handleIncomingRpc(message, 'notification');
    };
    const onError = () => this._scheduleNotificationReconnect();

    if (typeof window !== 'undefined' && window.electronAPI?.openCodeBuddyStream) {
      this._sseIpcStream = window.electronAPI.openCodeBuddyStream(
        {
          url: `${this.apiBase}/api/v1/acp`,
          timeoutMs: 0,
          headers: makeHeaders({
            Accept: 'text/event-stream',
            'acp-connection-id': this.connectionId,
            ...(this.sessionToken ? { 'acp-session-token': this.sessionToken } : {}),
          }),
        },
        { onMessage, onError },
      );
      return;
    }

    this._openFetchNotificationStream(onMessage, onError).catch((err) => {
      if (err?.name !== 'AbortError') onError(err);
    });
  }

  stopNotificationStream() {
    if (this._sseReconnectTimer) {
      clearTimeout(this._sseReconnectTimer);
      this._sseReconnectTimer = null;
    }
    if (this._sseIpcStream) {
      try {
        this._sseIpcStream.close?.();
      } catch (_) {}
      this._sseIpcStream = null;
    }
    if (this._sseAbortController) {
      this._sseAbortController.abort();
      this._sseAbortController = null;
    }
    this._sseBuffer = '';
  }

  _scheduleNotificationReconnect() {
    if (!this.connected || this.reconnecting || this._sseReconnectTimer) return;
    const delay = Math.min(2000 * 2 ** this._sseRetryAttempt, 60000);
    this._sseRetryAttempt = Math.min(this._sseRetryAttempt + 1, 10);
    this._sseReconnectTimer = setTimeout(() => {
      this._sseReconnectTimer = null;
      if (this.connected && !this.reconnecting) this.startNotificationStream(false);
    }, delay);
  }

  async _openFetchNotificationStream(onMessage, onError) {
    const response = await fetch(`${this.apiBase}/api/v1/acp`, {
      headers: makeHeaders({
        Accept: 'text/event-stream',
        'acp-connection-id': this.connectionId,
        ...(this.sessionToken ? { 'acp-session-token': this.sessionToken } : {}),
      }),
      signal: this._sseAbortController?.signal,
    });
    if (!response.ok) {
      onError(new Error(`ACP notification stream failed: ${response.status}`));
      return;
    }
    await this.readSseStream(response, onMessage);
    onError(new Error('ACP notification stream closed'));
  }

  _consumeSseText(chunk, onMessage) {
    this._sseBuffer += chunk;
    const parts = this._sseBuffer.split(/\r?\n\r?\n/);
    this._sseBuffer = parts.pop() || '';
    for (const part of parts) {
      const data = part
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        // M-st10: join multi-line `data:` with `\n` per SSE spec (was empty string).
        .join('\n');
      if (!data) continue;
      try {
        onMessage(JSON.parse(data));
      } catch (_) {
        console.warn('ACP notification SSE JSON parse failed:', _);
      }
    }
  }

  async readSseStream(response, onMessage = (message) => this.handleIncomingRpc(message)) {
    const reader = response.body?.getReader?.();
    if (!reader) return;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this._consumeSseText(decoder.decode(value, { stream: true }), onMessage);
      }
      const tail = decoder.decode();
      if (tail) this._consumeSseText(tail, onMessage);
      if (this._sseBuffer.trim()) this._consumeSseText('\n\n', onMessage);
    } finally {
      reader.releaseLock?.();
    }
  }

  async initialize() {
    if (this.initialized) return;
    const result = await this.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: appName, version: appVersion },
      clientCapabilities: {
        _meta: {
          'codebuddy.ai': {
            question: true,
            promptSuggestion: true,
          },
        },
      },
    });
    this.authMethods = Array.isArray(result?.authMethods) ? result.authMethods : [];
    this.initialized = true;
    this.emit('initialized', result);
    return result;
  }

  async authenticate(methodId) {
    return this.request('authenticate', { methodId });
  }

  async initializeSession(sessionId = null, cwd = '.') {
    await this.connect();
    const init = await this.initialize();
    // cwd 决定该会话 agent 工具调用的实际工作目录；session/new 时一次性注入，运行时不可改
    const loaded = sessionId
      ? await this.request('session/load', { sessionId, cwd, mcpServers: [] })
      : await this.request('session/new', { cwd, mcpServers: [] });
    // 记住成功绑定的会话上下文，供传输失败后 restoreConnection 自动 rebind。
    const boundSessionId = sessionId || loaded?.sessionId || null;
    if (boundSessionId) {
      this._lastSessionId = boundSessionId;
      this._lastCwd = cwd;
      this.sessionBound = true;
    }
    return { init, loaded };
  }

  async disconnect() {
    const previousConnectionId = this.connectionId;
    this.cancelAllActivePrompts();
    this.connected = false;
    this.initialized = false;
    this.authMethods = [];
    this.reconnecting = false;
    this._connecting = false;
    this.connectionId = null;
    this.sessionToken = null;
    this.reconnectAttempts = 0;
    this._restoreGeneration += 1;
    this._lastSessionId = null;
    this.sessionBound = false;
    this.permissionRequestIds.clear();
    this.permissionRequestToolCallIds.clear();
    this.questionRequestIds.clear();
    this.incomingEventOccurrences.clear();
    this.clearPendingPromptNotifications();
    this.promptRunIdByRequestId.clear();
    this.lastPromptContextBySession.clear();

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    this.stopHeartbeat();
    this.stopNotificationStream();
    if (previousConnectionId) await this.releaseConnection(previousConnectionId);
  }

  async releaseConnection(connectionId) {
    if (!connectionId) return;
    await this.requestHttp(`/api/v1/acp/connect/${encodeURIComponent(connectionId)}`, {
      method: 'DELETE',
      timeoutMs: 5000,
    }).catch(() => null);
  }

  requestStreamingIpc(payload, id, timeoutMs, context = null) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let stream = null;
      let timeoutId = null;
      let unregisterPrompt = () => {};
      let matchedResponse = false;
      let matchedResult = null;
      let matchedError = null;
      const streamFailure = (error, fallback) => {
        const failure =
          error instanceof Error ? error : new Error(typeof error === 'string' ? error : error?.message || fallback);
        if (matchedResponse) failure.promptAccepted = true;
        return failure;
      };
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        timeoutId = null;
        unregisterPrompt();
        stream?.close?.();
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const armTimeout = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (timeoutMs <= 0) return;
        timeoutId = setTimeout(() => {
          finish(reject, new AcpTimeoutError(payload.method, { idleMs: timeoutMs, kind: 'idle' }));
        }, timeoutMs);
      };
      const clearIdleTimer = () => {
        if (timeoutId) clearTimeout(timeoutId);
        timeoutId = null;
      };
      if (payload.method === 'session/prompt' || payload.method === 'authenticate') {
        // authenticate 无 sessionId：用合成 key，便于侧栏「取消登录」打断等待。
        unregisterPrompt = this.trackActivePrompt(
          payload.method === 'authenticate'
            ? `__authenticate__${id}`
            : payload.params?.sessionId,
          () => {
            finish(reject, new Error('ACP request cancelled by user'));
          },
          context,
        );
        if (unregisterPrompt.handle) {
          unregisterPrompt.handle.touchIdle = armTimeout;
          unregisterPrompt.handle.pauseIdle = clearIdleTimer;
          unregisterPrompt.handle.resumeIdle = armTimeout;
        }
      }
      armTimeout();

      try {
        stream = window.electronAPI.openCodeBuddyStream(
          {
            url: `${this.apiBase}/api/v1/acp`,
            method: 'POST',
            headers: makeHeaders({
              Accept: 'application/json, text/event-stream',
              'Content-Type': 'application/json',
              'acp-connection-id': this.connectionId,
              ...(this.sessionToken ? { 'acp-session-token': this.sessionToken } : {}),
            }),
            body: JSON.stringify(payload),
            timeoutMs,
            rpcId: id,
          },
          {
            onMessage: (message) => {
              if (settled) return;
              armTimeout();
              if (!message?.method && message?.id !== undefined && message?.id !== null && String(message.id) === id) {
                matchedResponse = true;
                matchedResult = message.result ?? null;
                matchedError = message.error ? createAcpRpcError(payload.method, message.error) : null;
                return;
              }
              this.handleIncomingRpc(message, 'request', context);
            },
            onError: (error) => {
              if (matchedError) {
                finish(reject, matchedError);
              } else {
                const info = normalizeStreamError(error);
                const cls = classifyTransportFailure(info);
                // 401 → 既有登录引导链路；4xx/5xx/idle → 不拆连接（业务/上游错误或会话可恢复）；
                // 仅真网络断开（status null + network/timeout）标记连接断开并触发快速重连。
                if (cls === 'auth') {
                  announceAuthRequired(`${this.apiBase}/api/v1/acp`, 401);
                } else if (cls === 'transport') {
                  this.markConnectionBroken('stream-error');
                }
                const failure = streamFailure(info.message, `ACP stream failed: ${payload.method}`);
                failure.transportFailure = cls === 'transport';
                failure.failureClass = cls;
                failure.status = info.status;
                finish(reject, failure);
              }
            },
            onEnd: (result) => {
              if (result?.ok === false) {
                const cls = classifyTransportFailure({ status: result.status ?? null, kind: 'http' });
                if (cls === 'auth') {
                  announceAuthRequired(`${this.apiBase}/api/v1/acp`, result.status);
                } else if (cls === 'transport') {
                  this.markConnectionBroken('post-failed');
                }
                const failure = new Error(
                  `ACP POST failed: ${result.status || 0} ${result.statusText || ''}`.trim(),
                );
                failure.transportFailure = cls === 'transport';
                failure.failureClass = cls;
                failure.status = result.status ?? null;
                finish(reject, failure);
              } else if (matchedError) {
                finish(reject, matchedError);
              } else if (!matchedResponse) {
                // POST 以非匹配 id 的 JSON 通知正常结束（真正结果走 GET-SSE）：
                // 不视为连接断开，交由上层 grace 等待 + 历史恢复。
                const failure = new Error(`ACP response stream ended before RPC result: ${payload.method}`);
                failure.transportFailure = false;
                failure.failureClass = 'client';
                finish(reject, failure);
              } else if (Number(result?.parseErrorCount) > 0) {
                finish(
                  reject,
                  streamFailure(
                    `ACP response stream contained ${result.parseErrorCount} invalid event(s)`,
                    `ACP stream failed: ${payload.method}`,
                  ),
                );
              } else {
                finish(resolve, matchedResult);
              }
            },
          },
        );
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  async request(method, params = {}, context = null) {
    if (!this.connected || !this.connectionId) {
      throw new Error('ACP client is not connected');
    }

    const id = String(++this.requestCounter);
    const payload = { jsonrpc: '2.0', method, params, id };
    const isLongRunning = LONG_RUNNING_ACP_METHODS.has(method);
    if (isLongRunning && typeof window !== 'undefined' && window.electronAPI?.openCodeBuddyStream) {
      return this.requestStreamingIpc(payload, id, LONG_REQUEST_IDLE_TIMEOUT_MS, context);
    }

    const controller = new AbortController();
    let cancelledByUser = false;
    const unregisterPrompt = isLongRunning
      ? this.trackActivePrompt(
          method === 'authenticate' ? `__authenticate__${id}` : params?.sessionId,
          () => {
            cancelledByUser = true;
            controller.abort();
          },
          context,
        )
      : () => {};
    let timeoutId = null;
    const armTimeout = () => {
      if (timeoutId) clearTimeout(timeoutId);
      const timeoutMs = isLongRunning ? LONG_REQUEST_IDLE_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS;
      if (timeoutMs <= 0) return;
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    };
    const clearIdleTimer = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = null;
    };
    if (isLongRunning && unregisterPrompt.handle) {
      unregisterPrompt.handle.touchIdle = armTimeout;
      unregisterPrompt.handle.pauseIdle = clearIdleTimer;
      unregisterPrompt.handle.resumeIdle = armTimeout;
    }
    armTimeout();

    try {
      const response = await this.requestHttp('/api/v1/acp', {
        method: 'POST',
        headers: makeHeaders({
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          'acp-connection-id': this.connectionId,
          ...(this.sessionToken ? { 'acp-session-token': this.sessionToken } : {}),
        }),
        body: JSON.stringify(payload),
        signal: controller.signal,
        timeoutMs: isLongRunning ? LONG_REQUEST_IDLE_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS,
      });

      if (!response.ok) {
        const postError = new Error(`ACP POST failed: ${response.status}`);
        postError.status = response.status;
        throw postError;
      }

      const reader = response.body?.getReader?.();
      const decoder = new TextDecoder();
      let text = '';
      let eventBuffer = '';
      let matchedResult = null;
      let matchedResponse = false;
      const processMessages = (messages) => {
        for (const message of messages) {
          if (!message.method && message.id !== undefined && message.id !== null && String(message.id) === id) {
            matchedResponse = true;
            if (message.error) {
              throw createAcpRpcError(method, message.error);
            }
            matchedResult = message.result ?? null;
          } else {
            this.handleIncomingRpc(message, 'request', context);
          }
        }
      };
      const consumeChunk = (chunk, flush = false) => {
        text += chunk;
        const consumed = consumeEventStreamChunk(eventBuffer, chunk, flush);
        eventBuffer = consumed.buffer;
        processMessages(consumed.messages);
      };

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          armTimeout();
          consumeChunk(decoder.decode(value, { stream: true }));
        }
        consumeChunk(decoder.decode());
        consumeChunk('', true);
      } else {
        text = await response.text();
        processMessages(parseEventStreamMessages(text));
      }

      if (matchedResponse) return matchedResult;
      if (response.truncated) {
        throw new Error(`ACP 响应流意外中断: ${method}`);
      }

      const trimmed = text.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        const parsed = JSON.parse(trimmed);
        if (parsed?.error) throw createAcpRpcError(method, parsed.error);
        return parsed?.result ?? parsed;
      }

      throw new Error(`ACP response stream ended before RPC result: ${method}`);
    } catch (err) {
      if (err.name === 'AbortError') {
        if (cancelledByUser) throw new Error('ACP request cancelled by user');
        if (isLongRunning) {
          // 长任务 idle 超时属于会话可恢复错误（AcpTimeoutError.sessionRecoverable），
          // 不视为传输断开：守护进程仍可能在处理，重连会建立新连接而丢失当前会话。
          throw new AcpTimeoutError(method, { idleMs: LONG_REQUEST_IDLE_TIMEOUT_MS, kind: 'idle' });
        }
        // 短请求硬超时：连接大概率已死，立即重连。
        this.markConnectionBroken('hard-timeout');
        const timeoutErr = new AcpTimeoutError(method, { idleMs: DEFAULT_REQUEST_TIMEOUT_MS, kind: 'hard' });
        timeoutErr.transportFailure = true;
        timeoutErr.failureClass = 'transport';
        throw timeoutErr;
      }
      // AcpRpcError 是服务端业务错误（鉴权/拒绝等），不视为传输断开。
      // 其余错误按 HTTP status 分类：4xx/5xx 不拆连接，仅真网络断开（status null）触发重连。
      if (!(err instanceof AcpRpcError) && !err.transportFailure) {
        const info = normalizeStreamError(err);
        const cls = classifyTransportFailure({ ...info, isLongRunningIdleTimeout: false });
        if (cls === 'auth') {
          announceAuthRequired(`${this.apiBase}/api/v1/acp`, err.status);
        } else if (cls === 'transport') {
          this.markConnectionBroken('request-error');
        }
        err.transportFailure = cls === 'transport';
        err.failureClass = cls;
      }
      throw err;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      unregisterPrompt();
    }
  }
}

export async function fetchJson(path, init = {}) {
  const response = await requestCodeBuddy(path, init);
  // CLI 2.125 often returns 204 No Content for workspace-dirs POST/DELETE/sync,
  // plugins/update, marketplaces/auto-update, etc. Empty bodies must not call json().
  if (response.status === 204) {
    return null;
  }
  const text = await response.text().catch(() => '');
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_) {
      payload = text;
    }
  }
  if (!response.ok) {
    const detail =
      (payload && typeof payload === 'object'
        ? payload?.error?.message || payload?.error || payload?.message
        : null) || '';
    throw new Error(detail || `${response.status} ${response.statusText}`);
  }
  // Successful empty body (rare non-204) → null; callers already use `??` / optional chaining.
  if (payload == null || payload === '') return null;
  return payload;
}

// ===== 鉴权 =====
// 对照源：POST /api/v1/auth/login {password} -> {success, token?, error?}
// 成功后 token 存 sessionStorage（setAuthToken），所有请求经 makeHeaders 注入 Bearer
export async function authLogin(password, options = {}) {
  const baseUrl = String(options.baseUrl || '').replace(/\/$/, '');
  const response = await requestCodeBuddy(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: makeHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ password }),
    timeoutMs: 15000,
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const err = await response.json();
      if (err?.error) message = err.error;
    } catch (_) {}
    return { success: false, error: message };
  }
  const payload = await response.json();
  if (payload?.success) {
    // 仅当后端真发 token 才持久化为 Bearer；无 token 字段时**不**把密码当 bearer 落 sessionStorage
    // 旧兜底“用 password 作 bearer”会让明文密码长期驻留 sessionStorage，并在每次请求中重复携带；
    // 后端不返回 token 时，当前会话不需要 Bearer 鉴权。
    if (payload.token && options.persistToken !== false) setAuthToken(payload.token);
    return { success: true, token: payload.token || null };
  }
  return { success: false, error: payload?.error || 'login.error.incorrect' };
}

export function authLogout() {
  clearAuthToken();
}

// 查后端鉴权态：GET /api/v1/auth/status -> {authEnabled, authenticated}。
// 旧版服务没有该接口时继续兼容；其余网络或服务错误必须交给界面明确恢复。
export async function checkAuth() {
  const response = await requestCodeBuddy('/api/v1/auth/status');
  if (response.status === 404) return 'authenticated';
  if (response.status === 401) return 'login';
  if (!response.ok) throw new Error(`无法检查 CodeBuddy 登录状态 (${response.status || '无响应'})`);
  const payload = await response.json();
  const data = payload?.data ?? payload ?? {};
  return data.authEnabled && !data.authenticated ? 'login' : 'authenticated';
}

// API_BASE is now dynamic — use getApiBase() / setApiBase() instead
