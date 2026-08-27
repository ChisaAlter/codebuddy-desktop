import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// IPC 信任边界契约：main.cjs 里每个 ipcMain.handle 通道都必须校验 sender
// 是主窗口 webContents（requireTrustedMainSender / isTrustedGitSender），
// 防止新增通道时遗漏（历史上 runtime:list、app:openExternal 等只读/外链
// 通道曾长期未加守卫）。R12 起 ipcMain.on 通道同样必须守卫
//（requireTrustedMainSenderOn，静默忽略而非抛错——on 通道无返回错误的信道）。
// main.cjs 无法在 vitest 里 require（会启动 Electron），
// 与 main-process-stream-contract 一样对源码做静态断言。

const mainSource = fs.readFileSync(path.join(process.cwd(), 'electron', 'main.cjs'), 'utf8');

function listHandleRegistrations(source) {
  const registrations = [];
  const pattern = /ipcMain\.(handle|on)\('([^']+)'/g;
  let match;
  while ((match = pattern.exec(source))) {
    registrations.push({ kind: match[1], channel: match[2], index: match.index });
  }
  return registrations;
}

describe('ipcMain.handle trusted-sender contract', () => {
  const registrations = listHandleRegistrations(mainSource);

  it('finds a realistic number of IPC registrations', () => {
    expect(registrations.filter((item) => item.kind === 'handle').length).toBeGreaterThan(40);
  });

  it('every ipcMain.handle body validates the sender', () => {
    const unguarded = [];
    for (let index = 0; index < registrations.length; index += 1) {
      const item = registrations[index];
      if (item.kind !== 'handle') continue;
      const end = registrations[index + 1] ? registrations[index + 1].index : mainSource.length;
      const body = mainSource.slice(item.index, end);
      // 只匹配调用（行首缩进 + 调用形式），不匹配 requireTrustedMainSender 的函数定义。
      const guarded =
        /^\s*requireTrustedMainSender\(event\);/m.test(body) ||
        /isTrustedGitSender\(event\.sender/.test(body) ||
        /isTrustedMainSender\(event\.sender/.test(body);
      if (!guarded) unguarded.push(item.channel);
    }
    expect(unguarded, `unguarded ipcMain.handle channels: ${unguarded.join(', ')}`).toEqual([]);
  });

  it('finds a realistic number of ipcMain.on registrations', () => {
    expect(registrations.filter((item) => item.kind === 'on').length).toBeGreaterThan(10);
  });

  it('every ipcMain.on body validates the sender', () => {
    const unguarded = [];
    for (let index = 0; index < registrations.length; index += 1) {
      const item = registrations[index];
      if (item.kind !== 'on') continue;
      const end = registrations[index + 1] ? registrations[index + 1].index : mainSource.length;
      const body = mainSource.slice(item.index, end);
      // on 通道统一走 requireTrustedMainSenderOn（布尔 + early-return，不抛错）；
      // 保留 isTrustedMainSender(event.sender 的内联形式兼容匹配。
      const guarded =
        /^\s*if \(!requireTrustedMainSenderOn\(event\)\)/m.test(body) ||
        /isTrustedMainSender\(event\.sender/.test(body);
      if (!guarded) unguarded.push(item.channel);
    }
    expect(unguarded, `unguarded ipcMain.on channels: ${unguarded.join(', ')}`).toEqual([]);
  });

  it('handlers registered with ipcMain.on declare the event parameter (guard needs it)', () => {
    // 守卫依赖 event.sender/event.senderFrame；若回调把 event 写成 `_event`
    // 或省略，守卫无从谈起。逐个回调断言首参就叫 event，给出比上一条更直接的信号。
    const pattern = /ipcMain\.on\('([^']+)',\s*(?:async\s*)?\(([^)]*)\)/g;
    let match;
    const missing = [];
    while ((match = pattern.exec(mainSource))) {
      const firstParam = match[2].split(',')[0].trim();
      if (firstParam !== 'event') missing.push(match[1]);
    }
    expect(missing, `ipcMain.on handlers without an event param: ${missing.join(', ')}`).toEqual([]);
  });

  it('sender guards forward event.senderFrame (iframe rejection reaches git-security)', () => {
    // requireTrustedMainSender / requireTrustedMainSenderOn 是 senderFrame 校验的
    // 单一入口；若有人把第三参删掉，isTrustedSenderFrame 将永远收到 undefined
    //（= 放行），iframe 拒绝形同虚设。
    expect(mainSource).toMatch(
      /function requireTrustedMainSender\(event\) \{\s*\n\s*if \(!isTrustedMainSender\(event\.sender, mainWindow, event\.senderFrame\)\)/,
    );
    expect(mainSource).toMatch(
      /function requireTrustedMainSenderOn\(event\) \{\s*\n\s*return isTrustedMainSender\(event\.sender, mainWindow, event\.senderFrame\);/,
    );
  });
});
