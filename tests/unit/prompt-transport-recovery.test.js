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

describe('prompt transport failure recovery (no auto-resend)', () => {
  let request;

  beforeEach(() => {
    request = vi.fn();
    useStore.setState({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      projectsById: {
        'project-1': { id: 'project-1', workspacePath: 'C:/Project' },
      },
      threadsById: {
        'thread-1': { id: 'thread-1', projectId: 'project-1', sessionId: 'session-ready', metadata: {} },
      },
      threadRuntimeById: {
        'thread-1': runtime(),
      },
      ...runtime(),
      error: null,
      getThreadClient: () => ({ request, cancelActivePrompt: vi.fn().mockReturnValue(false) }),
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
      notifyThreadResult: vi.fn(),
    });
  });

  it('does NOT auto-resend after a transport failure; falls to history recovery then error', async () => {
    request
      .mockRejectedValueOnce(new Error('ipc stream died'))
      .mockRejectedValueOnce(new Error('history unavailable'));

    await expect(useStore.getState().runThreadPrompt('thread-1', 'hello')).resolves.toBe(false);

    const promptCalls = request.mock.calls.filter((call) => call[0] === 'session/prompt');
    expect(promptCalls).toHaveLength(1); // never resent
    // Recovery attempted via session/load
    expect(request.mock.calls.some((call) => call[0] === 'session/load')).toBe(true);
    expect(useStore.getState().threadsById['thread-1'].status).toBe('error');
  });

  it('does NOT auto-resend when the prompt was accepted; restores nothing (promptAccepted)', async () => {
    const accepted = new Error('stream ended after accept');
    accepted.promptAccepted = true;
    request
      .mockRejectedValueOnce(accepted)
      .mockRejectedValueOnce(new Error('history recovery unavailable'));

    await expect(
      useStore.getState().runThreadPrompt('thread-1', 'accepted prompt'),
    ).resolves.toBe(false);

    const promptCalls = request.mock.calls.filter((call) => call[0] === 'session/prompt');
    expect(promptCalls).toHaveLength(1);
    expect(useStore.getState().threadsById['thread-1'].draft).toBe('');
  });

  it('does NOT auto-resend when the turn already has activity (thinking chunk)', async () => {
    request
      .mockImplementationOnce(async () => {
        const promptRunId = useStore.getState().threadRuntimeById['thread-1'].activePromptRunId;
        useStore.getState().handleConversationEvent({
          threadId: 'thread-1',
          type: 'session/update',
          detail: {
            sessionId: 'session-ready',
            _client: { source: 'request', promptRunId },
            update: {
              sessionUpdate: 'agent_thought_chunk',
              messageId: 'thought-1',
              content: { type: 'text', text: 'thinking' },
            },
          },
        });
        throw new Error('ipc stream died');
      })
      .mockRejectedValueOnce(new Error('history unavailable'));

    await expect(useStore.getState().runThreadPrompt('thread-1', 'hello')).resolves.toBe(false);

    const promptCalls = request.mock.calls.filter((call) => call[0] === 'session/prompt');
    expect(promptCalls).toHaveLength(1);
    expect(useStore.getState().threadsById['thread-1'].status).toBe('error');
  });

  it('does NOT auto-resend for a non-transport RPC business error', async () => {
    request
      .mockRejectedValueOnce(new Error('rpc refused'))
      .mockResolvedValueOnce({ sessionId: 'session-ready' });

    await expect(useStore.getState().runThreadPrompt('thread-1', 'hello')).resolves.toBe(false);

    const promptCalls = request.mock.calls.filter((call) => call[0] === 'session/prompt');
    expect(promptCalls).toHaveLength(1);
  });

  it('restores the draft when recovery fails and the prompt was never accepted', async () => {
    request
      .mockRejectedValueOnce(new Error('connection rejected prompt'))
      .mockRejectedValueOnce(new Error('history unavailable'));

    await expect(
      useStore.getState().runThreadPrompt('thread-1', 'retry prompt'),
    ).resolves.toBe(false);

    expect(useStore.getState().threadsById['thread-1'].draft).toBe('retry prompt');
  });

  it('reports success when history recovery yields a final answer', async () => {
    request
      .mockRejectedValueOnce(new Error('ipc stream died'))
      .mockImplementationOnce(async () => {
        useStore.getState().handleConversationEvent({
          threadId: 'thread-1',
          type: 'session/update',
          detail: {
            sessionId: 'session-ready',
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'history-final',
              content: { type: 'text', text: '历史恢复的最终回答' },
              _meta: { 'codebuddy.ai': { mode: 'history', offset: 9 } },
            },
          },
        });
        return { sessionId: 'session-ready' };
      });

    await expect(useStore.getState().runThreadPrompt('thread-1', 'hello')).resolves.toBe(true);

    expect(useStore.getState().threadsById['thread-1'].status).toBe('idle');
    expect(
      useStore
        .getState()
        .threadRuntimeById['thread-1'].timeline.some((item) => item.content === '历史恢复的最终回答'),
    ).toBe(true);
  });

  // ===== Phase 4: 断连时历史恢复前置 restore；事件处理 =====

  it('connected=false 时 recover 先 reconnect 再 session/load', async () => {
    const reconnect = vi.fn().mockResolvedValue(true);
    useStore.setState({
      getThreadClient: () => ({
        connected: false,
        initialized: false,
        reconnect,
        request,
        cancelActivePrompt: vi.fn().mockReturnValue(false),
      }),
    });

    request
      .mockRejectedValueOnce(new Error('ipc stream died'))
      .mockImplementationOnce(async () => {
        useStore.getState().handleConversationEvent({
          threadId: 'thread-1',
          type: 'session/update',
          detail: {
            sessionId: 'session-ready',
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'hist-restored',
              content: { type: 'text', text: '恢复后的历史回答' },
              _meta: { 'codebuddy.ai': { mode: 'history', offset: 5 } },
            },
          },
        });
        return { sessionId: 'session-ready' };
      });

    await expect(useStore.getState().runThreadPrompt('thread-1', 'hello')).resolves.toBe(true);

    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(reconnect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-ready' }),
    );
    expect(useStore.getState().threadsById['thread-1'].status).toBe('idle');
  });

  it('reconnect 失败时 recover 返回 false → 草稿恢复 + 错误卡', async () => {
    const reconnect = vi.fn().mockResolvedValue(false);
    useStore.setState({
      getThreadClient: () => ({
        connected: false,
        initialized: false,
        reconnect,
        request,
        cancelActivePrompt: vi.fn().mockReturnValue(false),
      }),
    });
    request.mockRejectedValueOnce(new Error('ipc stream died'));

    await expect(
      useStore.getState().runThreadPrompt('thread-1', 'offline prompt'),
    ).resolves.toBe(false);

    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(useStore.getState().threadsById['thread-1'].status).toBe('error');
    expect(useStore.getState().threadsById['thread-1'].draft).toBe('offline prompt');
  });

  it('reconnected(sessionBound:false) 置 sessionRestoreNeeded', () => {
    useStore.getState().handleConversationEvent({
      threadId: 'thread-1',
      type: 'reconnected',
      detail: { attempts: 2, sessionBound: false },
    });
    expect(useStore.getState().threadRuntimeById['thread-1'].sessionRestoreNeeded).toBe(true);
  });

  it('reconnected(sessionBound:true) 清除 sessionRestoreNeeded', () => {
    useStore.setState((state) => ({
      threadRuntimeById: {
        ...state.threadRuntimeById,
        'thread-1': { ...state.threadRuntimeById['thread-1'], sessionRestoreNeeded: true },
      },
    }));
    useStore.getState().handleConversationEvent({
      threadId: 'thread-1',
      type: 'reconnected',
      detail: { attempts: 1, sessionBound: true },
    });
    expect(useStore.getState().threadRuntimeById['thread-1'].sessionRestoreNeeded).toBe(false);
  });

  it('session_invalid 写明确错误且不静默新建会话', async () => {
    useStore.getState().handleConversationEvent({
      threadId: 'thread-1',
      type: 'session_invalid',
      detail: { sessionId: 'session-ready' },
    });
    const thread = useStore.getState().threadsById['thread-1'];
    expect(thread.metadata?.sessionInvalid).toBe(true);
    expect(String(thread.metadata?.lastError || '')).toContain('会话已失效');
  });

  // ===== Delayed rebind: turn 终态后补 session/load =====

  function makeBoundClient() {
    const markSessionBound = vi.fn().mockReturnValue(true);
    useStore.setState({
      getThreadClient: () => ({
        connected: true,
        initialized: true,
        markSessionBound,
        request,
        cancelActivePrompt: vi.fn().mockReturnValue(false),
      }),
    });
    return markSessionBound;
  }

  it('成功终态后 sessionRestoreNeeded 触发 rebind：session/load + markSessionBound，重放事件不污染 timeline', async () => {
    const markSessionBound = makeBoundClient();
    useStore.setState((state) => ({
      threadRuntimeById: {
        ...state.threadRuntimeById,
        'thread-1': { ...state.threadRuntimeById['thread-1'], sessionRestoreNeeded: true },
      },
    }));
    request
      .mockImplementationOnce(async () => {
        // turn 有活动 → 成功终态，不触发 recoverPromptHistory
        const promptRunId = useStore.getState().threadRuntimeById['thread-1'].activePromptRunId;
        useStore.getState().handleConversationEvent({
          threadId: 'thread-1',
          type: 'session/update',
          detail: {
            sessionId: 'session-ready',
            _client: { source: 'request', promptRunId },
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'reply-1',
              content: { type: 'text', text: 'done' },
            },
          },
        });
        return { stopReason: 'end_turn' };
      })
      .mockImplementationOnce(async () => {
        // rebind 的 session/load 重放一条历史事件：终态后应被门控丢弃
        useStore.getState().handleConversationEvent({
          threadId: 'thread-1',
          type: 'session/update',
          detail: {
            sessionId: 'session-ready',
            _client: { source: 'request', historyReplay: true },
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'rebind-hist',
              content: { type: 'text', text: 'REBIND_HISTORY' },
              _meta: { 'codebuddy.ai': { mode: 'history' } },
            },
          },
        });
        return { sessionId: 'session-ready' };
      });

    await expect(useStore.getState().runThreadPrompt('thread-1', 'hello')).resolves.toBe(true);

    // 第二次 request 调用是 rebind 的 session/load
    expect(request.mock.calls[1][0]).toBe('session/load');
    expect(markSessionBound).toHaveBeenCalledWith('session-ready', expect.anything());
    // 重放事件被终态门控丢弃，timeline 无 REBIND_HISTORY
    expect(
      useStore
        .getState()
        .threadRuntimeById['thread-1'].timeline.some((item) => item.content === 'REBIND_HISTORY'),
    ).toBe(false);
  });

  it('失败终态后同样触发 rebind', async () => {
    const markSessionBound = makeBoundClient();
    useStore.setState((state) => ({
      threadRuntimeById: {
        ...state.threadRuntimeById,
        'thread-1': { ...state.threadRuntimeById['thread-1'], sessionRestoreNeeded: true },
      },
    }));
    request
      .mockRejectedValueOnce(new Error('ipc stream died'))
      .mockRejectedValueOnce(new Error('history unavailable'))
      .mockResolvedValueOnce({ sessionId: 'session-ready' }); // rebind session/load

    await expect(useStore.getState().runThreadPrompt('thread-1', 'hello')).resolves.toBe(false);

    expect(request.mock.calls.some((call) => call[0] === 'session/load')).toBe(true);
    expect(markSessionBound).toHaveBeenCalledWith('session-ready', expect.anything());
  });

  it('rebindSessionAfterTurn：active turn 存在时不执行 session/load', async () => {
    const markSessionBound = makeBoundClient();
    useStore.setState((state) => ({
      threadRuntimeById: {
        ...state.threadRuntimeById,
        'thread-1': {
          ...state.threadRuntimeById['thread-1'],
          sessionRestoreNeeded: true,
          activePromptRunId: 'run-active',
        },
      },
    }));

    const result = await useStore.getState().rebindSessionAfterTurn('thread-1');
    expect(result).toBe(false);
    expect(request.mock.calls.filter((call) => call[0] === 'session/load')).toHaveLength(0);
    expect(markSessionBound).not.toHaveBeenCalled();
  });

  it('rebindSessionAfterTurn：sessionRestoreNeeded=false 时不执行 session/load', async () => {
    const markSessionBound = makeBoundClient();
    const result = await useStore.getState().rebindSessionAfterTurn('thread-1');
    expect(result).toBe(false);
    expect(request.mock.calls.filter((call) => call[0] === 'session/load')).toHaveLength(0);
    expect(markSessionBound).not.toHaveBeenCalled();
  });

  it('rebindSessionAfterTurn：session/load 失败保留标记且不抛', async () => {
    makeBoundClient();
    useStore.setState((state) => ({
      threadRuntimeById: {
        ...state.threadRuntimeById,
        'thread-1': { ...state.threadRuntimeById['thread-1'], sessionRestoreNeeded: true },
      },
    }));
    request.mockRejectedValueOnce(new Error('session gone'));

    const result = await useStore.getState().rebindSessionAfterTurn('thread-1');
    expect(result).toBe(false);
    // 标记保留，下次操作再试
    expect(useStore.getState().threadRuntimeById['thread-1'].sessionRestoreNeeded).toBe(true);
  });
});
