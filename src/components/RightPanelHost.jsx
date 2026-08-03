import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { usePanelTransition } from './usePanelTransition';
import { resolveLocaleMode, translate } from '../lib/i18n';
import SurfacePicker from './SurfacePicker';

const ReplicaTerminalView = lazy(() => import('./ReplicaTerminalView'));
const ReplicaChangesView = lazy(() => import('./ReplicaChangesView'));

const RIGHT_PANEL_TYPES = new Set(['surfaces', 'files', 'browser', 'terminal', 'diff']);

function safeBrowserUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 4096) return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return '';
    return parsed.toString();
  } catch (_) {
    return '';
  }
}

export function PanelHeader({ title, onClose, onBack = null }) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-border-default)] px-3">
      {onBack ? (
        <button
          type="button"
          className="rounded px-2 py-1 text-xs text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
          onClick={onBack}
          aria-label="返回工作面选择"
          title="返回"
          data-testid="right-panel-back"
        >
          ←
        </button>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--color-text-primary)]">{title}</span>
      <button
        type="button"
        className="rounded px-2 py-1 text-xs text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
        onClick={onClose}
        aria-label="关闭右侧面板"
        title="关闭"
      >
        ✕
      </button>
    </div>
  );
}

function FilePanel({ onClose, onBack, t }) {
  const fileCwd = useStore((s) => s.fileCwd);
  const fileEntries = useStore((s) => s.fileEntries);
  const fileLoading = useStore((s) => s.fileLoading);
  const fileLoadError = useStore((s) => s.fileLoadError);
  const openDirectory = useStore((s) => s.openDirectory);
  const openFile = useStore((s) => s.openFile);
  const setRoute = useStore((s) => s.setRoute);
  const [query, setQuery] = useState('');

  const visibleEntries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return fileEntries || [];
    return (fileEntries || []).filter((entry) => String(entry?.name || entry?.path || '').toLowerCase().includes(needle));
  }, [fileEntries, query]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title={t('topbar.surface.files')} onClose={onClose} onBack={onBack} />
      <div className="border-b border-[var(--color-border-default)] p-3">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索当前目录"
          aria-label="搜索当前目录"
          className="input-field w-full text-xs"
        />
        <div className="mt-2 truncate text-[11px] text-[var(--color-text-muted)]" title={fileCwd || '.'}>
          {fileCwd || '.'}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {fileLoading ? <div className="p-3 text-xs text-[var(--color-text-muted)]">加载文件中...</div> : null}
        {fileLoadError ? <div className="p-3 text-xs text-[var(--color-accent-red)]">{fileLoadError}</div> : null}
        {!fileLoading && !fileLoadError && visibleEntries.length === 0 ? (
          <div className="p-3 text-xs text-[var(--color-text-muted)]">当前目录为空</div>
        ) : null}
        {visibleEntries.map((entry) => {
          const isDirectory = entry?.type === 'directory' || entry?.type === 'dir' || entry?.is_dir;
          const path = entry?.path || entry?.name || '';
          return (
            <button
              key={path}
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
              onClick={async () => {
                if (isDirectory) await openDirectory(path);
                else await openFile(path);
              }}
              title={path}
            >
              <span aria-hidden="true">{isDirectory ? '📁' : '📄'}</span>
              <span className="min-w-0 flex-1 truncate">{entry?.name || path}</span>
            </button>
          );
        })}
      </div>
      <div className="border-t border-[var(--color-border-default)] p-3">
        <button type="button" className="btn-ghost w-full px-3 py-1.5 text-xs" onClick={() => setRoute('editor')}>
          在工作区编辑
        </button>
      </div>
    </div>
  );
}

