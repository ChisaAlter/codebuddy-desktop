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