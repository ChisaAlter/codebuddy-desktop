import { useStore } from '../store';
import { fetchJson } from './acp';

// Git cwd 跟随当前工作区：优先读 store.workspacePath，兜底 '.'
// 注意：每次 runGit 调用都动态读取，切工作区后下一次 git 调用立即生效
function getWorkspaceCwd() {
  try {
    const state = useStore.getState?.();
    if (state && state.workspacePath) return state.workspacePath;
  } catch (_) { /* store 未初始化时兜底 */ }
  return '.';
}

export async function runGit(commandArgs = [], cwd = getWorkspaceCwd()) {
  // 实机 QA 钩子：contextBridge 冻结 electronAPI，无法在 CDP 中改写 runGit。
  // 仅当 window.__QA_GIT_MOCK__ 被显式设置时生效（生产路径永不设置）。
  if (typeof window !== 'undefined' && window.__QA_GIT_MOCK__) {
    const mock = window.__QA_GIT_MOCK__;
    if (typeof mock === 'function') return mock(commandArgs, cwd);
    if (mock?.ok === false || mock?.error) {
      throw new Error(mock.error || 'git command failed');
    }
    return mock?.output ?? '';
  }
  const proc = await window.electronAPI?.runGit?.({ args: commandArgs, cwd });
  if (!proc || !proc.ok) {
    throw new Error(proc?.error || 'git command failed');
  }
  return proc.output || '';
}

/**
 * Git HTTP API 对照路径（对照源 bundle：POST /api/v1/git/{command}，body 拼 cwd）
 * - 与本地 IPC runGit 并存，不替换主路径
 * - 用途：后端有 git 但本机无 spawn 能力的环境兜底；亦供对照源真实 UI 路径回归比对
 * - body 形状：{...args, cwd: workspacePath}，对照源 FO() 读 editor-store.rootPath
 * - 返回：后端 git 结果（json 或 string），由调用方自行解析
 * @param {string} command - git 子命令，如 'status'/'log'/'diff'/'commit'
 * @param {object} [args] - 命令参数对象，如 { short: true, count: 20 }
 * @returns {Promise<object|string>}
 */
