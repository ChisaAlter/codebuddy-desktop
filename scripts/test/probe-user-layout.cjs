#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const driver = require('./e2e-driver.cjs');

const port = Number(process.argv[2] || 57466);
const shotPath = path.resolve(__dirname, '..', '..', '.omo', 'user-msg-verify', 'after-dismiss-typed.png');

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on('error', reject);
  });
}

async function main() {
  const list = await getJson(`http://127.0.0.1:${port}/json/list`);
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no page target');
  const client = await driver.connectCdp({ ...page, debugPort: port }, { commandTimeoutMs: 60000 });

  const clicked = await client.evaluate(`(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const start = buttons.find((b) => /开始使用|稍后继续/.test(b.textContent || ''));
    if (start) start.click();
    return start ? String(start.textContent || '').trim() : null;
  })()`);
  console.log('clicked', clicked);
  await new Promise((r) => setTimeout(r, 1000));

  const layout = await client.evaluate(`(() => {
    const scroller =
      document.querySelector('.page-shell > .flex-1.overflow-y-auto') ||
      document.querySelector('.flex-1.overflow-y-auto');
    const users = Array.from(document.querySelectorAll('[data-chat-role="user"]'));
    const sr = scroller ? scroller.getBoundingClientRect() : null;
    const userInfo = users.map((el, i) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const inner = el.firstElementChild;
      const is = inner ? getComputedStyle(inner) : null;
      const text = (el.textContent || '').trim();
      return {
        i,
        text: text.slice(0, 50),
        effort: text.toLowerCase().startsWith('/effort'),
        top: Math.round(r.top),
        left: Math.round(r.left),
        w: Math.round(r.width),
        h: Math.round(r.height),
        display: s.display,
        visibility: s.visibility,
        opacity: s.opacity,
        bg: is?.backgroundColor || null,
        color: is?.color || null,
        inScrollerView: !!(
          sr &&
          r.bottom > sr.top &&
          r.top < sr.bottom &&
          r.height > 0
        ),
      };
    });
    return {
      userCount: users.length,
      assistantCount: document.querySelectorAll('[data-chat-role="assistant"]').length,
      dialogOpen: (document.body.innerText || '').includes('检查 CodeBuddy CLI'),
      scroller: scroller
        ? {
            clientH: scroller.clientHeight,
            scrollH: scroller.scrollHeight,
            scrollTop: scroller.scrollTop,
            innerH: scroller.firstElementChild ? scroller.firstElementChild.scrollHeight : null,
            childCount: scroller.children.length,
            top: sr ? Math.round(sr.top) : null,
            bottom: sr ? Math.round(sr.bottom) : null,
          }
        : null,
      inView: userInfo.filter((u) => u.inScrollerView).map((u) => ({ i: u.i, text: u.text, top: u.top })),
      typed: userInfo
        .filter((u) => !u.effort)
        .map((u) => ({ i: u.i, text: u.text, top: u.top, h: u.h, inView: u.inScrollerView, bg: u.bg })),
      effort: userInfo
        .filter((u) => u.effort)
        .map((u) => ({ i: u.i, text: u.text, top: u.top, h: u.h, inView: u.inScrollerView, bg: u.bg })),
    };
  })()`);
  console.log('layout', JSON.stringify(layout, null, 2));

  const scrolled = await client.evaluate(`(() => {
    const scroller =
      document.querySelector('.page-shell > .flex-1.overflow-y-auto') ||
      document.querySelector('.flex-1.overflow-y-auto');
    const users = Array.from(document.querySelectorAll('[data-chat-role="user"]'));
    const typed = users.find((el) => !(el.textContent || '').trim().toLowerCase().startsWith('/effort'));
    if (!typed) return { ok: false, reason: 'no-typed' };
    typed.scrollIntoView({ block: 'center' });
    const r = typed.getBoundingClientRect();
    return {
      ok: true,
      text: (typed.textContent || '').trim().slice(0, 60),
      top: Math.round(r.top),
      h: Math.round(r.height),
      scrollTop: scroller ? scroller.scrollTop : null,
      scrollH: scroller ? scroller.scrollHeight : null,
      clientH: scroller ? scroller.clientHeight : null,
    };
  })()`);
  console.log('scrolled', scrolled);
  await new Promise((r) => setTimeout(r, 400));

  const shot = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.dirname(shotPath), { recursive: true });
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  console.log('shot', shotPath);

  client.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
