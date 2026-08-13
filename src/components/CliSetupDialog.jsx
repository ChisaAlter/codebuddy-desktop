import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { copyTextToClipboard } from '../lib/clipboard';
import { ensureRecommendedCodeBuddyCli, getCliMaintenanceInfo } from '../lib/cli-maintenance';
import { resolveLocaleMode, translate } from '../lib/i18n';
import {
  isCliBlockedStatus,
  isCliSetupFirstLaunchDone,
  markCliSetupFirstLaunchDone,
  markSessionCliSetupSkipped,
  readSessionCliSetupSkipped,
} from '../lib/cli-setup-gate';
import { CODEBUDDY_CLI_BOOTSTRAP_COMMAND, requestSettingsSection } from '../lib/settings-nav';

/**
 * 启动时检测 CodeBuddy CLI（借鉴 pi-desktop Onboarding step1）：
 * - 桌面端 + 主壳已就绪后自动探测
 * - missing / outdated / unknown 时弹出；首启时也会弹出以便确认版本
 * - 一键安装推荐版、刷新、复制命令、打开设置、跳过（本会话）
 */
export default function CliSetupDialog() {
  const localeMode = useStore((s) => s.guiSettings?.locale || 'system');
  const productStateLoaded = useStore((s) => s.productStateLoaded);
  const setRoute = useStore((s) => s.setRoute);
  const t = useCallback(
    (key, vars) => translate(resolveLocaleMode(localeMode), key, vars),
    [localeMode],
  );

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [cliInfo, setCliInfo] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [installOutput, setInstallOutput] = useState('');
  const [probed, setProbed] = useState(false);
  const initialProbeDoneRef = useRef(false);

  const isDesktop = typeof window !== 'undefined' && Boolean(window.electronAPI);

  const probe = useCallback(async ({ showLoading = true } = {}) => {
    if (!isDesktop) return null;
    if (showLoading) setLoading(true);
    setError('');
    try {
      const info = await getCliMaintenanceInfo();
      setCliInfo(info);
      setProbed(true);
      return info;
    } catch (err) {
      setCliInfo(null);
      setProbed(true);
      setError(err?.message || translate(resolveLocaleMode(localeMode), 'cliSetup.probeFailed'));
      return null;
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [isDesktop, localeMode]);

  useEffect(() => {
    if (!isDesktop || !productStateLoaded) return undefined;
    if (initialProbeDoneRef.current) return undefined;
    if (readSessionCliSetupSkipped()) {
      initialProbeDoneRef.current = true;
      return undefined;
    }

    let cancelled = false;
    initialProbeDoneRef.current = true;
    (async () => {
      const info = await probe({ showLoading: true });
      if (cancelled) return;
      const status = info?.compat?.status;
      const blocked = isCliBlockedStatus(status);
      const firstLaunch = !isCliSetupFirstLaunchDone();
      if (blocked || firstLaunch) {
        setOpen(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isDesktop, productStateLoaded, probe]);

  useEffect(() => {
    // Only re-probe while the setup dialog is open (user may have installed CLI in a terminal).
    if (!open || !isDesktop || installing) return undefined;
    let lastAt = 0;
    const onFocus = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const now = Date.now();
      if (now - lastAt < 2500) return;
      lastAt = now;
      probe({ showLoading: false }).then((info) => {
        if (!info?.compat) return;
        if (!isCliBlockedStatus(info.compat.status) && isCliSetupFirstLaunchDone()) {
          setOpen(false);
        }
      });
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [open, isDesktop, installing, probe]);

  const handleContinue = useCallback(() => {
    markCliSetupFirstLaunchDone();
    setOpen(false);
  }, []);

  const handleSkip = useCallback(() => {
    if (installing) return;
    markSessionCliSetupSkipped();
    markCliSetupFirstLaunchDone();
    setOpen(false);
  }, [installing]);

  const handleCopy = useCallback(async () => {
    try {
      await copyTextToClipboard(CODEBUDDY_CLI_BOOTSTRAP_COMMAND);
      setNotice(t('cli.commandCopied'));
    } catch (err) {
      setNotice(err?.message || t('cli.copyCommandFailed'));
    }
  }, [t]);

  const handleOpenSettings = useCallback(() => {
    if (installing) return;
    markCliSetupFirstLaunchDone();
    requestSettingsSection('settings-section-cli');
    setRoute('settings');
    setOpen(false);
  }, [installing, setRoute]);

  const handleOneClickInstall = useCallback(async () => {
    if (installing || loading) return;
    setInstalling(true);
    setError('');
    setNotice('');
    setInstallOutput('');
    try {
      const result = await ensureRecommendedCodeBuddyCli();
      setInstallOutput(result?.output || '');
      const info = await probe({ showLoading: false });
      const ok = info?.compat && !isCliBlockedStatus(info.compat.status);
      if (ok) {
        setNotice(
          t('cliSetup.installSuccess', {
            version: info?.version ? `v${info.version}` : result?.afterVersion || '',
          }),
        );
      } else if (result?.compat && !isCliBlockedStatus(result.compat.status)) {
        setCliInfo((current) => ({
          ...(current || {}),
          version: result.afterVersion,
          compat: result.compat,
        }));
        setNotice(t('cliSetup.installSuccess', { version: result.afterVersion ? `v${result.afterVersion}` : '' }));
      } else {
        setError(result?.compat?.message || t('cli.installFailed'));
      }
    } catch (err) {
      setError(err?.message || t('cli.installFailed'));
    } finally {
      setInstalling(false);
    }
  }, [installing, loading, probe, t]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        handleSkip();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, handleSkip]);

  if (!isDesktop || !open) return null;

  const status = cliInfo?.compat?.status;
  const blocked = isCliBlockedStatus(status);
  const ready = Boolean(cliInfo?.version) && !blocked;
  const versionLabel = cliInfo?.version ? `v${cliInfo.version}` : '';
  const recommended = cliInfo?.compat?.recommendedVersion || '2.135.0';
  const busy = loading || installing;

  const statusDotClass = busy && !ready
    ? 'bg-[var(--color-accent-yellow)] animate-pulse'
    : ready
      ? 'bg-[var(--color-accent-green)]'
      : 'bg-[var(--color-accent-red)]';

  const statusTitle = installing
    ? t('cliSetup.status.installing')
    : loading
      ? t('cliSetup.status.checking')
      : ready
        ? t('cliSetup.status.installed')
        : status === 'outdated'
          ? t('cliSetup.status.outdated')
          : status === 'unknown'
            ? t('cliSetup.status.unknown')
            : t('cliSetup.status.notFound');

  const statusDetail = installing
    ? t('cliSetup.detail.installing', { version: recommended })
    : loading
      ? t('cliSetup.detail.checking')
      : ready
        ? t('cliSetup.detail.version', { version: versionLabel || '—' })
        : cliInfo?.compat?.message || error || t('cliSetup.detail.notInstalled');

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cli-setup-title"
      data-testid="cli-setup-dialog"
    >
      <div className="w-full max-w-lg rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-6 shadow-2xl">
        <h2 id="cli-setup-title" className="text-lg font-semibold text-[var(--color-text-primary)]">
          {t('cliSetup.title')}
        </h2>
        <p className="mt-2 text-sm leading-6 text-[var(--color-text-secondary)]">{t('cliSetup.description')}</p>

        <div
          className="mt-5 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-4 py-3"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass}`} />
            <span className="text-sm font-medium text-[var(--color-text-primary)]">{statusTitle}</span>
          </div>
          <p className="mt-2 text-xs leading-5 text-[var(--color-text-secondary)]">{statusDetail}</p>
          {error && !ready ? (
            <p className="mt-1 text-xs text-[var(--color-accent-red)]" role="alert">
              {error}
            </p>
          ) : null}
          {cliInfo?.source ? (
            <p className="mt-1 break-all font-mono text-[11px] text-[var(--color-text-muted)]">
              {t('cliSetup.resolvedPath')}: {cliInfo.source}
            </p>
          ) : null}
        </div>

        {blocked && status === 'missing' ? (
          <div className="mt-4 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-code)] px-3 py-3">
            <div className="text-[11px] text-[var(--color-text-muted)]">{t('cli.bootstrapCommand')}</div>
            <code className="mt-1 block break-all font-mono text-[12px] text-[var(--color-text-primary)]">
              {CODEBUDDY_CLI_BOOTSTRAP_COMMAND}
            </code>
            <p className="mt-2 text-[11px] leading-5 text-[var(--color-text-muted)]">{t('cliSetup.oneClickHint')}</p>
          </div>
        ) : null}

        {installOutput ? (
          <pre className="mt-3 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-code)] px-3 py-2 font-mono text-[11px] text-[var(--color-text-secondary)]">
            {installOutput}
          </pre>
        ) : null}

        {notice ? (
          <div className="mt-3 text-xs text-[var(--color-accent-green)]">{notice}</div>
        ) : null}

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          <button type="button" className="btn-ghost px-3 py-1.5 text-xs" disabled={installing} onClick={handleSkip}>
            {t('cliSetup.skip')}
          </button>
          <button
            type="button"
            className="btn-ghost px-3 py-1.5 text-xs"
            disabled={busy}
            onClick={() => {
              setNotice('');
              setInstallOutput('');
              probe({ showLoading: true });
            }}
          >
            {loading && !installing ? t('cliSetup.refreshing') : t('cliSetup.refresh')}
          </button>
          {blocked && status === 'missing' ? (
            <button type="button" className="btn-ghost px-3 py-1.5 text-xs" disabled={installing} onClick={handleCopy}>
              {t('cli.copyCommand')}
            </button>
          ) : null}
          <button type="button" className="btn-ghost px-3 py-1.5 text-xs" disabled={installing} onClick={handleOpenSettings}>
            {t('cliSetup.openSettings')}
          </button>
          {blocked ? (
            <button
              type="button"
              className="btn-primary px-3 py-1.5 text-xs"
              disabled={busy}
              onClick={handleOneClickInstall}
              data-testid="cli-setup-one-click-install"
            >
              {installing
                ? t('cli.installing')
                : t('cli.oneClickInstall', { version: recommended })}
            </button>
          ) : ready ? (
            <button type="button" className="btn-primary px-3 py-1.5 text-xs" disabled={busy} onClick={handleContinue}>
              {t('cliSetup.continue')}
            </button>
          ) : probed && !loading ? (
            <button type="button" className="btn-primary px-3 py-1.5 text-xs" disabled={busy} onClick={handleSkip}>
              {t('cliSetup.continueAnyway')}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
