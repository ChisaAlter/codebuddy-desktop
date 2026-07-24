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
});
