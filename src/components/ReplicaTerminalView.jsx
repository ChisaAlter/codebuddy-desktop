import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useStore } from '../store';
import { useViewActive } from '../lib/use-view-active';
import { PtySocket } from '../lib/pty';

function TerminalPane({ projectId, pane, active, canSplit, canClose, operationBusy, onFocus, onSplitRight, onSplitDown, onClose, onReconnect }) {
  const containerRef = useRef(null);
  const terminalRef = useRef(null);
  const fitRef = useRef(null);
  const socketRef = useRef(null);
  const createPty = useStore((s) => s.createPty);
  const bindPtyToPane = useStore((s) => s.bindPtyToPane);
  const setPaneStatus = useStore((s) => s.setPaneStatus);
  const appendPaneOutput = useStore((s) => s.appendPaneOutput);
  const setPaneSession = useStore((s) => s.setPaneSession);
  const fetchPtyCwd = useStore((s) => s.fetchPtyCwd);
  const setPaneCwd = useStore((s) => s.setPaneCwd);
  const currentSessionIdRef = useRef(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const isCurrentProject = () => useStore.getState().activeProjectId === projectId;

  useEffect(() => {
    if (!containerRef.current || terminalRef.current) return;

    const term = new Terminal({
      fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace",
      fontSize: 13,
      cursorBlink: true,
      theme: {
        background: '#000000',
        foreground: '#ffffff',
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    if (pane.output) term.write(pane.output);
    terminalRef.current = term;
    fitRef.current = fitAddon;
    requestAnimationFrame(() => {
      try { fitAddon.fit(); } catch (_) {}
    });

    term.onData((data) => {
      socketRef.current?.sendInput(data);
    });

    let resizeFrame = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeFrame !== null) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        try {
          fitAddon.fit();
          socketRef.current?.resize(term.cols, term.rows);
        } catch (_) {}
      });
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      socketRef.current?.close();
      term.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useEffect(() => {
    async function ensureSession() {
      if (pane.sessionId || !isCurrentProject()) return;
      setPaneStatus(pane.id, 'connecting', projectId);
      // Prefer live store cwd (may have been captured just before a prior session died).
      const latestPane = useStore.getState().terminalPanes.find((item) => item.id === pane.id);
      const resumeCwd = latestPane?.cwd || pane.cwd || null;
      const created = await createPty(120, 32, resumeCwd);
      if (!isCurrentProject()) return;
      if (!created?.sessionId) throw new Error('PTY 创建失败');
      bindPtyToPane(pane.id, created.sessionId, projectId, created.cwd || resumeCwd);
    }
    ensureSession().catch(() => {
      if (isCurrentProject()) setPaneStatus(pane.id, 'error', projectId);
    });
  }, [projectId, pane.id, pane.sessionId, createPty, bindPtyToPane, setPaneStatus]);

  useEffect(() => {
    if (!helpOpen) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setHelpOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [helpOpen]);

  useEffect(() => {
    if (!pane.sessionId || !terminalRef.current) return;
    if (socketRef.current?.sessionId === pane.sessionId) return;

    socketRef.current?.close();
    socketRef.current = null;
    currentSessionIdRef.current = pane.sessionId;
    const socket = new PtySocket(pane.sessionId);
    socketRef.current = socket;
    setPaneSession(pane.id, pane.sessionId, projectId);

    socket.on('open', () => {
      if (!isCurrentProject() || currentSessionIdRef.current !== pane.sessionId) return;
      setPaneStatus(pane.id, 'connected', projectId);
      try {
        fitRef.current?.fit();
        socket.resize(terminalRef.current.cols, terminalRef.current.rows);
      } catch (_) {}
    });

    socket.on('message', (payload) => {
      if (!isCurrentProject() || currentSessionIdRef.current !== pane.sessionId) return;
      if (!terminalRef.current) return; // 卸载竞态：socket.close() 异步，dispose 后仍可能触发
      if (typeof payload === 'string') {
        terminalRef.current.write(payload);
        appendPaneOutput(pane.id, payload, projectId);
        return;
      }
      if (payload?.type === 'output' && payload?.data) {
        terminalRef.current.write(payload.data);
        appendPaneOutput(pane.id, payload.data, projectId);
      }
      if (payload?.type === 'exit') {
        // Best-effort: remember cwd before the session is gone so reconnect can resume there.
        fetchPtyCwd(pane.sessionId).then((cwd) => {
          if (cwd && isCurrentProject() && currentSessionIdRef.current === pane.sessionId) {
            setPaneCwd(pane.id, cwd, projectId);
          }
        }).catch(() => {});
        setPaneStatus(pane.id, 'disconnected', projectId);
      }
    });

    socket.on('close', () => {
      if (isCurrentProject() && currentSessionIdRef.current === pane.sessionId) setPaneStatus(pane.id, 'disconnected', projectId);
    });
    socket.on('error', () => {
      if (isCurrentProject() && currentSessionIdRef.current === pane.sessionId) setPaneStatus(pane.id, 'error', projectId);
    });
    socket.connect();

    return () => {
      if (socketRef.current === socket) socketRef.current = null;
      socket.close();
    };
  }, [projectId, pane.id, pane.sessionId, appendPaneOutput, setPaneSession, setPaneStatus, fetchPtyCwd, setPaneCwd]);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border"
      style={{
        borderColor: active ? '#0078d4' : '#2a2a2a',
        background: '#000000',
      }}
      onClick={onFocus}
    >
      <div className="flex h-9 items-center justify-between border-b px-3 text-xs"
        style={{ borderColor: '#2a2a2a', background: '#111111', color: '#b0b0b5' }}>
        <div className="flex items-center gap-2">
          <span>{pane.title}</span>
          {['error', 'disconnected'].includes(pane.status) ? (
            <span className="flex items-center gap-1.5 text-[10px]">
              <span className="text-[#f87171]">{pane.status === 'error' ? '连接失败' : '已断开'}</span>
              <button
                disabled={operationBusy}
                onClick={(e) => { e.stopPropagation(); onReconnect(pane.id); }}
                className="rounded px-1.5 py-0.5 text-[10px] border border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors disabled:cursor-wait disabled:opacity-50"
              >{operationBusy ? '处理中...' : '重连'}</button>
            </span>
          ) : (
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${
              pane.status === 'connected' ? 'bg-[rgba(74,222,128,0.12)] text-[#4ade80]' :
              pane.status === 'connecting' ? 'bg-[rgba(251,191,36,0.12)] text-[#fbbf24] animate-pulse' :
              'bg-[rgba(113,113,122,0.12)] text-[var(--color-text-muted)]'
            }`}>{pane.status === 'connected' ? '已连接' : pane.status === 'connecting' ? '连接中' : '空闲'}</span>
          )}
          {pane.sessionId ? <span className="text-[10px] opacity-70">{pane.sessionId.slice(0, 8)}</span> : null}
        </div>
        <div className="flex items-center gap-1">
          <button className="btn-ghost" disabled={!canSplit} onClick={(e) => { e.stopPropagation(); onSplitRight(); }}>右分</button>
          <button className="btn-ghost" disabled={!canSplit} onClick={(e) => { e.stopPropagation(); onSplitDown(); }}>下分</button>
          <div className="relative z-50 group">
            {helpOpen ? (
              <div
                className="fixed inset-0 z-40"
                aria-hidden="true"
                onClick={(event) => { event.stopPropagation(); setHelpOpen(false); }}
              />
            ) : null}
            <button
              type="button"
              className="relative z-50 flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors"
              title="终端快捷键"
              aria-label="查看终端快捷键"
              aria-expanded={helpOpen}
              aria-controls={'terminal-shortcuts-' + pane.id}
              onClick={(event) => { event.stopPropagation(); setHelpOpen((value) => !value); }}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M6.5 7.5h3V7h-3v.5zM5 9l.5 1h5l.5-1H5zM8 1a7 7 0 100 14A7 7 0 008 1zm0 12.5A5.5 5.5 0 1113.5 8 5.5 5.5 0 018 13.5z"/></svg>
            </button>
            <div
              id={'terminal-shortcuts-' + pane.id}
              role="tooltip"
              className={'absolute right-0 top-7 z-50 w-48 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] shadow-xl p-2 text-[10px] text-[var(--color-text-secondary)] space-y-1 ' + (helpOpen ? 'block' : 'hidden group-hover:block group-focus-within:block')}
            >
              <div className="font-medium text-[var(--color-text-primary)] mb-1">终端快捷键</div>
              <div>Ctrl+Shift+N 新建终端</div>
              <div>Ctrl+Shift+W 关闭终端</div>
              <div>Ctrl+Shift+→ 右分屏</div>
              <div>Ctrl+Shift+↓ 下分屏</div>
              <div>Alt+1/2 切换终端</div>
            </div>
          </div>
          <button
            className="btn-ghost disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!canClose || operationBusy}
            title={operationBusy ? '正在处理终端' : canClose ? '关闭终端' : '至少保留一个终端'}
            onClick={(e) => { e.stopPropagation(); onClose(); }}
          >
            {operationBusy ? '处理中...' : '关闭'}
          </button>
        </div>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden" />
    </div>
  );
}

export default function ReplicaTerminalView() {
  // M-perf (keep-alive): the terminal view stays mounted while hidden; pane
  // shortcuts must not fire when the route is not visible.
  const viewActive = useViewActive('terminal');
  const panes = useStore((s) => s.terminalPanes);
  const activePaneId = useStore((s) => s.activePaneId);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeProject = useStore((s) => s.projectsById[s.activeProjectId] || null);
  const apiBase = useStore((s) => s.apiBase);
  const splitPane = useStore((s) => s.splitPane);
  const closePane = useStore((s) => s.closePane);
  const setActivePane = useStore((s) => s.setActivePane);
  const createPty = useStore((s) => s.createPty);
  const releasePty = useStore((s) => s.releasePty);
  const fetchPtyCwd = useStore((s) => s.fetchPtyCwd);
  const setPaneCwd = useStore((s) => s.setPaneCwd);
  const setPaneStatus = useStore((s) => s.setPaneStatus);
  const bindPtyToPane = useStore((s) => s.bindPtyToPane);
  const initializeTerminal = useStore((s) => s.initializeTerminal);
  const restartProjectRuntime = useStore((s) => s.restartProjectRuntime);
  const [runtimeRetrying, setRuntimeRetrying] = useState(false);
  const [terminalOperationPaneId, setTerminalOperationPaneId] = useState(null);
  const [terminalActionError, setTerminalActionError] = useState('');
  const terminalOperationRef = useRef(null);

  useEffect(() => {
    terminalOperationRef.current = null;
    setRuntimeRetrying(false);
    setTerminalOperationPaneId(null);
    setTerminalActionError('');
    initializeTerminal();
  }, [activeProjectId, initializeTerminal]);

  const runtimeReady = Boolean(
    activeProjectId
    && activeProject?.runtimeStatus === 'running'
    && activeProject.runtimePort
    && apiBase === `http://127.0.0.1:${activeProject.runtimePort}`
  );

  const runtimeStatus = activeProject?.runtimeStatus || 'idle';
  const runtimeUnavailable = runtimeStatus === 'error' || runtimeStatus === 'stopped';

  const recoverRuntime = async () => {
    if (!activeProjectId || runtimeRetrying) return;
    const projectId = activeProjectId;
    setRuntimeRetrying(true);
    try {
      await restartProjectRuntime(projectId);
    } finally {
      if (useStore.getState().activeProjectId === projectId) setRuntimeRetrying(false);
    }
  };

  const beginPaneOperation = (paneId, type) => {
    if (terminalOperationRef.current) return null;
    const operation = { paneId, projectId: activeProjectId, type };
    terminalOperationRef.current = operation;
    setTerminalOperationPaneId(paneId);
    setTerminalActionError('');
    return operation;
  };

  const isPaneOperationCurrent = (operation) => (
    terminalOperationRef.current === operation
    && useStore.getState().activeProjectId === operation.projectId
  );

  const finishPaneOperation = (operation) => {
    if (terminalOperationRef.current !== operation) return;
    terminalOperationRef.current = null;
    setTerminalOperationPaneId(null);
  };

  /** Snapshot live PTY cwd onto the pane before tearing the session down. */
  const capturePaneCwd = async (pane, projectId) => {
    if (!pane?.sessionId) return pane?.cwd || null;
    const liveCwd = await fetchPtyCwd(pane.sessionId);
    if (liveCwd) {
      setPaneCwd(pane.id, liveCwd, projectId);
      return liveCwd;
    }
    return pane.cwd || null;
  };

  const closeTerminalPane = async (paneId) => {
    const pane = useStore.getState().terminalPanes.find((item) => item.id === paneId);
    if (!pane || useStore.getState().terminalPanes.length <= 1) return false;
    const operation = beginPaneOperation(paneId, 'close');
    if (!operation) return false;
    try {
      if (pane.sessionId) {
        // Persist cwd even though this pane is removed — useful if user reopens
        // a similar pane layout later via restored terminalState for other panes.
        await capturePaneCwd(pane, operation.projectId);
        if (!isPaneOperationCurrent(operation)) return false;
        const released = await releasePty(pane.sessionId);
        if (!isPaneOperationCurrent(operation)) return false;
        if (!released) {
          setTerminalActionError(useStore.getState().error || '关闭终端失败：无法释放 PTY 会话');
          setPaneStatus(paneId, 'error', operation.projectId);
          return false;
        }
      }
      if (!isPaneOperationCurrent(operation)) return false;
      const closed = closePane(paneId);
      if (!closed) setTerminalActionError('关闭终端失败，请重试');
      return closed;
    } catch (error) {
      if (isPaneOperationCurrent(operation)) setTerminalActionError(error?.message || '关闭终端失败');
      return false;
    } finally {
      finishPaneOperation(operation);
    }
  };

  const reconnectPane = async (paneId) => {
    const pane = useStore.getState().terminalPanes.find((item) => item.id === paneId);
    if (!pane || !activeProjectId) return false;
    const operation = beginPaneOperation(paneId, 'reconnect');
    if (!operation) return false;
    setPaneStatus(paneId, 'connecting', operation.projectId);
    try {
      let resumeCwd = pane.cwd || null;
      if (pane.sessionId) {
        resumeCwd = (await capturePaneCwd(pane, operation.projectId)) || resumeCwd;
        if (!isPaneOperationCurrent(operation)) return false;
        const released = await releasePty(pane.sessionId);
        if (!isPaneOperationCurrent(operation)) return false;
        if (!released) {
          setTerminalActionError(useStore.getState().error || '重连失败：无法释放旧 PTY 会话');
          setPaneStatus(paneId, 'error', operation.projectId);
          return false;
        }
      }
      const created = await createPty(120, 32, resumeCwd);
      if (!isPaneOperationCurrent(operation)) return false;
      if (!created?.sessionId) {
        setTerminalActionError(useStore.getState().error || '重连失败：无法创建新的 PTY 会话');
        setPaneStatus(paneId, 'error', operation.projectId);
        return false;
      }
      bindPtyToPane(paneId, created.sessionId, operation.projectId, created.cwd || resumeCwd);
      return true;
    } catch (error) {
      if (isPaneOperationCurrent(operation)) {
        setTerminalActionError(error?.message || '终端重连失败');
        setPaneStatus(paneId, 'error', operation.projectId);
      }
      return false;
    } finally {
      finishPaneOperation(operation);
    }
  };

  useEffect(() => {
    const onKeyDown = (event) => {
      // M-rc9: do not react to terminal pane shortcuts while a modal dialog is
      // open (e.g. ActionConfirmDialog), so Ctrl+Shift+W in a confirm does not
      // close a terminal pane underneath the overlay.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      // M-perf (keep-alive): the terminal view stays mounted while hidden — only
      // react to pane shortcuts while the terminal route is actually visible.
      if (!viewActive) return;
      if (event.ctrlKey && event.shiftKey && event.key === 'N') {
        event.preventDefault();
        if (!terminalOperationRef.current) splitPane(activePaneId, 'right');
      }
      if (event.ctrlKey && event.shiftKey && event.key === 'W') {
        event.preventDefault();
        const active = panes.find((pane) => pane.id === activePaneId);
        if (active && panes.length > 1 && !terminalOperationRef.current) closeTerminalPane(active.id);
      }
      if (event.ctrlKey && event.shiftKey && event.key === 'ArrowRight') {
        event.preventDefault();
        if (!terminalOperationRef.current) splitPane(activePaneId, 'right');
      }
      if (event.ctrlKey && event.shiftKey && event.key === 'ArrowDown') {
        event.preventDefault();
        if (!terminalOperationRef.current) splitPane(activePaneId, 'down');
      }
      if (event.altKey && /^[1-2]$/.test(event.key)) {
        const pane = panes[Number(event.key) - 1];
        if (pane) {
          event.preventDefault();
          setActivePane(pane.id);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [panes, activePaneId, splitPane, closeTerminalPane, setActivePane, viewActive]);

  const gridClass = useMemo(() => {
    if (panes.length <= 1) return 'grid-cols-1';
    return panes[1]?.split === 'down' ? 'grid-cols-1 grid-rows-2' : 'grid-cols-2 grid-rows-1';
  }, [panes]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-black text-white">
      <div className="flex h-12 items-center justify-between border-b border-[#2a2a2a] px-4">
        <div className="text-sm">Terminal</div>
        <div className="text-xs text-[#9ca3af]">项目级 PTY 实时连接</div>
      </div>
      {terminalActionError ? (
        <div className="flex items-center justify-between gap-3 border-b border-[rgba(239,68,68,0.35)] bg-[rgba(239,68,68,0.08)] px-4 py-2 text-xs text-[var(--color-accent-red)]">
          <span className="min-w-0 flex-1 break-words">{terminalActionError}</span>
          <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setTerminalActionError('')}>关闭</button>
        </div>
      ) : null}
      {runtimeUnavailable ? (
        <div className="flex flex-1 items-center justify-center bg-[var(--color-bg-primary)] px-6">
          <div className="max-w-lg text-center">
            <div className={`mb-2 text-sm font-medium ${runtimeStatus === 'error' ? 'text-[var(--color-accent-red)]' : 'text-[var(--color-text-primary)]'}`}>
              {runtimeStatus === 'error' ? '项目运行时启动失败' : '项目运行时已停止'}
            </div>
            <div className="mb-4 break-words text-xs leading-5 text-[var(--color-text-muted)]">
              {activeProject?.runtimeError || '终端需要运行中的 CodeBuddy 项目实例。'}
            </div>
            <button
              type="button"
              className="btn-primary px-4 py-2 text-xs"
              disabled={runtimeRetrying}
              onClick={recoverRuntime}
            >
              {runtimeRetrying ? '正在重新启动...' : '重新启动运行时'}
            </button>
          </div>
        </div>
      ) : !runtimeReady ? (
        <div className="flex-1 flex items-center justify-center bg-[var(--color-bg-primary)]">
          <div className="text-center">
            <div className="mb-2 text-sm text-[var(--color-text-secondary)]">正在连接项目运行时</div>
            <div className="text-xs text-[var(--color-text-muted)]">终端会在项目端口就绪后自动恢复</div>
          </div>
        </div>
      ) : panes.length === 0 ? (
        <div className="flex-1 flex items-center justify-center bg-[var(--color-bg-primary)]">
          <div className="text-center">
            <div className="mb-2 text-4xl opacity-20">⌨</div>
            <p className="text-sm text-[var(--color-text-muted)]">终端就绪中...</p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">正在建立 PTY 连接</p>
          </div>
        </div>
      ) : (
        <div className={`grid min-h-0 flex-1 gap-2 p-2 ${gridClass}`}>
          {panes.map((pane) => (
            <TerminalPane
              key={`${activeProjectId}-${pane.id}`}
              projectId={activeProjectId}
              pane={pane}
              active={pane.id === activePaneId}
              canSplit={panes.length < 2 && !terminalOperationPaneId}
              operationBusy={terminalOperationPaneId === pane.id}
              onFocus={() => setActivePane(pane.id)}
              canClose={panes.length > 1 && !terminalOperationPaneId}
              onSplitRight={() => splitPane(pane.id, 'right')}
              onSplitDown={() => splitPane(pane.id, 'down')}
              onClose={() => closeTerminalPane(pane.id)}
              onReconnect={() => reconnectPane(pane.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
