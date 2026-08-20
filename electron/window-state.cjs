'use strict';

const MIN_WIDTH = 900;
const MIN_HEIGHT = 640;
const DEFAULT_WIDTH = 1440;
const DEFAULT_HEIGHT = 920;

function overlapArea(state, workArea) {
  const width = Number(state?.width);
  const height = Number(state?.height);
  const x = Number(state?.x);
  const y = Number(state?.y);
  if (![width, height, x, y].every(Number.isFinite)) return 0;
  const overlapWidth = Math.min(x + width, workArea.x + workArea.width) - Math.max(x, workArea.x);
  const overlapHeight = Math.min(y + height, workArea.y + workArea.height) - Math.max(y, workArea.y);
  if (overlapWidth <= 0 || overlapHeight <= 0) return 0;
  return overlapWidth * overlapHeight;
}

function workAreasFromDisplays(displays = []) {
  return displays
    .map((display) => display?.workArea || display)
    .filter((area) => area && Number.isFinite(area.x) && Number.isFinite(area.y)
      && Number.isFinite(area.width) && Number.isFinite(area.height)
      && area.width > 0 && area.height > 0);
}

function chooseWorkArea(state, displays = []) {
  const areas = workAreasFromDisplays(displays);
  if (!areas.length) return null;
  let best = areas[0];
  let bestArea = overlapArea(state, best);
  for (const area of areas.slice(1)) {
    const areaOverlap = overlapArea(state, area);
    if (areaOverlap > bestArea) {
      best = area;
      bestArea = areaOverlap;
    }
  }
  return best;
}

function isFullyOnWorkArea(state, workArea) {
  if (!workArea) return false;
  const width = Number(state?.width);
  const height = Number(state?.height);
  const x = Number(state?.x);
  const y = Number(state?.y);
  if (![width, height, x, y].every(Number.isFinite)) return false;
  return x >= workArea.x
    && y >= workArea.y
    && x + width <= workArea.x + workArea.width
    && y + height <= workArea.y + workArea.height;
}

function windowStateIsVisible(state, displays = []) {
  if (typeof state?.x !== 'number' || typeof state?.y !== 'number') return true;
  return workAreasFromDisplays(displays).some((workArea) => overlapArea(state, workArea) >= 80 * 80);
}

function clampWindowState(state, displays = [], defaults = {}) {
  const fallbackWidth = Number(defaults.width) > 0 ? defaults.width : DEFAULT_WIDTH;
  const fallbackHeight = Number(defaults.height) > 0 ? defaults.height : DEFAULT_HEIGHT;
  const width = Math.max(MIN_WIDTH, Number(state?.width) || fallbackWidth);
  const height = Math.max(MIN_HEIGHT, Number(state?.height) || fallbackHeight);
  const workArea = chooseWorkArea({ ...state, width, height }, displays) || workAreasFromDisplays(displays)[0];
  if (!workArea) {
    return {
      x: Number.isFinite(state?.x) ? state.x : 80,
      y: Number.isFinite(state?.y) ? state.y : 80,
      width,
      height,
      isMaximized: Boolean(state?.isMaximized),
    };
  }

  const fittedWidth = Math.min(width, workArea.width);
  const fittedHeight = Math.min(height, workArea.height);
  const maxX = workArea.x + workArea.width - fittedWidth;
  const maxY = workArea.y + workArea.height - fittedHeight;
  const next = {
    x: Number.isFinite(state?.x) ? Math.min(Math.max(state.x, workArea.x), maxX) : workArea.x,
    y: Number.isFinite(state?.y) ? Math.min(Math.max(state.y, workArea.y), maxY) : workArea.y,
    width: fittedWidth,
    height: fittedHeight,
    isMaximized: Boolean(state?.isMaximized),
  };

  // 骑在两块屏中间时，整窗钳进重叠最大的那块工作区，避免侧栏落在另一块屏上。
  if (!isFullyOnWorkArea(next, workArea)) {
    next.x = workArea.x;
    next.y = workArea.y;
  }
  return next;
}

module.exports = {
  MIN_WIDTH,
  MIN_HEIGHT,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  overlapArea,
  windowStateIsVisible,
  clampWindowState,
};
