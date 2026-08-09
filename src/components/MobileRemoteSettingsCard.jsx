import React, { useCallback, useEffect, useRef, useState } from 'react';
import ActionConfirmDialog from './ActionConfirmDialog';

/**
 * Display helper for the device list / revoke confirm text: prefer the label,
 * fall back to the id prefix, and never crash when `deviceId` is missing
 * (older devices / malformed relay responses may omit it).
 */
export function deviceDisplayName(device) {
  if (device?.label) return device.label;
  const id = String(device?.deviceId || '');
  return id ? id.slice(0, 12) : '';
}

/**
 * Desktop-only: 手机远程（meet-me relay + E2EE pairing）.
 * Distinct from channel 「远程控制」(WeChat/WeCom).
 */
export default function MobileRemoteSettingsCard({ t }) {
  const api = typeof window !== 'undefined' ? window.electronAPI : null;
  const available = Boolean(api?.mobileRemoteGetStatus);

  const [status, setStatus] = useState(null);
  const [config, setConfig] = useState(null);
  const [offerUrl, setOfferUrl] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [devices, setDevices] = useState([]);
  const [busy, setBusy] = useState(false);
  // Synchronous in-flight guard for the TLS toggle: React batches state updates,
  // so two clicks inside the same batch both observe the old `busy` value.
  const tlsToggleBusyRef = useRef(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  // M-rc1: pending device revoke drives the shared ActionConfirmDialog instead
  // of the blocking, unstyleable window.confirm.
  const [pendingRevoke, setPendingRevoke] = useState(null);

  const refresh = useCallback(async () => {
    if (!available) return;
    try {
      const [st, cfg, devs] = await Promise.all([
        api.mobileRemoteGetStatus(),
        api.mobileRemoteGetConfig(),
        api.mobileRemoteListDevices ? api.mobileRemoteListDevices() : Promise.resolve([]),
      ]);
      setStatus(st);
      setConfig(cfg);
      setDevices(Array.isArray(devs) ? devs : []);
      setError('');
    } catch (e) {
      setError(e?.message || String(e));
    }
  }, [api, available]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const loadOffer = useCallback(async () => {
    if (!available) return;
    setBusy(true);
    try {
      const result = await api.mobileRemoteGetPairingOffer();
      const url = result?.offerUrl || result?.qrPayload || '';
      setOfferUrl(url);
      if (url) {
        const { default: QRCode } = await import('qrcode');
        setQrDataUrl(
          await QRCode.toDataURL(url, { width: 220, margin: 1, errorCorrectionLevel: 'M' }),
        );
      } else {
        setQrDataUrl('');
      }
      setError('');
      await refresh();
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [api, available, refresh]);

  // C1: load an offer that embeds a fresh one-time pairing token, required to pair
  // a NEW device when devices already exist. The first device pairs without a token.
  const loadOfferWithToken = useCallback(async () => {
    if (!available || !api.mobileRemoteGetPairingOfferWithToken) return;
    setBusy(true);
    try {
      const result = await api.mobileRemoteGetPairingOfferWithToken();
      const url = result?.offerUrl || result?.qrPayload || '';
      setOfferUrl(url);
      if (url) {
        const { default: QRCode } = await import('qrcode');
        setQrDataUrl(
          await QRCode.toDataURL(url, { width: 220, margin: 1, errorCorrectionLevel: 'M' }),
        );
      } else {
        setQrDataUrl('');
      }
      setError('');
      await refresh();
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [api, available, refresh]);

  const setEnabled = async (enabled) => {
    if (!available || !config) return;
    setBusy(true);
    try {
      const result = await api.mobileRemoteSetConfig({ ...config, enabled });
      setConfig(result.config);
      setStatus(result.status);
      if (result.startError) {
        // The host failed to start and the config was rolled back to enabled=false
        // by the main process — surface the reason rather than silently showing off.
        setError(result.startError);
      } else if (result.config.enabled) {
        await loadOffer();
        setError('');
      } else {
        setOfferUrl('');
        setQrDataUrl('');
        setError('');
      }
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveEndpoint = async () => {
    if (!available || !config) return;
    setBusy(true);
    try {
      const result = await api.mobileRemoteSetConfig({
        ...config,
        relayEndpoint: String(config.relayEndpoint || '').trim(),
        relayUseTls: Boolean(config.relayUseTls),
      });
      setConfig(result.config);
      setStatus(result.status);
      if (result.startError) {
        setError(result.startError);
      } else if (result.config.enabled) {
        await loadOffer();
        setError('');
      } else {
        setError('');
      }
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const copyOffer = async () => {
    if (!offerUrl) return;
    try {
      await navigator.clipboard.writeText(offerUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setError(e?.message || String(e));
    }
  };

  if (!available) {
    return (
      <div className="settings-card">
        <p className="text-xs text-[var(--color-text-secondary)]">
          {t('mobileRemote.unavailable')}
        </p>
      </div>
    );
  }

  const enabled = Boolean(config?.enabled);

  return (
    <div className="settings-card space-y-3">
      <p className="text-xs leading-5 text-[var(--color-text-secondary)]">
        {t('mobileRemote.desc')}
      </p>

      <div className="settings-row">
        <div className="settings-label-col">
          <span className="settings-label">{t('mobileRemote.enable')}</span>
          <span className="settings-desc">{t('mobileRemote.enable.desc')}</span>
        </div>
        <button
          type="button"
          className={`settings-toggle-switch ${enabled ? 'on' : ''}`}
          disabled={busy || !config}
          aria-pressed={enabled}
          onClick={() => setEnabled(!enabled)}
        />
      </div>

      <div className="settings-row">
        <div className="settings-label-col">
          <span className="settings-label">{t('mobileRemote.relayEndpoint')}</span>
          <span className="settings-desc">{t('mobileRemote.relayEndpoint.desc')}</span>
        </div>
        <input
          className="settings-input wide"
          value={config?.relayEndpoint ?? ''}
          disabled={busy || !config}
          onChange={(e) => setConfig((c) => ({ ...c, relayEndpoint: e.target.value }))}
          onBlur={saveEndpoint}
          placeholder="127.0.0.1:8787"
        />
      </div>

      <div className="settings-row">
        <div className="settings-label-col">
          <span className="settings-label">{t('mobileRemote.useTls')}</span>
          <span className="settings-desc">{t('mobileRemote.useTls.desc')}</span>
        </div>
        <button
          type="button"
          className={`settings-toggle-switch ${config?.relayUseTls ? 'on' : ''}`}
          disabled={busy || !config}
          aria-pressed={Boolean(config?.relayUseTls)}
          onClick={() => {
            // Guard against double-clicks: concurrent mobileRemoteSetConfig
            // calls could resolve out of order and the stale response would
            // overwrite the newer toggle state. The ref is synchronous, unlike
            // the busy state (React batches updates within an event batch).
            if (busy || tlsToggleBusyRef.current || !config) return;
            tlsToggleBusyRef.current = true;
            setBusy(true);
            const next = { ...config, relayUseTls: !config?.relayUseTls };
            setConfig(next);
            api
              .mobileRemoteSetConfig(next)
              .then((result) => {
                setConfig(result.config);
                setStatus(result.status);
                if (result.startError) setError(result.startError);
                else if (result.config.enabled) loadOffer();
              })
              .catch((e) => setError(e?.message || String(e)))
              .finally(() => {
                tlsToggleBusyRef.current = false;
                setBusy(false);
              });
          }}
        />
      </div>

      {/* M-mr1: warn when the relay endpoint is non-localhost and TLS is off —
          transport is plaintext (metadata visible to a MITM; content stays E2EE). */}
      {config && !config.relayUseTls && (() => {
        const ep = String(config.relayEndpoint || '').trim();
        const isLocalhost = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(ep);
        return !isLocalhost && ep ? (
          <div className="rounded-md border border-[var(--color-accent-yellow)]/40 bg-[var(--color-accent-yellow)]/5 p-2 text-[11px] leading-5 text-[var(--color-accent-yellow)]">
            {t('mobileRemote.tlsWarn')}
          </div>
        ) : null;
      })()}

      <div className="settings-row">
        <div className="settings-label-col">
          <span className="settings-label">{t('mobileRemote.status')}</span>
          <span className="settings-desc font-mono text-[11px]">
            serverId={status?.serverId || '—'} ·{' '}
            {status?.relayConnected
              ? t('mobileRemote.relayOnline')
              : t('mobileRemote.relayOffline')}
          </span>
        </div>
        <button className="btn-ghost shrink-0 px-2 py-1 text-[11px]" disabled={busy} onClick={refresh}>
          {t('mobileRemote.refresh')}
        </button>
      </div>

      {status?.lastError ? (
        <div className="text-[11px] text-[var(--color-accent-yellow)]">{status.lastError}</div>
      ) : null}

      {enabled ? (
        <div className="rounded-md border border-[var(--color-border-default)] p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-[var(--color-text-primary)]">
              {t('mobileRemote.pairing')}
            </span>
            <div className="flex gap-1">
              <button
                className="btn-ghost px-2 py-1 text-[11px]"
                disabled={busy}
                onClick={loadOffer}
              >
                {busy ? '…' : t('mobileRemote.regenerate')}
              </button>
              {/* C1: pair a NEW device — embeds a one-time token in the offer so it
                  can pair against a non-empty trust store. */}
              {api.mobileRemoteGetPairingOfferWithToken ? (
                <button
                  className="btn-ghost px-2 py-1 text-[11px]"
                  disabled={busy}
                  onClick={loadOfferWithToken}
                  title={devices.length > 0 ? '生成带配对令牌的二维码（用于添加新设备）' : '生成配对二维码（首台设备无需令牌）'}
                >
                  {busy ? '…' : t('mobileRemote.pairNew')}
                </button>
              ) : null}
              <button
                className="btn-primary px-2 py-1 text-[11px]"
                disabled={busy || !offerUrl}
                onClick={copyOffer}
              >
                {copied ? t('mobileRemote.copied') : t('mobileRemote.copyLink')}
              </button>
            </div>
          </div>
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt="mobile-remote pairing QR"
              className="mx-auto rounded bg-white p-2"
              width={220}
              height={220}
            />
          ) : (
            <p className="text-center text-xs text-[var(--color-text-secondary)]">
              {t('mobileRemote.qrHint')}
            </p>
          )}
          {offerUrl ? (
            <pre className="mt-2 max-h-20 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-[var(--color-text-secondary)]">
              {offerUrl}
            </pre>
          ) : null}
          <p className="mt-2 text-[11px] text-[var(--color-text-secondary)]">
            {t('mobileRemote.pairingWarn')}
          </p>
        </div>
      ) : null}

      {error ? <div className="text-xs text-[var(--color-accent-red)]">{error}</div> : null}

      {devices.length > 0 ? (
        <div className="rounded-md border border-[var(--color-border-default)] p-3">
          <div className="mb-2 text-xs font-medium text-[var(--color-text-primary)]">
            {t('mobileRemote.devices')}
          </div>
          <ul className="space-y-1">
            {devices.map((d, index) => (
              <li
                key={d.deviceId || `device-${index}`}
                className="flex items-center justify-between gap-2 text-[11px]"
              >
                <span className="min-w-0 truncate text-[var(--color-text-secondary)]">
                  {deviceDisplayName(d)}
                  {d.deviceId ? (
                    <span className="ml-1 text-[var(--color-text-tertiary)]">{d.deviceId.slice(0, 8)}</span>
                  ) : null}
                </span>
                <button
                  className="btn-ghost shrink-0 px-2 py-1 text-[11px] text-[var(--color-accent-red)]"
                  disabled={busy}
                  onClick={() => {
                    // M-rc1: open the shared ActionConfirmDialog instead of window.confirm.
                    if (!api.mobileRemoteRevokeDevice) return;
                    setPendingRevoke(d);
                  }}
                >
                  {t('mobileRemote.revoke')}
                </button>
              </li>
            ))}
          </ul>
          {/* C1: legacy devices (pre device-auth) lack a stored public key and are
              dropped on load; users must re-pair them. */}
          <p className="mt-2 text-[11px] text-[var(--color-text-tertiary)]">
            {t('mobileRemote.repairHint')}
          </p>
        </div>
      ) : null}

      {/* M-rc1: device revoke confirmation via the shared ActionConfirmDialog. */}
      <ActionConfirmDialog
        open={Boolean(pendingRevoke)}
        title={t('mobileRemote.revokeTitle')}
        description={`${t('mobileRemote.revokeDescription')}${pendingRevoke ? `（${deviceDisplayName(pendingRevoke)}）` : ''}`}
        confirmLabel={t('mobileRemote.confirmRevoke')}
        busy={busy}
        error=""
        danger
        onCancel={() => {
          if (busy) return;
          setPendingRevoke(null);
        }}
        onConfirm={async () => {
          if (!pendingRevoke || !api.mobileRemoteRevokeDevice) return;
          setBusy(true);
          try {
            await api.mobileRemoteRevokeDevice(pendingRevoke.deviceId);
            await refresh();
            setPendingRevoke(null);
          } catch (e) {
            setError(e?.message || String(e));
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}
