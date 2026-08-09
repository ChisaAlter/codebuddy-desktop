import { describe, it, expect } from 'vitest';
import { classifyGitError, ERROR_KINDS } from '../../src/lib/git-errors';

describe('classifyGitError - 错误态分层（M1，文案与原型冻结版一致）', () => {
  it('非仓库：fatal: not a git repository', () => {
    const r = classifyGitError('fatal: not a git repository: \'C:/x\'');
    expect(r.kind).toBe('notrepo');
    expect(r.title).toBe('不是 Git 仓库');
    expect(r.body).toContain('git init');
  });

  it('非仓库：中文 git 输出', () => {
    expect(classifyGitError('fatal: 不是 git 仓库')).toMatchObject({ kind: 'notrepo' });
  });

  it('权限：EACCES / permission denied / not accessible', () => {
    for (const msg of ['EACCES: permission denied, open', 'spawn git EACCES', 'not accessible: C:/x']) {
      expect(classifyGitError(msg).kind).toBe('perm');
    }
    const r = classifyGitError('EACCES');
    expect(r.title).toBe('权限不足');
  });

  it('超时：主进程 timeoutMessage / ETIMEDOUT', () => {
    for (const msg of ['Git push 执行超时，已停止命令', 'Error: ETIMEDOUT']) {
      expect(classifyGitError(msg).kind).toBe('timeout');
    }
    expect(classifyGitError('Git status 执行超时').title).toBe('读取超时');
  });

  it('16MB 截断：主进程显式文案', () => {
    const r = classifyGitError('Git 输出超过 16MB，已停止在界面中加载；请在终端中执行该操作');
    expect(r.kind).toBe('big');
    expect(r.title).toBe('输出过大已截断');
  });

  it('兜底：原文透出 + other 分类', () => {
    const r = classifyGitError('remote: Repository not found');
    expect(r.kind).toBe('other');
    expect(r.title).toBe('Git 不可用');
    expect(r.body).toBe('remote: Repository not found');
  });

  it('空/缺失错误兜底为可读文案', () => {
    const r = classifyGitError('');
    expect(r.kind).toBe('other');
    expect(r.body).toContain('刷新');
  });

  it('Error 对象入参', () => {
    expect(classifyGitError(new Error('fatal: not a git repository')).kind).toBe('notrepo');
  });

  it('分类枚举固定', () => {
    expect(ERROR_KINDS).toEqual(['notrepo', 'perm', 'timeout', 'big', 'other']);
  });
});
