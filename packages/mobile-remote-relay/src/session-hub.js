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
      const auth = this.verifyServerAuth(query);
      if (!auth.ok) {
        this.log('server auth failed', serverId, auth.reason);
        ws.close(1008, auth.reason || 'auth failed');
        return;
      }
      const session = this.getOrCreate(serverId);
      if (session.server && session.server.readyState === 1) {
        try {
          session.server.close(4000, 'replaced by new server');
        } catch {
          /* ignore */
        }
      }
      session.server = ws;
      ws._mr = { serverId, role, connectionId: null };
      this.log('server online', serverId);

      ws.on('message', (data, isBinary) => {
        this.#onServerMessage(serverId, data, isBinary);
      });
      ws.on('close', () => {
        const s = this.sessions.get(serverId);
        if (s && s.server === ws) {
          s.server = null;
          this.log('server offline', serverId);
          for (const [, client] of s.clients) {
            try {
              client.close(4001, 'server offline');
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
    if (session.clients.has(connectionId)) {
      try {
        session.clients.get(connectionId)?.close(4000, 'replaced');
      } catch {
        /* ignore */
      }
    }
    session.clients.set(connectionId, ws);
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
      // Prefix client frames so host can demux (phase-1 single socket)
      if (isBinary) {
        // binary: leave as-is only if host expects; phase-1 uses text
        this.#safeSend(s.server, data, true);
        return;
      }
      const text = typeof data === 'string' ? data : data.toString('utf8');
      this.#safeSend(
        s.server,
        JSON.stringify({ type: 'client_frame', connectionId, payload: text }),
      );
    });

    ws.on('close', () => {
      const s = this.sessions.get(serverId);
      if (!s) return;
      if (s.clients.get(connectionId) === ws) s.clients.delete(connectionId);
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

    // Host → specific client
    if (msg && msg.type === 'server_frame' && typeof msg.connectionId === 'string') {
      const client = s.clients.get(msg.connectionId);
      if (client && client.readyState === 1 && typeof msg.payload === 'string') {
        this.#safeSend(client, msg.payload);
      }
      return;
    }

    // Host broadcast (optional)
    if (msg && msg.type === 'broadcast' && typeof msg.payload === 'string') {
      for (const [, client] of s.clients) {
        if (client.readyState === 1) this.#safeSend(client, msg.payload);
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
