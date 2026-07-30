import React from 'react';
import { useStore } from '../store';
import { resolveLocaleMode, translate } from '../lib/i18n';

/**
 * 无限画布（对照真实 WebUI canvas.title=无限画布）。
 * 真实 WebUI 的画布是一个可放置终端/编辑器面板的无限平铺工作区；
 * 桌面端首版提供标题栏 + 工具栏 + 空态引导，与真实文案对齐。
 * 完整的拖拽平铺面板能力属于后续大项，此处先保证侧栏入口可达、文案与空态一致。
 */
export default function ReplicaCanvasView() {
  const locale = useStore((state) => state.guiSettings?.locale || 'system');
  const setRoute = useStore((state) => state.setRoute);
  const t = React.useCallback((key, vars) => translate(resolveLocaleMode(locale), key, vars), [locale]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--color-bg-primary)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border-default)] px-4 py-2.5">
        <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">{t('canvas.title')}</h2>
        <div className="flex items-center gap-1">
          <button
            className="btn-ghost px-2 py-1 text-xs"
            title={t('canvas.add')}
            onClick={() => setRoute('terminal')}
          >
            + {t('canvas.add')}
          </button>
        </div>
      </div>
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="text-center">
          <svg
            className="mx-auto mb-3 text-[var(--color-text-muted)]"
            width="40"
            height="40"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            aria-hidden="true"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18M9 3v18" />
          </svg>
          <div className="text-sm text-[var(--color-text-muted)]">
            {t('canvas.empty')}
          </div>
        </div>
      </div>
    </div>
  );
}