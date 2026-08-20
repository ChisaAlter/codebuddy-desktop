import { beforeEach, describe, it, expect, vi } from 'vitest';

// Mock 依赖：sessions-chat slice 引入较多模块，逐个 stub 掉只测 usage/compact 逻辑。
vi.mock('../../src/lib/acp', () => ({
  setAcpSessionToken: vi.fn(),
  isAcpAuthenticationError: vi.fn(() => false),
  LATE_PROMPT_CORRELATION_MS: 5000,
}));
vi.mock('../../src/lib/ops', () => ({
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
}));
vi.mock('../../src/lib/gui-settings', () => ({ saveGuiSettings: vi.fn() }));
vi.mock('../../src/lib/account-auth', () => ({
  classifyPromptRefusal: vi.fn(() => null),
  normalizeLastAccountUser: vi.fn((u) => u),
}));
vi.mock('../../src/lib/session-mode-labels', () => ({
  isCliPermissionBypassMode: vi.fn(() => false),
  getSessionModeLabel: vi.fn(),
  isFullAccessMode: vi.fn(() => false),
  isUltracodeEffort: vi.fn(() => false),
}));
vi.mock('../../src/lib/session-sidebar', () => ({ visibleProjectThreads: vi.fn(() => []) }));
vi.mock('../../src/lib/product-state', () => ({
  activeProject: vi.fn(),
  activeThread: vi.fn(),
  createThreadRecord: vi.fn((t) => t),
}));
vi.mock('../../src/store/helpers/prompt-completion', () => ({
  hasCompletePromptResponse: vi.fn(() => false),
  hasPromptRunActivity: vi.fn(() => false),
  hasUsableAssistantBody: vi.fn(() => false),
}));
vi.mock('../../src/store/helpers/terminal-workspace-state', () => ({
  resetProjectRuntimeViews: vi.fn(),
}));

// timeline / thread-runtime 用真实实现（reduceAcpEvent/emptyThreadRuntime 要真行为）。
import { createSessionsChatSlice } from '../../src/store/slices/sessions-chat';

function createFakeStore() {
  const state = {
    activeThreadId: 'thread-1',
    activeProjectId: 'project-1',
    threadsById: { 'thread-1': { id: 'thread-1', projectId: 'project-1', status: 'idle', sessionId: 's1' } },
    rightPanel: null,
    workflowPanelDismissedRunId: null,
    openRightPanel: vi.fn(),
    threadRuntimeById: { 'thread-1': { activePromptRunId: 'run-1', timeline: [] } },
    usage: null,
    compactState: null,
    timeline: [],
  };
  const get = () => state;
  const set = (patch) => {
    if (typeof patch === 'function') patch = patch(state);
    Object.assign(state, patch);
  };
  // patchThreadRuntime：对齐 store.js 行为，含 ACTIVE_THREAD_RUNTIME_KEYS 镜像。
  // 注意 sessions-chat slice 不定义此方法（由 store.js 提供），故挂到 state 上供 get() 解析。
  state.patchThreadRuntime = (threadId, patch) => {
    const prev = state.threadRuntimeById[threadId] || {
      timeline: [],
      compactState: null,
      progress: null,
      usage: null,
    };
    const next = { ...prev, ...patch };
    state.threadRuntimeById[threadId] = next;
    if (state.activeThreadId === threadId) {
      if ('usage' in patch) state.usage = patch.usage;
      if ('compactState' in patch) state.compactState = patch.compactState;
    }
  };
  // appendThreadTimelineEvent：走真实 reduceAcpEvent 写入 runtime.timeline。
  state.appendThreadTimelineEvent = (threadId, eventType, payload) => {
    const prev = state.threadRuntimeById[threadId] || { timeline: [] };
    const { reduceAcpEvent } = require('../../src/lib/timeline');
    const next = reduceAcpEvent(prev.timeline, eventType, payload, threadId);
    state.patchThreadRuntime(threadId, { timeline: next });
  };
  // status_change 处理路径所需的最小 stub。
  state.updateThreadRecord = (threadId, patch) => {
    const t = state.threadsById[threadId];
    if (t) Object.assign(t, patch);
  };
  state.getThreadClient = () => null;
  state.flushThreadTimelineCoalesce = () => {};
  state.cancelPendingTimelineActions = (timeline) => timeline;
  const ctx = { conversations: { peek: () => null }, cancelPendingTimelineActions: state.cancelPendingTimelineActions };
  const slice = createSessionsChatSlice(set, get, ctx);
  Object.assign(state, slice);
  return { state, get, set, slice };
}

