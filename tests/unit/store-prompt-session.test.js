import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hasCompletePromptResponse, hasUsableAssistantBody, useStore } from '../../src/store';

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

describe('store prompt session selection', () => {
  let request;

  beforeEach(() => {
    request = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });
    useStore.setState({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      projectsById: {
        'project-1': { id: 'project-1', workspacePath: 'C:/Project' },
      },
      threadsById: {
        'thread-1': { id: 'thread-1', projectId: 'project-1', sessionId: null, metadata: {} },
      },
      threadRuntimeById: {
        'thread-1': runtime(),
      },
      ...runtime(),
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
      notifyThreadResult: vi.fn(),
    });
  });

  it('accepts a final assistant answer followed by bookkeeping events', () => {
    const promptStartedAt = 1000;
    const timeline = [
      { id: 'prompt-1', type: 'message', role: 'user', content: 'hello', createdAt: promptStartedAt },
      { id: 'tool-1', type: 'tool_call', role: 'assistant', status: 'completed', createdAt: 1100 },
      { id: 'final-1', type: 'message', role: 'assistant', content: 'done', createdAt: 1200 },
      { id: 'checkpoint-1', type: 'checkpoint', status: 'completed', createdAt: 1300 },
      { id: 'goal-1', type: 'goal-status', status: 'completed', createdAt: 1400 },
    ];

    expect(hasCompletePromptResponse(timeline, 'prompt-1', promptStartedAt)).toBe(true);
  });

  it('rejects incomplete prompt responses that only have thinking, tools, or empty assistant text', () => {
    const promptStartedAt = 1000;
    const prompt = { id: 'prompt-1', type: 'message', role: 'user', content: 'hello', createdAt: promptStartedAt };

    expect(
      hasCompletePromptResponse(
        [prompt, { id: 'think-1', type: 'thinking', content: '…', createdAt: 1100 }],
        'prompt-1',
        promptStartedAt,
      ),
    ).toBe(false);
    expect(
      hasCompletePromptResponse(
        [prompt, { id: 'tool-1', type: 'tool_call', role: 'assistant', status: 'completed', createdAt: 1100 }],
        'prompt-1',
        promptStartedAt,
      ),
    ).toBe(false);
    expect(
      hasCompletePromptResponse(
        [prompt, { id: 'empty-1', type: 'message', role: 'assistant', content: '   ', createdAt: 1200 }],
        'prompt-1',
        promptStartedAt,
      ),
    ).toBe(false);
    expect(
      hasCompletePromptResponse(
        [
          prompt,
          { id: 'early-1', type: 'message', role: 'assistant', content: 'partial', createdAt: 1100 },
          { id: 'tool-1', type: 'tool_call', role: 'assistant', status: 'completed', createdAt: 1200 },
        ],
        'prompt-1',
        promptStartedAt,
      ),
    ).toBe(false);
  });

  it('treats pre-tool assistant narrative as a usable body even without a post-tool summary', () => {
    const promptStartedAt = 1000;
    const prompt = { id: 'prompt-1', type: 'message', role: 'user', content: 'hello', createdAt: promptStartedAt };
    const timeline = [
      prompt,
      { id: 'early-1', type: 'message', role: 'assistant', content: '按上次建议直接更新现有 CODEBUDDY.md。', createdAt: 1100 },
      { id: 'tool-1', type: 'tool_call', role: 'assistant', status: 'completed', createdAt: 1200 },
      { id: 'tool-2', type: 'tool_call', role: 'assistant', status: 'completed', createdAt: 1300 },
    ];

    expect(hasCompletePromptResponse(timeline, 'prompt-1', promptStartedAt)).toBe(false);
    expect(hasUsableAssistantBody(timeline, 'prompt-1', promptStartedAt)).toBe(true);
    expect(hasUsableAssistantBody([prompt, { id: 'think-1', type: 'thinking', content: '…' }], 'prompt-1', promptStartedAt)).toBe(
      false,
    );
  });

  it('does not call session/prompt when neither the thread record nor runtime has a session id', async () => {
    useStore.setState((state) => ({
      sessionId: null,
      threadsById: {
        ...state.threadsById,
        'thread-1': { ...state.threadsById['thread-1'], sessionId: null },
      },
      threadRuntimeById: {
        ...state.threadRuntimeById,
        'thread-1': runtime({ sessionId: null }),
      },
      ...runtime({ sessionId: null }),
    }));

    await expect(useStore.getState().runThreadPrompt('thread-1', 'hello')).resolves.toBe(false);

    expect(request).not.toHaveBeenCalled();
    expect(useStore.getState().error).toContain('尚未完成连接');
  });

  it('aborts success handling when the thread session changes mid-flight', async () => {
    request.mockImplementationOnce(async () => {
      useStore.setState((state) => ({
        threadsById: {
          ...state.threadsById,
          'thread-1': { ...state.threadsById['thread-1'], sessionId: 'session-switched' },
        },
        threadRuntimeById: {
          ...state.threadRuntimeById,
          'thread-1': {
            ...state.threadRuntimeById['thread-1'],
            sessionId: 'session-switched',
          },
        },
      }));
      return { stopReason: 'end_turn' };
    });

    await expect(useStore.getState().runThreadPrompt('thread-1', 'hello')).resolves.toBe(false);

    expect(request).toHaveBeenCalledWith(
      'session/prompt',
      {
        sessionId: 'session-ready',
        prompt: [{ type: 'text', text: 'hello' }],
      },
      { promptRunId: expect.stringMatching(/^run-/) },
    );
    expect(useStore.getState().threadsById['thread-1'].status).not.toBe('error');
    expect(useStore.getState().error).toBeNull();
  });

  it('uses the connected runtime session while the persisted thread record is still catching up', async () => {
    request.mockImplementationOnce(async () => {
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
    });

    await expect(useStore.getState().runThreadPrompt('thread-1', 'hello')).resolves.toBe(true);

    expect(request).toHaveBeenCalledWith(
      'session/prompt',
      {
        sessionId: 'session-ready',
        prompt: [{ type: 'text', text: 'hello' }],
      },
      { promptRunId: expect.stringMatching(/^run-/) },
    );
  });

  it('ignores a late content event that belongs to an older prompt run', async () => {
    request.mockImplementationOnce(async () => {
      const activePromptRunId = useStore.getState().threadRuntimeById['thread-1'].activePromptRunId;
      useStore.getState().handleConversationEvent({
        threadId: 'thread-1',
        type: 'session/update',
        detail: {
          sessionId: 'session-ready',
          _client: { source: 'request', promptRunId: 'run-old' },
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'old-late',
            content: { type: 'text', text: 'OLD_LATE' },
          },
        },
      });
      useStore.getState().handleConversationEvent({
        threadId: 'thread-1',
        type: 'session/update',
        detail: {
          sessionId: 'session-ready',
          _client: { source: 'request', promptRunId: activePromptRunId },
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'current-reply',
            content: { type: 'text', text: 'CURRENT_REPLY' },
          },
        },
      });
      return { stopReason: 'end_turn' };
    });

    await expect(useStore.getState().runThreadPrompt('thread-1', 'NEW_PROMPT')).resolves.toBe(true);

    const timeline = useStore.getState().threadRuntimeById['thread-1'].timeline;
    expect(timeline.some((item) => item.content === 'OLD_LATE')).toBe(false);
    expect(timeline.some((item) => item.content === 'CURRENT_REPLY')).toBe(true);
  });
  it('recovers a missing final response from session history before reporting success', async () => {
    request
      .mockResolvedValueOnce({ stopReason: 'end_turn' })
      .mockImplementationOnce(async () => {
        useStore.getState().handleConversationEvent({
          threadId: 'thread-1',
          type: 'session/update',
          detail: {
            sessionId: 'session-ready',
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'history-final',
              content: { type: 'text', text: '历史中恢复的最终回答' },
              _meta: { 'codebuddy.ai': { mode: 'history', offset: 9 } },
            },
          },
        });
        return { sessionId: 'session-ready' };
      });

    await expect(useStore.getState().runThreadPrompt('thread-1', 'hello')).resolves.toBe(true);

    expect(request).toHaveBeenNthCalledWith(
      2,
      'session/load',
      {
        sessionId: 'session-ready',
        cwd: 'C:/Project',
        mcpServers: [],
      },
      { promptRunId: expect.stringMatching(/^run-/), historyReplay: true },
    );
    expect(
      useStore
        .getState()
        .threadRuntimeById['thread-1'].timeline.some((item) => item.content === '历史中恢复的最终回答'),
    ).toBe(true);
  });

  it('preserves the user-selected model when history recovery reports a stale backend default', async () => {
    useStore.setState((state) => ({
      currentModel: 'grok-4.5',
      models: [
        { id: 'grok-4.5', name: 'Grok 4.5' },
        { id: 'hy3', name: 'Hy3' },
      ],
      threadsById: {
        ...state.threadsById,
        'thread-1': { ...state.threadsById['thread-1'], modelId: 'grok-4.5' },
      },
      threadRuntimeById: {
        ...state.threadRuntimeById,
        'thread-1': runtime({
          currentModel: 'grok-4.5',
          models: [
            { id: 'grok-4.5', name: 'Grok 4.5' },
            { id: 'hy3', name: 'Hy3' },
          ],
        }),
      },
    }));
    request
      .mockResolvedValueOnce({ stopReason: 'end_turn' })
      .mockImplementationOnce(async () => {
        useStore.getState().handleConversationEvent({
          threadId: 'thread-1',
          type: 'session/update',
          detail: {
            sessionId: 'session-ready',
            update: {
              sessionUpdate: 'config_option_update',
              configOptions: [
                {
                  id: 'model',
                  currentValue: 'hy3',
                  options: [
                    { value: 'grok-4.5', name: 'Grok 4.5' },
                    { value: 'hy3', name: 'Hy3' },
                  ],
                },
              ],
            },
          },
        });
        useStore.getState().handleConversationEvent({
          threadId: 'thread-1',
          type: 'model_update',
          detail: {
            currentModelId: 'hy3',
            availableModels: [
              { id: 'grok-4.5', name: 'Grok 4.5' },
              { id: 'hy3', name: 'Hy3' },
            ],
          },
        });
        useStore.getState().handleConversationEvent({
          threadId: 'thread-1',
          type: 'session/update',
          detail: {
            sessionId: 'session-ready',
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'history-final',
              content: { type: 'text', text: '历史恢复后的最终回答' },
              _meta: { 'codebuddy.ai': { mode: 'history', offset: 10 } },
            },
          },
        });
        return { sessionId: 'session-ready' };
      });

    await expect(useStore.getState().runThreadPrompt('thread-1', 'hello')).resolves.toBe(true);

    expect(useStore.getState().currentModel).toBe('grok-4.5');
    expect(useStore.getState().threadRuntimeById['thread-1'].currentModel).toBe('grok-4.5');
    expect(useStore.getState().threadsById['thread-1'].modelId).toBe('grok-4.5');

  });

  it('preserves model and mode selections when a backend session reset loads stale defaults', async () => {
    const resetRequest = vi.fn().mockResolvedValue({
      sessionId: 'session-reset',
      title: 'Reset session',
      models: {
        currentModelId: 'hy3',
        availableModels: [
          { id: 'grok-4.5', name: 'Grok 4.5' },
          { id: 'hy3', name: 'Hy3' },
        ],
      },
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'delegate', name: 'Delegate' },
        ],
      },
    });
    useStore.setState((state) => ({
      currentModel: 'grok-4.5',
      currentMode: 'delegate',
      threadsById: {
        ...state.threadsById,
        'thread-1': {
          ...state.threadsById['thread-1'],
          sessionId: 'session-old',
          modelId: 'custom-local:grok-4.5',
          modeId: 'delegate',
        },
      },
      threadRuntimeById: {
        ...state.threadRuntimeById,
        'thread-1': runtime({
          sessionId: 'session-old',
          currentModel: 'custom-local:grok-4.5',
          currentMode: 'delegate',
          models: [
            { id: 'grok-4.5', name: 'Grok 4.5' },
            { id: 'hy3', name: 'Hy3' },
          ],
          modes: [
            { id: 'default', name: 'Default' },
            { id: 'delegate', name: 'Delegate' },
          ],
        }),
      },
      getThreadClient: () => ({ connected: true, request: resetRequest }),
      refreshSessions: vi.fn().mockResolvedValue(true),
    }));

    await expect(useStore.getState().handleThreadSessionReset('thread-1', 'session-reset')).resolves.toBe(true);

    // GUI 保留了 delegate/model，CLI 加载返回 default/hy3 → 必须写回 CLI
    expect(resetRequest).toHaveBeenCalledWith('session/set_mode', {
      sessionId: 'session-reset',
      modeId: 'delegate',
    });
    expect(resetRequest).toHaveBeenCalledWith('session/set_model', {
      sessionId: 'session-reset',
      modelId: 'grok-4.5',
    });

    const state = useStore.getState();
    expect(state.currentModel).toBe('grok-4.5');
    expect(state.currentMode).toBe('delegate');
    expect(state.threadRuntimeById['thread-1']).toMatchObject({
      currentModel: 'grok-4.5',
      currentMode: 'delegate',
    });
    expect(state.threadsById['thread-1']).toMatchObject({
      modelId: 'grok-4.5',
      modeId: 'delegate',
    });
  });

  it('still accepts an authoritative model update outside history replay', () => {
    useStore.setState((state) => ({
      currentModel: 'grok-4.5',
      threadsById: {
        ...state.threadsById,
        'thread-1': { ...state.threadsById['thread-1'], modelId: 'grok-4.5' },
      },
      threadRuntimeById: {
        ...state.threadRuntimeById,
        'thread-1': runtime({ currentModel: 'grok-4.5', historyReplayActive: false }),
      },
    }));

    useStore.getState().handleConversationEvent({
      threadId: 'thread-1',
      type: 'model_update',
      detail: { currentModelId: 'hy3', availableModels: [{ id: 'hy3', name: 'Hy3' }] },
    });

    expect(useStore.getState().currentModel).toBe('hy3');
    expect(useStore.getState().threadRuntimeById['thread-1'].currentModel).toBe('hy3');
    expect(useStore.getState().threadsById['thread-1'].modelId).toBe('hy3');
  });
  it('still applies an explicit model selection through setModel', async () => {
    useStore.setState((state) => ({
      sessionId: 'session-ready',
      threadsById: {
        ...state.threadsById,
        'thread-1': { ...state.threadsById['thread-1'], sessionId: 'session-ready', modelId: 'hy3' },
      },
    }));

    await expect(useStore.getState().setModel('grok-4.5')).resolves.toBe(true);

    expect(request).toHaveBeenCalledWith('session/set_model', {
      sessionId: 'session-ready',
      modelId: 'grok-4.5',
    });
    expect(useStore.getState().currentModel).toBe('grok-4.5');
    expect(useStore.getState().threadRuntimeById['thread-1'].currentModel).toBe('grok-4.5');
    expect(useStore.getState().threadsById['thread-1'].modelId).toBe('grok-4.5');
  });
  it('does not restore an accepted prompt when transport and history recovery both fail', async () => {
    const attachment = { kind: 'text', name: 'note.txt', path: 'C:/Project/note.txt', text: 'hello' };
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
              messageId: 'accepted-thinking',
              content: { type: 'text', text: 'working' },
            },
          },
        });
        throw new Error('prompt transport ended');
      })
      .mockRejectedValueOnce(new Error('history recovery unavailable'));

    await expect(
      useStore.getState().runThreadPrompt('thread-1', 'accepted prompt', [attachment], 'accepted prompt'),
    ).resolves.toBe(false);

    const state = useStore.getState();
    expect(state.threadsById['thread-1'].status).toBe('error');
    expect(state.threadsById['thread-1'].draft).toBe('');
    expect(state.threadRuntimeById['thread-1'].pendingAttachments).toEqual([]);
    expect(state.error).toContain('history recovery unavailable');
  });

  it('does not restore input when the transport received a matching prompt result before failing', async () => {
    const attachment = { kind: 'text', name: 'result.txt', path: 'C:/Project/result.txt', text: 'result' };
    request
      .mockRejectedValueOnce(Object.assign(new Error('malformed stream tail'), { promptAccepted: true }))
      .mockRejectedValueOnce(new Error('history recovery unavailable'));

    await expect(
      useStore.getState().runThreadPrompt('thread-1', 'accepted by result', [attachment], 'accepted by result'),
    ).resolves.toBe(false);

    const state = useStore.getState();
    expect(state.threadsById['thread-1'].draft).toBe('');
    expect(state.threadRuntimeById['thread-1'].pendingAttachments).toEqual([]);
    expect(state.error).toContain('history recovery unavailable');
  });

  it('restores draft and attachments when the prompt failed before any acceptance evidence', async () => {
    const attachment = { kind: 'text', name: 'retry.txt', path: 'C:/Project/retry.txt', text: 'retry' };
    request
      .mockRejectedValueOnce(new Error('connection rejected prompt'))
      .mockRejectedValueOnce(new Error('history unavailable'));

    await expect(
      useStore.getState().runThreadPrompt('thread-1', 'retry prompt', [attachment], 'retry prompt'),
    ).resolves.toBe(false);

    const state = useStore.getState();
    expect(state.threadsById['thread-1'].draft).toBe('retry prompt');
    expect(state.threadRuntimeById['thread-1'].pendingAttachments).toEqual([attachment]);
    expect(state.error).toContain('connection rejected prompt');
  });

  it('marks the thread as error when end_turn has no final response and history recovery is empty', async () => {
    request.mockResolvedValueOnce({ stopReason: 'end_turn' }).mockResolvedValueOnce({ sessionId: 'session-ready' });

    await expect(useStore.getState().runThreadPrompt('thread-1', 'hello')).resolves.toBe(false);

    expect(useStore.getState().threadsById['thread-1'].status).toBe('error');
    expect(useStore.getState().error).toContain('最终正文未送达');
    expect(useStore.getState().threadsById['thread-1'].draft).toBe('');
  });

  it('soft-succeeds when tools finish without a post-tool summary but pre-tool body already arrived', async () => {
    request.mockImplementationOnce(async () => {
      const promptRunId = useStore.getState().threadRuntimeById['thread-1'].activePromptRunId;
      useStore.getState().handleConversationEvent({
        threadId: 'thread-1',
        type: 'session/update',
        detail: {
          sessionId: 'session-ready',
          _client: { source: 'request', promptRunId },
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'pre-tool',
            content: { type: 'text', text: '按上次建议直接更新现有 CODEBUDDY.md。' },
          },
        },
      });
      useStore.getState().handleConversationEvent({
        threadId: 'thread-1',
        type: 'session/update',
        detail: {
          sessionId: 'session-ready',
          _client: { source: 'request', promptRunId },
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-read-1',
            title: 'Read CODEBUDDY.md',
            status: 'completed',
          },
        },
      });
      return { stopReason: 'end_turn' };
    });

    await expect(useStore.getState().runThreadPrompt('thread-1', '/init')).resolves.toBe(true);

    const state = useStore.getState();
    expect(state.threadsById['thread-1'].status).toBe('idle');
    expect(state.error).toBeNull();
    expect(
      state.threadRuntimeById['thread-1'].timeline.some((item) =>
        String(item.content || '').includes('CODEBUDDY.md'),
      ),
    ).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not force re-login when prompt refusal is a network/proxy 502', async () => {
    useStore.setState({
      codeBuddyAccountAuthState: 'authenticated',
      codeBuddyAccountUser: { userNickname: 'Chisa', userId: 'u1' },
      guiSettings: {
        ...(useStore.getState().guiSettings || {}),
        lastAccountUser: { userNickname: 'Chisa', userId: 'u1' },
      },
    });
    const html502 =
      '502 <html><head><title>502 Bad Gateway</title></head></html> (proxy: http://127.0.0.1:10809 -> https://ayase.cn)';
    request.mockResolvedValueOnce({
      stopReason: 'refusal',
      category: 'network',
      errorMessage: html502,
    });

    await expect(useStore.getState().runThreadPrompt('thread-1', 'hello')).resolves.toBe(false);

    const state = useStore.getState();
    expect(state.codeBuddyAccountAuthState).toBe('authenticated');
    expect(state.codeBuddyAccountUser).toMatchObject({ userNickname: 'Chisa' });
    expect(state.threadsById['thread-1'].metadata?.authRequired).not.toBe(true);
    expect(String(state.error || state.threadsById['thread-1'].metadata?.lastError || '')).toMatch(
      /502|网络|代理|模型请求失败/,
    );
  });

  it('surfaces network details when CLI only embeds category inside errorMessage JSON', async () => {
    useStore.setState({
      codeBuddyAccountAuthState: 'authenticated',
      codeBuddyAccountUser: { userNickname: 'Chisa', userId: 'u1' },
      guiSettings: {
        ...(useStore.getState().guiSettings || {}),
        lastAccountUser: { userNickname: 'Chisa', userId: 'u1' },
      },
    });
    const details =
      '502 <html><head><title>502 Bad Gateway</title></head></html> (proxy: http://127.0.0.1:10809 -> https://ayase.cn)';
    request.mockResolvedValueOnce({
      stopReason: 'refusal',
      // Real CLI shape: no top-level category; JSON errorMessage from RequestError.toErrorResponse().
      errorMessage: JSON.stringify({
        code: -32001,
        message: `Network error: ${details}`,
        data: { category: 'network', statusCode: 502, details, code: 502 },
      }),
    });

    await expect(useStore.getState().runThreadPrompt('thread-1', 'hello')).resolves.toBe(false);

    const state = useStore.getState();
    expect(state.codeBuddyAccountAuthState).toBe('authenticated');
    expect(state.threadsById['thread-1'].metadata?.authRequired).not.toBe(true);
    const err = String(state.error || state.threadsById['thread-1'].metadata?.lastError || '');
    expect(err).toMatch(/HTTP 502|502/);
    expect(err).toMatch(/不是登录失效|网络|代理|模型请求失败/);
    expect(err).not.toMatch(/请求被拒绝/);
    expect(err).not.toMatch(/<\s*html/i);
  });

  it('marks cloud auth required only for explicit auth refusals', async () => {
    useStore.setState({
      codeBuddyAccountAuthState: 'authenticated',
      codeBuddyAccountUser: { userNickname: 'Chisa', userId: 'u1' },
      guiSettings: {
        ...(useStore.getState().guiSettings || {}),
        lastAccountUser: { userNickname: 'Chisa', userId: 'u1' },
      },
    });
    request.mockResolvedValueOnce({
      stopReason: 'refusal',
      category: 'auth',
      errorMessage: 'Authentication required',
    });

    await expect(useStore.getState().runThreadPrompt('thread-1', 'hello')).resolves.toBe(false);

    const state = useStore.getState();
    expect(state.codeBuddyAccountAuthState).toBe('required');
    expect(state.threadsById['thread-1'].metadata?.authRequired).toBe(true);
    expect(state.guiSettings?.lastAccountUser).toMatchObject({ userNickname: 'Chisa' });
  });

  it('queues a new message while the session is waiting for permission', async () => {
    useStore.setState((state) => ({
      threadsById: {
        ...state.threadsById,
        'thread-1': { ...state.threadsById['thread-1'], status: 'waiting' },
      },
    }));

    await expect(useStore.getState().sendPrompt('queued')).resolves.toMatchObject({ queued: true });

    expect(request).not.toHaveBeenCalled();
    expect(useStore.getState().threadRuntimeById['thread-1'].promptQueue).toHaveLength(1);
  });

  it('does not launch session/prompt when Stop is clicked during preflight persistence', async () => {
    let releasePreflight;
    let markPreflightStarted;
    const preflightStarted = new Promise((resolve) => {
      markPreflightStarted = resolve;
    });
    const updateThreadRecord = vi
      .fn()
      .mockImplementationOnce(async () => {
        markPreflightStarted();
        await new Promise((resolve) => {
          releasePreflight = resolve;
        });
        return true;
      })
      .mockImplementation(async (threadId, patch) => {
        useStore.setState((state) => ({
          threadsById: {
            ...state.threadsById,
            [threadId]: { ...state.threadsById[threadId], ...patch },
          },
        }));
        return true;
      });
    useStore.setState({
      updateThreadRecord,
      getThreadClient: () => ({ request, cancelActivePrompt: vi.fn().mockReturnValue(false) }),
    });

    const running = useStore.getState().runThreadPrompt('thread-1', 'hello');
    await preflightStarted;
    await expect(useStore.getState().cancelSession()).resolves.toBe(true);
    releasePreflight();

    await expect(running).resolves.toBe(false);
    expect(request).not.toHaveBeenCalledWith('session/prompt', expect.anything());
  });
  it('blocks model and mode changes while the current response is active', async () => {
    useStore.setState((state) => ({
      threadsById: {
        ...state.threadsById,
        'thread-1': { ...state.threadsById['thread-1'], status: 'running' },
      },
      threadRuntimeById: {
        ...state.threadRuntimeById,
        'thread-1': runtime({ isAwaitingResponse: false }),
      },
      ...runtime({ isAwaitingResponse: false }),
    }));

    await expect(useStore.getState().setMode('delegate')).resolves.toBe(false);
    await expect(useStore.getState().setModel('other-model')).resolves.toBe(false);

    expect(request).not.toHaveBeenCalled();
    expect(useStore.getState().error).toContain('当前回复进行中');
  });

  // H1: a content chunk that arrives after the run has finalized (activePromptRunId
  // cleared) but within the LATE_PROMPT_CORRELATION_MS window must still be accepted
  // and appended to the timeline instead of being silently dropped.
  it('accepts a late content chunk for the just-finalized prompt run', async () => {
    let finishedRunId = null;
    request.mockImplementationOnce(async () => {
      finishedRunId = useStore.getState().threadRuntimeById['thread-1'].activePromptRunId;
      useStore.getState().handleConversationEvent({
        threadId: 'thread-1',
        type: 'session/update',
        detail: {
          sessionId: 'session-ready',
          _client: { source: 'request', promptRunId: finishedRunId },
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'reply-final',
            content: { type: 'text', text: 'done' },
          },
        },
      });
      return { stopReason: 'end_turn' };
    });

    await expect(useStore.getState().runThreadPrompt('thread-1', 'hello')).resolves.toBe(true);

    // After success the activePromptRunId is cleared but lastPromptRunId is set.
    const runtimeAfter = useStore.getState().threadRuntimeById['thread-1'];
    expect(runtimeAfter.activePromptRunId).toBeNull();
    expect(runtimeAfter.lastPromptRunId).toBe(finishedRunId);

    // A late chunk arrives tagged with the finished run id (transport correlates it).
    useStore.getState().handleConversationEvent({
      threadId: 'thread-1',
      type: 'session/update',
      detail: {
        sessionId: 'session-ready',
        _client: { source: 'request', promptRunId: finishedRunId },
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'late-tail',
          content: { type: 'text', text: 'LATE_TAIL' },
        },
      },
    });

    expect(
      useStore.getState().threadRuntimeById['thread-1'].timeline.some((item) => item.content === 'LATE_TAIL'),
    ).toBe(true);
  });

  // H2: while isAwaitingResponse is true (promptDispatched not yet set), cancelling
  // must still emit session/cancel because the POST may already be in flight backend-side.
  it('emits session/cancel when cancelling during isAwaitingResponse pre-dispatch', async () => {
    const notify = vi.fn().mockResolvedValue(true);
    const cancelActivePrompt = vi.fn().mockReturnValue(true);
    const hasActivePrompt = vi.fn().mockReturnValue(false);
    useStore.setState((state) => ({
      threadsById: {
        ...state.threadsById,
        'thread-1': { ...state.threadsById['thread-1'], status: 'running' },
      },
      threadRuntimeById: {
        ...state.threadRuntimeById,
        'thread-1': runtime({
          activePromptRunId: 'run-pending',
          promptDispatched: false,
          isAwaitingResponse: true,
        }),
      },
      getThreadClient: () => ({
        request,
        notify,
        cancelActivePrompt,
        hasActivePrompt,
        invalidateInteractiveRequests: vi.fn(),
      }),
    }));

    await expect(useStore.getState().cancelSession()).resolves.toBe(true);

    expect(notify).toHaveBeenCalledWith('session/cancel', { sessionId: 'session-ready' });
  });

  // H4: two concurrent drainThreadPromptQueue calls must only dispatch session/prompt once.
  it('does not double-send session/prompt when two drains race past the queue lock', async () => {
    useStore.setState((state) => ({
      threadsById: {
        ...state.threadsById,
        'thread-1': { ...state.threadsById['thread-1'], status: 'idle' },
      },
      threadRuntimeById: {
        ...state.threadRuntimeById,
        'thread-1': runtime({
          isAwaitingResponse: false,
          activePromptRunId: null,
          promptQueue: [{ id: 'q1', text: 'first' }, { id: 'q2', text: 'second' }],
        }),
      },
    }));

    const p1 = useStore.getState().drainThreadPromptQueue('thread-1');
    const p2 = useStore.getState().drainThreadPromptQueue('thread-1');
    await Promise.all([p1, p2]);

    const promptCalls = request.mock.calls.filter((call) => call[0] === 'session/prompt');
    expect(promptCalls.length).toBe(1);
  });
});
