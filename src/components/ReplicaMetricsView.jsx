import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useStore } from '../store';
import { useViewActive } from '../lib/use-view-active';

// ── 工具函数 ──

export function clampPercent(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

export function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function formatUptime(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '--';
  seconds = value;
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d > 0) parts.push(`${d}天`);
  if (h > 0) parts.push(`${h}时`);
  if (m > 0) parts.push(`${m}分`);
  if (!parts.length || s > 0) parts.push(`${s}秒`);
  return parts.join(' ');
}

export function formatBytes(mib) {
  const n = Number(mib);
  if (!Number.isFinite(n)) return '--';
  if (n >= 1024) return `${(n / 1024).toFixed(1)} GiB`;
  return `${n.toFixed(1)} MiB`;
}

export function formatGiB(gib) {
  const n = Number(gib);
  if (!Number.isFinite(n)) return '--';
  return `${n.toFixed(1)} GiB`;
}

export function formatSampleTime(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return '--';
  const date = new Date(timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp);
  return Number.isNaN(date.getTime()) ? '--' : date.toLocaleString('zh-CN');
}

// ── 内部子组件 ──

function SkeletonCard() {
  return (
    <div className="card p-5">
      <div className="skeleton h-3 w-16 mb-3" />
      <div className="skeleton h-8 w-24 mb-2" />
      <div className="skeleton h-2 w-full mt-3" />
    </div>
  );
}

function LoadingState() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      <SkeletonCard /><SkeletonCard /><SkeletonCard /><SkeletonCard />
    </div>
  );
}

function StatCard({ label, value, unit, percent, max, colorClass, valueFormatter = formatBytes }) {
  const pct = clampPercent(percent);
  const displayValue = value ?? '--';
  const barColor = colorClass || 'bg-[var(--color-accent-blue)]';

  return (
    <div className="card p-5 animate-fadeIn">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">
          {label}
        </span>
        {max != null && (
          <span className="text-[11px] text-[var(--color-text-tertiary)] tabular-nums">
            {valueFormatter(value)} / {valueFormatter(max)}
          </span>
        )}
      </div>

      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-bold text-[var(--color-text-primary)] tabular-nums">
          {displayValue}
        </span>
        {unit && (
          <span className="text-sm text-[var(--color-text-tertiary)]">{unit}</span>
        )}
      </div>

      <div className="mt-3 h-2 rounded-full bg-[var(--color-bg-hover)] overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ease-out ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-1 text-[11px] text-[var(--color-text-muted)] text-right tabular-nums">
        {pct.toFixed(1)}%
      </div>
    </div>
  );
}

function SimpleBar({ height, maxH, label, color }) {
  const h = maxH > 0 ? Math.max(2, (height / maxH) * 60) : 2;
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        className="w-5 rounded-t-sm transition-all duration-300"
        style={{ height: `${h}px`, background: color || 'var(--color-accent-blue)' }}
        title={`${label}: ${height?.toFixed(1) ?? '--'}`}
      />
      <span className="text-[10px] text-[var(--color-text-muted)] leading-none">{label}</span>
    </div>
  );
}

function SimpleBarChart({ data, title, color, formatValue }) {
  if (!data || !Array.isArray(data) || data.length === 0) {
    return (
      <div className="card p-5 flex flex-col items-center justify-center" style={{ minHeight: 160 }}>
        <div className="text-[11px] text-[var(--color-text-muted)]">{title}</div>
        <div className="text-xs text-[var(--color-text-tertiary)] mt-2">暂无历史数据</div>
      </div>
    );
  }

  const values = data.map((d) => d?.value ?? 0);
  const maxVal = Math.max(...values, 1);

  return (
    <div className="card p-5">
      <div className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide mb-4">
        {title}
      </div>
      <div className="flex items-end justify-between gap-1 h-[80px]">
        {data.map((d, i) => (
          <SimpleBar
            key={i}
            height={d?.value ?? 0}
            maxH={maxVal}
            label={d?.label ?? `#${i + 1}`}
            color={color}
          />
        ))}
      </div>
      {formatValue && (
        <div className="mt-2 text-[11px] text-[var(--color-text-muted)] text-right">
          最高: {formatValue(maxVal)}
        </div>
      )}
    </div>
  );
}

