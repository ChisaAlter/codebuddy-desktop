/**
 * In-memory meet-me hub: one Host (server) + N clients per serverId.
 * Phase 1: single data socket per peer; control messages optional via same socket meta.
 */

import { randomUUID } from 'node:crypto';
import {
  deriveServerId,
  importRelayAuthPublicKey,
  verifyRelayServerAuth,
} from '@codebuddy/mobile-remote-crypto';

const AUTH_MAX_AGE_MS = 5 * 60 * 1000;
const AUTH_FUTURE_SKEW_MS = 60 * 1000;
const MAX_NONCE_CACHE = 2000;
// H10: resource caps to bound memory/DoS surface.
const MAX_SESSIONS = 1024;
const MAX_CLIENTS_PER_SESSION = 32;
const MAX_PENDING_FRAMES_PER_CLIENT = 256;
// R9: frame-count cap alone still allows 256 × maxPayload bytes per client to
// sit in relay memory. Cap total buffered BYTES per client as well; oldest
// frames are dropped first once either cap is exceeded.
const MAX_PENDING_BYTES_PER_CLIENT = 1 * 1024 * 1024;
const MAX_FAILED_AUTH_PER_SERVER_ID = 8;
const FAILED_AUTH_WINDOW_MS = 60 * 1000;
// Failure-count buckets for serverIds that have no bound session yet. Without
// this, an attacker could spam verifyServerAuth with random serverIds and force
// getOrCreate to allocate a session per attempt, exhausting MAX_SESSIONS and
// blocking legitimate hosts ("relay full"). Buckets are LRU-capped separately.
const MAX_UNAUTH_BUCKETS = 4096;

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
    /** @type {Map<string, { server: WebSocket | null, clients: Map<string, WebSocket>, relayAuthPublicKeyB64: string | null, usedNonces: Map<string, number>, failedAuth: { count: number, windowStart: number } }>} */
    this.sessions = new Map();
    // Failure counters for serverIds with no live session. Kept separate from
    // `sessions` so unauthenticated serverId spam cannot allocate sessions and
    // exhaust MAX_SESSIONS. LRU-evicted past MAX_UNAUTH_BUCKETS.
    /** @type {Map<string, { count: number, windowStart: number }>} */
    this.unauthFailures = new Map();
  }

  /**
   * @param {string} serverId
   */
  getOrCreate(serverId) {
    let s = this.sessions.get(serverId);
    if (!s) {
      // H10: cap total sessions to bound unbounded Map growth (any serverId string
      // could otherwise allocate a new entry).
      if (this.sessions.size >= MAX_SESSIONS) return null;
      s = {
        server: null,
        clients: new Map(),
        relayAuthPublicKeyB64: null,
        usedNonces: new Map(),
        failedAuth: { count: 0, windowStart: this.now() },
      };
      this.sessions.set(serverId, s);
    }
    return s;
  }

  /**
   * Record a failed auth attempt for a serverId and return false (reject) if the
   * per-serverId failure budget is exhausted within the rolling window. H8/H10:
   * prevents nonce-burn + signature-spam DoS from locking out a host's serverId.
   * Does NOT allocate a session: when no session exists for serverId yet, the
   * counter lives in `unauthFailures` (LRU-capped) so unauthenticated serverId
   * spam cannot exhaust MAX_SESSIONS via this path.
   * @param {string} serverId
   * @returns {boolean} true if the attempt may proceed, false if rate-limited.
   */
  recordFailedAuth(serverId) {
    const now = this.now();
    const s = this.sessions.get(serverId);
    if (s) {
      if (now - s.failedAuth.windowStart > FAILED_AUTH_WINDOW_MS) {
        s.failedAuth.count = 0;
        s.failedAuth.windowStart = now;
      }
      s.failedAuth.count += 1;
      return s.failedAuth.count <= MAX_FAILED_AUTH_PER_SERVER_ID;
    }
    // No session yet — track in unauthFailures (separate, LRU-capped map).
    let bucket = this.unauthFailures.get(serverId);
    if (!bucket) {
      if (this.unauthFailures.size >= MAX_UNAUTH_BUCKETS) {
        const first = this.unauthFailures.keys().next().value;
        if (first) this.unauthFailures.delete(first);
      }
      bucket = { count: 0, windowStart: now };
      this.unauthFailures.set(serverId, bucket);
    } else {
      // Refresh LRU position.
      this.unauthFailures.delete(serverId);
      this.unauthFailures.set(serverId, bucket);
    }
    if (now - bucket.windowStart > FAILED_AUTH_WINDOW_MS) {
      bucket.count = 0;
      bucket.windowStart = now;
    }
    bucket.count += 1;
    return bucket.count <= MAX_FAILED_AUTH_PER_SERVER_ID;
  }

  /**
   * @param {string} serverId
   * @param {string} nonce
   */
  consumeNonce(serverId, nonce) {
    const s = this.sessions.get(serverId);
    if (!s) {
      // No bound session → nothing to record. Nonces for unregistered serverIds
      // are not tracked (they cannot be replayed against a session that does not
      // exist). Returning true lets verifyServerAuth proceed; the caller is
      // expected to have created the session first on the success path.
      return true;
    }
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

    // Read-only lookup: do NOT allocate a session here. Previously this called
    // getOrCreate, which meant any failed-auth attempt with a random serverId
    // would allocate a session and exhaust MAX_SESSIONS (relay full DoS). The
    // session is created only after the signature verifies.
    const existing = this.sessions.get(serverId);
    if (existing && existing.relayAuthPublicKeyB64 && existing.relayAuthPublicKeyB64 !== pub) {
      return { ok: false, reason: 'relay-auth key mismatch for serverId' };
    }

    let publicKey;
    try {
      publicKey = importRelayAuthPublicKey(pub);
    } catch {
      return { ok: false, reason: 'invalid relay-auth public key' };
    }

    // H8: verify the signature BEFORE consuming the nonce. Previously the nonce
    // was burned first, so an attacker who knows the (public) serverId could
    // repeatedly hit the relay with random nonce+sig values, evicting the host's
    // legitimate nonces and DoSing host connectivity with "nonce replay" errors.
    const valid = verifyRelayServerAuth(
      { serverId, role, connectionId: connectionId || undefined, nonce, issuedAt },
      sig,
      publicKey,
    );
    if (!valid) {
      // H8/H10: rate-limit repeated bad-signature attempts per serverId so the
      // nonce cache and connection slots aren't burned by a spammer. This no
      // longer allocates a session — see recordFailedAuth.
      this.recordFailedAuth(serverId);
      return { ok: false, reason: 'bad signature' };
    }

    // Signature verified — now it is safe to bind the session and consume the
    // nonce. Creating the session here (rather than on every attempt) closes the
    // "random serverId spam → MAX_SESSIONS exhaustion" DoS.
    // H9: the serverId must be derived from the presented relay-auth public key
    // (deriveServerId). Without this, an attacker who sees a victim's serverId
    // in a QR offer could connect first with their own keypair and squat it —
    // the legitimate host would then be locked out with "key mismatch".
    if (deriveServerId(pub) !== serverId) {
      return { ok: false, reason: 'serverId does not match relay-auth key' };
    }
    const session = this.getOrCreate(serverId);
    if (!session) return { ok: false, reason: 'relay full' };
    if (!this.consumeNonce(serverId, nonce)) return { ok: false, reason: 'nonce replay' };

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
      if (!session) {
        // H10: sessions map is full.
        ws.close(1013, 'relay full');
        return;
      }

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
          clientState.dataWs = ws;
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
            clientState.pendingBytes = 0;
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
          // R9: while this data socket was live, the client's frames were wired
          // straight to it. Without re-attaching the buffering listener, every
          // client frame sent after this close would hit a dead socket and be
          // silently dropped. Re-buffer for the next data socket the host opens
          // (host reopens data sockets on reconnect). Only revert if THIS socket
          // is still the client's current data socket (a replacement may already
          // have rewired the client).
          const s = this.sessions.get(serverId);
          const c = s?.clients.get(connectionId);
          if (c && c.dataWs === ws) {
            c.dataWs = null;
            if (c.ws && c.ws.readyState === 1) {
              c.ws.removeAllListeners('message');
              this.#attachClientBuffering(serverId, connectionId, c);
            }
          }
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
    // Do NOT allocate a session here — clients must join an existing session
    // whose server control socket already authenticated via verifyServerAuth.
    // Pre-allocating would let an attacker spam random serverIds as clients and
    // exhaust MAX_SESSIONS ("relay full" DoS), mirroring the server-side fix.
    const session = this.sessions.get(serverId);
    if (!session) {
      ws.close(1013, 'server offline');
      return;
    }
    if (!session.server || session.server.readyState !== 1) {
      ws.close(1013, 'server offline');
      return;
    }
    // H10: cap concurrent clients per session to bound per-serverId DoS.
    if (session.clients.size >= MAX_CLIENTS_PER_SESSION) {
      ws.close(1013, 'too many clients');
      return;
    }
    // H11: ignore any client-supplied connectionId and assign a fresh server-side
    // UUID. A predictable, client-chosen connectionId let an attacker evict a live
    // client (duplicate key → 4000 'replaced') and squat the host's data routing.
    const connectionId = randomUUID();
    /** @type {{ ws: WebSocket, pending: string[], pendingBytes: number, dataWs: WebSocket | null }} */
    const clientState = { ws, pending: [], pendingBytes: 0, dataWs: null };
    session.clients.set(connectionId, clientState);
    ws._mr = { serverId, role, connectionId };
    this.log('client connected', serverId, connectionId);

    // notify host (plaintext control hint on server socket)
    this.#safeSend(
      session.server,
      JSON.stringify({ type: 'connected', connectionId }),
    );

    this.#attachClientBuffering(serverId, connectionId, clientState);

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
   * Buffer client frames until a host data socket attaches (or re-attaches).
   * H10/R9: bounded by BOTH a frame-count cap and a byte cap; oldest frames are
   * dropped first. S4: frames are never forwarded to the control socket — the
   * host's control socket has a lower/equal maxPayload and a single oversized
   * frame would drop the control connection, tearing down every client.
   * @param {string} serverId
   * @param {string} connectionId
   * @param {{ ws: WebSocket, pending: string[], pendingBytes: number }} clientState
   */
  #attachClientBuffering(serverId, connectionId, clientState) {
    clientState.ws.on('message', (data) => {
      const s = this.sessions.get(serverId);
      if (!s?.server || s.server.readyState !== 1) return;
      const text = typeof data === 'string' ? data : data.toString('utf8');
      const bytes = Buffer.byteLength(text, 'utf8');
      // R9: a single frame larger than the byte budget can never be buffered;
      // drop it outright instead of evicting the whole queue for nothing.
      if (bytes > MAX_PENDING_BYTES_PER_CLIENT) {
        this.log('pending frame too large', serverId, connectionId, bytes);
        return;
      }
      clientState.pending.push(text);
      clientState.pendingBytes += bytes;
      while (
        clientState.pending.length > MAX_PENDING_FRAMES_PER_CLIENT ||
        clientState.pendingBytes > MAX_PENDING_BYTES_PER_CLIENT
      ) {
        const dropped = clientState.pending.shift();
        clientState.pendingBytes -= Buffer.byteLength(dropped, 'utf8');
        this.log('pending overflow', serverId, connectionId);
      }
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
