import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Shrink, Settings2 } from 'lucide-react';
import { useStore } from '../store';
import { resolveLocaleMode, translate } from '../lib/i18n';
import { effectiveAutoCompactWindow } from '../lib/autocompact';
import { requestSettingsSection } from '../lib/settings-nav';

// 对齐 CodeBuddy CLI 2.128 WebUI 的输入框上下文用量功能：
// 环形百分比指示器 + 五类用量明细面板 + 一键压缩当前会话按钮。

// 颜色阈值（与 WebUI QQ 组件一致）：
// <60% 灰；>=60% 黄；>=70% 红；>=92% 加 pulse。
const WARN_THRESHOLD = 0.6;
const DANGER_THRESHOLD = 0.7;
const PULSE_THRESHOLD = 0.92;

// 五类用量颜色（映射到 GUI CSS 变量 token；WebUI 原色见 bundle Uo 常量）。
const CATEGORY_COLORS = {
  systemPrompt: 'var(--color-accent-green)',
  tools: 'var(--color-accent-yellow)',
  conversation: 'var(--color-accent-purple)',
  mcp: 'var(--color-accent-teal)',
  skills: 'var(--color-accent-blue)',
};

const CATEGORY_ORDER = ['systemPrompt', 'tools', 'conversation', 'mcp', 'skills'];

function useT() {
  const localeMode = useStore((state) => state.guiSettings?.locale || 'system');
  const [systemTick, setSystemTick] = useState(0);
  useEffect(() => {
    if (localeMode !== 'system') return undefined;
    const onChange = () => setSystemTick((value) => value + 1);
    window.addEventListener('languagechange', onChange);
    return () => window.removeEventListener('languagechange', onChange);
  }, [localeMode]);
  return useMemo(() => {
    void systemTick;
    const resolved = resolveLocaleMode(localeMode);
    return (key, vars) => translate(resolved, key, vars);
  }, [localeMode, systemTick]);
}

