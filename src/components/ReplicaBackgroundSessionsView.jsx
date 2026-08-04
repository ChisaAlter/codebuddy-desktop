import React from 'react';
import ActionConfirmDialog from './ActionConfirmDialog';
import { useStore } from '../store';
import { useViewActive } from '../lib/use-view-active';
import { copyTextToClipboard } from '../lib/clipboard';
import {
  attachBackgroundSession,
  killBackgroundSession,
  listBackgroundSessions,
  openBackgroundSessionEndpoint,
  readBackgroundSessionLogs,
  startBackgroundSession,
} from '../lib/background-sessions';

const KIND_LABELS = {
  bg: '后台任务',
  interactive: '交互会话',
  daemon: 'Daemon',
  prewarm: '预热进程',
};

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('zh-CN');
}

function formatRelative(value) {
  if (!value) return '-';
  const elapsed = Math.max(0, Date.now() - Number(value));
  if (!Number.isFinite(elapsed)) return '-';
  if (elapsed < 60000) return `${Math.max(0, Math.floor(elapsed / 1000))} 秒前`;
  if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)} 分钟前`;
  if (elapsed < 86400000) return `${Math.floor(elapsed / 3600000)} 小时前`;
  return `${Math.floor(elapsed / 86400000)} 天前`;
}

function StartBackgroundDialog({ open, busy, error, projects, existingNames, onCancel, onSubmit }) {
  const [name, setName] = React.useState('');
  const [projectId, setProjectId] = React.useState('');
  const [prompt, setPrompt] = React.useState('');
  const [validationError, setValidationError] = React.useState('');

  React.useEffect(() => {
    if (!open) return;
    setName(`bg-${String(Date.now()).slice(-6)}`);
    setProjectId(projects.find((project) => project.active)?.id || projects[0]?.id || '');
    setPrompt('');
    setValidationError('');
  }, [open]);

  if (!open) return null;

  const submit = () => {
    const normalizedName = name.trim();
    const project = projects.find((item) => item.id === projectId);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(normalizedName)) {
      setValidationError('名称只能包含字母、数字、点、连字符和下划线');
      return;
    }
    if (existingNames.has(normalizedName.toLowerCase())) {
      setValidationError('已有同名后台会话，请更换名称');
      return;
    }
    if (!project?.workspacePath) {
      setValidationError('请选择有效项目');
      return;
    }
    if (!prompt.trim()) {
      setValidationError('请输入后台任务内容');
      return;
    }
    if (prompt.trim().length > 20000) {
      setValidationError('后台任务内容不能超过 20000 个字符');
      return;
    }
    setValidationError('');
    onSubmit({ name: normalizedName, cwd: project.workspacePath, prompt: prompt.trim() });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4" role="dialog" aria-modal="true" aria-label="启动后台会话" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onCancel(); }}>
      <div className="w-full max-w-xl rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-5 shadow-xl">
        <div className="text-sm font-semibold text-[var(--color-text-primary)]">启动后台会话</div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-[var(--color-text-secondary)]">名称
            <input className="input-field mt-1 w-full font-mono" value={name} disabled={busy} onChange={(event) => { setName(event.target.value); setValidationError(''); }} />
          </label>
          <label className="text-xs text-[var(--color-text-secondary)]">项目
            <select className="input-field mt-1 w-full" value={projectId} disabled={busy} onChange={(event) => { setProjectId(event.target.value); setValidationError(''); }}>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <label className="sm:col-span-2 text-xs text-[var(--color-text-secondary)]">任务内容
            <textarea className="input-field mt-1 min-h-36 w-full resize-y" value={prompt} disabled={busy} onChange={(event) => { setPrompt(event.target.value); setValidationError(''); }} placeholder="描述需要 CodeBuddy 在后台完成的工作..." />
          </label>
        </div>
        <div className="mt-3 text-xs leading-5 text-[var(--color-text-muted)]">后台任务遵循 CodeBuddy CLI 的非交互运行规则，输出写入独立日志，可随时在此终止。</div>
        {(validationError || error) ? <div className="mt-3 text-xs text-[var(--color-accent-red)]">{validationError || error}</div> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost px-3 py-1.5 text-xs" disabled={busy} onClick={onCancel}>取消</button>
          <button className="btn-primary px-3 py-1.5 text-xs" disabled={busy || !projects.length} onClick={submit}>{busy ? '启动中...' : '启动任务'}</button>
        </div>
      </div>
    </div>
  );
}

function BackgroundLogsDialog({ value, autoRefresh, copyStatus, onClose, onRefresh, onToggleAutoRefresh, onCopy }) {
  if (!value) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4" role="dialog" aria-modal="true" aria-label="后台会话日志" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="flex max-h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] shadow-xl">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border-default)] px-5 py-4">
          <div className="min-w-0"><div className="truncate text-sm font-semibold text-[var(--color-text-primary)]">{value.session.name || `PID ${value.session.pid}`}</div><div className="mt-1 font-mono text-[10px] text-[var(--color-text-muted)]">PID {value.session.pid}</div></div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--color-text-muted)]">自动刷新</span>
            <button type="button" role="switch" aria-checked={autoRefresh} aria-label="自动刷新后台日志" className={`toggle-switch ${autoRefresh ? 'toggle-switch-on' : 'toggle-switch-off'}`} onClick={onToggleAutoRefresh}><div className={`toggle-knob ${autoRefresh ? 'toggle-knob-on' : ''}`} /></button>
            <button className="btn-ghost px-2.5 py-1 text-xs" disabled={value.loading} onClick={onRefresh}>{value.loading ? '刷新中...' : '刷新'}</button>
            <button className="btn-ghost min-w-[62px] px-2.5 py-1 text-xs" disabled={!value.content} onClick={onCopy}>{copyStatus === 'success' ? '已复制' : copyStatus === 'error' ? '复制失败' : '复制'}</button>
            <button className="btn-ghost px-2.5 py-1 text-xs" onClick={onClose}>关闭</button>
          </div>
        </div>
        {value.error ? <div className="mx-5 mt-4 rounded-md border border-[rgba(248,113,113,0.25)] bg-[rgba(248,113,113,0.08)] px-4 py-3 text-xs text-[var(--color-accent-red)]">{value.error}</div> : null}
        {value.truncated ? <div className="mx-5 mt-4 rounded-md border border-[rgba(250,204,21,0.25)] bg-[rgba(250,204,21,0.08)] px-4 py-3 text-xs text-[var(--color-accent-yellow)]">日志较大，仅显示最新 1 MB。</div> : null}
        <div className="min-h-0 flex-1 overflow-auto p-5">
          {value.loading && !value.content ? <div className="py-20 text-center text-sm text-[var(--color-text-muted)]">正在读取日志...</div> : value.content ? <pre className="min-h-64 whitespace-pre-wrap break-words rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] p-4 font-mono text-xs leading-5 text-[var(--color-text-secondary)]">{value.content}</pre> : <div className="py-20 text-center text-sm text-[var(--color-text-muted)]">暂无日志内容</div>}
        </div>
      </div>
    </div>
  );
}

export default function ReplicaBackgroundSessionsView() {
  // M-perf (keep-alive): pause the 10s refresh while this view is hidden.
  const active = useViewActive('instances');
  const projectsById = useStore((state) => state.projectsById);
  const projectOrder = useStore((state) => state.projectOrder);
  const activeProjectId = useStore((state) => state.activeProjectId);
  const [sessions, setSessions] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [kindFilter, setKindFilter] = React.useState('all');
  const [startOpen, setStartOpen] = React.useState(false);
  const [startBusy, setStartBusy] = React.useState(false);
  const [startError, setStartError] = React.useState('');
  const [pendingKill, setPendingKill] = React.useState(null);
  const [killBusy, setKillBusy] = React.useState(false);
  const [killError, setKillError] = React.useState('');
  const [attachBusyPid, setAttachBusyPid] = React.useState(null);
  const [logsDialog, setLogsDialog] = React.useState(null);
  const [logsAutoRefresh, setLogsAutoRefresh] = React.useState(false);
  const [copyStatus, setCopyStatus] = React.useState('idle');
  const requestRef = React.useRef(0);
  const logsRequestRef = React.useRef(0);
  const operationRef = React.useRef(null);
  const mountedRef = React.useRef(true);
  const copyTimerRef = React.useRef(null);

  const projects = React.useMemo(
    () => projectOrder.map((id) => projectsById[id]).filter(Boolean).map((project) => ({ ...project, active: project.id === activeProjectId })),
    [activeProjectId, projectOrder, projectsById],
  );

  const refresh = React.useCallback(async ({ initial = false, silent = false } = {}) => {
    const requestId = ++requestRef.current;
    if (initial) setLoading(true);
    else if (!silent) setRefreshing(true);
    if (!silent) setError('');
    try {
      const result = await listBackgroundSessions();
      if (!mountedRef.current || requestId !== requestRef.current) return null;
      setSessions(Array.isArray(result?.sessions) ? result.sessions : []);
      return result;
    } catch (refreshError) {
      if (mountedRef.current && requestId === requestRef.current && !silent) setError(refreshError?.message || '读取后台会话失败');
      return null;
    } finally {
      if (mountedRef.current && requestId === requestRef.current) {
        setLoading(false);
        if (!silent) setRefreshing(false);
      }
    }
  }, []);

  React.useEffect(() => {
    // M-perf (keep-alive): pause the 10s refresh while this view is hidden.
    if (!active) return undefined;
    mountedRef.current = true;
    refresh({ initial: true });
    const timer = setInterval(() => refresh({ silent: true }), 10000);
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      logsRequestRef.current += 1;
      clearInterval(timer);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, [active, refresh]);

  const submitStart = async (request) => {
    if (operationRef.current) return;
    const operation = {};
    operationRef.current = operation;
    setStartBusy(true);
    setStartError('');
    setNotice('');
    try {
      const result = await startBackgroundSession(request);
      if (!mountedRef.current || operationRef.current !== operation) return;
      setSessions(Array.isArray(result?.snapshot?.sessions) ? result.snapshot.sessions : []);
      setStartOpen(false);
      setNotice(result?.output || `后台会话 ${request.name} 已启动`);
    } catch (operationError) {
      if (mountedRef.current && operationRef.current === operation) setStartError(operationError?.message || '启动后台会话失败');
    } finally {
      if (operationRef.current === operation) operationRef.current = null;
      if (mountedRef.current) setStartBusy(false);
    }
  };

  const confirmKill = async () => {
    if (!pendingKill || operationRef.current) return;
    const operation = {};
    operationRef.current = operation;
    const target = pendingKill;
    setKillBusy(true);
    setKillError('');
    setNotice('');
    try {
      const result = await killBackgroundSession(target.pid);
      if (!mountedRef.current || operationRef.current !== operation) return;
      const nextSessions = Array.isArray(result?.snapshot?.sessions) ? result.snapshot.sessions : [];
      if (nextSessions.some((item) => item.pid === target.pid)) throw new Error('CodeBuddy 已返回成功，但该后台会话仍然存在，请刷新后重试');
      setSessions(nextSessions);
      setPendingKill(null);
      setNotice(result?.output || `后台会话 ${target.name || target.pid} 已终止`);
    } catch (operationError) {
      if (mountedRef.current && operationRef.current === operation) setKillError(operationError?.message || '终止后台会话失败');
    } finally {
      if (operationRef.current === operation) operationRef.current = null;
      if (mountedRef.current) setKillBusy(false);
    }
  };

  const loadLogs = React.useCallback(async (session) => {
    const requestId = ++logsRequestRef.current;
    setLogsDialog((current) => ({ session, content: current?.session?.pid === session.pid ? current.content : '', truncated: false, loading: true, error: '' }));
    try {
      const result = await readBackgroundSessionLogs(session.pid);
      if (!mountedRef.current || requestId !== logsRequestRef.current) return;
      setLogsDialog((current) => current?.session?.pid === session.pid ? { session, content: result?.content || '', truncated: !!result?.truncated, loading: false, error: '' } : current);
    } catch (logError) {
      if (mountedRef.current && requestId === logsRequestRef.current) setLogsDialog((current) => current?.session?.pid === session.pid ? { ...current, loading: false, error: logError?.message || '读取后台日志失败' } : current);
    }
  }, []);

  React.useEffect(() => {
    if (!logsAutoRefresh || !logsDialog?.session) return;
    const timer = setInterval(() => loadLogs(logsDialog.session), 5000);
    return () => clearInterval(timer);
  }, [loadLogs, logsAutoRefresh, logsDialog?.session]);

  const copyLogs = async () => {
    if (!logsDialog?.content) return;
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    try {
      await copyTextToClipboard(logsDialog.content);
      setCopyStatus('success');
    } catch (_) {
      setCopyStatus('error');
    }
    copyTimerRef.current = setTimeout(() => { copyTimerRef.current = null; setCopyStatus('idle'); }, 1800);
  };

  const openEndpoint = async (session) => {
    setError('');
    try {
      await openBackgroundSessionEndpoint(session.endpoint);
    } catch (endpointError) {
      setError(endpointError?.message || '打开 Endpoint 失败');
    }
  };

  const attachSession = async (session) => {
    if (operationRef.current) return;
    const operation = {};
    operationRef.current = operation;
    setAttachBusyPid(session.pid);
    setError('');
    setNotice('');
    try {
      const result = await attachBackgroundSession(session.pid);
      if (!mountedRef.current || operationRef.current !== operation) return;
      setNotice(`已在 ${result?.terminal || '交互终端'} 中接管 ${session.name || `PID ${session.pid}`}。关闭终端窗口不会终止后台任务。`);
    } catch (attachError) {
      if (mountedRef.current && operationRef.current === operation) setError(attachError?.message || '接管后台会话失败');
    } finally {
      if (operationRef.current === operation) operationRef.current = null;
      if (mountedRef.current) setAttachBusyPid(null);
    }
  };

  const query = search.trim().toLowerCase();
  const filtered = sessions.filter((session) => {
    if (kindFilter !== 'all' && session.kind !== kindFilter) return false;
    if (!query) return true;
    return [session.pid, session.name, session.sessionId, session.kind, session.status, session.cwd, session.endpoint, session.version, session.hostname].join(' ').toLowerCase().includes(query);
  });
  const existingNames = new Set(sessions.map((session) => session.name?.toLowerCase()).filter(Boolean));
  const kinds = Array.from(new Set(sessions.map((session) => session.kind).filter(Boolean)));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border-default)] px-6 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <input className="input-field w-64" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索名称、PID、目录或 Endpoint..." />
          <select className="input-field w-36" value={kindFilter} onChange={(event) => setKindFilter(event.target.value)}><option value="all">全部类型</option>{kinds.map((kind) => <option key={kind} value={kind}>{KIND_LABELS[kind] || kind}</option>)}</select>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost px-3 py-1.5 text-xs" disabled={refreshing || startBusy || killBusy || Boolean(attachBusyPid)} onClick={() => refresh()}>{refreshing ? '刷新中...' : '刷新'}</button>
          <button className="btn-primary px-3 py-1.5 text-xs" disabled={!projects.length || startBusy || killBusy || Boolean(attachBusyPid)} onClick={() => { setStartError(''); setStartOpen(true); }}>启动后台任务</button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {error ? <div className="mb-4 rounded-md border border-[rgba(248,113,113,0.25)] bg-[rgba(248,113,113,0.08)] px-4 py-3 text-xs text-[var(--color-accent-red)]">{error}</div> : null}
        {notice ? <div className="mb-4 rounded-md border border-[rgba(74,222,128,0.25)] bg-[rgba(74,222,128,0.08)] px-4 py-3 text-xs whitespace-pre-wrap text-[var(--color-accent-green)]">{notice}</div> : null}
        {loading ? <div className="py-20 text-center text-sm text-[var(--color-text-muted)]">正在读取 CodeBuddy 会话...</div> : filtered.length ? (
          <div className="overflow-hidden rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)]">
            {filtered.map((session, index) => {
              const heartbeatAge = session.lastHeartbeat ? Date.now() - session.lastHeartbeat : null;
              const active = heartbeatAge == null || heartbeatAge < 45000;
              const canKill = session.kind === 'bg';
              const canAttach = session.kind === 'bg';
              return <section key={`${session.kind}:${session.pid}`} className={index ? 'border-t border-[var(--color-border-default)]' : ''}>
                <div className="flex flex-wrap items-start gap-4 px-4 py-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${active ? 'bg-[var(--color-accent-green)]' : 'bg-[var(--color-accent-yellow)]'}`} />
                      <span className="font-medium text-[var(--color-text-primary)]">{session.name || session.sessionId || `PID ${session.pid}`}</span>
                      <span className="rounded border border-[var(--color-border-default)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">{KIND_LABELS[session.kind] || session.kind}</span>
                      {session.status ? <span className="text-[10px] text-[var(--color-text-secondary)]">{session.status}</span> : null}
                    </div>
                    <div className="mt-2 break-all font-mono text-xs text-[var(--color-text-secondary)]">{session.cwd || '-'}</div>
                    <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[10px] text-[var(--color-text-muted)]">
                      <span>PID {session.pid}</span><span>启动：{formatDateTime(session.startedAt)}</span><span>心跳：{formatRelative(session.lastHeartbeat || session.updatedAt)}</span>{session.version ? <span>CLI {session.version}</span> : null}{session.hostname ? <span>{session.hostname}</span> : null}
                    </div>
                    {session.endpoint ? <div className="mt-2 truncate font-mono text-[10px] text-[var(--color-text-muted)]" title={session.endpoint}>{session.endpoint}</div> : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {canAttach ? <button className="btn-ghost px-2 py-1 text-xs text-[var(--color-accent-blue)]" disabled={startBusy || killBusy || Boolean(attachBusyPid)} title="在交互终端中运行 codebuddy attach" onClick={() => attachSession(session)}>{attachBusyPid === session.pid ? '打开中...' : '接管'}</button> : null}
                    {session.endpoint ? <button className="btn-ghost px-2 py-1 text-xs" onClick={() => openEndpoint(session)}>打开</button> : null}
                    {session.logPath ? <button className="btn-ghost px-2 py-1 text-xs" onClick={() => { setCopyStatus('idle'); setLogsAutoRefresh(false); loadLogs(session); }}>日志</button> : null}
                    {canKill ? <button className="btn-ghost px-2 py-1 text-xs text-[var(--color-accent-red)]" disabled={startBusy || killBusy || Boolean(attachBusyPid)} onClick={() => { setKillError(''); setPendingKill(session); }}>终止</button> : null}
                  </div>
                </div>
              </section>;
            })}
          </div>
        ) : <div className="py-20 text-center"><div className="text-sm text-[var(--color-text-secondary)]">{sessions.length ? '没有匹配的会话' : '当前没有活跃 CodeBuddy 会话'}</div>{!projects.length ? <div className="mt-2 text-xs text-[var(--color-text-muted)]">先添加项目后即可启动后台任务。</div> : null}</div>}
      </div>

      <StartBackgroundDialog open={startOpen} busy={startBusy} error={startError} projects={projects} existingNames={existingNames} onCancel={() => { if (!startBusy) { setStartOpen(false); setStartError(''); } }} onSubmit={submitStart} />
      <ActionConfirmDialog open={Boolean(pendingKill)} title="终止后台会话？" description={pendingKill ? <><div className="font-medium text-[var(--color-text-primary)]">{pendingKill.name || `PID ${pendingKill.pid}`}</div><div className="mt-1 break-all font-mono">{pendingKill.cwd}</div><div className="mt-2">正在执行的 CodeBuddy 任务会立即停止，现有日志仍保留在磁盘中。</div></> : null} confirmLabel="终止会话" busy={killBusy} error={killError} onCancel={() => { if (!killBusy) { setPendingKill(null); setKillError(''); } }} onConfirm={confirmKill} />
      <BackgroundLogsDialog value={logsDialog} autoRefresh={logsAutoRefresh} copyStatus={copyStatus} onClose={() => { logsRequestRef.current += 1; setLogsDialog(null); setLogsAutoRefresh(false); }} onRefresh={() => logsDialog?.session && loadLogs(logsDialog.session)} onToggleAutoRefresh={() => setLogsAutoRefresh((value) => !value)} onCopy={copyLogs} />
    </div>
  );
}
