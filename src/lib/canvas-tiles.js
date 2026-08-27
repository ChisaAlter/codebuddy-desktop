// G10: Canvas 磁贴几何（对照 WebUI 2.138 canvas-store 纯变换部分）。
// 常量与 WebUI 一致：默认磁贴 400×300、最小 200×150、网格 20、缩放 0.1–5、
// 最小化高度 32。磁贴状态机 normal/maximized/minimized 与 prevBounds 语义同 WebUI。

export const TILE_DEFAULT_WIDTH = 400;
export const TILE_DEFAULT_HEIGHT = 300;
export const TILE_MIN_WIDTH = 200;
export const TILE_MIN_HEIGHT = 150;
export const CANVAS_GRID = 20;
export const CANVAS_MIN_ZOOM = 0.1;
export const CANVAS_MAX_ZOOM = 5;
export const TILE_MINIMIZED_HEIGHT = 32;

export function snapToGrid(value, grid = CANVAS_GRID) {
  return Math.round((Number(value) || 0) / grid) * grid;
}

export function clampZoom(zoom) {
  const value = Number(zoom);
  if (!Number.isFinite(value)) return 1;
  return Math.min(CANVAS_MAX_ZOOM, Math.max(CANVAS_MIN_ZOOM, value));
}

/** WebUI addTile：把新磁贴放在当前视口中心（画布坐标系，吸附网格）。 */
export function centerTilePosition(viewport, viewportSize) {
  const zoom = clampZoom(viewport?.zoom ?? 1);
  const panX = Number(viewport?.panX) || 0;
  const panY = Number(viewport?.panY) || 0;
  const width = Number(viewportSize?.width) || 0;
  const height = Number(viewportSize?.height) || 0;
  const x = (-panX + width / 2) / zoom - TILE_DEFAULT_WIDTH / 2;
  const y = (-panY + height / 2) / zoom - TILE_DEFAULT_HEIGHT / 2;
  return { x: snapToGrid(x), y: snapToGrid(y) };
}

export function makeTile(id, position, zIndex = 1) {
  return {
    id,
    type: 'terminal',
    x: Number(position?.x) || 0,
    y: Number(position?.y) || 0,
    width: TILE_DEFAULT_WIDTH,
    height: TILE_DEFAULT_HEIGHT,
    zIndex,
    windowState: 'normal',
    ptySessionId: null,
    cwd: null,
  };
}

function currentBounds(tile) {
  return tile.windowState === 'normal'
    ? { x: tile.x, y: tile.y, width: tile.width, height: tile.height }
    : tile.prevBounds;
}

export function maximizeTileState(tile, zIndex) {
  return { ...tile, windowState: 'maximized', prevBounds: currentBounds(tile), zIndex };
}

export function minimizeTileState(tile) {
  return { ...tile, windowState: 'minimized', height: TILE_MINIMIZED_HEIGHT, prevBounds: currentBounds(tile) };
}

export function restoreTileState(tile) {
  if (!tile.prevBounds) return { ...tile, windowState: 'normal' };
  const { prevBounds, ...rest } = tile;
  return { ...rest, ...prevBounds, windowState: 'normal' };
}

/** 以指针位置为锚点缩放（画布坐标保持在指针下不动）。 */
export function zoomViewportAtPoint(viewport, nextZoomRaw, point) {
  const zoom = clampZoom(viewport?.zoom ?? 1);
  const nextZoom = clampZoom(nextZoomRaw);
  if (nextZoom === zoom) return viewport;
  const px = Number(point?.x) || 0;
  const py = Number(point?.y) || 0;
  const panX = Number(viewport?.panX) || 0;
  const panY = Number(viewport?.panY) || 0;
  const worldX = (px - panX) / zoom;
  const worldY = (py - panY) / zoom;
  return { panX: px - worldX * nextZoom, panY: py - worldY * nextZoom, zoom: nextZoom };
}

/** 拖拽/缩放尺寸约束。 */
export function clampTileSize(width, height) {
  return {
    width: Math.max(TILE_MIN_WIDTH, Math.round(Number(width) || 0)),
    height: Math.max(TILE_MIN_HEIGHT, Math.round(Number(height) || 0)),
  };
}