// 数字缩写：>=1M → X.XM，>=1k → X.Xk，否则原值。对齐 WebUI qk()。
function formatTokenCount(value) {
  const n = Number(value) || 0;
  if (n >= 1e6) {
    const m = n / 1e6;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function ringColorClass(ratio) {
  if (ratio >= DANGER_THRESHOLD) return 'text-[var(--color-accent-red)]';
  if (ratio >= WARN_THRESHOLD) return 'text-[var(--color-accent-yellow)]';
  return 'text-[var(--color-text-muted)]';
}

export default function ContextUsageIndicator({ usage, onCompact, disabled, compactState }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  // G12: autocompact panel — mirror CLI settings state next to the usage ring.
  const autoCompactEnabled = useStore((s) => Boolean(s.settings?.autoCompactEnabled));
  const autoCompactWindow = useStore((s) => s.settings?.autoCompactWindow ?? null);
  const setRoute = useStore((s) => s.setRoute);

  // 外部点击关闭面板。
  useEffect(() => {
    if (!open) return undefined;
    const onMouseDown = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  // Escape 关闭。
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const handleCompactClick = useCallback(() => {
    if (disabled || compactState === 'compacting') return;
    setOpen(false);
    onCompact?.();
  }, [disabled, compactState, onCompact]);

  if (!usage || !usage.size || usage.size <= 0) return null;

  const ratio = Math.min((Number(usage.used) || 0) / usage.size, 1);
  const percent = Math.round(ratio * 100);
  const percentFormatted = (ratio * 100).toFixed(1);
  const colorClass = ringColorClass(ratio);
  const pulsing = ratio >= PULSE_THRESHOLD;

  // SVG 环形参数：r=7，周长 = 2πr ≈ 43.98。
  const r = 7;
  const circumference = 2 * Math.PI * r;
  const dash = ratio * circumference;

  const byCategory = usage.usageByCategory && typeof usage.usageByCategory === 'object' ? usage.usageByCategory : null;
  const breakdownRows = CATEGORY_ORDER.map((key) => ({
    key,
    label: t(`composer.contextUsage.category.${key}`),
    value: Number(byCategory?.[key]) || 0,
    color: CATEGORY_COLORS[key],
  })).filter((row) => row.value > 0);

  const compacting = compactState === 'compacting';
  const compactDisabled = disabled || compacting;

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={`flex items-center gap-1 h-6 px-1.5 rounded-full text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)] transition-colors ${pulsing ? 'animate-pulse' : ''}`}
        title={t('composer.contextUsage.title')}
        aria-label={t('composer.contextUsage.open')}
        aria-expanded={open}
        data-testid="context-usage-toggle"
      >
        <svg width="16" height="16" viewBox="0 0 18 18" className={colorClass}>
          <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
          <circle
            cx="9"
            cy="9"
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circumference}`}
            transform="rotate(-90 9 9)"
          />
        </svg>
        <span className={`text-[11px] tabular-nums ${colorClass}`}>{percent}%</span>
      </button>

      {open ? (
        <div
          className="absolute bottom-full right-0 mb-2 z-50 w-56 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-2.5 shadow-lg"
          role="dialog"
          data-testid="context-usage-panel"
        >
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-medium text-[var(--color-text-primary)]">
              {t('composer.contextUsage.title')}
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="flex items-center justify-center w-4 h-4 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
              aria-label={t('composer.contextUsage.close')}
            >
              <X size={12} />
            </button>
          </div>

          <div className="mt-1 flex items-baseline gap-1.5 whitespace-nowrap">
            <span className="text-[15px] font-semibold text-[var(--color-text-primary)] tabular-nums">
              {percentFormatted}%
            </span>
            <span className="text-[11px] text-[var(--color-text-muted)] tabular-nums">
              {t('composer.contextUsage.usedLabel')} {formatTokenCount(usage.used)} / {formatTokenCount(usage.size)}
            </span>
          </div>

          {breakdownRows.length > 0 ? (
            <>
              <div className="mt-2 flex h-1 w-full overflow-hidden rounded-full bg-[var(--color-bg-primary)]">
                {breakdownRows.map((row) => (
                  <div
                    key={row.key}
                    style={{ width: `${Math.min((row.value / usage.size) * 100, 100)}%`, backgroundColor: row.color }}
                  />
                ))}
              </div>
              <div className="mt-2 space-y-1">
                {breakdownRows.map((row) => (
                  <div key={row.key} className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 flex-none rounded-full" style={{ backgroundColor: row.color }} />
                    <span className="flex-1 text-[11px] text-[var(--color-text-muted)] truncate">{row.label}</span>
                    <span className="text-[11px] text-[var(--color-text-muted)] tabular-nums">
                      {((row.value / usage.size) * 100).toFixed(1)}%
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {/* G12: /autocompact 面板 — 展示自动压缩开关、窗口基准与生效值 */}
          <div className="mt-2 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-2 py-1.5" data-testid="autocompact-panel">
            <div className="flex items-center justify-between gap-1">
              <span className="text-[11px] font-medium text-[var(--color-text-secondary)]">
                {t('composer.autocompact.title')}
              </span>
              <button
                type="button"
                className="flex items-center gap-1 rounded px-1 py-0.5 text-[10px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
                onClick={() => {
                  setOpen(false);
                  requestSettingsSection('settings-section-settings-group-behavior');
                  setRoute('settings');
                }}
                title={t('composer.autocompact.configure')}
              >
                <Settings2 size={11} aria-hidden="true" />
                {t('composer.autocompact.configure')}
              </button>
            </div>
            <div className="mt-1 flex items-center justify-between text-[11px] text-[var(--color-text-muted)]">
              <span>{autoCompactEnabled ? t('composer.autocompact.enabled') : t('composer.autocompact.disabled')}</span>
              <span className="tabular-nums">
                {t('composer.autocompact.window')}{' '}
                {(() => {
                  const effective = effectiveAutoCompactWindow(autoCompactWindow, usage.size);
                  return effective ? formatTokenCount(effective) : t('composer.autocompact.followModel');
                })()}
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={handleCompactClick}
            disabled={compactDisabled}
            className="mt-2.5 flex w-full items-center justify-center gap-1.5 h-7 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] text-[12px] font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="context-usage-compact"
          >
            {compacting ? (
              <>
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-border-default)] border-t-[var(--color-text-primary)]" />
                <span>{t('composer.contextUsage.compacting')}</span>
              </>
            ) : (
              <>
                <Shrink size={12} />
                <span>{t('composer.contextUsage.compact')}</span>
              </>
            )}
          </button>
        </div>
      ) : null}
    </div>
  );
}