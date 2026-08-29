import { fetchJson, requestCodeBuddy } from './acp';

export async function fsList(path = '.', depth = 1) {
  // L1: cap depth client-side so a runaway caller cannot ask the backend for a
  // 9999-deep tree (huge payload). The backend canonicalizes and rejects `..`
  // traversal; this is a defense-in-depth bound.
  const cappedDepth = Math.min(Math.max(Number(depth) || 1, 1), 10);
  const payload = await fetchJson('/api/v1/fs/list', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, depth: cappedDepth }),
  });
  return payload.data?.entries || payload.entries || payload.files || [];
}

export async function fsSearchContent({ query, cwd = '.', isRegex = false, caseSensitive = false, wholeWord = false, includeGlob = '', excludeGlob = '' }) {
  const payload = await fetchJson('/api/v1/fs/search-content', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      cwd,
      isRegex,
      caseSensitive,
      wholeWord,
      includeGlob: includeGlob || undefined,
      excludeGlob: excludeGlob || undefined,
      maxResults: 200,
    }),
  });
  return payload.data?.results || payload.results || [];
}

/**
 * 文件名快速搜索（对照源 GET /api/v1/fs/search?query&limit）
 * - 用途：补全/打开文件面板的实时名匹配（不同于 fsSearchContent 的内容搜索）
 * - 返回：{ items: [{ path, name, type, ... }] }，对照源 bundle ve.items
 * @param {string} query - 文件名片段
 * @param {object} [opts] - { limit=15 }
 * @returns {Promise<Array>}
 */
export async function fsSearchFiles(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const params = new URLSearchParams();
  params.set('query', q);
  params.set('limit', String(opts.limit ?? 15));
  const payload = await fetchJson(`/api/v1/fs/search?${params.toString()}`);
  // 对照源 bundle：const ve=await ae.json(); C(ve.items||[])
  return payload?.items || payload?.data?.items || [];
}

export async function createWatcher(path = '.', recursive = true) {
  const payload = await fetchJson('/api/v1/fs/watcher/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, recursive }),
  });
  return payload.data || payload;
}

export async function pollWatcher(watcherId) {
  const payload = await fetchJson('/api/v1/fs/watcher/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ watcherId }),
  });
  const data = payload?.data ?? payload;
  if (Array.isArray(data)) return data;
  return data?.events || data?.changes || [];
}

export async function removeWatcher(watcherId) {
  return fetchJson('/api/v1/fs/watcher/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ watcherId }),
  });
}

export async function downloadFile(path) {
  const response = await requestCodeBuddy(`/api/v1/files/download?path=${encodeURIComponent(path)}`, {
    method: 'GET',
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

/**
 * 创建目录
 * @param {string} path - 目录路径
 * @returns {Promise<object>} 创建结果
 */
export async function fsMkdir(path) {
  const payload = await fetchJson('/api/v1/fs/mkdir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  return payload.data || payload;
}

/**
 * 移动/重命名文件或目录
 * @param {string} source - 源路径
 * @param {string} destination - 目标路径
 * @returns {Promise<object>} 移动结果
 */
export async function fsMove(source, destination) {
  const payload = await fetchJson('/api/v1/fs/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, destination }),
  });
  return payload.data || payload;
}

/**
 * 删除文件或目录
 * @param {string} path - 路径
 * @returns {Promise<object>} 删除结果
 */
export async function fsRemove(path) {
  const payload = await fetchJson('/api/v1/fs/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  return payload.data || payload;
}

/**
 * 写入文件内容
 * @param {string} path - 文件路径
 * @param {string} content - 文件内容
 * @returns {Promise<object>} 写入结果
 */
export async function fsWrite(path, content) {
  const payload = await fetchJson('/api/v1/fs/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content }),
  });
  return payload.data || payload;
}

/**
 * 读取文件内容（文本）
 * @param {string} path - 文件路径
 * @returns {Promise<string>} 文件文本内容
 */
export async function fsRead(path) {
  const response = await requestCodeBuddy(`/api/v1/fs/read?path=${encodeURIComponent(path)}`, {
    method: 'GET',
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

/**
 * G11: 读取文件为 Blob（图片 / PDF / SVG 预览用）。
 * 走 WebUI 同款二进制通道 `/api/v1/files/download`（fs/read 是文本语义，二进制会读取失败）。
 * @param {string} path - 文件路径
 * @returns {Promise<Blob>}
 */
export async function fsReadBlob(path) {
  const response = await requestCodeBuddy(`/api/v1/files/download?path=${encodeURIComponent(path)}`, {
    method: 'GET',
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.blob();
}

/**
 * 上传文件（base64 编码内容）
 * @param {string} path - 目标路径
 * @param {string} content - base64 编码的文件内容
 * @param {string} [encoding='base64'] - 编码方式
 * @returns {Promise<object>} 上传结果
 */
export async function fsUpload(path, content, encoding = 'base64') {
  const payload = await fetchJson('/api/v1/files/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content, encoding }),
  });
  return payload.data || payload;
}

export function normalizePathParts(path) {
  return String(path || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean);
}

export function joinPath(base, child) {
  if (!base || base === '.') return child;
  // L1: no client-side `..` rejection here — backend `/api/v1/fs/*` canonicalizes
  // and rejects traversal. Defense-in-depth relies on the backend; if a future
  // backend loosens that, add a `..` segment check here.
  return `${base.replace(/\\/g, '/')}/${child}`;
}

export { requestCodeBuddy as getCodeBuddyRequest };
