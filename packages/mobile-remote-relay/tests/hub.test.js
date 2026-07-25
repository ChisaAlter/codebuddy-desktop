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
    hub.attach(
      clientWs,
      new URLSearchParams({ serverId: 'srv_1', role: 'client', connectionId: 'c1' }),
    );

    const connected = serverWs.sent.map((s) => JSON.parse(String(s)));
    assert.ok(connected.some((m) => m.type === 'connected' && m.connectionId === 'c1'));

    clientWs.emit('message', 'hello-from-client', false);
    const fromClient = serverWs.sent.map((s) => JSON.parse(String(s)));
    assert.ok(
      fromClient.some(
        (m) => m.type === 'client_frame' && m.connectionId === 'c1' && m.payload === 'hello-from-client',
      ),
    );

    serverWs.emit(
      'message',
      JSON.stringify({ type: 'server_frame', connectionId: 'c1', payload: 'hello-from-host' }),
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

    // Client sends a frame before data socket opens -> buffered + forwarded to control
    clientWs.emit('message', 'pre-data-hello', false);
    assert.ok(
      serverCtrl.sent.map((s) => JSON.parse(String(s))).some(
        (m) => m.type === 'client_frame' && m.payload === 'pre-data-hello',
      ),
    );

    // Host opens data socket
    const dataSig = signRelayServerAuth(
      { serverId: 'srv_2', role: 'server', connectionId: 'c-d', nonce: 'nonce-data-2', issuedAt },
      kp.secretKey,
    );
    const dataWs = new FakeSocket();
    hub.attach(
      dataWs,
      new URLSearchParams({
        serverId: 'srv_2',
        role: 'server',
        connectionId: 'c-d',
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
      JSON.stringify({ type: 'server_frame', connectionId: 'c-d', payload: 'to-client' }),
      false,
    );
    assert.ok(clientWs.sent.includes('to-client'));

    // Control socket must not have been replaced
    assert.equal(serverCtrl.closed, null);
  });
});
