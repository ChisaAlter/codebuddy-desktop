import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { normalizeDir, normalizeDirList, isAllowedGitCwd, isTrustedGitSender } = require('../../electron/git-security.cjs');

// Windows 下 path.resolve('/a/b') = 'C:\\a\\b'，断言一律用 path.resolve 计算期望
const P_A = path.resolve('/a/b');
const P_C = path.resolve('/c/d');

describe('normalizeDir / normalizeDirList - 目录规范化', () => {
  it('trim + resolve 绝对化 + 去尾分隔符', () => {
    expect(normalizeDir('  /a/b/  ')).toBe(P_A);
    expect(normalizeDir('/a/b/')).toBe(P_A);
  });

  it('非法输入返回 null', () => {
    expect(normalizeDir('')).toBeNull();
    expect(normalizeDir('   ')).toBeNull();
    expect(normalizeDir(null)).toBeNull();
    expect(normalizeDir(undefined)).toBeNull();
    expect(normalizeDir(123)).toBeNull();
  });

  it('目录列表过滤非法项并去重', () => {
    const set = normalizeDirList(['/a/b', '/a/b/', '', null, 42, '/c/d']);
    expect([...set].sort()).toEqual([P_A, P_C].sort());
  });
});

describe('isAllowedGitCwd - cwd 归属白名单（M1 安全面）', () => {
  const allowed = normalizeDirList(['C:/work/proj-a', '/home/user/proj-b']);

  it('注册目录放行（含尾分隔符/大小写差异按 resolve 归一）', () => {
    expect(isAllowedGitCwd('C:/work/proj-a', allowed)).toBe(true);
    expect(isAllowedGitCwd('C:/work/proj-a/', allowed)).toBe(true);
    expect(isAllowedGitCwd('/home/user/proj-b', allowed)).toBe(true);
  });

  it('未注册目录拒绝', () => {
    expect(isAllowedGitCwd('C:/work/proj-c', allowed)).toBe(false);
    expect(isAllowedGitCwd('C:/work', allowed)).toBe(false);
    expect(isAllowedGitCwd('C:/work/proj-a/sub', allowed)).toBe(false);
  });

  it('相对路径/空值/非法值拒绝', () => {
    expect(isAllowedGitCwd('proj-a', allowed)).toBe(false);
    expect(isAllowedGitCwd('.', allowed)).toBe(false);
    expect(isAllowedGitCwd('', allowed)).toBe(false);
    expect(isAllowedGitCwd(null, allowed)).toBe(false);
  });

  it('安全默认：allowedDirs 非 Set 或为空 Set 时拒绝任意目录', () => {
    expect(isAllowedGitCwd('C:/work/proj-a', new Set())).toBe(false);
    expect(isAllowedGitCwd('C:/work/proj-a', null)).toBe(false);
    expect(isAllowedGitCwd('C:/work/proj-a', undefined)).toBe(false);
    expect(isAllowedGitCwd('C:/work/proj-a', ['C:/work/proj-a'])).toBe(false);
  });
});

describe('isTrustedGitSender - sender 信任校验', () => {
  const mainWc = { id: 'wc-main', isDestroyed: () => false };
  const mainWindow = { webContents: mainWc, isDestroyed: () => false };
  const otherWc = { id: 'wc-other', isDestroyed: () => false };

  it('主窗口 webContents 放行', () => {
    expect(isTrustedGitSender(mainWc, mainWindow)).toBe(true);
  });

  it('非主窗口 sender 拒绝', () => {
    expect(isTrustedGitSender(otherWc, mainWindow)).toBe(false);
    expect(isTrustedGitSender(otherWc, { webContents: mainWc, isDestroyed: () => false })).toBe(false);
  });

  it('已销毁的 sender / 窗口拒绝', () => {
    const destroyedSender = { ...mainWc, isDestroyed: () => true };
    expect(isTrustedGitSender(destroyedSender, mainWindow)).toBe(false);
    const destroyedWindow = { webContents: mainWc, isDestroyed: () => true };
    expect(isTrustedGitSender(mainWc, destroyedWindow)).toBe(false);
  });

  it('缺省/畸形入参拒绝（不抛异常）', () => {
    expect(isTrustedGitSender(null, mainWindow)).toBe(false);
    expect(isTrustedGitSender(undefined, mainWindow)).toBe(false);
    expect(isTrustedGitSender(mainWc, null)).toBe(false);
    expect(isTrustedGitSender({}, {})).toBe(false);
  });
});
