/**
 * 回归：对话完成后输入框上方不得残留「正在执行工具」等陈旧活动标签。
 *
 * 根因链（2026-08 修复前）：
 * 1. 终态回合 promptStartedAt 被清空后，currentTurnEntries 返回整个时间线，
 *    历史任意一处的工具调用都会把 source 钉为 'tools'（toolsOnly=true）。
 * 2. presentWorkflowActivity 的 tools-only 分支在 count=0 时回退到
 *    sessionActivity.tool（「正在执行工具」），即使没有任何工具在运行。
 * 3. 取消/中断后停在非终态（running）的工具条目同样被计入 running，
 *    终态后 count>0 继续下发「正在执行工具（N）」。
 * 4. ResponseActivityIndicator 无条件渲染，只要 label 非空就显示在输入框上方。
 */
import { describe, expect, it } from 'vitest';
import {
  deriveWorkflowView,
  normalizeWorkflowStatus,
  presentWorkflowActivity,
} from '../../src/lib/workflow-status';

const t = (key, vars) => `${key}:${vars?.count ?? ''}`;

function terminalRuntime(timeline) {
  // 与 responseTerminalRuntimePatch 终态一致：run / awaiting / startedAt 全部清空
  return {
    promptStartedAt: null,
    activePromptRunId: null,
    isAwaitingResponse: false,
    timeline,
  };
}

describe('regression: no stale tool-executing label after turn completion', () => {
  it('completed tools-only turn presents no activity label', () => {
    const timeline = [
      { type: 'message', role: 'user', content: 'go', createdAt: 1000 },
      { type: 'tool_call', toolCallId: 't1', title: 'Bash', status: 'completed', createdAt: 1100 },
      { type: 'message', role: 'assistant', content: 'done', streaming: false, createdAt: 1200 },
    ];
    const view = deriveWorkflowView({ runtime: terminalRuntime(timeline), threadStatus: 'idle', timeline });
    expect(view.toolsOnly).toBe(true);
    expect(view.terminal).toBe(true);
    expect(view.active).toBe(false);
    expect(view.visible).toBe(false);
    expect(presentWorkflowActivity(view, t)).toBeNull();
  });

  it('cancelled turn with tool stuck in running state presents no activity label', () => {
    // 取消/中断后工具条目可能停在 running（closeAssistantStream 不终态化工具条目）
    const timeline = [
      { type: 'message', role: 'user', content: 'go', createdAt: 1000 },
      { type: 'tool_call', toolCallId: 't1', title: 'Bash', status: 'running', createdAt: 1100 },
    ];
    const view = deriveWorkflowView({ runtime: terminalRuntime(timeline), threadStatus: 'cancelled', timeline });
    expect(view.terminal).toBe(true);
    expect(view.toolsRunningCount).toBe(0);
    expect(view.activeCount).toBe(0);
    expect(presentWorkflowActivity(view, t)).toBeNull();
  });

  it('historical tools do not pollute the label of a later plain-chat turn', () => {
    const timeline = [
      { type: 'message', role: 'user', content: 'turn1 with tools', createdAt: 1000 },
      { type: 'tool_call', toolCallId: 't1', title: 'Bash', status: 'completed', createdAt: 1100 },
      { type: 'message', role: 'assistant', content: 'done1', streaming: false, createdAt: 1200 },
      { type: 'message', role: 'user', content: 'turn2 plain chat', createdAt: 2000 },
      { type: 'message', role: 'assistant', content: 'done2', streaming: false, createdAt: 2100 },
    ];
    const view = deriveWorkflowView({ runtime: terminalRuntime(timeline), threadStatus: 'idle', timeline });
    expect(view.toolsOnly).toBe(false);
    expect(presentWorkflowActivity(view, t)).toBeNull();
  });

  it('active tools-only turn still shows the tools label', () => {
    const runtime = { activePromptRunId: 'run-1', promptStartedAt: 1000, isAwaitingResponse: true };
    const timeline = [
      { type: 'message', role: 'user', content: 'go', createdAt: 1000 },
      { type: 'tool_call', toolCallId: 't1', title: 'Bash', status: 'in_progress', createdAt: 1100 },
    ];
    const view = deriveWorkflowView({ runtime, threadStatus: 'running', timeline });
    expect(view.terminal).toBe(false);
    expect(view.toolsRunningCount).toBe(1);
    expect(presentWorkflowActivity(view, t)).toMatch(/activityTools/);
  });

  it('exposes terminal flag on normalizeWorkflowStatus', () => {
    const status = normalizeWorkflowStatus({
      threadStatus: 'idle',
      runtime: { activePromptRunId: null, isAwaitingResponse: false, promptStartedAt: null },
    });
    expect(status.terminal).toBe(true);
  });
});
