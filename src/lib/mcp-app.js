// G6: MCP Apps（ui:// 交互界面）检测与展示几何。
// WebUI 契约：资源 mimeType = text/html;profile=mcp-app，或 _meta['ui/resourceUri'] / _meta.ui.resourceUri
// 以 ui:// 开头（jB/OA）。Desktop 用隔离 WebContentsView 渲染（非主渲染进程 iframe），
// 这里只做纯检测/几何计算，Electron 侧见 electron/mcp-app-host.cjs。

export const MCP_APP_MIME = 'text/html;profile=mcp-app';
export const MCP_APP_DISPLAY_MODES = ['inline', 'fullscreen', 'pip'];

/** WebUI Gz 默认内联高度 / pip 尺寸。 */
export const MCP_APP_INLINE_HEIGHT = 320;
const PIP_WIDTH = 400;
const PIP_HEIGHT = 280;
const FULLSCREEN_MARGIN = 24;

function resourceFromBlock(block) {
  // ACP tool content block：{type:'content', content:{type:'resource', resource:{…}}}
  // 或已解包的 {type:'resource', resource:{…}}。
  const inner = block?.type === 'content' ? block.content : block;
  if (inner?.type !== 'resource') return null;
  return inner.resource || null;
}

function metaResourceUri(meta) {
  const direct = meta?.ui?.resourceUri ?? meta?.['ui/resourceUri'];
  return typeof direct === 'string' && direct.startsWith('ui://') ? direct : null;
}

/**
 * 从 tool_call / tool_call_update 原始负载提取 MCP App 资源。
 * 返回 { uri, html } 或 null（html 为空串时表示需要按需拉取，Desktop 暂不支持则忽略）。
 */
export function extractMcpAppResource(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const blocks = Array.isArray(payload.content) ? payload.content : [];
  for (const block of blocks) {
    const resource = resourceFromBlock(block);
    if (!resource) continue;
    const uri = typeof resource.uri === 'string' ? resource.uri : '';
    const isApp = resource.mimeType === MCP_APP_MIME || uri.startsWith('ui://');
    if (!isApp) continue;
    const html = typeof resource.text === 'string' ? resource.text : '';
    if (!html.trim()) continue;
    return { uri: uri || null, html };
  }
  // _meta 只声明了模板 URI 而无内联 HTML：需要 resources/read 往返，Desktop 暂不支持。
  if (metaResourceUri(payload._meta)) return null;
  return null;
}

export function normalizeMcpAppDisplayMode(mode) {
  return MCP_APP_DISPLAY_MODES.includes(mode) ? mode : 'inline';
}

/**
 * 计算 WebContentsView 在窗口内容坐标系中的边界。
 * inline 用占位元素矩形；fullscreen 全窗（留边距）；pip 右下角固定尺寸。
 */
export function mcpAppViewBounds(mode, anchorRect, viewport) {
  const vw = Math.max(0, Math.floor(Number(viewport?.width) || 0));
  const vh = Math.max(0, Math.floor(Number(viewport?.height) || 0));
  const normalized = normalizeMcpAppDisplayMode(mode);
  if (normalized === 'fullscreen') {
    return {
      x: FULLSCREEN_MARGIN,
      y: FULLSCREEN_MARGIN,
      width: Math.max(0, vw - FULLSCREEN_MARGIN * 2),
      height: Math.max(0, vh - FULLSCREEN_MARGIN * 2),
    };
  }
  if (normalized === 'pip') {
    return {
      x: Math.max(0, vw - PIP_WIDTH - 16),
      y: Math.max(0, vh - PIP_HEIGHT - 16),
      width: Math.min(PIP_WIDTH, vw),
      height: Math.min(PIP_HEIGHT, vh),
    };
  }
  const x = Math.max(0, Math.floor(Number(anchorRect?.x) || 0));
  const y = Math.max(0, Math.floor(Number(anchorRect?.y) || 0));
  const width = Math.max(0, Math.floor(Number(anchorRect?.width) || 0));
  const height = Math.max(0, Math.floor(Number(anchorRect?.height) || 0));
  // 裁剪到视口内，避免滚出可视区时 WebContentsView 覆盖标题栏等。
  const clampedY = Math.min(Math.max(0, y), vh);
  const clampedHeight = Math.max(0, Math.min(height, vh - clampedY));
  return { x, y: clampedY, width: Math.min(width, Math.max(0, vw - x)), height: clampedHeight };
}
