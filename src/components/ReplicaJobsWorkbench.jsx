// G4: 后台智能体工作台（WebUI /api/v1/jobs 工作流：派发 + 列表 + 停止/重启/重命名/删除/记录）。
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { resolveLocaleMode, translate } from '../lib/i18n';
import {
  listJobs,
  createJob,
  renameJob,
  stopJob,
  respawnJob,
  deleteJob,
  fetchJobTranscript,
  buildJobDispatchPayload,
  normalizeJobStatus,
  parseJobPrompt,
  JOB_PERMISSION_MODES,
} from '../lib/jobs-api';
import { formatHistoryRelativeTime } from '../lib/session-history';

const STATUS_STYLES = {
  running: 'bg-[var(--color-accent-green)]',
  pending: 'bg-[var(--color-accent-yellow)]',
  completed: 'bg-[var(--color-accent-blue)]',
  failed: 'bg-[var(--color-accent-red)]',
  stopped: 'bg-[var(--color-text-muted)]',
  unknown: 'bg-[var(--color-text-muted)]',
};

export default function ReplicaJobsWorkbench({ active }) {
  const localeMode = useStore((s) => s.guiSettings?.locale || 'system');
  const locale = resolveLocaleMode(localeMode);
  const t = useCallback((key, vars) => translate(locale, key, vars), [locale]);
  const workspacePath = useStore((s) => s.projectsById?.[s.activeProjectId]?.workspacePath || null);
  const activeSessionId = useStore((s) => s.threadsById?.[s.activeThreadId]?.sessionId || s.sessionId || null);

  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [prompt, setPrompt] = useState('');
  const [jobName, setJobName] = useState('');
  const [permissionMode, setPermissionMode] = useState('');
  const [worktree, setWorktree] = useState(false);
  const [startFrom, setStartFrom] = useState('blank');
  const [dispatchBusy, setDispatchBusy] = useState(false);
  const [dispatchError, setDispatchError] = useState('');
  const [actionBusyId, setActionBusyId] = useState(null);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [transcript, setTranscript] = useState(null);
  const requestRef = useRef(0);

  const refresh = useCallback(async ({ silent = false } = {}) => {
    const requestId = ++requestRef.current;
    if (!silent) {
      setLoading(true);
      setListError('');
    }
    try {
      const list = await listJobs({ cwd: workspacePath, all: !workspacePath });
      if (requestId !== requestRef.current) return;
      setJobs(list);
      setListError('');
    } catch (error) {
      if (requestId === requestRef.current) setListError(error?.message || String(error));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [workspacePath]);

  useEffect(() => {
    if (!active) return undefined;
    void refresh();
    const timer = setInterval(() => void refresh({ silent: true }), 10_000);
    return () => {
      requestRef.current += 1;
      clearInterval(timer);
    };
  }, [active, refresh]);

  const dispatch = useCallback(async () => {
    if (dispatchBusy) return;
    const payload = buildJobDispatchPayload({
      prompt,
      cwd: workspacePath,
      name: jobName,
      permissionMode,
      worktree,
      sourceSessionId: startFrom === 'continue' ? activeSessionId : null,
    });
    if (!payload) {
      setDispatchError(t('jobs.promptRequired'));
      return;
    }
    setDispatchBusy(true);
    setDispatchError('');
    try {
      await createJob(payload);
      setPrompt('');
      setJobName('');
      await refresh({ silent: true });
    } catch (error) {
      setDispatchError(error?.message || t('jobs.dispatchFailed'));
    } finally {
      setDispatchBusy(false);
    }
  }, [dispatchBusy, prompt, workspacePath, jobName, permissionMode, worktree, startFrom, activeSessionId, refresh, t]);

  const runJobAction = useCallback(
    async (jobId, action) => {
      if (actionBusyId) return;
      setActionBusyId(jobId);
      try {
        await action();
        await refresh({ silent: true });
      } catch (error) {
        setListError(error?.message || String(error));
      } finally {
        setActionBusyId(null);
      }
    },
    [actionBusyId, refresh],
  );

  const openTranscript = useCallback(
    async (job) => {
      try {
        const data = await fetchJobTranscript(job.id);
        setTranscript({ job, data });
      } catch (error) {
        setListError(error?.message || String(error));
      }
    },
    [],
  );

  const { isShell } = parseJobPrompt(prompt);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="page-content-wide space-y-4">
        <section className="surface-panel p-4" data-testid="jobs-dispatch">
          <h3 className="mb-2 text-sm font-medium text-[var(--color-text-primary)]">{t('jobs.dispatchTitle')}</h3>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={3}
            placeholder={t('jobs.promptPlaceholder')}
            className="w-full resize-none rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)]"
          />
          {isShell ? <div className="mt-1 text-xs text-[var(--color-accent-yellow)]">{t('jobs.shellHint')}</div> : null}
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
            <input
              value={jobName}
              onChange={(event) => setJobName(event.target.value)}
              placeholder={t('jobs.namePlaceholder')}
              className="w-40 rounded border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs text-[var(--color-text-primary)] outline-none"
            />
            {!isShell ? (
              <>
                <label className="flex items-center gap-1.5 text-[var(--color-text-secondary)]">
                  <span>{t('jobs.permissionMode')}</span>
                  <select
                    value={permissionMode}
                    onChange={(event) => setPermissionMode(event.target.value)}
                    className="rounded border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-1.5 py-1 text-xs text-[var(--color-text-primary)]"
                  >
                    <option value="">{t('jobs.permissionMode.default')}</option>
                    {JOB_PERMISSION_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {t(`jobs.mode.${mode}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-1.5 text-[var(--color-text-secondary)]">
                  <span>{t('jobs.startFrom')}</span>
                  <select
                    value={startFrom}
                    onChange={(event) => setStartFrom(event.target.value)}
                    className="rounded border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-1.5 py-1 text-xs text-[var(--color-text-primary)]"
                  >
                    <option value="blank">{t('jobs.startFrom.blank')}</option>
                    <option value="continue" disabled={!activeSessionId}>
                      {activeSessionId ? t('jobs.startFrom.continue') : t('jobs.startFrom.unavailable')}
                    </option>
                  </select>
                </label>
                <label className="flex cursor-pointer items-center gap-1.5 text-[var(--color-text-secondary)]">
                  <input type="checkbox" checked={worktree} onChange={(event) => setWorktree(event.target.checked)} />
                  <span>{t('jobs.worktree')}</span>
                </label>
              </>
            ) : null}
            <button
              type="button"
              className="btn-primary ml-auto px-3 py-1.5 text-xs disabled:opacity-50"
              disabled={dispatchBusy || !prompt.trim()}
              onClick={() => void dispatch()}
            >
              {dispatchBusy ? t('jobs.dispatching') : t('jobs.dispatch')}
            </button>
          </div>
          {dispatchError ? <div className="mt-2 text-xs text-[var(--color-accent-red)]">{dispatchError}</div> : null}
        </section>

        {listError ? (
          <div className="flex items-center justify-between rounded-md border border-[rgba(239,68,68,0.35)] bg-[rgba(239,68,68,0.08)] px-3 py-2 text-xs text-[var(--color-accent-red)]">
            <span>{listError}</span>
            <button className="btn-ghost px-2 py-1 text-xs" onClick={() => void refresh()}>
              {t('jobs.retry')}
            </button>
          </div>
        ) : null}

        {loading && jobs.length === 0 ? (
          <div className="py-8 text-center text-sm text-[var(--color-text-muted)]">{t('jobs.loading')}</div>
        ) : jobs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[var(--color-border-muted)] py-12 text-center text-sm text-[var(--color-text-muted)]">
            {t('jobs.empty')}
          </div>
        ) : (
          <div className="space-y-2">
            {jobs.map((job) => {
              const status = normalizeJobStatus(job);
              const isRenaming = renamingId === job.id;
              const busy = actionBusyId === job.id;
              return (
                <article key={job.id} className="surface-panel p-3">
                  <div className="flex items-center gap-3">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_STYLES[status] || STATUS_STYLES.unknown}`} />
                    <div className="min-w-0 flex-1">
                      {isRenaming ? (
                        <input
                          autoFocus
                          value={renameValue}
                          onChange={(event) => setRenameValue(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              const name = renameValue.trim();
                              setRenamingId(null);
                              if (name && name !== job.name) {
                                void runJobAction(job.id, () => renameJob(job.id, name));
                              }
                            }
                            if (event.key === 'Escape') setRenamingId(null);
                          }}
                          className="w-full rounded border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-2 py-1 text-sm text-[var(--color-text-primary)] outline-none"
                        />
                      ) : (
                        <>
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm text-[var(--color-text-primary)]">{job.name || job.id}</span>
                            <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
                              {t(`jobs.status.${status}`)}
                            </span>
                            {job.bash || job.kind === 'bash' ? (
                              <span className="shrink-0 rounded bg-[var(--color-bg-hover)] px-1 text-[10px] text-[var(--color-text-muted)]">shell</span>
                            ) : null}
                            {job.bgIsolation === 'worktree' || job.worktreePath ? (
                              <span className="shrink-0 rounded bg-[var(--color-bg-hover)] px-1 text-[10px] text-[var(--color-text-muted)]">worktree</span>
                            ) : null}
                          </div>
                          <div className="mt-0.5 flex items-center gap-2 truncate text-xs text-[var(--color-text-muted)]">
                            {job.updatedAt || job.createdAt ? (
                              <span>{formatHistoryRelativeTime(job.updatedAt || job.createdAt, locale)}</span>
                            ) : null}
                            {job.cwd ? <span className="truncate">{job.cwd}</span> : null}
                          </div>
                        </>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1 text-xs">
                      {status === 'running' || status === 'pending' ? (
                        <button className="btn-ghost px-2 py-1" disabled={busy} onClick={() => void runJobAction(job.id, () => stopJob(job.id))}>
                          {t('jobs.stop')}
                        </button>
                      ) : (
                        <button className="btn-ghost px-2 py-1" disabled={busy} onClick={() => void runJobAction(job.id, () => respawnJob(job.id))}>
                          {t('jobs.respawn')}
                        </button>
                      )}
                      <button className="btn-ghost px-2 py-1" disabled={busy} onClick={() => void openTranscript(job)}>
                        {t('jobs.transcript')}
                      </button>
                      <button
                        className="btn-ghost px-2 py-1"
                        disabled={busy}
                        onClick={() => {
                          setRenamingId(job.id);
                          setRenameValue(job.name || '');
                        }}
                      >
                        {t('jobs.rename')}
                      </button>
                      <button
                        className="btn-ghost px-2 py-1 text-[var(--color-accent-red)]"
                        disabled={busy}
                        onClick={() => void runJobAction(job.id, () => deleteJob(job.id))}
                      >
                        {t('jobs.delete')}
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      {transcript ? (
        <div className="fixed inset-0 z-[205] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30" onClick={() => setTranscript(null)} />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('jobs.transcript')}
            className="relative mx-4 flex max-h-[70vh] w-full max-w-[720px] flex-col overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-card)] shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-[var(--color-border-default)] px-4 py-3">
              <div className="truncate text-sm font-medium text-[var(--color-text-primary)]">
                {t('jobs.transcript')} · {transcript.job.name || transcript.job.id}
              </div>
              <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setTranscript(null)}>
                {t('jobs.close')}
              </button>
            </div>
            <pre className="flex-1 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[11px] text-[var(--color-text-secondary)]">
              {typeof transcript.data === 'string' ? transcript.data : JSON.stringify(transcript.data, null, 2)}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}
