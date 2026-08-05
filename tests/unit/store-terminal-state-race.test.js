import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../src/store';

function project(id, paneId) {
  return {
    id,
    workspacePath: `C:/${id}`,
    preferences: {
      terminalState: {
        activePaneId: paneId,
        panes: [{ id: paneId, output: `${id}-saved`, sessionId: null }],
      },
    },
  };
}

describe('terminal state project ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.electronAPI = {
      saveProductState: vi.fn().mockResolvedValue({ ok: true, disposition: 'committed' }),
      saveProductStateSync: vi.fn().mockReturnValue({ ok: true, disposition: 'committed' }),
    };
    useStore.setState({
      activeProjectId: 'project-a',
      activePaneId: 'pane-a',
      terminalPanes: [{ id: 'pane-a', output: 'A-live', sessionId: 'session-a', cwd: null }],
      projectsById: {
        'project-a': project('project-a', 'pane-a'),
        'project-b': project('project-b', 'pane-b'),
      },
      projectOrder: ['project-a', 'project-b'],
      threadsById: {},
      threadOrderByProject: { 'project-a': [], 'project-b': [] },
      productStateLoaded: true,
      error: null,
    });
  });

  afterEach(() => {
    useStore.getState().flushPendingPaneOutputs();
    vi.useRealTimers();
    delete window.electronAPI;
  });

  it('does not let an old project timer capture the new project panes', async () => {
    useStore.getState().scheduleTerminalStatePersist();
    useStore.setState({
      activeProjectId: 'project-b',
      activePaneId: 'pane-b',
      terminalPanes: [{ id: 'pane-b', output: 'B-live', sessionId: null }],
    });

    await vi.advanceTimersByTimeAsync(5000);
    expect(useStore.getState().projectsById['project-a'].preferences.terminalState.panes[0].output).toBe('project-a-saved');
    expect(useStore.getState().projectsById['project-b'].preferences.terminalState.panes[0].output).toBe('project-b-saved');
  });

  it('keeps a captured project snapshot while cwd lookup crosses a project switch', async () => {
    let releaseCwd;
    const cwdPending = new Promise((resolve) => {
      releaseCwd = resolve;
    });
    useStore.setState({ fetchPtyCwd: vi.fn(() => cwdPending) });

    const persist = useStore.getState().persistActiveProjectTerminalState();
    await Promise.resolve();
    useStore.setState({
      activeProjectId: 'project-b',
      activePaneId: 'pane-b',
      terminalPanes: [{ id: 'pane-b', output: 'B-live', sessionId: null, cwd: 'C:/B' }],
    });
    releaseCwd('C:/A');
    await persist;

    const state = useStore.getState();
    const aPane = state.projectsById['project-a'].preferences.terminalState.panes[0];
    expect(aPane).toMatchObject({ id: 'pane-a', output: 'A-live', cwd: 'C:/A' });
    expect(state.terminalPanes[0]).toMatchObject({ id: 'pane-b', output: 'B-live', cwd: 'C:/B' });
  });

  it('sync flush updates only the active project from root terminal state', () => {
    useStore.getState().scheduleTerminalStatePersist();
    useStore.setState({
      activeProjectId: 'project-b',
      activePaneId: 'pane-b',
      terminalPanes: [{ id: 'pane-b', output: 'B-live', sessionId: null }],
    });
    useStore.getState().scheduleTerminalStatePersist();

    expect(useStore.getState().flushProductStateSync()).toBe(true);
    const snapshot = window.electronAPI.saveProductStateSync.mock.calls[0][0];
    expect(snapshot.projectsById['project-a'].preferences.terminalState.panes[0].output).toBe('project-a-saved');
    expect(snapshot.projectsById['project-b'].preferences.terminalState.panes[0].output).toBe('B-live');
  });
});
