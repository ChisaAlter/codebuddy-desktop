import { beforeEach, describe, expect, it, vi } from 'vitest';

const opsMocks = vi.hoisted(() => ({
  deleteSession: vi.fn(),
}));

vi.mock('../../src/lib/ops', async (importOriginal) => ({
  ...(await importOriginal()),
  deleteSession: opsMocks.deleteSession,
}));

import { useStore } from '../../src/store';

const project = { id: 'p1', name: 'Project', workspacePath: 'C:/Project', preferences: {} };

function thread(id, overrides = {}) {
  return {
    id,
    projectId: 'p1',
    title: id,
    status: 'idle',
    unread: false,
    pinned: false,
    archivedAt: null,
    ...overrides,
  };
}

describe('M2 workflow panel lifecycle & dismissed race', () => {
  beforeEach(() => {
    opsMocks.deleteSession.mockReset();
    opsMocks.deleteSession.mockResolvedValue(null);
    window.electronAPI = { saveProductState: vi.fn().mockResolvedValue({ ok: true }) };
    useStore.setState({
      projectsById: { p1: project },
      projectOrder: ['p1'],
      threadsById: { t1: thread('t1'), t2: thread('t2') },
      threadOrderByProject: { p1: ['t1', 't2'] },
      activeProjectId: 'p1',
      activeThreadId: 't1',
      workspacePath: 'C:/Project',
      workflowFloatingPanel: null,
      workflowPanelDismissed: null,
      activePromptRunId: null,
      lastPromptRunId: 'old-run',
      threadRuntimeById: {},
      persistProductState: vi.fn().mockResolvedValue(true),
      activateThread: vi.fn().mockResolvedValue(true),
      newSession: vi.fn().mockResolvedValue(true),
      error: null,
      productStateLoaded: true,
    });
  });

  describe('openWorkflowPanel - payload 规范化 + 清 dismiss 窗', () => {
    it('只保留 projectId/threadId/runId 字符串字段，清 dismissed', () => {
      const s = useStore.getState();
      s.openWorkflowPanel({ projectId: 'p1', threadId: 't1', runId: 'run-1', evil: 'x', cwd: '/tmp' });
      expect(useStore.getState().workflowFloatingPanel).toEqual({
        payload: { projectId: 'p1', threadId: 't1', runId: 'run-1' },
      });
      expect(useStore.getState().workflowPanelDismissed).toBeNull();
    });

    it('非对象 payload → null payload；非字符串字段 → null', () => {
      const s = useStore.getState();
      s.openWorkflowPanel({ threadId: 42, runId: null });
      expect(useStore.getState().workflowFloatingPanel).toEqual({ payload: { projectId: null, threadId: null, runId: null } });
      s.openWorkflowPanel(null);
      expect(useStore.getState().workflowFloatingPanel).toEqual({ payload: null });
    });

    it('手动打开清 dismiss 窗（覆盖 dismiss 记录）', () => {
      useStore.setState({ workflowPanelDismissed: { runId: 'run-1', at: 12345 } });
      useStore.getState().openWorkflowPanel({ threadId: 't1', runId: 'run-2' });
      expect(useStore.getState().workflowPanelDismissed).toBeNull();
    });
  });

  describe('closeWorkflowPanel - dismissed 记录（时间戳 + 禁用 lastPromptRunId fallback）', () => {
    it('payload.runId 优先记录', () => {
      useStore.setState({ workflowFloatingPanel: { payload: { projectId: 'p1', threadId: 't1', runId: 'run-9' } } });
      useStore.getState().closeWorkflowPanel();
      const dismissed = useStore.getState().workflowPanelDismissed;
      expect(dismissed.runId).toBe('run-9');
      expect(Number.isFinite(dismissed.at)).toBe(true);
      expect(useStore.getState().workflowFloatingPanel).toBeNull();
    });

    it('payload 无 runId 时用 activePromptRunId', () => {
      useStore.setState({
        workflowFloatingPanel: { payload: { projectId: 'p1', threadId: 't1', runId: null } },
        activePromptRunId: 'run-live',
      });
      useStore.getState().closeWorkflowPanel();
      expect(useStore.getState().workflowPanelDismissed.runId).toBe('run-live');
    });

    it('两者皆无 → runId null（不再 fallback lastPromptRunId）', () => {
      useStore.setState({
        workflowFloatingPanel: { payload: { projectId: null, threadId: null, runId: null } },
        activePromptRunId: null,
        lastPromptRunId: 'old-run',
      });
      useStore.getState().closeWorkflowPanel();
      expect(useStore.getState().workflowPanelDismissed.runId).toBeNull();
    });
  });

  describe('closeWorkflowPanelIfBound - 幂等关闭', () => {
    it('面板不存在 → false 不抛', () => {
      expect(useStore.getState().closeWorkflowPanelIfBound('t1')).toBe(false);
    });

    it('面板绑定目标线程 → 关闭', () => {
      useStore.setState({ workflowFloatingPanel: { payload: { projectId: 'p1', threadId: 't1', runId: 'r' } } });
      expect(useStore.getState().closeWorkflowPanelIfBound('t1')).toBe(true);
      expect(useStore.getState().workflowFloatingPanel).toBeNull();
    });

    it('面板绑定其他线程 → 不动', () => {
      useStore.setState({ workflowFloatingPanel: { payload: { projectId: 'p1', threadId: 't2', runId: 'r' } } });
      expect(useStore.getState().closeWorkflowPanelIfBound('t1')).toBe(false);
      expect(useStore.getState().workflowFloatingPanel).not.toBeNull();
    });

    it('面板未绑定线程（threadId null）→ 关闭（生命周期切换兜底）', () => {
      useStore.setState({ workflowFloatingPanel: { payload: { projectId: null, threadId: null, runId: null } } });
      expect(useStore.getState().closeWorkflowPanelIfBound('t1')).toBe(true);
      expect(useStore.getState().workflowFloatingPanel).toBeNull();
    });
  });

  describe('toggleWorkflowPanel - 开/关切换', () => {
    it('关闭态 → 打开（payload 规范化）', () => {
      useStore.getState().toggleWorkflowPanel({ threadId: 't1', runId: 'r' });
      expect(useStore.getState().workflowFloatingPanel.payload.threadId).toBe('t1');
    });

    it('打开态 → 关闭（记录 dismissed）', () => {
      useStore.getState().toggleWorkflowPanel({ threadId: 't1', runId: 'r' });
      useStore.getState().toggleWorkflowPanel();
      expect(useStore.getState().workflowFloatingPanel).toBeNull();
      expect(useStore.getState().workflowPanelDismissed.runId).toBe('r');
    });
  });

  describe('deleteThread - 面板绑定被删线程时关闭', () => {
    it('删除面板绑定线程 → 面板关闭 + dismissed 记录', async () => {
      useStore.setState({
        workflowFloatingPanel: { payload: { projectId: 'p1', threadId: 't1', runId: 'run-1' } },
        sessions: [],
      });
      await expect(useStore.getState().deleteThread('t1')).resolves.toBe(true);
      expect(useStore.getState().workflowFloatingPanel).toBeNull();
      expect(useStore.getState().workflowPanelDismissed.runId).toBe('run-1');
    });

    it('删除非面板绑定线程 → 面板保持', async () => {
      useStore.setState({
        workflowFloatingPanel: { payload: { projectId: 'p1', threadId: 't1', runId: 'run-1' } },
        sessions: [],
      });
      await expect(useStore.getState().deleteThread('t2')).resolves.toBe(true);
      expect(useStore.getState().workflowFloatingPanel.payload.threadId).toBe('t1');
    });
  });

  describe('sendPrompt - 新回合清理 subagentReports（消除跨回合串扰）', () => {
    it('发送前清空 subagentReports（回退展示 lastSubagentReports）', async () => {
      const fakeClient = {
        hasActivePrompt: vi.fn(() => false),
        initializeSession: vi.fn().mockRejectedValue(new Error('no backend in test')),
        request: vi.fn().mockRejectedValue(new Error('no backend in test')),
        respondToPermissionRequest: vi.fn(),
        destroy: vi.fn(),
      };
      useStore.setState({
        getThreadClient: () => fakeClient,
        threadRuntimeById: {
          t1: {
            subagentReports: [{ id: 'old' }],
            lastSubagentReports: [{ id: 'old' }],
            promptQueue: [],
            pendingAttachments: [],
            promptSuggestion: null,
            isAwaitingResponse: false,
            activePromptRunId: null,
            promptDispatchInFlight: false,
          },
        },
      });
      await useStore.getState().sendPrompt('hello');
      // 后端不可用时 sendPrompt 可能返回 false/吞错——只断言清理已发生
      const runtime = useStore.getState().threadRuntimeById.t1;
      expect(runtime.subagentReports).toEqual([]);
      expect(runtime.lastSubagentReports).toEqual([{ id: 'old' }]);
    });
  });
});
