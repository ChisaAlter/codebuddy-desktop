import React, { useEffect, useId, useRef } from 'react';
import { FileDiff, FolderOpen, Globe, SquareTerminal } from 'lucide-react';

const SURFACES = [
  { id: 'browser', icon: Globe },
  { id: 'terminal', icon: SquareTerminal },
  { id: 'files', icon: FolderOpen },
  { id: 'diff', icon: FileDiff },
];

/**
 * Right-panel surface chooser (Browser / Terminal / Files / Diff).
 * Renders inside RightPanelHost — not a centered modal.
 */
export default function SurfacePicker({ onSelect, t, compact = false }) {
  const titleId = useId();
  const subtitleId = useId();
  const firstCardRef = useRef(null);

  useEffect(() => {
    const timer = requestAnimationFrame(() => firstCardRef.current?.focus());
    return () => cancelAnimationFrame(timer);
  }, []);

  return (
    <div
      className={`surface-picker-panel${compact ? ' is-compact' : ''}`}
      data-testid="surface-picker"
      role="region"
      aria-labelledby={titleId}
      aria-describedby={subtitleId}
    >
      <div className="surface-picker-heading">
        <h2 id={titleId} className="surface-picker-title">
          {t('topbar.surfacesTitle')}
        </h2>
        <p id={subtitleId} className="surface-picker-subtitle">
          {t('topbar.surfacesSubtitle')}
        </p>
      </div>
      <div className="surface-picker-grid">
        {SURFACES.map((surface, index) => {
          const Icon = surface.icon;
          return (
            <button
              key={surface.id}
              ref={index === 0 ? firstCardRef : undefined}
              type="button"
              className="surface-picker-card"
              data-surface={surface.id}
              data-testid={`surface-card-${surface.id}`}
              onClick={() => onSelect?.(surface.id)}
            >
              <span className="surface-picker-card-icon" aria-hidden="true">
                <Icon size={22} strokeWidth={1.6} />
              </span>
              <span className="surface-picker-card-title">{t(`topbar.surface.${surface.id}`)}</span>
              <span className="surface-picker-card-desc">{t(`topbar.surface.${surface.id}Desc`)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export { SURFACES };
