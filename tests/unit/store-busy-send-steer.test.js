// G3: busySendMode=immediate — session/steer 注入当前回合 + 队列条目「立即发送」。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../src/store';

function runtime(overrides = {}) {
  return {
    connectionState: 'connected',
    sessionId: 'session-ready',
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
    currentModel: 'hy3',
    currentMode: 'default',
    capabilities: {},
    ...overrides,
  };
}

function busyRuntime(overrides = {}) {
  return runtime({
    isAwaitingResponse: true,
    activePromptRunId: 'run-live',
    promptStartedAt: Date.now(),
    ...overrides,
  });
}

describe('busySendMode=immediate steer (G3)', () => {
  let request;

  beforeEach(() => {
    request = vi.fn().mockResolvedValue({ steered: true });
    useStore.setState({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      settings: { codebuddy: { composer: { busySendMode: 'immediate' } } },
      projectsById: {
        'project-1': { id: 'project-1', workspacePath: 'C:/Project' },
      },
      threadsById: {
        'thread-1': { id: 'thread-1', projectId: 'project-1', sessionId: null, status: 'running', metadata: {} },
      },
      threadRuntimeById: {
        'thread-1': busyRuntime(),
      },
      ...busyRuntime(),
      error: null,
      getThreadClient: () => ({ request }),
      updateThreadRecord: vi.fn().mockImplementation(async (threadId, patch) => {
        useStore.setState((state) => ({
          threadsById: {
            ...state.threadsById,
            [threadId]: { ...state.threadsById[threadId], ...patch },
          },
        }));
        return true;
      }),
      persistProductState: vi.fn().mockResolvedValue(true),
      drainThreadPromptQueue: vi.fn(),
      notifyThreadResult: vi.fn(),
    });
  });

  it('injects a busy message into the current turn via session/steer', async () => {
    const result = await useStore.getState().sendPrompt('add tests too');

    expect(result).toMatchObject({ steered: true });
    expect(request).toHaveBeenCalledWith('session/steer', {
      sessionId: 'session-ready',
      contentBlocks: expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'add tests too' })]),
    });
    const state = useStore.getState();
    expect(state.threadRuntimeById['thread-1'].promptQueue).toHaveLength(0);
    const timeline = state.threadRuntimeById['thread-1'].timeline;
    expect(timeline[timeline.length - 1]).toMatchObject({ role: 'user', content: 'add tests too' });
  });

  it('always queues slash commands even in immediate mode', async () => {
    const result = await useStore.getState().sendPrompt('/compact');

    expect(result).toMatchObject({ queued: true });
    expect(request).not.toHaveBeenCalled();
    expect(useStore.getState().threadRuntimeById['thread-1'].promptQueue).toHaveLength(1);
  });

  it('falls back to the queue when the CLI rejects the steer', async () => {
    request.mockResolvedValueOnce({ steered: false, reason: 'not-steerable' });

    const result = await useStore.getState().sendPrompt('fallback please');

    expect(result).toMatchObject({ queued: true });
    expect(useStore.getState().threadRuntimeById['thread-1'].promptQueue).toHaveLength(1);
  });

  it('queues in queue mode without calling session/steer', async () => {
    useStore.setState({ settings: { codebuddy: { composer: { busySendMode: 'queue' } } } });

    const result = await useStore.getState().sendPrompt('normal message');

    expect(result).toMatchObject({ queued: true });
    expect(request).not.toHaveBeenCalled();
  });

  it('sendQueuedPromptNow steers a queued item into the live turn and removes it', async () => {
    useStore.setState((state) => ({
      threadRuntimeById: {
        ...state.threadRuntimeById,
        'thread-1': busyRuntime({
          promptQueue: [
            { id: 'q1', text: 'first queued', attachments: [] },
            { id: 'q2', text: 'second queued', attachments: [] },
          ],
        }),
      },
    }));

    const result = await useStore.getState().sendQueuedPromptNow('thread-1', 'q2');

    expect(result).toMatchObject({ steered: true });
    expect(request).toHaveBeenCalledWith('session/steer', expect.objectContaining({ sessionId: 'session-ready' }));
    const queue = useStore.getState().threadRuntimeById['thread-1'].promptQueue;
    expect(queue.map((item) => item.id)).toEqual(['q1']);
  });

  it('sendQueuedPromptNow without a live turn moves the item to the front and drains', async () => {
    useStore.setState((state) => ({
      threadsById: {
        ...state.threadsById,
        'thread-1': { ...state.threadsById['thread-1'], status: 'idle' },
      },
      threadRuntimeById: {
        ...state.threadRuntimeById,
        'thread-1': runtime({
          promptQueue: [
            { id: 'q1', text: 'first queued', attachments: [] },
            { id: 'q2', text: 'second queued', attachments: [] },
          ],
        }),
      },
    }));

    const result = await useStore.getState().sendQueuedPromptNow('thread-1', 'q2');

    expect(result).toMatchObject({ queued: true, steered: false });
    expect(request).not.toHaveBeenCalled();
    const queue = useStore.getState().threadRuntimeById['thread-1'].promptQueue;
    expect(queue.map((item) => item.id)).toEqual(['q2', 'q1']);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(useStore.getState().drainThreadPromptQueue).toHaveBeenCalledWith('thread-1');
  });
});
