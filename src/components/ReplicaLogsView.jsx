import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useStore } from '../store';
import { copyTextToClipboard } from '../lib/clipboard';

export function highlightText(text, term) {
  if (!term || typeof text !== 'string') return text;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');
  const parts = text.split(regex);
  return parts.map((part, i) =>
    part.toLowerCase() === term.toLowerCase() ? (
      <mark key={i} className="bg-[var(--color-accent-yellow)] text-black px-0.5 rounded">{part}</mark>
    ) : part
  );
}

export default function ReplicaLogsView() {
  const workers = useStore((s) => s.workers);
  const refreshWorkers = useStore((s) => s.refreshWorkers);
  const workersError = useStore((s) => s.workersError);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const loadWorkerLogs = useStore((s) => s.loadWorkerLogs);
  const [workerPid, setWorkerPid] = useState('');
  const [logType, setLogType] = useState('stdout');
  const [logs, setLogs] = useState('');
  const [availableLogTypes, setAvailableLogTypes] = useState(['stdout', 'stderr']);
  const [logPath, setLogPath] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [loading, setLoading] = useState(false);
  const [initialWorkersLoad, setInitialWorkersLoad] = useState(true);
  const [logError, setLogError] = useState(null);
  const [copyStatus, setCopyStatus] = useState('idle');
  const containerRef = useRef(null);
  const logRequestIdRef = useRef(0);
  const logLoadInFlightRef = useRef(null);
  const preferredWorkerPidRef = useRef('');
  const preferredWorkerProjectRef = useRef(null);
  const copyResetTimerRef = useRef(null);

  useEffect(() => {
    let active = true;
    const projectId = activeProjectId;
    logRequestIdRef.current += 1;
    logLoadInFlightRef.current = null;
    setInitialWorkersLoad(true);
    setWorkerPid('');
    setLogs('');
    setLogPath('');
    setAvailableLogTypes(['stdout', 'stderr']);
    setAutoRefresh(false);
    setLoading(false);
    setLogError(null);
    Promise.resolve(refreshWorkers()).finally(() => {
      if (active && useStore.getState().activeProjectId === projectId) setInitialWorkersLoad(false);
    });
    try {
      const preferredPid = sessionStorage.getItem('logs-preferred-worker-pid');
      if (preferredPid) {
        preferredWorkerPidRef.current = preferredPid;
        preferredWorkerProjectRef.current = projectId;
        setWorkerPid(preferredPid);
        sessionStorage.removeItem('logs-preferred-worker-pid');
      }
    } catch (_) {}
    return () => { active = false; };
  }, [activeProjectId, refreshWorkers]);

  useEffect(() => {
    const hasWorker = (pid) => workers.some((worker) => String(worker.pid) === String(pid));
    if (workerPid && hasWorker(workerPid)) {
      preferredWorkerPidRef.current = '';
      preferredWorkerProjectRef.current = null;
      return;
    }
    const preferredPid = preferredWorkerProjectRef.current === activeProjectId
      ? preferredWorkerPidRef.current
      : '';
    if (!preferredPid) {
      preferredWorkerPidRef.current = '';
      preferredWorkerProjectRef.current = null;
    }
    if (preferredPid && hasWorker(preferredPid)) {
      preferredWorkerPidRef.current = '';
      preferredWorkerProjectRef.current = null;
      setWorkerPid(preferredPid);
    } else if (workers.length) {
      preferredWorkerPidRef.current = '';
      preferredWorkerProjectRef.current = null;
      setWorkerPid(String(workers[0].pid));
    }
  }, [activeProjectId, workers, workerPid]);

  useEffect(() => {
    logRequestIdRef.current += 1;
    logLoadInFlightRef.current = null;
    setLogs('');
    setLogPath('');
    setLogError(null);
    setLoading(false);
  }, [workerPid]);

  const loadLogs = useCallback(async () => {
    if (!workerPid || logLoadInFlightRef.current) return false;
    const operation = {};
    logLoadInFlightRef.current = operation;
    const projectId = activeProjectId;
    const requestedPid = workerPid;
    const requestId = ++logRequestIdRef.current;
    setLoading(true);
    setLogError(null);
    try {
      const result = await loadWorkerLogs(requestedPid, logType, 200);
      if (requestId !== logRequestIdRef.current || useStore.getState().activeProjectId !== projectId) return false;
      const content = typeof result === 'string' ? result : result?.content;
      const resolvedType = typeof result === 'object' ? result?.type : logType;
      const types = typeof result === 'object' && Array.isArray(result?.availableTypes) ? result.availableTypes : [];
      setLogs(content || '');
      setLogPath(typeof result === 'object' ? result?.logPath || '' : '');
      if (types.length) setAvailableLogTypes(types);
      if (resolvedType && resolvedType !== logType) setLogType(resolvedType);
      return true;
    } catch (err) {
      if (requestId !== logRequestIdRef.current || useStore.getState().activeProjectId !== projectId) return false;
      setLogError('日志加载失败: ' + (err?.message || '未知错误'));
      setLogs('');
      return false;
    } finally {
      if (logLoadInFlightRef.current === operation) logLoadInFlightRef.current = null;
      if (requestId === logRequestIdRef.current && useStore.getState().activeProjectId === projectId) setLoading(false);
    }
  }, [activeProjectId, workerPid, logType, loadWorkerLogs]);

  const changeLogType = (nextType) => {
    logRequestIdRef.current += 1;
    setLoading(false);
    setLogs('');
    setLogPath('');
    setLogError(null);
    setLogType(nextType);
  };

  useEffect(() => {
    if (!autoRefresh || !workerPid) return;
    const interval = setInterval(loadLogs, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, loadLogs, workerPid]);

  useEffect(() => {
    if (!logError) return;
    const timer = setTimeout(() => setLogError(null), 8000);
    return () => clearTimeout(timer);
  }, [logError]);

  useEffect(() => () => {
    if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
  }, []);

  useEffect(() => {
    setCopyStatus('idle');
  }, [logs]);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs]);

  const handleCopy = async () => {
    if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
    try {
      await copyTextToClipboard(logs);
      setCopyStatus('success');
    } catch (_) {
      setCopyStatus('error');
    }
    copyResetTimerRef.current = setTimeout(() => {
      copyResetTimerRef.current = null;
      setCopyStatus('idle');
    }, 1800);
  };

  const lines = logs ? logs.split('\n') : [];
  const term = searchTerm.trim();
  const filtered = term
    ? lines
        .map((line, i) => ({ line, num: i + 1, match: line.toLowerCase().includes(term.toLowerCase()) }))
        .filter((x) => x.match)
    : lines.map((line, i) => ({ line, num: i + 1, match: true }));

  const stderrMode = logType === 'stderr';
  const logColor = stderrMode ? 'var(--color-error)' : 'var(--color-text-secondary)';

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--color-bg-primary)]">
      <div className="flex h-12 items-center border-b border-[var(--color-border-default)] px-6">
        <h2 className="text-base font-semibold text-[var(--color-text-primary)]">日志查看器</h2>
      </div>

      <div className="flex items-center flex-wrap gap-3 border-b border-[var(--color-border-default)] px-6 py-3">
        <select
          className="input-field max-w-[240px]"
          value={workerPid}
          onChange={(e) => setWorkerPid(e.target.value)}
        >
          {initialWorkersLoad && workers.length === 0 ? (
            <option value="">加载 Worker 列表中...</option>
          ) : (
            <>
              <option value="">选择 Worker</option>
              {workers.map((w) => (
                <option key={w.pid} value={String(w.pid)}>
                  {w.pid} · {w.kind} · {w.sessionId || '-'}
                </option>
              ))}
            </>
          )}
        </select>

        <select
          className="input-field max-w-[160px]"
          value={logType}
          onChange={(e) => changeLogType(e.target.value)}
        >
          {availableLogTypes.map((type) => <option key={type} value={type}>{type}</option>)}
        </select>

        <button
          className="btn-primary"
          onClick={loadLogs}
          disabled={!workerPid || loading}
        >
          加载日志
        </button>

        {!workerPid && (
          <span className="text-xs text-[var(--color-error)]">请先选择一个 Worker</span>
        )}

        <span className="text-xs text-[var(--color-text-muted)] ml-1">自动刷新</span>
        <button
          type="button"
          role="switch"
          aria-checked={autoRefresh}
          aria-label="自动刷新日志"
          className={`toggle-switch ${autoRefresh ? 'toggle-switch-on' : 'toggle-switch-off'}`}
          onClick={() => setAutoRefresh((v) => !v)}
        >
          <div className={`toggle-knob ${autoRefresh ? 'toggle-knob-on' : ''}`} />
        </button>

        <input
          className="input-field max-w-[200px]"
          type="text"
          placeholder="搜索日志..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />

        {logPath ? <span className="max-w-[320px] truncate text-xs text-[var(--color-text-muted)]" title={logPath}>{logPath}</span> : null}
      </div>

      {logError && (
        <div className="mx-6 mb-2 p-2 rounded flex items-center justify-between text-xs"
             style={{ background: 'var(--color-error-bg, rgba(248,113,113,0.1))', border: '1px solid var(--color-accent-red)', color: 'var(--color-accent-red)' }}>
          <span>{logError}</span>
          <button className="underline" onClick={() => setLogError(null)}>关闭</button>
        </div>
      )}
      {workersError && !initialWorkersLoad && (
        <div className="mx-6 mb-2 rounded border border-[rgba(248,113,113,0.2)] bg-[rgba(248,113,113,0.1)] p-2 text-xs text-[var(--color-error)]">
          Worker 列表加载失败：{workersError}
          <button
            className="ml-3 underline"
            onClick={() => {
              setInitialWorkersLoad(true);
              Promise.resolve(refreshWorkers()).finally(() => setInitialWorkersLoad(false));
            }}
          >
            重试
          </button>
        </div>
      )}
      <div className="flex-1 overflow-hidden relative">
        {logs && (
          <button
            className={`absolute right-4 top-2 z-10 min-w-[76px] btn-ghost text-xs ${copyStatus === 'success' ? 'text-[var(--color-accent-green)]' : copyStatus === 'error' ? 'text-[var(--color-accent-red)]' : ''}`}
            onClick={handleCopy}
            title={copyStatus === 'success' ? '日志已复制' : copyStatus === 'error' ? '日志复制失败' : '复制全部日志'}
          >
            {copyStatus === 'success' ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 8l3 3 7-7" /></svg>
            ) : copyStatus === 'error' ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 4l8 8M12 4l-8 8" /></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="5" y="5" width="9" height="9" rx="1.5" />
                <path d="M11 5V3a1 1 0 00-1-1H3a1 1 0 00-1 1v8a1 1 0 001 1h2" />
              </svg>
            )}
            {copyStatus === 'success' ? '已复制' : copyStatus === 'error' ? '失败' : '复制'}
          </button>
        )}

        <div ref={containerRef} className="h-full overflow-auto p-6 pt-10">
          {loading ? (
            <pre className="min-h-full rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-4 space-y-2.5">
              {[88, 72, 91, 55, 85, 63, 94, 50, 78].map((w, i) => (
                <div key={i} className="skeleton" style={{ height: '0.75rem', width: `${w}%` }} />
              ))}
            </pre>
          ) : !logs ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-[var(--color-text-muted)]">暂无日志</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-[var(--color-text-muted)]">无匹配结果</p>
            </div>
          ) : (
            <pre
              className="min-h-full whitespace-pre-wrap break-words rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-4 text-xs font-mono"
              style={{ color: logColor }}
            >
              {filtered.map(({ line, num }) => (
                <div key={num} className="flex">
                  <span className="select-none shrink-0 w-10 text-right mr-3 text-[var(--color-text-muted)]">
                    {num}
                  </span>
                  <span>{term ? highlightText(line, term) : line}</span>
                </div>
              ))}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
