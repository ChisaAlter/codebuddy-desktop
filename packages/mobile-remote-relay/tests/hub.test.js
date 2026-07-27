import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
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

  it('accepts signed server and bridges client frames', () => {
    const kp = generateRelayAuthKeyPair();
    const pub = exportRelayAuthPublicKey(kp.publicKey);
    const issuedAt = Date.now();
    const nonce = 'nonce-abc';
    const fields = {
      serverId: 'srv_1',
      role: 'server',
      connectionId: '',
      nonce,
      issuedAt,
    };
    const sig = signRelayServerAuth(fields, kp.secretKey);

    const hub = new SessionHub({ allowUnsignedServer: false });
    const serverWs = new FakeSocket();
    const serverQ = new URLSearchParams({
      serverId: 'srv_1',
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
      new URLSearchParams({ serverId: 'srv_1', role: 'client', connectionId: 'c1' }),
    );

    const connected = serverWs.sent.map((s) => JSON.parse(String(s)));
    const connectedMsg = connected.find((m) => m.type === 'connected');
    assert.ok(connectedMsg && typeof connectedMsg.connectionId === 'string' && connectedMsg.connectionId.length > 0);
    const connectionId = connectedMsg.connectionId;
    // The client-supplied 'c1' must NOT be used (prevents squat/eviction).
    assert.notEqual(connectionId, 'c1');

    clientWs.emit('message', 'hello-from-client', false);
    const fromClient = serverWs.sent.map((s) => JSON.parse(String(s)));
    assert.ok(
      fromClient.some(
        (m) => m.type === 'client_frame' && m.connectionId === connectionId && m.payload === 'hello-from-client',
      ),
    );

    serverWs.emit(
      'message',
      JSON.stringify({ type: 'server_frame', connectionId, payload: 'hello-from-host' }),
      false,
    );
    assert.ok(clientWs.sent.includes('hello-from-host'));
  });

  it('data socket bridges client frames raw and flushes pending', () => {
    const kp = generateRelayAuthKeyPair();
    const pub = exportRelayAuthPublicKey(kp.publicKey);
    const issuedAt = Date.now();
    const nonce = 'nonce-data-1';
    // Control socket signs with empty connectionId (no connectionId query param).
    const ctrlSig = signRelayServerAuth(
      { serverId: 'srv_2', role: 'server', connectionId: '', nonce, issuedAt },
      kp.secretKey,
    );

    const hub = new SessionHub({ allowUnsignedServer: false });
    const serverCtrl = new FakeSocket();
    hub.attach(
      serverCtrl,
      new URLSearchParams({
        serverId: 'srv_2',
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
      new URLSearchParams({ serverId: 'srv_2', role: 'client', connectionId: 'c-d' }),
    );
    // H11: capture the relay-assigned connectionId from the 'connected' message.
    const connectedMsg = serverCtrl.sent
      .map((s) => JSON.parse(String(s)))
      .find((m) => m.type === 'connected');
    assert.ok(connectedMsg);
    const connectionId = connectedMsg.connectionId;
    assert.notEqual(connectionId, 'c-d');

    // Client sends a frame before data socket opens -> buffered + forwarded to control
    clientWs.emit('message', 'pre-data-hello', false);
    assert.ok(
      serverCtrl.sent.map((s) => JSON.parse(String(s))).some(
        (m) => m.type === 'client_frame' && m.payload === 'pre-data-hello',
      ),
    );

    // Host opens data socket using the relay-assigned connectionId
    const dataSig = signRelayServerAuth(
      { serverId: 'srv_2', role: 'server', connectionId, nonce: 'nonce-data-2', issuedAt },
      kp.secretKey,
    );
    const dataWs = new FakeSocket();
    hub.attach(
      dataWs,
      new URLSearchParams({
        serverId: 'srv_2',
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

    const hub = new SessionHub({ allowUnsignedServer: false });

    // Attacker uses the same (public) serverId + nonce but a bogus signature.
    const bogusSig = signRelayServerAuth(
      { serverId: 'srv_h8', role: 'server', connectionId: '', nonce: 'other', issuedAt },
      kp.secretKey,
    );
    const bogusWs = new FakeSocket();
    hub.attach(
      bogusWs,
      new URLSearchParams({
        serverId: 'srv_h8',
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
      { serverId: 'srv_h8', role: 'server', connectionId: '', nonce, issuedAt },
      kp.secretKey,
    );
    const goodWs = new FakeSocket();
    hub.attach(
      goodWs,
      new URLSearchParams({
        serverId: 'srv_h8',
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
