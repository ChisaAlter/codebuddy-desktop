#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  captureScreenshot,
  cleanupOwned,
  cleanupRuntimeDir,
  connectCdp,
  createRuntimeLayout,
  createSingleFinalizer,
  findRendererTarget,
  launchDesktop,
  seedProductState,
  waitForRendererValue,
  driveByRole,
} = require('./e2e-driver.cjs');

const projectRoot = path.resolve(__dirname, '..', '..');
const electronExe = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const shotDir = path.join(projectRoot, 'gui-test-screenshots', 'plugins-parity');
const runStamp = `plugins-gui-${Date.now()}`;
const runtime = createRuntimeLayout({ projectRoot, runStamp, label: 'plugins-gui' });

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function main() {
  ensureDir(shotDir);
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok: Boolean(ok), detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
    return Boolean(ok);
  };

  let launched = null;
  let client = null;
  const finalize = createSingleFinalizer(async () => {
    try { if (client?.close) await client.close(); } catch (_) {}
    if (launched) {
      try { await cleanupOwned({
          rootPid: launched.rootPid,
          trackedProcesses: launched.rootIdentity ? [launched.rootIdentity] : [],
        }); } catch (error) {
        console.warn('cleanupOwned warning:', error?.message || error);
      }
    }
    try {
      await cleanupRuntimeDir(runtime);
    } catch (error) {
      console.warn('cleanupRuntimeDir warning:', error?.message || error);
    }
  });

  try {
    fs.mkdirSync(runtime.userDataDir, { recursive: true });
    seedProductState({ userDataDir: runtime.userDataDir, projectRoot });
    launched = await launchDesktop({
      executable: electronExe,
      appArgs: ['.'],
      projectRoot,
      userDataDir: runtime.userDataDir,
      runtimeRoot: runtime.runtimeRoot,
      runtimeDir: runtime.runtimeDir,
      runtimeOwnership: runtime,
      env: {
        ELECTRON_ENABLE_LOGGING: '1',
      },
    });
    const debugPort = Number(launched?.debugPort);
    check('launchDesktop', Number.isInteger(debugPort), `cdp=${debugPort || 'none'}`);
    if (launched?.process) {
      launched.process.stdout?.on('data', (chunk) => console.log(`[electron] ${String(chunk).trim()}`));
      launched.process.stderr?.on('data', (chunk) => console.log(`[electron:err] ${String(chunk).trim()}`));
    }

    const target = await findRendererTarget({
      port: debugPort,
      expectedUrl: (url) =>
        /^http:\/\/(?:localhost:5173|127\.0\.0\.1:\d+\/index\.html)/.test(String(url || '')),
      timeoutMs: 60000,
    });
    client = await connectCdp(target, { commandTimeoutMs: 60000 });
    await client.send('Page.enable');
    await client.send('Runtime.enable');

    // Wait for app shell, then force plugins route.
    await waitForRendererValue(
      client,
      `(() => ({
        href: location.href,
        rootChildren: document.querySelectorAll('#root > *').length,
        body: (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 200),
      }))()`,
      {
        timeoutMs: 30000,
        describe: 'app shell ready',
        accept: (value) => value?.rootChildren > 0,
      },
    );
    await client.evaluate(`location.hash = '#/plugins'`);
    const pluginsState = await waitForRendererValue(
      client,
      `(() => {
        const text = document.body?.innerText || '';
        const tabs = Array.from(document.querySelectorAll('[role="tab"]')).map((el) => ({
          name: (el.textContent || '').trim(),
          selected: el.getAttribute('aria-selected') === 'true',
        }));
        return {
          hash: location.hash,
          title: document.title,
          hasInstalledTab: tabs.some((t) => t.name.includes('已安装')),
          hasBrowseTab: tabs.some((t) => t.name.includes('浏览市场')),
          hasMarketTab: tabs.some((t) => t.name.includes('市场') && !t.name.includes('浏览')),
          hasPluginsTitle: /插件/.test(text),
          tabs,
          bodySnippet: text.replace(/\\s+/g, ' ').slice(0, 500),
        };
      })()`,
      {
        timeoutMs: 45000,
        describe: 'plugins page ready',
        accept: (value) => value?.hash === '#/plugins' && value?.hasInstalledTab && value?.hasBrowseTab && value?.hasMarketTab,
      },
    );
    check('plugins three tabs present', true, JSON.stringify(pluginsState.tabs));
    await captureScreenshot(client, path.join(shotDir, '01-installed.png'));

    // Switch to browse tab
    await driveByRole(client, {
      role: 'tab',
      name: '浏览市场',
      action: 'click',
      timeoutMs: 10000,
    });
    const browseState = await waitForRendererValue(
      client,
      `(() => {
        const selected = Array.from(document.querySelectorAll('[role="tab"][aria-selected="true"]')).map((el) => (el.textContent || '').trim());
        const text = document.body?.innerText || '';
        return {
          selected,
          hasAllMarket: /全部市场/.test(text),
          hasScope: /用户全局|项目共享|项目本机/.test(text),
          bodySnippet: text.replace(/\\s+/g, ' ').slice(0, 400),
        };
      })()`,
      {
        timeoutMs: 10000,
        describe: 'browse tab selected',
        accept: (value) => value?.selected?.some((name) => name.includes('浏览市场')),
      },
    );
    check('browse tab selected', true, JSON.stringify(browseState.selected));
    check('browse has all-market option', browseState.hasAllMarket, browseState.bodySnippet);
    check('browse has install scope options', browseState.hasScope, browseState.bodySnippet);
    await captureScreenshot(client, path.join(shotDir, '02-browse.png'));

    // Switch to marketplaces tab
    await driveByRole(client, {
      role: 'tab',
      name: '市场',
      action: 'click',
      timeoutMs: 10000,
    });
    const marketState = await waitForRendererValue(
      client,
      `(() => {
        const selected = Array.from(document.querySelectorAll('[role="tab"][aria-selected="true"]')).map((el) => (el.textContent || '').trim());
        const text = document.body?.innerText || '';
        return {
          selected,
          hasAdd: /添加市场|市场源|名称（可选）/.test(text),
          hasSync: /同步/.test(text),
          bodySnippet: text.replace(/\\s+/g, ' ').slice(0, 400),
        };
      })()`,
      {
        timeoutMs: 10000,
        describe: 'marketplaces tab selected',
        accept: (value) => value?.selected?.some((name) => name === '市场' || name.includes('市场')),
      },
    );
    check('marketplaces tab selected', true, JSON.stringify(marketState.selected));
    check('marketplaces add form present', marketState.hasAdd, marketState.bodySnippet);
    check('marketplaces sync present', marketState.hasSync, marketState.bodySnippet);
    await captureScreenshot(client, path.join(shotDir, '03-marketplaces.png'));

    // Back to installed and open install modal if button exists
    await driveByRole(client, {
      role: 'tab',
      name: '已安装插件',
      action: 'click',
      timeoutMs: 10000,
    });
    try {
      await driveByRole(client, {
        role: 'button',
        name: '+ 安装插件',
        action: 'click',
        timeoutMs: 5000,
      });
      const installModal = await waitForRendererValue(
        client,
        `(() => {
          const text = document.body?.innerText || '';
          return {
            open: /安装插件|插件 ID|Marketplace|安装作用域/.test(text),
            hasScope: /用户全局|项目共享|项目本机/.test(text),
            bodySnippet: text.replace(/\\s+/g, ' ').slice(0, 400),
          };
        })()`,
        {
          timeoutMs: 8000,
          describe: 'install modal open',
          accept: (value) => value?.open,
        },
      );
      check('install modal opens with scope', installModal.hasScope, installModal.bodySnippet);
      await captureScreenshot(client, path.join(shotDir, '04-install-modal.png'));
    } catch (error) {
      check('install modal opens with scope', false, error.message);
    }

    const failed = results.filter((item) => !item.ok);
    console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
    console.log(`screenshots: ${shotDir}`);
    if (failed.length) process.exitCode = 1;
  } catch (error) {
    console.error('manual plugins gui failed:', error);
    process.exitCode = 1;
  } finally {
    await finalize();
  }
}

main();
