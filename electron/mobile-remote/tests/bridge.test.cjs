'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createBridge } = require('../bridge.cjs');

function makeFakeNet() {
  const handlers = new Map();
  return {
    fetch: async (url, opts) => {
      const key = `${opts.method || 'GET'} ${url}`;
      const h = handlers.get(key) || handlers.get(url);
      if (h) return h(opts);
      return { ok: false, status: 404, statusText: 'Not Found', text: async () => 'no handler' };
    },
    setHandler(key, fn) { handlers.set(key, fn); },
  };
}

function makeFakeRuntimeManager() {
  const runtimes = new Map();
  return {
    ensure: async (projectId) => runtimes.get(projectId) || { port: 0, status: 'error' },
    list: () => Array.from(runtimes.values()),
    setRuntime(projectId, rt) { runtimes.set(projectId, rt); },
  };
}

describe('bridge.dispatch', () => {
  // C1: most ops now require an authenticated connection. Helper builds an
  // authenticated ctx; use { send } only for the unauthenticated handshake trio.
  function authCtx(deviceId = 'dev-authed') {
    const sent = [];
    return { ctx: { send: (m) => sent.push(m), authenticated: true, deviceId, connectionId: 'c1' }, sent };
  }

  it('list_projects returns projects from product state', async () => {
    const net = makeFakeNet();
    const rm = makeFakeRuntimeManager();
    rm.setRuntime('p1', { projectId: 'p1', cwd: '/x', status: 'running', port: 1111, pid: 1 });
    const bridge = createBridge({
      net,
      runtimeManager: rm,
      getProductState: () => ({
        projectsById: { p1: { name: 'Proj', workspacePath: '/x' } },
        projectOrder: ['p1'],
        threadsById: {},
        threadOrderByProject: {},
      }),
    });
    const { ctx, sent } = authCtx();
    await bridge.dispatch(ctx, { type: 'list_projects', id: 'a' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'projects');
    assert.equal(sent[0].projects[0].projectId, 'p1');
    assert.equal(sent[0].projects[0].name, 'Proj');
  });

  it('ping returns pong without authentication', async () => {
    const bridge = createBridge({ net: makeFakeNet(), runtimeManager: makeFakeRuntimeManager(), getProductState: () => ({}) });
    const sent = [];
    await bridge.dispatch({ send: (m) => sent.push(m) }, { type: 'ping', id: 'p' });
    assert.deepEqual(sent, [{ type: 'pong', id: 'p' }]);
  });

  it('rejects a privileged op from an unauthenticated connection', async () => {
    const bridge = createBridge({ net: makeFakeNet(), runtimeManager: makeFakeRuntimeManager(), getProductState: () => ({}) });
    const sent = [];
    await bridge.dispatch({ send: (m) => sent.push(m) }, { type: 'list_projects', id: 'x' });
    assert.equal(sent[0].type, 'error');
    assert.equal(sent[0].code, 'auth_required');
  });

  it('device_register calls deps.registerDevice for an authenticated matching device', async () => {
    let registered = null;
    const bridge = createBridge({
      net: makeFakeNet(),
      runtimeManager: makeFakeRuntimeManager(),
      getProductState: () => ({}),
      registerDevice: (info) => { registered = info; return { ok: true }; },
      listDevices: () => [{ deviceId: 'd1', label: 'A' }],
    });
    const { ctx, sent } = authCtx('d1');
    await bridge.dispatch(ctx, { type: 'device_register', id: 'r', deviceId: 'd1', label: 'Pixel' });
    assert.equal(registered.deviceId, 'd1');
    assert.equal(registered.label, 'Pixel');
    assert.equal(sent[0].type, 'device_registered');
    assert.equal(sent[0].ok, true);
  });

  it('device_register rejects a deviceId that does not match the authenticated device', async () => {
    const bridge = createBridge({
      net: makeFakeNet(),
      runtimeManager: makeFakeRuntimeManager(),
      getProductState: () => ({}),
      registerDevice: () => ({ ok: true }),
    });
    const { ctx, sent } = authCtx('d1');
    await bridge.dispatch(ctx, { type: 'device_register', id: 'r', deviceId: 'd-other', label: 'X' });
    assert.equal(sent[0].type, 'error');
    assert.equal(sent[0].code, 'bad_request');
  });

  it('set_model posts ACP session/set_model', async () => {
    const net = makeFakeNet();
    const rm = makeFakeRuntimeManager();
    rm.setRuntime('p1', { projectId: 'p1', cwd: '/x', port: 2222, status: 'running' });
    let postedBody = null;
    net.setHandler('POST http://127.0.0.1:2222/api/v1/acp', async (opts) => {
      postedBody = opts.body;
      return { ok: true, status: 200, text: async () => '{"jsonrpc":"2.0","id":"op1","result":{}}' };
    });
    const bridge = createBridge({
      net,
      runtimeManager: rm,
      getProductState: () => ({
        projectsById: { p1: { workspacePath: '/x' } },
        threadsById: { t1: { projectId: 'p1', sessionId: 'sess-1' } },
      }),
    });
    const { ctx, sent } = authCtx();
    await bridge.dispatch(
      ctx,
      { type: 'set_model', id: 'op1', projectId: 'p1', threadId: 't1', modelId: 'hy3' },
    );
    const body = JSON.parse(postedBody);
    assert.equal(body.method, 'session/set_model');
    assert.equal(body.params.modelId, 'hy3');
    assert.equal(body.params.sessionId, 'sess-1');
    assert.equal(sent[0].type, 'setting_applied');
    assert.equal(sent[0].ok, true);
    assert.equal(sent[0].kind, 'set_model');
    assert.equal(sent[0].value, 'hy3');
  });

  it('permission_respond posts session/respond_permission', async () => {
    const net = makeFakeNet();
    const rm = makeFakeRuntimeManager();
    rm.setRuntime('p1', { projectId: 'p1', cwd: '/x', port: 3333, status: 'running' });
    let postedBody = null;
    net.setHandler('POST http://127.0.0.1:3333/api/v1/acp', async (opts) => {
      postedBody = opts.body;
      return { ok: true, status: 200, text: async () => '{"jsonrpc":"2.0","result":{}}' };
    });
    const bridge = createBridge({
      net,
      runtimeManager: rm,
      getProductState: () => ({ projectsById: { p1: { workspacePath: '/x' } }, threadsById: { t1: { projectId: 'p1', sessionId: 's1' } } }),
    });
    const { ctx, sent } = authCtx();
    await bridge.dispatch(
      ctx,
      { type: 'permission_respond', id: 'pr', projectId: 'p1', threadId: 't1', requestId: 'req1', decision: 'allow' },
    );
    const body = JSON.parse(postedBody);
    assert.equal(body.method, 'session/respond_permission');
    assert.equal(body.params.decision, 'allow');
    assert.equal(sent[0].type, 'permission_response_ack');
    assert.equal(sent[0].ok, true);
  });

  it('revoke_device calls deps.revokeDevice with the requesting device id', async () => {
    let revoked = null;
    let requester = null;
    const bridge = createBridge({
      net: makeFakeNet(),
      runtimeManager: makeFakeRuntimeManager(),
      getProductState: () => ({}),
      revokeDevice: (id, requestingId) => { revoked = id; requester = requestingId; return { ok: true, revoked: true }; },
    });
    const { ctx, sent } = authCtx('d1');
    await bridge.dispatch(ctx, { type: 'revoke_device', id: 'rv', deviceId: 'd2' });
    assert.equal(revoked, 'd2');
    assert.equal(requester, 'd1');
    assert.equal(sent[0].type, 'device_revoked');
    assert.equal(sent[0].revoked, true);
  });

  // C1: device_auth succeeds when the host verifies the signature and marks the
  // connection authenticated; subsequent privileged ops then succeed.
  it('device_auth marks the connection authenticated on a valid signature', async () => {
    let authed = null;
    const bridge = createBridge({
      net: makeFakeNet(),
      runtimeManager: makeFakeRuntimeManager(),
      getProductState: () => ({}),
      authenticateDevice: ({ deviceId, connectionId, signedChallenge, issuedAt }) => {
        authed = { deviceId, connectionId, signedChallenge, issuedAt };
        return { ok: true };
      },
    });
    const sent = [];
    const ctx = { send: (m) => sent.push(m), authenticated: false, deviceId: null, connectionId: 'c-auth' };
    await bridge.dispatch(ctx, {
      type: 'device_auth',
      id: 'da',
      deviceId: 'd1',
      signedChallenge: 'sig-b64',
      issuedAt: Date.now(),
    });
    assert.equal(authed.deviceId, 'd1');
    assert.equal(authed.signedChallenge, 'sig-b64');
    assert.equal(ctx.authenticated, true);
    assert.equal(ctx.deviceId, 'd1');
    assert.equal(sent[0].type, 'device_auth_ack');
    assert.equal(sent[0].ok, true);
  });

  it('device_auth fails when authenticateDevice rejects', async () => {
    const bridge = createBridge({
      net: makeFakeNet(),
      runtimeManager: makeFakeRuntimeManager(),
      getProductState: () => ({}),
      authenticateDevice: () => ({ ok: false, error: 'auth_failed' }),
    });
    const sent = [];
    const ctx = { send: (m) => sent.push(m), authenticated: false, connectionId: 'c-auth' };
    await bridge.dispatch(ctx, { type: 'device_auth', id: 'da', deviceId: 'd1', signedChallenge: 'sig', issuedAt: Date.now() });
    assert.equal(ctx.authenticated, false);
    assert.equal(sent[0].type, 'auth_required');
    assert.equal(sent[0].ok, false);
  });

  // C1: device_pair with an empty trust store succeeds without a pairing token;
  // with a non-empty trust store and no token it is rejected.
  it('device_pair succeeds on an empty trust store without a token', async () => {
    let paired = null;
    const bridge = createBridge({
      net: makeFakeNet(),
      runtimeManager: makeFakeRuntimeManager(),
      getProductState: () => ({}),
      pairDevice: (info) => { paired = info; return { ok: true, deviceId: 'dev_new' }; },
    });
    const sent = [];
    const ctx = { send: (m) => sent.push(m), authenticated: false, connectionId: 'c-pair' };
    await bridge.dispatch(ctx, {
      type: 'device_pair',
      id: 'dp',
      publicKeyB64: 'pub-b64',
      label: 'Phone',
      signedChallenge: 'sig',
      issuedAt: Date.now(),
    });
    assert.equal(paired.connectionId, 'c-pair');
    assert.equal(paired.publicKeyB64, 'pub-b64');
    assert.equal(ctx.authenticated, true);
    assert.equal(ctx.deviceId, 'dev_new');
    assert.equal(sent[0].type, 'device_paired');
    assert.equal(sent[0].ok, true);
  });

  // ---- R7/R8: prompt payload shape, stopReason completion, idle-window timeout ----

  /** Build a streaming SSE response whose reader yields one data frame per read. */
  function makeSseStreamResponse(frames, { chunkDelayMs = 0 } = {}) {
    let i = 0;
    return {
      ok: true,
      status: 200,
      text: async () => '',
      body: {
        getReader() {
          return {
            async read() {
              if (i >= frames.length) return { done: true, value: undefined };
              if (chunkDelayMs) await new Promise((r) => setTimeout(r, chunkDelayMs));
              const frame = frames[i++];
              const text = typeof frame === 'string' ? frame : `data: ${JSON.stringify(frame)}\n\n`;
              return { done: false, value: Buffer.from(text, 'utf8') };
            },
            cancel() {},
          };
        },
      },
    };
  }

  async function waitFor(predicate, timeoutMs = 5000) {
    const t0 = Date.now();
    while (!predicate()) {
      if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timeout');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  function promptProductState() {
    return {
      projectsById: { p1: { workspacePath: '/x' } },
      threadsById: { t1: { projectId: 'p1', sessionId: 'sess-1' } },
    };
  }

  it('prompt posts session/prompt with an ACP content-block array (not a bare string)', async () => {
    const net = makeFakeNet();
    const rm = makeFakeRuntimeManager();
    rm.setRuntime('p1', { projectId: 'p1', cwd: '/x', port: 4444, status: 'running' });
    let postedBody = null;
    net.setHandler('POST http://127.0.0.1:4444/api/v1/acp', async (opts) => {
      postedBody = JSON.parse(opts.body);
      return makeSseStreamResponse([
        { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk' } } },
        { jsonrpc: '2.0', id: postedBody.id, result: { stopReason: 'end_turn' } },
      ]);
    });
    const bridge = createBridge({ net, runtimeManager: rm, getProductState: promptProductState });
    const { ctx, sent } = authCtx();
    await bridge.dispatch(ctx, { type: 'prompt', id: 'pr1', projectId: 'p1', threadId: 't1', text: 'hello world' });
    await waitFor(() => sent.some((m) => m.type === 'prompt_done'));

    assert.equal(postedBody.method, 'session/prompt');
    assert.equal(postedBody.params.sessionId, 'sess-1');
    // ACP contract: prompt is an array of content blocks, same as the desktop renderer.
    assert.ok(Array.isArray(postedBody.params.prompt), 'prompt must be a content-block array');
    assert.deepEqual(postedBody.params.prompt, [{ type: 'text', text: 'hello world' }]);

    const done = sent.find((m) => m.type === 'prompt_done');
    assert.equal(done.stopReason, 'end_turn');
    assert.equal(done.error, null);
    // stream_event frames were forwarded before completion
    assert.ok(sent.some((m) => m.type === 'stream_event'));
  });

  it('prompt completes exactly once on the JSON-RPC response even without stopReason', async () => {
    const net = makeFakeNet();
    const rm = makeFakeRuntimeManager();
    rm.setRuntime('p1', { projectId: 'p1', cwd: '/x', port: 4445, status: 'running' });
    net.setHandler('POST http://127.0.0.1:4445/api/v1/acp', async (opts) => {
      const body = JSON.parse(opts.body);
      return makeSseStreamResponse([{ jsonrpc: '2.0', id: body.id, result: {} }]);
    });
    const bridge = createBridge({ net, runtimeManager: rm, getProductState: promptProductState });
    const { ctx, sent } = authCtx();
    await bridge.dispatch(ctx, { type: 'prompt', id: 'pr2', projectId: 'p1', threadId: 't1', text: 'hi' });
    await waitFor(() => sent.some((m) => m.type === 'prompt_done'));
    // give the .then() stream-end path a beat to (incorrectly) double-send
    await new Promise((r) => setTimeout(r, 50));
    const dones = sent.filter((m) => m.type === 'prompt_done');
    assert.equal(dones.length, 1);
    assert.equal(dones[0].error, null);
  });

  it('prompt still completes on legacy result.done frames', async () => {
    const net = makeFakeNet();
    const rm = makeFakeRuntimeManager();
    rm.setRuntime('p1', { projectId: 'p1', cwd: '/x', port: 4446, status: 'running' });
    net.setHandler('POST http://127.0.0.1:4446/api/v1/acp', async () =>
      makeSseStreamResponse([{ jsonrpc: '2.0', result: { done: true } }]));
    const bridge = createBridge({ net, runtimeManager: rm, getProductState: promptProductState });
    const { ctx, sent } = authCtx();
    await bridge.dispatch(ctx, { type: 'prompt', id: 'pr3', projectId: 'p1', threadId: 't1', text: 'hi' });
    await waitFor(() => sent.some((m) => m.type === 'prompt_done'));
    assert.equal(sent.find((m) => m.type === 'prompt_done').error, null);
  });

  // R8: a stream whose chunks each arrive within the idle window must survive
  // PAST the old wall-clock deadline (total duration > idle window).
  it('prompt stream survives long total duration when chunks keep arriving (idle window, not wall clock)', async () => {
    const net = makeFakeNet();
    const rm = makeFakeRuntimeManager();
    rm.setRuntime('p1', { projectId: 'p1', cwd: '/x', port: 4447, status: 'running' });
    net.setHandler('POST http://127.0.0.1:4447/api/v1/acp', async (opts) => {
      const body = JSON.parse(opts.body);
      // 6 chunks x 60ms = 360ms total, far beyond the 150ms idle window a
      // wall-clock deadline would enforce.
      const frames = [];
      for (let n = 0; n < 5; n += 1) {
        frames.push({ jsonrpc: '2.0', method: 'session/update', params: { n } });
      }
      frames.push({ jsonrpc: '2.0', id: body.id, result: { stopReason: 'end_turn' } });
      return makeSseStreamResponse(frames, { chunkDelayMs: 60 });
    });
    const bridge = createBridge({
      net,
      runtimeManager: rm,
      getProductState: promptProductState,
      promptIdleTimeoutMs: 150,
    });
    const { ctx, sent } = authCtx();
    await bridge.dispatch(ctx, { type: 'prompt', id: 'pr4', projectId: 'p1', threadId: 't1', text: 'long tool run' });
    await waitFor(() => sent.some((m) => m.type === 'prompt_done'), 5000);
    const done = sent.find((m) => m.type === 'prompt_done');
    assert.equal(done.error, null, `expected no error, got ${JSON.stringify(done.error)}`);
    assert.equal(done.stopReason, 'end_turn');
  });

  // R8: a stream that goes silent past the idle window is aborted with an error.
  it('prompt stream aborts with an error when idle past the window', async () => {
    const net = makeFakeNet();
    const rm = makeFakeRuntimeManager();
    rm.setRuntime('p1', { projectId: 'p1', cwd: '/x', port: 4448, status: 'running' });
    net.setHandler('POST http://127.0.0.1:4448/api/v1/acp', async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      body: {
        getReader() {
          let first = true;
          return {
            async read() {
              if (first) {
                first = false;
                return { done: false, value: Buffer.from('data: {"jsonrpc":"2.0","method":"session/update"}\n\n', 'utf8') };
              }
              // stall far past the idle window
              await new Promise((r) => setTimeout(r, 1500));
              return { done: true, value: undefined };
            },
            cancel() {},
          };
        },
      },
    }));
    const bridge = createBridge({
      net,
      runtimeManager: rm,
      getProductState: promptProductState,
      promptIdleTimeoutMs: 100,
    });
    const { ctx, sent } = authCtx();
    await bridge.dispatch(ctx, { type: 'prompt', id: 'pr5', projectId: 'p1', threadId: 't1', text: 'stalls' });
    await waitFor(() => sent.some((m) => m.type === 'prompt_done'), 5000);
    const done = sent.find((m) => m.type === 'prompt_done');
    assert.ok(done.error, 'idle stream must surface an error');
    assert.match(String(done.error.body || done.error.message || ''), /idle|deadline|HTTP 0/i);
  });

  it('device_pair surfaces the host rejection (e.g. missing token) as auth_required', async () => {
    const bridge = createBridge({
      net: makeFakeNet(),
      runtimeManager: makeFakeRuntimeManager(),
      getProductState: () => ({}),
      pairDevice: () => ({ ok: false, error: 'invalid or expired pairing token' }),
    });
    const sent = [];
    const ctx = { send: (m) => sent.push(m), authenticated: false, connectionId: 'c-pair' };
    await bridge.dispatch(ctx, {
      type: 'device_pair',
      id: 'dp',
      publicKeyB64: 'pub-b64',
      signedChallenge: 'sig',
      issuedAt: Date.now(),
    });
    assert.equal(ctx.authenticated, false);
    assert.equal(sent[0].type, 'auth_required');
    assert.equal(sent[0].error, 'invalid or expired pairing token');
  });
});