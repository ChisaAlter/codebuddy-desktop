// G6: MCP App 工具卡（ui:// 交互界面）。点击加载后由 Electron 主进程在隔离
// WebContentsView 中渲染 guest HTML（见 electron/mcp-app-host.cjs），组件本身只
// 负责占位矩形测量 + 展示模式（inline/fullscreen/pip）切换与关闭。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppWindow, Maximize2, Minimize2, PictureInPicture2, X } from 'lucide-react';
import { MCP_APP_INLINE_HEIGHT, mcpAppViewBounds, normalizeMcpAppDisplayMode } from '../lib/mcp-app';

let mcpAppSeq = 0;

export default function McpAppCard({ appResource, t }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('inline');
  const [error, setError] = useState('');
  const appIdRef = useRef(null);
  const anchorRef = useRef(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const supported = Boolean(window.electronAPI?.mcpAppOpen);
  const appId = useMemo(() => {
    mcpAppSeq += 1;
    return `mcp-app-${Date.now().toString(36)}-${mcpAppSeq}`;
  }, []);

  const computeBounds = useCallback(() => {
    const rect = anchorRef.current?.getBoundingClientRect() || null;
    return mcpAppViewBounds(
      modeRef.current,
      rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
      { width: window.innerWidth, height: window.innerHeight },
    );
  }, []);

  const syncBounds = useCallback(() => {
    if (!appIdRef.current) return;
    window.electronAPI?.mcpAppSetBounds?.(appIdRef.current, computeBounds());
  }, [computeBounds]);

  const closeApp = useCallback(() => {
    if (appIdRef.current) {
      void window.electronAPI?.mcpAppClose?.(appIdRef.current);
      appIdRef.current = null;
    }
    setOpen(false);
    setMode('inline');
  }, []);

  const openApp = useCallback(async () => {
    if (!supported || !appResource?.html) return;
    setError('');
    setOpen(true);
    try {
      // 先渲染占位（下一帧才有矩形），再挂 WebContentsView。
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      await window.electronAPI.mcpAppOpen({ id: appId, html: appResource.html, bounds: computeBounds() });
      appIdRef.current = appId;
      syncBounds();
    } catch (err) {
      setOpen(false);
      setError(err?.message || String(err));
    }
  }, [supported, appResource, appId, computeBounds, syncBounds]);

  // 打开期间：滚动/缩放跟随 + 周期兜底（虚拟列表重排等）。
  useEffect(() => {
    if (!open) return undefined;
    const onScroll = () => syncBounds();
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onScroll);
    const timer = setInterval(syncBounds, 500);
    return () => {
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onScroll);
      clearInterval(timer);
    };
  }, [open, syncBounds]);

  useEffect(() => () => closeApp(), [closeApp]);

  const switchMode = useCallback(
    (nextMode) => {
      setMode(normalizeMcpAppDisplayMode(nextMode));
      requestAnimationFrame(() => syncBounds());
    },
    [syncBounds],
  );

  if (!appResource) return null;

  if (!supported) {
    return (
      <div className="mt-1 rounded-md border border-[var(--color-border-muted)] px-2.5 py-1.5 text-[11px] text-[var(--color-text-muted)]">
        {t('tool.mcpAppDesktopOnly')}
      </div>
    );
  }

  if (!open) {
    return (
      <div className="mt-1">
        <button
          type="button"
          className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-[var(--color-border-default)] px-3 py-3 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
          onClick={() => void openApp()}
          data-testid="mcp-app-load"
        >
          <AppWindow size={14} />
          <span>{t('tool.mcpAppLoadHint')}</span>
          {appResource.uri ? <span className="truncate text-[10px] text-[var(--color-text-muted)]">({appResource.uri})</span> : null}
        </button>
        {error ? <div className="mt-1 text-[11px] text-[var(--color-accent-red)]">{error}</div> : null}
      </div>
    );
  }

  return (
    <div className="mt-1 overflow-hidden rounded-md border border-[var(--color-border-default)]" data-testid="mcp-app-frame">
      <div className="flex items-center gap-1 border-b border-[var(--color-border-muted)] bg-[var(--color-bg-secondary)] px-2 py-1">
        <AppWindow size={12} className="text-[var(--color-text-muted)]" />
        <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-muted)]">{appResource.uri || 'MCP App'}</span>
        {mode !== 'inline' ? (
          <button type="button" className="btn-ghost px-1.5 py-0.5" title={t('tool.mcpAppInline')} onClick={() => switchMode('inline')}>
            <Minimize2 size={12} />
          </button>
        ) : (
          <>
            <button type="button" className="btn-ghost px-1.5 py-0.5" title={t('tool.mcpAppPip')} onClick={() => switchMode('pip')}>
              <PictureInPicture2 size={12} />
            </button>
            <button type="button" className="btn-ghost px-1.5 py-0.5" title={t('tool.mcpAppFullscreen')} onClick={() => switchMode('fullscreen')}>
              <Maximize2 size={12} />
            </button>
          </>
        )}
        <button type="button" className="btn-ghost px-1.5 py-0.5" title={t('tool.mcpAppClose')} onClick={closeApp}>
          <X size={12} />
        </button>
      </div>
      {/* inline 模式下 WebContentsView 覆盖此占位区域；fullscreen/pip 时视图脱离占位。 */}
      <div
        ref={anchorRef}
        style={{ height: mode === 'inline' ? MCP_APP_INLINE_HEIGHT : 40 }}
        className="flex items-center justify-center bg-[var(--color-bg-primary)] text-[11px] text-[var(--color-text-muted)]"
      >
        {mode === 'inline' ? '' : t(mode === 'pip' ? 'tool.mcpAppPipActive' : 'tool.mcpAppFullscreenActive')}
      </div>
    </div>
  );
}
