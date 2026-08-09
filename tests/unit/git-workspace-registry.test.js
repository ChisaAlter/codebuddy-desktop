import { describe, it, expect, vi } from 'vitest';
import { createGitWorkspaceRegistrar } from '../../src/lib/git-workspace-registry';

function makeState({ workspacePath = null, workspaceExtraDirs = [], projectsById = {} } = {}) {
  return { workspacePath, workspaceExtraDirs, projectsById };
}

describe('createGitWorkspaceRegistrar - Git 工作目录注册（M1）', () => {
  it('首次 notify 上报全部来源目录（workspacePath + extraDirs + 项目路径）', () => {
    const register = vi.fn();
    let state = makeState({
      workspacePath: 'C:/proj/a',
      workspaceExtraDirs: ['C:/extra/1', 'C:/extra/2'],
      projectsById: { p1: { workspacePath: 'C:/proj/b' }, p2: { workspacePath: 'C:/proj/c' } },
    });
    const notify = createGitWorkspaceRegistrar({ getState: () => state, register });
    expect(notify()).toBe(true);
    expect(register).toHaveBeenCalledTimes(1);
    const { dirs } = register.mock.calls[0][0];
    expect(dirs.sort()).toEqual(['C:/proj/a', 'C:/extra/1', 'C:/extra/2', 'C:/proj/b', 'C:/proj/c'].sort());
  });

  it('集合无变化时不再上报（流式期间防高频 IPC）', () => {
    const register = vi.fn();
    const state = makeState({ workspacePath: 'C:/proj/a' });
    const notify = createGitWorkspaceRegistrar({ getState: () => state, register });
    notify();
    expect(notify()).toBe(false);
    expect(notify()).toBe(false);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('workspacePath 变化触发重新上报', () => {
    const register = vi.fn();
    const state = makeState({ workspacePath: 'C:/proj/a' });
    const notify = createGitWorkspaceRegistrar({ getState: () => state, register });
    notify();
    state.workspacePath = 'C:/proj/b';
    expect(notify()).toBe(true);
    expect(register).toHaveBeenCalledTimes(2);
    expect(register.mock.calls[1][0].dirs).toEqual(['C:/proj/b']);
  });

  it('extraDirs 增删触发重新上报', () => {
    const register = vi.fn();
    const state = makeState({ workspacePath: 'C:/proj/a', workspaceExtraDirs: ['C:/extra/1'] });
    const notify = createGitWorkspaceRegistrar({ getState: () => state, register });
    notify();
    state.workspaceExtraDirs = ['C:/extra/1', 'C:/extra/2'];
    expect(notify()).toBe(true);
    state.workspaceExtraDirs = ['C:/extra/1'];
    expect(notify()).toBe(true);
  });

  it('项目列表变化触发重新上报', () => {
    const register = vi.fn();
    const state = makeState({ workspacePath: 'C:/proj/a' });
    const notify = createGitWorkspaceRegistrar({ getState: () => state, register });
    notify();
    state.projectsById = { p3: { workspacePath: 'C:/proj/d' } };
    expect(notify()).toBe(true);
  });

  it('空值/空白被过滤；全空集合也允许上报（主进程侧安全默认拒绝）', () => {
    const register = vi.fn();
    const state = makeState({ workspacePath: '   ', workspaceExtraDirs: ['', null], projectsById: { p: { workspacePath: undefined } } });
    const notify = createGitWorkspaceRegistrar({ getState: () => state, register });
    expect(notify()).toBe(true);
    expect(register.mock.calls[0][0].dirs).toEqual([]);
  });

  it('getState 返回 null/畸形时不上报崩溃（空集合上报）', () => {
    const register = vi.fn();
    const notify = createGitWorkspaceRegistrar({ getState: () => null, register });
    expect(() => notify()).not.toThrow();
    expect(register).toHaveBeenCalledWith({ dirs: [] });
  });
});
