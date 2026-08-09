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

  it('does not overwrite terminal output that arrives during cwd lookup', async () => {
    let releaseCwd;
    const cwdPending = new Promise((resolve) => {
      releaseCwd = resolve;
    });
    useStore.setState({ fetchPtyCwd: vi.fn(() => cwdPending) });

    const persist = useStore.getState().persistActiveProjectTerminalState();
    await Promise.resolve();
    // Output lands while the cwd requests are in flight: the persisted snapshot
    // must include it (regression — the old second write used a stale snapshot).
    useStore.getState().appendPaneOutput('pane-a', 'new-output-during-cwd');
    releaseCwd('C:/A');
    await persist;

    const state = useStore.getState();
    const pane = state.projectsById['project-a'].preferences.terminalState.panes[0];
    expect(pane.output).toContain('new-output-during-cwd');
    expect(pane.cwd).toBe('C:/A');
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

  it('persists at the 5s boundary during continuous output (no starvation)', async () => {
    const { appendPaneOutput } = useStore.getState();
    for (let i = 1; i <= 10; i += 1) {
      appendPaneOutput('pane-a', `chunk-${i * 1000};`);
      await vi.advanceTimersByTimeAsync(1000);
    }

    // A reset-per-call schedule restarts a full 5s window on every chunk, so
    // chunks arriving faster than the window would never persist. The fixed
    // cadence must have fired at T=5s and T=10s regardless.
    const pane = useStore.getState().projectsById['project-a'].preferences.terminalState.panes[0];
    expect(pane.output).toContain('chunk-5000;');
    expect(pane.output).toContain('chunk-10000;');
  });

  it('pins a trailing persist to the cadence boundary after output stops', async () => {
    const { appendPaneOutput } = useStore.getState();
    appendPaneOutput('pane-a', 'first;');
    await vi.advanceTimersByTimeAsync(3000);
    appendPaneOutput('pane-a', 'second;');
    await vi.advanceTimersByTimeAsync(2000); // T=5s: the boundary from the first chunk

    const pane = useStore.getState().projectsById['project-a'].preferences.terminalState.panes[0];
    expect(pane.output).toContain('first;');
    expect(pane.output).toContain('second;');
  });
});
