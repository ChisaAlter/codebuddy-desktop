import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  workflowFloatingPanel: null,
  closeWorkflowPanel: vi.fn(),
  activeThreadId: 'thread-1',
  threadRuntimeById: {},
  threadsById: {},
  guiSettings: { locale: 'zh' },
}));

vi.mock('../../src/store', () => ({
  useStore(selector) {
    return selector(store);
  },
}));

import WorkflowFloatingPanelHost from '../../src/components/WorkflowFloatingPanelHost';

function setupGitMock() {
  window.electronAPI = {
    runGit: vi.fn(({ args }) => {
      if (args[0] === 'branch') return Promise.resolve({ ok: true, output: 'master\n' });
      if (args[0] === 'diff') return Promise.resolve({ ok: true, output: '3\t1\tpackage.json\n' });
      if (args[0] === 'status') return Promise.resolve({ ok: true, output: '## master...origin/master [ahead 2]\n M file.txt\n' });
      return Promise.resolve({ ok: true, output: '' });
    }),
  };
}

function flush() {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('WorkflowFloatingPanelHost', () => {
  let container;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    store.workflowFloatingPanel = {
      payload: { threadId: 'thread-1', runId: 'run-1' },
    };
    store.threadRuntimeById = {
      'thread-1': {
        timeline: [],
        teamState: null,
        memberHistoriesByName: {},
        subagentReports: [
          {
            id: 'agent-1',
            name: '搜索',
            status: 'running',
            description: '扫描项目',
            summary: '正在读取 package.json',
            toolCallCount: 2,
            conclusion: '',
            conclusionKind: 'empty',
            pathList: null,
          },
          {
            id: 'agent-2',
            name: '6 paths',
            status: 'completed',
            description: '查找相关文件',
            summary: '找到 6 个相关文件',
            toolCallCount: 1,
            conclusionKind: 'path_list',
            pathList: { count: 8, preview: ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'] },
          },
        ],
      },
    };
    store.threadsById = { 'thread-1': { id: 'thread-1', status: 'running', timeline: [] } };
    store.closeWorkflowPanel.mockReset();
  });
  afterEach(() => {
    container.remove();
    delete window.electronAPI;
  });

  it('renders the redesigned panel: git tools + subagent rows', async () => {
    setupGitMock();
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(WorkflowFloatingPanelHost)));
    await flush();

    expect(container.querySelector('[data-testid="workflow-floating-panel"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="workflow-right-panel"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="workflow-git-tools"]')).toBeTruthy();
    expect(container.textContent).toContain('Git 工具');
    expect(container.textContent).toContain('master');
    // worktree + cached 两个 numstat 各 +3 → 总计 +6
    expect(container.textContent).toContain('+6');
    // 子代理列表：名称 + 「在干什么」一句话
    expect(container.textContent).toContain('搜索');
    expect(container.textContent).toContain('正在读取 package.json');
    expect(container.textContent).toContain('6 paths');
    root.unmount();
  });

  it('expands a subagent row to show its work content', async () => {
    setupGitMock();
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(WorkflowFloatingPanelHost)));
    await flush();

    // 默认收起：路径列表不可见
    expect(container.querySelector('[data-testid="subagent-path-list"]')).toBeNull();
    const heads = container.querySelectorAll('.workflow-panel__subagent-head');
    expect(heads.length).toBe(2);

    // 点击「6 paths」行展开
    await act(async () => {
      heads[1].click();
    });
    expect(container.querySelector('[data-testid="subagent-path-list"]')).toBeTruthy();
    expect(container.textContent).toContain('8 条路径');
    // 截断提示：8 条只预览 5 条，提示还有 3 条
    expect(container.textContent).toContain('还有 3 条');
    expect(container.textContent).toContain('a.js');
    root.unmount();
  });

  it('closes on Escape', async () => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(WorkflowFloatingPanelHost)));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(store.closeWorkflowPanel).toHaveBeenCalledTimes(1);
    root.unmount();
  });

  it('hides goal and task sections when there are no goals/tasks', async () => {
    setupGitMock();
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(WorkflowFloatingPanelHost)));
    await flush();

    expect(container.querySelector('[data-testid="workflow-goals"]')).toBeNull();
    expect(container.querySelector('[data-testid="workflow-tasks"]')).toBeNull();
    root.unmount();
  });

  it('renders workflow progress agents when explicit subagent reports are unavailable', async () => {
    store.threadRuntimeById = {
      'thread-1': {
        timeline: [],
        teamState: null,
        memberHistoriesByName: {},
        subagentReports: [],
        workflowState: {
          runId: 'workflow-1',
          active: true,
          status: 'running',
          agents: [{
            id: 'workflow-agent-1',
            name: 'Inspect runtime',
            phase: 'Runtime',
            status: 'running',
          }],
        },
      },
    };
    setupGitMock();

    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(WorkflowFloatingPanelHost)));
    await flush();

    expect(container.querySelectorAll('.workflow-panel__subagent')).toHaveLength(1);
    expect(container.textContent).toContain('Inspect runtime');
    expect(container.textContent).toContain('Runtime');
    expect(container.textContent).not.toContain('暂无子代理活动');
    root.unmount();
  });

  it('goal-only run shows the goal list without inventing subagent rows', async () => {
    const now = Date.now();
    store.threadRuntimeById = {
      'thread-1': {
        timeline: [],
        activePromptRunId: 'run-goal',
        promptStartedAt: now - 8000,
        goalState: {
          mode: 'goal',
          goalsById: {
            g1: {
              goalId: 'g1',
              title: '进行代码的全部检查，落实文档',
              status: 'running',
              message: '目标进行中',
              updatedAt: now,
            },
          },
          activeGoalId: 'g1',
          eventCount: 1,
          updatedAt: now,
        },
        teamState: null,
        memberHistoriesByName: {},
        subagentReports: [],
      },
    };
    store.threadsById = { 'thread-1': { id: 'thread-1', status: 'running', timeline: [] } };
    setupGitMock();

    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(WorkflowFloatingPanelHost)));
    await flush();

    expect(container.querySelector('[data-testid="workflow-goals"]')).toBeTruthy();
    expect(container.textContent).toContain('进行代码的全部检查，落实文档');
    // 子代理区存在但为空态，无子代理行
    expect(container.querySelector('[data-testid="workflow-subagents"]')).toBeTruthy();
    expect(container.querySelector('.workflow-panel__subagent')).toBeNull();
    // 目标标题只出现一次
    const titleHits = container.textContent.split('进行代码的全部检查，落实文档').length - 1;
    expect(titleHits).toBe(1);
    root.unmount();
  });
});
