import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  reduceAcpEvent,
  closeAssistantStream,
  createTimelineEntry,
  executionGroupSummary,
  groupTimelineForDisplay,
  pushUserMessage,
  resetSeenContent,
} from '../../src/lib/timeline';

beforeEach(() => resetSeenContent());

describe('reduceAcpEvent - timeline 归并', () => {
  it('agent_message_chunk 追加到同 messageId 的 assistant 消息', () => {
    const tl = pushUserMessage([], '你好');
    const next = reduceAcpEvent(tl, 'agent_message_chunk', {
      messageId: 'm1',
      content: 'Hello',
    });
    // 应新增一条 assistant 消息，streaming=true，content='Hello'
    const assistant = next.find((e) => e.role === 'assistant');
    expect(assistant).toBeTruthy();
    expect(assistant.content).toBe('Hello');
    expect(assistant.streaming).toBe(true);
    expect(assistant.messageId).toBe('m1');
  });

  it('思考 chunk 在正文开始前保持流式，并在正文开始时记录结束时间', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(1000).mockReturnValueOnce(1000).mockReturnValue(4000);

    let next = reduceAcpEvent([], 'agent_thought_chunk', { messageId: 'thought-1', content: '' });
    expect(next[0]).toMatchObject({ type: 'thinking', streaming: true, createdAt: 1000 });

    next = reduceAcpEvent(next, 'agent_message_chunk', { messageId: 'answer-1', content: '完成' });
    expect(next[0]).toMatchObject({ type: 'thinking', streaming: false, completedAt: 4000 });
    expect(next[1]).toMatchObject({ type: 'message', role: 'assistant', streaming: true });
    now.mockRestore();
  });

  it('首个 thought chunk 到达时刻为思考计时起点（对齐 WebUI LIVE，不回写 prompt 发出时间）', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(7000);
    const next = reduceAcpEvent(
      [],
      'agent_thought_chunk',
      { messageId: 'thought-1', content: '分析中' },
      'thread-1',
      { thinkingStartedAt: 2000 },
    );

    expect(next[0]).toMatchObject({ type: 'thinking', createdAt: 7000, streaming: true });
    now.mockRestore();
  });

  it('status_change 与 model_update 不写入对话时间线', () => {
    const base = pushUserMessage([], '你好');
    const afterStatus = reduceAcpEvent(base, 'status_change', { status: 'idle', role: 'system' });
    const afterModel = reduceAcpEvent(afterStatus, 'model_update', { modelId: 'x' });
    expect(afterStatus).toEqual(base);
    expect(afterModel).toEqual(base);
    expect(afterModel.some((e) => e.type === 'status_change' || e.type === 'model_update')).toBe(false);
  });

  it('保留已持久化的思考结束时间', () => {
    const restored = createTimelineEntry({
      type: 'thinking',
      createdAt: 1000,
      completedAt: 4321,
      streaming: false,
    });

    expect(restored.completedAt).toBe(4321);
  });

  it('同 messageId 的多次 chunk 合并 content', () => {
    const tl = pushUserMessage([], '你好');
    let next = reduceAcpEvent(tl, 'agent_message_chunk', { messageId: 'm1', content: 'Hello' });
    next = reduceAcpEvent(next, 'agent_message_chunk', { messageId: 'm1', content: ' World' });
    const assistant = next.find((e) => e.role === 'assistant');
    expect(assistant.content).toBe('Hello World');
    // 仍 streaming
    expect(assistant.streaming).toBe(true);
  });

  it('merge 命中时返回新对象，不原地改写旧 timeline 条目', () => {
    const first = reduceAcpEvent([], 'agent_message_chunk', { messageId: 'm1', content: 'Hello' });
    const firstAssistant = first.find((e) => e.role === 'assistant');
    const second = reduceAcpEvent(first, 'agent_message_chunk', { messageId: 'm1', content: ' World' });
    const secondAssistant = second.find((e) => e.role === 'assistant');

    expect(second).not.toBe(first);
    expect(secondAssistant).not.toBe(firstAssistant);
    expect(firstAssistant.content).toBe('Hello');
    expect(secondAssistant.content).toBe('Hello World');
  });

  it('mode_update / current_mode_update 不写入对话 timeline', () => {
    const tl = pushUserMessage([], 'hello');
    const nextMode = reduceAcpEvent(tl, 'mode_update', { currentModeId: 'fullAccess' });
    const nextCurrent = reduceAcpEvent(tl, 'current_mode_update', { currentModeId: 'plan' });
    expect(nextMode).toBe(tl);
    expect(nextCurrent).toBe(tl);
    expect(nextMode.some((e) => e.type === 'mode_update')).toBe(false);
  });

  it('未知事件类型走 pushSystemEvent 返新数组不崩', () => {
    const tl = pushUserMessage([], 'x');
    const next = reduceAcpEvent(tl, 'unknown_event_type', { foo: 'bar' });
    // 兜底走 pushSystemEvent：返新数组（含原 timeline + 新 system 条目），不返原引用
    expect(Array.isArray(next)).toBe(true);
    expect(next.length).toBeGreaterThanOrEqual(tl.length);
  });

  it('payload 缺字段不崩（mergeAssistantChunk 兜底）', () => {
    const tl = pushUserMessage([], 'x');
    // payload=null：mergeAssistantChunk 内部应兜底不崩，返回数组（可能新数组）
    const next = reduceAcpEvent(tl, 'agent_message_chunk', null);
    expect(Array.isArray(next)).toBe(true);
  });

  it('重复加载同一条 assistant 历史消息时不再次拼接内容', () => {
    const payload = {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'history-assistant',
      content: { type: 'text', text: '历史回复' },
      _meta: { 'codebuddy.ai': { mode: 'history' } },
    };
    let next = reduceAcpEvent([], 'agent_message_chunk', payload);
    next = reduceAcpEvent(next, 'agent_message_chunk', payload);

    expect(next[0].content).toBe('历史回复');
  });

  it('重复加载同一条 user 历史消息时不再次拼接内容', () => {
    const payload = {
      sessionUpdate: 'user_message_chunk',
      messageId: 'history-user',
      content: { type: 'text', text: '历史问题' },
      _meta: { 'codebuddy.ai': { mode: 'history' } },
    };
    let next = reduceAcpEvent([], 'user_message_chunk', payload);
    next = reduceAcpEvent(next, 'user_message_chunk', payload);

    expect(next[0].content).toBe('历史问题');
  });

  it('工具调用之后同 messageId 的正文创建新的底部消息段', () => {
    let next = pushUserMessage([], '检查项目');
    next = reduceAcpEvent(next, 'agent_message_chunk', { messageId: 'm1', content: '开始检查' });
    next = reduceAcpEvent(next, 'tool_call', { toolCallId: 'tool-1', status: 'completed', title: 'Read file' });
    next = reduceAcpEvent(next, 'agent_message_chunk', { messageId: 'm1', content: '最终总结' });

    expect(next.map((item) => item.type)).toEqual(['message', 'message', 'tool_call', 'message']);
    expect(next.filter((item) => item.type === 'message' && item.role === 'assistant').map((item) => item.content)).toEqual([
      '开始检查',
      '最终总结',
    ]);
  });

  it('工具调用之后同 messageId 的后续思考仍创建 thinking 段', () => {
    let next = reduceAcpEvent([], 'agent_thought_chunk', { messageId: 'thought-1', content: '先检查' });
    next = reduceAcpEvent(next, 'tool_call', { toolCallId: 'tool-1', status: 'completed', title: 'Read file' });
    next = reduceAcpEvent(next, 'agent_thought_chunk', { messageId: 'thought-1', content: '继续分析' });

    expect(next.map((item) => item.type)).toEqual(['thinking', 'tool_call', 'thinking']);
    expect(next[2]).toMatchObject({ role: 'assistant', content: '继续分析', streaming: true });
  });

  it('无 messageId 的连续思考 chunk 合并到同一 streaming 段', () => {
    let next = reduceAcpEvent([], 'agent_thought_chunk', { content: '先看结构' });
    next = reduceAcpEvent(next, 'agent_thought_chunk', { content: '再读配置' });
    next = reduceAcpEvent(next, 'agent_thought_chunk', { content: '然后总结' });

    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      type: 'thinking',
      streaming: true,
      content: '先看结构再读配置然后总结',
    });
  });

  it('无 messageId 时，结束后的相邻思考仍追加到同一段', () => {
    let next = reduceAcpEvent([], 'agent_thought_chunk', { content: '第一段' });
    next = closeAssistantStream(next);
    expect(next[0].streaming).toBe(false);
    next = reduceAcpEvent(next, 'agent_thought_chunk', { content: '第二段' });

    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      type: 'thinking',
      streaming: true,
      content: '第一段第二段',
    });
  });

  it('保留模型合法输出的连续相同文本 chunk', () => {
    let next = reduceAcpEvent([], 'agent_message_chunk', { messageId: 'repeat', content: '哈' });
    next = reduceAcpEvent(next, 'agent_message_chunk', { messageId: 'repeat', content: '哈' });

    expect(next[0].content).toBe('哈哈');
  });

  it('历史回放把本地用户消息规范化为服务端 messageId 而不重复追加', () => {
    let next = pushUserMessage([], '了解项目');
    next = reduceAcpEvent(
      next,
      'user_message_chunk',
      {
        sessionUpdate: 'user_message_chunk',
        messageId: 'history-user',
        content: { type: 'text', text: '了解项目' },
        _meta: { 'codebuddy.ai': { mode: 'history', offset: 7 } },
      },
      'thread-a',
    );

    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ role: 'user', messageId: 'history-user', content: '了解项目' });
  });
});

