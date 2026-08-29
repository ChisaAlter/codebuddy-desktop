// G4: 后台任务纯逻辑（prompt 解析、dispatch payload 构建、状态/权限模式归一）。
import { describe, expect, it } from 'vitest';
import {
  parseJobPrompt,
  buildJobDispatchPayload,
  normalizeJobPermissionMode,
  normalizeJobStatus,
  JOB_PERMISSION_MODES,
} from '../../src/lib/jobs-api';

describe('parseJobPrompt', () => {
  it('detects shell jobs by ! prefix', () => {
    expect(parseJobPrompt('!npm test')).toEqual({ isShell: true, prompt: 'npm test' });
    expect(parseJobPrompt('  ! ls -la ')).toEqual({ isShell: true, prompt: 'ls -la' });
  });

  it('treats other prompts as agent jobs', () => {
    expect(parseJobPrompt('fix the bug')).toEqual({ isShell: false, prompt: 'fix the bug' });
    expect(parseJobPrompt('')).toEqual({ isShell: false, prompt: '' });
    expect(parseJobPrompt(null)).toEqual({ isShell: false, prompt: '' });
  });
});

describe('normalizeJobPermissionMode', () => {
  it('accepts known modes and maps fullAccess', () => {
    for (const mode of JOB_PERMISSION_MODES) expect(normalizeJobPermissionMode(mode)).toBe(mode);
    expect(normalizeJobPermissionMode('fullAccess')).toBe('bypassPermissions');
    expect(normalizeJobPermissionMode('nonsense')).toBe('');
    expect(normalizeJobPermissionMode('')).toBe('');
  });
});

describe('buildJobDispatchPayload', () => {
  it('returns null for empty prompts', () => {
    expect(buildJobDispatchPayload({ prompt: '' })).toBeNull();
    expect(buildJobDispatchPayload({ prompt: '   ' })).toBeNull();
    expect(buildJobDispatchPayload({ prompt: '!' })).toBeNull();
  });

  it('builds a bash payload for ! prompts (agent options dropped)', () => {
    expect(
      buildJobDispatchPayload({ prompt: '!npm run build', cwd: '/repo', name: ' build ', permissionMode: 'plan', worktree: true }),
    ).toEqual({ prompt: 'npm run build', cwd: '/repo', name: 'build', bash: true });
  });

  it('builds an agent payload with worktree isolation and source session', () => {
    expect(
      buildJobDispatchPayload({
        prompt: 'refactor auth',
        cwd: '/repo',
        permissionMode: 'acceptEdits',
        worktree: true,
        sourceSessionId: 'sess-1',
      }),
    ).toEqual({
      prompt: 'refactor auth',
      cwd: '/repo',
      permissionMode: 'acceptEdits',
      bgIsolation: 'worktree',
      sourceSessionId: 'sess-1',
    });
  });

  it('defaults to bgIsolation none and omits empty options', () => {
    expect(buildJobDispatchPayload({ prompt: 'do it' })).toEqual({ prompt: 'do it', bgIsolation: 'none' });
  });

  it('drops the invalid minimal+plan combination (WebUI rule)', () => {
    expect(buildJobDispatchPayload({ prompt: 'x', agent: 'minimal', permissionMode: 'plan' })).toEqual({
      prompt: 'x',
      agent: 'minimal',
      bgIsolation: 'none',
    });
    expect(buildJobDispatchPayload({ prompt: 'x', agent: 'minimal', permissionMode: 'auto' })).toEqual({
      prompt: 'x',
      agent: 'minimal',
      permissionMode: 'auto',
      bgIsolation: 'none',
    });
  });
});

describe('normalizeJobStatus', () => {
  it('maps aliases onto the five canonical statuses', () => {
    expect(normalizeJobStatus({ status: 'RUNNING' })).toBe('running');
    expect(normalizeJobStatus({ status: 'active' })).toBe('running');
    expect(normalizeJobStatus({ state: 'queued' })).toBe('pending');
    expect(normalizeJobStatus({ status: 'cancelled' })).toBe('stopped');
    expect(normalizeJobStatus({ status: 'error' })).toBe('failed');
    expect(normalizeJobStatus({ status: 'done' })).toBe('completed');
    expect(normalizeJobStatus({ status: 'weird' })).toBe('unknown');
    expect(normalizeJobStatus({})).toBe('unknown');
  });
});
