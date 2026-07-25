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
    const sent = [];
    await bridge.dispatch({ send: (m) => sent.push(m) }, { type: 'list_projects', id: 'a' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'projects');
    assert.equal(sent[0].projects[0].projectId, 'p1');
    assert.equal(sent[0].projects[0].name, 'Proj');
  });

  it('ping returns pong', async () => {
    const bridge = createBridge({ net: makeFakeNet(), runtimeManager: makeFakeRuntimeManager(), getProductState: () => ({}) });
    const sent = [];
    await bridge.dispatch({ send: (m) => sent.push(m) }, { type: 'ping', id: 'p' });
    assert.deepEqual(sent, [{ type: 'pong', id: 'p' }]);
  });

  it('device_register calls deps.registerDevice', async () => {
    let registered = null;
    const bridge = createBridge({
      net: makeFakeNet(),
      runtimeManager: makeFakeRuntimeManager(),
      getProductState: () => ({}),
      registerDevice: (info) => { registered = info; return { ok: true }; },
      listDevices: () => [{ deviceId: 'd1', label: 'A' }],
    });
    const sent = [];
    await bridge.dispatch({ send: (m) => sent.push(m) }, { type: 'device_register', id: 'r', deviceId: 'd1', label: 'Pixel' });
    assert.equal(registered.deviceId, 'd1');
    assert.equal(registered.label, 'Pixel');
    assert.equal(sent[0].type, 'device_registered');
    assert.equal(sent[0].ok, true);
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
    const sent = [];
    await bridge.dispatch(
      { send: (m) => sent.push(m) },
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
    const sent = [];
    await bridge.dispatch(
      { send: (m) => sent.push(m) },
      { type: 'permission_respond', id: 'pr', projectId: 'p1', threadId: 't1', requestId: 'req1', decision: 'allow' },
    );
    const body = JSON.parse(postedBody);
    assert.equal(body.method, 'session/respond_permission');
    assert.equal(body.params.decision, 'allow');
    assert.equal(sent[0].type, 'permission_response_ack');
    assert.equal(sent[0].ok, true);
  });

  it('revoke_device calls deps.revokeDevice', async () => {
    let revoked = null;
    const bridge = createBridge({
      net: makeFakeNet(),
      runtimeManager: makeFakeRuntimeManager(),
      getProductState: () => ({}),
      revokeDevice: (id) => { revoked = id; return { ok: true, revoked: true }; },
    });
    const sent = [];
    await bridge.dispatch({ send: (m) => sent.push(m) }, { type: 'revoke_device', id: 'rv', deviceId: 'd2' });
    assert.equal(revoked, 'd2');
    assert.equal(sent[0].type, 'device_revoked');
    assert.equal(sent[0].revoked, true);
  });
});