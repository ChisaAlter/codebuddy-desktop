import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { clampWindowState, windowStateIsVisible } = require('../../electron/window-state.cjs');

const PRIMARY = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
const SECONDARY = { workArea: { x: 1920, y: -225, width: 1920, height: 1080 } };

describe('window state clamping', () => {
  it('keeps a fully on-screen window in place', () => {
    expect(clampWindowState(
      { x: 120, y: 80, width: 1440, height: 900 },
      [PRIMARY],
    )).toEqual({ x: 120, y: 80, width: 1440, height: 900, isMaximized: false });
  });

  it('pulls a window that straddles two displays onto the larger-overlap screen', () => {
    const next = clampWindowState(
      { x: 2236, y: -225, width: 905, height: 647 },
      [PRIMARY, SECONDARY],
    );
    expect(next.x).toBeGreaterThanOrEqual(1920);
    expect(next.x + next.width).toBeLessThanOrEqual(1920 + 1920);
    expect(next.y).toBeGreaterThanOrEqual(-225);
    expect(next.y + next.height).toBeLessThanOrEqual(-225 + 1080);
    expect(next.width).toBe(905);
    expect(next.height).toBe(647);
  });

  it('shrinks a window that is larger than the target work area', () => {
    const next = clampWindowState(
      { x: 0, y: 0, width: 3000, height: 2000 },
      [PRIMARY],
    );
    expect(next).toEqual({ x: 0, y: 0, width: 1920, height: 1080, isMaximized: false });
  });

  it('treats missing coordinates as visible so first-run defaults still apply', () => {
    expect(windowStateIsVisible({ width: 1440, height: 920 }, [PRIMARY])).toBe(true);
  });
});
