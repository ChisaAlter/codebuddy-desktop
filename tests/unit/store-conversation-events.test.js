import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../src/store';

function runtime() {
  return {
    connectionState: 'connected',
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
  };
}

describe('store conversation event routing', () => {
  beforeEach(() => {
    useStore.setState({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      projectsById: {
        'project-1': { id: 'project-1', workspacePath: 'C:/Project' },
      },
      threadsById: {
        'thread-1': { id: 'thread-1', projectId: 'project-1', sessionId: 'session-1', metadata: {}, status: 'idle' },
        'thread-2': { id: 'thread-2', projectId: 'project-1', sessionId: 'session-2', metadata: {}, status: 'idle' },
      },
      threadRuntimeById: {
        'thread-1': runtime(),
        'thread-2': runtime(),
      },
      ...runtime(),
      sessionId: 'session-1',
      error: null,
      getThreadClient: useStore.getInitialState().getThreadClient,
      drainThreadPromptQueue: useStore.getInitialState().drainThreadPromptQueue,
    });
  });

  it('ignores session updates broadcast to a client for a different thread session', () => {
    useStore.getState().handleConversationEvent({
      threadId: 'thread-1',
      type: 'session/update',
      detail: {
        sessionId: 'session-2',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'message-2',
          content: { type: 'text', text: 'belongs to thread 2' },
        },
      },
    });

    expect(useStore.getState().threadRuntimeById['thread-1'].timeline).toEqual([]);
  });

  it('stores workflow metadata on the thread and clears the team snapshot at terminal status', () => {
    useStore.getState().patchThreadRuntime('thread-1', {
      activePromptRunId: 'run-workflow',
      promptDispatched: true,
      isAwaitingResponse: true,
    });
    useStore.getState().handleConversationEvent({
      threadId: 'thread-1',
      type: 'session/update',
      detail: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'session_info_update',
          _meta: {
            'codebuddy.ai/teamUpdate': {
              name: '探索工作流',
              members: [{ id: 'agent-1', name: '主进程', status: 'running' }],
            },
            'codebuddy.ai/agentPhase': { phase: 'planning', startedAt: 1000 },
            'codebuddy.ai/progress': { current: 1, total: 6 },
          },
        },
      },
    });

    expect(useStore.getState().threadRuntimeById['thread-1']).toMatchObject({
      teamState: { name: '探索工作流' },
      agentPhase: { phase: 'planning' },
      progress: { current: 1, total: 6 },
    });

    useStore.getState().handleConversationEvent({
      threadId: 'thread-1',
      type: 'session/update',
      detail: {
        sessionId: 'session-1',
        update: { sessionUpdate: 'status_change', status: 'idle' },
      },
    });

    expect(useStore.getState().threadRuntimeById['thread-1']).toMatchObject({
      teamState: null,
      agentPhase: null,
      progress: null,
    });
  });

  it('routes memberEvent chunks to member history without duplicating leader timeline', () => {
    useStore.getState().patchThreadRuntime('thread-1', {
      activePromptRunId: 'run-members',
      isAwaitingResponse: true,
      teamState: {
        type: 'team_created',
        teamName: '探索团队',
        members: [{ name: '主进程', taskId: 'task-main', status: 'running' }],
      },
    });
    useStore.getState().handleConversationEvent({
      threadId: 'thread-1',
      type: 'session/update',
      detail: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'member-message-1',
          content: '主进程已完成目录扫描',
          _meta: { 'codebuddy.ai/memberEvent': '主进程' },
        },
      },
    });

    const state = useStore.getState().threadRuntimeById['thread-1'];
    expect(state.memberHistoriesByName['主进程'][0]).toMatchObject({
      type: 'message',
      content: '主进程已完成目录扫描',
    });
    expect(state.timeline).toEqual([]);
  });

  it('keeps a final team snapshot after team_deleted and terminal status', () => {
    useStore.getState().patchThreadRuntime('thread-1', {
      activePromptRunId: 'run-team-final',
      isAwaitingResponse: true,
      teamState: {
        type: 'team_created',
        teamName: '探索团队',
        members: [{ name: '主进程', taskId: 'task-main', status: 'running' }],
      },
    });
    useStore.getState().handleConversationEvent({
      threadId: 'thread-1',
      type: 'session/update',
      detail: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'session_info_update',
          _meta: { 'codebuddy.ai/teamUpdate': { type: 'team_deleted' } },
        },
      },
    });

    const state = useStore.getState().threadRuntimeById['thread-1'];
    expect(state.teamState).toBeNull();
    expect(state.lastTeamState).toMatchObject({
      teamName: '探索团队',
      active: false,
      status: 'completed',
      members: [{ name: '主进程', status: 'completed' }],
    });
  });

  it('mirrors prompt dispatch in-flight state for the active thread', () => {
    useStore.getState().patchThreadRuntime('thread-1', { promptDispatchInFlight: true });
    expect(useStore.getState().promptDispatchInFlight).toBe(true);
    useStore.getState().patchThreadRuntime('thread-1', { promptDispatchInFlight: false });
    expect(useStore.getState().promptDispatchInFlight).toBe(false);
  });
  it('keeps thought chunks streaming after the initial response wait ends', () => {
    useStore.getState().patchThreadRuntime('thread-1', { isAwaitingResponse: true });

    useStore.getState().handleConversationEvent({
      threadId: 'thread-1',
      type: 'session/update',
      detail: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_thought_chunk',
          messageId: 'thought-1',
          content: { type: 'text', text: '' },
        },
      },
    });

    const state = useStore.getState().threadRuntimeById['thread-1'];
    expect(state.isAwaitingResponse).toBe(false);
    expect(state.timeline[0]).toMatchObject({ type: 'thinking', streaming: true });
  });

  it.each(['idle', 'error', 'cancelled'])('clears prompt runtime state when status_change reaches %s without an active request', (status) => {
    useStore.getState().patchThreadRuntime('thread-1', {
      activePromptRunId: 'run-terminal',
      promptDispatched: true,
      isAwaitingResponse: true,
      promptStartedAt: 1234,
      historyReplayActive: true,
      agentPhase: 'working',
      progress: { current: 1, total: 2 },
    });

    useStore.getState().handleConversationEvent({
      threadId: 'thread-1',
      type: 'session/update',
      detail: {
        sessionId: 'session-1',
        update: { sessionUpdate: 'status_change', status },
      },
    });

    expect(useStore.getState().threadRuntimeById['thread-1']).toMatchObject({
      activePromptRunId: null,
      promptDispatched: false,
      isAwaitingResponse: false,
      promptStartedAt: null,
      historyReplayActive: false,
      agentPhase: null,
      progress: null,
    });
  });

  it('keeps the run attached when a terminal status arrives before the active response stream ends', () => {
    useStore.setState({
      getThreadClient: () => ({ hasActivePrompt: () => true }),
    });
    useStore.getState().patchThreadRuntime('thread-1', {
      activePromptRunId: 'run-current',
      promptDispatched: true,
      isAwaitingResponse: false,
    });

    useStore.getState().handleConversationEvent({
      threadId: 'thread-1',
      type: 'session/update',
      detail: {
        sessionId: 'session-1',
        update: { sessionUpdate: 'status_change', status: 'idle' },
      },
    });
    useStore.getState().handleConversationEvent({
      threadId: 'thread-1',
      type: 'session/update',
      detail: {
        sessionId: 'session-1',
        _client: { source: 'request', promptRunId: 'run-current' },
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'final-after-idle',
          content: { type: 'text', text: 'final chunk' },
        },
      },
    });

    const runtimeState = useStore.getState().threadRuntimeById['thread-1'];
    expect(runtimeState.activePromptRunId).toBe('run-current');
    expect(runtimeState.timeline.some((item) => item.content === 'final chunk')).toBe(true);
  });

  it.each(['session_update', 'type'])('rejects old prompt content expressed through the %s alias', (field) => {
    useStore.getState().patchThreadRuntime('thread-1', { activePromptRunId: 'run-current' });
    useStore.getState().handleConversationEvent({
      threadId: 'thread-1',
      type: 'session/update',
      detail: {
        sessionId: 'session-1',
        _client: { source: 'request', promptRunId: 'run-old' },
        update: {
          [field]: 'agent_message_chunk',
          messageId: `old-${field}`,
          content: { type: 'text', text: 'OLD_ALIAS_CONTENT' },
        },
      },
    });

    expect(useStore.getState().threadRuntimeById['thread-1'].timeline).toEqual([]);
  });

  it('rejects uncorrelated notification content during the post-stream grace window', () => {
    useStore.setState((state) => ({
      threadsById: {
        ...state.threadsById,
        'thread-1': { ...state.threadsById['thread-1'], status: 'running' },
      },
    }));
    useStore.getState().patchThreadRuntime('thread-1', {
      activePromptRunId: 'run-grace',
      promptDispatched: true,
      isAwaitingResponse: false,
      historyReplayActive: false,
    });

    useStore.getState().handleConversationEvent({
      threadId: 'thread-1',
      type: 'session/update',
      detail: {
        sessionId: 'session-1',
        _client: { source: 'notification' },
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'uncorrelated-grace',
          content: { type: 'text', text: 'UNCORRELATED_GRACE' },
        },
      },
    });

    expect(useStore.getState().threadRuntimeById['thread-1'].timeline).toEqual([]);
  });

  it('rejects uncorrelated notification content on an idle thread', () => {
    useStore.getState().handleConversationEvent({
      threadId: 'thread-1',
      type: 'session/update',
      detail: {
        sessionId: 'session-1',
        _client: { source: 'notification' },
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'uncorrelated-idle',
          content: { type: 'text', text: 'UNCORRELATED_IDLE' },
        },
      },
    });

    expect(useStore.getState().threadRuntimeById['thread-1'].timeline).toEqual([]);
  });

  it('rejects correlated prompt content after its run has already ended', () => {
    useStore.getState().handleConversationEvent({
      threadId: 'thread-1',
      type: 'session/update',
      detail: {
        sessionId: 'session-1',
        _client: { source: 'notification', promptRunId: 'run-finished' },
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'late-after-finish',
          content: { type: 'text', text: 'LATE_AFTER_FINISH' },
        },
      },
    });

    expect(useStore.getState().threadRuntimeById['thread-1'].timeline).toEqual([]);
  });

  it('clears prompt runtime state after reconnect failure', () => {
    useStore.getState().patchThreadRuntime('thread-1', {
      activePromptRunId: 'run-reconnect',
      promptDispatched: true,
      isAwaitingResponse: true,
      promptStartedAt: 5678,
      historyReplayActive: true,
    });

    useStore.getState().handleConversationEvent({ threadId: 'thread-1', type: 'reconnect_failed', detail: {} });

    expect(useStore.getState().threadRuntimeById['thread-1']).toMatchObject({
      connectionState: 'error',
      activePromptRunId: null,
      promptDispatched: false,
      isAwaitingResponse: false,
      promptStartedAt: null,
      historyReplayActive: false,
    });
  });

  it('leaves a persisted prompt queue paused when an orphaned run reaches idle', async () => {
    vi.useFakeTimers();
    try {
      const drainThreadPromptQueue = vi.fn().mockResolvedValue(true);
      useStore.setState({ drainThreadPromptQueue });
      useStore.getState().patchThreadRuntime('thread-1', {
        activePromptRunId: 'run-orphaned',
        promptDispatched: true,
        isAwaitingResponse: true,
        promptQueue: [{ id: 'queued-1', text: 'continue' }],
      });

      useStore.getState().handleConversationEvent({
        threadId: 'thread-1',
        type: 'session/update',
        detail: {
          sessionId: 'session-1',
          update: { sessionUpdate: 'status_change', status: 'idle' },
        },
      });
      await vi.runAllTimersAsync();

      expect(drainThreadPromptQueue).not.toHaveBeenCalled();
      expect(useStore.getState().threadRuntimeById['thread-1'].promptQueue).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders extension and JSON-RPC permission notifications for one tool call only once', () => {
    const extension = {
      sessionUpdate: 'interruption_request',
      sessionId: 'session-1',
      interruptionId: 'ir-tool-1',
      toolCallId: 'tool-1',
      responseMode: 'extension',
    };
    const jsonRpc = {
      sessionUpdate: 'interruption_request',
      sessionId: 'session-1',
      interruptionId: 'perm-7',
      toolCallId: 'tool-1',
      responseMode: 'json-rpc',
    };

    useStore.getState().handleConversationEvent({ threadId: 'thread-1', type: 'interruption_request', detail: extension });
    useStore.getState().handleConversationEvent({ threadId: 'thread-1', type: 'interruption_request', detail: jsonRpc });

    const state = useStore.getState().threadRuntimeById['thread-1'];
    expect(state.permissionRequests).toHaveLength(1);
    expect(state.timeline.filter((item) => item.type === 'interruption')).toHaveLength(1);
  });
});
