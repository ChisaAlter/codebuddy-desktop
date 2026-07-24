import { useCallback, useEffect, useState } from 'react';

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    if (!available) return;
    try {
      const [st, cfg] = await Promise.all([
        api.mobileRemoteGetStatus(),
        api.mobileRemoteGetConfig(),
      ]);
      setStatus(st);
      setConfig(cfg);
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

  const setEnabled = async (enabled) => {
    if (!available || !config) return;
    setBusy(true);
    try {
      const result = await api.mobileRemoteSetConfig({ ...config, enabled });
      setConfig(result.config);
      setStatus(result.status);
      if (enabled) await loadOffer();
      else {
        setOfferUrl('');
        setQrDataUrl('');
      }
      setError('');
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
      if (result.config.enabled) await loadOffer();
      setError('');
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
            const next = { ...config, relayUseTls: !config?.relayUseTls };
            setConfig(next);
            api.mobileRemoteSetConfig(next).then((result) => {
              setConfig(result.config);
              setStatus(result.status);
              if (result.config.enabled) loadOffer();
            });
          }}
        />
      </div>

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
    </div>
  );
}
