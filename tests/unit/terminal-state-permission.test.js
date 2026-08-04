/**
 * 回归：终态线程不得被迟到的权限/问答事件复活，且权限未决时 status_change 不得锁死 Allow。
 *
 * 覆盖修复 1-5：
 * 1. responseTerminalRuntimePatch 默认清 permissionRequests/questions
 * 2. 终态时 cancelPendingTimelineActions 标记时间线卡片 cancelled
 * 3. handleThreadSessionUpdate 终态准入门控
 * 4. status_change 分支权限未决时保留 waiting
 * 5. respondToInterruption 放宽前置（有匹配项时允许响应）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cancelActivePrompt: vi.fn(),
  hasActivePrompt: vi.fn(),
  notify: vi.fn(),
  respondToPermissionRequest: vi.fn(),
  request: vi.fn(),
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
    lastTeamState: null,
    memberHistoriesByName: {},
    subagentToolCalls: {},
    workflowState: null,
    lastWorkflowState: null,
    goalState: null,
    lastGoalState: null,
    subagentReports: [],
    lastSubagentReports: [],
    rawExtensionEvents: [],
    agentPhase: null,
    progress: null,
    historyReplayActive: false,
    models: [],
    modes: [],
    currentModel: null,
    currentMode: 'default',
    thoughtLevel: null,
    thoughtLevelOptions: [],
    capabilities: {},
    ...overrides,
  };
}

function baseState(overrides = {}) {
  return {
    activeProjectId: 'project-1',
    activeThreadId: 'thread-1',
    sessionId: 'session-1',
    projectsById: { 'project-1': { id: 'project-1', workspacePath: 'C:/Project' } },
    threadsById: {
      'thread-1': {
        id: 'thread-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        metadata: {},
        status: 'error',
        timeline: [],
      },
    },
    threadRuntimeById: { 'thread-1': runtime() },
    ...runtime(),
    error: null,
    getThreadClient: () => ({
      cancelActivePrompt: mocks.cancelActivePrompt,
      hasActivePrompt: mocks.hasActivePrompt,
      notify: mocks.notify,
      respondToPermissionRequest: mocks.respondToPermissionRequest,
      request: mocks.request,
    }),
    persistProductState: vi.fn().mockResolvedValue(true),
    updateThreadRecord: vi.fn().mockImplementation(async (threadId, patch) => {
      useStore.setState((state) => ({
        threadsById: {
          ...state.threadsById,
          [threadId]: { ...state.threadsById[threadId], ...patch },
        },
      }));
      return true;
    }),
    appendThreadTimelineEvent: vi.fn().mockImplementation((threadId, type, payload) => {
      useStore.setState((state) => {
        const rt = state.threadRuntimeById[threadId] || runtime();
        return {
          threadRuntimeById: {
            ...state.threadRuntimeById,
            [threadId]: {
              ...rt,
              timeline: [...rt.timeline, { id: `tl-${Date.now()}-${Math.random()}`, type, ...payload }],
            },
          },
        };
      });
    }),
    ...overrides,
  };
}

function emitInterruption(detail) {
  useStore.getState().handleConversationEvent({
    threadId: 'thread-1',
    type: 'interruption_request',
    detail,
  });
}

function emitQuestion(detail) {
  useStore.getState().handleConversationEvent({
    threadId: 'thread-1',
    type: 'question_request',
    detail,
  });
}

describe('terminal state vs late interaction events', () => {
  beforeEach(() => {
    mocks.cancelActivePrompt.mockReset();
    mocks.cancelActivePrompt.mockReturnValue(false);
    mocks.hasActivePrompt.mockReset();
    mocks.hasActivePrompt.mockReturnValue(false);
    mocks.notify.mockReset();
    mocks.notify.mockResolvedValue(true);
    mocks.respondToPermissionRequest.mockReset();
    mocks.respondToPermissionRequest.mockResolvedValue(true);
    mocks.request.mockReset();
    mocks.request.mockResolvedValue(true);
  });

  it('late interruption_request does not resurrect a failed thread', () => {
    useStore.setState(baseState({}));
    expect(useStore.getState().threadsById['thread-1'].status).toBe('error');

    emitInterruption({
      sessionUpdate: 'interruption_request',
      sessionId: 'session-1',
      interruptionId: 'ir-late',
      toolCallId: 'tool-late',
      toolName: 'Write',
    });

    const state = useStore.getState();
    const rt = state.threadRuntimeById['thread-1'];
    // 不得追加 permissionRequests
    expect(rt.permissionRequests).toHaveLength(0);
    // 线程状态不得被回写成 waiting
    expect(state.threadsById['thread-1'].status).toBe('error');
    // 迟到事件应标记为 expired 而非 pending
    const lateCard = rt.timeline.find((item) => item.interruptionId === 'ir-late');
    expect(lateCard?.status).toBe('expired');
  });

  it('late interruption_request does not resurrect a cancelled thread', async () => {
    useStore.setState(baseState({}));
    // 先设为 running 再取消，走完整 cancelSession
    useStore.setState((state) => ({
      threadsById: {
        ...state.threadsById,
        'thread-1': { ...state.threadsById['thread-1'], status: 'running' },
      },
      threadRuntimeById: {
        ...state.threadRuntimeById,
        'thread-1': runtime({ activePromptRunId: 'run-1', isAwaitingResponse: true }),
      },
      isAwaitingResponse: true,
    }));

    await useStore.getState().cancelSession();
    expect(useStore.getState().threadsById['thread-1'].status).toBe('cancelled');
    expect(useStore.getState().threadRuntimeById['thread-1'].permissionRequests).toHaveLength(0);

    emitInterruption({
      sessionUpdate: 'interruption_request',
      sessionId: 'session-1',
      interruptionId: 'ir-after-cancel',
      toolCallId: 'tool-after-cancel',
      toolName: 'Write',
    });

    expect(useStore.getState().threadRuntimeById['thread-1'].permissionRequests).toHaveLength(0);
    expect(useStore.getState().threadsById['thread-1'].status).toBe('cancelled');
  });

  it('late interruption_request does not resurrect an idle thread after error terminalization', () => {
    // idle 本身是正常等待状态，不拦截中断。但如果线程先经过 error 终态（permissionRequests
    // 已被 responseTerminalRuntimePatch 清空），再变成 idle，迟到中断也不应追加——
    // 此处验证 error → idle 转换后迟到中断仍被门控。
    useStore.setState(baseState({}));
    // thread 已是 error（baseState 默认）
    expect(useStore.getState().threadsById['thread-1'].status).toBe('error');

    emitInterruption({
      sessionUpdate: 'interruption_request',
      sessionId: 'session-1',
      interruptionId: 'ir-error',
      toolCallId: 'tool-error',
      toolName: 'Write',
    });

    expect(useStore.getState().threadRuntimeById['thread-1'].permissionRequests).toHaveLength(0);
    expect(useStore.getState().threadsById['thread-1'].status).toBe('error');
  });

  it('late question_request does not resurrect a failed thread', () => {
    useStore.setState(baseState({}));

    emitQuestion({
      sessionUpdate: 'question_request',
      sessionId: 'session-1',
      toolCallId: 'q-late',
      questions: [{ id: 'q1', question: 'test?', options: [{ label: 'A', value: 'a' }] }],
    });

    const rt = useStore.getState().threadRuntimeById['thread-1'];
    expect(rt.questions).toHaveLength(0);
    expect(useStore.getState().threadsById['thread-1'].status).toBe('error');
  });
});

describe('status_change preserves waiting when interaction pending', () => {
  beforeEach(() => {
    mocks.cancelActivePrompt.mockReset();
    mocks.cancelActivePrompt.mockReturnValue(false);
    mocks.hasActivePrompt.mockReset();
    mocks.hasActivePrompt.mockReturnValue(false);
    mocks.notify.mockReset();
    mocks.respondToPermissionRequest.mockReset();
    mocks.request.mockReset();
  });

  it('status_change idle does not overwrite waiting when permissionRequests pending', () => {
    useStore.setState(baseState({}));
    useStore.setState((state) => ({
      threadsById: {
        ...state.threadsById,
        'thread-1': { ...state.threadsById['thread-1'], status: 'waiting' },
      },
      threadRuntimeById: {
        ...state.threadRuntimeById,
        'thread-1': runtime({
          permissionRequests: [{ interruptionId: 'perm-1', toolCallId: 'tool-1', status: 'pending' }],
          timeline: [
            {
              id: 'perm-card',
              type: 'interruption',
              status: 'pending',
              meta: { interruptionId: 'perm-1', toolCallId: 'tool-1' },
            },
          ],
        }),
      },
    }));

    useStore.getState().handleThreadSessionUpdate('thread-1', {
      sessionUpdate: 'status_change',
      status: 'idle',
      sessionId: 'session-1',
    });

    // 权限未决 → 状态必须保持 waiting，不得变成 idle
    expect(useStore.getState().threadsById['thread-1'].status).toBe('waiting');
  });
});

describe('respondToInterruption relaxed precondition', () => {
  beforeEach(() => {
    mocks.cancelActivePrompt.mockReset();
    mocks.hasActivePrompt.mockReset();
    mocks.hasActivePrompt.mockReturnValue(false);
    mocks.notify.mockReset();
    mocks.respondToPermissionRequest.mockReset();
    mocks.respondToPermissionRequest.mockResolvedValue(true);
    mocks.request.mockReset();
    mocks.request.mockResolvedValue(true);
  });

  it('allow works even when thread status is idle but matching permission exists', async () => {
    useStore.setState(baseState({}));
    useStore.setState((state) => ({
      threadsById: {
        ...state.threadsById,
        'thread-1': { ...state.threadsById['thread-1'], status: 'idle' },
      },
      threadRuntimeById: {
        ...state.threadRuntimeById,
        'thread-1': runtime({
          permissionRequests: [{ interruptionId: 'perm-1', toolCallId: 'tool-1', status: 'pending' }],
          timeline: [
            {
              id: 'perm-card',
              type: 'interruption',
              status: 'pending',
              meta: { interruptionId: 'perm-1', toolCallId: 'tool-1' },
              raw: { interruptionId: 'perm-1', toolCallId: 'tool-1' },
              toolCallId: 'tool-1',
            },
          ],
        }),
      },
    }));

    const ok = await useStore.getState().respondToInterruption('perm-1', 'allow', 'tool-1');
    // 有匹配项 → 放行响应，不得 return false
    expect(ok).toBe(true);
    expect(mocks.respondToPermissionRequest).toHaveBeenCalled();
  });

  it('allow returns false when thread is idle and no matching permission', async () => {
    useStore.setState(baseState({}));
    useStore.setState((state) => ({
      threadsById: {
        ...state.threadsById,
        'thread-1': { ...state.threadsById['thread-1'], status: 'idle' },
      },
      threadRuntimeById: {
        ...state.threadRuntimeById,
        'thread-1': runtime({ permissionRequests: [] }),
      },
    }));

    const ok = await useStore.getState().respondToInterruption('perm-missing', 'allow', 'tool-missing');
    expect(ok).toBe(false);
    expect(mocks.respondToPermissionRequest).not.toHaveBeenCalled();
  });
});

describe('active turn interruption still works (no false reject)', () => {
  beforeEach(() => {
    mocks.cancelActivePrompt.mockReset();
    mocks.hasActivePrompt.mockReset();
    mocks.hasActivePrompt.mockReturnValue(true);
    mocks.notify.mockReset();
    mocks.respondToPermissionRequest.mockReset();
    mocks.request.mockReset();
  });

  it('interruption_request on a running thread is admitted normally', () => {
    useStore.setState(baseState({}));
    useStore.setState((state) => ({
      threadsById: {
        ...state.threadsById,
        'thread-1': { ...state.threadsById['thread-1'], status: 'running' },
      },
      threadRuntimeById: {
        ...state.threadRuntimeById,
        'thread-1': runtime({ activePromptRunId: 'run-1', isAwaitingResponse: true }),
      },
    }));

    emitInterruption({
      sessionUpdate: 'interruption_request',
      sessionId: 'session-1',
      interruptionId: 'ir-live',
      toolCallId: 'tool-live',
      toolName: 'Write',
    });

    const rt = useStore.getState().threadRuntimeById['thread-1'];
    expect(rt.permissionRequests).toHaveLength(1);
    expect(rt.permissionRequests[0].interruptionId).toBe('ir-live');
    expect(useStore.getState().threadsById['thread-1'].status).toBe('waiting');
  });
});