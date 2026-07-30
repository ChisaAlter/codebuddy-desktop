import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_GUI_SETTINGS,
  GUI_PREFERENCES_KEY,
  SETTINGS_CACHE_KEY,
  isGuiSettingKey,
  loadGuiSettings,
  normalizeGuiSettings,
  saveGuiSettings,
  stripGuiSettings,
} from '../../src/lib/gui-settings.js';

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
    clear() {
      map.clear();
    },
  };
}

describe('gui-settings', () => {
  let storage;

  beforeEach(() => {
    storage = createMemoryStorage();
    globalThis.localStorage = storage;
  });

  afterEach(() => {
    delete globalThis.localStorage;
  });

  it('returns defaults when storage is empty', () => {
    expect(loadGuiSettings()).toEqual(DEFAULT_GUI_SETTINGS);
  });

  it('loads preferences from the dedicated key', () => {
    storage.setItem(
      GUI_PREFERENCES_KEY,
      JSON.stringify({
        theme: 'light',
        promptSuggestionEnabled: true,
        enablePasteImageFromClipboard: true,
        showTokensCounter: true,
        desktopNotificationsEnabled: false,
      }),
    );

    expect(loadGuiSettings()).toEqual({
      theme: 'light',
      locale: 'system',
      promptSuggestionEnabled: true,
      enablePasteImageFromClipboard: true,
      showTokensCounter: true,
      desktopNotificationsEnabled: false,
      // missing key → soft default global (runtime still re-resolves from disk OAuth)
      accountLoginSite: 'global',
      lastAccountUser: null,
      doNotDisturb: false,
      sessionAutoAllowFileEdits: false,
      requestPermissionOnFirstToolUse: false,
    });
  });

  it('normalizes accountLoginSite and lastAccountUser', () => {
    expect(normalizeGuiSettings({ accountLoginSite: 'global' }).accountLoginSite).toBe('global');
    expect(normalizeGuiSettings({ accountLoginSite: 'weird' }).accountLoginSite).toBe('global');
    expect(normalizeGuiSettings({ accountLoginSite: 'cn' }).accountLoginSite).toBe('cn');
    expect(
      normalizeGuiSettings({
        lastAccountUser: { userNickname: '  Ayase  ', userId: 'u1' },
      }).lastAccountUser,
    ).toEqual({ userNickname: 'Ayase', userId: 'u1' });
    expect(normalizeGuiSettings({ lastAccountUser: { foo: 1 } }).lastAccountUser).toBeNull();
  });

  it('migrates GUI fields from legacy mixed settings cache once', () => {
    storage.setItem(
      SETTINGS_CACHE_KEY,
      JSON.stringify({
        theme: 'light',
        promptSuggestionEnabled: true,
        'gateway.port': 1234,
      }),
    );

    const loaded = loadGuiSettings();
    expect(loaded.theme).toBe('light');
    expect(loaded.promptSuggestionEnabled).toBe(true);
    expect(JSON.parse(storage.getItem(GUI_PREFERENCES_KEY))).toMatchObject({
      theme: 'light',
      promptSuggestionEnabled: true,
    });
    // Legacy backend cache key must remain for offline settings.
    expect(storage.getItem(SETTINGS_CACHE_KEY)).toContain('gateway.port');
  });

  it('does not write default preferences when legacy cache is backend-only', () => {
    storage.setItem(SETTINGS_CACHE_KEY, JSON.stringify({ 'gateway.port': 1234, models: [] }));

    expect(loadGuiSettings()).toEqual(DEFAULT_GUI_SETTINGS);
    expect(storage.getItem(GUI_PREFERENCES_KEY)).toBeNull();
  });

  it('normalizes unknown theme values', () => {
    expect(normalizeGuiSettings({ theme: 'neon' }).theme).toBe('dark');
  });

  it('normalizes locale modes', () => {
    expect(normalizeGuiSettings({ locale: 'en' }).locale).toBe('en');
    expect(normalizeGuiSettings({ locale: 'zh' }).locale).toBe('zh');
    expect(normalizeGuiSettings({ locale: 'system' }).locale).toBe('system');
    expect(normalizeGuiSettings({ locale: 'fr' }).locale).toBe('system');
  });

  it('saveGuiSettings only writes the preferences key', () => {
    storage.setItem(SETTINGS_CACHE_KEY, JSON.stringify({ 'gateway.port': 9 }));
    saveGuiSettings({ theme: 'system', showTokensCounter: true });

    expect(JSON.parse(storage.getItem(GUI_PREFERENCES_KEY))).toMatchObject({
      theme: 'system',
      showTokensCounter: true,
    });
    expect(JSON.parse(storage.getItem(SETTINGS_CACHE_KEY))).toEqual({ 'gateway.port': 9 });
  });

  it('stripGuiSettings removes only GUI keys', () => {
    expect(
      stripGuiSettings({
        theme: 'light',
        showTokensCounter: true,
        'gateway.port': 1,
        models: ['a'],
      }),
    ).toEqual({
      'gateway.port': 1,
      models: ['a'],
    });
  });

  it('isGuiSettingKey recognizes only GUI keys', () => {
    expect(isGuiSettingKey('theme')).toBe(true);
    expect(isGuiSettingKey('gateway.port')).toBe(false);
  });
});
