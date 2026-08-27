// G10: Canvas —— PTY 终端磁贴画布（对照 WebUI 2.138 CanvasView / canvas-store）。
// 无限画布（平移/缩放）上放置可拖拽/缩放的终端磁贴；每块磁贴对应一个真实 PTY 会话
// （POST /api/v1/pty + WebSocket），复用 lib/pty 与 store.createPty/releasePty。
// 磁贴布局为视图内存态（关闭视图即回收 PTY），与 Desktop 多面板终端互不影响。
import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Plus, ZoomIn, ZoomOut, Maximize2, Minimize2, Minus, X, Square } from 'lucide-react';
import { useStore } from '../store';
import { PtySocket } from '../lib/pty';
import { resolveLocaleMode, translate } from '../lib/i18n';
import {
  CANVAS_GRID,
  TILE_MINIMIZED_HEIGHT,
  centerTilePosition,
  clampTileSize,
  makeTile,
  maximizeTileState,
  minimizeTileState,
  restoreTileState,
  snapToGrid,
  zoomViewportAtPoint,
} from '../lib/canvas-tiles';

// —— 磁贴内嵌终端：本地 xterm + PtySocket（不进全局 store，随磁贴生命周期回收）。 ——
function CanvasTerminalImpl({ tileId, onSession, onStatus }) {
  const containerRef = useRef(null);
  const createPty = useStore((s) => s.createPty);
  const releaseRef = useRef({ sessionId: null });

  useEffect(() => {
    if (!containerRef.current) return undefined;
    let disposed = false;
    const term = new Terminal({
      fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace",
      fontSize: 12,
      cursorBlink: true,
      theme: { background: '#000000', foreground: '#ffffff' },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    requestAnimationFrame(() => {
      try { fitAddon.fit(); } catch (_) {}
    });
    let socket = null;
    term.onData((data) => socket?.sendInput(data));

    let resizeFrame = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeFrame !== null) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        try {
          fitAddon.fit();
          socket?.resize(term.cols, term.rows);
        } catch (_) {}
      });
    });
    resizeObserver.observe(containerRef.current);

    onStatus?.('connecting');
    createPty(100, 26, null)
      .then((created) => {
        if (disposed) return;
        if (!created?.sessionId) throw new Error('PTY 创建失败');
        releaseRef.current.sessionId = created.sessionId;
        onSession?.(created.sessionId, created.cwd || null);
        socket = new PtySocket(created.sessionId);
        socket.on('open', () => {
          if (disposed) return;
          onStatus?.('connected');
          try {
            fitAddon.fit();
            socket.resize(term.cols, term.rows);
          } catch (_) {}
        });
        socket.on('message', (payload) => {
          if (disposed) return;
          if (typeof payload === 'string') term.write(payload);
          else if (payload?.type === 'output' && payload?.data) term.write(payload.data);
          else if (payload?.type === 'exit') onStatus?.('disconnected');
        });
        socket.on('close', () => !disposed && onStatus?.('disconnected'));
        socket.on('error', () => !disposed && onStatus?.('error'));
        socket.connect();
      })
      .catch(() => {
        if (!disposed) onStatus?.('error');
      });

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      socket?.close();
      term.dispose();
    };
    // tileId 变化才重建（createPty/onSession/onStatus 由调用方保证语义稳定）。
    // eslint-disable-next-line
  }, [tileId]);

  return <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden" />;
}

const CanvasTerminal = memo(CanvasTerminalImpl, (prev, next) => prev.tileId === next.tileId);

const STATUS_COLORS = {
  connected: 'bg-[var(--color-accent-green)]',
  connecting: 'bg-[var(--color-accent-yellow)] animate-pulse',
  disconnected: 'bg-[var(--color-text-muted)]',
  error: 'bg-[var(--color-accent-red)]',
};

let canvasTileSeq = 0;

