import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// main.cjs cannot be required under vitest (it boots Electron), so the stream
// parsing/bounding contract is pinned against the source, like the
// quit-request-controller default-value assertions.

const mainSource = fs.readFileSync(path.join(process.cwd(), 'electron', 'main.cjs'), 'utf8');

function functionSource(name) {
  const start = mainSource.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`function ${name} not found`);
  const open = mainSource.indexOf('{', start);
  const end = mainSource.indexOf('\n}', open);
  return mainSource.slice(open + 1, end);
}

describe('main-process SSE stream contract', () => {
  it('joins multi-line SSE data: fields with newline instead of concatenating and trimming', () => {
    const fn = functionSource('parseSseMessagesFromBuffer');
    // The SSE spec requires multi-line data: to be joined with \n; trimming each
    // line corrupts JSON payloads split across data: lines.
    expect(fn).toContain(".join('\\n')");
    expect(fn).toContain("line.slice(5).replace(/^ /, '').replace(/\\r$/, '')");
    expect(fn).not.toContain(".join('')");
  });

  it('bounds the openStream partial-event buffer', () => {
    expect(mainSource).toContain('const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;');
    expect(mainSource).toMatch(/Buffer\.byteLength\(buffer, 'utf8'\) > MAX_SSE_BUFFER_BYTES/);
  });

  it('bounds non-SSE codebuddy:request bodies (text 8MB, image 16MB)', () => {
    const start = mainSource.indexOf("ipcMain.handle('codebuddy:request'");
    const requestHandler = mainSource.slice(start, start + 8000);
    expect(requestHandler).toContain('readBoundedBodyText(response, MAX_SSE_BODY_BYTES)');
    expect(requestHandler).toContain('readBoundedBodyBytes(response, 16 * 1024 * 1024)');
    // The SSE loop's own cap stays in place.
    expect(requestHandler).toContain('MAX_SSE_BODY_BYTES = 8 * 1024 * 1024');
    // Bounded readers must cancel the stream when the cap is hit.
    expect(mainSource).toContain('truncated = true');
    expect(mainSource).toMatch(/async function readBoundedBody\(response, maxBytes, decode\)/);
  });
});
