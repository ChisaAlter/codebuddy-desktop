#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const driver = require('./e2e-driver.cjs');

const port = Number(process.argv[2] || 57466);
const outDir = path.resolve(__dirname, '..', '..', '.omo', 'user-msg-verify');

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => resolve(JSON.parse(data)));
      })
      .on('error', reject);
  });
}

async function main() {
  const list = await getJson(`http://127.0.0.1:${port}/json/list`);
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no page');
  const client = await driver.connectCdp({ ...page, debugPort: port }, { commandTimeoutMs: 60000 });

  await client.evaluate(`(() => {
    const scroller =
      document.querySelector('.page-shell > .flex-1.overflow-y-auto') ||
      document.querySelector('.flex-1.overflow-y-auto');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 400));

  const nearBottom = await client.evaluate(`(() => {
    const scroller =
      document.querySelector('.page-shell > .flex-1.overflow-y-auto') ||
      document.querySelector('.flex-1.overflow-y-auto');
    const sr = scroller.getBoundingClientRect();
    const items = [];
    for (const el of document.querySelectorAll('[data-chat-role], .execution-group, .thinking-block')) {
      const r = el.getBoundingClientRect();
      if (r.bottom > sr.top && r.top < sr.bottom && r.height > 0) {
        items.push({
          role: el.getAttribute('data-chat-role') || el.className.slice(0, 40),
          text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80),
          top: Math.round(r.top),
          h: Math.round(r.height),
        });
      }
    }
    const users = Array.from(document.querySelectorAll('[data-chat-role="user"]')).map((el) =>
      (el.textContent || '').trim(),
    );
    return {
      scrollTop: scroller.scrollTop,
      scrollH: scroller.scrollHeight,
      clientH: scroller.clientHeight,
      items,
      lastUsers: users.slice(-6),
    };
  })()`);
  console.log(JSON.stringify(nearBottom, null, 2));

  let shot = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'near-bottom.png'), Buffer.from(shot.data, 'base64'));

  const lastTyped = await client.evaluate(`(() => {
    const users = Array.from(document.querySelectorAll('[data-chat-role="user"]'));
    const typed = users.filter((el) => !(el.textContent || '').trim().toLowerCase().startsWith('/effort'));
    const last = typed[typed.length - 1];
    if (!last) return null;
    last.scrollIntoView({ block: 'center' });
    return (last.textContent || '').trim().slice(0, 80);
  })()`);
  console.log('lastTyped', lastTyped);
  await new Promise((r) => setTimeout(r, 400));
  shot = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, 'last-typed.png'), Buffer.from(shot.data, 'base64'));

  client.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
