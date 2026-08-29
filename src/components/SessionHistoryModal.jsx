// G9: 会话历史浏览器（对照 WebUI history 面板；Desktop 决策用 modal 而非右侧抽屉）。
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { History, RotateCcw, Pencil, Trash2, X } from 'lucide-react';
import { useStore } from '../store';
import { resolveLocaleMode, translate } from '../lib/i18n';
import { fetchResumableSessions, formatHistoryRelativeTime } from '../lib/session-history';
import { renameSession as apiRenameSession, deleteSession as apiDeleteSession } from '../lib/ops';

const PAGE_SIZE = 20;

function useUiTranslate() {
  const locale = useStore((s) => resolveLocaleMode(s.guiSettings?.locale || 'system'));
  return [useCallback((key, params) => translate(locale, key, params), [locale]), locale];
}

export default function SessionHistoryModal() {
  const [t, locale] = useUiTranslate();
  const open = useStore((s) => s.sessionHistoryOpen);
  const setOpen = useStore((s) => s.setSessionHistoryOpen);
  const workspacePath = useStore((s) => s.projectsById?.[s.activeProjectId]?.workspacePath || null);
  const activeSessionId = useStore((s) => s.threadsById?.[s.activeThreadId]?.sessionId || s.sessionId || null);
  const restoreHistorySession = useStore((s) => s.restoreHistorySession);
  const setRoute = useStore((s) => s.setRoute);

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [moreBusy, setMoreBusy] = useState(false);
  const [restoreBusyId, setRestoreBusyId] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleting, setDeleting] = useState(null);
  const [actionError, setActionError] = useState(null);
  const requestRef = useRef(0);
  const renameInputRef = useRef(null);

  const close = useCallback(() => setOpen(false), [setOpen]);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setLoadError(null);
    setActionError(null);
    try {
      const page = await fetchResumableSessions(workspacePath, { includeAttached: true, offset: 0, limit: PAGE_SIZE });
      if (requestId !== requestRef.current) return;
      setItems(page.candidates);
      setHasMore(page.hasMore);
      setOffset(page.nextOffset);
    } catch (error) {
      if (requestId === requestRef.current) setLoadError(error?.message || String(error));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [workspacePath]);

  const loadMore = useCallback(async () => {
    if (moreBusy || !hasMore) return;
    const requestId = requestRef.current;
    setMoreBusy(true);
    try {
      const page = await fetchResumableSessions(workspacePath, { includeAttached: true, offset, limit: PAGE_SIZE });
      if (requestId !== requestRef.current) return;
      setItems((current) => {
        const seen = new Set(current.map((item) => item.sessionId));
        return [...current, ...page.candidates.filter((item) => !seen.has(item.sessionId))];
      });
      setHasMore(page.hasMore);
      setOffset(page.nextOffset);
    } catch (error) {
      if (requestId === requestRef.current) setActionError(error?.message || String(error));
    } finally {
      if (requestId === requestRef.current) setMoreBusy(false);
    }
  }, [moreBusy, hasMore, workspacePath, offset]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (renaming) setRenaming(null);
      else if (deleting) setDeleting(null);
      else close();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, renaming, deleting, close]);

  const restore = useCallback(
    async (item) => {
      if (restoreBusyId) return;
      if (item.sessionId === activeSessionId) {
        close();
        return;
      }
      setRestoreBusyId(item.sessionId);
      setActionError(null);
      try {
        const ok = await restoreHistorySession(item.sessionId, item.label);
        if (ok) close();
        else setActionError(t('history.restoreFailed'));
      } catch (error) {
        setActionError(error?.message || t('history.restoreFailed'));
      } finally {
        setRestoreBusyId(null);
      }
    },
    [restoreBusyId, activeSessionId, restoreHistorySession, close, t],
  );

  const confirmRename = useCallback(async () => {
    if (!renaming) return;
    const name = renameValue.trim();
    if (!name) {
      setRenaming(null);
      return;
    }
    try {
      await apiRenameSession(renaming.sessionId, name);
      setItems((current) => current.map((item) => (item.sessionId === renaming.sessionId ? { ...item, label: name } : item)));
    } catch (error) {
      setActionError(error?.message || t('history.renameFailed'));
    } finally {
      setRenaming(null);
      setRenameValue('');
    }
  }, [renaming, renameValue, t]);

  const confirmDelete = useCallback(async () => {
    if (!deleting) return;
    if (deleting.sessionId === activeSessionId) {
      setActionError(t('history.cannotDeleteCurrent'));
      setDeleting(null);
      return;
    }
    try {
      await apiDeleteSession(deleting.sessionId, workspacePath);
      setItems((current) => current.filter((item) => item.sessionId !== deleting.sessionId));
    } catch (error) {
      setActionError(error?.message || t('history.deleteFailed'));
    } finally {
      setDeleting(null);
    }
  }, [deleting, activeSessionId, workspacePath, t]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[205] flex items-start justify-center pt-[10vh]" data-testid="session-history">
      <div className="absolute inset-0 bg-black/30" onClick={close} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('history.title')}
        className="relative mx-4 flex max-h-[70vh] w-full max-w-[640px] flex-col overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-card)] shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-border-default)] px-4 py-3">
          <History size={15} className="shrink-0 text-[var(--color-text-muted)]" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-[var(--color-text-primary)]">{t('history.title')}</div>
            <div className="truncate text-xs text-[var(--color-text-muted)]">
              {workspacePath ? `${t('history.project')}: ${workspacePath}` : t('history.noProjects')}
            </div>
          </div>
          <button
            type="button"
            className="rounded px-2 py-1 text-xs text-[var(--color-accent-blue)] hover:bg-[var(--color-bg-hover)]"
            onClick={() => {
              close();
              setRoute('instances');
            }}
          >
            {t('history.backgroundEntry')}
          </button>
          <button
            type="button"
            onClick={close}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
            aria-label={t('history.backToChat')}
          >
            <X size={14} />
          </button>
        </div>
        {actionError ? (
          <div className="border-b border-[var(--color-border-default)] bg-[var(--color-accent-red)]/10 px-4 py-2 text-xs text-[var(--color-accent-red)]">
            {actionError}
          </div>
        ) : null}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="px-4 py-8 text-center text-sm text-[var(--color-text-muted)]">{t('history.loading')}</div>
          ) : loadError ? (
            <div className="px-4 py-8 text-center text-sm">
              <div className="mb-2 text-[var(--color-accent-red)]">{t('history.loadError')}</div>
              <div className="mb-3 text-xs text-[var(--color-text-muted)]">{loadError}</div>
              <button
                type="button"
                className="rounded border border-[var(--color-border-default)] px-3 py-1 text-xs hover:bg-[var(--color-bg-hover)]"
                onClick={() => void load()}
              >
                {t('history.retry')}
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-[var(--color-text-muted)]">
              <div>{t('history.noData')}</div>
              <div className="mt-1 text-xs">{t('history.noDataHint')}</div>
            </div>
          ) : (
            <div className="divide-y divide-[var(--color-border-muted)]">
              {items.map((item) => {
                const isCurrent = item.sessionId === activeSessionId;
                const isRenaming = renaming?.sessionId === item.sessionId;
                return (
                  <div key={item.sessionId} className="group flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--color-bg-hover)]">
                    <div className="min-w-0 flex-1">
                      {isRenaming ? (
                        <input
                          ref={renameInputRef}
                          autoFocus
                          value={renameValue}
                          onChange={(event) => setRenameValue(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              void confirmRename();
                            }
                          }}
                          placeholder={t('history.renamePlaceholder')}
                          className="w-full rounded border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-2 py-1 text-sm text-[var(--color-text-primary)] outline-none"
                        />
                      ) : (
                        <>
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm text-[var(--color-text-primary)]">{item.label}</span>
                            {isCurrent ? (
                              <span className="shrink-0 rounded-full bg-[var(--color-accent-blue)]/15 px-1.5 py-0 text-[10px] font-medium text-[var(--color-accent-blue)]">
                                {t('history.current')}
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-0.5 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                            <span>{formatHistoryRelativeTime(item.updatedAt, locale)}</span>
                            {item.messageCount != null ? <span>{t('history.messages', { count: item.messageCount })}</span> : null}
                          </div>
                        </>
                      )}
                    </div>
                    {isRenaming ? (
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          className="rounded px-2 py-1 text-xs text-[var(--color-accent-blue)] hover:bg-[var(--color-bg-hover)]"
                          onClick={() => void confirmRename()}
                        >
                          {t('history.renameOk')}
                        </button>
                        <button
                          type="button"
                          className="rounded px-2 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"
                          onClick={() => setRenaming(null)}
                        >
                          {t('history.renameCancel')}
                        </button>
                      </div>
                    ) : (
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent-blue)] disabled:cursor-wait disabled:opacity-40"
                          disabled={Boolean(restoreBusyId)}
                          title={t('history.restore')}
                          aria-label={t('history.restore')}
                          onClick={() => void restore(item)}
                        >
                          <RotateCcw size={13} className={restoreBusyId === item.sessionId ? 'animate-spin' : undefined} />
                        </button>
                        <button
                          type="button"
                          className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
                          title={t('history.rename')}
                          aria-label={t('history.rename')}
                          onClick={() => {
                            setRenaming(item);
                            setRenameValue(item.label);
                          }}
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          type="button"
                          className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent-red)] disabled:cursor-not-allowed disabled:opacity-40"
                          disabled={isCurrent}
                          title={isCurrent ? t('history.cannotDeleteCurrent') : t('history.delete')}
                          aria-label={t('history.delete')}
                          onClick={() => setDeleting(item)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
              {hasMore ? (
                <div className="px-4 py-2 text-center">
                  <button
                    type="button"
                    className="rounded px-3 py-1 text-xs text-[var(--color-accent-blue)] hover:bg-[var(--color-bg-hover)] disabled:cursor-wait disabled:opacity-50"
                    disabled={moreBusy}
                    onClick={() => void loadMore()}
                  >
                    {moreBusy ? t('history.loading') : t('history.loadMore')}
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </div>
        {deleting ? (
          <div className="border-t border-[var(--color-border-default)] px-4 py-3">
            <div className="mb-2 text-sm text-[var(--color-text-primary)]">{t('history.deleteConfirm')}</div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded px-3 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"
                onClick={() => setDeleting(null)}
              >
                {t('history.deleteCancel')}
              </button>
              <button
                type="button"
                className="rounded bg-[var(--color-accent-red)] px-3 py-1 text-xs font-medium text-white"
                onClick={() => void confirmDelete()}
              >
                {t('history.deleteOk')}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