export async function runGitRemote(command, args = {}) {
  const cwd = getWorkspaceCwd();
  const body = { ...args, cwd };
  const payload = await fetchJson(`/api/v1/git/${encodeURIComponent(command)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return payload?.data ?? payload ?? null;
}

export async function getGitStatus(cwd) {
  const output = await runGit(['status', '--short', '-z'], cwd);
  const fields = output.split('\0').filter(Boolean);
  const items = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    const indexStatus = field.slice(0, 1);
    const worktreeStatus = field.slice(1, 2);
    const path = field.slice(3);
    const renamed = ['R', 'C'].includes(indexStatus) || ['R', 'C'].includes(worktreeStatus);
    const originalPath = renamed ? (fields[index + 1] || null) : null;
    if (renamed) index += 1;
    items.push({
      raw: field,
      indexStatus,
      worktreeStatus,
      path,
      originalPath,
    });
  }
  return items;
}

export async function getCurrentBranch(cwd) {
  return (await runGit(['branch', '--show-current'], cwd)).trim();
}

export async function getBranches(cwd) {
  return (await runGit(['branch', '--format=%(refname:short)'], cwd))
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export async function getDiff(path, cwd) {
  const [staged, unstaged] = await Promise.all([
    runGit(['diff', '--cached', '--', path], cwd),
    runGit(['diff', '--', path], cwd),
  ]);
  if (staged && unstaged) return `STAGED CHANGES\n${staged}\n\nUNSTAGED CHANGES\n${unstaged}`;
  return staged || unstaged;
}

export async function stageFile(path, cwd = getWorkspaceCwd()) {
  return await runGit(['add', '--', path], cwd);
}

export async function unstageFile(path, cwd = getWorkspaceCwd()) {
  return await runGit(['reset', 'HEAD', '--', path], cwd);
}

export async function discardFile(item, cwd = getWorkspaceCwd()) {
  const path = typeof item === 'string' ? item : item?.path;
  if (!path) throw new Error('缺少要丢弃的文件路径');
  const untracked = typeof item === 'object' && item?.indexStatus === '?' && item?.worktreeStatus === '?';
  if (untracked) {
    return await runGit(['clean', '-fd', '--', path], cwd);
  }
  const paths = [path];
  if (typeof item === 'object' && item?.originalPath) paths.push(item.originalPath);
  return await runGit(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...paths], cwd);
}

export async function stageAll(cwd = getWorkspaceCwd()) {
  return await runGit(['add', '-A'], cwd);
}

export async function unstageAll(cwd = getWorkspaceCwd()) {
  return await runGit(['reset', 'HEAD', '--', '.'], cwd);
}

export async function discardAll(cwd = getWorkspaceCwd()) {
  try {
    await runGit(['rev-parse', '--verify', 'HEAD'], cwd);
  } catch (_) {
    throw new Error('仓库尚无提交，无法安全丢弃全部修改');
  }
  await runGit(['reset', 'HEAD', '--', '.'], cwd);
  await runGit(['checkout', '--', '.'], cwd);
  return await runGit(['clean', '-fd'], cwd);
}

export async function switchBranch(name, cwd = getWorkspaceCwd()) {
  return await runGit(['checkout', name], cwd);
}

export async function createBranch(name, cwd = getWorkspaceCwd()) {
  return await runGit(['checkout', '-b', name], cwd);
}

export async function pushBranch(cwd = getWorkspaceCwd()) {
  try {
    return await runGit(['push'], cwd);
  } catch (error) {
    if (!/no upstream branch|has no upstream branch|set-upstream/i.test(error?.message || '')) throw error;
    const branch = await getCurrentBranch(cwd);
    if (!branch) throw new Error('当前处于 detached HEAD，无法自动建立远程跟踪分支');
    return await runGit(['push', '-u', 'origin', branch], cwd);
  }
}

export async function pullBranch(cwd = getWorkspaceCwd()) {
  return await runGit(['pull'], cwd);
}

/**
 * Git commit
 * @param {string} message - 提交信息
 * @returns {Promise<string>}
 */
export async function commit(message, cwd = getWorkspaceCwd()) {
  return await runGit(['commit', '-m', message], cwd);
}

/**
 * Git log（返回最近 N 条提交历史，精简格式）
 * @param {number} [count=20] - 返回的提交数量
 * @returns {Promise<Array<{raw: string}>>}
 */
export async function getLog(count = 20) {
  const output = await runGit(['log', `-${count}`, '--oneline', '--decorate']);
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => ({ raw: line }));
}

/**
 * Git log 详细版（返回最近 N 条提交历史，带完整信息）
 * @param {number} [count=20] - 返回的提交数量
 * @returns {Promise<Array<{hash: string, shortHash: string, author: string, date: string, subject: string}>>}
 */
export async function getLogDetailed(count = 20) {
  // %x1f（单元分隔符）作字段边界：作者名/提交信息里出现 `|` 会让旧的
  // split('|') 把 author 之后的所有字段左移（subject 有 rejoin 兜底，author 没有）。
  const output = await runGit(['log', `-${count}`, '--format=%H%x1f%h%x1f%an%x1f%ai%x1f%s']);
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [hash, shortHash, author, date, ...subjectParts] = line.split('\x1f');
      return { hash, shortHash, author, date, subject: subjectParts.join('\x1f') };
    });
}

/**
 * Git stash 暂存当前工作区修改
 * @returns {Promise<string>}
 */
export async function stash() {
  return await runGit(['stash']);
}

/**
 * Git stash pop 恢复最近一次暂存
 * @returns {Promise<string>}
 */
export async function stashPop() {
  return await runGit(['stash', 'pop']);
}

/**
 * Git stash 列表
 * @returns {Promise<Array<{raw: string}>>}
 */
export async function stashList() {
  const output = await runGit(['stash', 'list']);
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => ({ raw: line }));
}

/**
 * Git fetch 从远程获取最新 refs
 * @returns {Promise<string>}
 */
export async function fetch() {
  return await runGit(['fetch']);
}

/**
 * 获取未暂存的 diff
 * @returns {Promise<string>}
 */
export async function getUnstagedDiff() {
  return await runGit(['diff']);
}

/**
 * 获取已暂存区的 diff
 * @returns {Promise<string>}
 */
export async function getStagedDiff() {
  return await runGit(['diff', '--cached']);
}

/**
 * 获取远程仓库 URL
 * @returns {Promise<string>}
 */
export async function getRemoteUrl() {
  try {
    return (await runGit(['remote', 'get-url', 'origin'])).trim();
  } catch (_) {
    return '';
  }
}
