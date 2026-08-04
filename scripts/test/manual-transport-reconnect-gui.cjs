#!/usr/bin/env node
'use strict';

/**
 * Real-window acceptance for transport auto-reconnect (v2).
 *
 * Launches the real Electron desktop via the existing e2e driver, then exercises
 * the live AcpClient / store code paths through CDP evaluate.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  cleanupOwned,
  cleanupRuntimeDir,
  connectCdp,
  createRuntimeLayout,
  findRendererTarget,
  launchDesktop,
  seedProductState,
  waitForRendererValue,
} = require('./e2e-driver.cjs');

const projectRoot = path.resolve(__dirname, '..', '..');
const electronExe = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const screenshotDir = path.join(projectRoot, 'gui-test-screenshots');
const runStamp = `transport-reconnect-${Date.now()}`;
const runtimeOwnership = createRuntimeLayout({
  projectRoot,
  runStamp,
  label: 'transport-reconnect',
});
const { runtimeRoot, runtimeDir, userDataDir } = runtimeOwnership;

const results = [];

function check(name, ok, detail = '') {
  const result = { name, ok: Boolean(ok), detail: String(detail || '') };
  results.push(result);
  console.log(`${result.ok ? 'PASS' : 'FAIL'} ${name}${result.detail ? ` — ${result.detail}` : ''}`);
  return result.ok;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function capture(client, name) {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const file = path.join(screenshotDir, `${name}.png`);
  try {
    // e2e-driver CDP client exposes send() for protocol methods.
    const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`SHOT ${file}`);
    return file;
  } catch (error) {
    console.warn(`capture failed ${name}:`, error?.message || error);
    return null;
  }
}

async function main() {
  let launched = null;
  let client = null;
  let exitCode = 1;

  try {
    if (!fs.existsSync(electronExe)) {
      throw new Error(`electron binary missing: ${electronExe}`);
    }

    seedProductState({
      userDataDir,
      projectRoot,
      label: 'transport-reconnect',
    });

    // Skip Windows Job supervisor path (same workaround as manual-goal-gui.cjs).
    const plainSpawn = (...args) => spawn(...args);
    launched = await launchDesktop({
      executable: electronExe,
      appArgs: ['.'],
      projectRoot,
      userDataDir,
      runtimeRoot,
      runtimeDir,
      runtimeOwnership,
      spawnImpl: plainSpawn,
      env: {
        CODEBUDDY_E2E: '1',
        ELECTRON_ENABLE_LOGGING: '1',
      },
    });
    console.log(`launched pid=${launched.rootPid || launched.pid} cdp=${launched.debugPort}`);
    launched.process?.stdout?.on('data', (chunk) => console.log(`[electron] ${String(chunk).trim()}`));
    launched.process?.stderr?.on('data', (chunk) => console.log(`[electron:err] ${String(chunk).trim()}`));

    const target = await findRendererTarget({
      port: launched.debugPort,
      expectedUrl: (url) =>
        /localhost:5173|127\.0\.0\.1:\d+\/index\.html|file:\/\/|codebuddy/i.test(String(url || '')),
      timeoutMs: 90000,
    });
    console.log(`renderer target: ${target.url}`);
    client = await connectCdp(target, { commandTimeoutMs: 60000, connectTimeoutMs: 30000 });

    await client.evaluate(`if (location.hash !== '#/chat') location.hash = '#/chat'`);
    await wait(2500);
    await capture(client, `${runStamp}-01-boot`);

    await waitForRendererValue(
      client,
      `Boolean(window.__CODEBUDDY_STORE__?.getState)`,
      { timeoutMs: 60000, describe: 'store ready' },
    );

    // Import helper used by all cases.
    const importHelper = `
      async function loadAcp() {
        const candidates = ['/src/lib/acp.js'];
        // production build may not expose /src; try dynamic absolute file path is blocked by browser.
        // In packaged/prod static server, modules are bundled; fall back to store-only cases.
        for (const url of candidates) {
          try {
            const mod = await import(url);
            if (mod?.AcpClient) return mod;
          } catch (_) {}
        }
        return null;
      }
    `;

    // ---- 1) Finite reconnect budget ----
    const finite = await client.evaluate(`(async () => {
      ${importHelper}
      const mod = await loadAcp();
      if (!mod?.AcpClient) return { ok: false, reason: 'AcpClient-not-importable-in-renderer' };
      const client = new mod.AcpClient({ apiBase: 'http://127.0.0.1:63918' });
      client.autoReconnectEnabled = true;
      client.maxReconnectAttempts = 3;
      client.reconnectDelay = 50;
      client._lastSessionId = 'sess-acceptance';
      client._lastCwd = 'C:/acceptance';
      let connectCalls = 0;
      client.requestHttp = async () => {
        connectCalls += 1;
        throw new Error('connect refused');
      };
      const failed = [];
      client.on('reconnect_failed', (event) => failed.push(event.detail));
      client.markConnectionBroken('acceptance-finite');
      await new Promise((r) => setTimeout(r, 1500));
      return {
        ok: true,
        reconnecting: client.reconnecting,
        timer: client._reconnectTimer,
        failedCount: failed.length,
        attempts: failed[0]?.attempts ?? null,
        connectCalls,
        max: client.maxReconnectAttempts,
      };
    })()`);

    check(
      '1. 守护进程持续不可达时有限次重连后进入 reconnect_failed',
      finite?.ok &&
        finite.failedCount === 1 &&
        finite.reconnecting === false &&
        finite.timer == null &&
        Number(finite.attempts) >= Number(finite.max),
      JSON.stringify(finite),
    );

    // ---- 2) restoreConnection success ----
    const restore = await client.evaluate(`(async () => {
      ${importHelper}
      const mod = await loadAcp();
      if (!mod?.AcpClient) return { ok: false, reason: 'AcpClient-not-importable-in-renderer' };
      const ac = new mod.AcpClient({ apiBase: 'http://127.0.0.1:63918' });
      const methods = [];
      ac.requestHttp = async (path, init = {}) => {
        if (path === '/api/v1/acp/connect') {
          methods.push('connect');
          return { ok: true, status: 200, json: async () => ({ connectionId: 'conn-ok', sessionToken: 'tok' }) };
        }
        const body = JSON.parse(init.body || '{}');
        methods.push(body.method || path);
        if (body.method === 'initialize') {
          return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }) };
        }
        if (body.method === 'session/load') {
          return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { sessionId: 'sess-ok' } }) };
        }
        throw new Error('unexpected ' + (body.method || path));
      };
      const restoredEvents = [];
      ac.on('session_restored', (e) => restoredEvents.push(e.detail));
      await ac.restoreConnection({ sessionId: 'sess-ok', cwd: 'C:/acceptance' });
      return {
        ok: true,
        connected: ac.connected,
        initialized: ac.initialized,
        sessionBound: ac.sessionBound,
        methods,
        restoredEvents,
      };
    })()`);

    check(
      '2. restoreConnection 成功执行 connect+initialize+session/load 并绑定会话',
      restore?.ok &&
        restore.connected &&
        restore.initialized &&
        restore.sessionBound &&
        Array.isArray(restore.methods) &&
        restore.methods.includes('connect') &&
        restore.methods.includes('initialize') &&
        restore.methods.includes('session/load') &&
        restore.restoredEvents?.length === 1,
      JSON.stringify(restore),
    );

    // ---- 3) 401 no reconnect ----
    // Use non-streaming request() + requestHttp mock (avoids frozen contextBridge electronAPI).
    const auth401 = await client.evaluate(`(async () => {
      ${importHelper}
      const mod = await loadAcp();
      if (!mod?.AcpClient) return { ok: false, reason: 'AcpClient-not-importable-in-renderer' };
      const ac = new mod.AcpClient({ apiBase: 'http://127.0.0.1:63918' });
      ac.connected = true;
      ac.connectionId = 'conn-1';
      ac.sessionToken = 'tok';
      ac.initialized = true;
      ac.requestHttp = async () => ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => '',
      });
      const reconnecting = [];
      ac.on('reconnecting', (e) => reconnecting.push(e.detail));
      const authEvents = [];
      const onAuth = () => authEvents.push(1);
      window.addEventListener('codebuddy:auth-required', onAuth);
      let err = null;
      try {
        // session/set_model is a short non-streaming method.
        await ac.request('session/set_model', { sessionId: 's1', modelId: 'x' });
      } catch (e) {
        err = {
          message: e.message,
          transportFailure: e.transportFailure,
          failureClass: e.failureClass,
          status: e.status,
        };
      }
      window.removeEventListener('codebuddy:auth-required', onAuth);
      return {
        ok: true,
        connected: ac.connected,
        reconnecting: ac.reconnecting,
        reconnectingCount: reconnecting.length,
        authEvents: authEvents.length,
        err,
      };
    })()`);

    check(
      '3. HTTP 401 触发登录事件且不拆连接/不重连',
      auth401?.ok &&
        auth401.connected === true &&
        auth401.reconnectingCount === 0 &&
        auth401.authEvents >= 1 &&
        auth401.err?.failureClass === 'auth' &&
        auth401.err?.transportFailure === false,
      JSON.stringify(auth401),
    );

    // ---- 4) idle classification ----
    const idle = await client.evaluate(`(async () => {
      ${importHelper}
      const mod = await loadAcp();
      if (!mod?.classifyTransportFailure) return { ok: false, reason: 'classifier-missing' };
      return {
        ok: true,
        idleClass: mod.classifyTransportFailure({ status: null, kind: null, isLongRunningIdleTimeout: true }),
        hardClass: mod.classifyTransportFailure({ status: null, kind: 'timeout' }),
        upstreamClass: mod.classifyTransportFailure({ status: 502, kind: 'http' }),
        rateClass: mod.classifyTransportFailure({ status: 429, kind: 'http' }),
      };
    })()`);

    check(
      '4. idle/5xx/429 分类正确（idle 不拆；5xx=upstream；429=rate_limit）',
      idle?.ok &&
        idle.idleClass === 'idle' &&
        idle.hardClass === 'transport' &&
        idle.upstreamClass === 'upstream' &&
        idle.rateClass === 'rate_limit',
      JSON.stringify(idle),
    );

    // ---- 5) kill switch ----
    const killSwitch = await client.evaluate(`(async () => {
      ${importHelper}
      const mod = await loadAcp();
      if (!mod?.AcpClient) return { ok: false, reason: 'AcpClient-not-importable-in-renderer' };
      const ac = new mod.AcpClient({ apiBase: 'http://127.0.0.1:63918' });
      ac.setAutoReconnectEnabled(false);
      ac.connected = true;
      const reconnecting = [];
      ac.on('reconnecting', (e) => reconnecting.push(e.detail));
      ac.markConnectionBroken('kill-switch');
      await new Promise((r) => setTimeout(r, 300));
      return {
        ok: true,
        connected: ac.connected,
        reconnecting: ac.reconnecting,
        timer: ac._reconnectTimer,
        reconnectingEvents: reconnecting.length,
        enabled: ac.autoReconnectEnabled,
      };
    })()`);

    check(
      '5. kill switch 关闭后只断连、不调度自动重连',
      killSwitch?.ok &&
        killSwitch.connected === false &&
        killSwitch.reconnecting === false &&
        killSwitch.timer == null &&
        killSwitch.reconnectingEvents === 0 &&
        killSwitch.enabled === false,
      JSON.stringify(killSwitch),
    );

    // ---- 6) no automatic second session/prompt ----
    const noResend = await client.evaluate(`(async () => {
      const store = window.__CODEBUDDY_STORE__;
      if (!store?.getState) return { ok: false, reason: 'no-store' };
      const calls = [];
      const request = async (method) => {
        calls.push(method);
        if (method === 'session/prompt') {
          const err = new Error('ipc stream died');
          err.transportFailure = true;
          throw err;
        }
        if (method === 'session/load') throw new Error('history unavailable');
        return {};
      };
      const threadId = store.getState().activeThreadId || 'thread-acceptance';
      const projectId = store.getState().activeProjectId || 'project-acceptance';
      store.setState((state) => ({
        activeProjectId: projectId,
        activeThreadId: threadId,
        projectsById: {
          ...(state.projectsById || {}),
          [projectId]: {
            id: projectId,
            workspacePath: 'C:/acceptance',
            ...(state.projectsById?.[projectId] || {}),
          },
        },
        threadsById: {
          ...(state.threadsById || {}),
          [threadId]: {
            id: threadId,
            projectId,
            sessionId: 'session-acceptance',
            title: '验收会话',
            draft: '',
            timeline: [],
            status: 'idle',
            metadata: {},
            ...(state.threadsById?.[threadId] || {}),
          },
        },
        threadRuntimeById: {
          ...(state.threadRuntimeById || {}),
          [threadId]: {
            connectionState: 'connected',
            sessionId: 'session-acceptance',
            timeline: [],
            promptQueue: [],
            isAwaitingResponse: false,
            activePromptRunId: null,
            promptDispatched: false,
            promptDispatchInFlight: false,
            sessionRestoreNeeded: false,
            ...(state.threadRuntimeById?.[threadId] || {}),
          },
        },
        getThreadClient: () => ({
          connected: true,
          initialized: true,
          request,
          reconnect: async () => true,
          markSessionBound: () => true,
          cancelActivePrompt: () => false,
          hasActivePrompt: () => false,
        }),
        updateThreadRecord: async (id, patch) => {
          store.setState((s) => ({
            threadsById: {
              ...s.threadsById,
              [id]: { ...s.threadsById[id], ...patch },
            },
          }));
          return true;
        },
        persistProductState: async () => true,
        notifyThreadResult: () => {},
      }));
      const result = await store.getState().runThreadPrompt(threadId, 'acceptance no resend');
      return {
        ok: true,
        result,
        promptCalls: calls.filter((m) => m === 'session/prompt').length,
        loadCalls: calls.filter((m) => m === 'session/load').length,
        calls,
        status: store.getState().threadsById[threadId]?.status,
      };
    })()`);

    check(
      '6. 传输失败后不自动二次 session/prompt（仅一次）',
      noResend?.ok && noResend.promptCalls === 1 && noResend.result === false,
      JSON.stringify(noResend),
    );

    // ---- 7) delayed rebind after terminal ----
    const rebind = await client.evaluate(`(async () => {
      const store = window.__CODEBUDDY_STORE__;
      if (!store?.getState?.().rebindSessionAfterTurn) {
        return { ok: false, reason: 'rebindSessionAfterTurn-missing' };
      }
      const calls = [];
      const markSessionBound = (sessionId) => {
        calls.push(['markSessionBound', sessionId]);
        return true;
      };
      const request = async (method, params) => {
        calls.push([method, params?.sessionId || null]);
        if (method === 'session/load') return { sessionId: params.sessionId };
        return {};
      };
      const threadId = store.getState().activeThreadId || 'thread-acceptance';
      const projectId = store.getState().activeProjectId || 'project-acceptance';
      store.setState((state) => ({
        activeProjectId: projectId,
        activeThreadId: threadId,
        projectsById: {
          ...(state.projectsById || {}),
          [projectId]: { id: projectId, workspacePath: 'C:/acceptance', ...(state.projectsById?.[projectId] || {}) },
        },
        threadsById: {
          ...(state.threadsById || {}),
          [threadId]: {
            id: threadId,
            projectId,
            sessionId: 'session-acceptance',
            status: 'idle',
            metadata: {},
            ...(state.threadsById?.[threadId] || {}),
          },
        },
        threadRuntimeById: {
          ...(state.threadRuntimeById || {}),
          [threadId]: {
            ...(state.threadRuntimeById?.[threadId] || {}),
            connectionState: 'connected',
            sessionId: 'session-acceptance',
            sessionRestoreNeeded: true,
            activePromptRunId: null,
            timeline: [],
          },
        },
        getThreadClient: () => ({
          connected: true,
          initialized: true,
          request,
          markSessionBound,
          cancelActivePrompt: () => false,
          hasActivePrompt: () => false,
        }),
      }));
      const ok = await store.getState().rebindSessionAfterTurn(threadId);
      return { ok: true, rebindOk: ok, calls };
    })()`);

    check(
      '7. turn 终态 delayed rebind 会执行 session/load + markSessionBound',
      rebind?.ok &&
        rebind.rebindOk === true &&
        Array.isArray(rebind.calls) &&
        rebind.calls.some((c) => c[0] === 'session/load') &&
        rebind.calls.some((c) => c[0] === 'markSessionBound'),
      JSON.stringify(rebind),
    );

    // ---- 8) session-invalid restore → reconnected(sessionInvalid) ----
    const sessionInvalid = await client.evaluate(`(async () => {
      ${importHelper}
      const mod = await loadAcp();
      if (!mod?.AcpClient) return { ok: false, reason: 'AcpClient-not-importable-in-renderer' };
      const ac = new mod.AcpClient({ apiBase: 'http://127.0.0.1:63918' });
      ac._lastSessionId = 'sess-gone';
      ac.requestHttp = async (path, init = {}) => {
        if (path === '/api/v1/acp/connect') {
          return { ok: true, status: 200, json: async () => ({ connectionId: 'conn-sinv', sessionToken: 'tok' }) };
        }
        const body = JSON.parse(init.body || '{}');
        if (body.method === 'initialize') {
          return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }) };
        }
        if (body.method === 'session/load') {
          const err = new Error('session not found');
          err.status = 404;
          throw err;
        }
        throw new Error('unexpected ' + (body.method || path));
      };
      const reconnected = [];
      ac.on('reconnected', (e) => reconnected.push(e.detail));
      const invalid = [];
      ac.on('session_invalid', (e) => invalid.push(e.detail));
      ac.markConnectionBroken('acceptance-sinv');
      await new Promise((r) => setTimeout(r, 1500));
      return {
        ok: true,
        reconnected,
        invalid,
        reconnecting: ac.reconnecting,
      };
    })()`);
    check(
      '8. 会话失效时 restore 发出 session_invalid 且 reconnected 携带 sessionInvalid 标记',
      sessionInvalid?.ok &&
        sessionInvalid.invalid?.length === 1 &&
        sessionInvalid.reconnected?.length === 1 &&
        sessionInvalid.reconnected[0]?.sessionInvalid === true &&
        sessionInvalid.reconnected[0]?.sessionBound === false &&
        sessionInvalid.reconnecting === false,
      JSON.stringify(sessionInvalid),
    );

    // ---- settings default ----
    const settings = await client.evaluate(`(() => {
      const store = window.__CODEBUDDY_STORE__;
      const value = store?.getState?.()?.guiSettings?.transportAutoReconnect;
      return { ok: true, transportAutoReconnect: value };
    })()`);
    check(
      '附. guiSettings.transportAutoReconnect 默认为 true',
      settings?.ok && settings.transportAutoReconnect !== false,
      JSON.stringify(settings),
    );

    await capture(client, `${runStamp}-02-done`);

    const failed = results.filter((item) => !item.ok);
    exitCode = failed.length ? 1 : 0;
    console.log('');
    console.log(`SUMMARY ${results.length - failed.length}/${results.length} passed`);
    if (failed.length) {
      console.log('FAILED:');
      for (const item of failed) console.log(`- ${item.name}: ${item.detail}`);
    }

    fs.mkdirSync(screenshotDir, { recursive: true });
    fs.writeFileSync(
      path.join(screenshotDir, `${runStamp}-report.json`),
      JSON.stringify({ runStamp, results, exitCode }, null, 2),
    );
  } catch (error) {
    console.error('ACCEPTANCE ERROR:', error?.stack || error);
    exitCode = 1;
  } finally {
    try {
      if (client) await client.close?.();
    } catch (_) {}
    try {
      if (launched?.process && !launched.process.killed) launched.process.kill();
    } catch (_) {}
    try {
      cleanupOwned(runtimeOwnership);
    } catch (_) {}
    try {
      cleanupRuntimeDir(runtimeDir);
    } catch (_) {}
    process.exit(exitCode);
  }
}

main();
