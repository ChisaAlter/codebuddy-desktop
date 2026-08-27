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
 * senderFrame 校验（Electron IPC 溯源，防 iframe 冒充主窗口）：
 * - null/undefined 放行：Electron 文档允许 frame 已销毁或跨导航时 event.senderFrame
 *   为 null，此时回退到 sender 级校验（sender === mainWindow.webContents 已足够）。
 * - 子 frame（iframe，parent 非空）一律拒绝：即使 iframe 与主窗口同 webContents，
 *   特权 IPC 也只允许主 frame 发起（Electron 安全清单「validate the sender frame」）。
 * - frame 必须就是 sender 自己的 mainFrame（防其他 webContents 的顶层 frame 冒充）。
 */
function isTrustedSenderFrame(senderFrame, sender) {
  if (senderFrame == null) return true;
  if (senderFrame.parent != null) return false;
  if (sender && sender.mainFrame && senderFrame !== sender.mainFrame) return false;
  return true;
}

/**
 * sender 校验：必须是主窗口的 webContents（对齐 isAllowedLocalRuntimeUrl 的本地信任边界）。
 * 任何已销毁/非主窗口的 sender 一律拒绝。可选第三参 senderFrame（event.senderFrame）：
 * 传入时额外要求是主 frame（见 isTrustedSenderFrame）。
 */
function isTrustedGitSender(sender, mainWindow, senderFrame) {
  if (!sender || typeof sender.isDestroyed !== 'function' || sender.isDestroyed()) return false;
  if (!mainWindow || typeof mainWindow.isDestroyed !== 'function' || mainWindow.isDestroyed()) return false;
  if (sender !== mainWindow.webContents) return false;
  return isTrustedSenderFrame(senderFrame, sender);
}

const isTrustedMainSender = isTrustedGitSender;

module.exports = {
  normalizeDir,
  normalizeDirList,
  isAllowedGitCwd,
  isTrustedSenderFrame,
  isTrustedGitSender,
  isTrustedMainSender,
};
