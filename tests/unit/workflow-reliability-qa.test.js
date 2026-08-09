/**
 * Production QA contract tests for workflow IA + idle reliability + recovery.
 * These encode the frozen §2 product contract from the delivery plan.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AcpClient, AcpTimeoutError } from '../../src/lib/acp';
import { subagentMetadata } from '../../src/lib/acp-workflow-events';
import { collectSubagentReports, isBareAgentIdentity } from '../../src/lib/subagent-report';
import { formatToolCollapsedSummary } from '../../src/lib/tool-output-format';
import {
  deriveWorkflowView,
  normalizeWorkflowStatus,
  presentWorkflowActivity,
  presentWorkflowAutoOpen,
} from '../../src/lib/workflow-status';
import {
  hasUsableMemberConclusions,
} from '../../src/store/helpers/prompt-completion';

describe('QA contract: subagent identity', () => {
  it('rejects bare agent ids as subagent metadata', () => {
    expect(subagentMetadata({ title: 'TaskCreate', _meta: { agentId: '1785720595825-gc8kb5' } })).toBeNull();
    expect(isBareAgentIdentity('1785720595825-gc8kb5')).toBe(true);
  });

  it('accepts explicit subagent signals', () => {
    expect(
      subagentMetadata({
        _meta: {
          'codebuddy.ai/isSubAgent': true,
          'codebuddy.ai/memberName': 'explorer',
        },
      }),
    ).toMatchObject({ isSubagent: true, memberName: 'explorer' });
  });
});

describe('QA contract: reports and task summary', () => {
  it('drops TaskCreate id shells from collectSubagentReports', () => {
    const reports = collectSubagentReports({
      timeline: [
        {
          type: 'tool_call',
          title: 'TaskCreate',
          agentId: '1785720595825-gc8kb5',
          status: 'completed',
        },
      ],
    });
    expect(reports).toEqual([]);
  });

  it('keeps named team members with conclusions', () => {
    const reports = collectSubagentReports({
      teamState: {
        members: [{ name: 'general-purpose', role: 'explorer', agentId: 'agent-1', status: 'completed' }],
      },
      memberHistoriesByName: {
        'general-purpose': [{ type: 'message', role: 'assistant', content: '扫描完成' }],
      },
    });
    expect(reports[0]).toMatchObject({ name: 'general-purpose', conclusion: '扫描完成' });
    expect(isBareAgentIdentity(reports[0].name)).toBe(false);
  });

  it('TaskCreate summary prefers human goal text', () => {
    expect(
      formatToolCollapsedSummary({
        title: 'TaskCreate',
        rawInput: { description: '实现 prototype-v3 token' },
      }),
    ).toMatch(/prototype-v3/);
  });
});

describe('QA contract: workflow autoOpen / tools-only', () => {
  it('tools-only TaskCreate does not auto-open', () => {
    const runtime = { activePromptRunId: 'run-1', promptStartedAt: 1000 };
    const timeline = [
      { type: 'message', role: 'user', content: 'go', createdAt: 1000 },
      {
        type: 'tool_call',
        toolCallId: 't1',
        title: 'TaskCreate',
        status: 'in_progress',
        rawInput: { description: '写样式' },
        createdAt: 1100,
      },
    ];
    const status = normalizeWorkflowStatus({
      threadStatus: 'running',
      runtime,
      timeline,
    });
    expect(status.source).toBe('tools');
    expect(status.shouldAutoOpen).toBe(false);
    expect(presentWorkflowAutoOpen(status, { runId: 'run-1' })).toBe(false);
    expect(status.capabilityMessage).toBe('tools-only');
    const view = deriveWorkflowView({ threadStatus: 'running', runtime, timeline });
    expect(view.empty).toBe(true);
    expect(view.toolsOnly).toBe(true);
    expect(presentWorkflowAutoOpen(view, { runId: 'run-1' })).toBe(false);
  });

  it('team source may auto-open unless dismissed', () => {
    const status = normalizeWorkflowStatus({
      threadStatus: 'running',
      runtime: {
        activePromptRunId: 'run-team',
        promptStartedAt: 1000,
        teamState: {
          members: [{ id: 'a1', name: '探索', status: 'running', task: '扫目录' }],
        },
      },
    });
    expect(status.source).toBe('team');
    expect(status.shouldAutoOpen).toBe(true);
    expect(presentWorkflowAutoOpen(status, { runId: 'run-team' })).toBe(true);
    // M2：dismissed 结构 { runId, at }——超窗 + 同 run 永久抑制
    expect(
      presentWorkflowAutoOpen(status, { runId: 'run-team', dismissed: { runId: 'run-team', at: Date.now() - 5000 } }),
    ).toBe(false);
  });

  it('activity presenter uses tools label not fake steps for tools-only', () => {
    const t = (key, vars) => `${key}:${vars?.count ?? ''}`;
    const status = {
      active: true,
      visible: true,
      source: 'tools',
      toolsRunningCount: 2,
      phase: 'tool_executing',
    };
    expect(presentWorkflowActivity(status, t)).toMatch(/activityTools/);
  });
});

describe('QA contract: completion soft-success', () => {
  it('member conclusions count as usable orchestration output', () => {
    expect(
      hasUsableMemberConclusions({
        explorer: [{ type: 'message', role: 'assistant', content: 'done' }],
      }),
    ).toBe(true);
    expect(hasUsableMemberConclusions({ explorer: [] })).toBe(false);
  });
});

describe('QA contract: SSE keeps session/prompt idle alive', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete window.electronAPI;
  });

  it('does not idle-timeout when GET-SSE progress continues', async () => {
    let handlers;
    window.electronAPI = {
      openCodeBuddyStream(_request, nextHandlers) {
        handlers = nextHandlers;
        return { close: () => {} };
      },
    };
    const client = new AcpClient({ apiBase: 'http://127.0.0.1:45678' });
    client.connected = true;
    client.connectionId = 'conn-qa';
    const request = client.request('session/prompt', { sessionId: 's-qa', prompt: [] });

    await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
    client.handleIncomingRpc(
      {
        method: 'session/update',
        params: {
          sessionId: 's-qa',
          update: { sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'in_progress' },
        },
      },
      'notification',
    );
    await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
    handlers.onMessage({ jsonrpc: '2.0', id: '1', result: { stopReason: 'end_turn' } });
    handlers.onEnd({ ok: true, status: 200 });
    await expect(request).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('throws AcpTimeoutError after true dual-channel silence', async () => {
    window.electronAPI = {
      openCodeBuddyStream() {
        return { close: () => {} };
      },
    };
    const client = new AcpClient({ apiBase: 'http://127.0.0.1:45678' });
    client.connected = true;
    client.connectionId = 'conn-qa-timeout';
    const request = client.request('session/prompt', { sessionId: 's-timeout', prompt: [] });
    const expectation = expect(request).rejects.toBeInstanceOf(AcpTimeoutError);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 50);
    await expectation;
  });
});
