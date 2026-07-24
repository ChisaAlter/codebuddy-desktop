import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKeyPair,
  exportPublicKey,
  createClientChannel,
  createHostChannelFromHello,
  buildE2eeHelloMessage,
  parseHandshakeMessage,
  signRelayServerAuth,
  verifyRelayServerAuth,
  generateRelayAuthKeyPair,
  generateHostKeyMaterial,
  loadHostE2eeKeyPair,
} from '../src/index.js';

describe('e2ee channel', () => {
  it('client and host can exchange messages', () => {
    const host = generateKeyPair();
    const { ephemeralPublicKeyB64, channel: clientCh } = createClientChannel(host.publicKey);
    const hostCh = createHostChannelFromHello(host, ephemeralPublicKeyB64);

    const hello = buildE2eeHelloMessage(ephemeralPublicKeyB64);
    assert.equal(parseHandshakeMessage(hello)?.type, 'e2ee_hello');

    const c1 = clientCh.encrypt(JSON.stringify({ type: 'ping', id: '1' }));
    const p1 = hostCh.decryptUtf8(c1);
    assert.deepEqual(JSON.parse(p1), { type: 'ping', id: '1' });

    const c2 = hostCh.encrypt(JSON.stringify({ type: 'pong', id: '1' }));
    const p2 = clientCh.decryptUtf8(c2);
    assert.deepEqual(JSON.parse(p2), { type: 'pong', id: '1' });
  });

  it('rejects replay', () => {
    const host = generateKeyPair();
    const { ephemeralPublicKeyB64, channel: clientCh } = createClientChannel(host.publicKey);
    const hostCh = createHostChannelFromHello(host, ephemeralPublicKeyB64);
    const frame = clientCh.encrypt('once');
    hostCh.decryptUtf8(frame);
    assert.throws(() => hostCh.decryptUtf8(frame), /replay|sequence/);
  });
});

describe('relay auth', () => {
  it('signs and verifies', () => {
    const kp = generateRelayAuthKeyPair();
    const fields = {
      serverId: 'srv_a',
      role: 'server',
      connectionId: '',
      nonce: 'n1',
      issuedAt: 1_700_000_000_000,
    };
    const sig = signRelayServerAuth(fields, kp.secretKey);
    assert.equal(verifyRelayServerAuth(fields, sig, kp.publicKey), true);
    assert.equal(
      verifyRelayServerAuth({ ...fields, nonce: 'other' }, sig, kp.publicKey),
      false,
    );
  });
});

describe('host key material', () => {
  it('round-trips e2ee keys', () => {
    const material = generateHostKeyMaterial();
    const kp = loadHostE2eeKeyPair(material);
    assert.equal(exportPublicKey(kp.publicKey), material.e2ee.publicKeyB64);
  });
});