export default function ReplicaCanvasView() {
  const localeMode = useStore((s) => s.guiSettings?.locale || 'system');
  const locale = resolveLocaleMode(localeMode);
  const t = useCallback((key, vars) => translate(locale, key, vars), [locale]);
  const releasePty = useStore((s) => s.releasePty);
  const activeProject = useStore((s) => s.projectsById[s.activeProjectId] || null);
  const apiBase = useStore((s) => s.apiBase);
  const runtimeReady = Boolean(
    activeProject?.runtimeStatus === 'running'
    && activeProject.runtimePort
    && apiBase === `http://127.0.0.1:${activeProject.runtimePort}`,
  );

  const [viewport, setViewport] = useState({ panX: 0, panY: 0, zoom: 1 });
  const [tiles, setTiles] = useState({});
  const [statusByTile, setStatusByTile] = useState({});
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });
  const nextZIndexRef = useRef(1);
  const canvasRef = useRef(null);
  const sessionByTileRef = useRef(new Map());
  const dragRef = useRef(null);

  useEffect(() => {
    const node = canvasRef.current;
    if (!node) return undefined;
    const observer = new ResizeObserver(() => {
      const rect = node.getBoundingClientRect();
      setCanvasSize({ width: rect.width, height: rect.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [runtimeReady]);

  const addTile = useCallback(() => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const position = centerTilePosition(viewport, rect ? { width: rect.width, height: rect.height } : { width: 800, height: 600 });
    canvasTileSeq += 1;
    const id = `tile-${Date.now().toString(36)}-${canvasTileSeq}`;
    const tile = makeTile(id, position, nextZIndexRef.current);
    nextZIndexRef.current += 1;
    setTiles((current) => ({ ...current, [id]: tile }));
  }, [viewport]);

  const removeTile = useCallback(
    (tileId) => {
      const sessionId = sessionByTileRef.current.get(tileId);
      sessionByTileRef.current.delete(tileId);
      if (sessionId) void releasePty(sessionId);
      setTiles((current) => {
        const rest = { ...current };
        delete rest[tileId];
        return rest;
      });
      setStatusByTile((current) => {
        const rest = { ...current };
        delete rest[tileId];
        return rest;
      });
    },
    [releasePty],
  );

  const updateTile = useCallback((tileId, patch) => {
    setTiles((current) => (current[tileId] ? { ...current, [tileId]: { ...current[tileId], ...patch } } : current));
  }, []);

  const bringToFront = useCallback((tileId) => {
    const zIndex = nextZIndexRef.current;
    nextZIndexRef.current += 1;
    setTiles((current) => (current[tileId] ? { ...current, [tileId]: { ...current[tileId], zIndex } } : current));
  }, []);

  const toggleMaximize = useCallback((tileId) => {
    setTiles((current) => {
      const tile = current[tileId];
      if (!tile) return current;
      if (tile.windowState === 'maximized') return { ...current, [tileId]: restoreTileState(tile) };
      const zIndex = nextZIndexRef.current;
      nextZIndexRef.current += 1;
      return { ...current, [tileId]: maximizeTileState(tile, zIndex) };
    });
  }, []);

  const toggleMinimize = useCallback((tileId) => {
    setTiles((current) => {
      const tile = current[tileId];
      if (!tile) return current;
      return {
        ...current,
        [tileId]: tile.windowState === 'minimized' ? restoreTileState(tile) : minimizeTileState(tile),
      };
    });
  }, []);

  // 视图卸载时回收全部 PTY（内存态画布，不跨路由保留会话）。
  useEffect(
    () => () => {
      for (const sessionId of sessionByTileRef.current.values()) {
        if (sessionId) void releasePty(sessionId);
      }
      sessionByTileRef.current.clear();
    },
    [releasePty],
  );

  // —— 画布平移（空白处拖拽）与磁贴拖拽/缩放，统一 pointer 处理。 ——
  const onCanvasPointerDown = useCallback(
    (event) => {
      if (event.button !== 0 || event.target !== canvasRef.current) return;
      dragRef.current = { kind: 'pan', startX: event.clientX, startY: event.clientY, panX: viewport.panX, panY: viewport.panY };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [viewport],
  );

  const beginTileDrag = useCallback(
    (event, tile) => {
      if (event.button !== 0 || tile.windowState === 'maximized') return;
      event.stopPropagation();
      bringToFront(tile.id);
      dragRef.current = { kind: 'move', tileId: tile.id, startX: event.clientX, startY: event.clientY, x: tile.x, y: tile.y };
      canvasRef.current?.setPointerCapture(event.pointerId);
    },
    [bringToFront],
  );

  const beginTileResize = useCallback(
    (event, tile) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      bringToFront(tile.id);
      dragRef.current = {
        kind: 'resize',
        tileId: tile.id,
        startX: event.clientX,
        startY: event.clientY,
        width: tile.width,
        height: tile.height,
      };
      canvasRef.current?.setPointerCapture(event.pointerId);
    },
    [bringToFront],
  );

  const onPointerMove = useCallback(
    (event) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (drag.kind === 'pan') {
        setViewport((current) => ({ ...current, panX: drag.panX + dx, panY: drag.panY + dy }));
        return;
      }
      const zoom = viewport.zoom || 1;
      if (drag.kind === 'move') {
        updateTile(drag.tileId, { x: snapToGrid(drag.x + dx / zoom), y: snapToGrid(drag.y + dy / zoom) });
        return;
      }
      if (drag.kind === 'resize') {
        updateTile(drag.tileId, clampTileSize(drag.width + dx / zoom, drag.height + dy / zoom));
      }
    },
    [viewport.zoom, updateTile],
  );

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const onWheel = useCallback((event) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (event.ctrlKey || event.metaKey) {
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      setViewport((current) =>
        zoomViewportAtPoint(current, (current.zoom || 1) * factor, {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        }),
      );
      return;
    }
    setViewport((current) => ({ ...current, panX: current.panX - event.deltaX, panY: current.panY - event.deltaY }));
  }, []);

  const zoomBy = useCallback((factor) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    setViewport((current) =>
      zoomViewportAtPoint(current, (current.zoom || 1) * factor, {
        x: (rect?.width || 0) / 2,
        y: (rect?.height || 0) / 2,
      }),
    );
  }, []);

  const tileList = Object.values(tiles);

  return (
    <div className="page-shell" data-testid="canvas-view">
      <div className="page-header">
        <div>
          <h2 className="page-header-title">{t('canvas.title')}</h2>
          <div className="page-header-desc">{t('canvas.subtitle')}</div>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost px-2 py-1.5 text-xs" title={t('canvas.zoomOut')} onClick={() => zoomBy(1 / 1.2)}>
            <ZoomOut size={13} />
          </button>
          <button
            className="btn-ghost px-2 py-1.5 text-xs tabular-nums"
            title={t('canvas.zoomReset')}
            onClick={() => setViewport({ panX: 0, panY: 0, zoom: 1 })}
          >
            {Math.round((viewport.zoom || 1) * 100)}%
          </button>
          <button className="btn-ghost px-2 py-1.5 text-xs" title={t('canvas.zoomIn')} onClick={() => zoomBy(1.2)}>
            <ZoomIn size={13} />
          </button>
          <button className="btn-primary px-3 py-1.5 text-xs" disabled={!runtimeReady} onClick={addTile}>
            <Plus size={12} className="mr-1 inline-block" />
            {t('canvas.addTile')}
          </button>
        </div>
      </div>

      {!runtimeReady ? (
        <div className="flex flex-1 items-center justify-center text-center">
          <div>
            <div className="mb-1 text-sm text-[var(--color-text-secondary)]">{t('canvas.runtimeNotReady')}</div>
            <div className="text-xs text-[var(--color-text-muted)]">{t('canvas.runtimeNotReadyHint')}</div>
          </div>
        </div>
      ) : (
        <div
          ref={canvasRef}
          className="relative min-h-0 flex-1 cursor-grab overflow-hidden bg-[var(--color-bg-primary)] active:cursor-grabbing"
          style={{
            backgroundImage: 'radial-gradient(circle, var(--color-border-muted) 1px, transparent 1px)',
            backgroundSize: `${CANVAS_GRID * (viewport.zoom || 1)}px ${CANVAS_GRID * (viewport.zoom || 1)}px`,
            backgroundPosition: `${viewport.panX}px ${viewport.panY}px`,
            touchAction: 'none',
          }}
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
        >
          {tileList.length === 0 ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-[var(--color-text-muted)]">
              {t('canvas.empty')}
            </div>
          ) : null}
          <div
            className="absolute left-0 top-0"
            style={{ transform: `translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewport.zoom || 1})`, transformOrigin: '0 0' }}
          >
            {tileList.map((tile) => {
              const isMaximized = tile.windowState === 'maximized';
              const isMinimized = tile.windowState === 'minimized';
              const status = statusByTile[tile.id] || 'connecting';
              const zoom = viewport.zoom || 1;
              // 最大化：反变换填满画布可视区（同一 DOM 节点，避免重挂 PTY 终端）。
              const style = isMaximized
                ? {
                    left: -viewport.panX / zoom,
                    top: -viewport.panY / zoom,
                    width: canvasSize.width / zoom,
                    height: canvasSize.height / zoom,
                    zIndex: tile.zIndex,
                  }
                : {
                    left: tile.x,
                    top: tile.y,
                    width: tile.width,
                    height: isMinimized ? TILE_MINIMIZED_HEIGHT : tile.height,
                    zIndex: tile.zIndex,
                  };
              return (
                <div
                  key={tile.id}
                  className="absolute flex flex-col overflow-hidden rounded-lg border border-[var(--color-border-default)] bg-black shadow-lg"
                  style={style}
                  onPointerDown={() => bringToFront(tile.id)}
                >
                  <div
                    className="flex h-8 shrink-0 cursor-move items-center gap-2 border-b border-[#2a2a2a] bg-[#111111] px-2 text-[11px] text-[#b0b0b5]"
                    onPointerDown={(event) => beginTileDrag(event, tile)}
                    onDoubleClick={() => toggleMaximize(tile.id)}
                  >
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_COLORS[status] || STATUS_COLORS.disconnected}`} />
                    <span className="min-w-0 flex-1 truncate">{tile.cwd || t('canvas.tileTitle')}</span>
                    <button
                      type="button"
                      className="flex h-5 w-5 items-center justify-center rounded hover:bg-[#2a2a2a]"
                      title={isMinimized ? t('canvas.restore') : t('canvas.minimize')}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() => toggleMinimize(tile.id)}
                    >
                      {isMinimized ? <Square size={10} /> : <Minus size={10} />}
                    </button>
                    <button
                      type="button"
                      className="flex h-5 w-5 items-center justify-center rounded hover:bg-[#2a2a2a]"
                      title={isMaximized ? t('canvas.restore') : t('canvas.maximize')}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() => toggleMaximize(tile.id)}
                    >
                      {isMaximized ? <Minimize2 size={10} /> : <Maximize2 size={10} />}
                    </button>
                    <button
                      type="button"
                      className="flex h-5 w-5 items-center justify-center rounded hover:bg-[#2a2a2a] hover:text-[var(--color-accent-red)]"
                      title={t('canvas.closeTile')}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() => removeTile(tile.id)}
                    >
                      <X size={10} />
                    </button>
                  </div>
                  <div className={isMinimized ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
                    <CanvasTerminal
                      tileId={tile.id}
                      onSession={(sessionId, cwd) => {
                        sessionByTileRef.current.set(tile.id, sessionId);
                        updateTile(tile.id, { ptySessionId: sessionId, ...(cwd ? { cwd } : {}) });
                      }}
                      onStatus={(next) => setStatusByTile((current) => ({ ...current, [tile.id]: next }))}
                    />
                  </div>
                  {!isMinimized && !isMaximized ? (
                    <div
                      className="absolute bottom-0 right-0 h-3 w-3 cursor-nwse-resize"
                      onPointerDown={(event) => beginTileResize(event, tile)}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>

        </div>
      )}
    </div>
  );
}
