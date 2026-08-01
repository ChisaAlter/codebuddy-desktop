'use strict';

/**
 * Host outbound relay transport.
 * Phase 1: single control socket; per-client data sockets; E2EE per client.
 *
 * Wire protocol with relay (see packages/mobile-remote-relay/session-hub.js):
 *   - Host control socket: receives { type: 'connected'|'disconnected', connectionId }
 *   - For each connected client, host opens data socket with connectionId,
 *     receives client text frames as raw payload (S4: the relay no longer
 *     forwards client_frame to the control socket), sends to client via
 *     { type:'server_frame', connectionId, payload }.
 *   - payload is the E2EE base64 bundle (or pre-handshake plaintext JSON).
 */

const { randomBytes } = require('crypto');
const { pathToFileURL } = require('url');
const path = require('path');

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const CONTROL_PING_INTERVAL_MS = 10000;
const CLIENT_DATA_OPEN_TIMEOUT_MS = 8000;

/**
 * @typedef {import('ws').WebSocket} WebSocket
 */

/**
 * Lazily import the protocol + crypto ESM packages and the `ws` module.
 */
async function loadDeps() {
  const root = path.join(__dirname, '..', '..', 'packages');
  const protocolUrl = pathToFileURL(path.join(root, 'mobile-remote-protocol', 'src', 'index.js')).href;
  const cryptoUrl = pathToFileURL(path.join(root, 'mobile-remote-crypto', 'src', 'index.js')).href;
  const [protocol, crypto, wsMod] = await Promise.all([
    import(protocolUrl),
    import(cryptoUrl),
    import('ws'),
  ]);
  return { protocol, crypto, WebSocket: wsMod.WebSocket || wsMod.default };
}

/**
 * @param {object} args
 * @param {string} args.endpoint host:port
 * @param {boolean} [args.useTls]
 * @param {string} args.serverId
 * @param {object} args.e2eeKeyPair { publicKey, secretKey } (NaCl)
 * @param {object} args.relayAuthKeyPair { publicKey, secretKey } (NaCl sign)
 * @param {object} args.handlers
 * @param {(client: ClientSession) => Promise<void>} args.handlers.onClientReady
 * @param {(client: ClientSession, plaintext: string) => Promise<void>} args.handlers.onClientMessage
 * @param {(client: ClientSession) => void} [args.handlers.onClientClose]
 * @param {(...a: unknown[]) => void} [args.log]
 */
