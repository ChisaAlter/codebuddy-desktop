import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cancelActivePrompt: vi.fn(),
  hasActivePrompt: vi.fn(),
  notify: vi.fn(),
  invalidateInteractiveRequests: vi.fn(),
  respondToPermissionRequest: vi.fn(),
  request: vi.fn(),
  submitQuestionAnswers: vi.fn(),
  cancelQuestionAnswers: vi.fn(),
}));

vi.mock('../../src/lib/acp', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    AcpClient: class {
      cancelActivePrompt = mocks.cancelActivePrompt;
      hasActivePrompt = mocks.hasActivePrompt;
      notify = mocks.notify;
    },
  };
});

import { useStore } from '../../src/store';

describe('store cancellation', () => {
  beforeEach(() => {
    mocks.cancelActivePrompt.mockReset();
    mocks.cancelActivePrompt.mockReturnValue(true);
    mocks.hasActivePrompt.mockReset();
    mocks.hasActivePrompt.mockReturnValue(true);
    mocks.notify.mockReset();
    mocks.notify.mockResolvedValue(true);
    mocks.invalidateInteractiveRequests.mockReset();
    mocks.respondToPermissionRequest.mockReset();
    mocks.request.mockReset();
    mocks.submitQuestionAnswers.mockReset();
    mocks.cancelQuestionAnswers.mockReset();
    useStore.setState({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      sessionId: 'session-123',
      projectsById: {
        'project-1': { id: 'project-1', workspacePath: 'C:/Project' },
      },
      threadsById: {
        'thread-1': {
          id: 'thread-1',
          projectId: 'project-1',
          sessionId: 'session-123',
          timeline: [],
          metadata: {},
          status: 'running',
        },
      },
      threadRuntimeById: {
        'thread-1': {
          activePromptRunId: 'run-1',
          promptDispatched: true,
          sessionId: 'session-123',
          timeline: [
            {
              id: 'assistant-1',
              type: 'message',
              role: 'assistant',
              content: 'Working',
              streaming: true,
              createdAt: Date.now(),
            },
          ],
        },
      },
      threadOrderByProject: { 'project-1': ['thread-1'] },
      getThreadClient: () => ({
        cancelActivePrompt: mocks.cancelActivePrompt,
        hasActivePrompt: mocks.hasActivePrompt,
        notify: mocks.notify,
        invalidateInteractiveRequests: mocks.invalidateInteractiveRequests,
        respondToPermissionRequest: mocks.respondToPermissionRequest,
        request: mocks.request,
        submitQuestionAnswers: mocks.submitQuestionAnswers,
        cancelQuestionAnswers: mocks.cancelQuestionAnswers,
      }),
      persistProductState: vi.fn().mockResolvedValue(true),
      isAwaitingResponse: true,
      error: null,
      timeline: [
        {
          id: 'assistant-1',
          type: 'message',
          role: 'assistant',
          content: 'Working',
          streaming: true,
          createdAt: Date.now(),
        },
      ],
    });
  });

  it('cancels the local stream and confirms backend cancellation through ACP', async () => {
    await expect(useStore.getState().cancelSession()).resolves.toBe(true);

    expect(mocks.cancelActivePrompt).toHaveBeenCalledWith('session-123');
    expect(mocks.notify).toHaveBeenCalledWith('session/cancel', { sessionId: 'session-123' });
    expect(useStore.getState().isAwaitingResponse).toBe(false);
    expect(useStore.getState().timeline.find((item) => item.role === 'assistant')?.streaming).toBe(false);
  });

  it('keeps the local task cancelled when backend cancellation confirmation fails', async () => {
    mocks.notify.mockRejectedValueOnce(new Error('cancel endpoint unavailable'));

    await expect(useStore.getState().cancelSession()).resolves.toBe(true);

    expect(mocks.cancelActivePrompt).toHaveBeenCalledWith('session-123');
    expect(useStore.getState().threadsById['thread-1'].status).toBe('cancelled');
    expect(useStore.getState().threadRuntimeById['thread-1'].activePromptRunId).toBeNull();
    expect(useStore.getState().error).toBeNull();
    expect(useStore.getState().threadsById['thread-1'].metadata.cancelWarning).toContain('已关闭本地请求流');
  });

  it('treats an unsupported session/cancel method as a compatible local cancellation', async () => {
    const methodNotFound = Object.assign(new Error('Method not found: session/cancel'), { code: -32601 });
    mocks.notify.mockRejectedValueOnce(methodNotFound);

    await expect(useStore.getState().cancelSession()).resolves.toBe(true);

    expect(mocks.cancelActivePrompt).toHaveBeenCalledWith('session-123');
    expect(useStore.getState().threadsById['thread-1'].status).toBe('cancelled');
    expect(useStore.getState().threadsById['thread-1'].metadata.cancelWarning).toBeNull();
    expect(useStore.getState().error).toBeNull();
  });

  it('clears history recovery and rejects late history chunks after cancellation completes', async () => {
    useStore.setState((state) => ({
      threadRuntimeById: {
        ...state.threadRuntimeById,
        'thread-1': {
          ...state.threadRuntimeById['thread-1'],
          historyReplayActive: true,
        },
      },
    }));

    await expect(useStore.getState().cancelSession()).resolves.toBe(true);
    useStore.getState().handleThreadSessionUpdate('thread-1', {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'late-history',
      content: { type: 'text', text: '不应写入' },
      _meta: { 'codebuddy.ai': { mode: 'history', offset: 99 } },
    });

    const runtime = useStore.getState().threadRuntimeById['thread-1'];
    expect(runtime.historyReplayActive).toBe(false);
    expect(runtime.timeline.some((item) => item.messageId === 'late-history')).toBe(false);
  });

  it('expires permission and question actions when cancellation completes', async () => {
    useStore.setState((state) => ({
      threadsById: {
        ...state.threadsById,
        'thread-1': { ...state.threadsById['thread-1'], status: 'waiting' },
      },
      threadRuntimeById: {
        ...state.threadRuntimeById,
        'thread-1': {
          ...state.threadRuntimeById['thread-1'],
          permissionRequests: [{ interruptionId: 'permission-1', toolCallId: 'tool-1' }],
          questions: [{ toolCallId: 'question-1' }],
          timeline: [
            ...state.threadRuntimeById['thread-1'].timeline,
            {
              id: 'permission-card',
              type: 'interruption',
              status: 'pending',
              meta: { interruptionId: 'permission-1', toolCallId: 'tool-1' },
            },
            {
              id: 'question-card',
              type: 'question',
              status: 'pending',
              meta: { toolCallId: 'question-1' },
            },
          ],
        },
      },
    }));

    await expect(useStore.getState().cancelSession()).resolves.toBe(true);

    const runtime = useStore.getState().threadRuntimeById['thread-1'];
    expect(mocks.invalidateInteractiveRequests).toHaveBeenCalledWith('session-cancelled');
    expect(runtime.permissionRequests).toEqual([]);
    expect(runtime.questions).toEqual([]);
    expect(runtime.timeline.find((item) => item.id === 'permission-card')?.status).toBe('cancelled');
    expect(runtime.timeline.find((item) => item.id === 'question-card')?.status).toBe('cancelled');

    await expect(useStore.getState().respondToInterruption('permission-1', 'allow', 'tool-1')).resolves.toBe(false);
    await expect(useStore.getState().submitQuestionAnswers('question-1', { answer: 'yes' })).resolves.toBe(false);
    await expect(useStore.getState().cancelQuestionAnswers('question-1')).resolves.toBe(false);
    expect(mocks.respondToPermissionRequest).not.toHaveBeenCalled();
    expect(mocks.submitQuestionAnswers).not.toHaveBeenCalled();
    expect(mocks.cancelQuestionAnswers).not.toHaveBeenCalled();
  });

  it('clears the prompt queue on local cancel so the next send does not drain a stale item', async () => {
    mocks.request.mockResolvedValue({ stopReason: 'end_turn' });
    useStore.setState((state) => ({
      threadRuntimeById: {
        ...state.threadRuntimeById,
        'thread-1': {
          ...state.threadRuntimeById['thread-1'],
          promptQueue: [{ id: 'queued-old', text: 'stale queued prompt' }],
        },
      },
    }));

    await expect(useStore.getState().cancelSession()).resolves.toBe(true);

    const runtime = useStore.getState().threadRuntimeById['thread-1'];
    expect(runtime.promptQueue).toEqual([]);
    expect(useStore.getState().threadsById['thread-1'].metadata.promptQueue).toEqual([]);

    mocks.request.mockClear();
    await useStore.getState().drainThreadPromptQueue('thread-1');
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('closes stale assistant streams when a project disconnects', async () => {
    await useStore.getState().disconnectProjectThreads('project-1');

    const runtime = useStore.getState().threadRuntimeById['thread-1'];
    expect(runtime.connectionState).toBe('disconnected');
    expect(runtime.isAwaitingResponse).toBe(false);
    expect(runtime.activePromptRunId).toBeNull();
    expect(runtime.promptDispatched).toBe(false);
    expect(runtime.timeline.find((item) => item.role === 'assistant')?.streaming).toBe(false);
  });
});
