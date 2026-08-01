import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson } from '../lib/acp';
import { useStore } from '../store';

function StatCard({ title, value, subtitle }) {
  return (
    <div className="rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-5">
      <div className="text-xs text-[var(--color-text-muted)]">{title}</div>
      <div className="mt-2 text-2xl font-bold text-[var(--color-text-primary)]">{value}</div>
      {subtitle ? <div className="mt-1 text-xs text-[var(--color-text-secondary)]">{subtitle}</div> : null}
    </div>
  );
}

function WorkerCard({ worker }) {
  return (
    <div className="rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-sm font-medium text-[var(--color-text-primary)]">{worker.kind || 'worker'}</div>
        <span className="rounded px-2 py-1 text-[10px]" style={{ background: worker.isCurrent ? 'rgba(34,197,94,0.1)' : 'rgba(107,114,128,0.1)', color: worker.isCurrent ? '#22c55e' : '#9ca3af' }}>
          {worker.isCurrent ? 'current' : 'worker'}
        </span>
      </div>
      <div className="space-y-1 text-xs text-[var(--color-text-secondary)]">
        <div>PID: {worker.pid || '-'}</div>
        <div className="truncate">Session: {worker.sessionId || '-'}</div>
        <div className="truncate">Endpoint: {worker.endpoint || worker.url || '-'}</div>
        <div>Version: {worker.version || '-'}</div>
      </div>
    </div>
  );
}

export function unwrapPayload(payload) {
  return payload?.data ?? payload ?? null;
}

export function formatDiskUsage(metrics) {
  if (!metrics) return '-';
  const usedGiB = Number.isFinite(Number(metrics.diskUsedGiB))
    ? Number(metrics.diskUsedGiB)
    : Number(metrics.diskUsed) / 1024 / 1024 / 1024;
  const totalGiB = Number.isFinite(Number(metrics.diskTotalGiB))
    ? Number(metrics.diskTotalGiB)
    : Number(metrics.diskTotal) / 1024 / 1024 / 1024;
  if (!Number.isFinite(usedGiB) || !Number.isFinite(totalGiB)) return '-';
  return `${usedGiB.toFixed(1)} / ${totalGiB.toFixed(1)} GiB`;
}

