'use strict';

/**
 * Mobile-remote bridge: decrypts op JSON and maps to local CodeBuddy runtime / CLI.
 * Reuses the same patterns as the renderer IPC: runtimeManager.ensure + net.fetch to
 * 127.0.0.1:{port}. Never exposes arbitrary URLs.
 */

const DEFAULT_TIMEOUT_MS = 30000;
const PROMPT_TIMEOUT_MS = 120000;

/**
 * @param {object} deps
 * @param {import('electron').Net} deps.net
 * @param {{ ensure: (id: string, cwd: string, opts?: object) => Promise<{projectId,cwd,status,port,password,pid}>,
 *           list: () => Array<{projectId,cwd,status,port,pid}>,
 *           stop: (id: string) => Promise<any> }} deps.runtimeManager
 * @param {() => any} deps.getProductState
 * @param {(...a: unknown[]) => void} [deps.log]
 */
function createBridge(deps) {
  const log = deps.log || (() => {});
  const { net, runtimeManager, getProductState } = deps;

  /**
   * @param {string} projectId
   * @returns {{ cwd: string } | null}
   */
  function getProjectCwd(projectId) {
    const state = getProductState() || {};
    const p = state.projectsById?.[projectId];
    return p && typeof p.workspacePath === 'string' ? { cwd: p.workspacePath } : null;
  }

  /**
   * @param {string} projectId
   */
  async function ensureRuntime(projectId) {
    const info = getProjectCwd(projectId);
    if (!info) throw new Error('project not found');
    const runtime = await runtimeManager.ensure(projectId, info.cwd);
    if (!runtime || !runtime.port) throw new Error('runtime unavailable');
    return runtime;
  }

  /**
   * Local REST request to a project's serve port.
   * @param {{ port: number, password?: string }} runtime
   * @param {string} pathname starts with /
   * @param {{ method?: string, body?: string, headers?: object, timeoutMs?: number, signal?: AbortSignal }} [init]
   */
  async function cliRequest(runtime, pathname, init = {}) {
    const base = `http://127.0.0.1:${runtime.port}`;
    const url = pathname.startsWith('http') ? pathname : `${base}${pathname}`;
    const headers = { 'X-CodeBuddy-Request': '1', ...(init.headers || {}) };
    if (runtime.password) headers.Authorization = `Bearer ${runtime.password}`;
    const controller = new AbortController();
    const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (init.signal) {
      init.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    try {
      const response = await net.fetch(url, {
        method: init.method || 'GET',
        headers,
        body: init.body,
        signal: controller.signal,
      });
      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        body: text,
        json: () => (text ? JSON.parse(text) : null),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Stream SSE lines from a project's serve endpoint.
   * @param {{ port: number, password?: string }} runtime
   * @param {string} pathname
   * @param {{ method?: string, body?: string, headers?: object, timeoutMs?: number, onMessage: (msg: object) => void, signal?: AbortSignal }} init
   */
  async function cliStream(runtime, pathname, init) {
    const base = `http://127.0.0.1:${runtime.port}`;
    const url = pathname.startsWith('http') ? pathname : `${base}${pathname}`;
    const headers = {
      'X-CodeBuddy-Request': '1',
      Accept: 'text/event-stream',
      ...(init.headers || {}),
    };
    if (runtime.password) headers.Authorization = `Bearer ${runtime.password}`;
    const controller = new AbortController();
    const timeoutMs = init.timeoutMs ?? PROMPT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (init.signal) {
      init.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    try {
      const response = await net.fetch(url, {
        method: init.method || 'GET',
        headers,
        body: init.body,
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return { ok: false, status: response.status, body: text };
      }
      const reader = response.body?.getReader?.();
      if (!reader) {
        const text = await response.text();
        for (const m of parseSse(text)) init.onMessage(m);
        return { ok: true, status: response.status };
      }
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const msg = parseSseBlock(block);
          if (msg) init.onMessage(msg);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        const msg = parseSseBlock(buffer);
        if (msg) init.onMessage(msg);
      }
      return { ok: true, status: response.status };
    } finally {
      clearTimeout(timer);
    }
  }

  function parseSseBlock(block) {
    const lines = block.split('\n');
    const dataLines = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    if (!dataLines.length) return null;
    const payload = dataLines.join('\n');
    try { return JSON.parse(payload); } catch { return { raw: payload }; }
  }
  function parseSse(text) {
    const out = [];
    for (const block of text.split('\n\n')) {
      const m = parseSseBlock(block);
      if (m) out.push(m);
    }
    return out;
  }

  /** @type {Map<string, AbortController>} runId -> abort */
  const activePrompts = new Map();

  /**
   * Dispatch an op. Returns optional sync response; streams push via sender.
   * @param {object} ctx
   * @param {(message: object) => void} ctx.send
   * @param {object} op parsed JSON
   */
  async function dispatch(ctx, op) {
    if (!op || typeof op !== 'object') {
      return sendError(ctx, op, 'bad_request', 'op must be an object');
    }
    const type = op.type;
    const id = op.id || null;
    log('op', type, id);

    // C1: ops other than the handshake trio (ping, device_auth, device_pair)
    // require an authenticated connection. A connection is authenticated once its
    // device_auth or device_pair op succeeds. This blocks anyone who merely has
    // the (public) QR/relayAuth info from issuing prompts, approving permissions,
    // or revoking devices.
    const AUTH_EXEMPT = new Set(['ping', 'device_auth', 'device_pair']);
    if (!AUTH_EXEMPT.has(type) && !ctx.authenticated) {
      return sendError(ctx, op, 'auth_required', 'device authentication required');
    }

    try {
      switch (type) {
        case 'ping':
          ctx.send({ type: 'pong', id });
          return;

        case 'device_auth': {
          // C1: verify a per-connection device-auth signature against the trust store.
          const deviceId = String(op.deviceId || '').trim();
          const signedChallenge = String(op.signedChallenge || '').trim();
          const issuedAt = Number(op.issuedAt);
          if (!deviceId || !signedChallenge) {
            return sendError(ctx, op, 'bad_request', 'deviceId and signedChallenge required');
          }
          if (!deps.authenticateDevice) {
            return sendError(ctx, op, 'auth_required', 'device authentication not configured');
          }
          const result = deps.authenticateDevice({ deviceId, connectionId: ctx.connectionId, signedChallenge, issuedAt });
          if (result?.ok) {
            // Mark this connection authenticated for subsequent ops.
            ctx.authenticated = true;
            ctx.deviceId = deviceId;
            ctx.send({ type: 'device_auth_ack', id, deviceId, ok: true });
          } else {
            ctx.send({ type: 'auth_required', id, ok: false, error: result?.error || 'auth_failed' });
          }
          return;
        }

        case 'device_pair': {
          // C1: pair a new device (first device pairs free; later devices need a
          // pairing token embedded in the offer). The device presents its Ed25519
          // public key + a signed challenge proving key possession. The host-side
          // pairDevice verifies the signature, derives deviceId, and stores the
          // public key.
          const publicKeyB64 = String(op.publicKeyB64 || '').trim();
          const label = String(op.label || '').trim().slice(0, 64);
          const signedChallenge = String(op.signedChallenge || '').trim();
          const issuedAt = Number(op.issuedAt);
          const pairingToken = op.pairingToken ? String(op.pairingToken).trim() : null;
          if (!publicKeyB64 || !signedChallenge) {
            return sendError(ctx, op, 'bad_request', 'publicKeyB64 and signedChallenge required');
          }
          if (!deps.pairDevice) {
            return sendError(ctx, op, 'auth_required', 'device pairing not configured');
          }
          const result = deps.pairDevice({
            publicKeyB64,
            label,
            connectionId: ctx.connectionId,
            pairingToken,
            signedChallenge,
            issuedAt,
          });
          if (result?.ok) {
            ctx.authenticated = true;
            ctx.deviceId = result.deviceId;
            ctx.send({ type: 'device_paired', id, deviceId: result.deviceId, ok: true });
          } else {
            ctx.send({ type: 'auth_required', id, ok: false, error: result?.error || 'pair_failed' });
          }
          return;
        }

        case 'device_register': {
          // C1: device_register now only updates the label of an already-paired
          // device. First-time identity is established via device_pair. The
          // connection must be authenticated, and the deviceId must match the
          // connection's authenticated deviceId (derived from its keypair).
          const deviceId = String(op.deviceId || '').trim();
          const label = String(op.label || '').trim().slice(0, 64);
          if (!deviceId) return sendError(ctx, op, 'bad_request', 'deviceId required');
          if (ctx.deviceId && ctx.deviceId !== deviceId) {
            return sendError(ctx, op, 'bad_request', 'deviceId must match the authenticated device');
          }
          if (deps.registerDevice) {
            const result = deps.registerDevice({ deviceId, label, connectionId: ctx.connectionId });
            ctx.send({ type: 'device_registered', id, deviceId, label, ok: !result?.error, error: result?.error });
          } else {
            ctx.send({ type: 'device_registered', id, deviceId, label, ok: true });
          }
          return;
        }

        case 'list_devices': {
          const devices = deps.listDevices ? deps.listDevices() : [];
          ctx.send({ type: 'devices', id, devices });
          return;
        }

        case 'revoke_device': {
          const deviceId = String(op.deviceId || '').trim();
          if (!deviceId) return sendError(ctx, op, 'bad_request', 'deviceId required');
          // C2: pass the requesting (authenticated) device's id so the host can
          // enforce "a device may only revoke itself, or the first (admin) device".
          const result = deps.revokeDevice
            ? deps.revokeDevice(deviceId, ctx.deviceId || null)
            : { ok: true };
          ctx.send({
            type: 'device_revoked',
            id,
            deviceId,
            ok: !result?.error,
            revoked: Boolean(result?.revoked),
            error: result?.error,
          });
          return;
        }

        case 'list_projects': {
          const state = getProductState() || {};
          const runtimes = runtimeManager.list();
          const rtByProject = new Map(runtimes.map((r) => [r.projectId, r]));
          const projects = (state.projectOrder || Object.keys(state.projectsById || {}))
            .map((projectId) => {
              const p = state.projectsById?.[projectId];
              if (!p) return null;
              const rt = rtByProject.get(projectId);
              return {
                projectId,
                name: p.name || projectId,
                cwd: p.workspacePath || '',
                runtimeStatus: rt?.status || 'idle',
                port: rt?.port || null,
              };
            })
            .filter(Boolean);
          ctx.send({ type: 'projects', id, projects });
          return;
        }

        case 'ensure_runtime': {
          const projectId = String(op.projectId || '');
          if (!projectId) return sendError(ctx, op, 'bad_request', 'projectId required');
          const runtime = await ensureRuntime(projectId);
          ctx.send({
            type: 'runtime',
            id,
            projectId,
            status: runtime.status,
            port: runtime.port || null,
          });
          return;
        }

        case 'list_threads': {
          const projectId = String(op.projectId || '');
          const state = getProductState() || {};
          const order = state.threadOrderByProject?.[projectId] || [];
          const threads = order
            .map((threadId) => {
              const t = state.threadsById?.[threadId];
              if (!t) return null;
              return {
                threadId,
                title: t.title || '',
                archived: Boolean(t.archived),
                pinned: Boolean(t.pinned),
                updatedAt: t.updatedAt || null,
              };
            })
            .filter(Boolean);
          ctx.send({ type: 'threads', id, projectId, threads });
          return;
        }

        case 'create_thread': {
          const projectId = String(op.projectId || '');
          if (!projectId) return sendError(ctx, op, 'bad_request', 'projectId required');
          // Thread creation is owned by GUI store; for MVP we report unsupported
          // and rely on existing desktop threads. Renderer can create then list.
          return sendError(ctx, op, 'unsupported', 'create_thread not yet supported via mobile-remote; create on desktop then list');
        }

        case 'open_thread': {
          const projectId = String(op.projectId || '');
          const threadId = String(op.threadId || '');
          const state = getProductState() || {};
          const t = state.threadsById?.[threadId];
          if (!t || t.projectId !== projectId) {
            return sendError(ctx, op, 'bad_request', 'thread not found for project');
          }
          const timeline = Array.isArray(t.timeline) ? t.timeline : [];
          ctx.send({
            type: 'thread_opened',
            id,
            projectId,
            threadId,
            timeline: timeline.slice(-200),
          });
          return;
        }

        case 'prompt': {
          const projectId = String(op.projectId || '');
          const threadId = String(op.threadId || '');
          const text = String(op.text || '');
          if (!projectId || !threadId || !text) {
            return sendError(ctx, op, 'bad_request', 'projectId, threadId, text required');
          }
          const runtime = await ensureRuntime(projectId);
          const state = getProductState() || {};
          const thread = state.threadsById?.[threadId];
          const sessionId = thread?.sessionId || null;
          if (!sessionId) {
            return sendError(ctx, op, 'bad_request', 'thread has no sessionId; open in desktop first');
          }
          const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const controller = new AbortController();
          activePrompts.set(runId, controller);
          ctx.send({ type: 'prompt_started', id, runId, projectId, threadId });

          // ACP session/prompt via SSE
          const body = JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/prompt',
            params: { sessionId, prompt: text },
            id: runId,
          });
          cliStream(runtime, '/api/v1/acp', {
            method: 'POST',
            body,
            headers: { 'content-type': 'application/json', 'acp-session-token': sessionId },
            signal: controller.signal,
            onMessage: (msg) => {
              ctx.send({ type: 'stream_event', id, runId, projectId, threadId, event: msg });
              if (msg?.result?.done || msg?.error) {
                ctx.send({ type: 'prompt_done', id, runId, projectId, threadId, error: msg?.error || null });
              }
            },
          })
            .then((r) => {
              if (!r.ok) {
                ctx.send({
                  type: 'prompt_done',
                  id,
                  runId,
                  projectId,
                  threadId,
                  error: { code: 'prompt_failed', message: `HTTP ${r.status}`, body: r.body?.slice?.(0, 500) },
                });
              }
            })
            .catch((err) => {
              ctx.send({
                type: 'prompt_done',
                id,
                runId,
                projectId,
                threadId,
                error: { code: 'prompt_error', message: err?.message || String(err) },
              });
            })
            .finally(() => {
              activePrompts.delete(runId);
            });
          return;
        }

        case 'interrupt': {
          const runId = String(op.runId || '');
          const controller = runId ? activePrompts.get(runId) : null;
          if (controller) {
            controller.abort();
            activePrompts.delete(runId);
            ctx.send({ type: 'interrupted', id, runId });
          } else {
            ctx.send({ type: 'interrupted', id, runId, note: 'no active prompt' });
          }
          return;
        }

        case 'list_background_tasks': {
          // backgroundSession IPC lives in main; bridge will be wired with a getter in host.cjs
          const tasks = deps.listBackgroundTasks ? deps.listBackgroundTasks() : [];
          ctx.send({ type: 'background_tasks', id, tasks });
          return;
        }

        case 'get_session_options': {
          const projectId = String(op.projectId || '');
          const threadId = String(op.threadId || '');
          const state = getProductState() || {};
          const t = state.threadsById?.[threadId];
          if (!t || t.projectId !== projectId) {
            return sendError(ctx, op, 'bad_request', 'thread not found');
          }
          // Thread record stores last-known modelId/modeId. thoughtLevel lives in
          // renderer-only threadRuntimeById; for MVP we surface what product-state
          // has and let the client show a free-form override if absent.
          ctx.send({
            type: 'session_options',
            id,
            projectId,
            threadId,
            model: t.modelId || null,
            mode: t.modeId || null,
            reasoning: t.reasoning || t.thoughtLevel || null,
          });
          return;
        }

        case 'list_models': {
          // Model list comes from ACP session detail, not a REST endpoint. For
          // MVP we return the project's known thread models from product-state
          // (de-duped) plus a note to read the full list from Desktop.
          const projectId = String(op.projectId || '');
          const state = getProductState() || {};
          const order = state.threadOrderByProject?.[projectId] || [];
          const models = new Set();
          for (const tid of order) {
            const t = state.threadsById?.[tid];
            if (t?.modelId) models.add(t.modelId);
          }
          ctx.send({
            type: 'models',
            id,
            projectId,
            ok: true,
            models: Array.from(models).map((id) => ({ id, name: id })),
            note: 'List is derived from known thread models; open Desktop for the full catalog.',
          });
          return;
        }

        case 'set_model':
        case 'set_mode':
        case 'set_reasoning': {
          const projectId = String(op.projectId || '');
          const threadId = String(op.threadId || '');
          if (!projectId || !threadId) {
            return sendError(ctx, op, 'bad_request', 'projectId, threadId required');
          }
          const state = getProductState() || {};
          const thread = state.threadsById?.[threadId];
          const sessionId = thread?.sessionId || null;
          if (!sessionId) {
            return sendError(ctx, op, 'bad_request', 'thread has no sessionId');
          }
          const runtime = await ensureRuntime(projectId);
          let method;
          let params;
          if (type === 'set_model') {
            if (!op.modelId) return sendError(ctx, op, 'bad_request', 'modelId required');
            method = 'session/set_model';
            params = { sessionId, modelId: String(op.modelId) };
          } else if (type === 'set_mode') {
            if (!op.modeId) return sendError(ctx, op, 'bad_request', 'modeId required');
            method = 'session/set_mode';
            params = { sessionId, modeId: String(op.modeId) };
          } else {
            if (!op.value) return sendError(ctx, op, 'bad_request', 'value required');
            method = 'session/set_config_option';
            params = { sessionId, configId: 'thought_level', value: String(op.value) };
          }
          const r = await cliRequest(runtime, '/api/v1/acp', {
            method: 'POST',
            body: JSON.stringify({ jsonrpc: '2.0', method, params, id: id || undefined }),
            headers: {
              'content-type': 'application/json',
              'acp-session-token': sessionId,
              Accept: 'application/json',
            },
            timeoutMs: DEFAULT_TIMEOUT_MS,
          });
          const json = r.ok ? safeJson(r) : null;
          if (!r.ok || json?.error) {
            ctx.send({
              type: 'setting_applied',
              id,
              projectId,
              threadId,
              ok: false,
              kind: type,
              error: json?.error?.message || r.body?.slice(0, 500) || `HTTP ${r.status}`,
            });
            return;
          }
          ctx.send({
            type: 'setting_applied',
            id,
            projectId,
            threadId,
            ok: true,
            kind: type,
            value:
              type === 'set_model' ? op.modelId : type === 'set_mode' ? op.modeId : op.value,
          });
          return;
        }

        case 'permission_respond': {
          const projectId = String(op.projectId || '');
          const threadId = String(op.threadId || '');
          const requestId = String(op.requestId || '');
          const decision = String(op.decision || '').toLowerCase(); // allow | deny
          if (!projectId || !threadId || !requestId || (decision !== 'allow' && decision !== 'deny')) {
            return sendError(ctx, op, 'bad_request', 'projectId, threadId, requestId, decision(allow|deny) required');
          }
          const state = getProductState() || {};
          const thread = state.threadsById?.[threadId];
          const sessionId = thread?.sessionId || null;
          if (!sessionId) {
            return sendError(ctx, op, 'bad_request', 'thread has no sessionId');
          }
          const runtime = await ensureRuntime(projectId);
          // ACP permission response: session/respond_permission
          const r = await cliRequest(runtime, '/api/v1/acp', {
            method: 'POST',
            body: JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/respond_permission',
              params: { sessionId, requestId, decision: decision === 'allow' ? 'allow' : 'deny' },
              id: id || undefined,
            }),
            headers: {
              'content-type': 'application/json',
              'acp-session-token': sessionId,
              Accept: 'application/json',
            },
          });
          const json = r.ok ? safeJson(r) : null;
          ctx.send({
            type: 'permission_response_ack',
            id,
            projectId,
            threadId,
            requestId,
            ok: r.ok && !json?.error,
            error: json?.error?.message || (r.ok ? null : r.body?.slice(0, 500)),
          });
          return;
        }

        default:
          return sendError(ctx, op, 'bad_request', `unknown op type: ${type}`);
      }
    } catch (err) {
      return sendError(ctx, op, 'internal', err?.message || String(err));
    }
  }

  function safeJson(r) {
    try { return r.json(); } catch { return null; }
  }

  function sendError(ctx, op, code, message) {
    ctx.send({
      type: 'error',
      id: op?.id || null,
      code,
      message,
    });
  }

  return { dispatch };
}

module.exports = { createBridge };