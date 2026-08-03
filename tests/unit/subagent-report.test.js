import { describe, expect, it } from 'vitest';
import { buildSubagentConclusion, collectSubagentReports } from '../../src/lib/subagent-report';

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
        'general-purpose': [{ type: 'message', role: 'assistant', content: '读取完成，未修改文件。' }],
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
        conclusionKind: 'text',
      }),
    ]);
  });

  it('falls back to task identity with empty conclusion kind (no path wall)', () => {
    const reports = collectSubagentReports({
      lastTeamState: { members: [{ name: '探索代理', taskId: 'task-7', status: 'completed' }] },
      emptyConclusionLabel: '',
    });
    expect(reports[0]).toMatchObject({
      name: '探索代理',
      agentId: 'task-7',
      status: 'completed',
      conclusionKind: 'empty',
    });
    expect(String(reports[0].conclusion || '')).not.toMatch(/node_modules|C:\\/);
  });

  it('S01 prefers assistant message as conclusion', () => {
    const built = buildSubagentConclusion({
      history: [
        { type: 'tool_call', content: 'noise' },
        { type: 'message', role: 'assistant', content: '最终结论：通过。' },
      ],
      tools: [],
    });
    expect(built.conclusion).toBe('最终结论：通过。');
    expect(built.conclusionKind).toBe('text');
  });

  it('S02 path-wall rawOutput becomes path_list not raw dump', () => {
    const paths = Array.from({ length: 12 }, (_, i) => `C:\\A\\proj\\node_modules\\p${i}\\index.js`);
    const built = buildSubagentConclusion({
      history: [],
      tools: [{ toolName: 'Glob', rawOutput: paths.join('\n') }],
    });
    expect(built.conclusionKind).toBe('path_list');
    expect(built.pathList.count).toBe(12);
    expect(built.conclusion).toBe('');
  });

  it('S03 assistant before tool garbage still wins', () => {
    const built = buildSubagentConclusion({
      history: [
        { type: 'message', role: 'assistant', content: '人话结论' },
        { type: 'tool_call', content: 'C:\\a\\b\\c' },
      ],
      tools: [{ rawOutput: 'C:\\x\\y\\z\nC:\\x\\y\\w' }],
    });
    expect(built.conclusion).toBe('人话结论');
  });

  it('S04 two agents with same role different ids stay separate', () => {
    const reports = collectSubagentReports({
      teamState: {
        members: [
          { name: 'worker', role: 'explorer', agentId: 'agent-a', status: 'completed' },
          { name: 'worker-2', role: 'explorer', agentId: 'agent-b', status: 'completed' },
        ],
      },
      memberHistoriesByName: {
        worker: [{ type: 'message', role: 'assistant', content: 'A done' }],
        'worker-2': [{ type: 'message', role: 'assistant', content: 'B done' }],
      },
    });
    expect(reports).toHaveLength(2);
    const byId = Object.fromEntries(reports.map((r) => [r.agentId, r]));
    expect(byId['agent-a'].conclusion).toBe('A done');
    expect(byId['agent-b'].conclusion).toBe('B done');
  });

  it('S05 tools-only yields tool_summary not path wall', () => {
    const built = buildSubagentConclusion({
      history: [],
      tools: [
        { toolName: 'Read', status: 'completed' },
        { toolName: 'Read', status: 'completed' },
        { toolName: 'Bash', status: 'completed' },
      ],
    });
    expect(built.conclusionKind).toBe('tool_summary');
    expect(built.summary).toMatch(/Read/);
  });
});
