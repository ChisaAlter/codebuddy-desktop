// G8: 命令面板（⌘/Ctrl+Shift+H）——视图 / 动作 / 斜杠命令 / 主题 / 语言。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, LayoutGrid, Zap, TerminalSquare, Palette, Languages, Check } from 'lucide-react';
import { useStore } from '../store';
import { resolveLocaleMode, translate } from '../lib/i18n';
import { buildPaletteCommands, filterPaletteCommands, requestComposerInsert } from '../lib/command-palette';

const KIND_ICONS = {
  view: LayoutGrid,
  action: Zap,
  command: TerminalSquare,
  theme: Palette,
  language: Languages,
};

function useUiTranslate() {
  const locale = useStore((s) => resolveLocaleMode(s.guiSettings?.locale || 'system'));
  return useCallback((key, params) => translate(locale, key, params), [locale]);
}

export default function CommandPalette({ open, onClose }) {
  const t = useUiTranslate();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const availableCommands = useStore((s) => s.availableCommands);
  const theme = useStore((s) => s.guiSettings?.theme || 'dark');
  const locale = useStore((s) => s.guiSettings?.locale || 'system');
  const setRoute = useStore((s) => s.setRoute);
  const updateGuiSetting = useStore((s) => s.updateGuiSetting);
  const setSidebarCollapsed = useStore((s) => s.setSidebarCollapsed);

  const commands = useMemo(
    () => buildPaletteCommands({ t, slashCommands: availableCommands, theme, locale }),
    [t, availableCommands, theme, locale],
  );
  const filtered = useMemo(() => filterPaletteCommands(commands, query), [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelectedIndex(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    const item = listRef.current?.querySelector('[data-selected="true"]');
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, filtered]);

  const execute = useCallback(
    (command) => {
      if (!command) return;
      onClose();
      const state = useStore.getState();
      if (command.kind === 'view') {
        setRoute(command.value);
        return;
      }
      if (command.kind === 'action') {
        if (command.value === 'toggle-sidebar') {
          setSidebarCollapsed(!state.sidebarCollapsed);
        } else if (command.value === 'new-conversation') {
          if (state.newSessionBusy || state.projectNavigationBusy) return;
          setRoute('chat');
          state.newSession().catch((error) => useStore.setState({ error: error?.message || '创建新对话失败' }));
        }
        return;
      }
      if (command.kind === 'command') {
        setRoute('chat');
        requestComposerInsert(`/${command.value} `);
        return;
      }
      if (command.kind === 'theme') {
        void updateGuiSetting('theme', command.value);
        return;
      }
      if (command.kind === 'language') {
        void updateGuiSetting('locale', command.value);
      }
    },
    [onClose, setRoute, setSidebarCollapsed, updateGuiSetting],
  );

  const onKeyDown = useCallback(
    (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedIndex((index) => Math.min(index + 1, filtered.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedIndex((index) => Math.max(index - 1, 0));
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        execute(filtered[selectedIndex]);
      }
    },
    [onClose, filtered, selectedIndex, execute],
  );

  if (!open) return null;

  let lastKind = null;
  return (
    <div className="fixed inset-0 z-[210] flex items-start justify-center pt-[12vh]" data-testid="command-palette">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.title')}
        className="relative mx-4 flex w-full max-w-[560px] flex-col overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-card)] shadow-2xl"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-border-default)] px-4 py-3">
          <Search size={15} className="shrink-0 text-[var(--color-text-muted)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('palette.placeholder')}
            className="w-full bg-transparent text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)]"
            data-testid="command-palette-input"
          />
          <kbd className="shrink-0 rounded border border-[var(--color-border-default)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
            Esc
          </kbd>
        </div>
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1" role="listbox">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-[var(--color-text-muted)]">{t('palette.empty')}</div>
          ) : (
            filtered.map((command, index) => {
              const Icon = KIND_ICONS[command.kind] || Zap;
              const showHeader = command.kind !== lastKind;
              lastKind = command.kind;
              return (
                <React.Fragment key={command.id}>
                  {showHeader ? (
                    <div className="px-4 pb-1 pt-2 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
                      {t(`palette.kind.${command.kind}`)}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === selectedIndex}
                    data-selected={index === selectedIndex ? 'true' : undefined}
                    className={`flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors ${
                      index === selectedIndex
                        ? 'bg-[var(--color-bg-hover)] text-[var(--color-text-primary)]'
                        : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'
                    }`}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onClick={() => execute(command)}
                  >
                    <Icon size={14} className="shrink-0 text-[var(--color-text-muted)]" />
                    <span className="min-w-0 flex-1 truncate">{command.label}</span>
                    {command.hint ? (
                      <span className="min-w-0 max-w-[45%] truncate text-xs text-[var(--color-text-muted)]">{command.hint}</span>
                    ) : null}
                    {command.active ? <Check size={13} className="shrink-0 text-[var(--color-accent-green)]" /> : null}
                  </button>
                </React.Fragment>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