async function startHostRelayTransport(args) {
  const { protocol, crypto, WebSocket } = await loadDeps();
  const log = args.log || (() => {});

  /** @type {Map<string, ClientSession>} */
  const clients = new Map();
  let controlWs = null;
  let stopped = false;
  let reconnectTimer = null;
  let pingTimer = null;
  // M-mr3: track the last pong time so a half-open control socket (e.g. after
  // suspend/network change) is detected and terminated instead of silently
  // dropping future client/data traffic.
  let lastPongAt = 0;

  function scheduleReconnect(delay) {
    if (stopped) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectControl().catch((err) => {
        log('control reconnect failed', err?.message || err);
        scheduleReconnect(nextBackoff());
      });
    }, delay);
  }

  let attempt = 0;
  function nextBackoff() {
    attempt += 1;
    const base = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt - 1), RECONNECT_MAX_MS);
    return base + Math.floor(Math.random() * 500);
  }

  function signServerAuth(connectionId) {
    const issuedAt = Date.now();
    const nonce = randomBytes(12).toString('base64url');
    const sig = crypto.signRelayServerAuth(
      {
        serverId: args.serverId,
        role: 'server',
        connectionId: connectionId || '',
        nonce,
        issuedAt,
      },
      args.relayAuthKeyPair.secretKey,
    );
    return {
      relayAuthNonce: nonce,
      relayAuthIssuedAt: String(issuedAt),
      relayAuthSig: sig,
      relayAuthPublicKeyB64: crypto.exportRelayAuthPublicKey(args.relayAuthKeyPair.publicKey),
    };
  }

  async function openDataSocket(connectionId) {
    const url = protocol.buildRelayWebSocketUrl({
      endpoint: args.endpoint,
      useTls: args.useTls,
      serverId: args.serverId,
      role: 'server',
      connectionId,
      extraQuery: signServerAuth(connectionId),
    });
    log('opening data socket', connectionId);
    const ws = new WebSocket(url, {
      handshakeTimeout: CLIENT_DATA_OPEN_TIMEOUT_MS,
      perMessageDeflate: false,
      maxPayload: 16 * 1024 * 1024,
    });
    /** @type {ClientSession} */
    const session = {
      connectionId,
      ws,
      channel: null,
      ready: false,
      closed: false,
    };
    clients.set(connectionId, session);

    const openTimer = setTimeout(() => {
      try { ws.terminate(); } catch (_) {}
    }, CLIENT_DATA_OPEN_TIMEOUT_MS);

    ws.on('open', () => {
      clearTimeout(openTimer);
      log('data socket open', connectionId);
    });

    ws.on('message', async (data, isBinary) => {
      if (isBinary) return;
      // S4: the relay forwards client frames to the host data socket as raw
      // payload (client_frame routing to the control socket was removed).
      const text = typeof data === 'string' ? data : data.toString('utf8');
      await handleClientFrame(session, text);
    });

    ws.on('close', () => {
      clearTimeout(openTimer);
      handleClientClose(session);
    });
    ws.on('error', (err) => {
      clearTimeout(openTimer);
      log('data socket error', connectionId, err?.message || err);
      handleClientClose(session);
    });
  }

  async function handleClientFrame(session, text) {
    if (session.closed) return;

    // Pre-handshake: expect e2ee_hello JSON plaintext
    if (!session.channel) {
      const msg = crypto.parseHandshakeMessage(text);
      if (!msg || msg.type !== 'e2ee_hello' || typeof msg.publicKeyB64 !== 'string') {
        log('expected e2ee_hello', session.connectionId);
        return;
      }
      try {
        session.channel = crypto.createHostChannelFromHello(args.e2eeKeyPair, msg.publicKeyB64);
      } catch (err) {
        log('host channel from hello failed', err?.message || err);
        try { session.ws.close(1008, 'bad hello'); } catch (_) {}
        return;
      }
      const ready = crypto.buildE2eeReadyMessage();
      sendServerFrame(session, ready);
      session.ready = true;
      log('client ready (e2ee)', session.connectionId);
      try { await args.handlers.onClientReady?.(session); } catch (err) {
        log('onClientReady threw', err?.message || err);
      }
      return;
    }

    // Encrypted payload
    let plaintext;
    try {
      plaintext = session.channel.decryptUtf8(text);
    } catch (err) {
      log('decrypt failed', session.connectionId, err?.message || err);
      return;
    }
    try {
      await args.handlers.onClientMessage?.(session, plaintext);
    } catch (err) {
      log('onClientMessage threw', err?.message || err);
    }
  }

  /**
   * Send a plaintext (pre-handshake) frame to the client via the relay's
   * server_frame wrapping so the relay demuxes to the right client.
   */
  function sendServerFrame(session, payloadText) {
    if (!session || session.closed || !session.ws || session.ws.readyState !== 1) return;
    const wrapped = JSON.stringify({
      type: 'server_frame',
      connectionId: session.connectionId,
      payload: payloadText,
    });
    try { session.ws.send(wrapped); } catch (_) {}
  }

  function handleClientClose(session) {
    if (session.closed) return;
    session.closed = true;
    if (clients.get(session.connectionId) === session) clients.delete(session.connectionId);
    args.handlers.onClientClose?.(session);
    log('client closed', session.connectionId);
  }

  /**
   * Send an encrypted JSON message to a client.
   * @param {ClientSession} session
   * @param {object} message
   */
  function sendToClient(session, message) {
    if (!session || session.closed || !session.ws || session.ws.readyState !== 1) return;
    if (!session.channel || !session.ready) {
      log('sendToClient before ready', session?.connectionId);
      return;
    }
    const bundle = session.channel.encrypt(JSON.stringify(message));
    sendServerFrame(session, bundle);
  }

  async function connectControl() {
    if (stopped) return;
    const url = protocol.buildRelayWebSocketUrl({
      endpoint: args.endpoint,
      useTls: args.useTls,
      serverId: args.serverId,
      role: 'server',
      extraQuery: signServerAuth(''),
    });
    log('connecting control', url.split('?')[0]);
    const ws = new WebSocket(url, {
      handshakeTimeout: 8000,
      perMessageDeflate: false,
      // S4: keep the control socket cap aligned with the relay (16MB). The
      // relay no longer forwards client frames to the control socket, but a
      // mismatched smaller cap would still turn any large inbound frame into a
      // full control disconnect (which drops every client's data socket).
      maxPayload: 16 * 1024 * 1024,
    });
    controlWs = ws;

    await new Promise((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        // S3: stop() may have closed this socket while it was still connecting;
        // do not register the control handlers or ping timer for a dead socket.
        if (stopped) {
          try { ws.close(); } catch (_) {}
          reject(new Error('transport stopped'));
          return;
        }
        resolve();
      };
      const onError = (err) => { cleanup(); reject(err); };
      const cleanup = () => {
        ws.removeListener('open', onOpen);
        ws.removeListener('error', onError);
      };
      ws.once('open', onOpen);
      ws.once('error', onError);
    });

    log('control online', args.serverId);
    attempt = 0;

    ws.on('message', async (data, isBinary) => {
      if (isBinary) return;
      const text = typeof data === 'string' ? data : data.toString('utf8');
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'connected' && typeof msg.connectionId === 'string') {
        log('client joined', msg.connectionId);
        await openDataSocket(msg.connectionId).catch((err) => {
          log('openDataSocket failed', msg.connectionId, err?.message || err);
        });
      } else if (msg.type === 'disconnected' && typeof msg.connectionId === 'string') {
        const s = clients.get(msg.connectionId);
        if (s) {
          try { s.ws.close(); } catch (_) {}
          handleClientClose(s);
        }
      }
    });

    ws.on('close', () => {
      log('control closed');
      controlWs = null;
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      // drop all clients
      for (const s of clients.values()) {
        try { s.ws.close(); } catch (_) {}
        handleClientClose(s);
      }
      scheduleReconnect(nextBackoff());
    });
    ws.on('error', (err) => {
      log('control error', err?.message || err);
    });
    // M-mr3: record pong arrivals so the ping interval can detect a half-open
    // control socket and terminate it, triggering reconnect.
    lastPongAt = Date.now();
    ws.on('pong', () => {
      lastPongAt = Date.now();
    });

    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (controlWs && controlWs.readyState === 1) {
        // M-mr3: if no pong has arrived within ~3x the ping interval, the control
        // socket is half-open — terminate so connectControl's close handler
        // schedules a reconnect instead of silently dropping traffic.
        if (Date.now() - lastPongAt > CONTROL_PING_INTERVAL_MS * 3) {
          log('control pong timeout, terminating');
          try { controlWs.terminate(); } catch (_) {}
          return;
        }
        try { controlWs.ping(); } catch (_) {}
      }
    }, CONTROL_PING_INTERVAL_MS);
  }

  await connectControl().catch((err) => {
    log('initial control connect failed', err?.message || err);
    scheduleReconnect(nextBackoff());
  });

  return {
    /** @param {ClientSession} session @param {object} message */
    sendToClient,
    /**
     * @param {object} message
     * @param {(connectionId: string) => boolean} [filterFn] optional per-client
     *   gate (S2: host.cjs passes an authenticated-connections filter so E2EE-only
     *   handshakes do not receive broadcasts).
     */
    broadcast(message, filterFn) {
      for (const [connectionId, s] of clients) {
        if (filterFn && !filterFn(connectionId)) continue;
        sendToClient(s, message);
      }
    },
    getStats() {
      return {
        controlOnline: Boolean(controlWs && controlWs.readyState === 1),
        clients: Array.from(clients.keys()),
      };
    },
    /**
     * Force-close a specific client's data socket (C2: used when revoking a
     * device so its active connection is torn down and cannot keep issuing ops).
     * @param {string} connectionId
     * @returns {boolean} whether a client was found and closed.
     */
    kickConnection(connectionId) {
      const s = clients.get(connectionId);
      if (!s) return false;
      try { s.ws.close(4001, 'revoked'); } catch (_) {}
      handleClientClose(s);
      return true;
    },
    async stop() {
      stopped = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      for (const s of clients.values()) {
        try { s.ws.close(); } catch (_) {}
        handleClientClose(s);
      }
      clients.clear();
      if (controlWs) {
        try { controlWs.close(); } catch (_) {}
        controlWs = null;
      }
    },
  };
}

module.exports = { startHostRelayTransport };