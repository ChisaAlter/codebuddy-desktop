import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpClient, AcpRpcError, isAcpAuthenticationError, setApiBase } from '../../src/lib/acp';

function sseResponse(text) {
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
  };
}

describe('AcpClient GET SSE notification stream', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    setApiBase('http://127.0.0.1:63918');
    delete window.electronAPI;
  });

  it('retains native authentication methods and authenticates through ACP', async () => {
    const client = new AcpClient();
    client.connected = true;
    client.connectionId = 'conn-auth';
    client.request = vi
      .fn()
      .mockResolvedValueOnce({ authMethods: [{ id: 'iOA', name: 'Login with iOA' }] })
      .mockResolvedValueOnce({ _meta: { 'codebuddy.ai/userinfo': { userId: 'user-1' } } });

    await client.initialize();
    await expect(client.authenticate('iOA')).resolves.toMatchObject({
      _meta: { 'codebuddy.ai/userinfo': { userId: 'user-1' } },
    });
    expect(client.authMethods).toEqual([{ id: 'iOA', name: 'Login with iOA' }]);
    expect(client.request).toHaveBeenNthCalledWith(2, 'authenticate', { methodId: 'iOA' });
  });

  it('readSseStream 能跨 chunk 解析 SSE 消息', async () => {
    const client = new AcpClient();
    const messages = [];
    const response = {
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"method":"session/'));
          controller.enqueue(new TextEncoder().encode('update","params":{"ok":true}}\n\n'));
          controller.close();
        },
      }),
    };

    await client.readSseStream(response, (message) => messages.push(message));

    expect(messages).toEqual([{ method: 'session/update', params: { ok: true } }]);
  });

  it('connect 后可通过 Electron IPC stream 派发 session/update', async () => {
    setApiBase('http://127.0.0.1:23456');
    const fetchMock = vi.fn(async (url, init = {}) => {
      const method = init.method || 'GET';
      if (url === 'http://127.0.0.1:23456/api/v1/acp/connect' && method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ connectionId: 'conn-ipc', sessionToken: 'sess-ipc' }),
        };
      }
      if (url === 'http://127.0.0.1:23456/api/v1/acp/connect/conn-ipc' && method === 'DELETE') {
        return { ok: true, status: 204, text: async () => '' };
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    let closeCalled = false;
    let openedRequest = null;
    window.electronAPI = {
      openCodeBuddyStream(request, handlers) {
        openedRequest = request;
        queueMicrotask(() =>
          handlers.onMessage({
            method: 'session/update',
            params: { sessionId: 's-ipc', update: { sessionUpdate: 'agent_message_chunk' } },
          }),
        );
        return {
          close: () => {
            closeCalled = true;
          },
        };
      },
    };

    const client = new AcpClient();
    const updates = [];
    client.on('session/update', (event) => updates.push(event.detail));

    await client.connect();

    await vi.waitFor(() => {
      expect(updates).toHaveLength(1);
    });
    expect(openedRequest).toMatchObject({
      url: 'http://127.0.0.1:23456/api/v1/acp',
      timeoutMs: 0,
      headers: expect.objectContaining({
        Accept: 'text/event-stream',
        'acp-connection-id': 'conn-ipc',
        'acp-session-token': 'sess-ipc',
      }),
    });
    expect(updates[0]).toMatchObject({ sessionId: 's-ipc' });

    await client.disconnect();
    expect(closeCalled).toBe(true);
  });

  it('session/new 返回后仍处理同一 POST 流里的延迟指令列表', async () => {
    window.electronAPI = {
      requestCodeBuddy: vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'text/event-stream' },
        body: [
          'event: message',
          'data: {"jsonrpc":"2.0","id":"1","result":{"sessionId":"session-delayed"}}',
          '',
          'event: message',
          'data: {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session-delayed","update":{"sessionUpdate":"available_commands_update","availableCommands":[{"name":"help","description":"Show help"}]}}}',
          '',
          '',
        ].join('\n'),
      })),
    };

    const client = new AcpClient({ apiBase: 'http://127.0.0.1:45679' });
    client.connected = true;
    client.connectionId = 'conn-delayed';
    const updates = [];
    client.on('session/update', (event) => updates.push(event.detail));

    await expect(client.request('session/new', { cwd: '.', mcpServers: [] })).resolves.toEqual({
      sessionId: 'session-delayed',
    });
    expect(updates).toEqual([
      {
        sessionId: 'session-delayed',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'help', description: 'Show help' }],
        },
      },
    ]);
  });

  it('request 在最终结果返回前逐条派发 POST SSE 更新', async () => {
    setApiBase('http://127.0.0.1:34568');
    let releaseResult;
    const fetchMock = vi.fn(async (url, init = {}) => {
      const method = init.method || 'GET';
      if (url === 'http://127.0.0.1:34568/api/v1/acp' && method === 'POST') {
        const body = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"method":"session/update","params":{"sessionId":"s-stream","update":{"sessionUpdate":"agent_message_chunk","messageId":"m1","content":{"type":"text","text":"第一段"}}}}\n\n',
                ),
              );
              releaseResult = () => {
                controller.enqueue(
                  new TextEncoder().encode(`data: {"jsonrpc":"2.0","id":"${body.id}","result":null}\n\n`),
                );
                controller.close();
              };
            },
          }),
        };
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new AcpClient();
    client.connected = true;
    client.connectionId = 'conn-stream';
    const updates = [];
    client.on('session/update', (event) => updates.push(event.detail));
    let requestResolved = false;
    const request = client
      .request(
        'session/prompt',
        { sessionId: 's-stream', prompt: [] },
        { promptRunId: 'run-current' },
      )
      .then((result) => {
      requestResolved = true;
        return result;
      });

    await vi.waitFor(() => expect(updates).toHaveLength(1));
    expect(requestResolved).toBe(false);
    expect(updates[0]).toMatchObject({
      sessionId: 's-stream',
      _client: { source: 'request', promptRunId: 'run-current' },
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1' },
    });

    releaseResult();
    await expect(request).resolves.toBeNull();
  });

  it('Electron IPC POST 流在 RPC 结果先到时仍排空后续消息块', async () => {
    let handlers;
    let openedRequest;
    let closeCalled = false;
    window.electronAPI = {
      openCodeBuddyStream(request, nextHandlers) {
        openedRequest = request;
        handlers = nextHandlers;
        return {
          close: () => {
            closeCalled = true;
          },
        };
      },
    };

    const client = new AcpClient({ apiBase: 'http://127.0.0.1:45678' });
    client.connected = true;
    client.connectionId = 'conn-ipc-stream';
    client.sessionToken = 'token-ipc-stream';
    const updates = [];
    client.on('session/update', (event) => updates.push(event.detail));
    let requestResolved = false;
    const request = client.request('session/prompt', { sessionId: 's-ipc-stream', prompt: [] }).then((result) => {
      requestResolved = true;
      return result;
    });

    handlers.onMessage({ jsonrpc: '2.0', id: '1', result: { stopReason: 'end_turn' } });
    expect(requestResolved).toBe(false);
    expect(closeCalled).toBe(false);

    handlers.onMessage({
      method: 'session/update',
      params: {
        sessionId: 's-ipc-stream',
        update: {
          sessionUpdate: 'agent_thought_chunk',
          messageId: 'thought-1',
          content: { type: 'text', text: '正在分析' },
        },
      },
    });
    expect(openedRequest).toMatchObject({
      url: 'http://127.0.0.1:45678/api/v1/acp',
      method: 'POST',
      rpcId: '1',
      timeoutMs: 10 * 60 * 1000,
      headers: expect.objectContaining({
        'acp-connection-id': 'conn-ipc-stream',
        'acp-session-token': 'token-ipc-stream',
      }),
    });
    expect(updates[0]).toMatchObject({
      update: { sessionUpdate: 'agent_thought_chunk', messageId: 'thought-1' },
    });
    expect(requestResolved).toBe(false);

    handlers.onEnd({ ok: true, status: 200, statusText: 'OK' });
    await expect(request).resolves.toEqual({ stopReason: 'end_turn' });
    expect(closeCalled).toBe(true);
  });

  it('rejects a matched Electron RPC result when a later malformed stream event is reported', async () => {
    let handlers;
    const close = vi.fn();
    window.electronAPI = {
      openCodeBuddyStream(_request, nextHandlers) {
        handlers = nextHandlers;
        return { close };
      },
    };

    const client = new AcpClient({ apiBase: 'http://127.0.0.1:45678' });
    client.connected = true;
    client.connectionId = 'conn-malformed-tail';
    const request = client.request('session/prompt', { sessionId: 's-malformed-tail', prompt: [] });

    handlers.onMessage({ jsonrpc: '2.0', id: '1', result: { stopReason: 'end_turn' } });
    handlers.onError('ACP stream contained 1 invalid event(s)');

    const error = await request.catch((value) => value);
    expect(error).toMatchObject({ message: expect.stringContaining('invalid event'), promptAccepted: true });
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects a POST stream end that reports malformed events after the RPC result', async () => {
    let handlers;
    window.electronAPI = {
      openCodeBuddyStream(_request, nextHandlers) {
        handlers = nextHandlers;
        return { close: vi.fn() };
      },
    };
    const client = new AcpClient({ apiBase: 'http://127.0.0.1:45678' });
    client.connected = true;
    client.connectionId = 'conn-malformed-end';
    const request = client.request('session/prompt', { sessionId: 's-malformed-end', prompt: [] });

    handlers.onMessage({ jsonrpc: '2.0', id: '1', result: { stopReason: 'end_turn' } });
    handlers.onEnd({ ok: true, status: 200, parseErrorCount: 1 });

    const error = await request.catch((value) => value);
    expect(error).toMatchObject({ message: expect.stringContaining('contained 1 invalid event'), promptAccepted: true });
  });

  it('uses the active prompt request stream as the canonical source for live content', () => {
    const client = new AcpClient();
    const updates = [];
    client.on('session/update', (event) => updates.push(event.detail.update.content.text));
    const message = {
      method: 'session/update',
      params: {
        sessionId: 's-active',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'm-active',
          content: { type: 'text', text: 'CURRENT' },
        },
      },
    };
    const unregister = client.trackActivePrompt('s-active', () => {});

    client.handleIncomingRpc(message, 'notification');
    client.handleIncomingRpc(message, 'request', { promptRunId: 'run-current' });
    unregister();

    expect(updates).toEqual(['CURRENT']);
  });
  it('delivers the buffered notification copy when the POST stream never provides it', async () => {
    vi.useFakeTimers();
    try {
      const client = new AcpClient();
      const updates = [];
      client.on('session/update', (event) => updates.push(event.detail));
      const unregister = client.trackActivePrompt('s-fallback', () => {}, { promptRunId: 'run-fallback' });
      const message = {
        method: 'session/update',
        params: {
          sessionId: 's-fallback',
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'm-fallback',
            content: { type: 'text', text: 'FALLBACK' },
            _meta: { 'codebuddy.ai/requestId': 'backend-fallback' },
          },
        },
      };

      client.handleIncomingRpc(message, 'notification');
      expect(updates).toEqual([]);
      await vi.advanceTimersByTimeAsync(81);

      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({
        update: { content: { text: 'FALLBACK' } },
        _client: { source: 'notification', promptRunId: 'run-fallback' },
      });
      unregister();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the notification fallback when the matching POST copy arrives first', async () => {
    vi.useFakeTimers();
    try {
      const client = new AcpClient();
      const updates = [];
      client.on('session/update', (event) => updates.push(event.detail.update.content.text));
      const unregister = client.trackActivePrompt('s-race', () => {}, { promptRunId: 'run-race' });
      const message = {
        method: 'session/update',
        params: {
          sessionId: 's-race',
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'm-race',
            content: { type: 'text', text: 'POST_WINS' },
            _meta: { 'codebuddy.ai/requestId': 'backend-race' },
          },
        },
      };

      client.handleIncomingRpc(message, 'notification');
      client.handleIncomingRpc(message, 'request', { promptRunId: 'run-race' });
      await vi.advanceTimersByTimeAsync(81);

      expect(updates).toEqual(['POST_WINS']);
      unregister();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a delayed notification mapped to its original backend prompt run', async () => {
    vi.useFakeTimers();
    try {
      const client = new AcpClient();
      const updates = [];
      client.on('session/update', (event) => updates.push(event.detail));
      client.handleIncomingRpc(
        {
          method: 'session/update',
          params: {
            sessionId: 's-mapped',
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'm-old-first',
              content: { type: 'text', text: 'OLD_FIRST' },
              _meta: { 'codebuddy.ai/requestId': 'backend-old' },
            },
          },
        },
        'request',
        { promptRunId: 'run-old' },
      );
      updates.length = 0;
      const unregister = client.trackActivePrompt('s-mapped', () => {}, { promptRunId: 'run-new' });

      client.handleIncomingRpc(
        {
          method: 'session/update',
          params: {
            sessionId: 's-mapped',
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'm-old-late',
              content: { type: 'text', text: 'OLD_LATE' },
              _meta: { 'codebuddy.ai/requestId': 'backend-old' },
            },
          },
        },
        'notification',
      );
      await vi.advanceTimersByTimeAsync(81);

      expect(updates).toHaveLength(1);
      expect(updates[0]._client).toMatchObject({ source: 'notification', promptRunId: 'run-old' });
      unregister();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves repeated identical notification chunks when only one POST copy arrives', async () => {
    vi.useFakeTimers();
    try {
      const client = new AcpClient();
      const updates = [];
      client.on('session/update', (event) => updates.push(event.detail.update.content.text));
      const unregister = client.trackActivePrompt('s-repeat', () => {}, { promptRunId: 'run-repeat' });
      const message = {
        method: 'session/update',
        params: {
          sessionId: 's-repeat',
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'm-repeat',
            content: { type: 'text', text: 'REPEAT' },
            _meta: { 'codebuddy.ai/requestId': 'backend-repeat' },
          },
        },
      };

      client.handleIncomingRpc(message, 'notification');
      client.handleIncomingRpc(message, 'notification');
      client.handleIncomingRpc(message, 'request', { promptRunId: 'run-repeat' });
      await vi.advanceTimersByTimeAsync(81);

      expect(updates).toEqual(['REPEAT', 'REPEAT']);
      unregister();
    } finally {
      vi.useRealTimers();
    }
  });

  it('queues uncorrelated notification content while another prompt is active, then delivers with last run id', async () => {
    vi.useFakeTimers();
    try {
      const client = new AcpClient();
      const updates = [];
      client.on('session/update', (event) => updates.push(event.detail));
      const unregister = client.trackActivePrompt('s-uncorrelated', () => {}, { promptRunId: 'run-current' });

      client.handleIncomingRpc(
        {
          method: 'session/update',
          params: {
            sessionId: 's-uncorrelated',
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'unknown-late',
              content: { type: 'text', text: 'UNKNOWN_LATE' },
            },
          },
        },
        'notification',
      );
      // Still held while the prompt POST is active (POST is preferred when it carries the same chunk).
      expect(updates).toEqual([]);
      await vi.advanceTimersByTimeAsync(100);
      // Fallback delivers after PROMPT_NOTIFICATION_FALLBACK_MS with the active/last run id.
      expect(updates).toHaveLength(1);
      expect(updates[0].update.content.text).toBe('UNKNOWN_LATE');
      expect(updates[0]._client).toMatchObject({ source: 'notification', promptRunId: 'run-current' });
      unregister();
    } finally {
      vi.useRealTimers();
    }
  });

  it('correlates late SSE without requestId to the last prompt run after the stream closes', async () => {
    vi.useFakeTimers();
    try {
      const client = new AcpClient();
      const updates = [];
      client.on('session/update', (event) => updates.push(event.detail));
      const unregister = client.trackActivePrompt('s-late-sse', () => {}, { promptRunId: 'run-just-finished' });
      unregister();
      updates.length = 0;

      client.handleIncomingRpc(
        {
          method: 'session/update',
          params: {
            sessionId: 's-late-sse',
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'late-final',
              content: { type: 'text', text: 'LATE_FINAL_BODY' },
            },
          },
        },
        'notification',
      );

      expect(updates).toHaveLength(1);
      expect(updates[0].update.content.text).toBe('LATE_FINAL_BODY');
      expect(updates[0]._client).toMatchObject({ promptRunId: 'run-just-finished' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('usage-refresh and rebind do not stamp latePromptContext promptRunId', () => {
    const client = new AcpClient();
    const updates = [];
    client.on('session/update', (event) => updates.push(event.detail));
    const unregister = client.trackActivePrompt('s-usage-refresh', () => {}, { promptRunId: 'run-just-finished' });
    unregister();

    client.handleIncomingRpc(
      {
        method: 'session/update',
        params: {
          sessionId: 's-usage-refresh',
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'hist-load',
            content: { type: 'text', text: 'SHOULD_NOT_INHERIT_RUN' },
          },
        },
      },
      'request',
      { mode: 'usage-refresh' },
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]._client).toEqual({ source: 'request', mode: 'usage-refresh' });

    updates.length = 0;
    client.handleIncomingRpc(
      {
        method: 'session/update',
        params: {
          sessionId: 's-usage-refresh',
          update: { sessionUpdate: 'usage_update', used: 1, size: 10 },
        },
      },
      'request',
      { mode: 'usage-refresh' },
    );
    expect(updates[0]._client).toEqual({ source: 'request', mode: 'usage-refresh' });

    updates.length = 0;
    client.handleIncomingRpc(
      {
        method: 'session/update',
        params: {
          sessionId: 's-usage-refresh',
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'rebind-hist',
            content: { type: 'text', text: 'REBIND' },
          },
        },
      },
      'request',
      { mode: 'rebind' },
    );
    expect(updates[0]._client).toEqual({ source: 'request', mode: 'rebind' });
  });

  it('retains the mapped prompt run on a late notification after the prompt stream closes', () => {
    const client = new AcpClient();
    const updates = [];
    client.on('session/update', (event) => updates.push(event.detail));
    client.handleIncomingRpc(
      {
        method: 'session/update',
        params: {
          sessionId: 's-late-mapped',
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'mapped-first',
            content: { type: 'text', text: 'FIRST' },
            _meta: { 'codebuddy.ai/requestId': 'backend-mapped-late' },
          },
        },
      },
      'request',
      { promptRunId: 'run-finished' },
    );
    updates.length = 0;

    client.handleIncomingRpc(
      {
        method: 'session/update',
        params: {
          sessionId: 's-late-mapped',
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'mapped-late',
            content: { type: 'text', text: 'LATE' },
            _meta: { 'codebuddy.ai/requestId': 'backend-mapped-late' },
          },
        },
      },
      'notification',
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]._client).toMatchObject({ source: 'notification', promptRunId: 'run-finished' });
  });

  it('marks an unknown idle notification request as a server-initiated turn', () => {
    const client = new AcpClient();
    const updates = [];
    client.on('session/update', (event) => updates.push(event.detail));

    client.handleIncomingRpc(
      {
        method: 'session/update',
        params: {
          sessionId: 's-background',
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'background-first',
            content: { type: 'text', text: 'BACKGROUND_FINAL' },
            _meta: { 'codebuddy.ai/requestId': 'backend-background' },
          },
        },
      },
      'notification',
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]._client).toEqual({
      source: 'notification',
      requestId: 'backend-background',
      serverInitiated: true,
    });
  });

  it('marks the matching idle session_end as a server-initiated terminal event', () => {
    const client = new AcpClient();
    const updates = [];
    client.on('session/update', (event) => updates.push(event.detail));

    client.handleIncomingRpc(
      {
        method: 'session/update',
        params: {
          sessionId: 's-background-end',
          update: {
            sessionUpdate: 'session_end',
            _meta: { 'codebuddy.ai/requestId': 'backend-background-end' },
          },
        },
      },
      'notification',
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]._client).toEqual({
      source: 'notification',
      requestId: 'backend-background-end',
      serverInitiated: true,
    });
  });

  it('does not attach a fresh notification request to the previous prompt late window', () => {
    const client = new AcpClient();
    const updates = [];
    client.on('session/update', (event) => updates.push(event.detail));
    const unregister = client.trackActivePrompt('s-background-race', () => {}, { promptRunId: 'run-previous' });
    unregister();

    client.handleIncomingRpc(
      {
        method: 'session/update',
        params: {
          sessionId: 's-background-race',
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'background-race-first',
            content: { type: 'text', text: 'BACKGROUND_NEW_TURN' },
            _meta: { 'codebuddy.ai/requestId': 'backend-new-turn' },
          },
        },
      },
      'notification',
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]._client).toEqual({
      source: 'notification',
      requestId: 'backend-new-turn',
      serverInitiated: true,
    });
  });

  it('deduplicates interleaved POST and notification copies without dropping repeated live text', () => {
    const client = new AcpClient();
    const updates = [];
    client.on('session/update', (event) => updates.push(event.detail.update.content.text));
    const first = {
      method: 'session/update',
      params: {
        sessionId: 's-dual',
        update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'A' } },
      },
    };
    const second = {
      method: 'session/update',
      params: {
        sessionId: 's-dual',
        update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'B' } },
      },
    };

    client.handleIncomingRpc(first, 'request');
    client.handleIncomingRpc(second, 'request');
    client.handleIncomingRpc(first, 'notification');
    client.handleIncomingRpc(second, 'notification');
    client.handleIncomingRpc(first, 'request');

    expect(updates).toEqual(['A', 'B', 'A']);
  });

  it('rejects an Electron POST stream that ends without the matching RPC result', async () => {
    let handlers;
    window.electronAPI = {
      openCodeBuddyStream(_request, nextHandlers) {
        handlers = nextHandlers;
        return { close: vi.fn() };
      },
    };
    const client = new AcpClient({ apiBase: 'http://127.0.0.1:45678' });
    client.connected = true;
    client.connectionId = 'conn-missing-result';
    const request = client.request('session/prompt', { sessionId: 's-missing-result', prompt: [] });

    handlers.onEnd({ ok: true, status: 200, statusText: 'OK' });

    await expect(request).rejects.toThrow('before RPC result');
  });

  it('rejects truncated Electron proxy responses without a matching RPC result', async () => {
    window.electronAPI = {
      requestCodeBuddy: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'text/event-stream' },
        body: 'data: {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-trunc","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"partial"}}}}\n\n',
        truncated: true,
      }),
    };
    const client = new AcpClient({ apiBase: 'http://127.0.0.1:45678' });
    client.connected = true;
    client.connectionId = 'conn-truncated';

    await expect(client.request('session/prompt', { sessionId: 's-trunc', prompt: [] })).rejects.toThrow(
      'ACP 响应流意外中断',
    );
  });

  it('returns a matched RPC result even when the Electron proxy marks the body truncated', async () => {
    window.electronAPI = {
      requestCodeBuddy: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'text/event-stream' },
        body: 'data: {"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}\n\n',
        truncated: true,
      }),
    };
    const client = new AcpClient({ apiBase: 'http://127.0.0.1:45678' });
    client.connected = true;
    client.connectionId = 'conn-truncated-matched';
    client.nextId = 1;

    await expect(client.request('session/prompt', { sessionId: 's-trunc-ok', prompt: [] })).resolves.toEqual({
      stopReason: 'end_turn',
    });
  });
  it('sends session/cancel as a JSON-RPC notification without an id', async () => {
    window.electronAPI = {
      requestCodeBuddy: vi.fn().mockResolvedValue({
        ok: true,
        status: 202,
        statusText: 'Accepted',
        headers: {},
        body: '',
      }),
    };
    const client = new AcpClient({ apiBase: 'http://127.0.0.1:45678' });
    client.connected = true;
    client.connectionId = 'conn-notify';
    client.sessionToken = 'token-notify';

    await expect(client.notify('session/cancel', { sessionId: 's-cancel' })).resolves.toBe(true);

    const request = window.electronAPI.requestCodeBuddy.mock.calls[0][0];
    expect(JSON.parse(request.body)).toEqual({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: 's-cancel' },
    });
    expect(JSON.parse(request.body)).not.toHaveProperty('id');
  });
  it('rejects a successful HTTP notification response that contains a JSON-RPC error', async () => {
    window.electronAPI = {
      requestCodeBuddy: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Cancellation rejected' },
        }),
      }),
    };
    const client = new AcpClient({ apiBase: 'http://127.0.0.1:45678' });
    client.connected = true;
    client.connectionId = 'conn-notify-error';

    await expect(client.notify('session/cancel', { sessionId: 's-cancel' })).rejects.toMatchObject({
      name: 'AcpRpcError',
      code: -32001,
      message: 'Cancellation rejected',
    });
  });

  it('locally cancels the active Electron prompt stream', async () => {
    let closeCalled = false;
    window.electronAPI = {
      openCodeBuddyStream() {
        return {
          close: () => {
            closeCalled = true;
          },
        };
      },
    };

    const client = new AcpClient({ apiBase: 'http://127.0.0.1:45678' });
    client.connected = true;
    client.connectionId = 'conn-cancel';
    const request = client.request('session/prompt', { sessionId: 's-cancel', prompt: [] });

    expect(client.cancelActivePrompt('s-cancel')).toBe(true);
    await expect(request).rejects.toThrow('cancelled by user');
    expect(closeCalled).toBe(true);
    expect(client.cancelActivePrompt('s-cancel')).toBe(false);
  });

  it('request 收到 result:null 时仍视为匹配到响应', async () => {
    setApiBase('http://127.0.0.1:34567');
    const fetchMock = vi.fn(async (url, init = {}) => {
      const method = init.method || 'GET';
      if (url === 'http://127.0.0.1:34567/api/v1/acp' && method === 'POST') {
        const body = JSON.parse(init.body);
        return sseResponse(`data: {"jsonrpc":"2.0","id":"${body.id}","result":null}\n\n`);
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new AcpClient();
    client.connected = true;
    client.connectionId = 'conn-null';

    await expect(client.request('session/prompt', { sessionId: 's1', prompt: [] })).resolves.toBeNull();
  });

  it('preserves ACP authentication error metadata', async () => {
    window.electronAPI = {
      requestCodeBuddy: vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: '1',
          error: { code: -32000, message: 'Authentication required', data: { category: 'auth' } },
        }),
      })),
    };
    const client = new AcpClient({ apiBase: 'http://127.0.0.1:45678' });
    client.connected = true;
    client.connectionId = 'conn-auth';

    const error = await client.request('initialize', {}).catch((value) => value);
    expect(error).toBeInstanceOf(AcpRpcError);
    expect(error).toMatchObject({ code: -32000, category: 'auth', data: { category: 'auth' } });
    expect(isAcpAuthenticationError(error)).toBe(true);
  });

  it('connect 后建立 GET /api/v1/acp 长连接并派发 session/update', async () => {
    setApiBase('http://127.0.0.1:12345');
    const fetchMock = vi.fn(async (url, init = {}) => {
      const method = init.method || 'GET';
      if (url === 'http://127.0.0.1:12345/api/v1/acp/connect' && method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ connectionId: 'conn-1', sessionToken: 'sess-1' }),
        };
      }
      if (url === 'http://127.0.0.1:12345/api/v1/acp' && method === 'GET') {
        return sseResponse(
          'data: {"method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":[{"type":"text","text":"pong"}]}}}\n\n',
        );
      }
      if (url === 'http://127.0.0.1:12345/api/v1/acp/connect/conn-1' && method === 'DELETE') {
        return { ok: true, status: 204, text: async () => '' };
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new AcpClient();
    const updates = [];
    client.on('session/update', (event) => updates.push(event.detail));

    await client.connect();

    await vi.waitFor(() => {
      expect(updates).toHaveLength(1);
    });
    expect(updates[0]).toMatchObject({
      sessionId: 's1',
      update: { sessionUpdate: 'agent_message_chunk' },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:12345/api/v1/acp',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'text/event-stream',
          'acp-connection-id': 'conn-1',
          'acp-session-token': 'sess-1',
        }),
      }),
    );

    await client.disconnect();
  });

  // M-st8: concurrent connect() calls must not double-issue /acp/connect. The
  // _connecting guard makes the second call return early.
  it('does not double-issue /acp/connect when two connect() calls race', async () => {
    setApiBase('http://127.0.0.1:23457');
    let connectCalls = 0;
    let releaseConnect;
    const fetchMock = vi.fn(async (url, init = {}) => {
      const method = init.method || 'GET';
      if (url === 'http://127.0.0.1:23457/api/v1/acp/connect' && method === 'POST') {
        connectCalls += 1;
        // Hold the first connect until both connect() calls have been dispatched.
        return new Promise((resolve) => {
          releaseConnect = () =>
            resolve({
              ok: true,
              status: 200,
              json: async () => ({ connectionId: 'conn-race', sessionToken: 'sess-race' }),
            });
        });
      }
      if (url === 'http://127.0.0.1:23457/api/v1/acp/connect/conn-race' && method === 'DELETE') {
        return { ok: true, status: 204, text: async () => '' };
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    window.electronAPI = {
      openCodeBuddyStream: () => ({ close: () => {} }),
    };

    const client = new AcpClient();
    const p1 = client.connect();
    const p2 = client.connect();
    // Release the in-flight connect so both promises can settle.
    releaseConnect();
    await Promise.all([p1, p2]);

    expect(connectCalls).toBe(1);
    await client.disconnect();
  });
});

describe('AcpClient _codebuddy.ai/authUrl notification', () => {
  it('emits the auth URL as a client event (GUI opens the browser from it)', () => {
    const client = new AcpClient();
    const received = [];
    const off = client.on('_codebuddy.ai/authUrl', (event) => received.push(event.detail));

    client.handleIncomingRpc(
      {
        jsonrpc: '2.0',
        method: '_codebuddy.ai/authUrl',
        params: { authUrl: 'https://www.codebuddy.cn/oauth/authorize?app=1', provider: 'external' },
      },
      'notification',
    );
    off();

    expect(received).toEqual([
      { authUrl: 'https://www.codebuddy.cn/oauth/authorize?app=1', provider: 'external' },
    ]);
  });

  it('GET-SSE progress touches active session/prompt idle timer', async () => {
    vi.useFakeTimers();
    let handlers;
    window.electronAPI = {
      openCodeBuddyStream(_request, nextHandlers) {
        handlers = nextHandlers;
        return { close: () => {} };
      },
    };
    const client = new AcpClient({ apiBase: 'http://127.0.0.1:45678' });
    client.connected = true;
    client.connectionId = 'conn-idle';
    const request = client.request('session/prompt', { sessionId: 's-idle', prompt: [] });
    // Advance just under idle window, then SSE thought should re-arm.
    await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
    client.handleIncomingRpc(
      {
        method: 'session/update',
        params: {
          sessionId: 's-idle',
          update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'still working' } },
        },
      },
      'notification',
    );
    await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
    handlers.onMessage({ jsonrpc: '2.0', id: '1', result: { stopReason: 'end_turn' } });
    handlers.onEnd({ ok: true, status: 200 });
    await expect(request).resolves.toEqual({ stopReason: 'end_turn' });
    vi.useRealTimers();
  });
});
