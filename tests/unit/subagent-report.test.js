import { describe, expect, it } from 'vitest';
import { collectSubagentReports } from '../../src/lib/subagent-report';

describe('collectSubagentReports', () => {
  it('groups member metadata and tool history into a stable report', () => {
    const reports = collectSubagentReports({
      teamState: {
        members: [{ name: 'general-purpose', role: 'researcher', agentId: 'agent-1', status: 'running', toolCallCount: 1 }],
      },
      timeline: [
        { type: 'tool_call', toolCallId: 'tool-1', isSubAgent: true, memberName: 'general-purpose', title: 'Read', status: 'completed' },
      ],
      memberHistoriesByName: {
        'general-purpose': [{ type: 'message', content: '读取完成，未修改文件。' }],
      },
    });

    expect(reports).toEqual([
      expect.objectContaining({
        name: 'general-purpose',
        role: 'researcher',
        agentId: 'agent-1',
        status: 'running',
        toolCallCount: 1,
        conclusion: '读取完成，未修改文件。',
      }),
    ]);
  });

  it('falls back to task or session identity and preserves no-conclusion state', () => {
    const reports = collectSubagentReports({
      lastTeamState: { members: [{ name: '探索代理', taskId: 'task-7', status: 'completed' }] },
    });
    expect(reports[0]).toMatchObject({ name: '探索代理', agentId: 'task-7', status: 'completed', conclusion: '暂无结论' });
  });
});