beforeEach(() => {
  const { resetSeenContent } = require('../../src/lib/timeline');
  resetSeenContent();
});

describe('sessions-chat - usage_update 解析 usageByCategory', () => {
  it('handleThreadSessionUpdate 从 _meta 解出五类用量', () => {
    const { state, slice } = createFakeStore();
    const update = {
      sessionUpdate: 'usage_update',
      used: 6000,
      size: 10000,
      cost: { amount: 0.1, currency: 'USD' },
      _meta: {
        'codebuddy.ai/usageByCategory': {
          systemPrompt: 1000,
          tools: 500,
          conversation: 4000,
          mcp: 200,
          skills: 300,
        },
      },
    };
    slice.handleThreadSessionUpdate('thread-1', update);
    expect(state.usage).toBeTruthy();
    expect(state.usage.used).toBe(6000);
    expect(state.usage.size).toBe(10000);
    expect(state.usage.cost).toEqual({ amount: 0.1, currency: 'USD' });
    expect(state.usage.usageByCategory).toEqual({
      systemPrompt: 1000,
      tools: 500,
      conversation: 4000,
      mcp: 200,
      skills: 300,
    });
    expect(state.usage.updatedAt).toBeTypeOf('number');
  });

  it('缺少 usageByCategory 时 usageByCategory 为 null', () => {
    const { state, slice } = createFakeStore();
    slice.handleThreadSessionUpdate('thread-1', { sessionUpdate: 'usage_update', used: 1, size: 10, _meta: {} });
    expect(state.usage.usageByCategory).toBeNull();
  });
});