function SystemInfoRow({ label, value }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-4 border-b border-[var(--color-border-default)] py-2 last:border-b-0">
      <span className="shrink-0 text-xs text-[var(--color-text-muted)]">{label}</span>
      <span className="max-w-[70%] truncate text-xs font-mono tabular-nums text-[var(--color-text-primary)]" title={String(value ?? '--')}>{value ?? '--'}</span>
    </div>
  );
}

function InstancesTable({ instances }) {
  if (!instances.length) return null;
  return (
    <div className="card mb-6 overflow-hidden animate-fadeIn">
      <div className="flex items-center justify-between border-b border-[var(--color-border-default)] px-5 py-4">
        <div className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">CodeBuddy 实例</div>
        <div className="text-xs text-[var(--color-text-secondary)]">共 {instances.length} 个</div>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-[760px] w-full text-xs">
          <thead className="bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)]">
            <tr>
              <th className="px-4 py-2.5 text-left font-medium">状态</th>
              <th className="px-4 py-2.5 text-right font-medium">PID</th>
              <th className="px-4 py-2.5 text-left font-medium">工作目录</th>
              <th className="px-4 py-2.5 text-left font-medium">版本</th>
              <th className="px-4 py-2.5 text-right font-medium">运行时长</th>
              <th className="px-4 py-2.5 text-right font-medium">RSS</th>
            </tr>
          </thead>
          <tbody>
            {instances.map((instance, index) => {
              const unavailable = Boolean(instance.error);
              const status = unavailable ? instance.error : (instance.isCurrent ? '当前实例' : '可响应');
              return (
                <tr key={instance.id || instance.pid || index} className="border-t border-[var(--color-border-muted)] text-[var(--color-text-secondary)]">
                  <td className="px-4 py-2.5">
                    <span
                      className={`inline-flex max-w-[150px] truncate rounded px-2 py-0.5 text-[10px] ${unavailable ? 'bg-[var(--color-error-bg)] text-[var(--color-error)]' : 'bg-[rgba(34,197,94,0.1)] text-[var(--color-success)]'}`}
                      title={status}
                    >
                      {status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-[var(--color-text-primary)]">{instance.pid || '-'}</td>
                  <td className="max-w-[320px] truncate px-4 py-2.5 text-[var(--color-text-primary)]" title={instance.cwd || ''}>{instance.cwd || '-'}</td>
                  <td className="px-4 py-2.5">{instance.version || '-'}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{formatUptime(instance.uptimeSeconds)}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{unavailable ? '--' : formatBytes(instance.rssMib)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EmptyState({ onRefresh }) {
  return (
    <div className="flex flex-col items-center justify-center py-16">
      <div className="w-16 h-16 rounded-full bg-[var(--color-bg-hover)] flex items-center justify-center mb-4">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="22,12 18,12 15,21 9,3 6,12 2,12" />
        </svg>
      </div>
      <p className="text-sm text-[var(--color-text-muted)] mb-4">暂无监控数据</p>
      <button onClick={onRefresh} className="btn-primary text-xs">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
        </svg>
        重试
      </button>
    </div>
  );
}

function ErrorState({ message, onRetry }) {
  return (
    <div className="flex items-start gap-3 p-4 rounded-lg bg-[var(--color-error-bg)] border border-[var(--color-error)]/20 animate-fadeIn">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-error)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5">
        <circle cx="12" cy="12" r="10" />
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
      </svg>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-[var(--color-error)] font-medium">获取监控数据失败</p>
        {message && <p className="text-xs text-[var(--color-text-muted)] mt-1 truncate">{message}</p>}
      </div>
      <button onClick={onRetry} className="btn-ghost text-xs shrink-0">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
        </svg>
        重试
      </button>
    </div>
  );
}

// ── 历史数据管理 ──

const MAX_HISTORY = 20;

export function pruneHistory(history) {
  if (history.length > MAX_HISTORY) return history.slice(history.length - MAX_HISTORY);
  return history;
}

// ── 主组件 ──

export default function ReplicaMetricsView() {
  // M-perf (keep-alive): pause auto-refresh while this view is hidden.
  const active = useViewActive('metrics');
  const metrics = useStore((s) => s.metrics);
  const refreshMetrics = useStore((s) => s.refreshMetrics);
  const activeProjectId = useStore((s) => s.activeProjectId);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [cpuHistory, setCpuHistory] = useState([]);
  const [memHistory, setMemHistory] = useState([]);
  const sampleIndexRef = useRef(0);
  const prevMetricsRef = useRef(null);
  const refreshInFlightRef = useRef(null);

  useEffect(() => {
    setCpuHistory([]);
    setMemHistory([]);
    setError(null);
    setLoading(true);
    setRefreshing(false);
    refreshInFlightRef.current = null;
    sampleIndexRef.current = 0;
    prevMetricsRef.current = null;
  }, [activeProjectId]);

  // 拉取数据
  const doRefresh = useCallback(async () => {
    if (refreshInFlightRef.current) return false;
    const operation = {};
    refreshInFlightRef.current = operation;
    const projectId = activeProjectId;
    try {
      setRefreshing(true);
      setError(null);
      const ok = await refreshMetrics();
      if (useStore.getState().activeProjectId !== projectId) return false;
      if (ok === false) {
        setError(useStore.getState().metricsError || '请求失败');
        return false;
      }
      return true;
    } catch (e) {
      if (useStore.getState().activeProjectId !== projectId) return false;
      setError(e?.message || '请求失败');
      return false;
    } finally {
      if (refreshInFlightRef.current === operation) {
        refreshInFlightRef.current = null;
        if (useStore.getState().activeProjectId === projectId) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    }
  }, [activeProjectId, refreshMetrics]);

  // 首次加载
  useEffect(() => {
    doRefresh();
  }, [doRefresh]);

  // 自动刷新
  useEffect(() => {
    if (!active || !autoRefresh) return;
    const id = setInterval(() => {
      doRefresh();
    }, 30000);
    return () => clearInterval(id);
  }, [active, autoRefresh, doRefresh]);

  // 当 metrics 更新后记录历史
  useEffect(() => {
    if (!metrics) return;

    // 避免同一次数据重复记录
    const snap = JSON.stringify({ cpu: metrics.cpuUsedPct, mem: metrics.memUsedMib });
    if (snap === prevMetricsRef.current) return;
    prevMetricsRef.current = snap;

    sampleIndexRef.current += 1;
    const label = `#${sampleIndexRef.current}`;

    setCpuHistory((prev) =>
      pruneHistory([...prev, { label, value: metrics.cpuUsedPct ?? 0 }])
    );
    setMemHistory((prev) =>
      pruneHistory([...prev, { label, value: metrics.memUsedMib ?? 0 }])
    );
  }, [metrics]);

  // ── 从 metrics 提取字段 ──

  const cpuPct = finiteNumber(metrics?.cpuUsedPct);
  const memUsed = finiteNumber(metrics?.memUsedMib);
  const memTotal = finiteNumber(metrics?.memTotalMib);
  const diskUsed = metrics?.diskUsedGiB != null
    ? finiteNumber(metrics.diskUsedGiB)
    : finiteNumber(metrics?.diskUsed) / 1024 / 1024 / 1024;
  const diskTotal = metrics?.diskTotalGiB != null
    ? finiteNumber(metrics.diskTotalGiB)
    : finiteNumber(metrics?.diskTotal) / 1024 / 1024 / 1024;
  const instances = Array.isArray(metrics?.instances)
    ? [...metrics.instances].sort(
        (left, right) =>
          Number(Boolean(right.isCurrent)) - Number(Boolean(left.isCurrent)) ||
          Number(Boolean(left.error)) - Number(Boolean(right.error)),
      )
    : [];
  const healthyInstanceCount = instances.filter((instance) => !instance.error).length;
  const currentInstance =
    instances.find((instance) => instance.isCurrent) ||
    instances.find((instance) => !instance.error) ||
    instances[0] || null;

  const memPercent = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;
  const diskPercent = diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0;
  const instancePercent = instances.length ? (healthyInstanceCount / instances.length) * 100 : 0;
  const allInstancesHealthy = instances.length > 0 && healthyInstanceCount === instances.length;

  const hasData = metrics && Object.keys(metrics).length > 0;

  // 系统信息
  const sysInfo = [
    { label: '采样时间', value: formatSampleTime(metrics?.ts) },
    { label: 'CPU 核心数', value: metrics?.cpuCount ?? metrics?.cpuCores ?? '--' },
    { label: '操作系统', value: currentInstance ? `${currentInstance.os || '-'} / ${currentInstance.arch || '-'}` : '--' },
    { label: '主机名', value: currentInstance?.hostname || '--' },
    { label: '当前版本', value: currentInstance?.version || '--' },
    { label: '运行模式', value: currentInstance?.mode || '--' },
    { label: '当前运行时长', value: formatUptime(currentInstance?.uptimeSeconds) },
    { label: '当前工作目录', value: currentInstance?.cwd || '--' },
  ].filter((item) => item.value !== '--' && item.value != null);

  // ── 渲染 ──

  const renderContent = () => {
    if (loading) return <LoadingState />;
    if (error) return <ErrorState message={error} onRetry={doRefresh} />;
    if (!hasData) return <EmptyState onRefresh={doRefresh} />;

    return (
      <>
        {/* StatCards 4 列网格 */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard
            label="CPU 使用率"
            value={cpuPct.toFixed(1)}
            unit="%"
            percent={cpuPct}
            colorClass="bg-[var(--color-accent-blue)]"
          />
          <StatCard
            label="内存使用"
            value={(memUsed ?? 0).toFixed(0)}
            unit="MiB"
            percent={memPercent}
            max={memTotal}
            colorClass="bg-[var(--color-accent-purple)]"
          />
          <StatCard
            label="磁盘使用"
            value={(diskUsed ?? 0).toFixed(1)}
            unit="GiB"
            percent={diskPercent}
            max={diskTotal}
            valueFormatter={formatGiB}
            colorClass="bg-[var(--color-accent-green)]"
          />
          <StatCard
            label="CodeBuddy 实例"
            value={healthyInstanceCount}
            unit={`/ ${instances.length} 可响应`}
            percent={instancePercent}
            colorClass={allInstancesHealthy ? 'bg-[var(--color-accent-green)]' : 'bg-[var(--color-accent-yellow)]'}
          />
        </div>

        {/* 历史图表区域 */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          <SimpleBarChart
            data={cpuHistory}
            title="CPU 历史 (%)"
            color="var(--color-accent-blue)"
            formatValue={(v) => `${v.toFixed(1)}%`}
          />
          <SimpleBarChart
            data={memHistory}
            title="内存历史 (MiB)"
            color="var(--color-accent-purple)"
            formatValue={(v) => formatBytes(v)}
          />
        </div>

        <InstancesTable instances={instances} />

        {/* 系统信息 */}
        <div className="card p-5 animate-fadeIn">
          <div className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide mb-3">
            系统信息
          </div>
          <div>
            {sysInfo.map((item) => (
              <SystemInfoRow key={item.label} label={item.label} value={item.value} />
            ))}
            {sysInfo.length === 0 && (
              <div className="text-xs text-[var(--color-text-tertiary)] py-2 text-center">
                暂无系统信息
              </div>
            )}
          </div>
        </div>
      </>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--color-bg-primary)]">
      {/* 标题栏 */}
      <div className="flex h-12 items-center justify-between border-b border-[var(--color-border-default)] px-6 shrink-0">
        <h2 className="text-base font-semibold text-[var(--color-text-primary)]">系统监控</h2>
        <div className="flex items-center gap-3">
          {/* 自动刷新开关 */}
          <button
            onClick={() => setAutoRefresh((v) => !v)}
            className="flex items-center gap-1.5 text-[11px] transition-colors"
            style={{ color: autoRefresh ? 'var(--color-success)' : 'var(--color-text-muted)' }}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${autoRefresh ? 'bg-[var(--color-success)]' : 'bg-[var(--color-text-muted)]'}`} />
            自动刷新
          </button>

          {/* 刷新按钮 */}
          <button
            onClick={doRefresh}
            disabled={refreshing}
            className="btn-ghost text-xs"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={refreshing ? 'animate-spin' : ''}
            >
              <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
            </svg>
            刷新
          </button>
        </div>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto p-6">
        {renderContent()}
      </div>
    </div>
  );
}
