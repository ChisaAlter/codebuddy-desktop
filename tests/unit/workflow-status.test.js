import { describe, expect, it } from 'vitest';
import {
  deriveWorkflowView,
  normalizeWorkflowStatus,
  presentWorkflowTopbarHighlight,
} from '../../src/lib/workflow-status';

const memberNames = ['主进程', '渲染层', 'preload/shared', '构建配置', '测试文档', 'git 历史'];

describe('workflow status normalization', () => {
  it('keeps an explicit team snapshot as six independently visible subagents', () => {
    const status = normalizeWorkflowStatus({
      threadStatus: 'running',
      runtime: {
        activePromptRunId: 'run-1',
        promptStartedAt: 1000,
        agentPhase: { phase: 'planning', startedAt: 1200 },
        progress: { current: 2, total: 6, message: '正在并行探索' },
        teamState: {
          name: '探索工作流',
          members: memberNames.map((name, index) => ({
            id: `agent-${index}`,
            name,
            task: `检查 ${name}`,
            status: index < 2 ? 'running' : index === 5 ? 'failed' : 'completed',
          })),
        },
      },
      now: 5000,
    });

    expect(status.source).toBe('team');
    expect(status.visible).toBe(true);
    expect(status.active).toBe(true);
    expect(status.reportedCount).toBe(6);
    expect(status.items).toHaveLength(6);
    expect(status.activeCount).toBe(2);
    expect(status.completedCount).toBe(3);
    expect(status.failedCount).toBe(1);
    expect(status.progress).toMatchObject({ current: 2, total: 6, percent: 33.33333333333333 });
    expect(status.items[0]).toMatchObject({ name: '主进程', task: '检查 主进程', status: 'running' });
  });

  it('treats ordinary tools as tools-only and real task rows as steps', () => {
    const status = normalizeWorkflowStatus({
      threadStatus: 'running',
      runtime: { activePromptRunId: 'run-2', promptStartedAt: 2000 },
      timeline: [
        { type: 'message', role: 'user', content: '检查项目', createdAt: 2000 },
        {
          type: 'tool_call',
          toolCallId: 'tool-1',
          title: 'Read',
          status: 'in_progress',
          rawInput: { path: 'src/App.jsx' },
          createdAt: 2100,
        },
        {
          type: 'taskCreated',
          id: 'task-1',
          meta: { title: '运行测试', status: 'pending' },
          createdAt: 2200,
        },
      ],
    });

    expect(status.source).toBe('timeline');
    expect(status.members).toEqual([]);
    expect(status.steps).toHaveLength(1);
    expect(status.tools).toHaveLength(1);
    expect(status.tools[0]).toMatchObject({ name: 'Read', task: 'src/App.jsx', kind: 'tool' });
    expect(status.steps[0]).toMatchObject({ name: '运行测试', status: 'pending', kind: 'task' });
    expect(status.shouldAutoOpen).toBe(false);
  });

  it('empty new session is idle with no fake running/completed chrome', () => {
    const runtime = {
      timeline: [
        {
          type: 'message',
          role: 'assistant',
          content: '<system-reminder>ultracode mode enabled</system-reminder>',
          createdAt: 1000,
        },
      ],
    };
    const status = normalizeWorkflowStatus({
      threadStatus: 'idle',
      runtime,
      now: 2000,
    });
    expect(status.visible).toBe(false);
    expect(status.active).toBe(false);
    expect(status.status).toBe('idle');
    expect(status.shouldAutoOpen).toBe(false);
    expect(status.phase).toBe('');
    expect(status.members).toEqual([]);
    expect(status.tools).toEqual([]);

    const view = deriveWorkflowView({ threadStatus: 'idle', runtime, now: 2000 });
    expect(view.kind).toBe('empty');
    expect(view.empty).toBe(true);
    expect(view.highlightTopbar).toBe(false);
    expect(view.showStatus).toBe(false);
    expect(view.showPhase).toBe(false);
    expect(view.status).toBe('idle');
    expect(view.phase).toBe('');
    // Hard invariant: never completed chrome when empty
    expect(view.status).not.toBe('completed');
    expect(presentWorkflowTopbarHighlight(runtime, 'idle', runtime.timeline)).toBe(false);
  });

  it('deriveWorkflowView never pairs completed status with empty body', () => {
    const view = deriveWorkflowView({
      threadStatus: 'idle',
      runtime: { lastTeamState: { members: [] }, agentPhase: null, progress: null },
    });
    expect(view.empty).toBe(true);
    expect(view.showStatus).toBe(false);
    expect(view.showPhase).toBe(false);
    expect(view.highlightTopbar).toBe(false);
  });

  it('does not auto-open for tools-only TaskCreate spam', () => {
    const runtime = { activePromptRunId: 'run-tools', promptStartedAt: 2000 };
    const timeline = [
      { type: 'message', role: 'user', content: '实现', createdAt: 2000 },
      {
        type: 'tool_call',
        toolCallId: 't1',
        title: 'TaskCreate',
        status: 'completed',
        rawInput: { description: '写 token' },
        createdAt: 2100,
      },
      {
        type: 'tool_call',
        toolCallId: 't2',
        title: 'TaskCreate',
        status: 'in_progress',
        rawInput: { description: '写样式' },
        createdAt: 2200,
      },
    ];
    const status = normalizeWorkflowStatus({
      threadStatus: 'running',
      runtime,
      timeline,
    });
    expect(status.source).toBe('tools');
    expect(status.shouldAutoOpen).toBe(false);
    expect(status.toolsRunningCount).toBe(1);
    expect(status.phase).toBe('tool_executing');

    // Hybrid A: tools-only is chat process, not floating-panel orchestration.
    const view = deriveWorkflowView({ threadStatus: 'running', runtime, timeline });
    expect(view.empty).toBe(true);
    expect(view.kind).toBe('empty');
    expect(view.toolsOnly).toBe(true);
    expect(view.highlightTopbar).toBe(false);
    expect(view.shouldAutoOpen).toBe(false);
  });

  it('ignores stale execution events from an earlier user turn', () => {
    const status = normalizeWorkflowStatus({
      threadStatus: 'running',
      runtime: { activePromptRunId: 'run-3', promptStartedAt: 3000 },
      timeline: [
        { type: 'message', role: 'user', content: '旧问题', createdAt: 1000 },
        { type: 'tool_call', toolCallId: 'old', title: '旧工具', status: 'running', createdAt: 1100 },
        { type: 'message', role: 'user', content: '新问题', createdAt: 3000 },
        { type: 'tool_call', toolCallId: 'new', title: '新工具', status: 'completed', createdAt: 3100 },
      ],
    });

    // tools-only: items are tools from the current turn only
    expect(status.source).toBe('tools');
    expect(status.items).toHaveLength(1);
    expect(status.items[0].id).toBe('new');
  });

  it('keeps the workflow visible while a permission request is unresolved', () => {
    const status = normalizeWorkflowStatus({
      threadStatus: 'idle',
      runtime: {
        promptStartedAt: 1000,
        permissionRequests: [{ interruptionId: 'permission-1', status: 'pending' }],
      },
      now: 4000,
    });

    expect(status.visible).toBe(true);
    expect(status.active).toBe(true);
    expect(status.status).toBe('waiting');
    expect(status.phase).toBe('waiting_for_permission');
    expect(status.items).toEqual([]);
  });

  it('maps unresolved questions to the same waiting workflow state', () => {
    const status = normalizeWorkflowStatus({
      threadStatus: 'idle',
      runtime: {
        questions: [{ toolCallId: 'question-1', status: 'pending' }],
      },
    });

    expect(status.visible).toBe(true);
    expect(status.active).toBe(true);
    expect(status.status).toBe('waiting');
    expect(status.phase).toBe('waiting_for_permission');
  });
  it('exposes a goal-only workflow step and projection', () => {
    const status = normalizeWorkflowStatus({
      threadStatus: 'running',
      runtime: {
        activePromptRunId: 'run-goal',
        promptStartedAt: 1000,
        goalState: {
          mode: 'goal',
          eventCount: 1,
          activeGoalId: 'g1',
          goalsById: {
            g1: { goalId: 'g1', title: '完成目标', status: 'running', progress: { percent: 40 }, updatedAt: 1200 },
          },
        },
      },
      timeline: [],
    });
    expect(status.source).toBe('goal');
    expect(status.currentGoal.title).toBe('完成目标');
    expect(status.items[0]).toMatchObject({ kind: 'goal', status: 'running' });
  });
  it('reports a completed team snapshot after the prompt reaches idle', () => {
    const status = normalizeWorkflowStatus({
      threadStatus: 'idle',
      runtime: {
        teamState: { members: [{ id: 'a', name: '探索', status: 'completed' }] },
        agentPhase: { phase: 'idle', startedAt: 1000 },
        promptStartedAt: 1000,
      },
      now: 4000,
    });

    expect(status.visible).toBe(true);
    expect(status.active).toBe(false);
    expect(status.status).toBe('completed');
    expect(status.durationMs).toBe(3000);
  });
});
