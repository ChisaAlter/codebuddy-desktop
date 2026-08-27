import { describe, expect, it } from 'vitest';
import { buildPromptContentBlocks, ATTACHMENT_TEXT_LIMIT } from '../../src/lib/prompt-content';

// R11 拆分首步的行为锁定：与 sessions-chat.js runThreadPrompt 原内联实现一致。
describe('buildPromptContentBlocks', () => {
  it('always leads with the user text block', () => {
    expect(buildPromptContentBlocks('你好')).toEqual([{ type: 'text', text: '你好' }]);
    expect(buildPromptContentBlocks('你好', [])).toEqual([{ type: 'text', text: '你好' }]);
  });

  it('passes image attachments through with data and mimeType', () => {
    const blocks = buildPromptContentBlocks('看图', [
      { kind: 'image', data: 'aGVsbG8=', mimeType: 'image/png', name: 'a.png', path: '/tmp/a.png' },
    ]);
    expect(blocks).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    ]);
  });

  it('wraps text attachments with file name and path header', () => {
    const blocks = buildPromptContentBlocks('读文件', [
      { kind: 'text', name: 'notes.md', path: '/repo/notes.md', text: '内容' },
    ]);
    expect(blocks[1]).toEqual({ type: 'text', text: '文件: notes.md\n路径: /repo/notes.md\n\n内容' });
  });

  it('clips oversize text attachments and appends the truncation marker', () => {
    const oversize = 'x'.repeat(ATTACHMENT_TEXT_LIMIT + 10);
    const blocks = buildPromptContentBlocks('大文件', [
      { kind: 'text', name: 'big.txt', path: '/repo/big.txt', text: oversize },
    ]);
    const body = blocks[1].text;
    expect(body.endsWith('\n\n[文件内容已截断]')).toBe(true);
    expect(body).toContain('x'.repeat(100));
    // 头部 + 截断后的正文 + 标记，不含超出上限的部分
    expect(body.length).toBe('文件: big.txt\n路径: /repo/big.txt\n\n'.length + ATTACHMENT_TEXT_LIMIT + '\n\n[文件内容已截断]'.length);
  });

  it('coerces missing text to empty string and skips unsupported kinds', () => {
    const blocks = buildPromptContentBlocks('混合', [
      { kind: 'text', name: 'empty.txt', path: '/repo/empty.txt' },
      { kind: 'unsupported', name: 'a.bin', path: '/repo/a.bin' },
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[1].text).toBe('文件: empty.txt\n路径: /repo/empty.txt\n\n');
  });
});
