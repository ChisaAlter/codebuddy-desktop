const STORAGE_KEY = 'codebuddy-gui-keybindings';

export const GUI_KEYBINDING_ACTIONS = [
  { id: 'toggle-sidebar', label: '切换侧边栏', defaultShortcut: 'ctrl+b' },
  { id: 'new-conversation', label: '新建对话', defaultShortcut: 'ctrl+alt+n' },
  { id: 'open-chat', label: '打开对话', defaultShortcut: 'ctrl+1' },
  { id: 'open-terminal', label: '打开终端', defaultShortcut: 'ctrl+2' },
  { id: 'open-editor', label: '打开编辑器', defaultShortcut: 'ctrl+3' },
  { id: 'open-changes', label: '打开变更', defaultShortcut: 'ctrl+4' },
  { id: 'open-settings', label: '打开设置', defaultShortcut: 'ctrl+,' },
];

export function normalizeShortcut(value) {
  const aliases = { control: 'ctrl', cmd: 'meta', command: 'meta', option: 'alt' };
  const parts = String(value || '')
    .trim()
    .toLowerCase()
    .split('+')
    .map((part) => aliases[part.trim()] || part.trim())
    .filter(Boolean);
  const modifiers = ['ctrl', 'alt', 'shift', 'meta'].filter((modifier) => parts.includes(modifier));
  const key = parts.find((part) => !['ctrl', 'alt', 'shift', 'meta'].includes(part));
  return key ? [...modifiers, key].join('+') : '';
}

const RESERVED_SHORTCUTS = new Map([
  ['f5', '系统刷新快捷键不可覆盖'],
  ['ctrl+r', '系统刷新快捷键不可覆盖'],
  ['ctrl+w', '窗口关闭快捷键不可覆盖'],
  ['ctrl+shift+w', '窗口关闭快捷键不可覆盖'],
  ['alt+f4', '窗口关闭快捷键不可覆盖'],
  ['ctrl+shift+i', '开发者工具快捷键不可覆盖'],
]);

export function guiShortcutValidationError(value) {
  const shortcut = normalizeShortcut(value);
  if (!shortcut) return '快捷键不能为空';
  return RESERVED_SHORTCUTS.get(shortcut) || '';
}

export function shortcutFromKeyboardEvent(event) {
  if (!event?.key || ['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return '';
  let key = event.key.toLowerCase();
  if (key === ' ') key = 'space';
  const parts = [];
  if (event.ctrlKey) parts.push('ctrl');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  if (event.metaKey) parts.push('meta');
  parts.push(key);
  return normalizeShortcut(parts.join('+'));
}

export function guiShortcutAllowedInInput(shortcut) {
  const parts = normalizeShortcut(shortcut).split('+');
  return parts.includes('ctrl') || parts.includes('alt') || parts.includes('meta');
}

export function defaultGuiKeybindings() {
  return Object.fromEntries(GUI_KEYBINDING_ACTIONS.map((action) => [action.id, action.defaultShortcut]));
}

// M-perf: module-level cache. The global keydown handler (capture phase, runs on
// every keystroke including plain typing) used to re-read localStorage + JSON.parse
// + re-normalize all shortcuts on every key press via the default parameter of
// guiActionForShortcut. Cache the parsed bindings and invalidate on save/reset.
let cachedGuiKeybindings = null;

export function loadGuiKeybindings() {
  if (cachedGuiKeybindings) return cachedGuiKeybindings;
  const defaults = defaultGuiKeybindings();
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const normalized = {};
    const shortcuts = new Set();
    for (const action of GUI_KEYBINDING_ACTIONS) {
      const shortcut = normalizeShortcut(stored?.[action.id]) || action.defaultShortcut;
      if (guiShortcutValidationError(shortcut) || shortcuts.has(shortcut)) {
        cachedGuiKeybindings = defaults;
        return defaults;
      }
      normalized[action.id] = shortcut;
      shortcuts.add(shortcut);
    }
    cachedGuiKeybindings = normalized;
    return normalized;
  } catch (_) {
    cachedGuiKeybindings = defaults;
    return defaults;
  }
}

export function saveGuiKeybindings(bindings) {
  const normalized = {};
  const shortcuts = new Map();
  for (const action of GUI_KEYBINDING_ACTIONS) {
    const shortcut = normalizeShortcut(bindings?.[action.id]) || action.defaultShortcut;
    const validationError = guiShortcutValidationError(shortcut);
    if (validationError) throw new Error(`${action.label}：${validationError}`);
    const duplicate = shortcuts.get(shortcut);
    if (duplicate) throw new Error(`“${action.label}”与“${duplicate}”使用了相同快捷键`);
    shortcuts.set(shortcut, action.label);
    normalized[action.id] = shortcut;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  cachedGuiKeybindings = normalized;
  window.dispatchEvent(new CustomEvent('codebuddy:gui-keybindings-changed', { detail: normalized }));
  return normalized;
}

export function resetGuiKeybindings() {
  cachedGuiKeybindings = null;
  return saveGuiKeybindings(defaultGuiKeybindings());
}

export function guiActionForShortcut(shortcut, bindings = loadGuiKeybindings()) {
  const normalized = normalizeShortcut(shortcut);
  if (!normalized) return null;
  return GUI_KEYBINDING_ACTIONS.find((action) => bindings[action.id] === normalized)?.id || null;
}
