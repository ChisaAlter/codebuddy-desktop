import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateGitArgs, normalizeGitRequest } = require('../../electron/git-validate.cjs');

describe('normalizeGitRequest - 形态归一', () => {
  it('数组形态转 {args, cwd}', () => {
    const { args, cwd } = normalizeGitRequest(['status', '--short']);
    expect(args).toEqual(['status', '--short']);
    expect(cwd).toBe('');
  });

  it('对象形态保留 args，cwd 缺失时保持为空以便主进程拒绝', () => {
    const { args, cwd } = normalizeGitRequest({ args: ['log'] });
    expect(args).toEqual(['log']);
    expect(cwd).toBe('');
  });

  it('空入参兜底为空 args + 空 cwd', () => {
    const { args, cwd } = normalizeGitRequest(null);
    expect(args).toEqual([]);
    expect(cwd).toBe('');
  });

  it('cwd 空白串归一为空，非空白 trim', () => {
    expect(normalizeGitRequest({ args: [], cwd: '   ' }).cwd).toBe('');
    expect(normalizeGitRequest({ args: [], cwd: '  /tmp/x  ' }).cwd).toBe('/tmp/x');
  });

  it('args 非字符串元素被 String() 强转', () => {
    expect(normalizeGitRequest({ args: [1, true, null] }).args).toEqual(['1', 'true', 'null']);
  });
});

describe('validateGitArgs - 白名单与安全拦截', () => {
  it('空命令返错', () => {
    expect(validateGitArgs([])).toMatch(/empty/);
  });

  it('未在白名单的子命令拒', () => {
    expect(validateGitArgs(['ls-files'])).toMatch(/not allowed/);
    expect(validateGitArgs(['clone', '.'])).toMatch(/not allowed/);
  });

  it('合法 UI 命令形态全放行', () => {
    const okCases = [
      ['status', '--short', '-z'],
      ['branch', '--show-current'],
      ['branch', '--format=%(refname:short)'],
      ['stash', 'pop'],
      ['stash', 'list'],
      ['reset', 'HEAD', '--', 'x.txt'],
      ['reset', 'HEAD', '--', '.'],
      ['remote', 'get-url', 'origin'],
      ['add', '--', 'x.txt'],
      ['add', '-A'],
      ['checkout', '--', 'x.txt'],
      ['checkout', '--', '.'],
      ['checkout', 'main'],
      ['checkout', '-b', 'feat'],
      ['clean', '-fd'],
      ['clean', '-fd', '--', 'new.txt'],
      ['restore', '--source=HEAD', '--staged', '--worktree', '--', 'x.txt'],
      ['rev-parse', '--verify', 'HEAD'],
      ['diff', '--', 'x.txt'],
      ['diff', '--cached'],
      ['diff', '--numstat'],
      ['diff', '--cached', '--numstat'],
      ['status', '-sb'],
      ['commit', '-m', 'msg'],
      ['log', '-20', '--oneline', '--decorate'],
      ['log', '-20', '--format=%H|%h|%an|%ai|%s'],
      ['stash'],
      ['push'],
      ['push', '-u', 'origin', 'feat/review'],
      ['fetch'],
      ['pull'],
    ];
    for (const args of okCases) {
      expect(validateGitArgs(args)).toBeNull();
    }
  });

  it('非 UI 命令形态与短选项绕过均拒绝', () => {
    expect(validateGitArgs(['branch', '--delete', 'x'])).toMatch(/branch.*not allowed/);
    expect(validateGitArgs(['branch', '-d', 'x'])).toMatch(/branch.*not allowed/);
    expect(validateGitArgs(['stash', 'drop'])).toMatch(/stash.*not allowed/);
    expect(validateGitArgs(['remote', 'add', 'x', 'y'])).toMatch(/remote.*not allowed/);
    expect(validateGitArgs(['reset', '--hard'])).toMatch(/reset.*not allowed/);
    expect(validateGitArgs(['checkout', '--orphan', 'x'])).toMatch(/checkout.*not allowed/);
    expect(validateGitArgs(['checkout', '-f'])).toMatch(/checkout.*not allowed/);
    expect(validateGitArgs(['diff', '--ext-diff'])).toMatch(/diff.*not allowed/);
    expect(validateGitArgs(['fetch', '--upload-pack=/bin/sh'])).toMatch(/fetch.*not allowed/);
    expect(validateGitArgs(['commit', '-c', 'x'])).toMatch(/commit.*not allowed/);
    expect(validateGitArgs(['-C', '/repo', 'status'])).toMatch(/-C.*not allowed/);
  });

  it('-- 后路径段豁免黑名单（不解析为选项）', () => {
    expect(validateGitArgs(['add', '--', '--config'])).toBeNull();
  });

  it('commit -m 后的文本按提交信息处理，不误判为选项', () => {
    expect(validateGitArgs(['commit', '-m', '--config'])).toBeNull();
  });

  // M1：commit message 双端上限（主进程硬上限 4096，前端 maxLength 对齐）
  it('commit message 超过 4096 字符拒绝', () => {
    expect(validateGitArgs(['commit', '-m', 'x'.repeat(4097)])).toMatch(/exceeds 4096/);
  });

  it('commit message 恰好 4096 字符放行', () => {
    expect(validateGitArgs(['commit', '-m', 'x'.repeat(4096)])).toBeNull();
  });

  it('commit message 为空串拒绝（isPath 非空校验）', () => {
    expect(validateGitArgs(['commit', '-m', ''])).toMatch(/commit.*not allowed/);
  });

  it('M1 新增形态的变体仍拒绝（防止宽匹配）', () => {
    expect(validateGitArgs(['diff', '--numstat', '--stat'])).toMatch(/diff.*not allowed/);
    expect(validateGitArgs(['status', '-sb', '--porcelain'])).toMatch(/status.*not allowed/);
  });
});
