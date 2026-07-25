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
      const serverId = 'srv_host_transport_test';

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
});