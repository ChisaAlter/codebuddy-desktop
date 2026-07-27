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
  exportRelayAuthPublicKey,
  generateHostKeyMaterial,
  loadHostE2eeKeyPair,
  deriveServerId,
  generateDeviceKeyPair,
  exportDevicePublicKey,
  exportDeviceSecretKey,
  importDevicePublicKey,
  importDeviceSecretKey,
  signDeviceAuth,
  verifyDeviceAuth,
  deriveDeviceId,
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

describe('serverId derivation (H9)', () => {
  it('derives a deterministic srv_ id from the relay-auth public key', () => {
    const kp1 = generateRelayAuthKeyPair();
    const pub1 = exportRelayAuthPublicKey(kp1.publicKey);
    const id1a = deriveServerId(pub1);
    const id1b = deriveServerId(pub1);
    assert.equal(id1a, id1b, 'same key → same serverId');
    assert.ok(id1a.startsWith('srv_'), 'serverId has srv_ prefix');
    assert.ok(id1a.length > 'srv_'.length, 'serverId has a payload');
  });

  it('produces different serverIds for different keys', () => {
    const kp1 = generateRelayAuthKeyPair();
    const kp2 = generateRelayAuthKeyPair();
    const id1 = deriveServerId(exportRelayAuthPublicKey(kp1.publicKey));
    const id2 = deriveServerId(exportRelayAuthPublicKey(kp2.publicKey));
    assert.notEqual(id1, id2, 'different keys → different serverIds');
  });

  it('rejects an invalid relay-auth public key', () => {
    assert.throws(() => deriveServerId('not-a-valid-key'));
  });
});

describe('device authentication (C1/C2/H12)', () => {
  it('signs and verifies a device auth challenge', () => {
    const kp = generateDeviceKeyPair();
    const fields = {
      serverId: 'srv_x',
      deviceId: 'dev_y',
      connectionId: 'c1',
      issuedAt: 1_700_000_000_000,
    };
    const sig = signDeviceAuth(fields, kp.secretKey);
    assert.equal(verifyDeviceAuth(fields, sig, kp.publicKey), true);
    // Tampering with issuedAt must invalidate the signature.
    assert.equal(
      verifyDeviceAuth({ ...fields, issuedAt: fields.issuedAt + 1 }, sig, kp.publicKey),
      false,
    );
    // A different connectionId must invalidate.
    assert.equal(
      verifyDeviceAuth({ ...fields, connectionId: 'c-other' }, sig, kp.publicKey),
      false,
    );
  });

  it('deriveDeviceId is deterministic and unique per key', () => {
    const kp1 = generateDeviceKeyPair();
    const kp2 = generateDeviceKeyPair();
    const id1a = deriveDeviceId(kp1.publicKey);
    const id1b = deriveDeviceId(kp1.publicKey);
    const id2 = deriveDeviceId(kp2.publicKey);
    assert.equal(id1a, id1b, 'same key → same deviceId');
    assert.notEqual(id1a, id2, 'different keys → different deviceIds');
    assert.ok(id1a.startsWith('dev_'), 'deviceId has dev_ prefix');
  });

  it('export/import round-trip device keys', () => {
    const kp = generateDeviceKeyPair();
    const pubB64 = exportDevicePublicKey(kp.publicKey);
    const secB64 = exportDeviceSecretKey(kp.secretKey);
    assert.equal(importDevicePublicKey(pubB64).byteLength, kp.publicKey.byteLength);
    // Re-import and sign → verify still works.
    const pub = importDevicePublicKey(pubB64);
    const fields = { serverId: 's', deviceId: 'd', connectionId: 'c', issuedAt: 1 };
    const sig = signDeviceAuth(fields, importDeviceSecretKey(secB64));
    assert.equal(verifyDeviceAuth(fields, sig, pub), true);
  });
});
