'use strict';

// Regression tests for the adversarial-review fixes on the host:
//  - P0-4: broadcast must only reach device-authenticated connections.
//  - M3:   a pairing token must not be consumed before the pair signature verifies.
//  - P0-9: serverId is always derived from the relay-auth public key (legacy
//          random serverIds are migrated on ensureMaterial).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('url');

const cryptoPath = pathToFileURL(
  path.join(__dirname, '..', '..', '..', 'packages', 'mobile-remote-crypto', 'src', 'index.js'),
).href;

const { MobileRemoteHost } = require('../host.cjs');

async function makeHost() {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-host-test-'));
  const host = new MobileRemoteHost({ userDataPath, log: () => {} });
  host._crypto = await import(cryptoPath);
  return { host, userDataPath };
}

describe('MobileRemoteHost broadcast auth filter (P0-4)', () => {
  it('only delivers to connections that passed device_auth', async () => {
    const { host, userDataPath } = await makeHost();
    try {
      const delivered = [];
      host._transport = {
        broadcast(message, filterFn) {
          for (const connectionId of ['auth-conn', 'anon-conn']) {
            if (filterFn && !filterFn(connectionId)) continue;
            delivered.push([connectionId, message]);
          }
        },
      };
      host.authenticatedConnections.add('auth-conn');
      host.broadcast({ type: 'notify', title: 'task done' });
      assert.deepEqual(
        delivered.map(([cid]) => cid),
        ['auth-conn'],
        'anon connection (E2EE only, no device_auth) must not receive broadcasts',
      );
    } finally {
      fs.rmSync(userDataPath, { recursive: true, force: true });
    }
  });
});

describe('MobileRemoteHost pairing token consumption order (M3)', () => {
  it('does not burn the one-time token when the pair signature is invalid', async () => {
    const { host, userDataPath } = await makeHost();
    try {
      // requiresToken: the trust store is non-empty.
      const firstKp = host._crypto.generateDeviceKeyPair();
      host.devices = [
        {
          deviceId: host._crypto.deriveDeviceId(firstKp.publicKey),
          publicKeyB64: host._crypto.exportDevicePublicKey(firstKp.publicKey),
          label: 'existing',
        },
      ];
      const token = host.generatePairingToken();

      const attackerKp = host._crypto.generateDeviceKeyPair();
      const pub = host._crypto.exportDevicePublicKey(attackerKp.publicKey);
      // Valid token but a WRONG (but well-formed) signature — must not consume.
      const otherKp = host._crypto.generateDeviceKeyPair();
      const otherDeviceId = host._crypto.deriveDeviceId(otherKp.publicKey);
      const wrongSig = host._crypto.signDeviceAuth(
        { serverId: 'any', deviceId: otherDeviceId, connectionId: 'conn-1', issuedAt: Date.now() },
        otherKp.secretKey,
      );
      const res = host._pairDevice(pub, 'attacker', 'conn-1', token, wrongSig, Date.now());
      assert.equal(res.ok, false);
      assert.ok(host.activePairingTokens.has(token), 'token must survive an invalid-signature attempt');

      // A malformed (non-base64) signature must fail cleanly, not throw.
      const malformed = host._pairDevice(pub, 'attacker', 'conn-2', token, 'not-base64!!', Date.now());
      assert.equal(malformed.ok, false);
      assert.ok(host.activePairingTokens.has(token), 'token must survive a malformed-signature attempt');

      // Correct signature with the same token — now it pairs and burns the token.
      host.state.serverId = 'srv_test_host';
      const deviceId = host._crypto.deriveDeviceId(attackerKp.publicKey);
      const issuedAt = Date.now();
      const sig = host._crypto.signDeviceAuth(
        { serverId: host.state.serverId, deviceId, connectionId: 'conn-1', issuedAt },
        attackerKp.secretKey,
      );
      const good = host._pairDevice(pub, 'attacker', 'conn-1', token, sig, issuedAt);
      assert.equal(good.ok, true);
      assert.equal(good.deviceId, deviceId);
      assert.ok(!host.activePairingTokens.has(token), 'token consumed only after a valid pair');
    } finally {
      fs.rmSync(userDataPath, { recursive: true, force: true });
    }
  });
});

describe('MobileRemoteHost serverId derivation (P0-9)', () => {
  it('derives serverId from the relay-auth key on fresh material', async () => {
    const { host, userDataPath } = await makeHost();
    try {
      await host.ensureMaterial();
      const derived = host._crypto.deriveServerId(host.state.material.relayAuth.publicKeyB64);
      assert.equal(host.state.serverId, derived);
      assert.match(host.state.serverId, /^srv_/);
    } finally {
      fs.rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it('migrates a legacy random serverId to the key-derived id', async () => {
    const { host, userDataPath } = await makeHost();
    try {
      host.state.material = host._crypto.generateHostKeyMaterial();
      host.state.serverId = 'srv_legacy_random_0000000000000000';
      await host.ensureMaterial();
      const derived = host._crypto.deriveServerId(host.state.material.relayAuth.publicKeyB64);
      assert.equal(host.state.serverId, derived, 'legacy id must be replaced by the derived id');
      assert.notEqual(host.state.serverId, 'srv_legacy_random_0000000000000000');
    } finally {
      fs.rmSync(userDataPath, { recursive: true, force: true });
    }
  });
});
