#!/usr/bin/env node
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { SessionHub } from './session-hub.js';

const host = process.env.MOBILE_REMOTE_RELAY_HOST || '0.0.0.0';
const port = Number(process.env.MOBILE_REMOTE_RELAY_PORT || 8787);
const allowUnsignedServer =
  process.env.MOBILE_REMOTE_RELAY_ALLOW_UNSIGNED_SERVER === '1' ||
  process.env.MOBILE_REMOTE_RELAY_ALLOW_UNSIGNED_SERVER === 'true';

const hub = new SessionHub({
  allowUnsignedServer,
  log: (...args) => {
    if (process.env.MOBILE_REMOTE_RELAY_QUIET === '1') return;
    console.log(new Date().toISOString(), ...args);
  },
});

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url?.startsWith('/health?')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'codebuddy-mobile-remote-relay' }));
    return;
  }
  res.writeHead(404);
  res.end('Not Found');
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  try {
    const hostHeader = req.headers.host || `localhost:${port}`;
    const url = new URL(req.url || '/ws', `http://${hostHeader}`);
    hub.attach(ws, url.searchParams);
  } catch (err) {
    console.error('connection error', err);
    try {
      ws.close(1011, 'internal');
    } catch {
      /* ignore */
    }
  }
});

server.listen(port, host, () => {
  console.log(
    `mobile-remote relay listening on http://${host}:${port} (ws /ws, unsignedServer=${allowUnsignedServer})`,
  );
});

export { server, hub, wss };
