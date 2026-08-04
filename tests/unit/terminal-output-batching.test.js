import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../src/store';

describe('terminal output batching (M-perf)', () => {
  beforeEach(() => {
    useStore.setState({
      activeProjectId: 'project-1',
      activePaneId: 'pane-1',
      terminalPanes: [{ id: 'pane-1', output: 'start', sessionId: 's1' }],
      projectsById: { 'project-1': { id: 'project-1', workspacePath: 'C:/Project' } },
      productStateLoaded: true,
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    // Fold any pending chunks so later tests start from a clean module state.
    useStore.getState().flushPendingPaneOutputs();
  });

  it('merges a burst of chunks into one store write on a 50ms window', () => {
    const { appendPaneOutput } = useStore.getState();
    appendPaneOutput('pane-1', 'a');
    appendPaneOutput('pane-1', 'b');
    appendPaneOutput('pane-1', 'c');

    // High-frequency output must not rebuild terminalPanes per chunk.
    expect(useStore.getState().terminalPanes[0].output).toBe('start');

    vi.advanceTimersByTime(50);
    expect(useStore.getState().terminalPanes[0].output).toBe('startabc');
  });

  it('flushes pending chunks immediately for a quit/switch snapshot', () => {
    const { appendPaneOutput, flushPendingPaneOutputs } = useStore.getState();
    appendPaneOutput('pane-1', 'x');
    expect(useStore.getState().terminalPanes[0].output).toBe('start');

    flushPendingPaneOutputs();
    expect(useStore.getState().terminalPanes[0].output).toBe('startx');
    // Already drained — a second flush is a no-op.
    flushPendingPaneOutputs();
    expect(useStore.getState().terminalPanes[0].output).toBe('startx');
  });
});
