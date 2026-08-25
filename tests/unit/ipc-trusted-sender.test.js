import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// IPC 信任边界契约：main.cjs 里每个 ipcMain.handle 通道都必须校验 sender
// 是主窗口 webContents（requireTrustedMainSender / isTrustedGitSender），
// 防止新增通道时遗漏（历史上 runtime:list、app:openExternal 等只读/外链
// 通道曾长期未加守卫）。main.cjs 无法在 vitest 里 require（会启动 Electron），
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
});
