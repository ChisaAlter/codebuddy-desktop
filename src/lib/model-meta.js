// 对照 WebUI 2.138 模型菜单的 meta 列：优先显示计费倍率（credits，如「0.5x」），
// 无倍率时回落到上下文窗口容量（maxInputTokens，如「200K」）。
// credits 原始值为 CLI 下发的字符串（例如 "0.5 credits" / "×0.25 credits"）。

export function formatModelCredits(credits) {
  if (credits == null) return '';
  const text = String(credits)
    .replace(/\s*credits\s*$/i, '')
    .trim();
  const value = Number.parseFloat(text.replace(/^[x×]/i, ''));
  return Number.isFinite(value) && value > 0 ? `${value}x` : '';
}

export function formatContextTokens(tokens) {
  const value = Number(tokens);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value >= 1e6) {
    const millions = value / 1e6;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (value >= 1e3) return `${Math.round(value / 1e3)}K`;
  return String(value);
}

export function modelMenuMeta(model) {
  return formatModelCredits(model?.credits) || formatContextTokens(model?.contextWindow);
}