describe('closeAssistantStream', () => {
  it('把所有 assistant 消息的 streaming 置 false', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(5000);
    const tl = pushUserMessage([], 'hi');
    let next = reduceAcpEvent(tl, 'agent_message_chunk', { messageId: 'm1', content: 'x' });
    const closed = closeAssistantStream(next);
    const assistant = closed.find((e) => e.role === 'assistant');
    expect(assistant.streaming).toBe(false);
    expect(assistant.completedAt).toBe(5000);
    now.mockRestore();
  });

  it('结束响应时同时结束仍在计时的思考流', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(5000);
    const closed = closeAssistantStream([
      { id: 'thought', type: 'thinking', role: 'assistant', createdAt: 1000, streaming: true },
    ]);

    expect(closed[0]).toMatchObject({ streaming: false, completedAt: 5000 });
    now.mockRestore();
  });

  it('关闭流时给缺少 completedAt 的已结束思考补全结束时间', () => {
    const closed = closeAssistantStream([
      {
        id: 'legacy-thought',
        type: 'thinking',
        role: 'assistant',
        createdAt: 1000,
        streaming: false,
        completedAt: null,
      },
    ]);

    expect(closed[0]).toMatchObject({ streaming: false, completedAt: 1000 });
  });

  it('非 assistant 条目不变', () => {
    const tl = pushUserMessage([], 'hi');
    const closed = closeAssistantStream(tl);
    const user = closed.find((e) => e.role === 'user');
    expect(user).toBeTruthy();
  });
});