function BrowserPanel({ payload, panelPhase, onClose, onBack, t }) {
  const initialUrl = safeBrowserUrl(payload?.url);
  const [address, setAddress] = useState(initialUrl);
  const [url, setUrl] = useState(initialUrl);
  const browserSurfaceRef = useRef(null);
  const openBrowser = window.electronAPI?.rightBrowserOpen;
  const setBrowserBounds = window.electronAPI?.rightBrowserSetBounds;

  useEffect(() => {
    const next = safeBrowserUrl(payload?.url);
    if (next) {
      setAddress(next);
      setUrl(next);
    }
  }, [payload?.url]);

  useEffect(() => {
    if (!openBrowser) return undefined;
    const unsubscribe = window.electronAPI?.onRightBrowserState?.((state) => {
      const nextUrl = safeBrowserUrl(state?.url);
      if (nextUrl) {
        setAddress(nextUrl);
        setUrl(nextUrl);
      }
    });
    return () => unsubscribe?.();
  }, [openBrowser]);

  useEffect(() => {
    if (!openBrowser) return undefined;
    let frame = 0;
    const sync = () => {
      const rect = browserSurfaceRef.current?.getBoundingClientRect();
      if (rect && setBrowserBounds) {
        setBrowserBounds({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
      }
      if (panelPhase !== 'closed') frame = requestAnimationFrame(sync);
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(sync) : null;
    if (observer && browserSurfaceRef.current) observer.observe(browserSurfaceRef.current);
    window.addEventListener('resize', sync);
    sync();
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', sync);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [openBrowser, panelPhase, setBrowserBounds, url]);

  useEffect(() => {
    if (!openBrowser || !url) {
      window.electronAPI?.rightBrowserClose?.();
      return undefined;
    }
    openBrowser(url).catch(() => {});
    return () => window.electronAPI?.rightBrowserClose?.();
  }, [openBrowser, url]);

  const navigate = (event) => {
    event.preventDefault();
    const next = safeBrowserUrl(address);
    if (next) setUrl(next);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title={t('topbar.surface.browser')} onClose={onClose} onBack={onBack} />
      <form className="flex gap-2 border-b border-[var(--color-border-default)] p-2" onSubmit={navigate}>
        <input
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          placeholder="输入 http(s) 地址"
          aria-label="浏览器地址"
          className="input-field min-w-0 flex-1 text-xs"
        />
        <button type="submit" className="btn-primary px-2 text-xs">
          打开
        </button>
      </form>
      {url ? (
        <div ref={browserSurfaceRef} className="min-h-0 flex-1 bg-white" data-testid="right-browser-surface" />
      ) : (
        <div
          ref={browserSurfaceRef}
          className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-xs text-[var(--color-text-muted)]"
          data-testid="right-browser-surface"
        >
          点击 AI 回复中的链接，或输入 http(s) 地址打开页面
        </div>
      )}
    </div>
  );
}

function EmbeddedSurfacePanel({ title, onClose, onBack, children }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="right-embedded-surface">
      <PanelHeader title={title} onClose={onClose} onBack={onBack} />
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

function panelTitle(type, t) {
  if (type === 'surfaces') return t('topbar.surfacesTitle');
  if (type === 'files') return t('topbar.surface.files');
  if (type === 'browser') return t('topbar.surface.browser');
  if (type === 'terminal') return t('topbar.surface.terminal');
  if (type === 'diff') return t('topbar.surface.diff');
  return t('topbar.surfaces');
}

export default function RightPanelHost() {
  const rightPanel = useStore((s) => s.rightPanel);
  const closeRightPanel = useStore((s) => s.closeRightPanel);
  const openRightPanel = useStore((s) => s.openRightPanel);
  const localeMode = useStore((s) => s.guiSettings?.locale || 'system');
  const t = (key, vars) => translate(resolveLocaleMode(localeMode), key, vars);
  const transitioned = usePanelTransition(rightPanel);

  useEffect(() => {
    if (!transitioned.value || !RIGHT_PANEL_TYPES.has(transitioned.value.type)) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        // From a concrete surface, Esc returns to chooser; from chooser, closes panel.
        if (transitioned.value?.type && transitioned.value.type !== 'surfaces') {
          openRightPanel('surfaces');
        } else {
          closeRightPanel();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeRightPanel, openRightPanel, transitioned.value]);

  if (!transitioned.value) return null;
  const panel = transitioned.value;
  if (!RIGHT_PANEL_TYPES.has(panel.type)) return null;

  const goChooser = () => openRightPanel('surfaces');
  const back = panel.type === 'surfaces' ? null : goChooser;

  return (
    <aside
      className={`right-panel-host flex h-full w-[min(440px,40vw)] min-w-[320px] shrink-0 flex-col border-l border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] is-${transitioned.phase}`}
      data-testid="right-panel"
      data-panel-type={panel.type}
      data-panel-phase={transitioned.phase}
      role="complementary"
      aria-label={panelTitle(panel.type, t)}
    >
      {panel.type === 'surfaces' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <PanelHeader title={t('topbar.surfacesTitle')} onClose={closeRightPanel} />
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <SurfacePicker
              t={t}
              onSelect={(surfaceId) => {
                if (['browser', 'files', 'terminal', 'diff'].includes(surfaceId)) {
                  openRightPanel(surfaceId);
                }
              }}
            />
          </div>
        </div>
      ) : null}

      {panel.type === 'files' ? <FilePanel onClose={closeRightPanel} onBack={back} t={t} /> : null}

      {panel.type === 'browser' ? (
        <BrowserPanel payload={panel.payload} panelPhase={transitioned.phase} onClose={closeRightPanel} onBack={back} t={t} />
      ) : null}

      {panel.type === 'terminal' ? (
        <EmbeddedSurfacePanel title={t('topbar.surface.terminal')} onClose={closeRightPanel} onBack={back}>
          <Suspense fallback={<div className="p-4 text-xs text-[var(--color-text-muted)]">…</div>}>
            <div className="right-panel-embed h-full min-h-0">
              <ReplicaTerminalView />
            </div>
          </Suspense>
        </EmbeddedSurfacePanel>
      ) : null}

      {panel.type === 'diff' ? (
        <EmbeddedSurfacePanel title={t('topbar.surface.diff')} onClose={closeRightPanel} onBack={back}>
          <Suspense fallback={<div className="p-4 text-xs text-[var(--color-text-muted)]">…</div>}>
            <div className="right-panel-embed h-full min-h-0">
              <ReplicaChangesView />
            </div>
          </Suspense>
        </EmbeddedSurfacePanel>
      ) : null}
    </aside>
  );
}
