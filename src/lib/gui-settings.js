// GUI 偏好：主题、通知等本地 UI 开关。正式键与后端 settings 缓存分离。
import { normalizeAccountLoginSite, normalizeLastAccountUser } from './account-auth';

export const GUI_PREFERENCES_KEY = 'codebuddy-gui-preferences';
// 后端 /api/v1/settings 的离线缓存键（历史也混放过 GUI 字段，仅作迁移源读取）。
export const SETTINGS_CACHE_KEY = 'codebuddy-gui-settings';

const STORAGE_KEY = GUI_PREFERENCES_KEY;
const LEGACY_STORAGE_KEY = SETTINGS_CACHE_KEY;

export const DEFAULT_GUI_SETTINGS = {
  theme: 'dark',
  // WebUI locale mode: zh | en | system (resolved via navigator when system).
  locale: 'system',
  promptSuggestionEnabled: false,
  enablePasteImageFromClipboard: false,
  showTokensCounter: false,
  desktopNotificationsEnabled: true,
  // Do not disturb: suppress task notifications regardless of desktopNotificationsEnabled.
  doNotDisturb: false,
  // Auto-allow file-edit permission requests for the active session without showing the dialog.
  sessionAutoAllowFileEdits: false,
  // Request permission on the first tool use of each session (behavior hint label).
  requestPermissionOnFirstToolUse: false,
  // Production structured tool/subagent/goal output (WebUI-aligned clamp + cards).
  // Default true; set false only as emergency rollback to legacy pre dumps.
  structuredOutputV1: true,
  // Transport auto-reconnect on true network failures. Default true; set false
  // as emergency rollback (failure only surfaces error, no reconnect attempts).
  transportAutoReconnect: true,
  // Cloud account login site: cn (China) | global (international).
  // Default global = same as bare CLI (no INTERNET_ENVIRONMENT), so disk OAuth survives GUI restart.
  accountLoginSite: 'global',
  // Last successful cloud userinfo for sidebar display only (not proof of auth).
  lastAccountUser: null,
};

export const GUI_SETTING_KEYS = Object.freeze(Object.keys(DEFAULT_GUI_SETTINGS));
const GUI_SETTING_KEY_SET = new Set(GUI_SETTING_KEYS);

export function isGuiSettingKey(key) {
  return GUI_SETTING_KEY_SET.has(String(key || ''));
}

export function normalizeGuiSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const theme = ['dark', 'light', 'system'].includes(source.theme) ? source.theme : DEFAULT_GUI_SETTINGS.theme;
  const locale = ['zh', 'en', 'system'].includes(source.locale) ? source.locale : DEFAULT_GUI_SETTINGS.locale;
  return {
    theme,
    locale,
    promptSuggestionEnabled: source.promptSuggestionEnabled === true,
    enablePasteImageFromClipboard: source.enablePasteImageFromClipboard === true,
    showTokensCounter: source.showTokensCounter === true,
    desktopNotificationsEnabled: source.desktopNotificationsEnabled !== false,
    doNotDisturb: source.doNotDisturb === true,
    sessionAutoAllowFileEdits: source.sessionAutoAllowFileEdits === true,
    requestPermissionOnFirstToolUse: source.requestPermissionOnFirstToolUse === true,
    // Default on; only explicit false disables.
    structuredOutputV1: source.structuredOutputV1 !== false,
    // Default on; only explicit false disables auto-reconnect.
    transportAutoReconnect: source.transportAutoReconnect !== false,
    accountLoginSite: normalizeAccountLoginSite(source.accountLoginSite),
    lastAccountUser: normalizeLastAccountUser(source.lastAccountUser),
  };
}

function legacyHasGuiFields(source) {
  if (!source || typeof source !== 'object') return false;
  return GUI_SETTING_KEYS.some((key) => Object.prototype.hasOwnProperty.call(source, key));
}

export function loadGuiSettings() {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_GUI_SETTINGS };
  try {
    const current = localStorage.getItem(STORAGE_KEY);
    if (current) return normalizeGuiSettings(JSON.parse(current));
    const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!legacyRaw) return { ...DEFAULT_GUI_SETTINGS };
    const legacy = JSON.parse(legacyRaw);
    // 仅当旧缓存里仍带 GUI 字段时迁移；后端-only 缓存不应写成“默认偏好”覆盖用户。
    if (!legacyHasGuiFields(legacy)) return { ...DEFAULT_GUI_SETTINGS };
    const migrated = normalizeGuiSettings(legacy);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
    // Note: the legacy cache (LEGACY_STORAGE_KEY) also holds backend-only
    // settings (e.g. gateway.port), so it is intentionally NOT cleared here —
    // removing it would drop offline backend state. A re-migration on a future
    // load that loses STORAGE_KEY is harmless (the legacy cache is the source of
    // truth for backend keys the GUI does not own).
    return migrated;
  } catch (_) {
    return { ...DEFAULT_GUI_SETTINGS };
  }
}

export function saveGuiSettings(value) {
  const normalized = normalizeGuiSettings(value);
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  }
  return normalized;
}

// Keys that must never be treated as CodeBuddy CLI /api/v1/settings values.
// promptSuggestionEnabled is intentionally NOT stripped: WebUI stores it as a
// user-scope CLI setting, while older GUI builds also kept a local display flag.
const STRIP_FROM_BACKEND_SETTINGS = Object.freeze([
  'theme',
  'locale',
  'enablePasteImageFromClipboard',
  'showTokensCounter',
  'desktopNotificationsEnabled',
  'doNotDisturb',
  'sessionAutoAllowFileEdits',
  'requestPermissionOnFirstToolUse',
  'structuredOutputV1',
  'transportAutoReconnect',
  'accountLoginSite',
  'lastAccountUser',
]);

export function stripGuiSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return {};
  const next = { ...settings };
  for (const key of STRIP_FROM_BACKEND_SETTINGS) delete next[key];
  return next;
}
