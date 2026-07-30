import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store';
import { fetchDaemonStatus, restartDaemon, startDaemon, stopDaemon, stopWorker } from '../lib/ops';
import { getDaemonServiceStatus, installDaemonService, uninstallDaemonService } from '../lib/daemon-service';
import ActionConfirmDialog from './ActionConfirmDialog';

const STATUS_CONFIG = {
  running: { klass: 'tag-green', label: '运行中' },
  active: { klass: 'tag-green', label: '运行中' },
  stopped: { klass: 'tag-red', label: '已停止' },
  stale: { klass: 'tag-yellow', label: '心跳过期' },
  error: { klass: 'tag-red', label: '错误' },
  failed: { klass: 'tag-red', label: '失败' },
};

const HEARTBEAT_STALE_MS = 60_000;

function toTimestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number < 1_000_000_000_000 ? number * 1000 : number;
}

function resolveWorkerStatus(worker) {
  const explicit = String(worker.status || worker.state || '').toLowerCase();
  if (explicit) return explicit;
  const heartbeat = toTimestamp(worker.lastHeartbeat || worker.updatedAt);
  if (heartbeat && Date.now() - heartbeat > HEARTBEAT_STALE_MS) return 'stale';
  return 'active';
}

function formatRelativeTime(value) {
  const timestamp = toTimestamp(value);
  if (!timestamp) return '-';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 5) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function formatDateTime(value) {
  const timestamp = toTimestamp(value);
  if (!timestamp) return '-';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('zh-CN');
}

const DAEMON_PERMISSION_OPTIONS = [
  ['default', '默认确认'],
  ['acceptEdits', '自动接受编辑'],
  ['plan', '计划模式'],
  ['dontAsk', '不主动询问'],
  ['auto', '自动模式'],
  ['bypassPermissions', '跳过权限确认'],
];

