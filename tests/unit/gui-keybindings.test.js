import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultGuiKeybindings,
  guiActionForShortcut,
  guiShortcutAllowedInInput,
  loadGuiKeybindings,
  saveGuiKeybindings,
} from '../../src/lib/gui-keybindings';

describe('GUI keybindings in text inputs', () => {
  it('allows command-modified shortcuts without capturing normal typing', () => {
    expect(guiShortcutAllowedInInput('ctrl+b')).toBe(true);
    expect(guiShortcutAllowedInInput('ctrl+alt+n')).toBe(true);
    expect(guiShortcutAllowedInInput('meta+1')).toBe(true);
    expect(guiShortcutAllowedInInput('alt+ArrowLeft')).toBe(true);
    expect(guiShortcutAllowedInInput('b')).toBe(false);
    expect(guiShortcutAllowedInInput('shift+b')).toBe(false);
  });
});

describe('GUI keybindings module cache (M-perf)', () => {
  let stored;

  beforeEach(() => {
    stored = '{}';
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => stored),
      setItem: vi.fn((_key, value) => {
        stored = String(value);
      }),
      removeItem: vi.fn(() => {
        stored = '{}';
      }),
    });
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses localStorage once and serves the cached bindings afterwards', () => {
    const getItem = vi.mocked(localStorage.getItem);
    const first = loadGuiKeybindings();
    expect(first['open-chat']).toBe('ctrl+1');

    const second = loadGuiKeybindings();
    expect(second).toEqual(first);
    // The cache must be a single object: repeated calls (e.g. the global
    // keydown handler on every keystroke) must not re-read + re-parse storage.
    expect(getItem).toHaveBeenCalledTimes(1);
  });

  it('invalidates the cache on save so new bindings take effect immediately', () => {
    const custom = { ...defaultGuiKeybindings(), 'open-chat': 'ctrl+alt+1' };
    saveGuiKeybindings(custom);
    expect(loadGuiKeybindings()['open-chat']).toBe('ctrl+alt+1');
    expect(guiActionForShortcut('ctrl+alt+1')).toBe('open-chat');
    expect(guiActionForShortcut('ctrl+1')).toBeNull();
  });
});
