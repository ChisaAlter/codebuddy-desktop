'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { pathToFileURL } = require('url');

const relayServerPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'packages',
  'mobile-remote-relay',
  'src',
  'server.js',
);

const protocolPath = pathToFileURL(
  path.join(__dirname, '..', '..', '..', 'packages', 'mobile-remote-protocol', 'src', 'index.js'),
).href;
const cryptoPath = pathToFileURL(
  path.join(__dirname, '..', '..', '..', 'packages', 'mobile-remote-crypto', 'src', 'index.js'),
).href;

async function startRelay() {
  const port = 19000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [relayServerPath], {
    env: {
      ...process.env,
      MOBILE_REMOTE_RELAY_HOST: '127.0.0.1',
      MOBILE_REMOTE_RELAY_PORT: String(port),
      MOBILE_REMOTE_RELAY_ALLOW_UNSIGNED_SERVER: '1',
      MOBILE_REMOTE_RELAY_QUIET: '1',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await once(child.stdout, 'data');
  return { port, child };
}

describe('Host transport.cjs + bridge echo via relay', () => {
  it('host transport serves an op via the real relay', async () => {
    const { port, child } = await startRelay();
    const [protocol, crypto, { WebSocket }] = await Promise.all([
      import(protocolPath),
      import(cryptoPath),
      import('ws'),
    ]);
    const { startHostRelayTransport } = require('../transport.cjs');

    try {
      const hostE2ee = crypto.generateKeyPair();
      const hostAuth = crypto.generateRelayAuthKeyPair();
      // H9: relay requires the serverId to be derived from the relay-auth key.
      const serverId = crypto.deriveServerId(crypto.exportRelayAuthPublicKey(hostAuth.publicKey));

      let receivedOp = null;
      const transport = await startHostRelayTransport({
        endpoint: `127.0.0.1:${port}`,
        useTls: false,
        serverId,
        e2eeKeyPair: hostE2ee,
        relayAuthKeyPair: hostAuth,
        log: () => {},
        handlers: {
          onClientReady: async () => {},
          onClientMessage: async (client, plaintext) => {
            receivedOp = JSON.parse(plaintext);
            // echo pong
            transport.sendToClient(client, { type: 'pong', id: receivedOp.id });
          },
        },
      });

      // Wait for control to be online
      const ctrlStart = Date.now();
      while (!transport.getStats().controlOnline && Date.now() - ctrlStart < 3000) {
        await new Promise((r) => setTimeout(r, 30));
      }
      assert.ok(transport.getStats().controlOnline, 'host control should be online');

      // Build offer the way host.cjs would
      const offerUrl = protocol.encodeConnectionOfferToUrl({
        v: 1,
        serverId,
        hostPublicKeyB64: crypto.exportPublicKey(hostE2ee.publicKey),
        relayAuthPublicKeyB64: crypto.exportRelayAuthPublicKey(hostAuth.publicKey),
        relay: { endpoint: `127.0.0.1:${port}`, useTls: false },
      });
      const offer = protocol.parseConnectionOfferFromUrl(offerUrl);

      // Client connects
      const clientWs = new WebSocket(
        protocol.buildRelayWebSocketUrl({
          endpoint: `127.0.0.1:${port}`,
          useTls: false,
          serverId,
          role: 'client',
          connectionId: 'c-host-test',
        }),
      );
      await once(clientWs, 'open');

      const clientFrames = [];
      clientWs.on('message', (d) => clientFrames.push(d.toString()));

      // Give relay time to notify host + host to open data socket
      const readyStart = Date.now();
      while (Date.now() - readyStart < 4000) {
        // client-side E2EE hello once we see host data socket is reachable (just send)
        if (clientWs.readyState === 1) break;
        await new Promise((r) => setTimeout(r, 20));
      }

      const hostPub = crypto.importPublicKey(offer.hostPublicKeyB64);
      const { ephemeralPublicKeyB64, channel: clientCh } = crypto.createClientChannel(hostPub);
      clientWs.send(crypto.buildE2eeHelloMessage(ephemeralPublicKeyB64));

      // Wait for e2ee_ready (relay unwraps server_frame and delivers raw payload
      // to the client).
      const waitReady = async (timeoutMs = 4000) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          for (const f of clientFrames) {
            const parsed = crypto.parseHandshakeMessage(f);
            if (parsed?.type === 'e2ee_ready') return true;
          }
          await new Promise((r) => setTimeout(r, 20));
        }
        return false;
      };
      assert.ok(await waitReady(), 'expected e2ee_ready delivered to client');

      // Send encrypted ping
      clientWs.send(clientCh.encrypt(JSON.stringify({ type: 'ping', id: 'p-host' })));

      // Wait for encrypted pong (relay delivers raw payload to client).
      const pongStart = Date.now();
      let pong = null;
      while (Date.now() - pongStart < 4000) {
        for (const f of clientFrames) {
          const parsed = crypto.parseHandshakeMessage(f);
          if (parsed) continue; // plaintext handshake
          try {
            const decoded = JSON.parse(clientCh.decryptUtf8(f));
            if (decoded.type === 'pong' && decoded.id === 'p-host') {
              pong = decoded;
              break;
            }
          } catch {
            /* ignore */
          }
        }
        if (pong) break;
        await new Promise((r) => setTimeout(r, 20));
      }

      assert.ok(pong, 'expected encrypted pong via server_frame');
      assert.equal(pong.type, 'pong');
      assert.equal(pong.id, 'p-host');
      assert.equal(receivedOp?.type, 'ping');

      clientWs.close();
      await transport.stop();
    } finally {
      child.kill('SIGTERM');
    }
  });

  // C1: end-to-end device_pair → privileged op. A client with no prior pairing
  // sends device_pair (empty trust store, no token needed). The host bridge's
  // pairDevice verifies the client's signed challenge against the presented
  // public key, derives deviceId, marks the connection authenticated, and the
  // subsequent list_projects op succeeds (instead of auth_required).
  it('device_pair authenticates the connection so privileged ops succeed', async () => {
    const { port, child } = await startRelay();
    const [protocol, crypto, { WebSocket }] = await Promise.all([
      import(protocolPath),
      import(cryptoPath),
      import('ws'),
    ]);
    const { startHostRelayTransport } = require('../transport.cjs');
    const { createBridge } = require('../bridge.cjs');

    try {
      const hostE2ee = crypto.generateKeyPair();
      const hostAuth = crypto.generateRelayAuthKeyPair();
      // H9: relay requires the serverId to be derived from the relay-auth key.
      const serverId = crypto.deriveServerId(crypto.exportRelayAuthPublicKey(hostAuth.publicKey));

      // Host bridge with a real pairDevice dep that verifies the client signature
      // and stores the device (empty trust store → first device pairs free).
      const devices = [];
      const authenticatedConnections = new Set();
      const bridge = createBridge({
        net: { fetch: async () => ({ ok: false, status: 404 }) },
        runtimeManager: { list: () => [], ensure: async () => ({ port: 0, status: 'error' }) },
        getProductState: () => ({
          projectsById: { p1: { name: 'Proj', workspacePath: '/x' } },
          projectOrder: ['p1'],
          threadsById: {},
          threadOrderByProject: {},
        }),
        registerDevice: () => ({ ok: true }),
        listDevices: () => devices.map((d) => ({ deviceId: d.deviceId, label: d.label })),
        revokeDevice: () => ({ ok: true, revoked: true }),
        authenticateDevice: ({ deviceId, connectionId, signedChallenge, issuedAt }) => {
          const dev = devices.find((d) => d.deviceId === deviceId);
          if (!dev) return { ok: false, error: 'unknown device' };
          const skew = Math.abs(Date.now() - Number(issuedAt));
          if (skew > 60000) return { ok: false, error: 'issuedAt out of range' };
          const valid = crypto.verifyDeviceAuth(
            { serverId, deviceId, connectionId, issuedAt: Number(issuedAt) },
            signedChallenge,
            crypto.importDevicePublicKey(dev.publicKeyB64),
          );
          if (!valid) return { ok: false, error: 'auth_failed' };
          return { ok: true };
        },
        pairDevice: ({ publicKeyB64, connectionId, signedChallenge, issuedAt }) => {
          const pub = crypto.importDevicePublicKey(publicKeyB64);
          const deviceId = crypto.deriveDeviceId(pub);
          const skew = Math.abs(Date.now() - Number(issuedAt));
          if (skew > 60000) return { ok: false, error: 'issuedAt out of range' };
          const valid = crypto.verifyDeviceAuth(
            { serverId, deviceId, connectionId, issuedAt: Number(issuedAt) },
            signedChallenge,
            pub,
          );
          if (!valid) return { ok: false, error: 'pair signature verification failed' };
          devices.push({ deviceId, publicKeyB64, label: 'Test' });
          return { ok: true, deviceId };
        },
        log: () => {},
      });

      const transport = await startHostRelayTransport({
        endpoint: `127.0.0.1:${port}`,
        useTls: false,
        serverId,
        e2eeKeyPair: hostE2ee,
        relayAuthKeyPair: hostAuth,
        log: () => {},
        handlers: {
          onClientReady: async (client) => {
            // C1: send the relay-assigned connectionId so the client can sign with it.
            try {
              client.ws.send(JSON.stringify({
                type: 'server_frame',
                connectionId: client.connectionId,
                payload: client.channel.encrypt(JSON.stringify({
                  type: 'connected',
                  connectionId: client.connectionId,
                  serverId,
                })),
              }));
            } catch (_) {}
          },
          onClientMessage: async (client, plaintext) => {
            let op;
            try { op = JSON.parse(plaintext); } catch { return; }
            const ctx = {
              send: (message) => {
                if (!client.channel || !client.ready) return;
                const bundle = client.channel.encrypt(JSON.stringify(message));
                try {
                  client.ws.send(JSON.stringify({
                    type: 'server_frame',
                    connectionId: client.connectionId,
                    payload: bundle,
                  }));
                } catch (_) {}
              },
              connectionId: client.connectionId,
              authenticated: authenticatedConnections.has(client.connectionId),
              deviceId: null,
            };
            await bridge.dispatch(ctx, op);
            // Track authenticated connections so subsequent ops on this ctx pass.
            if (ctx.authenticated) authenticatedConnections.add(client.connectionId);
          },
          onClientClose: () => {},
        },
      });

      // Wait for control to be online
      const ctrlStart = Date.now();
      while (!transport.getStats().controlOnline && Date.now() - ctrlStart < 3000) {
        await new Promise((r) => setTimeout(r, 30));
      }
      assert.ok(transport.getStats().controlOnline, 'host control should be online');

      // Client connects
      const clientWs = new WebSocket(
        protocol.buildRelayWebSocketUrl({
          endpoint: `127.0.0.1:${port}`,
          useTls: false,
          serverId,
          role: 'client',
        }),
      );
      await once(clientWs, 'open');

      const clientFrames = [];
      clientWs.on('message', (d) => clientFrames.push(d.toString()));

      const hostPub = hostE2ee.publicKey;
      const { ephemeralPublicKeyB64, channel: clientCh } = crypto.createClientChannel(hostPub);
      clientWs.send(crypto.buildE2eeHelloMessage(ephemeralPublicKeyB64));

      // Wait for e2ee_ready
      const waitReady = async (timeoutMs = 4000) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          for (const f of clientFrames) {
            const parsed = crypto.parseHandshakeMessage(f);
            if (parsed?.type === 'e2ee_ready') return true;
          }
          await new Promise((r) => setTimeout(r, 20));
        }
        return false;
      };
      assert.ok(await waitReady(), 'expected e2ee_ready');

      // Wait for the encrypted 'connected' message carrying the connectionId.
      const waitConnected = async (timeoutMs = 4000) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          for (const f of clientFrames) {
            if (crypto.parseHandshakeMessage(f)) continue;
            try {
              const decoded = JSON.parse(clientCh.decryptUtf8(f));
              if (decoded.type === 'connected' && decoded.connectionId) return decoded;
            } catch { /* ignore */ }
          }
          await new Promise((r) => setTimeout(r, 20));
        }
        return null;
      };
      const connected = await waitConnected();
      assert.ok(connected, 'expected encrypted connected frame');
      const connectionId = connected.connectionId;

      // Client generates its device keypair and signs the device-pair challenge.
      const deviceKp = crypto.generateDeviceKeyPair();
      const deviceId = crypto.deriveDeviceId(deviceKp.publicKey);
      const issuedAt = Date.now();
      const sig = crypto.signDeviceAuth(
        { serverId, deviceId, connectionId, issuedAt },
        deviceKp.secretKey,
      );
      clientWs.send(clientCh.encrypt(JSON.stringify({
        type: 'device_pair',
        id: 'pair-1',
        publicKeyB64: crypto.exportDevicePublicKey(deviceKp.publicKey),
        label: 'Test Device',
        signedChallenge: sig,
        issuedAt,
      })));

      // Wait for device_paired ack.
      const waitPaired = async (timeoutMs = 4000) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          for (const f of clientFrames) {
            if (crypto.parseHandshakeMessage(f)) continue;
            try {
              const decoded = JSON.parse(clientCh.decryptUtf8(f));
              if (decoded.type === 'device_paired' && decoded.ok) return decoded;
            } catch { /* ignore */ }
          }
          await new Promise((r) => setTimeout(r, 20));
        }
        return null;
      };
      const paired = await waitPaired();
      assert.ok(paired, 'expected device_paired');
      assert.equal(paired.deviceId, deviceId);

      // Now send a privileged op (list_projects) — must succeed post-auth.
      clientWs.send(clientCh.encrypt(JSON.stringify({ type: 'list_projects', id: 'lp' })));
      const waitProjects = async (timeoutMs = 4000) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          for (const f of clientFrames) {
            if (crypto.parseHandshakeMessage(f)) continue;
            try {
              const decoded = JSON.parse(clientCh.decryptUtf8(f));
              if (decoded.type === 'projects') return decoded;
            } catch { /* ignore */ }
          }
          await new Promise((r) => setTimeout(r, 20));
        }
        return null;
      };
      const projects = await waitProjects();
      assert.ok(projects, 'expected projects response after authentication');
      assert.equal(projects.projects[0].projectId, 'p1');

      // And an unauthenticated-only op like ping still works.
      clientWs.close();
      await transport.stop();
    } finally {
      child.kill('SIGTERM');
    }
  });
});