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
});
