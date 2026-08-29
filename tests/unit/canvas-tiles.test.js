// G10: Canvas 磁贴几何纯逻辑（对照 WebUI canvas-store 常量与变换）。
import { describe, expect, it } from 'vitest';
import {
  TILE_DEFAULT_WIDTH,
  TILE_DEFAULT_HEIGHT,
  TILE_MINIMIZED_HEIGHT,
  snapToGrid,
  clampZoom,
  centerTilePosition,
  makeTile,
  maximizeTileState,
  minimizeTileState,
  restoreTileState,
  zoomViewportAtPoint,
  clampTileSize,
} from '../../src/lib/canvas-tiles';

describe('grid & zoom', () => {
  it('snaps to the 20px grid', () => {
    expect(snapToGrid(0)).toBe(0);
    expect(snapToGrid(29)).toBe(20);
    expect(snapToGrid(31)).toBe(40);
    expect(snapToGrid(-29)).toBe(-20);
  });

  it('clamps zoom to 0.1–5 (WebUI N/P)', () => {
    expect(clampZoom(0.01)).toBe(0.1);
    expect(clampZoom(9)).toBe(5);
    expect(clampZoom(1.5)).toBe(1.5);
    expect(clampZoom(NaN)).toBe(1);
  });
});

describe('centerTilePosition / makeTile', () => {
  it('centers a 400x300 tile in the visible viewport, snapped to grid', () => {
    const pos = centerTilePosition({ panX: 0, panY: 0, zoom: 1 }, { width: 800, height: 600 });
    expect(pos).toEqual({ x: 200, y: 160 });
    const tile = makeTile('t1', pos, 3);
    expect(tile).toMatchObject({
      id: 't1',
      type: 'terminal',
      x: 200,
      y: 160,
      width: TILE_DEFAULT_WIDTH,
      height: TILE_DEFAULT_HEIGHT,
      zIndex: 3,
      windowState: 'normal',
    });
  });

  it('accounts for pan and zoom', () => {
    const pos = centerTilePosition({ panX: -100, panY: 40, zoom: 2 }, { width: 800, height: 600 });
    expect(pos).toEqual({ x: 60, y: -20 });
  });
});

describe('tile window states', () => {
  const tile = makeTile('t1', { x: 100, y: 60 }, 1);

  it('maximize stores prevBounds and bumps zIndex', () => {
    const maxed = maximizeTileState(tile, 9);
    expect(maxed.windowState).toBe('maximized');
    expect(maxed.zIndex).toBe(9);
    expect(maxed.prevBounds).toEqual({ x: 100, y: 60, width: TILE_DEFAULT_WIDTH, height: TILE_DEFAULT_HEIGHT });
  });

  it('minimize collapses to header height and restore round-trips', () => {
    const minimized = minimizeTileState(tile);
    expect(minimized.height).toBe(TILE_MINIMIZED_HEIGHT);
    expect(minimized.windowState).toBe('minimized');
    const restored = restoreTileState(minimized);
    expect(restored).toMatchObject({ x: 100, y: 60, width: TILE_DEFAULT_WIDTH, height: TILE_DEFAULT_HEIGHT, windowState: 'normal' });
    expect(restored.prevBounds).toBeUndefined();
  });

  it('restore without prevBounds only resets windowState', () => {
    expect(restoreTileState({ ...tile, windowState: 'maximized' }).windowState).toBe('normal');
  });
});

describe('zoomViewportAtPoint / clampTileSize', () => {
  it('keeps the anchor point stationary while zooming', () => {
    const viewport = { panX: 0, panY: 0, zoom: 1 };
    const next = zoomViewportAtPoint(viewport, 2, { x: 400, y: 300 });
    // 画布坐标 (400,300) 缩放后仍映射到屏幕 (400,300)：pan = p - world*zoom
    expect(next).toEqual({ panX: -400, panY: -300, zoom: 2 });
  });

  it('returns the same viewport when zoom is unchanged (already clamped)', () => {
    const viewport = { panX: 5, panY: 5, zoom: 5 };
    expect(zoomViewportAtPoint(viewport, 8, { x: 0, y: 0 })).toBe(viewport);
  });

  it('enforces 200x150 minimum tile size', () => {
    expect(clampTileSize(100, 100)).toEqual({ width: 200, height: 150 });
    expect(clampTileSize(640, 480)).toEqual({ width: 640, height: 480 });
  });
});
