import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  deriveServerId,
  generateRelayAuthKeyPair,
  exportRelayAuthPublicKey,
  signRelayServerAuth,
} from '@codebuddy/mobile-remote-crypto';
import { SessionHub } from '../src/session-hub.js';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    this.closed = null;
  }
  send(data) {
    this.sent.push(data);
  }
  close(code, reason) {
    this.readyState = 3;
    this.closed = { code, reason };
    this.emit('close');
  }
  // needed for data-socket rewire path
  removeAllListeners(event) {
    if (event) super.removeAllListeners(event);
    return this;
  }
}

describe('SessionHub auth', () => {
  it('rejects unsigned server when not allowed', () => {
    const hub = new SessionHub({ allowUnsignedServer: false });
    const ws = new FakeSocket();
    const q = new URLSearchParams({ serverId: 'srv_1', role: 'server' });
    hub.attach(ws, q);
    assert.equal(ws.closed?.code, 1008);
  });

  it('accepts signed server and rejects client_frame forwarding to control', () => {
    const kp = generateRelayAuthKeyPair();
    const pub = exportRelayAuthPublicKey(kp.publicKey);
    const issuedAt = Date.now();
    const nonce = 'nonce-abc';
    // H9: serverId must be derived from the relay-auth public key.
    const serverId = deriveServerId(pub);
    const fields = {
      serverId,
      role: 'server',
      connectionId: '',
      nonce,
      issuedAt,
    };
    const sig = signRelayServerAuth(fields, kp.secretKey);

    const hub = new SessionHub({ allowUnsignedServer: false });
    const serverWs = new FakeSocket();
    const serverQ = new URLSearchParams({
      serverId,
      role: 'server',
      relayAuthNonce: nonce,
      relayAuthIssuedAt: String(issuedAt),
      relayAuthSig: sig,
      relayAuthPublicKeyB64: pub,
    });
    hub.attach(serverWs, serverQ);
    assert.equal(serverWs.closed, null);

    const clientWs = new FakeSocket();
    // H11: relay now ignores any client-supplied connectionId and assigns a fresh
    // server-side UUID. Capture the assigned id from the 'connected' control message.
    hub.attach(
      clientWs,
      new URLSearchParams({ serverId, role: 'client', connectionId: 'c1' }),
    );

    const connected = serverWs.sent.map((s) => JSON.parse(String(s)));
    const connectedMsg = connected.find((m) => m.type === 'connected');
    assert.ok(connectedMsg && typeof connectedMsg.connectionId === 'string' && connectedMsg.connectionId.length > 0);
    const connectionId = connectedMsg.connectionId;
    // The client-supplied 'c1' must NOT be used (prevents squat/eviction).
    assert.notEqual(connectionId, 'c1');

    // S4: client frames are buffered for the data socket and must NOT be
    // forwarded to the control socket (a large frame would kill the control
    // connection and disconnect every client).
    clientWs.emit('message', 'hello-from-client', false);
    const fromClient = serverWs.sent.map((s) => JSON.parse(String(s)));
    assert.ok(
      !fromClient.some((m) => m.type === 'client_frame'),
      'client frames must not be forwarded to the control socket',
    );

    serverWs.emit(
      'message',
      JSON.stringify({ type: 'server_frame', connectionId, payload: 'hello-from-host' }),
      false,
    );
    assert.ok(clientWs.sent.includes('hello-from-host'));
  });

  it('rejects a signed server whose serverId is not derived from its key', () => {
    const kp = generateRelayAuthKeyPair();
    const pub = exportRelayAuthPublicKey(kp.publicKey);
    const issuedAt = Date.now();
    const nonce = 'nonce-squat';
    // Attacker claims a serverId that is NOT derived from their own keypair
    // (e.g. the victim's serverId seen in a QR offer).
    const foreignServerId = 'srv_attacker_claims_victim_id';
    const sig = signRelayServerAuth(
      { serverId: foreignServerId, role: 'server', connectionId: '', nonce, issuedAt },
      kp.secretKey,
    );
    const hub = new SessionHub({ allowUnsignedServer: false });
    const ws = new FakeSocket();
    hub.attach(
      ws,
      new URLSearchParams({
        serverId: foreignServerId,
        role: 'server',
        relayAuthNonce: nonce,
        relayAuthIssuedAt: String(issuedAt),
        relayAuthSig: sig,
        relayAuthPublicKeyB64: pub,
      }),
    );
    assert.equal(ws.closed?.code, 1008);
    assert.match(String(ws.closed?.reason || ''), /serverId/);
  });

  it('data socket bridges client frames raw and flushes pending', () => {
    const kp = generateRelayAuthKeyPair();
    const pub = exportRelayAuthPublicKey(kp.publicKey);
    const issuedAt = Date.now();
    const nonce = 'nonce-data-1';
    const serverId = deriveServerId(pub);
    // Control socket signs with empty connectionId (no connectionId query param).
    const ctrlSig = signRelayServerAuth(
      { serverId, role: 'server', connectionId: '', nonce, issuedAt },
      kp.secretKey,
    );

    const hub = new SessionHub({ allowUnsignedServer: false });
    const serverCtrl = new FakeSocket();
    hub.attach(
      serverCtrl,
      new URLSearchParams({
        serverId,
        role: 'server',
        relayAuthNonce: nonce,
        relayAuthIssuedAt: String(issuedAt),
        relayAuthSig: ctrlSig,
        relayAuthPublicKeyB64: pub,
      }),
    );

    const clientWs = new FakeSocket();
    hub.attach(
      clientWs,
      new URLSearchParams({ serverId, role: 'client', connectionId: 'c-d' }),
    );
    // H11: capture the relay-assigned connectionId from the 'connected' message.
    const connectedMsg = serverCtrl.sent
      .map((s) => JSON.parse(String(s)))
      .find((m) => m.type === 'connected');
    assert.ok(connectedMsg);
    const connectionId = connectedMsg.connectionId;
    assert.notEqual(connectionId, 'c-d');

    // Client sends a frame before data socket opens -> buffered for the data
    // socket; S4: it must NOT be forwarded to the control socket.
    clientWs.emit('message', 'pre-data-hello', false);
    assert.ok(
      !serverCtrl.sent.map((s) => JSON.parse(String(s))).some((m) => m.type === 'client_frame'),
      'client frames must not be forwarded to the control socket',
    );

    // Host opens data socket using the relay-assigned connectionId
    const dataSig = signRelayServerAuth(
      { serverId, role: 'server', connectionId, nonce: 'nonce-data-2', issuedAt },
      kp.secretKey,
    );
    const dataWs = new FakeSocket();
    hub.attach(
      dataWs,
      new URLSearchParams({
        serverId,
        role: 'server',
        connectionId,
        relayAuthNonce: 'nonce-data-2',
        relayAuthIssuedAt: String(issuedAt),
        relayAuthSig: dataSig,
        relayAuthPublicKeyB64: pub,
      }),
    );

    // pending frame should be flushed to data socket as raw text
    assert.ok(dataWs.sent.includes('pre-data-hello'));

    // Client frame after data socket open goes to data socket raw (not control)
    clientWs.emit('message', 'post-data-msg', false);
    assert.ok(dataWs.sent.includes('post-data-msg'));

    // Host data socket server_frame -> client
    dataWs.emit(
      'message',
      JSON.stringify({ type: 'server_frame', connectionId, payload: 'to-client' }),
      false,
    );
    assert.ok(clientWs.sent.includes('to-client'));

    // Control socket must not have been replaced
    assert.equal(serverCtrl.closed, null);
  });

  // H8: a bad-signature auth attempt must NOT consume the nonce, so the host's
  // legitimate auth with the same nonce can still succeed afterwards.
  it('does not consume nonce when the signature is invalid', () => {
    const kp = generateRelayAuthKeyPair();
    const pub = exportRelayAuthPublicKey(kp.publicKey);
    const issuedAt = Date.now();
    const nonce = 'nonce-shared';
    const serverId = deriveServerId(pub);

    const hub = new SessionHub({ allowUnsignedServer: false });

    // Attacker uses the same (public) serverId + nonce but a bogus signature.
    const bogusSig = signRelayServerAuth(
      { serverId, role: 'server', connectionId: '', nonce: 'other', issuedAt },
      kp.secretKey,
    );
    const bogusWs = new FakeSocket();
    hub.attach(
      bogusWs,
      new URLSearchParams({
        serverId,
        role: 'server',
        relayAuthNonce: nonce,
        relayAuthIssuedAt: String(issuedAt),
        relayAuthSig: bogusSig,
        relayAuthPublicKeyB64: pub,
      }),
    );
    assert.equal(bogusWs.closed?.code, 1008);

    // The legitimate host signs correctly with the same nonce and must succeed.
    const goodSig = signRelayServerAuth(
      { serverId, role: 'server', connectionId: '', nonce, issuedAt },
      kp.secretKey,
    );
    const goodWs = new FakeSocket();
    hub.attach(
      goodWs,
      new URLSearchParams({
        serverId,
        role: 'server',
        relayAuthNonce: nonce,
        relayAuthIssuedAt: String(issuedAt),
        relayAuthSig: goodSig,
        relayAuthPublicKeyB64: pub,
      }),
    );
    assert.equal(goodWs.closed, null);
  });

  // H10: the sessions Map is capped; once full, new serverIds are rejected.
  it('caps the number of sessions and rejects new serverIds beyond the cap', () => {
    const hub = new SessionHub({ allowUnsignedServer: true });
    // Fill sessions by attaching servers (allowUnsignedServer bypasses auth).
    for (let i = 0; i < 1024; i += 1) {
      const ws = new FakeSocket();
      hub.attach(ws, new URLSearchParams({ serverId: `srv_fill_${i}`, role: 'server' }));
      if (ws.closed) throw new Error(`fill attach ${i} closed unexpectedly`);
    }
    // The next serverId should be rejected (relay full).
    const overflow = new FakeSocket();
    hub.attach(overflow, new URLSearchParams({ serverId: 'srv_overflow', role: 'server' }));
    assert.equal(overflow.closed?.code, 1013);
  });

  // Shared helper: authenticated control socket + client, returns the
  // relay-assigned connectionId and signing material for data sockets.
  function setupSignedSession(hub, nonceSeed = 'n') {
    const kp = generateRelayAuthKeyPair();
    const pub = exportRelayAuthPublicKey(kp.publicKey);
    const issuedAt = Date.now();
    const serverId = deriveServerId(pub);
    const ctrlSig = signRelayServerAuth(
      { serverId, role: 'server', connectionId: '', nonce: `${nonceSeed}-ctrl`, issuedAt },
      kp.secretKey,
    );
    const serverCtrl = new FakeSocket();
    hub.attach(
      serverCtrl,
      new URLSearchParams({
        serverId,
        role: 'server',
        relayAuthNonce: `${nonceSeed}-ctrl`,
        relayAuthIssuedAt: String(issuedAt),
        relayAuthSig: ctrlSig,
        relayAuthPublicKeyB64: pub,
      }),
    );
    assert.equal(serverCtrl.closed, null);

    const clientWs = new FakeSocket();
    hub.attach(clientWs, new URLSearchParams({ serverId, role: 'client' }));
    const connectionId = serverCtrl.sent
      .map((s) => JSON.parse(String(s)))
      .find((m) => m.type === 'connected').connectionId;

    const attachData = (nonce) => {
      const sig = signRelayServerAuth(
        { serverId, role: 'server', connectionId, nonce, issuedAt },
        kp.secretKey,
      );
      const dataWs = new FakeSocket();
      hub.attach(
        dataWs,
        new URLSearchParams({
          serverId,
          role: 'server',
          connectionId,
          relayAuthNonce: nonce,
          relayAuthIssuedAt: String(issuedAt),
          relayAuthSig: sig,
          relayAuthPublicKeyB64: pub,
        }),
      );
      return dataWs;
    };

    return { serverId, serverCtrl, clientWs, connectionId, attachData };
  }

  // R9: pending frames are capped by BYTES, not only by frame count. Oldest
  // frames are evicted first once the byte budget (1 MiB) is exceeded.
  it('caps pending client frames by total bytes, dropping oldest first', () => {
    const hub = new SessionHub({ allowUnsignedServer: false });
    const { clientWs, attachData } = setupSignedSession(hub, 'nonce-bytes');

    // 3 × 400 KiB = 1.2 MiB > 1 MiB cap, but only 3 frames (far below the
    // 256-frame cap). The first frame must be evicted; the last two (800 KiB)
    // fit within the budget.
    const big = (tag) => tag + 'x'.repeat(400 * 1024);
    clientWs.emit('message', big('frame-1:'), false);
    clientWs.emit('message', big('frame-2:'), false);
    clientWs.emit('message', big('frame-3:'), false);

    const dataWs = attachData('nonce-bytes-data');
    const flushed = dataWs.sent.filter((s) => typeof s === 'string' && s.startsWith('frame-'));
    assert.deepEqual(
      flushed.map((s) => s.slice(0, 8)),
      ['frame-2:', 'frame-3:'],
      'oldest frame must be evicted once the byte cap is exceeded',
    );
  });

  // R9: a single frame larger than the whole byte budget is dropped without
  // evicting already-buffered frames.
  it('drops an oversized single frame without evicting the existing buffer', () => {
    const hub = new SessionHub({ allowUnsignedServer: false });
    const { clientWs, attachData } = setupSignedSession(hub, 'nonce-oversize');

    clientWs.emit('message', 'small-frame', false);
    clientWs.emit('message', 'huge:' + 'x'.repeat(1024 * 1024 + 1), false);

    const dataWs = attachData('nonce-oversize-data');
    assert.ok(dataWs.sent.includes('small-frame'));
    assert.ok(!dataWs.sent.some((s) => typeof s === 'string' && s.startsWith('huge:')));
  });

  // R9: when the host's data socket closes, client frames must be re-buffered
  // (not silently dropped) and flushed to the NEXT data socket the host opens.
  it('re-buffers client frames after data-socket close and flushes to the next data socket', () => {
    const hub = new SessionHub({ allowUnsignedServer: false });
    const { clientWs, attachData } = setupSignedSession(hub, 'nonce-reattach');

    const dataWs1 = attachData('nonce-reattach-d1');
    clientWs.emit('message', 'while-data-open', false);
    assert.ok(dataWs1.sent.includes('while-data-open'));

    // Host data socket drops (e.g. host reconnects). Frames sent in the gap
    // must not vanish.
    dataWs1.close(1006, 'host data socket lost');
    clientWs.emit('message', 'sent-during-gap-1', false);
    clientWs.emit('message', 'sent-during-gap-2', false);

    const dataWs2 = attachData('nonce-reattach-d2');
    assert.ok(dataWs2.sent.includes('sent-during-gap-1'), 'gap frame 1 must be flushed to the new data socket');
    assert.ok(dataWs2.sent.includes('sent-during-gap-2'), 'gap frame 2 must be flushed to the new data socket');

    // And live bridging continues on the new socket.
    clientWs.emit('message', 'after-reattach', false);
    assert.ok(dataWs2.sent.includes('after-reattach'));
  });

  // R9 guard: a stale data socket's close must NOT sever a newer data socket's
  // rewire (replacement may already have rewired the client).
  it('stale data-socket close does not break a newer data socket rewire', () => {
    const hub = new SessionHub({ allowUnsignedServer: false });
    const { clientWs, attachData } = setupSignedSession(hub, 'nonce-stale');

    const dataWs1 = attachData('nonce-stale-d1');
    const dataWs2 = attachData('nonce-stale-d2');
    // Old socket closes AFTER the replacement attached.
    dataWs1.close(1006, 'stale');

    clientWs.emit('message', 'still-live', false);
    assert.ok(dataWs2.sent.includes('still-live'), 'frames must keep flowing to the replacement data socket');
  });

  // H10: per-session client count is capped.
  it('caps concurrent clients per session', () => {
    const hub = new SessionHub({ allowUnsignedServer: true });
    const serverWs = new FakeSocket();
    hub.attach(serverWs, new URLSearchParams({ serverId: 'srv_clients', role: 'server' }));
    for (let i = 0; i < 32; i += 1) {
      const c = new FakeSocket();
      hub.attach(c, new URLSearchParams({ serverId: 'srv_clients', role: 'client' }));
      if (c.closed) throw new Error(`client ${i} closed unexpectedly`);
    }
    const extra = new FakeSocket();
    hub.attach(extra, new URLSearchParams({ serverId: 'srv_clients', role: 'client' }));
    assert.equal(extra.closed?.code, 1013);
  });
});
