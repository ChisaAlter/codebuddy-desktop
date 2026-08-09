import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { Profiler } from 'react';
import { act } from 'react';
import { useStore } from '../../src/store';
import { WorkflowFloatingPanelBody } from '../../src/components/WorkflowFloatingPanelSections';

// M3 实测门禁：流式纯 chunk 期间面板渲染不随 chunk 线性增长，结构事件才触发重算。
// 用 React Profiler 统计 Body 子树每次提交（父组件计数测不到子组件订阅驱动更新）。
let container;
let renderCount = 0;
function onRender() {
  renderCount += 1;
}

function baseRuntime() {
  return {
    timeline: [],
    goalState: { goalsById: {}, mode: null },
    lastGoalState: null,
    subagentReports: [],
    lastSubagentReports: null,
    teamState: null,
    lastTeamState: null,
    workflowState: null,
    lastWorkflowState: null,
    activePromptRunId: null,
    promptStartedAt: null,
    isAwaitingResponse: false,
    agentPhase: null,
    progress: null,
    permissionRequests: [],
    questions: [],
    memberHistoriesByName: {},
    subagentToolCalls: {},
    rawExtensionEvents: [],
    promptQueue: [],
  };
}

describe('M3 render-count gate: streaming chunks do not re-render the panel', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    renderCount = 0;
    // GitToolSection 的 refresh 挂起（pending promise）：隔离其异步 setState 对计数的污染
    window.electronAPI = { runGit: vi.fn().mockReturnValue(new Promise(() => {})) };
    useStore.setState({
      projectsById: {},
      threadsById: { t1: { id: 't1', status: 'running' } },
      threadRuntimeById: { t1: baseRuntime() },
      activeThreadId: 't1',
      workflowFloatingPanel: null,
    });
  });

  afterEach(() => {
    container.remove();
    delete window.electronAPI;
  });

  it('纯 chunk（仅 memberHistoriesByName 变化）不随 chunk 线性增长；结构事件精确触发', async () => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container);
    await act(async () => {
      root.render(
        React.createElement(
          Profiler,
          { id: 'body', onRender },
          React.createElement(WorkflowFloatingPanelBody, { threadId: 't1' }),
        ),
      );
    });
    const initial = renderCount;
    expect(initial).toBeGreaterThan(0);

    // 模拟 30 个流式纯内容 chunk：只有 memberHistoriesByName 引用变化。
    // React 18 useSyncExternalStore 挂载后有 1-2 次预热渲染（固有行为），
    // 之后渲染次数与 chunk 数无关——量化门禁：预热上限内，不随 chunk 线性增长。
    for (let index = 0; index < 30; index += 1) {
      await act(async () => {
        useStore.getState().patchThreadRuntime('t1', {
          memberHistoriesByName: { m1: [{ content: `chunk-${index}` }] },
        });
      });
    }
    expect(renderCount - initial).toBeLessThanOrEqual(2);
    const afterChunks = renderCount;

    // 结构事件：goalState 变化 → 精确触发一次重算
    await act(async () => {
      useStore.getState().patchThreadRuntime('t1', {
        goalState: { goalsById: { g1: { goalId: 'g1', title: '目标一', status: 'running' } }, mode: null },
      });
    });
    expect(renderCount).toBe(afterChunks + 1);

    // 结构事件：subagentReports 新数组 → 精确触发一次重算
    await act(async () => {
      useStore.getState().patchThreadRuntime('t1', {
        subagentReports: [{ id: 'a1', name: '探索', status: 'running', summary: '工作中' }],
      });
    });
    expect(renderCount).toBe(afterChunks + 2);
  });

  it('timeline 结构事件触发重算（任务/状态展示需要）', async () => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container);
    await act(async () => {
      root.render(
        React.createElement(
          Profiler,
          { id: 'body', onRender },
          React.createElement(WorkflowFloatingPanelBody, { threadId: 't1' }),
        ),
      );
    });
    // 预热两次无关 set（React 18 首次 store 通知的预热渲染）
    await act(async () => {
      useStore.getState().patchThreadRuntime('t1', { historyReplayActive: false });
    });
    await act(async () => {
      useStore.getState().patchThreadRuntime('t1', { historyReplayActive: false });
    });
    const beforeTimeline = renderCount;

    await act(async () => {
      useStore.getState().patchThreadRuntime('t1', {
        timeline: [{ type: 'tool_call', id: 'tc1', status: 'running' }],
      });
    });
    // timeline 结构事件必须触发重算（≥1），且不产生渲染风暴（≤2）
    const delta = renderCount - beforeTimeline;
    expect(delta).toBeGreaterThanOrEqual(1);
    expect(delta).toBeLessThanOrEqual(2);
  });
});
