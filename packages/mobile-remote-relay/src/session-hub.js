/**
 * In-memory meet-me hub: one Host (server) + N clients per serverId.
 * Phase 1: single data socket per peer; control messages optional via same socket meta.
 */

import { randomUUID } from 'node:crypto';
import {
  importRelayAuthPublicKey,
  verifyRelayServerAuth,
} from '@codebuddy/mobile-remote-crypto';

const AUTH_MAX_AGE_MS = 5 * 60 * 1000;
const AUTH_FUTURE_SKEW_MS = 60 * 1000;
const MAX_NONCE_CACHE = 2000;

/**
 * @typedef {import('ws').WebSocket} WebSocket
 */

export class SessionHub {
  /**
   * @param {{ allowUnsignedServer?: boolean, now?: () => number, log?: (...args: unknown[]) => void }} [options]
   */
  constructor(options = {}) {
    this.allowUnsignedServer = Boolean(options.allowUnsignedServer);
    this.now = options.now || (() => Date.now());
    this.log = options.log || (() => {});
    /** @type {Map<string, { server: WebSocket | null, clients: Map<string, WebSocket>, relayAuthPublicKeyB64: string | null, usedNonces: Map<string, number> }>} */
    this.sessions = new Map();
  }

  /**
   * @param {string} serverId
   */
  getOrCreate(serverId) {
    let s = this.sessions.get(serverId);
    if (!s) {
      s = {
        server: null,
        clients: new Map(),
        relayAuthPublicKeyB64: null,
        usedNonces: new Map(),
      };
      this.sessions.set(serverId, s);
    }
    return s;
  }

  /**
   * @param {string} serverId
   * @param {string} nonce
   */
  consumeNonce(serverId, nonce) {
    const s = this.getOrCreate(serverId);
    const now = this.now();
    for (const [n, exp] of s.usedNonces) {
      if (exp < now) s.usedNonces.delete(n);
    }
    if (s.usedNonces.has(nonce)) return false;
    if (s.usedNonces.size >= MAX_NONCE_CACHE) {
      const first = s.usedNonces.keys().next().value;
      if (first) s.usedNonces.delete(first);
    }
    s.usedNonces.set(nonce, now + AUTH_MAX_AGE_MS);
    return true;
  }

  /**
   * @param {URLSearchParams} query
   * @returns {{ ok: true } | { ok: false, reason: string }}
   */
  verifyServerAuth(query) {
    const serverId = query.get('serverId') || '';
    const role = query.get('role') || '';
    const connectionId = query.get('connectionId') || '';
    const nonce = query.get('relayAuthNonce') || '';
    const issuedAtRaw = query.get('relayAuthIssuedAt') || '';
    const sig = query.get('relayAuthSig') || '';
    const pub = query.get('relayAuthPublicKeyB64') || '';

    if (!sig || !nonce || !issuedAtRaw || !pub) {
      if (this.allowUnsignedServer) return { ok: true };
      return { ok: false, reason: 'missing relay auth fields' };
    }

    const issuedAt = Number(issuedAtRaw);
    if (!Number.isFinite(issuedAt)) return { ok: false, reason: 'invalid issuedAt' };
    const now = this.now();
    if (issuedAt > now + AUTH_FUTURE_SKEW_MS) return { ok: false, reason: 'issuedAt in future' };
    if (now - issuedAt > AUTH_MAX_AGE_MS) return { ok: false, reason: 'auth expired' };
    if (!this.consumeNonce(serverId, nonce)) return { ok: false, reason: 'nonce replay' };

    const session = this.getOrCreate(serverId);
    if (session.relayAuthPublicKeyB64 && session.relayAuthPublicKeyB64 !== pub) {
      return { ok: false, reason: 'relay-auth key mismatch for serverId' };
    }

    let publicKey;
    try {
      publicKey = importRelayAuthPublicKey(pub);
    } catch {
      return { ok: false, reason: 'invalid relay-auth public key' };
    }

    const valid = verifyRelayServerAuth(
      { serverId, role, connectionId: connectionId || undefined, nonce, issuedAt },
      sig,
      publicKey,
    );
    if (!valid) return { ok: false, reason: 'bad signature' };

    session.relayAuthPublicKeyB64 = pub;
    return { ok: true };
  }

