import { describe, expect, it } from 'vitest';
import { resolveThreadTimeline } from '../../src/store/helpers/thread-runtime.js';

describe('resolveThreadTimeline', () => {
  it('keeps runtime when both sides already share the same user turns', () => {
    const runtime = [
      { id: 'u1', type: 'message', role: 'user', content: 'hello', createdAt: 1 },
      { id: 'a1', type: 'message', role: 'assistant', content: 'hi', createdAt: 2 },
    ];
    const thread = [
      { id: 'u1', type: 'message', role: 'user', content: 'hello', createdAt: 1 },
      { id: 'a1', type: 'message', role: 'assistant', content: 'hi', createdAt: 2 },
    ];
    expect(resolveThreadTimeline(runtime, thread)).toBe(runtime);
  });

  it('falls back to thread history when runtime timeline is empty array', () => {
    const thread = [
      { id: 'u1', type: 'message', role: 'user', content: '一打开就自动再进 CodeBuddy能实现吗' },
      { id: 'a1', type: 'message', role: 'assistant', content: '能实现' },
    ];
    // This is the bug: [] is truthy so `[] || thread` kept [].
    expect(resolveThreadTimeline([], thread)).toEqual(thread);
  });

  it('prefers disk history when live runtime has tools/thinking but no user bubbles', () => {
    const runtime = [
      { id: 't1', type: 'thinking', role: 'assistant', content: '…', streaming: true },
      { id: 'a1', type: 'message', role: 'assistant', content: '回复', streaming: true },
      { id: 'c1', type: 'tool_call', role: 'assistant', toolCallId: 'x', status: 'running' },
    ];
    const thread = [
      { id: 'u1', type: 'message', role: 'user', content: '我的消息应该显示' },
      { id: 'a0', type: 'message', role: 'assistant', content: '旧回复' },
    ];
    expect(resolveThreadTimeline(runtime, thread)).toEqual(thread);
  });

  it('merges missing disk user messages into a shorter live runtime', () => {
    const runtime = [
      { id: 'u2', type: 'message', role: 'user', content: '第二条', createdAt: 200 },
      { id: 'a2', type: 'message', role: 'assistant', content: '答2', createdAt: 201 },
    ];
    const thread = [
      { id: 'u1', type: 'message', role: 'user', content: '第一条', createdAt: 100 },
      { id: 'a1', type: 'message', role: 'assistant', content: '答1', createdAt: 101 },
      { id: 'u2', type: 'message', role: 'user', content: '第二条', createdAt: 200 },
    ];
    const resolved = resolveThreadTimeline(runtime, thread);
    const users = resolved.filter((item) => item.role === 'user').map((item) => item.content);
    expect(users).toEqual(['第一条', '第二条']);
  });

  it('returns empty when both are empty', () => {
    expect(resolveThreadTimeline([], [])).toEqual([]);
  });

  it('uses thread when runtime is null/undefined', () => {
    const thread = [{ id: 'u1', type: 'message', role: 'user', content: 'hi' }];
    expect(resolveThreadTimeline(null, thread)).toEqual(thread);
    expect(resolveThreadTimeline(undefined, thread)).toEqual(thread);
  });

  it('uses empty runtime when thread has no history either', () => {
    expect(resolveThreadTimeline([], null)).toEqual([]);
  });
});
