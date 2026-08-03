import { describe, expect, it } from 'vitest';
import {
  clampTextLines,
  classifyToolPayload,
  extractPathList,
  formatToolCollapsedSummary,
  formatToolExpandedView,
  getToolKind,
  isPathHeavyText,
  normalizeToolResult,
  stripShellChrome,
  summarizeToolLine,
} from '../../src/lib/tool-output-format';

describe('tool-output-format production matrix', () => {
  it('T01 empty', () => {
    expect(normalizeToolResult(null)).toBe('');
    expect(classifyToolPayload(null)).toBe('empty');
    expect(clampTextLines('').totalLines).toBe(0);
  });

  it('T02 single line text fully visible', () => {
    const c = clampTextLines('hello');
    expect(c.visible).toBe('hello');
    expect(c.hiddenLines).toBe(0);
  });

  it('T03 eight lines no truncation', () => {
    const text = Array.from({ length: 8 }, (_, i) => `L${i + 1}`).join('\n');
    const c = clampTextLines(text, 8);
    expect(c.hiddenLines).toBe(0);
    expect(c.totalLines).toBe(8);
  });

  it('T04 nine lines clamps to 8', () => {
    const text = Array.from({ length: 9 }, (_, i) => `L${i + 1}`).join('\n');
    const c = clampTextLines(text, 8);
    expect(c.visible.split('\n')).toHaveLength(8);
    expect(c.hiddenLines).toBe(1);
    expect(c.truncated).toBe(true);
  });

  it('T05 ten thousand lines reports totals', () => {
    const text = Array.from({ length: 10000 }, (_, i) => `L${i}`).join('\n');
    const c = clampTextLines(text, 8);
    expect(c.totalLines).toBe(10000);
    expect(c.hiddenLines).toBe(9992);
  });

  it('T06 string path list', () => {
    const text = [
      'C:\\A\\proj\\a.ts',
      'C:\\A\\proj\\b.ts',
      'C:\\A\\proj\\c.ts',
    ].join('\n');
    const list = extractPathList(text);
    expect(list.count).toBe(3);
    expect(list.preview).toHaveLength(3);
    expect(classifyToolPayload(text)).toBe('path_list');
  });

  it('T07 JSON array paths', () => {
    const arr = [
      'C:\\A\\ChisaTerminal\\node_modules\\a\\index.js',
      'C:\\A\\ChisaTerminal\\node_modules\\b\\index.js',
      'C:\\A\\ChisaTerminal\\src\\main.ts',
    ];
    const list = extractPathList(arr);
    expect(list.count).toBe(3);
    expect(classifyToolPayload(arr)).toBe('path_list');
  });

  it('T08 ACP content text blocks', () => {
    const payload = {
      content: [
        { type: 'text', text: 'line1\nline2\nline3' },
      ],
    };
    expect(normalizeToolResult(payload)).toContain('line1');
  });

  it('T09 single-key stdout object', () => {
    expect(normalizeToolResult({ stdout: 'ok\n' })).toBe('ok\n');
  });

  it('T10 nested noise envelope prefers text when simple', () => {
    const text = normalizeToolResult({ type: 'text', text: 'clean' });
    expect(text).toBe('clean');
  });

  it('T11 strips shell chrome', () => {
    const raw = 'Command: ls\nExit Code: 0\nStdout:\nhello\nworld';
    const stripped = stripShellChrome(raw);
    expect(stripped).not.toMatch(/Command:/i);
    expect(stripped).toMatch(/hello/);
  });

  it('T12 unknown MCP kind still clamps (production baseline)', () => {
    const body = Array.from({ length: 20 }, (_, i) => `row ${i}`).join('\n');
    const view = formatToolExpandedView({
      toolName: 'mcp_custom_whatever',
      rawOutput: body,
    });
    expect(view.kind).toBe('default');
    expect(view.body.split('\n').length).toBeLessThanOrEqual(8);
    expect(view.hiddenLines).toBeGreaterThan(0);
    expect(view.truncated).toBe(true);
  });

  it('T13 path-heavy node_modules is path_list mode', () => {
    const paths = Array.from(
      { length: 12 },
      (_, i) => `C:\\A\\ChisaTerminal\\node_modules\\pkg${i}\\index.js`,
    );
    const text = paths.join('\n');
    expect(isPathHeavyText(text)).toBe(true);
    const view = formatToolExpandedView({
      toolName: 'Glob',
      rawOutput: text,
    });
    expect(view.mode).toBe('path_list');
    expect(view.pathList.count).toBe(12);
    expect(view.pathList.preview.length).toBeLessThanOrEqual(5);
  });

  it('T14 answer-is-paths keeps count (no silent drop)', () => {
    const paths = Array.from({ length: 30 }, (_, i) => `C:\\cfg\\file${i}.json`);
    const view = formatToolExpandedView({
      kind: 'search',
      rawOutput: paths,
    });
    expect(view.mode).toBe('path_list');
    expect(view.pathList.count).toBe(30);
  });

  it('summarizes preferred input fields', () => {
    expect(summarizeToolLine({ command: 'npm test -- --run' })).toContain('npm test');
    expect(
      formatToolCollapsedSummary({
        rawInput: { path: 'C:\\very\\long\\path\\to\\file.ts' },
      }),
    ).toMatch(/file\.ts|path/);
  });

  it('detects execute kind and strips chrome in expanded view', () => {
    expect(getToolKind({ toolName: 'Bash' })).toBe('execute');
    const view = formatToolExpandedView({
      toolName: 'Bash',
      rawInput: { command: 'echo hi' },
      rawOutput: 'Command: echo hi\nExit Code: 0\nhello',
    });
    expect(view.kind).toBe('execute');
    expect(view.body).toMatch(/hello/);
    expect(view.body).not.toMatch(/Exit Code/i);
  });

  it('full mode still caps extreme output', () => {
    const huge = Array.from({ length: 500 }, (_, i) => `L${i}`).join('\n');
    const view = formatToolExpandedView({ rawOutput: huge }, { full: true });
    expect(view.body.split('\n').length).toBeLessThanOrEqual(200);
  });

  it('JSON string array of paths classifies as path_list', () => {
    const json = JSON.stringify([
      'C:\\a\\one.ts',
      'C:\\a\\two.ts',
      'C:\\a\\three.ts',
    ]);
    expect(classifyToolPayload(json)).toBe('path_list');
    expect(extractPathList(json).count).toBe(3);
  });
});