export default function ReplicaMonitorView() {
  const activeProjectId = useStore((state) => state.activeProjectId);
  const loadRequestRef = useRef(0);
  const loadInFlightRef = useRef(null);
  const [auth, setAuth] = useState(null);
  const [info, setInfo] = useState(null);
  const [daemon, setDaemon] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [workers, setWorkers] = useState([]);
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (loadInFlightRef.current) return false;
    const operation = {};
    loadInFlightRef.current = operation;
    const requestId = ++loadRequestRef.current;
    const projectId = activeProjectId;
    setLoading(true);
    setError('');
    try {
      const results = await Promise.allSettled([
        fetchJson('/api/v1/auth/status'),
        fetchJson('/api/v1/info'),
        fetchJson('/api/v1/daemon/status'),
        fetchJson('/api/v1/metrics'),
        fetchJson('/api/v1/workers'),
        fetchJson('/api/v1/channels'),
      ]);
      if (requestId !== loadRequestRef.current || useStore.getState().activeProjectId !== projectId) return false;
      const failed = [];
      const read = (index, label, apply) => {
        const result = results[index];
        if (result.status === 'fulfilled') apply(result.value);
        else failed.push(label);
      };

      read(0, '认证状态', (payload) => setAuth(unwrapPayload(payload)));
      read(1, '环境信息', (payload) => setInfo(unwrapPayload(payload)));
      read(2, 'Daemon 状态', (payload) => setDaemon(unwrapPayload(payload)));
      read(3, '系统指标', (payload) => setMetrics(unwrapPayload(payload)));
      read(4, 'Worker 列表', (payload) => {
        const workerList = payload?.data?.workers || payload?.workers || payload?.data || payload || [];
        setWorkers(Array.isArray(workerList) ? workerList : []);
      });
      read(5, '渠道列表', (payload) => {
        const channelList = payload?.data?.clients || payload?.clients || payload?.data?.channels || payload?.channels || [];
        setChannels((Array.isArray(channelList) ? channelList : []).filter((item) => !item.hidden));
      });
      if (failed.length) setError(`部分数据暂时不可用：${failed.join('、')}`);
      return failed.length === 0;
    } catch (err) {
      if (requestId === loadRequestRef.current && useStore.getState().activeProjectId === projectId) {
        setError(err.message || '加载失败');
      }
      return false;
    } finally {
      if (loadInFlightRef.current === operation) {
        loadInFlightRef.current = null;
        if (requestId === loadRequestRef.current && useStore.getState().activeProjectId === projectId) setLoading(false);
      }
    }
  }, [activeProjectId]);

  useEffect(() => {
    setAuth(null);
    setInfo(null);
    setDaemon(null);
    setMetrics(null);
    setWorkers([]);
    setChannels([]);
    setLoading(true);
    loadInFlightRef.current = null;
    load();
  }, [load]);

  const diskGiB = formatDiskUsage(metrics);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--color-bg-primary)]">
      <div className="flex h-12 items-center border-b border-[var(--color-border-default)] px-6">
        <h2 className="text-base font-semibold text-[var(--color-text-primary)]">监控</h2>
      </div>
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        <div>
          <div className="text-lg font-semibold text-[var(--color-text-primary)]">监控</div>
          <div className="mt-1 text-sm text-[var(--color-text-secondary)]">运行状态与实例健康</div>
        </div>

        <div className="flex gap-3">
          <button className="btn-primary" onClick={load} disabled={loading}>{loading ? '刷新中...' : '刷新'}</button>
        </div>

        {loading ? (
          <div className="grid grid-cols-2 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-5">
                <div className="skeleton h-3 w-16 rounded" />
                <div className="skeleton mt-2 h-7 w-28 rounded" />
                <div className="skeleton mt-2 h-3 w-20 rounded" />
              </div>
            ))}
          </div>
        ) : null}
        {error ? <div className="rounded-lg border border-[rgba(239,68,68,0.35)] bg-[rgba(239,68,68,0.08)] px-4 py-3 text-sm text-red-300 flex items-center gap-2"><span>{error}</span><button className="btn-ghost text-sm underline" onClick={load}>重试</button></div> : null}

        <div className="grid grid-cols-2 gap-4">
          <StatCard title="认证" value={auth ? (auth.authenticated ? 'authenticated' : 'unauthenticated') : '-'} subtitle={auth ? `authEnabled: ${String(!!auth.authEnabled)}` : '状态不可用'} />
          <StatCard title="Daemon" value={daemon?.status || '-'} subtitle={`PID ${daemon?.pid || '-'}`} />
          <StatCard title="CPU" value={metrics?.cpuUsedPct ?? '-'} subtitle="CPU Used %" />
          <StatCard title="Memory" value={metrics?.memUsedMib ?? '-'} subtitle={`Total ${metrics?.memTotalMib ?? '-'} MiB`} />
          <StatCard title="Disk" value={diskGiB} subtitle="Used / Total" />
          <StatCard title="Channels" value={channels.length} subtitle="Visible channels" />
        </div>

        <section className="space-y-3">
          <div className="text-sm font-medium text-[var(--color-text-secondary)]">环境信息</div>
          <div className="rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-4 text-sm text-[var(--color-text-secondary)] space-y-1">
            <div>CWD: {info?.cwd || '-'}</div>
            <div>OS: {info?.os || '-'} / {info?.arch || '-'}</div>
            <div>Node: {info?.nodeVersion || '-'}</div>
            <div>Gateway: {info?.gatewayMode || '-'}</div>
            <div>Tunnel: {info?.tunnelUrl || '-'}</div>
          </div>
        </section>

        <section className="space-y-3">
          <div className="text-sm font-medium text-[var(--color-text-secondary)]">Workers</div>
          {workers.length ? (
            <div className="grid grid-cols-2 gap-4">
              {workers.map((worker) => <WorkerCard key={`${worker.pid}-${worker.sessionId}`} worker={worker} />)}
            </div>
          ) : (
            <div className="text-sm text-[var(--color-text-muted)]">暂无 worker</div>
          )}
        </section>
      </div>
    </div>
  );
}