describe('sessions-chat - compact meta 处理', () => {
  it('progress.type=compacting 置 compactState 并追加 compacting 时间线条目', () => {
    const { state, slice } = createFakeStore();
    slice.handleThreadSessionUpdate('thread-1', {
      sessionUpdate: 'status_change',
      _meta: { 'codebuddy.ai/progress': { type: 'compacting' } },
    });
    expect(state.compactState).toBe('compacting');
    const tl = state.threadRuntimeById['thread-1'].timeline;
    expect(tl.some((e) => e.type === 'compact' && e.meta?.phase === 'compacting')).toBe(true);
  });

  it('连续 compacting 不重复追加时间线条目', () => {
    const { state, slice } = createFakeStore();
    slice.handleThreadSessionUpdate('thread-1', {
      sessionUpdate: 'status_change',
      _meta: { 'codebuddy.ai/progress': { type: 'compacting' } },
    });
    const firstCount = state.threadRuntimeById['thread-1'].timeline.filter(
      (e) => e.type === 'compact' && e.meta?.phase === 'compacting',
    ).length;
    slice.handleThreadSessionUpdate('thread-1', {
      sessionUpdate: 'status_change',
      _meta: { 'codebuddy.ai/progress': { type: 'compacting' } },
    });
    const secondCount = state.threadRuntimeById['thread-1'].timeline.filter(
      (e) => e.type === 'compact' && e.meta?.phase === 'compacting',
    ).length;
    expect(firstCount).toBe(1);
    expect(secondCount).toBe(1);
    expect(state.compactState).toBe('compacting');
  });

  it('compacting 后 progress 转为其他类型 → compacted 终态', () => {
    const { state, slice } = createFakeStore();
    slice.handleThreadSessionUpdate('thread-1', {
      sessionUpdate: 'status_change',
      _meta: { 'codebuddy.ai/progress': { type: 'compacting' } },
    });
    slice.handleThreadSessionUpdate('thread-1', {
      sessionUpdate: 'status_change',
      _meta: { 'codebuddy.ai/progress': { type: 'responding' } },
    });
    expect(state.compactState).toBe('compacted');
    const phases = state.threadRuntimeById['thread-1'].timeline
      .filter((e) => e.type === 'compact')
      .map((e) => e.meta?.phase);
    expect(phases).toEqual(['compacting', 'compacted']);
  });

  it('terminal status clears a previous compactState', () => {
    const { state, slice } = createFakeStore();
    slice.handleThreadSessionUpdate('thread-1', {
      sessionUpdate: 'status_change',
      _meta: { 'codebuddy.ai/progress': { type: 'compacting' } },
    });
    expect(state.compactState).toBe('compacting');
    slice.handleThreadSessionUpdate('thread-1', {
      sessionUpdate: 'status_change',
      status: 'completed',
    });
    expect(state.compactState).toBeNull();
  });

  it('codebuddy.ai/compact-cancelled → cancelled 终态 + 时间线条目', () => {
    const { state, slice } = createFakeStore();
    slice.handleThreadSessionUpdate('thread-1', {
      sessionUpdate: 'status_change',
      _meta: { 'codebuddy.ai/compact-cancelled': true },
    });
    expect(state.compactState).toBe('cancelled');
    const tl = state.threadRuntimeById['thread-1'].timeline;
    expect(tl.some((e) => e.type === 'compact' && e.meta?.phase === 'cancelled')).toBe(true);
  });

  it('compacted 后延迟触发 refreshUsageAfterCompact 执行轻量 session/load', async () => {
    vi.useFakeTimers();
    try {
      const { state, slice } = createFakeStore();
      const request = vi.fn().mockResolvedValue({});
      state.getThreadClient = () => ({ request });
      // 压缩完成事件到达时 turn 尚未终态（activePromptRunId 存在），直接刷新应被跳过
      slice.handleThreadSessionUpdate('thread-1', {
        sessionUpdate: 'status_change',
        _meta: { 'codebuddy.ai/progress': { type: 'compacting' } },
      });
      slice.handleThreadSessionUpdate('thread-1', {
        sessionUpdate: 'status_change',
        _meta: { 'codebuddy.ai/progress': { type: 'responding' } },
      });
      expect(state.compactState).toBe('compacted');
      expect(state.threadRuntimeById['thread-1'].usageRefreshPending).toBe(true);
      // 终态：清理 activePromptRunId（模拟 turn 结束），推进延迟窗口
      state.threadRuntimeById['thread-1'].activePromptRunId = null;
      await vi.advanceTimersByTimeAsync(2000);
      expect(request).toHaveBeenCalledWith(
        'session/load',
        expect.objectContaining({ sessionId: 's1', cwd: '.' }),
        expect.objectContaining({ mode: 'usage-refresh' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshUsageAfterCompact 在 turn 活跃时跳过并记下 pending，终态再刷', async () => {
    const { state, slice } = createFakeStore();
    const request = vi.fn().mockResolvedValue({});
    state.getThreadClient = () => ({ request });
    state.threadRuntimeById['thread-1'].activePromptRunId = 'run-1';
    const ok = await slice.refreshUsageAfterCompact('thread-1');
    expect(ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(state.threadRuntimeById['thread-1'].usageRefreshPending).toBe(true);

    state.threadRuntimeById['thread-1'].activePromptRunId = null;
    const flushed = slice.flushPendingUsageRefresh('thread-1');
    expect(flushed).toBe(true);
    await Promise.resolve();
    expect(request).toHaveBeenCalledWith(
      'session/load',
      expect.objectContaining({ sessionId: 's1' }),
      expect.objectContaining({ mode: 'usage-refresh' }),
    );
  });

  it('usage-refresh 的历史 chunk / status_change 不进入 timeline，只接受 usage_update', () => {
    const { state, slice } = createFakeStore();
    state.threadRuntimeById['thread-1'].activePromptRunId = null;
    state.threadRuntimeById['thread-1'].lastPromptRunId = 'run-1';
    state.threadRuntimeById['thread-1'].lastPromptRunAt = Date.now();
    const before = state.threadRuntimeById['thread-1'].timeline.length;

    slice.handleConversationEvent({
      threadId: 'thread-1',
      type: 'session/update',
      detail: {
        sessionId: 's1',
        _client: { mode: 'usage-refresh' },
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'hist-1',
          content: { type: 'text', text: 'LOAD_HISTORY_MUST_NOT_LAND' },
        },
      },
    });
    slice.handleConversationEvent({
      threadId: 'thread-1',
      type: 'session/update',
      detail: {
        sessionId: 's1',
        _client: { mode: 'usage-refresh' },
        update: { sessionUpdate: 'status_change', status: 'running' },
      },
    });
    expect(state.threadRuntimeById['thread-1'].timeline.length).toBe(before);
    expect(state.threadsById['thread-1'].status).toBe('idle');

    slice.handleConversationEvent({
      threadId: 'thread-1',
      type: 'session/update',
      detail: {
        sessionId: 's1',
        _client: { mode: 'usage-refresh' },
        update: { sessionUpdate: 'usage_update', used: 12, size: 100 },
      },
    });
    expect(state.usage?.used).toBe(12);
  });

  it('无 live run 且本地已终态时忽略重放的 status_change', () => {
    const { state, slice } = createFakeStore();
    state.threadRuntimeById['thread-1'].activePromptRunId = null;
    state.threadsById['thread-1'].status = 'cancelled';
    slice.handleThreadSessionUpdate('thread-1', {
      sessionUpdate: 'status_change',
      status: 'running',
    });
    expect(state.threadsById['thread-1'].status).toBe('cancelled');
  });
});
