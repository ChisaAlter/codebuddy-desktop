import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store';
import { runGit } from '../lib/git';
import { classifyGitError } from '../lib/git-errors';
import {
  COMMIT_PHASES,
  PHASE_LABELS,
  RESULT,
  executeCommitTransaction,
  retryPushAfterCommitted,
} from '../lib/git-commit-flow';
import { normalizeWorkflowStatus, STATUS_LABELS } from '../lib/workflow-status';
import { usePanelT } from '../lib/use-panel-t';
import { emptyThreadRuntime } from '../store/helpers/thread-runtime';
import { getPanelGoals, getPanelReports, isWorkflowHistory } from '../lib/workflow-panel-data';
import { switchBranch } from '../lib/git';

function statusLabel(status, t) {
  const key = STATUS_LABELS[String(status || '').toLowerCase()];
  return key ? t(key) : String(status || '');
}

function Dot({ status }) {
  return <span className={`workflow-panel__dot is-${String(status || 'idle').toLowerCase()}`} aria-hidden="true" />;
}

// ===== 1. Git 工具（M1：错误分层 + 提交事务分步 + 部分失败中间态）=====
const MAX_COMMIT_MESSAGE_LENGTH = 4096;

// Windows 路径比较不区分大小写（与 projects-runtime.js 先例一致）
function normalizeCwdKey(value) {
  if (typeof value !== 'string') return value;
  // 渲染进程没有 process：用 userAgent / path 分隔符推断 Windows
  const isWin =
    (typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent || '')) ||
    (typeof value === 'string' && /^[A-Za-z]:[/\\]/.test(value));
  return isWin ? value.toLowerCase() : value;
}
const compareCwdInsensitive = (a, b) => normalizeCwdKey(a) === normalizeCwdKey(b);

const ERROR_ICONS = {
  notrepo: 'M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z',
  perm: 'M4 4a4 4 0 0 1 8 0v2h.25c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 12.25 15h-8.5A1.75 1.75 0 0 1 2 13.25v-5.5C2 6.784 2.784 6 3.75 6H4Zm8.25 3.5h-8.5a.25.25 0 0 0-.25.25v5.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25ZM10 4a2 2 0 1 0-4 0v2h4Z',
  timeout: 'M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0Zm.75 3.75a.75.75 0 0 0-1.5 0v5a.75.75 0 0 0 .47.697l3 1.25a.75.75 0 0 0 .56-1.392L8.75 8.296Z',
  big: 'M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z',
  other: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm9 3a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm-.25-6.25a.75.75 0 0 0-1.5 0v3.5a.75.75 0 0 0 1.5 0Z',
};

function GitIcon({ name }) {
  const paths = {
    changes:
      'M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.906 1.627L11.75 5.427V2h2.156a.25.25 0 0 1 .177.073ZM4.72 7.22a.75.75 0 0 1 1.06 0l.97.97.97-.97a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734l-1.25 1.25a.75.75 0 0 1-1.06 0L4.72 8.28a.75.75 0 0 1 0-1.06Zm0 4.56a.75.75 0 0 1 1.06 0l.97.97.97-.97a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734l-1.25 1.25a.75.75 0 0 1-1.06 0l-1.25-1.25a.75.75 0 0 1 0-1.06Z',
    branch:
      'M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z',
    commit:
      'M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z',
  };
  return (
    <svg className="workflow-panel__git-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d={paths[name] || paths.commit} />
    </svg>
  );
}