function DaemonServiceInstallDialog({ open, busy, error, onCancel, onSubmit }) {
  const [port, setPort] = React.useState('');
  const [permissionMode, setPermissionMode] = React.useState('default');
  const [validationError, setValidationError] = React.useState('');

  React.useEffect(() => {
    if (!open) return;
    setPort('');
    setPermissionMode('default');
    setValidationError('');
  }, [open]);

  if (!open) return null;

  const submit = () => {
    const portText = port.trim();
    if (portText) {
      const value = Number(portText);
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        setValidationError('端口必须是 1 到 65535 之间的整数');
        return;
      }
    }
    setValidationError('');
    onSubmit({ port: portText, permissionMode });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4" role="dialog" aria-modal="true" aria-label="安装 Daemon 系统服务" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onCancel(); }}>
      <div className="w-full max-w-md rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-5 shadow-xl">
        <div className="text-sm font-semibold text-[var(--color-text-primary)]">安装 Daemon 系统服务</div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-[var(--color-text-secondary)]">端口
            <input className="input-field mt-1 w-full font-mono" inputMode="numeric" value={port} disabled={busy} onChange={(event) => { setPort(event.target.value); setValidationError(''); }} placeholder="自动分配" />
          </label>
          <label className="text-xs text-[var(--color-text-secondary)]">权限模式
            <select className="input-field mt-1 w-full" value={permissionMode} disabled={busy} onChange={(event) => setPermissionMode(event.target.value)}>{DAEMON_PERMISSION_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          </label>
        </div>
        <div className="mt-3 text-xs leading-5 text-[var(--color-text-muted)]">Windows 将创建用户级任务计划，并在登录后自动启动 CodeBuddy Daemon。</div>
        {permissionMode === 'bypassPermissions' ? <div className="mt-3 rounded-md border border-[rgba(250,204,21,0.25)] bg-[rgba(250,204,21,0.08)] px-3 py-2 text-xs text-[var(--color-accent-yellow)]">跳过权限确认会让后台会话直接执行操作，仅应在隔离环境中使用。</div> : null}
        {(validationError || error) ? <div className="mt-3 text-xs text-[var(--color-accent-red)]">{validationError || error}</div> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost px-3 py-1.5 text-xs" disabled={busy} onClick={onCancel}>取消</button>
          <button className="btn-primary px-3 py-1.5 text-xs" disabled={busy} onClick={submit}>{busy ? '安装中...' : '安装服务'}</button>
        </div>
      </div>
    </div>
  );
}

export default function ReplicaWorkersView() {
  const { workers, refreshWorkers, workersError, setRoute } = useStore(useShallow((state) => ({
    workers: state.workers,
    refreshWorkers: state.refreshWorkers,
    workersError: state.workersError,
    setRoute: state.setRoute,
  })));
  const activeProjectId = useStore((state) => state.activeProjectId);
  const [refreshing, setRefreshing] = React.useState(false);
  const [expandedPid, setExpandedPid] = React.useState(null);
  const [searchTerm, setSearchTerm] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [daemon, setDaemon] = React.useState(null);
  const [daemonBusy, setDaemonBusy] = React.useState(false);
  const [daemonService, setDaemonService] = React.useState(null);
  const [daemonServiceBusy, setDaemonServiceBusy] = React.useState(false);
  const [daemonServiceError, setDaemonServiceError] = React.useState('');
  const [daemonServiceNotice, setDaemonServiceNotice] = React.useState('');
  const [daemonInstallOpen, setDaemonInstallOpen] = React.useState(false);
  const [daemonUninstallOpen, setDaemonUninstallOpen] = React.useState(false);
  const [workerBusyPid, setWorkerBusyPid] = React.useState(null);
  const [actionError, setActionError] = React.useState('');
  const [pendingStopWorker, setPendingStopWorker] = React.useState(null);
  const [workerActionError, setWorkerActionError] = React.useState('');
  const projectGenerationRef = React.useRef(0);
  const refreshRequestRef = React.useRef(0);
  const daemonServiceOperationRef = React.useRef(null);

  const handleRefresh = React.useCallback(async () => {
    const projectId = activeProjectId;
    const requestId = ++refreshRequestRef.current;
    setRefreshing(true);
    setActionError('');
    try {
      const [workersResult, daemonResult, daemonServiceResult] = await Promise.allSettled([
        refreshWorkers(),
        fetchDaemonStatus(),
        getDaemonServiceStatus(),
      ]);
      if (requestId !== refreshRequestRef.current || useStore.getState().activeProjectId !== projectId) return false;
      if (workersResult.status === 'rejected') {
        setActionError(workersResult.reason?.message || '加载 Worker 失败');
      }
      if (daemonResult.status === 'fulfilled') {
        setDaemon(daemonResult.value);
      } else {
        setActionError((current) => current || daemonResult.reason?.message || '加载 Daemon 状态失败');
      }
      if (daemonServiceResult.status === 'fulfilled') {
        setDaemonService(daemonServiceResult.value);
        setDaemonServiceError('');
      } else {
        setDaemonServiceError(daemonServiceResult.reason?.message || '加载 Daemon 系统服务状态失败');
      }
      return workersResult.status === 'fulfilled' && workersResult.value !== false && daemonResult.status === 'fulfilled' && daemonServiceResult.status === 'fulfilled';
    } finally {
      if (requestId === refreshRequestRef.current && useStore.getState().activeProjectId === projectId) {
        setRefreshing(false);
        setLoading(false);
      }
    }
  }, [activeProjectId, refreshWorkers]);

  React.useEffect(() => {
    projectGenerationRef.current += 1;
    refreshRequestRef.current += 1;
    setDaemon(null);
    setDaemonService(null);
    setLoading(true);
    setRefreshing(false);
    setDaemonBusy(false);
    setDaemonServiceBusy(false);
    setDaemonServiceError('');
    setDaemonServiceNotice('');
    setDaemonInstallOpen(false);
    setDaemonUninstallOpen(false);
    daemonServiceOperationRef.current = null;
    setWorkerBusyPid(null);
    setExpandedPid(null);
    setActionError('');
    setPendingStopWorker(null);
    setWorkerActionError('');
    handleRefresh();
  }, [activeProjectId, handleRefresh]);

  const runDaemonAction = async (action, fallbackMessage) => {
    const projectId = activeProjectId;
    const generation = projectGenerationRef.current;
    setDaemonBusy(true);
    setActionError('');
    try {
      await action();
      if (projectId !== useStore.getState().activeProjectId || generation !== projectGenerationRef.current) return;
      await handleRefresh();
    } catch (error) {
      if (projectId === useStore.getState().activeProjectId && generation === projectGenerationRef.current) {
        setActionError(error?.message || fallbackMessage);
      }
    } finally {
      if (projectId === useStore.getState().activeProjectId && generation === projectGenerationRef.current) setDaemonBusy(false);
    }
  };

  const submitDaemonServiceInstall = async (options) => {
    if (daemonServiceOperationRef.current) return;
    const operation = {};
    daemonServiceOperationRef.current = operation;
    const generation = projectGenerationRef.current;
    setDaemonServiceBusy(true);
    setDaemonServiceError('');
    setDaemonServiceNotice('');
    try {
      const result = await installDaemonService(options);
      if (daemonServiceOperationRef.current !== operation || generation !== projectGenerationRef.current) return;
      setDaemonService(result?.snapshot || await getDaemonServiceStatus());
      setDaemonInstallOpen(false);
      setDaemonServiceNotice(result?.output || 'Daemon 系统服务已安装');
    } catch (error) {
      if (daemonServiceOperationRef.current === operation && generation === projectGenerationRef.current) setDaemonServiceError(error?.message || '安装 Daemon 系统服务失败');
    } finally {
      if (daemonServiceOperationRef.current === operation) daemonServiceOperationRef.current = null;
      if (generation === projectGenerationRef.current) setDaemonServiceBusy(false);
    }
  };

  const confirmDaemonServiceUninstall = async () => {
    if (daemonServiceOperationRef.current) return;
    const operation = {};
    daemonServiceOperationRef.current = operation;
    const generation = projectGenerationRef.current;
    setDaemonServiceBusy(true);
    setDaemonServiceError('');
    setDaemonServiceNotice('');
    try {
      const result = await uninstallDaemonService();
      if (daemonServiceOperationRef.current !== operation || generation !== projectGenerationRef.current) return;
      setDaemonService(result?.snapshot || await getDaemonServiceStatus());
      setDaemonUninstallOpen(false);
      setDaemonServiceNotice(result?.output || 'Daemon 系统服务已卸载');
    } catch (error) {
      if (daemonServiceOperationRef.current === operation && generation === projectGenerationRef.current) setDaemonServiceError(error?.message || '卸载 Daemon 系统服务失败');
    } finally {
      if (daemonServiceOperationRef.current === operation) daemonServiceOperationRef.current = null;
      if (generation === projectGenerationRef.current) setDaemonServiceBusy(false);
    }
  };

  const requestStopWorker = (worker) => {
    if (!worker?.pid) return;
    if (worker.isCurrent) {
      setActionError('当前 Worker 正在为此项目提供服务，请在“项目运行时”页面停止或重启。');
      return;
    }
    setPendingStopWorker(worker);
    setWorkerActionError('');
  };

  const closeStopWorkerDialog = () => {
    if (workerBusyPid) return;
    setPendingStopWorker(null);
    setWorkerActionError('');
  };

  const confirmStopWorker = async () => {
    const worker = pendingStopWorker;
    if (!worker?.pid || workerBusyPid) return;
    const projectId = activeProjectId;
    const generation = projectGenerationRef.current;
    setWorkerBusyPid(worker.pid);
    setWorkerActionError('');
    try {
      await stopWorker(worker.pid);
      if (projectId !== useStore.getState().activeProjectId || generation !== projectGenerationRef.current) return;
      await refreshWorkers();
      if (projectId === useStore.getState().activeProjectId && generation === projectGenerationRef.current) setPendingStopWorker(null);
    } catch (error) {
      if (projectId === useStore.getState().activeProjectId && generation === projectGenerationRef.current) {
        setWorkerActionError(error?.message || '终止 Worker 失败');
      }
    } finally {
      if (projectId === useStore.getState().activeProjectId && generation === projectGenerationRef.current) setWorkerBusyPid(null);
    }
  };

  const workersList = Array.isArray(workers)
    ? [...workers].sort(
        (left, right) => Number(Boolean(right.isCurrent)) - Number(Boolean(left.isCurrent)) ||
          Number(right.lastHeartbeat || right.updatedAt || 0) - Number(left.lastHeartbeat || left.updatedAt || 0),
      )
    : [];

  // Search filter
  const term = searchTerm.trim().toLowerCase();
  const filtered = term
    ? workersList.filter(
        (w) =>
          (w.kind || '').toLowerCase().includes(term) ||
          String(w.pid || '').includes(term) ||
          (w.sessionId || '').toLowerCase().includes(term) ||
          (w.cwd || '').toLowerCase().includes(term) ||
          (w.endpoint || w.url || '').toLowerCase().includes(term) ||
          (w.hostname || '').toLowerCase().includes(term) ||
          (w.mode || '').toLowerCase().includes(term)
      )
    : workersList;

  const getStatusTag = (w) => {
    const status = resolveWorkerStatus(w);
    const cfg = STATUS_CONFIG[status] || { klass: 'tag-green', label: w.status || w.state || status };
    return <span className={`tag ${cfg.klass}`}>{cfg.label}</span>;
  };

  const handleViewLogs = (w) => {
    try {
      sessionStorage.setItem('logs-preferred-worker-pid', String(w.pid));
    } catch (_) {}
    setRoute('logs');
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[var(--color-bg-primary)]">
      <div className="mx-auto w-full max-w-5xl px-8 py-8">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">Agent 实例管理</h1>
            {!loading ? <span className="rounded bg-[var(--color-bg-tertiary)] px-2 py-0.5 text-xs text-[var(--color-text-muted)]">{workersList.length}</span> : null}
          </div>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-1.5 rounded-md border border-[var(--color-border-default)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors disabled:opacity-50"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={refreshing ? 'animate-spin' : ''}>
              <path d="M1 8a7 7 0 0113.29-4M15 8a7 7 0 01-13.29 4" />
              <path d="M13 1v4h-4M3 15v-4h4" />
            </svg>
            {refreshing ? '刷新中...' : '刷新'}
          </button>
        </div>

        <div className="mb-5 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-[var(--color-text-primary)]">Daemon</div>
              <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                状态：{daemon?.status || '未知'}{daemon?.pid ? ` · PID ${daemon.pid}` : ''}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {daemon?.status === 'running' ? (
                <button className="btn-ghost text-xs" disabled={daemonBusy} onClick={() => runDaemonAction(stopDaemon, '停止 Daemon 失败')}>停止</button>
              ) : (
                <button className="btn-primary text-xs" disabled={daemonBusy} onClick={() => runDaemonAction(startDaemon, '启动 Daemon 失败')}>启动</button>
              )}
              <button className="btn-ghost text-xs" disabled={daemonBusy} onClick={() => runDaemonAction(restartDaemon, '重启 Daemon 失败')}>
                {daemonBusy ? '处理中...' : '重启'}
              </button>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border-default)] pt-4">
            <div>
              <div className="text-sm font-medium text-[var(--color-text-primary)]">登录自启动</div>
              <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                {daemonService?.systemService?.installed ? '已安装' : daemonService ? '未安装' : '状态未知'}
                {daemonService?.systemService?.backend ? ` · ${daemonService.systemService.backend}` : ''}
              </div>
              {daemonServiceNotice ? <div className="mt-2 text-xs whitespace-pre-wrap text-[var(--color-accent-green)]">{daemonServiceNotice}</div> : null}
              {daemonServiceError ? <div className="mt-2 text-xs text-[var(--color-accent-red)]">{daemonServiceError}</div> : null}
            </div>
            <div className="flex items-center gap-2">
              {daemonService?.systemService?.installed ? <button className="btn-ghost text-xs text-[var(--color-accent-red)]" disabled={daemonServiceBusy} onClick={() => { setDaemonServiceError(''); setDaemonUninstallOpen(true); }}>卸载自启动</button> : <button className="btn-primary text-xs" disabled={daemonServiceBusy || !daemonService} onClick={() => { setDaemonServiceError(''); setDaemonInstallOpen(true); }}>安装自启动</button>}
            </div>
          </div>
        </div>

        {/* Error banner */}
        {(workersError || actionError) && (
          <div className="mb-4 rounded-lg border border-[rgba(248,113,113,0.2)] bg-[rgba(248,113,113,0.1)] px-4 py-2.5 text-sm text-[#f87171]">
            {actionError || workersError}
            <button className="ml-3 underline text-xs" onClick={handleRefresh}>重试</button>
          </div>
        )}

        {/* Search */}
        <div className="mb-4">
          <input
            className="input-field max-w-[320px]"
            type="text"
            placeholder="搜索 Worker、目录、Endpoint 或主机..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>

        {/* Loading skeleton */}
        {loading && (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-4 shimmer"
              >
                <div className="flex items-center gap-2 mb-2">
                  <div className="skeleton h-5 w-16 rounded-full" />
                  <div className="skeleton h-5 w-12 rounded-full" />
                  <div className="skeleton h-3 w-14 ml-auto" />
                </div>
                <div className="space-y-1.5">
                  <div className="skeleton h-3 w-2/3" />
                  <div className="skeleton h-3 w-1/2" />
                  <div className="skeleton h-3 w-3/4" />
                </div>
                <div className="flex items-center gap-1 mt-3 pt-2 border-t border-[var(--color-border-muted)]">
                  <div className="skeleton h-3 w-10" />
                  <div className="skeleton h-3 w-10" />
                  <div className="skeleton h-3 w-10" />
                  <div className="skeleton h-3 w-14 ml-auto" />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loading && filtered.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[var(--color-border-muted)] py-16 text-center">
            <p className="text-sm text-[var(--color-text-muted)]">
              {workersList.length === 0 ? '暂无活跃 worker' : '无匹配 Worker'}
            </p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              {workersList.length === 0 ? 'Worker 进程将在需要时自动创建' : '尝试更换搜索条件'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map((w, idx) => {
              const isExpanded = expandedPid === w.pid;
              const resolvedStatus = resolveWorkerStatus(w);
              return (
                <div
                  key={w.pid || idx}
                  className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)]"
                >
                  {/* Card header - clickable to expand */}
                  <div
                    className="p-4 cursor-pointer hover:bg-[var(--color-bg-hover)] transition-colors"
                    onClick={() => setExpandedPid(isExpanded ? null : w.pid)}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <span className="rounded-full bg-[rgba(74,222,128,0.1)] px-2 py-0.5 text-[10px] font-medium text-[#4ade80]">
                        {w.kind || 'Worker'}
                      </span>
                      {getStatusTag(w)}
                      {w.isCurrent ? <span className="rounded bg-[rgba(59,130,246,0.12)] px-2 py-0.5 text-[10px] text-[var(--color-accent-blue)]">当前运行时</span> : null}
                      <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">
                        PID {w.pid || '-'}
                      </span>
                    </div>
                    <div className="space-y-1 text-xs text-[var(--color-text-secondary)]">
                      <div className="truncate">Session: {w.sessionId || '-'}</div>
                      <div className="truncate">CWD: {w.cwd || '-'}</div>
                      <div>Version: {w.version || '-'} / OS: {w.os || '-'}</div>
                      <div className="truncate" title={w.endpoint || w.url || ''}>Endpoint: {w.endpoint || w.url || '-'}</div>
                      <div>Mode: {w.mode || '-'} / Host: {w.hostname || w.host || '-'}</div>
                      <div>Heartbeat: {formatRelativeTime(w.lastHeartbeat || w.updatedAt)}</div>
                    </div>

                    {/* Action buttons */}
                    <div className="flex items-center gap-1 mt-3 pt-2 border-t border-[var(--color-border-muted)]">
                      <button
                        className="btn-ghost text-xs text-[var(--color-accent-blue)]"
                        onClick={(e) => { e.stopPropagation(); handleViewLogs(w); }}
                      >
                        日志
                      </button>
                      <button
                        className="btn-ghost text-xs text-[var(--color-error)]"
                        onClick={(e) => { e.stopPropagation(); requestStopWorker(w); }}
                        disabled={w.isCurrent || workerBusyPid === w.pid}
                        title={w.isCurrent ? '当前 Worker 请在项目运行时页面管理' : '终止这个 Worker'}
                      >
                        {w.isCurrent ? '当前运行时' : (workerBusyPid === w.pid ? '终止中...' : '终止')}
                      </button>
                      <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">
                        {isExpanded ? '收起' : '展开详情'}
                      </span>
                    </div>
                  </div>

                  {/* Expanded detail panel */}
                  <div
                    className={`overflow-hidden transition-all duration-300 ease-in-out ${
                      isExpanded ? 'max-h-[800px] opacity-100' : 'max-h-0 opacity-0'
                    }`}
                  >
                    <div className="border-t border-[var(--color-border-default)] p-4 bg-[var(--color-bg-card)] rounded-b-lg">
                      <h4 className="text-xs font-semibold text-[var(--color-text-primary)] mb-3">Worker 详情</h4>
                      <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
                        <Field label="PID" value={w.pid} />
                        <Field label="Kind" value={w.kind} />
                        <Field label="Current" value={w.isCurrent ? '是' : '否'} />
                        <Field label="Status" value={STATUS_CONFIG[resolvedStatus]?.label || resolvedStatus} />
                        <Field label="Session ID" value={w.sessionId} />
                        <Field label="Mode" value={w.mode} />
                        <Field label="CWD" value={w.cwd} />
                        <Field label="Endpoint" value={w.endpoint || w.url} />
                        <Field label="Version" value={w.version} />
                        <Field label="OS" value={w.os} />
                        <Field label="Arch" value={w.arch || w.architecture} />
                        <Field label="Host" value={w.host || w.hostname} />
                        <Field label="Started" value={formatDateTime(w.startedAt || w.createdAt || w.startTime)} />
                        <Field label="Heartbeat" value={formatRelativeTime(w.lastHeartbeat || w.updatedAt)} />
                        <Field label="Updated" value={formatDateTime(w.updatedAt || w.lastHeartbeat)} />
                        <Field label="Port" value={w.port} />
                        <Field label="Command" value={w.command || w.cmd} />
                        <Field label="CPU" value={w.cpu != null ? `${w.cpu}%` : null} />
                        <Field label="Memory" value={w.memory || w.mem} />
                      </div>
                      {w.args && w.args.length > 0 && (
                        <div className="mt-3">
                          <div className="text-[10px] font-medium text-[var(--color-text-muted)] mb-1">Args</div>
                          <pre className="text-xs text-[var(--color-text-secondary)] bg-[var(--color-bg-code)] rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                            {Array.isArray(w.args) ? w.args.join(' ') : String(w.args)}
                          </pre>
                        </div>
                      )}
                      {w.env && Object.keys(w.env).length > 0 && (
                        <div className="mt-3">
                          <div className="text-[10px] font-medium text-[var(--color-text-muted)] mb-1">Env</div>
                          <pre className="text-xs text-[var(--color-text-secondary)] bg-[var(--color-bg-code)] rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                            {Object.entries(w.env)
                              .map(([k, v]) => `${k}=${v}`)
                              .join('\n')}
                          </pre>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <DaemonServiceInstallDialog open={daemonInstallOpen} busy={daemonServiceBusy} error={daemonServiceError} onCancel={() => { if (!daemonServiceBusy) { setDaemonInstallOpen(false); setDaemonServiceError(''); } }} onSubmit={submitDaemonServiceInstall} />
      <ActionConfirmDialog open={daemonUninstallOpen} title="卸载 Daemon 登录自启动？" description="将删除 CodeBuddy Daemon 的系统服务注册。当前已运行的 Daemon 不会被此操作强制终止。" confirmLabel="卸载自启动" busy={daemonServiceBusy} error={daemonServiceError} onCancel={() => { if (!daemonServiceBusy) { setDaemonUninstallOpen(false); setDaemonServiceError(''); } }} onConfirm={confirmDaemonServiceUninstall} />
      <ActionConfirmDialog
        open={Boolean(pendingStopWorker)}
        title="终止 Worker？"
        description={pendingStopWorker ? (
          <><div className="font-medium text-[var(--color-text-primary)]">PID {pendingStopWorker.pid} · {pendingStopWorker.kind || 'Worker'}</div><div className="mt-1 break-words">{pendingStopWorker.cwd || pendingStopWorker.endpoint || '-'}</div><div className="mt-2">正在执行的任务会立即中断，此操作无法撤销。</div></>
        ) : null}
        confirmLabel="终止 Worker"
        busy={Boolean(workerBusyPid)}
        error={workerActionError}
        onCancel={closeStopWorkerDialog}
        onConfirm={confirmStopWorker}
      />
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className="text-[var(--color-text-muted)] shrink-0 min-w-[80px]">{label}</span>
      <span className="truncate text-[var(--color-text-secondary)]" title={String(value ?? '-')}>{value ?? '-'}</span>
    </div>
  );
}
