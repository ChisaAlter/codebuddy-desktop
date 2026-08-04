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
        teamState: { teamName: '探索团队', members: [{ id: 'agent-1', name: '搜索', task: '扫描项目', status: 'running', taskId: 'task-1' }] },
        memberHistoriesByName: {},
      },
    };
    store.threadsById = { 'thread-1': { id: 'thread-1', status: 'running', timeline: [] } };
    store.closeWorkflowPanel.mockReset();
  });
  afterEach(() => container.remove());

  it('renders workflow details as a separate floating dialog', async () => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(WorkflowFloatingPanelHost)));
    expect(container.querySelector('[data-testid="workflow-floating-panel"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="workflow-right-panel"]')).toBeTruthy();
    expect(container.textContent).toContain('搜索');
    expect(container.textContent).toContain('task-1');
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

  it('goal-only run does not invent a fake subagent row from the goal title', async () => {
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
      },
    };
    store.threadsById = { 'thread-1': { id: 'thread-1', status: 'running', timeline: [] } };

    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(WorkflowFloatingPanelHost)));

    expect(container.querySelector('[data-testid="workflow-current-goal"]')).toBeTruthy();
    expect(container.textContent).toContain('进行代码的全部检查，落实文档');
    // Synthetic goal step must not appear under 子代理
    expect(container.querySelector('[data-testid="workflow-members"]')).toBeNull();
    expect(container.textContent).not.toContain('暂无任务详情');
    expect(container.textContent).not.toMatch(/1\/1\s*项进行中/);
    // Overview keeps a generic label; goal title only once in GoalCard
    const titleHits = container.textContent.split('进行代码的全部检查，落实文档').length - 1;
    expect(titleHits).toBe(1);
    root.unmount();
  });
});