  /**
   * @param {WebSocket} ws
   * @param {URLSearchParams} query
   */
  attach(ws, query) {
    const serverId = (query.get('serverId') || '').trim();
    const role = (query.get('role') || '').trim();
    if (!serverId) {
      ws.close(1008, 'serverId required');
      return;
    }
    if (role !== 'server' && role !== 'client') {
      ws.close(1008, 'role must be server or client');
      return;
    }

    if (role === 'server') {
      const connectionId = (query.get('connectionId') || '').trim();
      const isData = connectionId.length > 0;

      const auth = this.verifyServerAuth(query);
      if (!auth.ok) {
        this.log('server auth failed', serverId, auth.reason);
        ws.close(1008, auth.reason || 'auth failed');
        return;
      }
      const session = this.getOrCreate(serverId);

      if (isData) {
        // Data socket: a per-client outbound socket opened by the host when a
        // client joins. It must NOT replace the control socket. Find the client
        // this data socket serves and bridge frames directly with that client.
        const clientState = session.clients.get(connectionId);
        const client = clientState?.ws;
        ws._mr = { serverId, role, connectionId, isData: true };
        this.log('server data online', serverId, connectionId, client ? 'client-present' : 'no-client');

        if (client && client.readyState === 1) {
          // Rewire client -> this data socket (raw payload, no client_frame wrap).
          client.removeAllListeners('message');
          client.on('message', (data, isBinary) => {
            if (isBinary) {
              this.#safeSend(ws, data, true);
              return;
            }
            const text = typeof data === 'string' ? data : data.toString('utf8');
            this.#safeSend(ws, text, false);
          });
          // Flush any frames buffered before the data socket attached.
          if (clientState.pending.length) {
            for (const pending of clientState.pending) this.#safeSend(ws, pending, false);
            clientState.pending = [];
          }
        }

        ws.on('message', (data, isBinary) => {
          if (isBinary) return;
          const text = typeof data === 'string' ? data : data.toString('utf8');
          // Host data socket sends { type:'server_frame', connectionId, payload }.
          // Forward payload to the client as raw text.
          let payload = null;
          try {
            const wrapped = JSON.parse(text);
            if (
              wrapped &&
              wrapped.type === 'server_frame' &&
              wrapped.connectionId === connectionId &&
              typeof wrapped.payload === 'string'
            ) {
              payload = wrapped.payload;
            }
          } catch {
            payload = text; // raw fallback
          }
          if (payload == null) return;
          const s = this.sessions.get(serverId);
          const c = s?.clients.get(connectionId);
          if (c?.ws && c.ws.readyState === 1) this.#safeSend(c.ws, payload, false);
        });

        ws.on('close', () => {
          this.log('server data offline', serverId, connectionId);
        });
        return;
      }

      // Control socket (no connectionId)
      if (session.server && session.server.readyState === 1) {
        try {
          session.server.close(4000, 'replaced by new server');
        } catch {
          /* ignore */
        }
      }
      session.server = ws;
      ws._mr = { serverId, role, connectionId: null, isData: false };
      this.log('server online', serverId);

      ws.on('message', (data, isBinary) => {
        this.#onServerMessage(serverId, data, isBinary);
      });
      ws.on('close', () => {
        const s = this.sessions.get(serverId);
        if (s && s.server === ws) {
          s.server = null;
          this.log('server offline', serverId);
          for (const [, clientState] of s.clients) {
            try {
              clientState.ws.close(4001, 'server offline');
            } catch {
              /* ignore */
            }
          }
          s.clients.clear();
        }
      });
      return;
    }

    // client
    const session = this.getOrCreate(serverId);
    if (!session.server || session.server.readyState !== 1) {
      ws.close(1013, 'server offline');
      return;
    }
    const connectionId = (query.get('connectionId') || '').trim() || randomUUID();
    const existing = session.clients.get(connectionId);
    if (existing) {
      try { existing.ws.close(4000, 'replaced'); } catch { /* ignore */ }
    }
    /** @type {{ ws: WebSocket, pending: string[] }} */
    const clientState = { ws, pending: [] };
    session.clients.set(connectionId, clientState);
    ws._mr = { serverId, role, connectionId };
    this.log('client connected', serverId, connectionId);

    // notify host (plaintext control hint on server socket)
    this.#safeSend(
      session.server,
      JSON.stringify({ type: 'connected', connectionId }),
    );

    ws.on('message', (data, isBinary) => {
      const s = this.sessions.get(serverId);
      if (!s?.server || s.server.readyState !== 1) return;
      const text = typeof data === 'string' ? data : data.toString('utf8');
      clientState.pending.push(text);
      // Also forward to control as client_frame (host ignores on control, but
      // keeps the option open for single-socket hosts).
      this.#safeSend(
        s.server,
        JSON.stringify({ type: 'client_frame', connectionId, payload: text }),
      );
    });

    ws.on('close', () => {
      const s = this.sessions.get(serverId);
      if (!s) return;
      if (s.clients.get(connectionId)?.ws === ws) s.clients.delete(connectionId);
      if (s.server && s.server.readyState === 1) {
        this.#safeSend(
          s.server,
          JSON.stringify({ type: 'disconnected', connectionId }),
        );
      }
      this.log('client disconnected', serverId, connectionId);
    });
  }

  /**
   * @param {string} serverId
   * @param {import('ws').RawData} data
   * @param {boolean} isBinary
   */
  #onServerMessage(serverId, data, isBinary) {
    if (isBinary) return;
    const text = typeof data === 'string' ? data : data.toString('utf8');
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const s = this.sessions.get(serverId);
    if (!s) return;

    // Host → specific client (legacy control-socket path; data sockets preferred)
    if (msg && msg.type === 'server_frame' && typeof msg.connectionId === 'string') {
      const c = s.clients.get(msg.connectionId);
      if (c?.ws && c.ws.readyState === 1 && typeof msg.payload === 'string') {
        this.#safeSend(c.ws, msg.payload);
      }
      return;
    }

    // Host broadcast (optional)
    if (msg && msg.type === 'broadcast' && typeof msg.payload === 'string') {
      for (const [, clientState] of s.clients) {
        if (clientState.ws.readyState === 1) this.#safeSend(clientState.ws, msg.payload);
      }
    }
  }

  /**
   * @param {WebSocket} ws
   * @param {import('ws').RawData} data
   * @param {boolean} [isBinary]
   */
  #safeSend(ws, data, isBinary = false) {
    if (!ws || ws.readyState !== 1) return;
    try {
      ws.send(data, { binary: isBinary });
    } catch {
      /* ignore */
    }
  }
}
