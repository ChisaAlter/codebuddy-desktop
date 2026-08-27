// G11: 编辑器多标签纯逻辑（pin / 关闭其它 / 关闭后焦点迁移）+ 文件预览类型判定。
// 排序不变式：pinned 标签始终位于列表前部（与 WebUI EditorView 标签条一致）。

export function tabBasename(path) {
  const parts = String(path || '').replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || String(path || '');
}

function sortPinnedFirst(tabs) {
  const pinned = tabs.filter((tab) => tab.pinned);
  const rest = tabs.filter((tab) => !tab.pinned);
  return [...pinned, ...rest];
}

export function addEditorTab(tabs, path) {
  const list = Array.isArray(tabs) ? tabs : [];
  if (!path || list.some((tab) => tab.path === path)) return list;
  return [...list, { path, pinned: false }];
}

export function closeEditorTab(tabs, path) {
  const list = Array.isArray(tabs) ? tabs : [];
  return list.filter((tab) => tab.path !== path);
}

/** 关闭 activePath 后应聚焦的标签：优先右邻，无则左邻，空则 null。 */
export function nextActiveAfterClose(tabs, closedPath, activePath) {
  const list = Array.isArray(tabs) ? tabs : [];
  if (closedPath !== activePath) return activePath;
  const index = list.findIndex((tab) => tab.path === closedPath);
  if (index < 0) return activePath;
  const remaining = list.filter((tab) => tab.path !== closedPath);
  if (remaining.length === 0) return null;
  return (remaining[index] || remaining[index - 1] || remaining[0]).path;
}

export function toggleEditorTabPin(tabs, path) {
  const list = Array.isArray(tabs) ? tabs : [];
  return sortPinnedFirst(list.map((tab) => (tab.path === path ? { ...tab, pinned: !tab.pinned } : tab)));
}

/** 关闭其它：保留 pinned 标签与目标标签本身。 */
export function closeOtherEditorTabs(tabs, keepPath) {
  const list = Array.isArray(tabs) ? tabs : [];
  return list.filter((tab) => tab.pinned || tab.path === keepPath);
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx']);

/** 预览类型：markdown | image | svg | pdf | text。 */
export function editorFileKind(path) {
  const ext = String(path || '').split('.').pop()?.toLowerCase() || '';
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
  if (ext === 'svg') return 'svg';
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  return 'text';
}
