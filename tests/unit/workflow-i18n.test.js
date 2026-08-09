import { describe, it, expect } from 'vitest';
import { translate, resolveLocaleMode } from '../../src/lib/i18n';
import { STATUS_LABELS } from '../../src/lib/workflow-status';
import { classifyGitError } from '../../src/lib/git-errors';

const zh = (key, vars) => translate(resolveLocaleMode('zh'), key, vars);
const en = (key, vars) => translate(resolveLocaleMode('en'), key, vars);

describe('M5 面板 i18n：zh/en 双语言键完整性与渲染', () => {
  const panelKeys = [
    'workflow.panelTitle', 'workflow.panelClose',
    'workflow.git.title', 'workflow.git.refresh', 'workflow.git.refreshing', 'workflow.git.loading',
    'workflow.git.changes', 'workflow.git.noBranch', 'workflow.git.branch', 'workflow.git.ahead', 'workflow.git.behind',
    'workflow.git.commitPlaceholder', 'workflow.git.commitPush',
    'workflow.git.adding', 'workflow.git.committing', 'workflow.git.pushing',
    'workflow.git.addingHint', 'workflow.git.committingHint', 'workflow.git.pushingHint',
    'workflow.git.committedOk', 'workflow.git.committedRef', 'workflow.git.pushFailed',
    'workflow.git.retryPush', 'workflow.git.pushRetryHint', 'workflow.git.noWorkspace',
    'workflow.git.projectSwitched', 'workflow.git.retrySwitched', 'workflow.git.committed',
    'workflow.git.pushFailedToast', 'workflow.git.commitFailed', 'workflow.git.repushed',
    'workflow.goals.title', 'workflow.tasks.title', 'workflow.subagents.title',
    'workflow.subagents.empty', 'workflow.subagents.historyPrefix',
    'workflow.subagents.paths', 'workflow.subagents.pathCount', 'workflow.subagents.more',
    'workflow.subagents.toolCalls', 'workflow.subagents.noToolCalls',
    'workflow.history.badge', 'workflow.history.goalsNote',
  ];

  it('zh 与 en 全部键均有非空译文', () => {
    for (const key of panelKeys) {
      const z = zh(key);
      const e = en(key);
      expect(z.trim().length, `zh ${key}`).toBeGreaterThan(0);
      expect(e.trim().length, `en ${key}`).toBeGreaterThan(0);
    }
  });

  it('zh 与 en 译文不同（确实存在翻译）', () => {
    for (const key of ['workflow.git.commitPush', 'workflow.goals.title', 'workflow.panelTitle']) {
      expect(zh(key)).not.toBe(en(key));
    }
  });

  it('模板变量渲染', () => {
    expect(zh('workflow.git.ahead', { n: 3 })).toBe('领先 3');
    expect(en('workflow.git.ahead', { n: 3 })).toBe('3 ahead');
    expect(zh('workflow.subagents.pathCount', { n: 8 })).toBe('8 条路径');
  });

  it('STATUS_LABELS 单源：所有键在 i18n 表中存在', () => {
    for (const key of Object.values(STATUS_LABELS)) {
      expect(zh(key).trim().length, `zh ${key}`).toBeGreaterThan(0);
      expect(en(key).trim().length, `en ${key}`).toBeGreaterThan(0);
    }
  });

  it('STATUS_LABELS 覆盖 normalizeStatus 的全部输出键', () => {
    for (const k of ['pending', 'running', 'working', 'in_progress', 'waiting', 'blocked', 'queued', 'completed', 'failed', 'cancelled', 'idle']) {
      expect(STATUS_LABELS[k], k).toBeTruthy();
    }
  });

  it('classifyGitError 双语言渲染（t 注入）', () => {
    const z = classifyGitError('fatal: not a git repository', zh);
    expect(z.title).toBe('不是 Git 仓库');
    const e = classifyGitError('fatal: not a git repository', en);
    expect(e.title).toBe('Not a Git repository');
    expect(e.body).toContain('git init');
  });
});
