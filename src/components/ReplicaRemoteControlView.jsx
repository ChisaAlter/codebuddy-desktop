import React, { useCallback, useEffect, useState, useRef } from 'react';
import { fetchJson } from '../lib/acp';
import { createWechatChannel, fetchWechatQr, createWecomChannel, channelAction, deleteChannelInstance } from '../lib/ops';
import { useStore } from '../store';
import { useViewActive } from '../lib/use-view-active';

function normalizeRemoteControlPayload(payload) {
  const data = payload?.data ?? payload ?? {};
  const clients = data.clients || data.channels || [];
  return Array.isArray(clients) ? clients : [];
}

function channelTypeLabel(type) {
  if (type === 'wechat') return '微信';
  if (type === 'wecom') return '企业微信';
  return type || '未知渠道';
}

function channelStatusLabel(status) {
  if (status === 'connected') return '已连接';
  if (status === 'connecting') return '连接中';
  if (status === 'stopped' || status === 'disconnected') return '未连接';
  if (status === 'error') return '异常';
  return status || '未知';
}

function ChannelCard({ channel, projectId, generation, isScopeCurrent, onRefresh, onWechatQrRequested, onDeleted }) {
  const type = channel.clientType || 'unknown';
  const instanceId = channel.instanceId;
  const displayName = channel.displayName || `${type}:${instanceId || ''}`;
  const status = channel.status || 'unknown';
  const color = status === 'connected' ? '#22c55e' : status === 'connecting' ? '#f59e0b' : '#8e8e93';
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [confirmAction, setConfirmAction] = useState('');
  const [confirmError, setConfirmError] = useState('');
  const mountedRef = useRef(true);
  const actionInFlightRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      actionInFlightRef.current = false;
    };
  }, []);

  const isCurrentScope = () => (
    mountedRef.current && isScopeCurrent(projectId, generation)
  );

  const beginAction = (action) => {
    if (!instanceId || actionInFlightRef.current || !isCurrentScope()) return false;
    actionInFlightRef.current = true;
    setBusy(action);
    setMessage('');
    setConfirmError('');
    return true;
  };

  const finishAction = () => {
    actionInFlightRef.current = false;
    if (isCurrentScope()) setBusy('');
  };

  // 当前后端契约仅提供 start/stop 两个连接状态动作。
  const pickToggleAction = (currentStatus) => currentStatus === 'connected' ? 'stop' : 'start';

  const handleToggle = async () => {
    const action = pickToggleAction(status);
    if (!beginAction('toggle')) return false;
    try {
      const result = await channelAction(type, instanceId, action);
      if (!isCurrentScope()) return false;
      setMessage(result?.message || (action === 'start' ? '已发起连接' : '已断开'));
      await onRefresh?.();
      return isCurrentScope();
    } catch (err) {
      if (isCurrentScope()) setMessage(err.message || '操作失败');
      return false;
    } finally {
      finishAction();
    }
  };

  const handleUnbind = async () => {
    if (!beginAction('unbind')) return false;
    try {
      const result = await channelAction(type, instanceId, 'unbind');
      if (!isCurrentScope()) return false;
      if (type === 'wechat' && result?.needsQrScan) {
        setMessage('旧凭据已清除，请重新扫码');
        onWechatQrRequested?.(instanceId, displayName);
      } else {
        setMessage(result?.message || '已解绑');
      }
      await onRefresh?.();
      return isCurrentScope();
    } catch (err) {
      if (isCurrentScope()) setConfirmError(err.message || '解绑失败');
      return false;
    } finally {
      finishAction();
    }
  };

  const handleDelete = async () => {
    if (!beginAction('delete')) return false;
    try {
      await deleteChannelInstance(type, instanceId);
      if (!isCurrentScope()) return false;
      setMessage('已删除');
      onDeleted?.(instanceId);
      await onRefresh?.();
      return isCurrentScope();
    } catch (err) {
      if (isCurrentScope()) setConfirmError(err.message || '删除失败');
      return false;
    } finally {
      finishAction();
    }
  };

  const openConfirm = (action) => {
    if (actionInFlightRef.current || !isCurrentScope()) return;
    setConfirmAction(action);
    setConfirmError('');
  };

  const closeConfirm = () => {
    if (actionInFlightRef.current || !isCurrentScope()) return;
    setConfirmAction('');
    setConfirmError('');
  };

  const confirmDestructiveAction = async () => {
    if (!confirmAction || actionInFlightRef.current || !isCurrentScope()) return;
    const action = confirmAction;
    const ok = action === 'unbind' ? await handleUnbind() : await handleDelete();
    if (ok && isCurrentScope()) {
      setConfirmAction('');
      setConfirmError('');
    }
  };
  return (
    <div className="surface-panel p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-[var(--color-text-primary)]">{displayName}</div>
          <div className="mt-1 text-xs text-[var(--color-text-muted)]">{channelTypeLabel(type)}</div>
        </div>
        <span className="rounded px-2 py-1 text-[10px]" style={{ background: `${color}1a`, color }}>
          {channelStatusLabel(status)}
        </span>
      </div>
      <div className="text-xs text-[var(--color-text-secondary)]">
        <span className="text-[var(--color-text-muted)]">实例 ID </span>
        <span className="font-mono">{instanceId || '-'}</span>
      </div>
      <div className="mt-3 flex gap-2 flex-wrap">
        <button className="btn-ghost" disabled={!!busy} onClick={handleToggle}>{busy === 'toggle' ? '处理中...' : (status === 'connected' ? '断开' : '连接')}</button>
        <button
          className="btn-ghost"
          disabled={!!busy}
          onClick={() => openConfirm('unbind')}
          title={type === 'wechat' ? '清除旧凭据并重新扫码' : '清除已保存的渠道凭据'}
        >
          {busy === 'unbind' ? '处理中...' : '解绑'}
        </button>
        <button className="btn-ghost text-[var(--color-accent-red)]" disabled={!!busy} onClick={() => openConfirm('delete')}>{busy === 'delete' ? '处理中...' : '删除'}</button>
      </div>
      {message ? <div className="mt-2 text-xs text-[var(--color-text-secondary)]">{message}</div> : null}

      {confirmAction ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4"
          role="dialog"
          aria-modal="true"
          aria-label={confirmAction === 'unbind' ? '解绑渠道确认' : '删除渠道确认'}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeConfirm();
          }}
        >
          <div className="w-full max-w-sm rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-5 shadow-xl">
            <div className="text-sm font-semibold text-[var(--color-text-primary)]">
              {confirmAction === 'unbind' ? '解绑渠道？' : '删除渠道？'}
            </div>
            <div className="mt-3 text-xs leading-5 text-[var(--color-text-secondary)]">
              <div className="font-medium text-[var(--color-text-primary)]">{displayName}</div>
              <p className="mt-2">
                {confirmAction === 'unbind'
                  ? type === 'wechat'
                    ? '旧登录凭据会被清除，随后需要重新扫描二维码。'
                    : '已保存的渠道凭据会被清除，后续需要重新配置。'
                  : '该渠道实例会被永久删除，此操作无法撤销。'}
              </p>
            </div>
            {confirmError ? <div className="mt-3 text-xs text-[var(--color-accent-red)]">{confirmError}</div> : null}
            <div className="mt-5 flex justify-end gap-2">
              <button className="btn-ghost px-3 py-1.5 text-xs" disabled={!!busy} onClick={closeConfirm}>取消</button>
              <button
                className={confirmAction === 'delete' ? 'rounded-md px-3 py-1.5 text-xs font-medium text-white' : 'btn-primary px-3 py-1.5 text-xs'}
                style={confirmAction === 'delete' ? { background: 'var(--color-accent-red)' } : undefined}
                disabled={!!busy}
                onClick={confirmDestructiveAction}
              >
                {busy ? '处理中...' : confirmAction === 'unbind' ? '确认解绑' : '删除渠道'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function ReplicaRemoteControlView() {
  // M-perf (keep-alive): pause the 5s channel refresh while this view is hidden.
  // The QR login poll (a stateful flow) deliberately keeps running.
  const active = useViewActive('remote-control');
  const setRoute = useStore((state) => state.setRoute);
  const activeProjectId = useStore((state) => state.activeProjectId);
  const [channels, setChannels] = useState([]);
  const [channelsProjectId, setChannelsProjectId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const mountedRef = useRef(true);
  const loadInFlightRef = useRef(null);

  const viewGenerationRef = useRef(0);
  const qrPollGenerationRef = useRef(0);
  const wechatActionVersionRef = useRef(0);
  const wecomActionVersionRef = useRef(0);
  // 微信创建 + 二维码态（对照源 POST /channels/wechat + GET /channels/wechat/{id}/qr）
  const [wechatBusy, setWechatBusy] = useState(false);
  const [wechatQr, setWechatQr] = useState(null); // {qrImage} 或 null
  const [wechatQrLoading, setWechatQrLoading] = useState(false);
  const [wechatQrError, setWechatQrError] = useState(null);
  const [wechatQrInstanceId, setWechatQrInstanceId] = useState('');
  const qrPollRef = useRef(null);

  // 企微创建表单
  const [wecomBusy, setWecomBusy] = useState(false);
  const [wecomBotId, setWecomBotId] = useState('');
  const [wecomSecret, setWecomSecret] = useState('');
  const [wecomError, setWecomError] = useState(null);

  const isScopeCurrent = useCallback((projectId, generation) => (
    mountedRef.current &&
    generation === viewGenerationRef.current &&
    useStore.getState().activeProjectId === projectId
  ), []);

  const load = useCallback(async ({ silent = false } = {}) => {
    const projectId = activeProjectId;
    const generation = viewGenerationRef.current;
    const requestKey = `${projectId || 'none'}:${generation}`;
    if (loadInFlightRef.current === requestKey) return false;
    loadInFlightRef.current = requestKey;
    if (!silent) {
      setLoading(true);
      setError('');
    }
    try {
      const payload = await fetchJson('/api/v1/channels');
      const clients = normalizeRemoteControlPayload(payload);
      if (isScopeCurrent(projectId, generation)) {
        setChannels(clients.filter((item) => !item.hidden && !String(item.instanceId || '').startsWith('_pending')));
        setChannelsProjectId(projectId);
        setError('');
      }
      return true;
    } catch (err) {
      if (isScopeCurrent(projectId, generation)) setError(err.message || '加载失败');
      return false;
    } finally {
      if (loadInFlightRef.current === requestKey) loadInFlightRef.current = null;
      if (!silent && isScopeCurrent(projectId, generation)) setLoading(false);
    }
  }, [activeProjectId, isScopeCurrent]);

  useEffect(() => {
    mountedRef.current = true;
    const generation = ++viewGenerationRef.current;
    qrPollGenerationRef.current += 1;
    wechatActionVersionRef.current += 1;
    wecomActionVersionRef.current += 1;
    if (qrPollRef.current) {
      clearTimeout(qrPollRef.current);
      qrPollRef.current = null;
    }
    setChannels([]);
    setChannelsProjectId(null);
    setLoading(true);
    setError('');
    setInfo('');
    setWechatBusy(false);
    setWechatQr(null);
    setWechatQrInstanceId('');
    setWechatQrLoading(false);
    setWechatQrError(null);
    setWecomBusy(false);
    setWecomBotId('');
    setWecomSecret('');
    setWecomError(null);
    if (!active) return undefined;
    load();
    const refreshTimer = setInterval(() => load({ silent: true }), 5000);
    return () => {
      mountedRef.current = false;
      if (viewGenerationRef.current === generation) viewGenerationRef.current += 1;
      qrPollGenerationRef.current += 1;
      wechatActionVersionRef.current += 1;
      wecomActionVersionRef.current += 1;
      clearInterval(refreshTimer);
      if (qrPollRef.current) {
        clearTimeout(qrPollRef.current);
        qrPollRef.current = null;
      }
    };
  }, [active, load]);

  // 微信：创建实例后轮询二维码（对照源 bundle 每 1s 拉，最长 180s）
  const stopQrPoll = () => {
    qrPollGenerationRef.current += 1;
    if (qrPollRef.current) { clearTimeout(qrPollRef.current); qrPollRef.current = null; }
  };
  const pollQr = (instanceId, projectId, generation) => {
    const startedAt = Date.now();
    stopQrPoll();
    const pollGeneration = qrPollGenerationRef.current;
    const isCurrentPoll = () => (
      pollGeneration === qrPollGenerationRef.current &&
      isScopeCurrent(projectId, generation)
    );
    const poll = async () => {
      if (!isCurrentPoll()) return;
      if (Date.now() - startedAt > 180000) {
        stopQrPoll();
        setWechatQrError('二维码超时，请重新创建');
        setWechatQrLoading(false);
        return;
      }
      try {
        const r = await fetchWechatQr(instanceId);
        if (!isCurrentPoll()) return;
        if (r.type === 'confirmed') {
          stopQrPoll();
          setWechatQr(null);
          setWechatQrInstanceId('');
          setWechatQrLoading(false);
          setWechatQrError(null);
          setInfo(r.message || '微信已连接');
          await load({ silent: true });
          return;
        }
        if (r.type === 'error') {
          stopQrPoll();
          setWechatQrError(r.error || r.message || '二维码登录失败');
          setWechatQrLoading(false);
          return;
        }
        if (r.ok && r.qrImage) {
          setWechatQr({ qrImage: r.qrImage });
          setWechatQrLoading(false);
          setWechatQrError(null);
        }
      } catch (_) { /* 忽略瞬时网络错，继续轮询 */ }
      if (isCurrentPoll()) qrPollRef.current = setTimeout(poll, 1000);
    };
    qrPollRef.current = setTimeout(poll, 1000);
  };

  const showWechatQr = (instanceId, message, projectId = activeProjectId, generation = viewGenerationRef.current) => {
    if (!isScopeCurrent(projectId, generation)) return false;
    setWechatQrInstanceId(instanceId);
    setWechatQr(null);
    setWechatQrError(null);
    setWechatQrLoading(true);
    stopQrPoll();
    if (message) setInfo(message);
    pollQr(instanceId, projectId, generation);
    return true;
  };

  const handleChannelDeleted = (instanceId, projectId = activeProjectId, generation = viewGenerationRef.current) => {
    if (!isScopeCurrent(projectId, generation)) return;
    if (!instanceId || instanceId !== wechatQrInstanceId) return;
    stopQrPoll();
    setWechatQrInstanceId('');
    setWechatQr(null);
    setWechatQrLoading(false);
    setWechatQrError(null);
  };

  const handleCreateWechat = async () => {
    const projectId = activeProjectId;
    const generation = viewGenerationRef.current;
    const actionVersion = ++wechatActionVersionRef.current;
    const isCurrentAction = () => (
      actionVersion === wechatActionVersionRef.current &&
      isScopeCurrent(projectId, generation)
    );
    setWechatBusy(true);
    setWechatQr(null);
    setWechatQrInstanceId('');
    setWechatQrError(null);
    setWechatQrLoading(true);
    stopQrPoll();
    try {
      const result = await createWechatChannel();
      if (!isCurrentAction()) return;
      const instanceId = result?.instanceId || result?.id;
      if (!instanceId) throw new Error('后端未返回 instanceId');
      showWechatQr(instanceId, `微信实例已创建：${instanceId}`, projectId, generation);
      await load();
    } catch (err) {
      if (isCurrentAction()) {
        setWechatQrError(err.message || '创建微信实例失败');
        setWechatQrLoading(false);
      }
    } finally {
      if (isCurrentAction()) setWechatBusy(false);
    }
  };

  const handleCreateWecom = async () => {
    setWecomError(null);
    const botId = wecomBotId.trim();
    const secret = wecomSecret.trim();
    if (!botId || !secret) { setWecomError('botId 与 secret 均不可为空'); return; }
    const projectId = activeProjectId;
    const generation = viewGenerationRef.current;
    const actionVersion = ++wecomActionVersionRef.current;
    const isCurrentAction = () => (
      actionVersion === wecomActionVersionRef.current &&
      isScopeCurrent(projectId, generation)
    );
    setWecomBusy(true);
    try {
      await createWecomChannel({ botId, secret });
      if (!isCurrentAction()) return;
      setWecomBotId((current) => current.trim() === botId ? '' : current);
      setWecomSecret((current) => current.trim() === secret ? '' : current);
      setInfo('企微实例已创建');
      await load();
    } catch (err) {
      if (isCurrentAction()) setWecomError(err.message || '创建企微实例失败');
    } finally {
      if (isCurrentAction()) setWecomBusy(false);
    }
  };

  const scopedChannels = channelsProjectId === activeProjectId ? channels : [];
  const wechat = scopedChannels.filter((item) => item.clientType === 'wechat');
  const wecom = scopedChannels.filter((item) => item.clientType === 'wecom');
  const others = scopedChannels.filter((item) => item.clientType !== 'wechat' && item.clientType !== 'wecom');
  const renderProjectId = activeProjectId;
  const renderGeneration = viewGenerationRef.current;

  return (
    <div className="page-shell">
      <div className="page-header">
        <div>
          <h2 className="page-header-title">远程控制</h2>
          <div className="page-header-desc">连接微信与企业微信，在移动端继续处理任务</div>
        </div>
        <button className="btn-ghost" onClick={() => load()} disabled={loading}>{loading ? '刷新中...' : '刷新连接'}</button>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="page-content-wide space-y-5">
          <div className="responsive-tool-grid">
            {/* 微信创建 + 二维码展示 */}
            <section className="surface-panel p-5">
              <div className="text-sm font-semibold text-[var(--color-text-primary)]">添加微信机器人</div>
              <div className="mt-1 text-xs text-[var(--color-text-muted)]">创建实例后使用微信扫码登录</div>
              <div className="mt-4 flex flex-wrap items-start gap-4">
                <div className="min-w-[180px] flex-1">
                  <button className="btn-primary" disabled={wechatBusy || wechatQrLoading} onClick={handleCreateWechat}>
                    {wechatBusy ? '创建中...' : '创建并显示二维码'}
                  </button>
                  {wechatQrLoading && <div className="mt-3 flex items-center gap-2 text-xs text-[var(--color-text-muted)]"><div className="h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-border-muted)] border-t-[var(--color-accent-primary)]" />等待二维码就绪...</div>}
                  {wechatQrError && <div className="mt-3 text-xs text-[var(--color-accent-red)]">{wechatQrError}</div>}
                </div>
                {wechatQr?.qrImage && (
                  <div className="flex shrink-0 flex-col items-center gap-2 rounded-lg border border-[var(--color-border-default)] bg-white p-3 shadow-sm">
                    <img src={wechatQr.qrImage} alt="微信登录二维码" className="h-40 w-40" style={{ imageRendering: 'pixelated' }} />
                    <div className="text-xs text-slate-500">用微信扫码登录</div>
                  </div>
                )}
              </div>
            </section>

            {/* 企微创建表单 */}
            <section className="surface-panel p-5">
              <div className="text-sm font-semibold text-[var(--color-text-primary)]">添加企业微信机器人</div>
              <div className="mt-1 text-xs text-[var(--color-text-muted)]">填写机器人凭据后创建连接实例</div>
              <div className="mt-4 grid grid-cols-1 gap-3">
                <label>
                  <span className="mb-1.5 block text-xs text-[var(--color-text-secondary)]">Bot ID</span>
                  <input
                    value={wecomBotId}
                    onChange={(e) => setWecomBotId(e.target.value)}
                    placeholder="输入 Bot ID"
                    className="input-field"
                    aria-label="企微 botId"
                  />
                </label>
                <label>
                  <span className="mb-1.5 block text-xs text-[var(--color-text-secondary)]">Secret</span>
                  <input
                    type="password"
                    value={wecomSecret}
                    onChange={(e) => setWecomSecret(e.target.value)}
                    placeholder="输入 Secret"
                    className="input-field"
                    aria-label="企微 secret"
                  />
                </label>
              </div>
              {wecomError && <div className="mt-3 text-xs text-[var(--color-accent-red)]">{wecomError}</div>}
              <button className="btn-primary mt-4" disabled={wecomBusy || !wecomBotId.trim() || !wecomSecret.trim()} onClick={handleCreateWecom}>
                {wecomBusy ? '创建中...' : '创建企微机器人'}
              </button>
            </section>
          </div>

          {loading ? <div className="text-sm text-[var(--color-text-muted)]">正在加载连接...</div> : null}
          {info ? <div className="flex items-center justify-between gap-3 rounded-lg border border-[rgba(34,197,94,0.25)] bg-[rgba(34,197,94,0.08)] px-4 py-3 text-sm text-[var(--color-accent-green)]"><span>{info}</span><button className="btn-ghost text-xs" onClick={() => setInfo('')}>关闭</button></div> : null}
          {error ? <div className="flex items-center justify-between gap-3 rounded-lg border border-[rgba(239,68,68,0.35)] bg-[rgba(239,68,68,0.08)] px-4 py-3 text-sm text-[var(--color-accent-red)]"><span>{error}</span><button className="btn-ghost text-xs" onClick={load}>重试</button></div> : null}

          <div className="responsive-card-grid">
            <section className="space-y-3">
              <div className="text-sm font-semibold text-[var(--color-text-primary)]">微信机器人</div>
              {wechat.length ? wechat.map((item) => (
                <ChannelCard
                  key={`${renderProjectId}-${renderGeneration}-${item.clientType}-${item.instanceId}`}
                  channel={item}
                  projectId={renderProjectId}
                  generation={renderGeneration}
                  isScopeCurrent={isScopeCurrent}
                  onRefresh={load}
                  onWechatQrRequested={(instanceId, name) => showWechatQr(instanceId, `${name} 已解绑，请重新扫码`, renderProjectId, renderGeneration)}
                  onDeleted={(instanceId) => handleChannelDeleted(instanceId, renderProjectId, renderGeneration)}
                />
              )) : <div className="empty-state text-sm">暂无微信连接</div>}
            </section>

            <section className="space-y-3">
              <div className="text-sm font-semibold text-[var(--color-text-primary)]">企业微信机器人</div>
              {wecom.length ? wecom.map((item) => <ChannelCard key={`${renderProjectId}-${renderGeneration}-${item.clientType}-${item.instanceId}`} channel={item} projectId={renderProjectId} generation={renderGeneration} isScopeCurrent={isScopeCurrent} onRefresh={load} />) : <div className="empty-state text-sm">暂无企业微信连接</div>}
            </section>
          </div>

          {others.length ? (
            <section className="space-y-3">
              <div className="text-sm font-semibold text-[var(--color-text-primary)]">更多渠道</div>
              <div className="responsive-card-grid">
                {others.map((item) => <ChannelCard key={`${renderProjectId}-${renderGeneration}-${item.clientType}-${item.instanceId}`} channel={item} projectId={renderProjectId} generation={renderGeneration} isScopeCurrent={isScopeCurrent} onRefresh={load} />)}
              </div>
            </section>
          ) : null}

          <div className="surface-panel flex flex-wrap items-center justify-between gap-4 px-5 py-4">
            <div>
              <div className="text-sm font-semibold text-[var(--color-text-primary)]">安装更多渠道</div>
              <div className="mt-1 text-xs text-[var(--color-text-muted)]">从插件市场添加第三方渠道连接</div>
            </div>
            <button className="btn-ghost" onClick={() => setRoute('plugins')}>打开插件市场</button>
          </div>
        </div>
      </div>
    </div>
  );
}
