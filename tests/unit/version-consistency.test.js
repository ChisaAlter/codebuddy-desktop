import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// 版本一致性守卫：README「当前版本」、package-lock 与 RELEASE_NOTES 必须跟随
// package.json 的 version 一起更新，防止 1.1.0/1.1.1 这类文档漂移再次发生
// （发布脚本 scripts/run-release.cjs 只在 Windows 打包时执行，不覆盖文档）。

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;

describe('version consistency', () => {
  it('package.json version is a plain x.y.z version', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('README 当前版本 matches package.json', () => {
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    const match = readme.match(/\*\*当前版本：\[([^\]]+)\]\(([^)]+)\)\*\*/);
    expect(match, 'README 缺少「当前版本：[x.y.z](…)」标记').toBeTruthy();
    expect(match[1]).toBe(version);
    expect(match[2]).toContain(`/releases/tag/v${version}`);
  });

  it('package-lock.json version fields match package.json', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    expect(lock.version).toBe(version);
    expect(lock.packages['']?.version).toBe(version);
  });

  it('RELEASE_NOTES.md has a heading for the current version', () => {
    const notes = fs.readFileSync(path.join(root, 'RELEASE_NOTES.md'), 'utf8');
    // R12 收紧：不再接受正文任意位置 includes(version)（版本号出现在别的段落
    // 也能骗过守卫），必须存在以当前版本为标题的章节行，
    // 如「## 1.1.2（…）」或「# CodeBuddy Desktop 1.1.2」。
    const escaped = version.replace(/\./g, '\\.');
    const headingPattern = new RegExp(`^#{1,3} (?:.*\\s)?v?${escaped}(?![\\d.])`, 'm');
    expect(
      headingPattern.test(notes),
      `RELEASE_NOTES.md 缺少 ${version} 的章节标题（如「## ${version}」）`,
    ).toBe(true);
  });
});
