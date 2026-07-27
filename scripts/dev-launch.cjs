#!/usr/bin/env node
// 桌面快捷方式启动器：起 vite dev server → 等就绪 → 起 electron → 退出时一并清理。
// 用法：node scripts/dev-launch.cjs   （或经桌面 .bat 双击）
// 退出码：electron 的退出码；Ctrl+C 杀两进程后退出 130。

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

const projectRoot = path.resolve(__dirname, '..');
const VITE_PORT = 5173;
const VITE_URL = `http://localhost:${VITE_PORT}/`;

function log(msg) { console.log(`[dev-launch] ${msg}`); }

function waitUntilHttpOk(url, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode === 200 || res.statusCode === 304) return resolve(true);
        if (Date.now() - start > timeoutMs) return reject(new Error(`vite 返回 ${res.statusCode}，超时`));
        setTimeout(probe, 300);
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) return reject(new Error(`vite ${VITE_PORT} 超时未起 (${timeoutMs}ms)`));
        setTimeout(probe, 300);
      });
    };
    probe();
  });
}

let viteProc = null;
let electronProc = null;
let exiting = false;

function killAll(code) {
  if (exiting) return;
  exiting = true;
  for (const p of [electronProc, viteProc]) {
    if (p && !p.killed) {
      try {
        // L9: on Windows, process.kill(parentPid) does not propagate to child
        // processes (Electron spawns renderer/GPU helpers; Vite may spawn esbuild
        // workers). Use taskkill /T to kill the whole tree; on POSIX the signal
        // to the parent is enough since children share the process group.
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore', shell: true });
        } else {
          process.kill(p.pid, 'SIGTERM');
        }
      } catch (_) {}
    }
  }
  process.exit(code ?? 0);
}

process.on('SIGINT', () => killAll(130));
process.on('SIGTERM', () => killAll(143));
process.on('uncaughtException', (err) => { console.error('[dev-launch] uncaught', err); killAll(1); });

(async () => {
  const nodeBin = process.execPath;
  const viteBin = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  const electronCli = path.join(projectRoot, 'node_modules', 'electron', 'cli.js');

  if (!fs.existsSync(viteBin)) { console.error(`[dev-launch] 找不到 ${viteBin}，先 npm install`); process.exit(1); }
  if (!fs.existsSync(electronCli)) { console.error(`[dev-launch] 找不到 ${electronCli}，先 npm install`); process.exit(1); }

  log(`起 vite dev server (port ${VITE_PORT})...`);
  viteProc = spawn(nodeBin, [viteBin, '--port', String(VITE_PORT), '--strictPort'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  });
  viteProc.on('exit', (code) => { if (!exiting) { log(`vite 意外退出 code=${code}`); killAll(code ?? 1); } });

  log('等 vite 就绪...');
  try {
    await waitUntilHttpOk(VITE_URL, 30000);
  } catch (e) {
    console.error(`[dev-launch] ${e.message}`);
    killAll(1);
  }
  log('vite 就绪，起 electron...');

  electronProc = spawn(nodeBin, [electronCli, '.'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  });
  electronProc.on('exit', (code) => {
    log(`electron 退出 code=${code}`);
    killAll(code ?? 0);
  });
})().catch((err) => { console.error('[dev-launch] 启动失败', err); killAll(1); });