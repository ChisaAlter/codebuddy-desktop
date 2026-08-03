import { describe, expect, it } from 'vitest';
import {
  appendRawExtensionEvent,
  classifyAcpUpdate,
  completedTeamSnapshot,
  goalEventFromPayload,
  mergeCodeBuddyTeamState,
  normalizeTeamUpdate,
  subagentMetadata,
} from '../../src/lib/acp-workflow-events';
import { mergeMemberTimeline, reduceAcpEvent } from '../../src/lib/timeline';
import { normalizeWorkflowStatus } from '../../src/lib/workflow-status';

const teamMembers = [
  {
    name: '主进程',
    color: '#4f8cff',
    description: '分析主进程',
    status: 'running',
    taskId: 'task-main',
    sessionId: 'session-main',
    tokenUsage: { inputTokens: 120, outputTokens: 40, lastContextWindow: 1000 },
    toolCallCount: 3,
  },
  {
    name: '渲染层',
    description: '分析渲染层',
    status: 'pending',
    taskId: 'task-renderer',
  },
];

describe('CodeBuddy ACP workflow extensions', () => {
  it('classifies standard state_update as workflow state', () => {
    expect(classifyAcpUpdate({
      sessionUpdate: 'state_update',
      state: { phase: 'executing' },
    })).toMatchObject({ kind: 'workflow', source: 'acp-standard' });
  });

  it('extracts bare goal events for runtime activity and auto-open', () => {
    expect(goalEventFromPayload({
      sessionUpdate: 'goal-progress',
      goalId: 'goal-1',
      percent: 25,
    })).toMatchObject({ type: 'goal-progress', payload: { goalId: 'goal-1', percent: 25 } });
  });

  it('merges team_created and incremental member_status_change snapshots', () => {
    const created = mergeCodeBuddyTeamState(null, {
      type: 'team_created',
      teamName: '项目探索',
      isAutoTeam: true,
      members: teamMembers,
    }, 100);
    const updated = mergeCodeBuddyTeamState(created, {
      type: 'member_status_change',
      members: [{ taskId: 'task-main', status: 'completed', toolCallCount: 5 }],
    }, 200);

    expect(created).toMatchObject({ teamName: '项目探索', active: true, members: teamMembers });
    expect(updated.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: 'task-main', status: 'completed', toolCallCount: 5, description: '分析主进程' }),
      expect.objectContaining({ taskId: 'task-renderer', status: 'pending' }),
    ]));
  });

  it('preserves a completed snapshot when team_deleted arrives', () => {
    const active = mergeCodeBuddyTeamState(null, { type: 'team_created', name: '探索', members: teamMembers }, 100);
    const completed = completedTeamSnapshot(active, { type: 'team_deleted' }, 300);
    expect(completed).toMatchObject({ type: 'team_deleted', active: false, status: 'completed', updatedAt: 300 });
    expect(completed.members).toHaveLength(2);
  });

  it('recognizes only explicit subagent metadata', () => {
    expect(subagentMetadata({ title: 'Read file' })).toBeNull();
    expect(subagentMetadata({
      _meta: { agentId: '1785720595825-gc8kb5' },
    })).toBeNull();
    expect(subagentMetadata({
      _meta: {
        'codebuddy.ai/isSubAgent': true,
        'codebuddy.ai/parentToolCallId': 'parent-1',
        'codebuddy.ai/subagentType': 'explorer',
        'codebuddy.ai/memberName': '主进程',
      },
    })).toMatchObject({ isSubagent: true, parentToolCallId: 'parent-1', memberName: '主进程' });
  });

  it('bounds unknown extension events', () => {
    let events = [];
    for (let index = 0; index < 120; index += 1) {
      events = appendRawExtensionEvent(events, 'codebuddy.ai/custom', { index });
    }
    expect(events).toHaveLength(100);
    expect(events[0].payload.index).toBe(20);
  });

  it('builds an isolated member history for member chunks', () => {
    const payload = {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'member-message',
      content: '成员进度',
      _meta: { 'codebuddy.ai/memberEvent': '主进程' },
    };
    const memberHistories = mergeMemberTimeline({}, '主进程', 'agent_message_chunk', payload, 'thread-1');
    const leaderTimeline = reduceAcpEvent([], 'agent_message_chunk', {
      ...payload,
      _meta: {},
    }, 'thread-1');
    expect(memberHistories['主进程'][0].content).toBe('成员进度');
    expect(leaderTimeline[0].content).toBe('成员进度');
    expect(memberHistories['主进程']).not.toBe(leaderTimeline);
  });

  it('nests explicit child tools whether child or parent arrives first', () => {
    const child = {
      sessionUpdate: 'tool_call',
      toolCallId: 'child-1',
      title: 'Read',
      _meta: {
        'codebuddy.ai/isSubAgent': true,
        'codebuddy.ai/parentToolCallId': 'parent-1',
      },
    };
    const parent = { sessionUpdate: 'tool_call', toolCallId: 'parent-1', title: 'Agent' };
    const childFirst = reduceAcpEvent(reduceAcpEvent([], 'tool_call', child), 'tool_call', parent);
    const parentFirst = reduceAcpEvent(reduceAcpEvent([], 'tool_call', parent), 'tool_call', child);
    for (const timeline of [childFirst, parentFirst]) {
      expect(timeline).toHaveLength(1);
      expect(timeline[0].toolCallId).toBe('parent-1');
      expect(timeline[0].children[0]).toMatchObject({ toolCallId: 'child-1', isSubAgent: true });
    }
  });

  it('does not turn ordinary tools or prose into subagent rows', () => {
    const status = normalizeWorkflowStatus({
      threadStatus: 'running',
      runtime: {
        activePromptRunId: 'run-1',
        timeline: [{ type: 'tool_call', toolCallId: 'read-1', title: 'Read', status: 'running' }],
      },
    });
    expect(status.source).toBe('tools');
    expect(status.shouldAutoOpen).toBe(false);
    expect(status.members).toHaveLength(0);
    expect(status.items[0].name).toBe('Read');
  });
});
