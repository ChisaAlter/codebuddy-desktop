import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../src/store';

function runtime(overrides = {}) {
  return {
    connectionState: 'connected',
    sessionId: 'session-1',
    timeline: [],
    permissionRequests: [],
    questions: [],
    usage: null,
    availableCommands: [],
    isAwaitingResponse: false,
    promptStartedAt: null,
    activePromptRunId: null,
    promptDispatched: false,
    promptQueue: [],
    pendingAttachments: [],
    promptSuggestion: null,
    teamState: null,
    agentPhase: null,
    progress: null,
    historyReplayActive: false,
    models: [],
    modes: [],
    currentModel: null,
    currentMode: 'default',
    capabilities: {},
    ...overrides,
  };
}

describe('store product state flush', () => {
  let saveProductState;
  let saveProductStateSync;

  beforeEach(() => {
    saveProductState = vi.fn().mockResolvedValue({ ok: true });
    saveProductStateSync = vi.fn().mockReturnValue({ ok: true, state: {} });
    window.electronAPI = {
      saveProductState,
      saveProductStateSync,
    };
    useStore.setState({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      projectOrder: ['project-1'],
      threadOrderByProject: { 'project-1': ['thread-1'] },
      projectsById: {
        'project-1': {
          id: 'project-1',
          name: 'Project',
          workspacePath: 'C:/Project',
          preferences: {},
        },
      },
      threadsById: {
        'thread-1': {
          id: 'thread-1',
          projectId: 'project-1',
          sessionId: 'session-1',
          title: 'Chat',
          draft: 'pending draft',
          timeline: [],
          metadata: {},
          status: 'idle',
        },
      },
      threadRuntimeById: {
        'thread-1': runtime({
          timeline: [{ id: 'msg-1', type: 'message', role: 'user', content: 'hello', createdAt: 1 }],
        }),
      },
      guiSettings: {},
      error: null,
      productStateLoaded: true,
    });
  });

  afterEach(() => {
    delete window.electronAPI;
  });

  it('returns false when saveProductStateSync is unavailable', () => {
    delete window.electronAPI.saveProductStateSync;
    expect(useStore.getState().flushProductStateSync()).toBe(false);
  });

  it('surfaces save failures and returns false', () => {
    saveProductStateSync.mockReturnValueOnce({ ok: false, error: 'disk full' });
    expect(useStore.getState().flushProductStateSync()).toBe(false);
    expect(useStore.getState().error).toContain('disk full');
  });

  it('treats malformed and failed async save envelopes as persistence failures', async () => {
    saveProductState.mockResolvedValueOnce(null);
    await expect(useStore.getState().persistProductState()).resolves.toBe(false);
    expect(useStore.getState().error).toContain('保存项目状态失败');

    useStore.setState({ error: null });
    saveProductState.mockResolvedValueOnce({ ok: false, error: 'disk full' });
    await expect(useStore.getState().persistProductState()).resolves.toBe(false);
    expect(useStore.getState().error).toContain('disk full');
  });

  it('flushes pending timeline timers into the sync snapshot', () => {
    useStore.getState().scheduleThreadTimelinePersist('thread-1');
    useStore.getState().patchThreadRuntime('thread-1', {
      timeline: [
        { id: 'msg-1', type: 'message', role: 'user', content: 'hello', createdAt: 1 },
        { id: 'msg-2', type: 'message', role: 'assistant', content: 'world', createdAt: 2 },
      ],
    });

    expect(useStore.getState().flushProductStateSync()).toBe(true);

    expect(saveProductStateSync).toHaveBeenCalledTimes(1);
    const snapshot = saveProductStateSync.mock.calls[0][0];
    expect(snapshot.threadsById['thread-1'].timeline.map((item) => item.id)).toEqual(['msg-1', 'msg-2']);
    expect(useStore.getState().threadsById['thread-1'].timeline.map((item) => item.id)).toEqual(['msg-1', 'msg-2']);
  });

  it('awaits concurrent async persist then flushes without throwing', async () => {
    let releaseSave;
    const saveStarted = new Promise((resolve) => {
      saveProductState.mockImplementationOnce(
        () =>
          new Promise((resolveSave) => {
            releaseSave = () => resolveSave({ ok: true });
            resolve();
          }),
      );
    });

    const pending = useStore.getState().persistProductState();
    await saveStarted;
    expect(useStore.getState().flushProductStateSync()).toBe(true);
    releaseSave();
    await expect(pending).resolves.toBe(true);
    expect(saveProductStateSync).toHaveBeenCalled();
  });

  // M-st5: a persist timer whose async body starts running after
  // flushProductStateSync cleared it must NOT overwrite the sync snapshot.
  it('does not overwrite the sync snapshot when a cleared persist timer fires late', async () => {
    // Schedule a timeline persist timer.
    useStore.getState().scheduleThreadTimelinePersist('thread-1');
    // The sync flush clears timers and writes a snapshot containing msg-2.
    useStore.getState().patchThreadRuntime('thread-1', {
      timeline: [
        { id: 'msg-1', type: 'message', role: 'user', content: 'hello', createdAt: 1 },
        { id: 'msg-2', type: 'message', role: 'assistant', content: 'sync', createdAt: 2 },
      ],
    });
    expect(useStore.getState().flushProductStateSync()).toBe(true);
    const syncSnapshot = saveProductStateSync.mock.calls[0][0];
    expect(syncSnapshot.threadsById['thread-1'].timeline.map((i) => i.content)).toContain('sync');

    // Advance fake timers so the cleared persist-timer callback (if any) would run.
    // With the owner-check fix, the callback bails out; without it, it would call
    // persistProductState and overwrite. Verify no extra async save happens.
    saveProductState.mockClear();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(saveProductState).not.toHaveBeenCalled();
  });

  // M-st6: when an external timeline patch arrives while the window is hidden
  // and stream chunks are coalesced, patchThreadRuntime must fold the coalesced
  // chunks into the patch instead of dropping them.
  it('folds coalesced stream chunks into an external timeline patch', () => {
    // Seed runtime with a baseline assistant message.
    useStore.setState((state) => ({
      threadRuntimeById: {
        ...state.threadRuntimeById,
        'thread-1': runtime({
          timeline: [{ id: 'base', type: 'message', role: 'assistant', content: 'base', createdAt: 1, streaming: true }],
        }),
      },
    }));
    // Pretend the window is hidden so appendThreadTimelineEvent coalesces.
    const originalHidden = document.hidden;
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    try {
      useStore.getState().appendThreadTimelineEvent('thread-1', 'agent_message_chunk', {
        messageId: 'chunk-1',
        content: { type: 'text', text: 'chunked-tail' },
      });
      // The coalesced entry holds the chunk; runtime.timeline still lacks it.
      const runtimeTimelineBefore = useStore.getState().threadRuntimeById['thread-1'].timeline;
      expect(JSON.stringify(runtimeTimelineBefore)).not.toContain('chunked-tail');
      // An external patch arrives with a timeline derived from the stale runtime
      // (e.g. closeAssistantStream(runtime.timeline)). Without the merge, the
      // coalesced chunk would be dropped on flush. patchThreadRuntime should fold
      // the coalesced entry so the chunk survives.
      const staleTimeline = useStore.getState().threadRuntimeById['thread-1'].timeline.map((i) => ({
        ...i,
        streaming: false,
      }));
      useStore.getState().patchThreadRuntime('thread-1', { timeline: staleTimeline });
      const merged = useStore.getState().threadRuntimeById['thread-1'].timeline;
      expect(JSON.stringify(merged)).toContain('chunked-tail');
    } finally {
      Object.defineProperty(document, 'hidden', { value: originalHidden, configurable: true });
    }
  });

  // M-st7: a thread persisted mid-prompt (status running/cancelling/waiting) is
  // normalized to 'idle' on hydrate so the UI does not show a phantom running
  // thread with no live runtime to cancel.
  it('normalizes ghost running/cancelling/waiting threads to idle on hydrate', async () => {
    window.electronAPI.loadProductState = vi.fn().mockResolvedValue({
      projectOrder: ['project-1'],
      projectsById: { 'project-1': { id: 'project-1', name: 'Project', workspacePath: 'C:/Project', preferences: {} } },
      threadOrderByProject: { 'project-1': ['thread-1', 'thread-2', 'thread-3'] },
      threadsById: {
        'thread-1': { id: 'thread-1', projectId: 'project-1', sessionId: 's1', title: 'A', status: 'running', timeline: [], metadata: {} },
        'thread-2': { id: 'thread-2', projectId: 'project-1', sessionId: 's2', title: 'B', status: 'cancelling', timeline: [], metadata: {} },
        'thread-3': { id: 'thread-3', projectId: 'project-1', sessionId: 's3', title: 'C', status: 'waiting', timeline: [], metadata: {} },
        'thread-4': { id: 'thread-4', projectId: 'project-1', sessionId: 's4', title: 'D', status: 'idle', timeline: [], metadata: {} },
      },
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
    });
    saveProductState.mockResolvedValue({ ok: true });

    await useStore.getState().hydrateProductState();

    const threads = useStore.getState().threadsById;
    expect(threads['thread-1'].status).toBe('idle');
    expect(threads['thread-2'].status).toBe('idle');
    expect(threads['thread-3'].status).toBe('idle');
    expect(threads['thread-4'].status).toBe('idle'); // already idle, unchanged
  });
});
