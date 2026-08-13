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

  it('accepts one server-initiated request on an idle thread without admitting another request', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(20_000);
      useStore.getState().patchThreadRuntime('thread-1', {
        workflowState: { runId: 'workflow-live', status: 'running', active: true },
        backgroundDrainRunId: 'workflow-live',
        backgroundDrainUntil: 80_000,
        backgroundDrainMaxUntil: 140_000,
      });
      const sendBackgroundChunk = (requestId, messageId, text) => {
        useStore.getState().handleConversationEvent({
          threadId: 'thread-1',
          type: 'session/update',
          detail: {
            sessionId: 'session-1',
            _client: { source: 'notification', requestId, serverInitiated: true },
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId,
              content: { type: 'text', text },
            },
          },
        });
      };

      sendBackgroundChunk('backend-workflow', 'background-first', '后台汇总第一段');
      let state = useStore.getState().threadRuntimeById['thread-1'];
      expect(state.backgroundDrainRunId).toBe('server:backend-workflow');
      expect(state.backgroundDrainUntil).toBeGreaterThan(Date.now());
      expect(state.timeline).toEqual([
        expect.objectContaining({ type: 'message', role: 'assistant', content: '后台汇总第一段' }),
      ]);

      sendBackgroundChunk('backend-workflow', 'background-second', '后台汇总第二段');
      sendBackgroundChunk('backend-other', 'background-other', '不属于该后台回合');

      state = useStore.getState().threadRuntimeById['thread-1'];
      expect(state.timeline.map((item) => item.content).join('')).toContain('后台汇总第二段');
      expect(state.timeline.map((item) => item.content).join('')).not.toContain('不属于该后台回合');
      expect(state.backgroundDrainRunId).toBe('server:backend-workflow');
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the matching server-initiated assistant stream on session_end', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(25_000);
      useStore.getState().patchThreadRuntime('thread-1', {
        lastWorkflowState: { runId: 'workflow-finished', status: 'completed', active: false },
        backgroundDrainRunId: 'workflow-finished',
        backgroundDrainUntil: 85_000,
        backgroundDrainMaxUntil: 145_000,
      });

      useStore.getState().handleConversationEvent({
        threadId: 'thread-1',
        type: 'session/update',
        detail: {
          sessionId: 'session-1',
          _client: { source: 'notification', requestId: 'backend-final', serverInitiated: true },
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'background-final',
            content: { type: 'text', text: '完整后台汇总' },
          },
        },
      });

      let state = useStore.getState().threadRuntimeById['thread-1'];
      expect(state.backgroundDrainRunId).toBe('server:backend-final');
      expect(state.timeline).toEqual([
        expect.objectContaining({ content: '完整后台汇总', streaming: true }),
      ]);

      vi.setSystemTime(26_000);
      useStore.getState().handleConversationEvent({
        threadId: 'thread-1',
        type: 'session/update',
        detail: {
          sessionId: 'session-1',
          _client: { source: 'notification', requestId: 'backend-other', serverInitiated: true },
          update: { sessionUpdate: 'session_end' },
        },
      });
      expect(useStore.getState().threadRuntimeById['thread-1'].timeline[0].streaming).toBe(true);

      useStore.getState().handleConversationEvent({
        threadId: 'thread-1',
        type: 'session/update',
        detail: {
          sessionId: 'session-1',
          _client: { source: 'notification', requestId: 'backend-final', serverInitiated: true },
          update: { sessionUpdate: 'session_end' },
        },
      });

      state = useStore.getState().threadRuntimeById['thread-1'];
      expect(state.timeline).toEqual([
        expect.objectContaining({ content: '完整后台汇总', streaming: false, completedAt: 26_000 }),
      ]);
      expect(state.backgroundDrainUntil).toBe(0);
      expect(state.backgroundDrainMaxUntil).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a server-initiated idle request without workflow evidence', () => {
    useStore.getState().handleConversationEvent({
      threadId: 'thread-1',
      type: 'session/update',
      detail: {
        sessionId: 'session-1',
        _client: { source: 'notification', requestId: 'backend-unrelated', serverInitiated: true },
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'background-unrelated',
          content: { type: 'text', text: 'UNRELATED_SERVER_CONTENT' },
        },
      },
    });

    const state = useStore.getState().threadRuntimeById['thread-1'];
    expect(state.timeline).toEqual([]);
    expect(state.backgroundDrainRunId).toBeFalsy();
  });

  it('rejects a server-initiated request after a completed workflow drain expires', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(200_000);
      useStore.getState().patchThreadRuntime('thread-1', {
        workflowState: { runId: 'workflow-old', status: 'completed', active: false },
        lastWorkflowState: { runId: 'workflow-old', status: 'completed', active: false },
        backgroundDrainRunId: 'workflow-old',
        backgroundDrainUntil: 100_000,
        backgroundDrainMaxUntil: 160_000,
      });

      useStore.getState().handleConversationEvent({
        threadId: 'thread-1',
        type: 'session/update',
        detail: {
          sessionId: 'session-1',
          _client: { source: 'notification', requestId: 'backend-too-late', serverInitiated: true },
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'background-too-late',
            content: { type: 'text', text: '过期后台内容' },
          },
        },
      });

      const state = useStore.getState().threadRuntimeById['thread-1'];
      expect(state.timeline).toEqual([]);
      expect(state.backgroundDrainRunId).toBe('workflow-old');
    } finally {
      vi.useRealTimers();
    }
  });

  it('polls workflow snapshots into the panel and opens a drain when the run finishes', async () => {
    vi.useFakeTimers();
    const previousElectronApi = window.electronAPI;
    try {
      vi.setSystemTime(30_000);
      window.electronAPI = {
        readWorkflowProgress: vi
          .fn()
          .mockResolvedValueOnce({
            runId: 'workflow-live',
            name: 'package-read',
            status: 'running',
            active: true,
            phase: 'Inspect',
            phaseCount: 1,
            agentCount: 1,
            startedAt: 30_010,
            agents: [{ id: 'agent-key', name: 'package-reader', phase: 'Inspect', status: 'running' }],
          })
          .mockResolvedValueOnce({
            runId: 'workflow-live',
            name: 'package-read',
            status: 'completed',
            active: false,
            phase: 'Inspect',
            phaseCount: 1,
            agentCount: 1,
            startedAt: 30_010,
            completedAt: 31_000,
            agents: [{ id: 'agent-key', name: 'package-reader', phase: 'Inspect', status: 'completed' }],
          }),
      };

      expect(useStore.getState().startWorkflowProgressMonitor).toEqual(expect.any(Function));
      useStore.getState().startWorkflowProgressMonitor({
        threadId: 'thread-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        startedAfter: 30_000,
      });
      await vi.advanceTimersByTimeAsync(0);

      let state = useStore.getState();
      expect(window.electronAPI.readWorkflowProgress).toHaveBeenNthCalledWith(1, {
        projectId: 'project-1',
        sessionId: 'session-1',
        startedAfter: 30_000,
      });
      expect(state.threadRuntimeById['thread-1'].workflowState).toMatchObject({
        runId: 'workflow-live',
        active: true,
        phase: 'Inspect',
        agents: [{ name: 'package-reader', status: 'running' }],
      });
      expect(state.workflowFloatingPanel?.payload).toMatchObject({
        threadId: 'thread-1',
        runId: 'workflow-live',
      });

      await vi.advanceTimersByTimeAsync(500);
      state = useStore.getState();
      expect(window.electronAPI.readWorkflowProgress).toHaveBeenNthCalledWith(2, {
        projectId: 'project-1',
        sessionId: 'session-1',
        startedAfter: 30_000,
        runId: 'workflow-live',
      });
      expect(state.threadRuntimeById['thread-1'].workflowState).toMatchObject({
        runId: 'workflow-live',
        active: false,
        status: 'completed',
      });
      expect(state.threadRuntimeById['thread-1'].lastWorkflowState).toMatchObject({
        runId: 'workflow-live',
        status: 'completed',
      });
      expect(state.threadRuntimeById['thread-1'].backgroundDrainRunId).toBe('workflow-live');
      expect(state.threadRuntimeById['thread-1'].backgroundDrainUntil).toBeGreaterThan(Date.now());
    } finally {
      window.electronAPI = previousElectronApi;
      vi.useRealTimers();
    }
  });

  it('accepts unmarked background drain content after a confirmed workflow finish', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      useStore.getState().handleConversationEvent({
        threadId: 'thread-1',
        type: 'session/update',
        detail: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'session_info_update',
            _meta: {
              'codebuddy.ai/workflowEventKind': 'workflow_run_finished',
              'codebuddy.ai/workflowRunId': 'workflow-background',
              'codebuddy.ai/workflowName': 'Background review',
              'codebuddy.ai/workflowStatus': 'completed',
              'codebuddy.ai/workflowAgentCount': 1,
              'codebuddy.ai/workflowCachedCount': 0,
              'codebuddy.ai/workflowPhaseCount': 1,
            },
          },
        },
      });

      const afterFinish = useStore.getState().threadRuntimeById['thread-1'];
      expect(afterFinish.backgroundDrainUntil).toBeGreaterThan(Date.now());

      useStore.getState().handleConversationEvent({
        threadId: 'thread-1',
        type: 'session/update',
        detail: {
          sessionId: 'session-1',
          _client: { source: 'notification', promptRunId: 'different-prompt-run' },
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'wrong-prompt-final',
            content: { type: 'text', text: '其他回合内容' },
          },
        },
      });
      expect(useStore.getState().threadRuntimeById['thread-1'].timeline).toEqual([]);

      useStore.getState().handleConversationEvent({
        threadId: 'thread-1',
        type: 'session/update',
        detail: {
          sessionId: 'session-1',
          _client: { source: 'notification' },
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'workflow-final',
            content: { type: 'text', text: '后台工作流最终汇总' },
          },
        },
      });

      expect(useStore.getState().threadRuntimeById['thread-1'].timeline).toEqual([
        expect.objectContaining({ type: 'message', role: 'assistant', content: '后台工作流最终汇总' }),
      ]);

      vi.advanceTimersByTime(120_001);
      useStore.getState().handleConversationEvent({
        threadId: 'thread-1',
        type: 'session/update',
        detail: {
          sessionId: 'session-1',
          _client: { source: 'notification' },
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'workflow-too-late',
            content: { type: 'text', text: '过期后台通知' },
          },
        },
      });
      expect(useStore.getState().threadRuntimeById['thread-1'].timeline).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
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

  it('preserves active turn runtime after reconnect failure', () => {
    useStore.getState().patchThreadRuntime('thread-1', {
      activePromptRunId: 'run-reconnect',
      promptDispatched: true,
      isAwaitingResponse: true,
      promptStartedAt: 5678,
      historyReplayActive: true,
    });
    useStore.setState((state) => ({
      threadsById: {
        ...state.threadsById,
        'thread-1': { ...state.threadsById['thread-1'], status: 'running' },
      },
    }));

    useStore.getState().handleConversationEvent({ threadId: 'thread-1', type: 'reconnect_failed', detail: {} });

    // 有 active turn 时只标连接错误，禁止清 run id / 强制终态。
    expect(useStore.getState().threadRuntimeById['thread-1']).toMatchObject({
      connectionState: 'error',
      activePromptRunId: 'run-reconnect',
      promptDispatched: true,
      isAwaitingResponse: true,
      promptStartedAt: 5678,
      historyReplayActive: true,
    });
    expect(useStore.getState().threadsById['thread-1'].status).toBe('running');
  });

  it('terminalizes idle threads after reconnect failure', () => {
    useStore.getState().patchThreadRuntime('thread-1', {
      activePromptRunId: null,
      isAwaitingResponse: false,
      connectionState: 'reconnecting',
    });

    useStore.getState().handleConversationEvent({ threadId: 'thread-1', type: 'reconnect_failed', detail: {} });

    expect(useStore.getState().threadRuntimeById['thread-1']).toMatchObject({
      connectionState: 'error',
      activePromptRunId: null,
      isAwaitingResponse: false,
    });
    expect(useStore.getState().threadsById['thread-1'].status).toBe('error');
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

describe('subagent report rebuild frequency (M-perf)', () => {
  let calls;

  beforeEach(() => {
    calls = 0;
    const module = { collectSubagentReports: vi.fn(() => ({ rebuilt: ++calls, at: Date.now() })) };
    // Re-import with a spy on collectSubagentReports through the slice's import.
    vi.doMock('../../src/lib/subagent-report', () => module);
    // The slice module is already loaded with the real import; use the store's
    // own handleConversationEvent and count via a wrapped spy is not possible
    // without module reload — instead assert behavior: content chunks must not
    // change subagentReports (no rebuild), structural events must.
  });

  it('does not rebuild subagent reports on pure content chunks', async () => {
    useStore.setState({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      threadsById: {
        'thread-1': { id: 'thread-1', projectId: 'project-1', sessionId: 'session-1', metadata: {}, status: 'running' },
      },
      threadRuntimeById: {
        'thread-1': runtime({
          teamState: { teamName: 'T', members: [{ id: 'm1', name: '搜索', task: 'x', status: 'running', taskId: 't1' }] },
          memberHistoriesByName: {},
          subagentToolCalls: {},
        }),
      },
    });

    const emitMemberChunk = (text) =>
      useStore.getState().handleConversationEvent({
        threadId: 'thread-1',
        type: 'session/update',
        detail: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            _meta: {
              'codebuddy.ai/memberEvent': {
                name: '搜索',
                content: { type: 'text', text },
              },
            },
          },
        },
      });

    emitMemberChunk('第一段');
    const first = useStore.getState().threadRuntimeById['thread-1'].subagentReports;
    emitMemberChunk('第二段');
    const second = useStore.getState().threadRuntimeById['thread-1'].subagentReports;
    // Pure content chunks must NOT rebuild the report (same reference).
    expect(second).toBe(first);
    // Member history still grew.
    expect(Object.keys(useStore.getState().threadRuntimeById['thread-1'].memberHistoriesByName || {})).toHaveLength(1);

    // A structural event (tool_call for the member) must rebuild.
    useStore.getState().handleConversationEvent({
      threadId: 'thread-1',
      type: 'session/update',
      detail: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          _meta: {
            'codebuddy.ai/memberEvent': { name: '搜索' },
            'codebuddy.ai/subagent': { parentToolCallId: 'p1' },
          },
          toolCallId: 'tc-1',
          status: 'completed',
        },
      },
    });
    const third = useStore.getState().threadRuntimeById['thread-1'].subagentReports;
    expect(third).not.toBe(first);
  });
});
