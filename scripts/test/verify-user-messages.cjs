#!/usr/bin/env node
'use strict';

/**
 * Launch packaged desktop against a copy of real product-state (or real userData),
 * then report which user bubbles are in the DOM and whether non-/effort ones exist.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const driver = require('./e2e-driver.cjs');

const projectRoot = path.resolve(__dirname, '..', '..');
const executable = path.join(projectRoot, 'dist', 'win-unpacked', 'CodeBuddy Desktop.exe');
const realUserData = path.join(process.env.APPDATA || '', 'codebuddy-gui');
const runStamp = `user-msg-verify-${Date.now()}`;
const runtimeOwnership = driver.createRuntimeLayout({ projectRoot, runStamp, label: 'user-msg' });
const { runtimeRoot, runtimeDir, userDataDir } = runtimeOwnership;
const shotDir = path.join(projectRoot, '.omo', 'user-msg-verify');

function countUsersInTimeline(timeline) {
  if (!Array.isArray(timeline)) return 0;
  return timeline.filter((item) => item?.type === 'message' && item?.role === 'user').length;
}

function isEffortOnly(text) {
  return /^\/effort\b/i.test(String(text || '').trim());
}

async function main() {
  if (!fs.existsSync(executable)) throw new Error(`Missing packaged exe: ${executable}`);
  const srcState = path.join(realUserData, 'product-state.json');
  if (!fs.existsSync(srcState)) throw new Error(`Missing real product-state: ${srcState}`);

  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(shotDir, { recursive: true });
  const dstState = path.join(userDataDir, 'product-state.json');
  fs.copyFileSync(srcState, dstState);

  const disk = JSON.parse(fs.readFileSync(dstState, 'utf8'));
  const activeThread = disk.threadsById?.[disk.activeThreadId];
  const diskUsers = (activeThread?.timeline || []).filter(
    (item) => item?.type === 'message' && item?.role === 'user',
  );
  const expectedUsers = diskUsers.length;
  const expectedTyped = diskUsers.filter((u) => !isEffortOnly(u.content)).length;
  console.log(
    JSON.stringify(
      {
        userData: userDataDir,
        activeThreadId: disk.activeThreadId,
        diskTimelineLen: activeThread?.timeline?.length || 0,
        expectedUsers,
        expectedTyped,
        sampleTyped: diskUsers
          .filter((u) => !isEffortOnly(u.content))
          .slice(0, 5)
          .map((u) => String(u.content).slice(0, 40)),
      },
      null,
      2,
    ),
  );

  spawnSync('taskkill', ['/F', '/IM', 'CodeBuddy Desktop.exe'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));

  let launched = null;
  let client = null;
  try {
    launched = await driver.launchDesktop({
      executable,
      projectRoot,
      userDataDir,
      runtimeRoot,
      runtimeDir,
      runtimeOwnership,
      env: { CODEBUDDY_GUI_E2E: '1' },
    });
    console.log('launched', { debugPort: launched.debugPort });

    const startupLog = path.join(userDataDir, 'electron-startup.log');
    const startupDeadline = Date.now() + 90000;
    while (Date.now() < startupDeadline) {
      if (fs.existsSync(startupLog)) {
        const text = fs.readFileSync(startupLog, 'utf8');
        if (/renderer ready=true/.test(text) && /runtime ready project=/.test(text)) break;
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    // Give hydrate + history a moment after runtime ready.
    await new Promise((r) => setTimeout(r, 4000));

    const target = await driver.findRendererTarget({
      port: launched.debugPort,
      expectedUrl: /index\.html/,
      timeoutMs: 45000,
    });
    client = await driver.connectCdp(target, { commandTimeoutMs: 60000 });

    // Wait for either user bubbles or a settled chat shell.
    await driver.waitForRendererValue(
      client,
      `(() => ({
        users: document.querySelectorAll('[data-chat-role="user"]').length,
        composer: !!document.querySelector('[role="textbox"], textarea'),
        body: (document.body?.innerText || '').length
      }))()`,
      {
        timeoutMs: 60000,
        predicate: (v) => v && (v.users > 0 || (v.composer && v.body > 50)),
      },
    );

    // Re-probe a few times after session/load may rewrite timeline.
    let probe = null;
    for (let i = 0; i < 12; i += 1) {
      probe = await client.evaluate(`(() => {
        const nodes = Array.from(document.querySelectorAll('[data-chat-role="user"]'));
        const users = nodes.map((el, index) => {
          const text = (el.textContent || '').trim();
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          const inner = el.querySelector('div');
          const innerStyle = inner ? window.getComputedStyle(inner) : null;
          return {
            index,
            text: text.slice(0, 80),
            isEffort: text.trim().toLowerCase().startsWith('/effort'),
            height: Math.round(rect.height),
            width: Math.round(rect.width),
            top: Math.round(rect.top),
            visible:
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              Number(style.opacity || '1') > 0 &&
              rect.height > 0 &&
              rect.width > 0,
            bg: innerStyle?.backgroundColor || style.backgroundColor,
            color: innerStyle?.color || style.color,
          };
        });
        const typed = users.filter((u) => !u.isEffort);
        const effort = users.filter((u) => u.isEffort);
        const scroller = document.querySelector('.flex-1.overflow-y-auto');
        return {
          hash: location.hash,
          total: users.length,
          typed: typed.length,
          effort: effort.length,
          typedSamples: typed.slice(0, 8).map((u) => u.text),
          effortSamples: effort.map((u) => u.text),
          invisible: users.filter((u) => !u.visible).length,
          zeroHeight: users.filter((u) => u.height === 0).length,
          scroll: scroller
            ? {
                top: Math.round(scroller.scrollTop),
                height: Math.round(scroller.scrollHeight),
                client: Math.round(scroller.clientHeight),
              }
            : null,
          users,
        };
      })()`);
      if (probe && probe.typed > 0) break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Scroll to top and capture; then bottom.
    await client.evaluate(`(() => {
      const scroller = document.querySelector('.flex-1.overflow-y-auto');
      if (scroller) scroller.scrollTop = 0;
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 500));
    let shot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shotDir, 'top.png'), Buffer.from(shot.data, 'base64'));

    await client.evaluate(`(() => {
      const scroller = document.querySelector('.flex-1.overflow-y-auto');
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 500));
    shot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shotDir, 'bottom.png'), Buffer.from(shot.data, 'base64'));

    // Scroll until first typed user is in view (if any).
    const firstTyped = (probe?.users || []).find((u) => !u.isEffort);
    if (firstTyped) {
      await client.evaluate(`(() => {
        const nodes = Array.from(document.querySelectorAll('[data-chat-role="user"]'));
        const target = nodes.find((el) => !(el.textContent||'').trim().toLowerCase().startsWith('/effort'));
        target?.scrollIntoView({ block: 'center' });
        return target ? (target.textContent || '').trim().slice(0, 80) : null;
      })()`);
      await new Promise((r) => setTimeout(r, 400));
      shot = await client.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(shotDir, 'typed-user.png'), Buffer.from(shot.data, 'base64'));
    }

    console.log('probe', JSON.stringify({
      total: probe?.total,
      typed: probe?.typed,
      effort: probe?.effort,
      typedSamples: probe?.typedSamples,
      effortSamples: probe?.effortSamples,
      invisible: probe?.invisible,
      zeroHeight: probe?.zeroHeight,
      scroll: probe?.scroll,
    }, null, 2));
    console.log('shots', shotDir);

    const ok = probe && probe.typed > 0 && probe.invisible === 0;
    if (ok) {
      console.log(`PASS typed user bubbles visible: ${probe.typed}/${expectedTyped} (effort=${probe.effort})`);
      process.exitCode = 0;
    } else if (probe && probe.total > 0 && probe.typed === 0) {
      console.log(`FAIL only effort/system-like user bubbles: total=${probe.total} typed=0`);
      process.exitCode = 2;
    } else {
      console.log(`FAIL user bubbles missing: total=${probe?.total || 0} typed=${probe?.typed || 0}`);
      process.exitCode = 1;
    }
  } finally {
    try {
      client?.close?.();
    } catch (_) {}
    try {
      if (launched) await driver.cleanupOwned(launched);
    } catch (error) {
      console.error('cleanupOwned failed', error.message);
      spawnSync('taskkill', ['/F', '/IM', 'CodeBuddy Desktop.exe'], { stdio: 'ignore' });
    }
  }
}

main().catch((error) => {
  console.error('VERIFY FAIL', error);
  process.exitCode = 1;
});
