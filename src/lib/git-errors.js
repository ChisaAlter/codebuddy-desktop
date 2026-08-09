// M1 错误态分层：Git 错误分类（M4/M5：文案走 i18n 键，t 注入；无 t 时中文兜底）
// 契约：docs/workflow/specs/2026-08-06-workflow-panel-payload-contract.md §4
import { translate, resolveLocaleMode } from './i18n';

const ERROR_KINDS = ['notrepo', 'perm', 'timeout', 'big', 'other'];

const ERROR_KEYS = {
  notrepo: { title: 'workflow.gitError.notrepo.title', body: 'workflow.gitError.notrepo.body' },
  perm: { title: 'workflow.gitError.perm.title', body: 'workflow.gitError.perm.body' },
  timeout: { title: 'workflow.gitError.timeout.title', body: 'workflow.gitError.timeout.body' },
  big: { title: 'workflow.gitError.big.title', body: 'workflow.gitError.big.body' },
  other: { title: 'workflow.gitError.other.title', body: 'workflow.gitError.other.body' },
};

const defaultT = (key) => translate(resolveLocaleMode('zh'), key);

/**
 * 将主进程返回的原始错误文本分类为分层错误态。
 * @param {string|Error} raw
 * @param {(key: string, vars?: object) => string} [t] i18n 渲染函数（默认中文）
 * @returns {{ kind: string, title: string, body: string }}
 */
export function classifyGitError(raw, t = defaultT) {
  const message = String(raw?.message ?? raw ?? '').trim();

  // 16MB 截断（主进程显式文案）
  if (/16MB|输出超过/.test(message)) {
    return { kind: 'big', title: t(ERROR_KEYS.big.title), body: t(ERROR_KEYS.big.body) };
  }

  // 超时（主进程 timeoutMessage 或 ETIMEDOUT）
  if (/执行超时|ETIMEDOUT|timed out|Timed out|超时/.test(message)) {
    return { kind: 'timeout', title: t(ERROR_KEYS.timeout.title), body: t(ERROR_KEYS.timeout.body) };
  }

  // 权限（EACCES / permission denied / 无法访问）
  if (/EACCES|permission denied|denied|权限|无法访问|not accessible/.test(message)) {
    return { kind: 'perm', title: t(ERROR_KEYS.perm.title), body: t(ERROR_KEYS.perm.body) };
  }

  // 非仓库（fatal: not a git repository / 没有 .git）
  if (/not a git repository|not a git repo|不是 git 仓库|不是 Git 仓库|does not appear to be a git repository|fatal:/i.test(message)) {
    return { kind: 'notrepo', title: t(ERROR_KEYS.notrepo.title), body: t(ERROR_KEYS.notrepo.body) };
  }

  // 兜底：原文透出（仍恒显刷新按钮）
  return {
    kind: 'other',
    title: t(ERROR_KEYS.other.title),
    body: message || t(ERROR_KEYS.other.body),
  };
}

export { ERROR_KINDS };
