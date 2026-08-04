import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpClient, AcpRpcError, setApiBase } from '../../src/lib/acp';

// 覆盖模型请求失败自动重连：requestStreamingIpc / request 在传输层失败时
// 必须立即把连接标记为断开并触发指数退避重连（而非等 ~90s 心跳兜底）。
describe('ACP auto-reconnect on transport failure', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setApiBase('http://127.0.0.1:63918');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete window.electronAPI;
  });

  function makeClient() {
    const client = new AcpClient({ apiBase: 'http://127.0.0.1:63918' });
    client.connected = true;
    client.connectionId = 'conn-1';
    client.sessionToken = 'sess-1';
    // 重连依赖 connect() -> requestHttp -> IPC/fetch；统一桩成失败，便于断言重连被调度。
    client.connect = vi.fn(async () => {
      throw new Error('connect refused');
    });
    return client;
  }

  // Phase 3: 真实 requestHttp 驱动，跑满重连退避验证有限终止。
  function makeRealClient() {
    const client = new AcpClient({ apiBase: 'http://127.0.0.1:63918' });
    client._lastSessionId = 'sess-real';
    client._lastCwd = 'C:/Project';
    return client;
  }

  function ipcStream(handlers) {
    return {
      openCodeBuddyStream(_request, { onMessage, onError, onEnd }) {
        handlers({ onMessage, onError, onEnd });
        return { close: () => {} };
      },
    };
  }

  it('requestStreamingIpc transport onError 立即标记连接断开并触发重连', async () => {
    const client = makeClient();
    let onErrorRef;
    window.electronAPI = ipcStream(({ onError }) => {
      onErrorRef = onError;
    });

    const reconnecting = vi.fn();
    client.on('reconnecting', (event) => reconnecting(event.detail));

    const rejected = client.requestStreamingIpc(
      { jsonrpc: '2.0', method: 'session/prompt', params: { sessionId: 's1' } },
      '1',
      1000,
      null,
    );

    await onErrorRef(new Error('ipc stream died'));
    // streamFailure 保留原始 Error 的 message；transportFailure 标记由上层判定重发。
    await expect(rejected).rejects.toSatisfy((err) => err.transportFailure === true && /ipc stream died/.test(err.message));

    // 连接被立即标记为断开（不必等心跳）。
    expect(client.connected).toBe(false);
    expect(client.connectionState).toBe('reconnecting');
    expect(reconnecting).toHaveBeenCalledWith(expect.objectContaining({ attempt: 0 }));
    expect(client.connect).not.toHaveBeenCalled(); // 退避未到，尚未重试
  });

  it('requestStreamingIpc onEnd(ok:false) 5xx 视为 upstream 不触发重连', async () => {
    const client = makeClient();
    let onEndRef;
    window.electronAPI = ipcStream(({ onEnd }) => {
      onEndRef = onEnd;
    });
    const reconnecting = vi.fn();
    client.on('reconnecting', (event) => reconnecting(event.detail));

    const rejected = client.requestStreamingIpc(
      { jsonrpc: '2.0', method: 'session/prompt', params: { sessionId: 's1' } },
      '2',
      1000,
      null,
    );

    await onEndRef({ ok: false, status: 502 });
    await expect(rejected).rejects.toSatisfy(
      (err) => err.transportFailure === false && err.failureClass === 'upstream',
    );

    expect(client.connected).toBe(true); // 5xx 不拆连接
    expect(reconnecting).not.toHaveBeenCalled();
  });

  it('requestStreamingIpc onEnd(ok:false) network(status null) 触发重连', async () => {
    const client = makeClient();
    let onEndRef;
    window.electronAPI = ipcStream(({ onEnd }) => {
      onEndRef = onEnd;
    });
    const reconnecting = vi.fn();
    client.on('reconnecting', (event) => reconnecting(event.detail));

    const rejected = client.requestStreamingIpc(
      { jsonrpc: '2.0', method: 'session/prompt', params: { sessionId: 's1' } },
      '2b',
      1000,
      null,
    );

    await onEndRef({ ok: false, status: null, kind: 'network' });
    await expect(rejected).rejects.toSatisfy((err) => err.transportFailure === true);

    expect(client.connected).toBe(false);
    expect(reconnecting).toHaveBeenCalled();
  });

  it('requestStreamingIpc onEnd(ok:true) 无匹配 id 不拆连接', async () => {
    const client = makeClient();
    let onMessageRef;
    let onEndRef;
    window.electronAPI = ipcStream(({ onMessage, onEnd }) => {
      onMessageRef = onMessage;
      onEndRef = onEnd;
    });
    const reconnecting = vi.fn();
    client.on('reconnecting', (event) => reconnecting(event.detail));

    const pending = client.requestStreamingIpc(
      { jsonrpc: '2.0', method: 'session/prompt', params: { sessionId: 's1' } },
      '2c',
      1000,
      null,
    );
    // 非匹配 id 的 JSON 通知（真正结果走 GET-SSE）
    onMessageRef({ method: 'session/update', params: { sessionId: 's1' } });
    onEndRef({ ok: true, status: 200 });

    await expect(pending).rejects.toSatisfy((err) => err.transportFailure === false);
    expect(client.connected).toBe(true);
    expect(reconnecting).not.toHaveBeenCalled();
  });

  it('onError 401 触发 announceAuthRequired 且不拆连接', async () => {
    const client = makeClient();
    let onErrorRef;
    window.electronAPI = ipcStream(({ onError }) => {
      onErrorRef = onError;
    });
    const reconnecting = vi.fn();
    client.on('reconnecting', (event) => reconnecting(event.detail));
    const authRequired = vi.fn();
    window.addEventListener('codebuddy:auth-required', authRequired);

    const pending = client.requestStreamingIpc(
      { jsonrpc: '2.0', method: 'session/prompt', params: { sessionId: 's1' } },
      '2d',
      1000,
      null,
    );
    await onErrorRef({ message: 'ACP stream failed: 401', status: 401, kind: 'http' });

    await expect(pending).rejects.toSatisfy(
      (err) => err.transportFailure === false && err.failureClass === 'auth',
    );
    expect(client.connected).toBe(true);
    expect(reconnecting).not.toHaveBeenCalled();
    expect(authRequired).toHaveBeenCalled();
    window.removeEventListener('codebuddy:auth-required', authRequired);
  });

  it('onError 429 不触发重连', async () => {
    const client = makeClient();
    let onErrorRef;
    window.electronAPI = ipcStream(({ onError }) => {
      onErrorRef = onError;
    });
    const reconnecting = vi.fn();
    client.on('reconnecting', (event) => reconnecting(event.detail));

    const pending = client.requestStreamingIpc(
      { jsonrpc: '2.0', method: 'session/prompt', params: { sessionId: 's1' } },
      '2e',
      1000,
      null,
    );
    await onErrorRef({ message: 'rate limited', status: 429, kind: 'http' });

    await expect(pending).rejects.toSatisfy(
      (err) => err.transportFailure === false && err.failureClass === 'rate_limit',
    );
    expect(client.connected).toBe(true);
    expect(reconnecting).not.toHaveBeenCalled();
  });

  it('onError status null (network) 触发重连', async () => {
    const client = makeClient();
    let onErrorRef;
    window.electronAPI = ipcStream(({ onError }) => {
      onErrorRef = onError;
    });
    const reconnecting = vi.fn();
    client.on('reconnecting', (event) => reconnecting(event.detail));

    const pending = client.requestStreamingIpc(
      { jsonrpc: '2.0', method: 'session/prompt', params: { sessionId: 's1' } },
      '2f',
      1000,
      null,
    );
    await onErrorRef({ message: 'ipc stream died', status: null, kind: 'network' });

    await expect(pending).rejects.toSatisfy(
      (err) => err.transportFailure === true && err.failureClass === 'transport',
    );
    expect(client.connected).toBe(false);
    expect(reconnecting).toHaveBeenCalled();
  });

  it('onError idle-timeout（主进程读循环空闲）不拆连接', async () => {
    const client = makeClient();
    let onErrorRef;
    window.electronAPI = ipcStream(({ onError }) => {
      onErrorRef = onError;
    });
    const reconnecting = vi.fn();
    client.on('reconnecting', (event) => reconnecting(event.detail));

    const pending = client.requestStreamingIpc(
      { jsonrpc: '2.0', method: 'session/prompt', params: { sessionId: 's1' } },
      '2g',
      1000,
      null,
    );
    await onErrorRef({
      message: 'CodeBuddy stream timed out after 600000ms',
      status: null,
      kind: 'idle-timeout',
    });

    await expect(pending).rejects.toSatisfy(
      (err) => err.transportFailure === false && err.failureClass === 'idle',
    );
    expect(client.connected).toBe(true);
    expect(reconnecting).not.toHaveBeenCalled();
  });

  it('已匹配的 RPC 业务错误不触发重连（区别于传输失败）', async () => {
    const client = makeClient();
    let onMessageRef;
    let onErrorRef;
    window.electronAPI = ipcStream(({ onMessage, onError }) => {
      onMessageRef = onMessage;
      onErrorRef = onError;
    });
    const reconnecting = vi.fn();
    client.on('reconnecting', (event) => reconnecting(event.detail));

    const pending = client.requestStreamingIpc(
      { jsonrpc: '2.0', method: 'session/prompt', params: { sessionId: 's1' } },
      '3',
      1000,
      null,
    );
    // 服务端先返回 RPC error 帧（已接受），再断流。
    onMessageRef({ id: '3', error: { code: -32000, message: 'rate limited' } });
    await onErrorRef(new Error('stream closed after error'));

    await expect(pending).rejects.toBeInstanceOf(AcpRpcError);
    expect(client.connected).toBe(true); // 业务错误不破坏连接
    expect(reconnecting).not.toHaveBeenCalled();
  });

  it('正常 resolve 不触发重连', async () => {
    const client = makeClient();
    let onMessageRef;
    let onEndRef;
    window.electronAPI = ipcStream(({ onMessage, onEnd }) => {
      onMessageRef = onMessage;
      onEndRef = onEnd;
    });
    const reconnecting = vi.fn();
    client.on('reconnecting', reconnecting);

    const pending = client.requestStreamingIpc(
      { jsonrpc: '2.0', method: 'session/prompt', params: { sessionId: 's1' } },
      '4',
      1000,
      null,
    );
    onMessageRef({ id: '4', result: { stopReason: 'end_turn' } });
    onEndRef({ ok: true, parseErrorCount: 0 });

    await expect(pending).resolves.toMatchObject({ stopReason: 'end_turn' });
    expect(client.connected).toBe(true);
    expect(reconnecting).not.toHaveBeenCalled();
  });

  it('request() 非流式硬超时标记传输失败并触发重连', async () => {
    const client = makeClient();
    client.requestHttp = vi.fn(async () => {
      const err = new Error('timed out');
      err.name = 'AbortError';
      throw err;
    });
    const reconnecting = vi.fn();
    client.on('reconnecting', reconnecting);

    await expect(client.request('session/new', { cwd: '.', mcpServers: [] })).rejects.toThrow();
    expect(client.connected).toBe(false);
    expect(reconnecting).toHaveBeenCalled();
  });

  it('request() 的 AcpRpcError 不触发重连', async () => {
    const client = makeClient();
    client.requestHttp = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ jsonrpc: '2.0', id: '5', error: { code: -32000, message: 'bad params' } }),
    }));
    const reconnecting = vi.fn();
    client.on('reconnecting', reconnecting);

    await expect(client.request('session/new', { cwd: '.', mcpServers: [] })).rejects.toBeInstanceOf(
      AcpRpcError,
    );
    expect(client.connected).toBe(true);
    expect(reconnecting).not.toHaveBeenCalled();
  });

  // ===== Phase 3: 有限退避 / restoreConnection / 代际 / kill switch =====

  it('退避最多 maxReconnectAttempts 次后 reconnect_failed 且不再调度', async () => {
    const client = makeRealClient();
    client.autoReconnectEnabled = true;
    client.requestHttp = vi.fn(async () => {
      throw new Error('connect refused');
    });
    const failed = vi.fn();
    client.on('reconnect_failed', (event) => failed(event.detail));

    client.markConnectionBroken('test');

    // 退避：1+2+4+8+16+30*4 = 151s 覆盖 10 次尝试；多推进一点确保没有第 11 次。
    await vi.advanceTimersByTimeAsync(200000);

    expect(failed).toHaveBeenCalledTimes(1);
    expect(client.reconnecting).toBe(false);
    expect(client._reconnectTimer).toBeNull();
    // 尝试次数：0..9 共 10 次，每次 connect 抛错；第 10 次后 attempts>=max → failed。
    expect(failed.mock.calls[0][0].attempts).toBeGreaterThanOrEqual(client.maxReconnectAttempts);
  });

  it('restoreConnection 成功：connect → initialize → session/load → reconnected(sessionBound)', async () => {
    const client = makeRealClient();
    const calls = [];
    client.requestHttp = vi.fn(async (path, init) => {
      calls.push(path);
      if (path === '/api/v1/acp/connect') {
        return { ok: true, status: 200, json: async () => ({ connectionId: 'conn-new', sessionToken: 'tok' }) };
      }
      if (path === '/api/v1/acp' && init?.body) {
        const body = JSON.parse(init.body);
        if (body.method === 'initialize') {
          return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }) };
        }
        if (body.method === 'session/load') {
          return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { sessionId: 'sess-real' } }) };
        }
      }
      throw new Error(`unexpected ${init?.method} ${path}`);
    });

    const reconnected = vi.fn();
    client.on('reconnected', (event) => reconnected(event.detail));
    const sessionRestored = vi.fn();
    client.on('session_restored', (event) => sessionRestored(event.detail));

    await client.restoreConnection({ sessionId: 'sess-real', cwd: 'C:/Project' });

    expect(client.connected).toBe(true);
    expect(client.initialized).toBe(true);
    expect(client.sessionBound).toBe(true);
    expect(calls).toContain('/api/v1/acp/connect');
    expect(calls).toContain('/api/v1/acp'); // initialize + session/load
    // restoreConnection 本身不 emit reconnected（那是 _scheduleReconnect 的职责）
    expect(reconnected).not.toHaveBeenCalled();
    // session/load 成功后 emit session_restored，供 store 清除 sessionRestoreNeeded
    expect(sessionRestored).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-real' }));
  });

  it('后台 _scheduleReconnect 成功后 emit reconnected 且带 sessionBound', async () => {
    const client = makeRealClient();
    client.requestHttp = vi.fn(async (path, init) => {
      if (path === '/api/v1/acp/connect') {
        return { ok: true, status: 200, json: async () => ({ connectionId: 'conn-new', sessionToken: 'tok' }) };
      }
      const body = JSON.parse(init.body || '{}');
      if (body.method === 'initialize') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }) };
      }
      if (body.method === 'session/load') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { sessionId: 'sess-real' } }) };
      }
      throw new Error('unexpected');
    });

    const reconnected = vi.fn();
    client.on('reconnected', (event) => reconnected(event.detail));

    client.markConnectionBroken('test');
    expect(client.reconnecting).toBe(true);

    await vi.advanceTimersByTimeAsync(2000); // 第一次重试（1s 退避后）

    expect(reconnected).toHaveBeenCalledTimes(1);
    expect(reconnected.mock.calls[0][0].sessionBound).toBe(true);
    expect(client.reconnecting).toBe(false);
    expect(client.connected).toBe(true);
    expect(client.initialized).toBe(true);
  });

  it('代际：在飞 connect 被 markConnectionBroken 取代后不应用新连接', async () => {
    const client = makeRealClient();
    let releaseConnect;
    client.requestHttp = vi.fn(async (path) => {
      if (path === '/api/v1/acp/connect') {
        await new Promise((resolve) => {
          releaseConnect = resolve;
        });
        return { ok: true, status: 200, json: async () => ({ connectionId: 'conn-late', sessionToken: 'tok' }) };
      }
      throw new Error('unexpected');
    });

    // 发起在飞 connect
    const connecting = client.connect();
    // 等 requestHttp 进入 await
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    // 在飞期间连接被标记 broken（代际递增）
    client.markConnectionBroken('concurrent-break');

    releaseConnect();
    // 代际不符：connect 放弃应用并抛 superseded（AbortError），由调用方 catch。
    await expect(connecting).rejects.toThrow('ACP connect superseded');

    // 旧 connect 结果被放弃：connected 保持 false
    expect(client.connected).toBe(false);
    expect(client.connectionId).toBeNull();
  });

  it('kill switch: autoReconnectEnabled=false 时不调度重连', async () => {
    const client = makeRealClient();
    client.autoReconnectEnabled = false;
    const reconnecting = vi.fn();
    client.on('reconnecting', (event) => reconnecting(event.detail));
    const failed = vi.fn();
    client.on('reconnect_failed', (event) => failed(event.detail));

    client.markConnectionBroken('test');

    expect(client.connected).toBe(false);
    expect(client.reconnecting).toBe(false);
    expect(client._reconnectTimer).toBeNull();
    expect(reconnecting).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100000);
    expect(client._reconnectTimer).toBeNull();
  });

  it('reconnect() 返回真实可用性：连接失败时返回 false', async () => {
    const client = makeRealClient();
    client.requestHttp = vi.fn(async () => {
      throw new Error('connect refused');
    });

    const result = await client.reconnect({ sessionId: 'sess-real', cwd: 'C:/Project' });
    expect(result).toBe(false);
    expect(client.connected).toBe(false);
  });

  it('reconnect() 成功时返回 true 且 initialized/sessionBound', async () => {
    const client = makeRealClient();
    client.requestHttp = vi.fn(async (path, init) => {
      if (path === '/api/v1/acp/connect') {
        return { ok: true, status: 200, json: async () => ({ connectionId: 'conn-r', sessionToken: 'tok' }) };
      }
      const body = JSON.parse(init.body || '{}');
      if (body.method === 'initialize') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }) };
      }
      if (body.method === 'session/load') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { sessionId: 'sess-real' } }) };
      }
      throw new Error('unexpected');
    });

    const result = await client.reconnect({ sessionId: 'sess-real', cwd: 'C:/Project' });
    expect(result).toBeTruthy();
    expect(client.connected).toBe(true);
    expect(client.initialized).toBe(true);
    expect(client.sessionBound).toBe(true);
  });

  it('restoreConnection 在 initialize 失败后清理半初始化连接', async () => {
    const client = makeRealClient();
    const released = [];
    client.releaseConnection = vi.fn(async (id) => {
      released.push(id);
    });
    client.requestHttp = vi.fn(async (path, init) => {
      if (path === '/api/v1/acp/connect') {
        return { ok: true, status: 200, json: async () => ({ connectionId: 'conn-partial', sessionToken: 'tok' }) };
      }
      const body = JSON.parse(init.body || '{}');
      if (body.method === 'initialize') {
        throw new Error('initialize refused');
      }
      throw new Error('unexpected');
    });

    await expect(client.restoreConnection({ sessionId: 'sess-real', cwd: 'C:/Project' })).rejects.toThrow(
      'initialize refused',
    );
    expect(client.connected).toBe(false);
    expect(client.initialized).toBe(false);
    expect(client.connectionId).toBeNull();
    expect(released).toContain('conn-partial');
  });

  it('reconnect() 等待在飞 connect 共享 promise，而不是假等待', async () => {
    const client = makeRealClient();
    let releaseConnect;
    const connectStarted = new Promise((resolve) => {
      client.requestHttp = vi.fn(async (path, init) => {
        if (path === '/api/v1/acp/connect') {
          resolve();
          await new Promise((r) => {
            releaseConnect = r;
          });
          return { ok: true, status: 200, json: async () => ({ connectionId: 'conn-wait', sessionToken: 'tok' }) };
        }
        const body = JSON.parse(init.body || '{}');
        if (body.method === 'initialize') {
          return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }) };
        }
        if (body.method === 'session/load') {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { sessionId: 'sess-real' } }),
          };
        }
        throw new Error('unexpected');
      });
    });

    const first = client.connect();
    await connectStarted;
    expect(client._connecting).toBe(true);
    expect(client._connectPromise).toBeTruthy();

    const reconnecting = client.reconnect({ sessionId: 'sess-real', cwd: 'C:/Project' });
    // 释放在飞 connect，reconnect 应能等到并继续 restore。
    releaseConnect();
    const result = await reconnecting;
    await first.catch(() => null);

    expect(result).toBeTruthy();
    expect(client.connected).toBe(true);
    expect(client.initialized).toBe(true);
  });

  it('markConnectionBroken 在已 reconnecting 时重排调度但保留 attempts 预算', async () => {
    const client = makeRealClient();
    client.autoReconnectEnabled = true;
    client.reconnectDelay = 1000;
    client.requestHttp = vi.fn(async () => {
      throw new Error('connect refused');
    });

    client.markConnectionBroken('first');
    expect(client.reconnecting).toBe(true);
    const firstTimer = client._reconnectTimer;
    expect(firstTimer).toBeTruthy();

    client.reconnectAttempts = 5;
    client.markConnectionBroken('second');
    // 预算必须保留：清零会让 reconnect_failed 永不触发，破坏有限重连 SLI。
    expect(client.reconnectAttempts).toBe(5);
    expect(client._reconnectTimer).toBeTruthy();
    expect(client._reconnectTimer).not.toBe(firstTimer);
  });

  it('rearm 时 attempts 已达 max 则直接 reconnect_failed，不再重排', async () => {
    const client = makeRealClient();
    client.autoReconnectEnabled = true;
    client.maxReconnectAttempts = 3;
    client.reconnectDelay = 1000;
    client.requestHttp = vi.fn(async () => {
      throw new Error('connect refused');
    });
    const failed = vi.fn();
    client.on('reconnect_failed', (event) => failed(event.detail));

    client.markConnectionBroken('first');
    client.reconnectAttempts = 3; // 预算已耗尽
    client.markConnectionBroken('second');

    expect(failed).toHaveBeenCalledTimes(1);
    expect(client.reconnecting).toBe(false);
    expect(client._reconnectTimer).toBeNull();
  });

  it('restoreConnection 返回 sessionInvalid 时 reconnected 事件携带标记', async () => {
    const client = makeRealClient();
    client._lastSessionId = 'sess-invalid';
    client.requestHttp = vi.fn(async (path, init) => {
      if (path === '/api/v1/acp/connect') {
        return { ok: true, status: 200, json: async () => ({ connectionId: 'conn-sinv', sessionToken: 'tok' }) };
      }
      const body = JSON.parse(init.body || '{}');
      if (body.method === 'initialize') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }) };
      }
      if (body.method === 'session/load') {
        // 会话不存在 → sessionInvalid 判定（HTTP 4xx，避免被归为 transport）
        const err = new Error('session not found');
        err.status = 404;
        throw err;
      }
      throw new Error('unexpected');
    });
    const reconnected = vi.fn();
    client.on('reconnected', (event) => reconnected(event.detail));
    const invalid = vi.fn();
    client.on('session_invalid', (event) => invalid(event.detail));

    client.markConnectionBroken('test');
    await vi.advanceTimersByTimeAsync(2000);

    expect(invalid).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-invalid' }));
    expect(reconnected).toHaveBeenCalledTimes(1);
    expect(reconnected.mock.calls[0][0].sessionInvalid).toBe(true);
    expect(reconnected.mock.calls[0][0].sessionBound).toBe(false);
  });

  it('reconnect() 对 sessionInvalid 返回 false（session_invalid 事件已发出）', async () => {
    const client = makeRealClient();
    client.requestHttp = vi.fn(async (path, init) => {
      if (path === '/api/v1/acp/connect') {
        return { ok: true, status: 200, json: async () => ({ connectionId: 'conn-r2', sessionToken: 'tok' }) };
      }
      const body = JSON.parse(init.body || '{}');
      if (body.method === 'initialize') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }) };
      }
      if (body.method === 'session/load') {
        const err = new Error('unknown session');
        err.status = 404;
        throw err;
      }
      throw new Error('unexpected');
    });

    const result = await client.reconnect({ sessionId: 'sess-gone', cwd: 'C:/Project' });
    expect(result).toBe(false);
  });

  it('kill switch 关闭时 connect 失败不触发自动重连', async () => {
    const client = makeRealClient();
    client.setAutoReconnectEnabled(false);
    client.requestHttp = vi.fn(async () => {
      throw new Error('connect refused');
    });
    const reconnecting = vi.fn();
    client.on('reconnecting', (event) => reconnecting(event.detail));

    await expect(client.connect()).rejects.toThrow('connect refused');
    expect(client.connected).toBe(false);
    expect(client.reconnecting).toBe(false);
    expect(client._reconnectTimer).toBeNull();
    expect(reconnecting).not.toHaveBeenCalled();
  });
});