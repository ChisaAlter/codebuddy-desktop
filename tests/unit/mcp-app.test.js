// G6: MCP App 纯逻辑（资源检测 + 展示几何 + 主进程校验器）。
import { describe, expect, it } from 'vitest';
import {
  MCP_APP_MIME,
  extractMcpAppResource,
  normalizeMcpAppDisplayMode,
  mcpAppViewBounds,
} from '../../src/lib/mcp-app';
import { validBounds, validAppId } from '../../electron/mcp-app-host.cjs';

describe('extractMcpAppResource', () => {
  const appResource = { uri: 'ui://widget/1', mimeType: MCP_APP_MIME, text: '<html>app</html>' };

  it('finds app resources inside ACP content blocks', () => {
    expect(
      extractMcpAppResource({ content: [{ type: 'content', content: { type: 'resource', resource: appResource } }] }),
    ).toEqual({ uri: 'ui://widget/1', html: '<html>app</html>' });
    expect(extractMcpAppResource({ content: [{ type: 'resource', resource: appResource }] })).toEqual({
      uri: 'ui://widget/1',
      html: '<html>app</html>',
    });
  });

  it('accepts ui:// uri without the profile mime', () => {
    expect(
      extractMcpAppResource({
        content: [{ type: 'resource', resource: { uri: 'ui://x', mimeType: 'text/html', text: '<p>x</p>' } }],
      }),
    ).toEqual({ uri: 'ui://x', html: '<p>x</p>' });
  });

  it('rejects plain resources, empty html and missing payloads', () => {
    expect(
      extractMcpAppResource({
        content: [{ type: 'resource', resource: { uri: 'file:///a.txt', mimeType: 'text/plain', text: 'hi' } }],
      }),
    ).toBeNull();
    expect(
      extractMcpAppResource({ content: [{ type: 'resource', resource: { ...appResource, text: '  ' } }] }),
    ).toBeNull();
    expect(extractMcpAppResource(null)).toBeNull();
    expect(extractMcpAppResource({})).toBeNull();
  });
});

describe('display mode + bounds', () => {
  const viewport = { width: 1200, height: 800 };

  it('normalizes display modes', () => {
    expect(normalizeMcpAppDisplayMode('pip')).toBe('pip');
    expect(normalizeMcpAppDisplayMode('fullscreen')).toBe('fullscreen');
    expect(normalizeMcpAppDisplayMode('bogus')).toBe('inline');
  });

  it('computes fullscreen bounds with margin', () => {
    expect(mcpAppViewBounds('fullscreen', null, viewport)).toEqual({ x: 24, y: 24, width: 1152, height: 752 });
  });

  it('computes pip bounds at bottom right', () => {
    const bounds = mcpAppViewBounds('pip', null, viewport);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(1200);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(800);
    expect(bounds.width).toBe(400);
    expect(bounds.height).toBe(280);
  });

  it('clamps inline bounds to the viewport', () => {
    expect(mcpAppViewBounds('inline', { x: 100, y: 700, width: 600, height: 320 }, viewport)).toEqual({
      x: 100,
      y: 700,
      width: 600,
      height: 100,
    });
    expect(mcpAppViewBounds('inline', { x: 0, y: -50, width: 600, height: 320 }, viewport).y).toBe(0);
  });
});

describe('mcp-app-host validators', () => {
  it('validBounds rejects malformed rects', () => {
    expect(validBounds({ x: 1, y: 2, width: 300, height: 200 })).toEqual({ x: 1, y: 2, width: 300, height: 200 });
    expect(validBounds({ x: -1, y: 2, width: 300, height: 200 })).toBeNull();
    expect(validBounds({ x: 1, y: 2, width: 30000, height: 200 })).toBeNull();
    expect(validBounds({ x: 1, y: 2, width: NaN, height: 200 })).toBeNull();
    expect(validBounds()).toBeNull();
  });

  it('validAppId only accepts short alphanumeric ids', () => {
    expect(validAppId('mcp-app-abc-1')).toBe('mcp-app-abc-1');
    expect(validAppId('../evil')).toBeNull();
    expect(validAppId('a'.repeat(65))).toBeNull();
    expect(validAppId(42)).toBeNull();
  });
});