describe('pushUserMessage', () => {
  it('追加一条 user 消息到 timeline 末尾', () => {
    const tl = pushUserMessage([], '测试');
    expect(tl).toHaveLength(1);
    expect(tl[0].role).toBe('user');
    expect(tl[0].content).toBe('测试');
  });

  it('不修改原 timeline 数组（返回新数组）', () => {
    const orig = pushUserMessage([], 'a');
    const next = pushUserMessage(orig, 'b');
    expect(orig).toHaveLength(1);
    expect(next).toHaveLength(2);
    expect(orig[0].content).toBe('a');
  });

  it('可附带图片/文件 attachments（WebUI 用户气泡）', () => {
    const tl = pushUserMessage([], '见图', 1000, [
      { name: 'a.png', path: '/tmp/a.png', kind: 'image', mimeType: 'image/png', data: 'abc' },
      { name: 'note.txt', path: '/tmp/note.txt', kind: 'text' },
    ]);
    expect(tl[0].attachments).toHaveLength(2);
    expect(tl[0].attachments[0]).toMatchObject({ kind: 'image', name: 'a.png', data: 'abc' });
    expect(tl[0].attachments[1]).toMatchObject({ kind: 'text', name: 'note.txt' });
  });
});

describe('execution timeline grouping', () => {
  it('groups consecutive tool and activity events into one execution record', () => {
    const grouped = groupTimelineForDisplay([
      { id: 'answer', type: 'message', role: 'assistant', content: '完成' },
      { id: 'write', type: 'tool_call', status: 'completed', title: 'Write file' },
      { id: 'checkpoint', type: 'checkpoint', meta: { event: 'created' } },
      { id: 'run', type: 'tool_call', status: 'completed', title: 'Run tests' },
      { id: 'next', type: 'message', role: 'user', content: '继续' },
    ]);

    expect(grouped).toHaveLength(3);
    expect(grouped[1]).toMatchObject({ type: 'execution_group', autoCollapse: false });
    expect(grouped[1].items.map((item) => item.id)).toEqual(['write', 'checkpoint', 'run']);
  });

  it('still groups internal-only clusters (UI hides them; must not split the turn)', () => {
    const grouped = groupTimelineForDisplay([
      { id: 'user', type: 'message', role: 'user', content: '看一下' },
      { id: 'think', type: 'thinking', role: 'assistant', content: '…', streaming: false },
      { id: 'cp', type: 'checkpoint', meta: { event: 'created' } },
      { id: 'final', type: 'message', role: 'assistant', content: '好了', streaming: false },
    ]);
    const groups = grouped.filter((item) => item.type === 'execution_group');
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((item) => item.id)).toEqual(['cp']);
    // Thinking stays standalone when a checkpoint sits between it and the answer.
    expect(grouped.some((item) => item.type === 'thinking')).toBe(true);
    // Answer remains the last visible content after the (UI-hidden) group.
    expect(grouped[grouped.length - 1]).toMatchObject({ id: 'final', type: 'message' });
  });

  it('collapses every execution group in a turn only after the final answer starts', () => {
    const grouped = groupTimelineForDisplay([
      { id: 'user', type: 'message', role: 'user', content: '分析项目' },
      { id: 'tool-1', type: 'tool_call', status: 'completed', title: 'Read files' },
      { id: 'progress', type: 'message', role: 'assistant', content: '继续检查测试。' },
      { id: 'tool-2', type: 'tool_call', status: 'completed', title: 'Run tests' },
      { id: 'final', type: 'message', role: 'assistant', content: '这是最终结论。' },
    ]);

    const executionGroups = grouped.filter((item) => item.type === 'execution_group');
    expect(executionGroups).toHaveLength(2);
    expect(executionGroups[0].items.map((item) => item.id)).toEqual(['tool-1']);
    expect(executionGroups[1].items.map((item) => item.id)).toEqual(['tool-2']);
    expect(grouped.findIndex((item) => item.id === 'progress')).toBeLessThan(
      grouped.findIndex((item) => item.items?.some((candidate) => candidate.id === 'tool-2')),
    );
    expect(executionGroups.every((item) => item.autoCollapse)).toBe(true);
  });

  it('folds task-list artifacts into the same execution record instead of rendering repeated cards', () => {
    const grouped = groupTimelineForDisplay([
      { id: 'user', type: 'message', role: 'user', content: '检查项目' },
      {
        id: 'tasks',
        type: 'artifact',
        meta: { artifact: { title: 'Tasks', tasks: [{ title: '运行测试', status: 'completed' }] } },
      },
      { id: 'tool', type: 'tool_call', status: 'completed', title: 'Run tests' },
      { id: 'final', type: 'message', role: 'assistant', content: '检查完成', streaming: false },
    ]);

    const executionGroups = grouped.filter((item) => item.type === 'execution_group');
    expect(executionGroups).toHaveLength(1);
    expect(executionGroups[0].items.map((item) => item.id)).toEqual(['tasks', 'tool']);
    expect(grouped.some((item) => item.type === 'artifact')).toBe(false);
  });

  it('keeps completed tools expanded while the turn has no final answer', () => {
    const grouped = groupTimelineForDisplay([
      { id: 'user', type: 'message', role: 'user', content: '分析项目' },
      { id: 'tool', type: 'tool_call', status: 'completed', title: 'Read files' },
    ]);

    expect(grouped.find((item) => item.type === 'execution_group')?.autoCollapse).toBe(false);
  });

  it('does not auto-collapse tools while the possible final answer is still streaming', () => {
    const active = groupTimelineForDisplay([
      { id: 'user', type: 'message', role: 'user', content: '分析项目' },
      { id: 'tool', type: 'tool_call', status: 'completed', title: 'Read files' },
      { id: 'answer', type: 'message', role: 'assistant', content: '正在总结', streaming: true },
    ]);
    const completed = groupTimelineForDisplay([
      { id: 'user', type: 'message', role: 'user', content: '分析项目' },
      { id: 'tool', type: 'tool_call', status: 'completed', title: 'Read files' },
      { id: 'answer', type: 'message', role: 'assistant', content: '总结完成', streaming: false },
    ]);

    expect(active.find((item) => item.type === 'execution_group')?.autoCollapse).toBe(false);
    expect(completed.find((item) => item.type === 'execution_group')?.autoCollapse).toBe(true);
  });

  it('summarizes completed and failed execution records in user-facing language', () => {
    expect(executionGroupSummary([
      { type: 'tool_call', status: 'completed' },
      { type: 'checkpoint' },
    ])).toEqual({ detail: '1 个工具 · 1 个检查点', status: '已完成', tone: 'success' });

    expect(executionGroupSummary([
      { type: 'tool_call', status: 'failed' },
    ])).toMatchObject({ status: '有失败项', tone: 'error' });
  });

  it('returns IDENTITY-STABLE derived objects for unchanged entries (M-perf memo contract)', () => {
    // Derived objects (thinking-merge + execution_group) must keep object
    // identity across calls when their sources did not change — otherwise
    // TimelineItem's React.memo is defeated and every stream chunk re-renders
    // the whole transcript. This is the contract the 300-entry perf fixture
    // gate depends on (append cost was ~1s before this fix, ~30ms after).
    const base = [
      { id: 'user-1', type: 'message', role: 'user', content: '分析项目', createdAt: 1 },
      { id: 'think-1', type: 'thinking', role: 'assistant', content: '思考中', streaming: false, createdAt: 2 },
      { id: 'answer-1', type: 'message', role: 'assistant', content: '已分析', streaming: false, createdAt: 3 },
      { id: 'tool-1', type: 'tool_call', status: 'completed', title: 'Read', createdAt: 4 },
      { id: 'user-2', type: 'message', role: 'user', content: '继续', createdAt: 5 },
      { id: 'answer-2', type: 'message', role: 'assistant', content: '进行中', streaming: true, createdAt: 6 },
    ];
    const first = groupTimelineForDisplay(base);
    // Append a new chunk to the LAST message (same as a real stream append:
    // untouched entries keep references, the tail changes).
    const mutated = [...base.slice(0, -1), { ...base[base.length - 1], content: '进行中…新内容' }];
    const second = groupTimelineForDisplay(mutated);

    expect(first.length).toBe(second.length);
    // All entries except the changed tail must be the SAME objects.
    for (let i = 0; i < first.length - 1; i += 1) {
      expect(first[i]).toBe(second[i]);
    }
    // The thinking-merged answer keeps its identity too.
    const thinkingAnswer = first.find((item) => item.thinking);
    const thinkingAnswerAgain = second.find((item) => item.thinking);
    expect(thinkingAnswer).toBe(thinkingAnswerAgain);
  });

  it('merges consecutive thinking and co-locates it on the following assistant answer (WebUI Px)', () => {
    const grouped = groupTimelineForDisplay([
      { id: 'user', type: 'message', role: 'user', content: '/init' },
      {
        id: 't1',
        type: 'thinking',
        role: 'assistant',
        content: '先看目录结构。',
        streaming: false,
        createdAt: 1000,
        completedAt: 2000,
      },
      {
        id: 't2',
        type: 'thinking',
        role: 'assistant',
        content: '再读核心模块。',
        streaming: false,
        createdAt: 2100,
        completedAt: 4000,
      },
      {
        id: 't3',
        type: 'thinking',
        role: 'assistant',
        content: '最后写 CODEBUDDY.md。',
        streaming: false,
        createdAt: 4100,
        completedAt: 5000,
      },
      { id: 'answer', type: 'message', role: 'assistant', content: '完成', streaming: false },
    ]);

    // No standalone thinking card — WebUI renders thinking inside the assistant message unit.
    expect(grouped.filter((item) => item.type === 'thinking')).toHaveLength(0);
    const answer = grouped.find((item) => item.id === 'answer');
    expect(answer).toMatchObject({ type: 'message', role: 'assistant', content: '完成' });
    expect(answer.thinking).toMatchObject({
      content: '先看目录结构。\n\n再读核心模块。\n\n最后写 CODEBUDDY.md。',
      streaming: false,
      createdAt: 1000,
      completedAt: 5000,
    });
    expect(answer.thinking.items).toHaveLength(3);
  });

  it('does not merge thinking across tool calls', () => {
    const grouped = groupTimelineForDisplay([
      { id: 't1', type: 'thinking', role: 'assistant', content: '准备读文件', streaming: false, createdAt: 1 },
      { id: 'tool', type: 'tool_call', status: 'completed', title: 'Read' },
      { id: 't2', type: 'thinking', role: 'assistant', content: '继续分析', streaming: false, createdAt: 2 },
    ]);

    const thinkingCards = grouped.filter((item) => item.type === 'thinking');
    expect(thinkingCards).toHaveLength(2);
    expect(thinkingCards.map((item) => item.content)).toEqual(['准备读文件', '继续分析']);
    expect(grouped.some((item) => item.type === 'execution_group')).toBe(true);
  });

  it('keeps thinking standalone when tools interrupt before the answer', () => {
    const grouped = groupTimelineForDisplay([
      { id: 'user', type: 'message', role: 'user', content: '分析' },
      {
        id: 't1',
        type: 'thinking',
        role: 'assistant',
        content: '先读文件',
        streaming: false,
        createdAt: 1,
        completedAt: 2,
      },
      { id: 'tool', type: 'tool_call', status: 'completed', title: 'Read' },
      { id: 'answer', type: 'message', role: 'assistant', content: '结论', streaming: false },
    ]);

    expect(grouped.filter((item) => item.type === 'thinking')).toHaveLength(1);
    expect(grouped.find((item) => item.id === 'answer')?.thinking).toBeUndefined();
  });

  it('keeps streaming flag when any merged thinking part is still open', () => {
    const grouped = groupTimelineForDisplay([
      { id: 't1', type: 'thinking', role: 'assistant', content: '已完成段', streaming: false, createdAt: 1, completedAt: 2 },
      { id: 't2', type: 'thinking', role: 'assistant', content: '仍在流', streaming: true, createdAt: 3 },
    ]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({
      type: 'thinking',
      streaming: true,
      content: '已完成段\n\n仍在流',
      completedAt: null,
    });
  });
});
