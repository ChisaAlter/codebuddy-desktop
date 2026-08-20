import { beforeEach, describe, expect, it, vi } from 'vitest';

const opsMocks = vi.hoisted(() => ({
  deleteSession: vi.fn(),
}));

vi.mock('../../src/lib/ops', async (importOriginal) => ({
  ...(await importOriginal()),
  deleteSession: opsMocks.deleteSession,
}));

import { useStore } from '../../src/store';

const project = {
  id: 'p1',
  name: 'Project',
  workspacePath: 'C:/Project',
  preferences: { sidebarExpanded: true },
};

function thread(id, overrides = {}) {
  return {
    id,
    projectId: 'p1',
    title: id,
    status: 'idle',
    unread: false,
    pinned: false,
    archivedAt: null,
    ...overrides,
  };
}

describe('store sidebar session mutations', () => {
  let saveProductState;
  let activateThread;
  let newSession;

  beforeEach(() => {
    opsMocks.deleteSession.mockReset();
    opsMocks.deleteSession.mockResolvedValue(null);
    saveProductState = vi.fn().mockResolvedValue({ ok: true });
    window.electronAPI = { saveProductState };
    activateThread = vi.fn().mockResolvedValue(true);
    newSession = vi.fn().mockResolvedValue(true);
    useStore.setState({
      projectsById: { p1: project },
      projectOrder: ['p1'],
      threadsById: {
        t1: thread('t1'),
        t2: thread('t2'),
      },
      threadOrderByProject: { p1: ['t1', 't2'] },
      activeProjectId: 'p1',
      activeThreadId: 't1',
      workspacePath: 'C:/Project',
      activateThread,
      newSession,
      error: null,
      productStateLoaded: true,
    });
  });

  it('persists project folding state', async () => {
    await expect(useStore.getState().setProjectSidebarExpanded('p1', false)).resolves.toBe(true);

    expect(useStore.getState().projectsById.p1.preferences.sidebarExpanded).toBe(false);
    expect(saveProductState).toHaveBeenCalledTimes(1);
  });

  it('persists pin state', async () => {
    await expect(useStore.getState().setThreadPinned('t1', true)).resolves.toBe(true);

    expect(useStore.getState().threadsById.t1.pinned).toBe(true);
    expect(saveProductState).toHaveBeenCalledTimes(1);
  });

  it('archives the active thread and opens the next visible thread', async () => {
    await expect(useStore.getState().archiveThread('t1')).resolves.toBe(true);

    expect(useStore.getState().threadsById.t1.archivedAt).toEqual(expect.any(String));
    expect(activateThread).toHaveBeenCalledWith('t2');
    expect(newSession).not.toHaveBeenCalled();
  });

  it('creates a replacement when archiving the last visible thread', async () => {
    useStore.setState({
      threadsById: {
        t1: thread('t1'),
        t2: thread('t2', { archivedAt: '2026-07-14T01:00:00.000Z' }),
      },
    });

    await expect(useStore.getState().archiveThread('t1')).resolves.toBe(true);

    expect(activateThread).not.toHaveBeenCalled();
    expect(newSession).toHaveBeenCalledTimes(1);
  });

  it('restores an archived thread without changing its pin state', async () => {
    useStore.setState({
      threadsById: {
        t1: thread('t1', { pinned: true, archivedAt: '2026-07-14T01:00:00.000Z' }),
        t2: thread('t2'),
      },
    });

    await expect(useStore.getState().restoreThread('t1')).resolves.toBe(true);

    expect(useStore.getState().threadsById.t1).toMatchObject({ pinned: true, archivedAt: null });
  });

  it('rolls back a pin change when persistence fails', async () => {
    saveProductState.mockRejectedValueOnce(new Error('disk full'));

    await expect(useStore.getState().setThreadPinned('t1', true)).resolves.toBe(false);

    expect(useStore.getState().threadsById.t1.pinned).toBe(false);
    expect(useStore.getState().error).toContain('disk full');
  });

  it('activates the first visible thread when an archived thread is ordered first', async () => {
    useStore.setState({
      projectsById: {
        p1: project,
        p2: { ...project, id: 'p2', name: 'Second', workspacePath: 'C:/Second' },
      },
      projectOrder: ['p1', 'p2'],
      threadsById: {
        t1: thread('t1'),
        archived: { ...thread('archived', { archivedAt: '2026-07-14T01:00:00.000Z' }), projectId: 'p2' },
        visible: { ...thread('visible'), projectId: 'p2' },
      },
      threadOrderByProject: { p1: ['t1'], p2: ['archived', 'visible'] },
      persistActiveProjectWorkspaceState: vi.fn().mockResolvedValue(true),
      persistActiveProjectTerminalState: vi.fn().mockResolvedValue(true),
      persistProductState: vi.fn().mockResolvedValue(true),
      ensureProjectRuntime: vi.fn().mockResolvedValue({ projectId: 'p2' }),
      loadProjectTerminalState: vi.fn(),
    });

    await expect(useStore.getState().activateProject('p2', { deferInitializationUntilAuth: true })).resolves.toBe(true);

    expect(useStore.getState().activeThreadId).toBe('visible');
  });

  it('creates a new thread under the target project when preferNewThread is set', async () => {
    useStore.setState({
      projectsById: {
        p1: project,
        p2: { ...project, id: 'p2', name: 'Second', workspacePath: 'C:/Second' },
      },
      projectOrder: ['p1', 'p2'],
      threadsById: {
        t1: thread('t1'),
        existing: { ...thread('existing'), projectId: 'p2' },
      },
      threadOrderByProject: { p1: ['t1'], p2: ['existing'] },
      activeProjectId: 'p1',
      activeThreadId: 't1',
      persistActiveProjectWorkspaceState: vi.fn().mockResolvedValue(true),
      persistActiveProjectTerminalState: vi.fn().mockResolvedValue(true),
      persistProductState: vi.fn().mockResolvedValue(true),
      ensureProjectRuntime: vi.fn().mockResolvedValue({ projectId: 'p2' }),
      loadProjectTerminalState: vi.fn(),
    });

    await expect(
      useStore.getState().activateProject('p2', {
        deferInitializationUntilAuth: true,
        preferNewThread: true,
      }),
    ).resolves.toBe(true);

    const state = useStore.getState();
    expect(state.activeProjectId).toBe('p2');
    expect(state.activeThreadId).not.toBe('existing');
    expect(state.threadOrderByProject.p2[0]).toBe(state.activeThreadId);
    expect(state.threadsById[state.activeThreadId]).toMatchObject({
      projectId: 'p2',
      sessionId: null,
    });
    expect(state.threadOrderByProject.p2).toEqual([state.activeThreadId, 'existing']);
  });

  it('reopens an existing workspace on its first visible thread', async () => {
    useStore.setState({
      projectsById: {
        p1: project,
        p2: { ...project, id: 'p2', name: 'Second', workspacePath: 'C:/Second' },
      },
      projectOrder: ['p1', 'p2'],
      threadsById: {
        t1: thread('t1'),
        archived: { ...thread('archived', { archivedAt: '2026-07-14T01:00:00.000Z' }), projectId: 'p2' },
        visible: { ...thread('visible'), projectId: 'p2' },
      },
      threadOrderByProject: { p1: ['t1'], p2: ['archived', 'visible'] },
      persistActiveProjectWorkspaceState: vi.fn().mockResolvedValue(true),
      persistActiveProjectTerminalState: vi.fn().mockResolvedValue(true),
      persistProductState: vi.fn().mockResolvedValue(true),
      ensureProjectRuntime: vi.fn().mockResolvedValue({ projectId: 'p2' }),
      loadProjectTerminalState: vi.fn(),
    });

    await expect(useStore.getState().setWorkspace('C:/Second', { deferInitializationUntilAuth: true })).resolves.toBe(true);

    expect(useStore.getState().activeThreadId).toBe('visible');
  });

  it('rolls back the active pointers when workspace startup fails', async () => {
    useStore.setState({
      projectsById: {
        p1: project,
        p2: { ...project, id: 'p2', name: 'Second', workspacePath: 'C:/Second' },
      },
      projectOrder: ['p1', 'p2'],
      threadsById: {
        t1: thread('t1'),
        visible: { ...thread('visible'), projectId: 'p2' },
      },
      threadOrderByProject: { p1: ['t1'], p2: ['visible'] },
      persistActiveProjectWorkspaceState: vi.fn().mockResolvedValue(true),
      persistActiveProjectTerminalState: vi.fn().mockResolvedValue(true),
      persistProductState: vi.fn().mockResolvedValue(true),
      ensureProjectRuntime: vi.fn().mockRejectedValue(new Error('runtime failed')),
      loadProjectTerminalState: vi.fn(),
    });

    await expect(useStore.getState().setWorkspace('C:/Second')).resolves.toBe(false);

    const state = useStore.getState();
    // Half-switch must be undone: active pointers stay with the previous project.
    expect(state.activeProjectId).toBe('p1');
    expect(state.activeThreadId).toBe('t1');
    expect(state.workspacePath).toBe('C:/Project');
    expect(state.error).toContain('runtime failed');
  });

  it('rolls back the active pointers when project activation fails', async () => {
    useStore.setState({
      projectsById: {
        p1: project,
        p2: { ...project, id: 'p2', name: 'Second', workspacePath: 'C:/Second' },
      },
      projectOrder: ['p1', 'p2'],
      threadsById: {
        t1: thread('t1'),
        visible: { ...thread('visible'), projectId: 'p2' },
      },
      threadOrderByProject: { p1: ['t1'], p2: ['visible'] },
      persistActiveProjectWorkspaceState: vi.fn().mockResolvedValue(true),
      persistActiveProjectTerminalState: vi.fn().mockResolvedValue(true),
      persistProductState: vi.fn().mockResolvedValue(true),
      ensureProjectRuntime: vi.fn().mockRejectedValue(new Error('runtime failed')),
      loadProjectTerminalState: vi.fn(),
    });

    await expect(useStore.getState().activateProject('p2')).resolves.toBe(false);

    const state = useStore.getState();
    expect(state.activeProjectId).toBe('p1');
    expect(state.activeThreadId).toBe('t1');
    expect(state.workspacePath).toBe('C:/Project');
    expect(state.error).toContain('runtime failed');
  });

  it('removes the blank preferNewThread session when activation fails after persist', async () => {
    useStore.setState({
      projectsById: {
        p1: project,
        p2: { ...project, id: 'p2', name: 'Second', workspacePath: 'C:/Second' },
      },
      projectOrder: ['p1', 'p2'],
      threadsById: {
        t1: thread('t1'),
        existing: { ...thread('existing'), projectId: 'p2' },
      },
      threadOrderByProject: { p1: ['t1'], p2: ['existing'] },
      persistActiveProjectWorkspaceState: vi.fn().mockResolvedValue(true),
      persistActiveProjectTerminalState: vi.fn().mockResolvedValue(true),
      persistProductState: vi.fn().mockResolvedValue(true),
      ensureProjectRuntime: vi.fn().mockResolvedValue(null),
      loadProjectTerminalState: vi.fn(),
    });

    await expect(
      useStore.getState().activateProject('p2', {
        deferInitializationUntilAuth: true,
        preferNewThread: true,
      }),
    ).resolves.toBe(false);

    const state = useStore.getState();
    expect(state.activeProjectId).toBe('p1');
    expect(state.activeThreadId).toBe('t1');
    expect(Object.keys(state.threadsById).sort()).toEqual(['existing', 't1']);
    expect(state.threadOrderByProject.p2).toEqual(['existing']);
  });

  it('removes the active project and selects a visible thread in the replacement project', async () => {
    useStore.setState({
      projectsById: {
        p1: project,
        p2: { ...project, id: 'p2', name: 'Second', workspacePath: 'C:/Second' },
      },
      projectOrder: ['p1', 'p2'],
      threadsById: {
        t1: thread('t1'),
        archived: { ...thread('archived', { archivedAt: '2026-07-14T01:00:00.000Z' }), projectId: 'p2' },
        visible: { ...thread('visible'), projectId: 'p2' },
      },
      threadOrderByProject: { p1: ['t1'], p2: ['archived', 'visible'] },
      threadRuntimeById: {},
      stopProjectRuntime: vi.fn().mockResolvedValue(true),
      persistProductState: vi.fn().mockResolvedValue(true),
      ensureProjectRuntime: vi.fn().mockResolvedValue({ projectId: 'p2' }),
      initializeWorkspace: vi.fn().mockResolvedValue(true),
      initializeActiveThread: vi.fn().mockResolvedValue(true),
      loadProjectTerminalState: vi.fn(),
      activateThreadRuntime: vi.fn(),
    });

    await expect(useStore.getState().removeProject('p1', { skipDirtyCheck: true })).resolves.toBe(true);

    expect(useStore.getState()).toMatchObject({ activeProjectId: 'p2', activeThreadId: 'visible' });
  });

  it('creates a replacement instead of activating an archived thread after deleting the active thread', async () => {
    useStore.setState({
      threadsById: {
        archived: thread('archived', { archivedAt: '2026-07-14T01:00:00.000Z' }),
        t1: thread('t1'),
      },
      threadOrderByProject: { p1: ['archived', 't1'] },
      activeThreadId: 't1',
      sessions: [],
      persistProductState: vi.fn().mockResolvedValue(true),
      activateThread,
      newSession,
    });

    await expect(useStore.getState().deleteThread('t1')).resolves.toBe(true);

    expect(activateThread).not.toHaveBeenCalled();
    expect(newSession).toHaveBeenCalledTimes(1);
  });

  it('removes locally without waiting for a stalled backend delete', async () => {
    opsMocks.deleteSession.mockReturnValue(new Promise(() => {}));
    activateThread = vi.fn().mockReturnValue(new Promise(() => {}));
    useStore.setState({
      threadsById: {
        t1: thread('t1', { sessionId: 'session-1' }),
        t2: thread('t2', { sessionId: 'session-2' }),
      },
      threadOrderByProject: { p1: ['t1', 't2'] },
      threadRuntimeById: { t1: { timeline: [{ id: 'message-1' }] } },
      activeThreadId: 't1',
      sessionId: 'session-1',
      sessions: [{ id: 'session-1' }, { id: 'session-2' }],
      persistProductState: vi.fn().mockResolvedValue(true),
      activateThread,
    });

    await expect(Promise.race([
      useStore.getState().deleteThread('t1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('delete remained blocked')), 250)),
    ])).resolves.toBe(true);
    await Promise.resolve();

    expect(opsMocks.deleteSession).toHaveBeenCalledWith('session-1');
    expect(useStore.getState().threadsById.t1).toBeUndefined();
    expect(useStore.getState().threadRuntimeById.t1).toBeUndefined();
    expect(useStore.getState().projectsById.p1.preferences.deletedSessionIds).toContain('session-1');
    expect(useStore.getState().sessions).toEqual([{ id: 'session-2' }]);
    expect(activateThread).toHaveBeenCalledWith('t2');
  });

  it('does not re-import sessions that were deleted locally', async () => {
    const requestCodeBuddy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessions: [
          { id: 'deleted-session', name: 'Deleted' },
          { id: 'visible-session', name: 'Visible' },
        ],
      }),
    });
    window.electronAPI = { saveProductState, requestCodeBuddy };
    useStore.setState({
      projectsById: {
        p1: {
          ...project,
          preferences: { ...project.preferences, deletedSessionIds: ['deleted-session'] },
        },
      },
      threadsById: { t1: thread('t1') },
      threadOrderByProject: { p1: ['t1'] },
      activeProjectId: 'p1',
      activeThreadId: 't1',
      sessions: [],
      persistProductState: vi.fn().mockResolvedValue(true),
    });

    await expect(useStore.getState().refreshSessions()).resolves.toBe(true);

    expect(useStore.getState().sessions).toEqual([{ id: 'visible-session', name: 'Visible' }]);
    expect(Object.values(useStore.getState().threadsById).some((item) => item.sessionId === 'deleted-session')).toBe(false);
    expect(Object.values(useStore.getState().threadsById).some((item) => item.sessionId === 'visible-session')).toBe(true);
  });
});
