// M1 安全面：Git cwd 归属白名单 + sender 校验（纯函数，供单测）
// 契约：docs/workflow/specs/2026-08-06-workflow-panel-payload-contract.md §2/§3
const path = require('path');

/**
 * 规范化目录：trim + path.resolve（绝对化 + 去尾分隔符）。非法输入返回 null。
 */
function normalizeDir(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return path.resolve(value.trim());
  } catch (_) {
    return null;
  }
}

/**
 * 目录数组 → 规范化 Set（过滤非法项）。允许空数组（结果为空 Set）。
 */
function normalizeDirList(dirs) {
  const set = new Set();
  for (const dir of Array.isArray(dirs) ? dirs : []) {
    const normalized = normalizeDir(dir);
    if (normalized) set.add(normalized);
  }
  return set;
}

/**
 * cwd 归属校验：cwd 必须能规范化，且 resolve 后 ∈ allowedDirs。
 * 安全默认：allowedDirs 非 Set 或为空 Set 时一律拒绝（未注册任何项目目录 = 拒绝任意目录）。
 */
function isAllowedGitCwd(cwd, allowedDirs) {
  const normalized = normalizeDir(cwd);
  if (!normalized) return false;
  if (!(allowedDirs instanceof Set) || allowedDirs.size === 0) return false;
  return allowedDirs.has(normalized);
}

/**
 * sender 校验：必须是主窗口的 webContents（对齐 isAllowedLocalRuntimeUrl 的本地信任边界）。
 * 任何已销毁/非主窗口的 sender 一律拒绝。
 */
function isTrustedGitSender(sender, mainWindow) {
  if (!sender || typeof sender.isDestroyed !== 'function' || sender.isDestroyed()) return false;
  if (!mainWindow || typeof mainWindow.isDestroyed !== 'function' || mainWindow.isDestroyed()) return false;
  return sender === mainWindow.webContents;
}

const isTrustedMainSender = isTrustedGitSender;

module.exports = {
  normalizeDir,
  normalizeDirList,
  isAllowedGitCwd,
  isTrustedGitSender,
  isTrustedMainSender,
};
