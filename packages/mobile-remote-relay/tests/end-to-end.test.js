import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { once } from 'node:events';
import {
  parseConnectionOfferFromUrl,
  buildRelayWebSocketUrl,
  encodeConnectionOfferToUrl,
} from '@codebuddy/mobile-remote-protocol';
import {
  importPublicKey,
  createClientChannel,
  createHostChannelFromHello,
  parseHandshakeMessage,
  buildE2eeHelloMessage,
  buildE2eeReadyMessage,
  exportPublicKey,
  exportRelayAuthPublicKey,
  generateKeyPair,
} from '@codebuddy/mobile-remote-crypto';
import { WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const relayServerPath = path.join(__dirname, '..', 'src', 'server.js');

async function startRelay() {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [relayServerPath], {
    env: {
      ...process.env,
      MOBILE_REMOTE_RELAY_HOST: '127.0.0.1',
      MOBILE_REMOTE_RELAY_PORT: String(port),
      MOBILE_REMOTE_RELAY_ALLOW_UNSIGNED_SERVER: '1',
      MOBILE_REMOTE_RELAY_QUIET: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await once(child.stdout, 'data');
  return { port, child };
}

const open = (ws) => once(ws, 'open');

describe('end-to-end: client -> relay -> host with E2EE', () => {
  it('routes an encrypted ping/pong through the relay', async () => {
    const relay = await startRelay();
    try {
      const hostE2ee = generateKeyPair();
      const hostAuth = generateKeyPair();
      const serverId = 'srv_e2e_test';

      const offerUrl = encodeConnectionOfferToUrl({
        v: 1,
        serverId,
        hostPublicKeyB64: exportPublicKey(hostE2ee.publicKey),
        relayAuthPublicKeyB64: exportRelayAuthPublicKey(hostAuth.publicKey),
        relay: { endpoint: `127.0.0.1:${relay.port}`, useTls: false },
      });
      const offer = parseConnectionOfferFromUrl(offerUrl);

      // Host control socket
      const hostControl = new WebSocket(
        buildRelayWebSocketUrl({
          endpoint: `127.0.0.1:${relay.port}`,
          useTls: false,
          serverId,
          role: 'server',
        }),
      );
      await open(hostControl);

      const controlFrames = [];
      hostControl.on('message', (d) => controlFrames.push(JSON.parse(d.toString())));

      // Client socket
      const clientWs = new WebSocket(
        buildRelayWebSocketUrl({
          endpoint: `127.0.0.1:${relay.port}`,
          useTls: false,
          serverId,
          role: 'client',
          connectionId: 'c-e2e',
        }),
      );
      await open(clientWs);

      // wait for "connected"
      const start = Date.now();
      while (!controlFrames.some((m) => m.type === 'connected' && m.connectionId === 'c-e2e')) {
        if (Date.now() - start > 3000) throw new Error('no connected frame');
        await new Promise((r) => setTimeout(r, 20));
      }

      // Host opens a data socket for that client
      const hostData = new WebSocket(
        buildRelayWebSocketUrl({
          endpoint: `127.0.0.1:${relay.port}`,
          useTls: false,
          serverId,
          role: 'server',
          connectionId: 'c-e2e',
        }),
      );
      await open(hostData);

      // Client receives raw payloads (relay unwraps server_frame before delivery).
      const clientFrames = [];
      clientWs.on('message', (d) => clientFrames.push(d.toString()));

      let hostChannel = null;
      hostData.on('message', (data, isBinary) => {
        if (isBinary) return;
        // Relay forwards client frames to the host data socket as raw payload
        // (it only wraps client_frame when forwarding to the *control* socket).
        const innerText = data.toString();

        if (!hostChannel) {
          const msg = parseHandshakeMessage(innerText);
          if (msg?.type === 'e2ee_hello' && msg.publicKeyB64) {
            hostChannel = createHostChannelFromHello(hostE2ee, msg.publicKeyB64);
            hostData.send(
              JSON.stringify({ type: 'server_frame', connectionId: 'c-e2e', payload: buildE2eeReadyMessage() }),
            );
          }
          return;
        }
        const plain = hostChannel.decryptUtf8(innerText);
        const op = JSON.parse(plain);
        const resp = { type: 'pong', id: op.id };
        hostData.send(
          JSON.stringify({ type: 'server_frame', connectionId: 'c-e2e', payload: hostChannel.encrypt(JSON.stringify(resp)) }),
        );
      });

      // Client E2EE
      const hostPub = importPublicKey(offer.hostPublicKeyB64);
      const { ephemeralPublicKeyB64, channel: clientCh } = createClientChannel(hostPub);
      clientWs.send(buildE2eeHelloMessage(ephemeralPublicKeyB64));

      // wait for ready (raw e2ee_ready delivered to client)
      const waitReady = async (timeoutMs = 4000) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          for (const f of clientFrames) {
            const parsed = parseHandshakeMessage(f);
            if (parsed?.type === 'e2ee_ready') return true;
          }
          await new Promise((r) => setTimeout(r, 20));
        }
        return false;
      };
      assert.ok(await waitReady(), 'expected e2ee_ready delivered to client');

      // Send encrypted ping
      clientWs.send(clientCh.encrypt(JSON.stringify({ type: 'ping', id: 'p1' })));

      // Wait for encrypted pong (raw payload)
      const pongStart = Date.now();
      let pong = null;
      while (Date.now() - pongStart < 3000) {
        for (const f of clientFrames) {
          const parsed = parseHandshakeMessage(f);
          if (parsed) continue; // plaintext handshake
          try {
            const decoded = JSON.parse(clientCh.decryptUtf8(f));
            if (decoded.type === 'pong' && decoded.id === 'p1') {
              pong = decoded;
              break;
            }
          } catch {
            /* not for us */
          }
        }
        if (pong) break;
        await new Promise((r) => setTimeout(r, 20));
      }

      assert.ok(pong, 'expected encrypted pong frame');
      assert.equal(pong.type, 'pong');
      assert.equal(pong.id, 'p1');

      clientWs.close();
      hostData.close();
      hostControl.close();
    } finally {
      relay.child.kill('SIGTERM');
    }
  });
});