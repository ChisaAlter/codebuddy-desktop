import { describe, it, expect } from 'vitest';
import { parseEventStreamMessages } from '../../src/lib/acp';

describe('parseEventStreamMessages - SSE 解析', () => {
  it('空文本返空数组', () => {
    expect(parseEventStreamMessages('')).toEqual([]);
    expect(parseEventStreamMessages('   \n\n  ')).toEqual([]);
  });

  it('单条 data: 行解析为 JSON', () => {
    const text = 'data: {"method":"session/update","params":{"x":1}}\n\n';
    const msgs = parseEventStreamMessages(text);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ method: 'session/update', params: { x: 1 } });
  });

  it('多条消息用双换行分隔，各成一条', () => {
    const text = [
      'data: {"id":"a"}',
      '',
      'data: {"id":"b"}',
      '',
      'data: {"id":"c"}',
      '',
    ].join('\n');
    const msgs = parseEventStreamMessages(text);
    expect(msgs.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('一条消息跨多行 data: 行拼接后 JSON.parse', () => {
    // 对照 ACP SSE：长 payload 会被拆成多个 data: 行，按 SSE 规范应拼接
    const text = 'data: {"part":1}\ndata: {"part":2}\n\n';
    const msgs = parseEventStreamMessages(text);
    // 拼接后是 {"part":1}{"part":2} —— JSON.parse 会炸，应被 try/catch 吞掉返空
    expect(msgs).toEqual([]);
  });

  // M-st10: per SSE spec, multiple `data:` lines within one event are joined
  // with `\n`. A JSON object split across two data: lines (a common server-side
  // pretty-print) must parse when joined with `\n` (whitespace outside strings
  // is allowed in JSON).
  it('joins multi-line data: with \\n per SSE spec (M-st10)', () => {
    // A JSON object split across two data: lines:
    //   data: {"a":1,
    //   data: "b":2}
    // joined with \n → {"a":1,\n"b":2} → valid JSON.
    const text = 'data: {"a":1,\ndata: "b":2}\n\n';
    const msgs = parseEventStreamMessages(text);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ a: 1, b: 2 });
  });

  it('data: 行带前导空格被 trim 清理后解析', () => {
    const text = 'data:    {"k":"v"}\n\n';
    const msgs = parseEventStreamMessages(text);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ k: 'v' });
  });

  it('非 data: 开头行（如 event: 或注释）被忽略', () => {
    const text = 'event: session/update\ndata: {"ok":true}\n\n';
    const msgs = parseEventStreamMessages(text);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ ok: true });
  });

  it('data: 行 JSON 不合法静默吞掉，不影响其他合法消息', () => {
    const text = [
      'data: {not json}',
      '',
      'data: {"ok":true}',
      '',
    ].join('\n');
    const msgs = parseEventStreamMessages(text);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ ok: true });
  });
});
