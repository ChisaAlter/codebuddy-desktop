// G12: `/autocompact` 面板逻辑（CLI 2.136 autoCompactWindow）。
// 触发基准 = min(autoCompactWindow, 模型上下文窗口)；未设置时跟随模型窗口。

export function normalizeAutoCompactWindow(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** Effective compaction baseline given the setting and the model context size. */
export function effectiveAutoCompactWindow(windowSetting, modelWindow) {
  const setting = normalizeAutoCompactWindow(windowSetting);
  const model = normalizeAutoCompactWindow(modelWindow);
  if (setting && model) return Math.min(setting, model);
  return setting || model || null;
}
