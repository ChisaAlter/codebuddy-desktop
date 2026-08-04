import { getApiBase, getAuthToken } from './acp';

function wsBase() {
  return getApiBase().replace(/^http/, 'ws');
}

/**
 * 构造 PTY WebSocket url（对照源 bundle）
 *   `${ws|wss}://${host}/api/v1/pty/${sessionId}/ws?token=${encodeURIComponent(authToken)}`
 * - /ws 后缀：对照源真实 UI 路由形状，项目旧版无此后缀
 * - ?token=：鉴权场景下 WS 握手需带 bearer token；无 token 则 query 为空
 * @param {string} sessionId
 * @returns {string}
 */
export function buildPtyWebSocketUrl(sessionId) {
  const base = `${wsBase()}/api/v1/pty/${encodeURIComponent(sessionId)}/ws`;
  const token = getAuthToken();
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

/**
 * PTY HTTP 直送输入（对照源 bundle aD()：POST /api/v1/pty/{id}/input/send {data}）
 * - 用途：WS 不可达时的 HTTP 兜底，或一次性输入无需建长连的场景
 * - 非阻塞：对照源同此用 .catch(()=>{}) 吞错，调用方不感知
 * @param {string} sessionId
 * @param {string} data
 */
export async function ptySendInputHttp(sessionId, data) {
  if (!sessionId) return;
  const { requestCodeBuddy } = await import('./acp');
  await requestCodeBuddy(`/api/v1/pty/${encodeURIComponent(sessionId)}/input/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
    timeoutMs: 10000,
  }).catch(() => null);
}

async function ptyResizeHttp(sessionId, cols, rows) {
  const { requestCodeBuddy } = await import('./acp');
  await requestCodeBuddy(`/api/v1/pty/${encodeURIComponent(sessionId)}/resize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cols, rows }),
    timeoutMs: 10000,
  }).catch(() => null);
}