export function GitToolSection() {
  const t = usePanelT();
  const [gitState, setGitState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [commitMessage, setCommitMessage] = useState('');
  const [composerOpen, setComposerOpen] = useState(false);
  const [commitPhase, setCommitPhase] = useState(COMMIT_PHASES.IDLE);
  const [pushError, setPushError] = useState('');
  const [committedMessage, setCommittedMessage] = useState('');
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [branches, setBranches] = useState([]);
  const [branchSwitching, setBranchSwitching] = useState('');
  const requestIdRef = useRef(0);
  const signalRef = useRef({ aborted: false });
  const commitInputRef = useRef(null);

  const busy =
    commitPhase === COMMIT_PHASES.ADDING ||
    commitPhase === COMMIT_PHASES.COMMITTING ||
    commitPhase === COMMIT_PHASES.PUSHING;

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError('');
    try {
      const [branchRaw, workRaw, cachedRaw, statusRaw, branchListRaw] = await Promise.all([
        runGit(['branch', '--show-current']),
        runGit(['diff', '--numstat']),
        runGit(['diff', '--cached', '--numstat']),
        runGit(['status', '-sb']).catch(() => ''),
        runGit(['branch', '--list', '--format=%(refname:short)']).catch(() => ''),
      ]);
      if (requestId !== requestIdRef.current) return;
      let added = 0;
      let deleted = 0;
      for (const out of [workRaw, cachedRaw]) {
        for (const line of String(out || '').split('\n')) {
          const match = line.match(/^(\d+|-)\s+(\d+|-)\s/);
          if (!match) continue;
          if (match[1] !== '-') added += Number(match[1]);
          if (match[2] !== '-') deleted += Number(match[2]);
        }
      }
      // 修复 behind-only：`[behind N]`（无 ahead）与 `[ahead N, behind M]` 均需识别
      const firstLine = String(statusRaw || '').split('\n')[0] || '';
      const aheadMatch = firstLine.match(/\[ahead (\d+)/);
      const behindMatch = firstLine.match(/behind (\d+)\]/);
      const ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
      const behind = behindMatch ? Number(behindMatch[1]) : 0;
      const currentBranch = String(branchRaw || '').trim();
      setGitState({
        branch: currentBranch,
        added,
        deleted,
        ahead,
        behind,
      });
      setBranches(
        String(branchListRaw || '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .filter((name) => name !== currentBranch),
      );
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err?.message || t('workflow.gitError.other.title'));
      setGitState(null);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [t]);

  const openChanges = () => {
    // 右侧栏 diff 面板内嵌 ReplicaChangesView，而不是全屏路由切换
    useStore.getState().toggleRightPanel?.('diff');
  };

  const switchToBranch = async (name) => {
    if (branchSwitching || !name || name === gitState?.branch) return;
    setBranchSwitching(name);
    setError('');
    try {
      await switchBranch(name);
      setBranchMenuOpen(false);
      await refresh();
    } catch (err) {
      setError(err?.message || t('workflow.gitError.other.title'));
    } finally {
      setBranchSwitching('');
    }
  };

  useEffect(() => {
    refresh();
    return () => {
      // 卸载守卫：面板关闭/组件卸载时终止进行中的事务与过期请求
      requestIdRef.current += 1;
      signalRef.current.aborted = true;
    };
  }, [refresh]);

  useEffect(() => {
    if (!composerOpen) return undefined;
    const id = requestAnimationFrame(() => commitInputRef.current?.focus?.());
    return () => cancelAnimationFrame(id);
  }, [composerOpen]);

  const resetCommit = () => {
    setCommitPhase(COMMIT_PHASES.IDLE);
    setPushError('');
    setCommittedMessage('');
  };

  const runAdd = useCallback((cwd) => runGit(['add', '-A'], cwd), []);
  const runCommit = useCallback((cwd, message) => runGit(['commit', '-m', message], cwd), []);
  const runPush = useCallback((cwd) => runGit(['push'], cwd), []);
  const currentWorkspaceKey = useCallback(() => normalizeCwdKey(useStore.getState().workspacePath || null), []);

  const commitAndPush = async () => {
    const message = commitMessage.trim();
    if (!message || busy) return;
    const snapshotCwd = useStore.getState().workspacePath || null;
    if (!snapshotCwd) {
      setError(t('workflow.git.noWorkspace'));
      return;
    }
    setError('');
    const result = await executeCommitTransaction({
      snapshotCwd,
      message,
      getCurrentCwd: currentWorkspaceKey,
      compareCwd: compareCwdInsensitive,
      onPhase: setCommitPhase,
      runAdd,
      runCommit,
      runPush,
      signal: signalRef.current,
    });
    if (result.status === RESULT.SUCCESS) {
      resetCommit();
      setCommitMessage('');
      setComposerOpen(false);
      useStore.getState().pushToast?.({ type: 'success', message: t('workflow.git.committed') });
      await refresh();
    } else if (result.status === RESULT.COMMITTED_PUSH_FAILED) {
      setCommitPhase(COMMIT_PHASES.COMMITTED_PUSH_FAILED);
      setPushError(result.error?.message || t('workflow.git.pushFailed'));
      setCommittedMessage(message);
      setCommitMessage('');
      setComposerOpen(false);
      useStore.getState().pushToast?.({ type: 'error', message: t('workflow.git.pushFailedToast') });
    } else if (result.status === RESULT.PROJECT_SWITCHED) {
      resetCommit();
      setError(t('workflow.git.projectSwitched'));
    } else if (result.status !== RESULT.ABORTED) {
      resetCommit();
      setError(result.error?.message || t('workflow.git.commitFailed'));
      useStore.getState().pushToast?.({ type: 'error', message: t('workflow.git.commitFailed') });
    }
  };

  const retryPush = async () => {
    if (busy) return;
    const snapshotCwd = useStore.getState().workspacePath || null;
    if (!snapshotCwd) {
      setError(t('workflow.git.noWorkspace'));
      return;
    }
    const result = await retryPushAfterCommitted({
      snapshotCwd,
      getCurrentCwd: currentWorkspaceKey,
      compareCwd: compareCwdInsensitive,
      onPhase: setCommitPhase,
      runPush,
      signal: signalRef.current,
    });
    if (result.status === RESULT.SUCCESS) {
      resetCommit();
      useStore.getState().pushToast?.({ type: 'success', message: t('workflow.git.repushed') });
      await refresh();
    } else if (result.status === RESULT.COMMITTED_PUSH_FAILED) {
      setCommitPhase(COMMIT_PHASES.COMMITTED_PUSH_FAILED);
      setPushError(result.error?.message || t('workflow.git.pushFailed'));
    } else if (result.status === RESULT.PROJECT_SWITCHED) {
      resetCommit();
      setError(t('workflow.git.retrySwitched'));
    }
  };

  const openComposer = () => {
    if (busy) return;
    setComposerOpen(true);
  };

  const classified = error ? classifyGitError(error, t) : null;
  const phaseLabel = PHASE_LABELS[commitPhase];
  const showComposer = composerOpen || busy || Boolean(commitMessage.trim());

  return (
    <section className="workflow-panel__section" data-testid="workflow-git-tools">
      <div className="workflow-panel__section-title">
        <span>{t('workflow.git.title')}</span>
        <button
          type="button"
          className="workflow-panel__refresh"
          onClick={refresh}
          disabled={loading || busy}
          title={t('workflow.git.refresh')}
          aria-label={t('workflow.git.refresh')}
        >
          {loading ? t('workflow.git.refreshing') : t('workflow.git.refresh')}
        </button>
      </div>
      {loading && !gitState && !error ? (
        <div className="workflow-panel__muted">{t('workflow.git.loading')}</div>
      ) : gitState ? (
        <>
          <div className="workflow-panel__git-list">
            <button
              type="button"
              className="workflow-panel__git-row is-changes is-action"
              data-testid="workflow-git-changes"
              onClick={openChanges}
              title={t('workflow.git.changes')}
            >
              <GitIcon name="changes" />
              <span className="workflow-panel__git-row-label">{t('workflow.git.changes')}</span>
              <span className="workflow-panel__git-row-meta">
                <b className="workflow-panel__added">+{gitState.added}</b>{' '}
                <b className="workflow-panel__deleted">-{gitState.deleted}</b>
              </span>
            </button>

            <button
              type="button"
              className="workflow-panel__git-row is-action is-branch"
              data-testid="workflow-git-branch"
              title={t('workflow.git.branch', { name: gitState.branch || t('workflow.git.noBranch') })}
              aria-expanded={branchMenuOpen}
              onClick={() => setBranchMenuOpen((open) => !open)}
            >
              <GitIcon name="branch" />
              <span className="workflow-panel__git-row-label">
                {gitState.branch || t('workflow.git.noBranch')}
              </span>
              {gitState.ahead > 0 || gitState.behind > 0 ? (
                <span className="workflow-panel__git-ahead">
                  {gitState.ahead > 0 ? t('workflow.git.ahead', { n: gitState.ahead }) : ''}
                  {gitState.behind > 0 ? ` ${t('workflow.git.behind', { n: gitState.behind })}` : ''}
                </span>
              ) : null}
              <span className="workflow-panel__git-chevron" aria-hidden="true">▾</span>
            </button>

            {branchMenuOpen ? (
              <div className="workflow-panel__git-branch-menu" data-testid="workflow-git-branch-menu" role="listbox">
                {branches.length === 0 ? (
                  <div className="workflow-panel__git-branch-empty">{t('workflow.git.noBranch')}</div>
                ) : (
                  branches.map((name) => (
                    <button
                      key={name}
                      type="button"
                      role="option"
                      className="workflow-panel__git-branch-item"
                      disabled={Boolean(branchSwitching)}
                      onClick={() => switchToBranch(name)}
                    >
                      {branchSwitching === name ? (
                        <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-[var(--color-border-default)] border-t-[var(--color-text-primary)]" />
                      ) : null}
                      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{name}</span>
                    </button>
                  ))
                )}
              </div>
            ) : null}

            {commitPhase === COMMIT_PHASES.COMMITTED_PUSH_FAILED ? (
              <>
                <div className="workflow-panel__banner is-ok" role="status">
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16Zm3.78-9.72a.751.751 0 0 0-1.042-.018L6.75 9.19 5.28 7.72a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042l2 2a.75.75 0 0 0 1.06 0l4.5-4.5a.75.75 0 0 0 0-1.06Z"/></svg>
                  <span>
                    <b>{t('workflow.git.committedOk')}</b>
                    <br />
                    {committedMessage || t('workflow.git.committedRef')}
                  </span>
                </div>
                <div className="workflow-panel__banner is-bad" role="alert">
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16ZM5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94Z"/></svg>
                  <span>
                    <b>{t('workflow.git.pushFailed')}</b>
                    <br />
                    {pushError || t('workflow.git.pushFailed')}。{t('workflow.git.pushRetryHint')}
                  </span>
                </div>
                <button
                  type="button"
                  className="workflow-panel__git-row is-action"
                  onClick={retryPush}
                  disabled={busy}
                >
                  <GitIcon name="commit" />
                  <span className="workflow-panel__git-row-label">
                    {phaseLabel ? t(phaseLabel.button) : t('workflow.git.retryPush')}
                  </span>
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="workflow-panel__git-row is-action"
                  onClick={openComposer}
                  disabled={busy}
                  data-testid="workflow-git-commit-action"
                >
                  <GitIcon name="commit" />
                  <span className="workflow-panel__git-row-label">
                    {phaseLabel ? t(phaseLabel.button) : t('workflow.git.commitOrPush')}
                  </span>
                </button>
                {showComposer ? (
                  <div className="workflow-panel__git-composer">
                    <input
                      ref={commitInputRef}
                      className="workflow-panel__git-input"
                      value={commitMessage}
                      onChange={(event) => setCommitMessage(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && event.nativeEvent.isComposing === false) commitAndPush();
                        if (event.key === 'Escape') {
                          setComposerOpen(false);
                          setCommitMessage('');
                        }
                      }}
                      placeholder={t('workflow.git.commitPlaceholder')}
                      aria-label={t('workflow.git.commitPlaceholder')}
                      maxLength={MAX_COMMIT_MESSAGE_LENGTH}
                      disabled={busy}
                    />
                    <button
                      type="button"
                      className="workflow-panel__git-commit"
                      onClick={commitAndPush}
                      disabled={busy || !commitMessage.trim()}
                    >
                      {phaseLabel ? t(phaseLabel.button) : t('workflow.git.commitPush')}
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </div>
          {busy && phaseLabel ? <div className="workflow-panel__commit-step">{t(phaseLabel.hint)}</div> : null}
        </>
      ) : null}
      {classified ? (
        <div className="workflow-panel__git-error" data-testid="workflow-git-error">
          <div className="workflow-panel__git-error-title">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d={ERROR_ICONS[classified.kind] || ERROR_ICONS.other} />
            </svg>
            {classified.title}
          </div>
          <div className="workflow-panel__git-error-body">{classified.body}</div>
          <button
            type="button"
            className="workflow-panel__refresh-link"
            onClick={refresh}
            disabled={loading}
            aria-label={t('workflow.git.refresh')}
          >
            {t('workflow.git.refresh')}
          </button>
        </div>
      ) : null}
    </section>
  );
}

export const GoalsSection = memo(function GoalsSection({ goals, history = false }) {
  const t = usePanelT();
  const ordered = useMemo(() => {
    const list = Array.isArray(goals) ? goals : [];
    return [...list].sort((a, b) => (a.sequence ?? a.updatedAt ?? 0) - (b.sequence ?? b.updatedAt ?? 0));
  }, [goals]);
  if (!ordered.length) return null;
  const completedCount = ordered.filter((goal) => goal.status === 'completed').length;
  return (
    <section className="workflow-panel__section" data-testid="workflow-goals">
      <div className="workflow-panel__section-title">
        <span>{t('workflow.goals.title')}</span>
        {history ? <span className="workflow-panel__history-badge">{t('workflow.history.badge')}</span> : null}
        <span className="workflow-panel__count">
          {completedCount}/{ordered.length}
        </span>
      </div>
      {history ? (
        <div className="workflow-panel__history-note">{t('workflow.history.goalsNote')}</div>
      ) : null}
      <ul className="workflow-panel__goal-list">
        {ordered.map((goal, index) => (
          // M4-D：key 稳定化——goal 用 sequence/eventKey（结构变化才换 key），
          // 避免 goalId||index 在同名/同 id 目标上重建行
          <li
            key={goal.sequence != null ? `goal-seq-${goal.sequence}` : (goal.eventKey ?? goal.goalId ?? `goal-${index}`)}
            className="workflow-panel__goal"
          >
            <span className="workflow-panel__goal-badge">{index + 1}</span>
            <span className="workflow-panel__goal-title" title={goal.title}>
              {goal.title}
            </span>
            <span className="workflow-panel__goal-progress">
              {goal.progress?.current != null && goal.progress?.total != null
                ? `${goal.progress.current}/${goal.progress.total}`
                : goal.progress?.percent != null
                  ? `${Math.round(goal.progress.percent)}%`
                  : ''}
            </span>
            <Dot status={goal.status} />
            <span className="sr-only">{statusLabel(goal.status, t)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
});

// ===== 3. 任务（有任务才展示；M3 memo）=====
export const TasksSection = memo(function TasksSection({ steps }) {
  const t = usePanelT();
  const tasks = useMemo(() => (Array.isArray(steps) ? steps.filter((step) => step.kind === 'task') : []), [steps]);
  if (!tasks.length) return null;
  const completedCount = tasks.filter((task) => task.status === 'completed').length;
  return (
    <section className="workflow-panel__section" data-testid="workflow-tasks">
      <div className="workflow-panel__section-title">
        <span>{t('workflow.tasks.title')}</span>
        <span className="workflow-panel__count">
          {completedCount}/{tasks.length}
        </span>
      </div>
      <ul className="workflow-panel__task-list">
        {tasks.map((task) => (
          <li key={task.id || task.name} className="workflow-panel__task">
            <Dot status={task.status} />
            <span className="workflow-panel__task-title" title={task.task || task.name}>
              {task.name || task.task || t('workflow.tasks.title')}
            </span>
            <span className="sr-only">{statusLabel(task.status, t)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
});

// ===== 4. 子代理列表：收起态一行「在干什么」，点击展开工作内容 =====
function oneLine(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pathBaseName(path) {
  return String(path || '').split(/[/\\]/).pop() || path;
}

function SubagentRow({ report, history = false }) {
  const t = usePanelT();
  const [open, setOpen] = useState(false);
  const activity = oneLine(report.summary || report.description);
  // M2：终态回退的「在干什么」加「任务：」前缀，与实时活动文案区分
  const displayActivity = history && activity ? `${t('workflow.subagents.historyPrefix')}${activity}` : activity;
  const pathList = report.pathList;
  const preview = Array.isArray(pathList?.preview) ? pathList.preview : [];
  // M4-D：path 去重（同名路径重复导致 key 冲突警告）
  const previewUnique = useMemo(() => [...new Set(preview)], [preview]);
  const previewCount = previewUnique.length;
  return (
    <li className="workflow-panel__subagent">
      <button
        type="button"
        className="workflow-panel__subagent-head"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <Dot status={report.status} />
        <span className="workflow-panel__subagent-name">{report.name || t('workflow.subagents.title')}</span>
        <span className="workflow-panel__subagent-activity" title={displayActivity}>
          {displayActivity || statusLabel(report.status, t)}
        </span>
        <span className="workflow-panel__subagent-status">{statusLabel(report.status, t)}</span>
        <span className="workflow-panel__subagent-chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open ? (
        <div className="workflow-panel__subagent-body">
          {report.description ? (
            <div className="workflow-panel__subagent-desc">{report.description}</div>
          ) : null}
          {report.conclusionKind === 'path_list' && pathList ? (
            <div className="workflow-panel__subagent-pathlist" data-testid="subagent-path-list">
              <div className="workflow-panel__muted">
                {pathList.count != null ? t('workflow.subagents.pathCount', { n: pathList.count }) : t('workflow.subagents.paths')}
              </div>
              {previewCount ? (
                <ul className="workflow-panel__path-items">
                  {previewUnique.map((path) => (
                    <li key={path} className="workflow-panel__path-item" title={path}>
                      {pathBaseName(path)}
                    </li>
                  ))}
                </ul>
              ) : null}
              {pathList.count != null && pathList.count > previewCount ? (
                <div className="workflow-panel__muted">{t('workflow.subagents.more', { n: pathList.count - previewCount })}</div>
              ) : null}
            </div>
          ) : report.conclusion ? (
            <div className="workflow-panel__subagent-conclusion">{report.conclusion}</div>
          ) : null}
          <div className="workflow-panel__subagent-meta">
            {report.toolCallCount > 0
              ? t('workflow.subagents.toolCalls', { n: report.toolCallCount })
              : t('workflow.subagents.noToolCalls')}
          </div>
        </div>
      ) : null}
    </li>
  );
}

// ===== 4. 子代理列表：收起态一行「在干什么」，点击展开工作内容（M3 memo）=====
export const SubagentsSection = memo(function SubagentsSection({ reports, history = false }) {
  const t = usePanelT();
  const list = Array.isArray(reports) ? reports : [];
  return (
    <section className="workflow-panel__section" data-testid="workflow-subagents">
      <div className="workflow-panel__section-title">
        <span>{t('workflow.subagents.title')}</span>
        {history ? <span className="workflow-panel__history-badge">{t('workflow.history.badge')}</span> : null}
        {list.length ? <span className="workflow-panel__count">{list.length}</span> : null}
      </div>
      {list.length ? (
        <ul className="workflow-panel__subagent-list">
          {list.map((report, index) => (
            // M4-D：key 稳定化——同名子代理用 identity+index 区分
            <SubagentRow key={report.id || `${report.name || 'agent'}-${index}`} report={report} history={history} />
          ))}
        </ul>
      ) : (
        <div className="workflow-panel__muted">{t('workflow.subagents.empty')}</div>
      )}
    </section>
  );
});

// ===== 面板主体：Git 工具 + 目标 + 任务 + 子代理 =====
// M3 性能：字段级订阅（useShallow）——流式纯 chunk 期间面板不随 chunk 重渲染，
// 仅结构事件（goalState/subagentReports/timeline 结构变化）触发重算。
// 注意：memberHistoriesByName 是 chunk 粒度字段（每次流式 chunk 都更新），
// 其消费方只有已废弃的 WorkflowStatusPanel（detailsAvailable/historyAvailable），
// 悬浮面板不使用——因此不订阅，避免每次 chunk 触发面板重渲染。
export function WorkflowFloatingPanelBody({ threadId }) {
  const runtimeFields = useStore(
    useShallow((state) => {
      const runtime = threadId ? state.threadRuntimeById[threadId] : null;
      return {
        activePromptRunId: runtime?.activePromptRunId ?? null,
        agentPhase: runtime?.agentPhase ?? null,
        completedAt: runtime?.completedAt ?? null,
        goalState: runtime?.goalState ?? null,
        historyReplayActive: runtime?.historyReplayActive ?? null,
        isAwaitingResponse: runtime?.isAwaitingResponse ?? null,
        lastGoalState: runtime?.lastGoalState ?? null,
        lastSubagentReports: runtime?.lastSubagentReports ?? null,
        lastTeamState: runtime?.lastTeamState ?? null,
        lastWorkflowState: runtime?.lastWorkflowState ?? null,
        permissionRequests: runtime?.permissionRequests ?? null,
        progress: runtime?.progress ?? null,
        promptStartedAt: runtime?.promptStartedAt ?? null,
        questions: runtime?.questions ?? null,
        subagentReports: runtime?.subagentReports ?? null,
        teamState: runtime?.teamState ?? null,
        timeline: runtime?.timeline ?? null,
        workflowState: runtime?.workflowState ?? null,
      };
    }),
  );
  const threadStatus = useStore((state) => (threadId ? state.threadsById[threadId]?.status : 'idle'));
  const history = isWorkflowHistory(runtimeFields);
  const goals = useMemo(() => getPanelGoals(runtimeFields), [runtimeFields.goalState, runtimeFields.lastGoalState]);
  const workflow = useMemo(() => {
    const runtime = { ...emptyThreadRuntime(), ...runtimeFields };
    return normalizeWorkflowStatus({
      runtime,
      threadStatus,
      timeline: runtimeFields.timeline || [],
    });
  }, [runtimeFields, threadStatus]);
  const reports = useMemo(
    () => getPanelReports(runtimeFields),
    [
      runtimeFields.subagentReports,
      runtimeFields.lastSubagentReports,
      runtimeFields.workflowState,
      runtimeFields.lastWorkflowState,
    ],
  );
  return (
    <div className="workflow-panel" data-testid="workflow-right-panel">
      <GitToolSection />
      <GoalsSection goals={goals} history={history} />
      <TasksSection steps={workflow.steps} />
      <SubagentsSection reports={reports} history={history} />
    </div>
  );
}