export class PtySocket {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.socket = null;
    this.listeners = new Map();
    this._reconnecting = false;
    this._maxReconnectAttempts = 5;
    this._reconnectInterval = 1000;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._closedExplicitly = false;
    this._sseStream = null;
    this._transport = null;
    this._inputQueue = [];
    this._inputFlushTimer = null;
  }

  get readyState() {
    return this.socket?.readyState ?? WebSocket.CLOSED;
  }

  isConnected() {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  on(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
    return () => this.listeners.get(type)?.delete(listener);
  }

  emit(type, payload) {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const listener of set) listener(payload);
  }

  connect() {
    // P0-3: only block re-entry while a socket is actually alive. A CLOSED
    // socket left behind by a server-side normal close (code 1000) must not
    // wedge connect() forever — the server process may have restarted and a
    // fresh socket is needed.
    if ((this.socket && this.socket.readyState !== WebSocket.CLOSED) || this._sseStream) return;
    this._closedExplicitly = false;
    if (typeof window !== 'undefined' && window.electronAPI?.openCodeBuddyStream) {
      this._connectSse();
      return;
    }
    this._transport = 'websocket';
    const url = buildPtyWebSocketUrl(this.sessionId);
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onopen = () => {
      this.emit('open', { sessionId: this.sessionId });
    };
    socket.onclose = (event) => {
      this.emit('close', event);
      // P0-3: always release the socket reference on close (guarding against a
      // newer socket replacing it mid-close). The old WS cannot come back to
      // life, so a later connect() must be able to build a fresh one.
      if (this.socket === socket) this.socket = null;
      // 非主动关闭时尝试重连（code 1000 是服务端正常关闭，不重连但允许重建）
      if (!this._closedExplicitly && !this._reconnecting && event.code !== 1000) {
        this._tryReconnect();
      }
    };
    socket.onerror = (event) => this.emit('error', event);
    socket.onmessage = (event) => {
      let payload = event.data;
      try {
        payload = JSON.parse(event.data);
      } catch (_) {
        // L7: non-JSON frames (e.g. terminal keepalive/binary) are emitted raw
        // below by design; the WS server only sends JSON for typed messages.
      }
      this.emit('message', payload);
      if (payload?.type) this.emit(payload.type, payload);
    };
  }

  sendInput(data) {
    if (this._transport === 'sse') {
      // M-perf: batch keystrokes in a 16ms window before the HTTP POST so a
      // typing burst is one IPC + one localhost round-trip instead of one per
      // key (each POST used to await a response via the generic request channel).
      // Failures surface through the 'error' event (TerminalPane marks the pane
      // status) rather than blocking input.
      this._inputQueue.push(data);
      if (!this._inputFlushTimer) {
        this._inputFlushTimer = setTimeout(() => this._flushInputQueue(), 16);
      }
      return;
    }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('PTY socket is not connected');
    }
    this.socket.send(JSON.stringify({ type: 'input', data }));
  }

  _flushInputQueue() {
    this._inputFlushTimer = null;
    if (!this._inputQueue.length) return;
    const data = this._inputQueue.join('');
    this._inputQueue = [];
    const p = ptySendInputHttp(this.sessionId, data);
    if (p && typeof p.catch === 'function') p.catch((err) => this.emit('error', err));
  }

  resize(cols, rows) {
    if (this._transport === 'sse') {
      // M-ls3: same error surfacing as sendInput for the SSE resize path.
      const p = ptyResizeHttp(this.sessionId, cols, rows);
      if (p && typeof p.catch === 'function') p.catch((err) => this.emit('error', err));
      return;
    }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('PTY socket is not connected');
    }
    this.socket.send(JSON.stringify({ type: 'resize', cols, rows }));
  }

  close() {
    this._closedExplicitly = true;
    this._reconnecting = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    // Drop queued input for a session that is being torn down (no point posting
    // keystrokes to a dead PTY).
    if (this._inputFlushTimer) {
      clearTimeout(this._inputFlushTimer);
      this._inputFlushTimer = null;
    }
    this._inputQueue = [];
    if (this._sseStream) {
      try { this._sseStream.close?.(); } catch (_) {}
      this._sseStream = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  _tryReconnect() {
    if (this._reconnecting) return;
    this._reconnecting = true;
    this._reconnectAttempts = 0;
    this._doReconnectAttempt();
  }

  _doReconnectAttempt() {
    // M-ls9: bail out if the PTY was closed explicitly — a reconnect attempt
    // scheduled before close() must not open a fresh socket afterward.
    if (this._closedExplicitly) {
      this._reconnecting = false;
      return;
    }
    this._reconnectAttempts++;
    if (this._reconnectAttempts > this._maxReconnectAttempts) {
      this._reconnecting = false;
      this.emit('reconnect_failed', { attempts: this._maxReconnectAttempts });
      return;
    }

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;

      // 清理旧 socket
      if (this.socket) {
        try { this.socket.close(); } catch (_) {}
        this.socket = null;
      }

      this.emit('reconnecting', { attempt: this._reconnectAttempts, max: this._maxReconnectAttempts });

      try {
        const url = buildPtyWebSocketUrl(this.sessionId);
        const socket = new WebSocket(url);
        this.socket = socket;

        socket.onopen = () => {
          this._reconnecting = false;
          this._reconnectAttempts = 0;
          this.emit('reconnected', { sessionId: this.sessionId });
          this.emit('open', { sessionId: this.sessionId });
        };

        socket.onclose = (event) => {
          this.emit('close', event);
          // P0-3: release the socket reference on any close so connect() can
          // rebuild after a server-side normal close (code 1000).
          if (this.socket === socket) this.socket = null;
          // 非主动关闭时尝试重连
          if (!this._closedExplicitly && !this._reconnecting && event.code !== 1000) {
            this._tryReconnect();
          }
        };

        socket.onerror = (event) => {
          this.emit('error', event);
        };

        socket.onmessage = (event) => {
          let payload = event.data;
          try {
            payload = JSON.parse(event.data);
          } catch (_) {}
          this.emit('message', payload);
          if (payload?.type) this.emit(payload.type, payload);
        };

        // 如果连接在一定时间内没建立，继续重试
        const connectTimeout = setTimeout(() => {
          if (this._reconnecting && socket.readyState !== WebSocket.OPEN) {
            try { socket.close(); } catch (_) {}
            // M-ls9: do not schedule another reconnect attempt after close().
            if (!this._closedExplicitly) this._doReconnectAttempt();
          }
        }, 3000);

        // 连接成功时清理超时
        const originalOnOpen = socket.onopen;
        socket.onopen = (event) => {
          clearTimeout(connectTimeout);
          if (originalOnOpen) originalOnOpen.call(socket, event);
        };

      } catch (_) {
        this._doReconnectAttempt();
      }
    }, this._reconnectInterval);
  }

  reconnect() {
    this._closedExplicitly = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._reconnecting = true;
    this._reconnectAttempts = 0;

    if (this.socket) {
      try { this.socket.close(); } catch (_) {}
      this.socket = null;
    }

    if (this._sseStream) {
      try { this._sseStream.close?.(); } catch (_) {}
      this._sseStream = null;
    }

    if (typeof window !== 'undefined' && window.electronAPI?.openCodeBuddyStream) {
      this._connectSse();
      return;
    }

    this._doReconnectAttempt();
  }

  async _connectSse() {
    this._transport = 'sse';
    try {
      const { requestCodeBuddy } = await import('./acp');
      const response = await requestCodeBuddy(`/api/v1/pty/${encodeURIComponent(this.sessionId)}`, {
        timeoutMs: 10000,
      });
      if (!response.ok) throw new Error(`PTY session unavailable: ${response.status}`);
      if (this._closedExplicitly) return;

      const token = getAuthToken();
      let stream = null;
      stream = window.electronAPI.openCodeBuddyStream({
        url: `${getApiBase()}/api/v1/pty/${encodeURIComponent(this.sessionId)}/output`,
        headers: {
          Accept: 'text/event-stream',
          'X-CodeBuddy-Request': '1',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      }, {
        onMessage: (message) => {
          if (this._closedExplicitly || this._sseStream !== stream) return;
          const payload = message?.type || !message?.data
            ? message
            : { ...message, type: 'output' };
          this.emit('message', payload);
          if (payload?.type) this.emit(payload.type, payload);
        },
        onError: (error) => {
          if (this._closedExplicitly || this._sseStream !== stream) return;
          try { stream?.close?.(); } catch (_) {}
          this._sseStream = null;
          // M-ls5: same half-dead reset as the connect-failure catch.
          this._transport = null;
          this.emit('error', error);
          this.emit('close', error);
        },
      });
      this._sseStream = stream;
      this.emit('open', { sessionId: this.sessionId, transport: 'sse' });
    } catch (error) {
      if (this._closedExplicitly) return;
      this._sseStream = null;
      // M-ls5: reset _transport so a subsequent connect() retries WS instead of
      // silently POSTing to /input/send on a half-dead SSE session forever.
      this._transport = null;
      this.emit('error', error);
      this.emit('close', error);
    }
  }
}
