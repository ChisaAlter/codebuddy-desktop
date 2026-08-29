// G8: 命令面板目录与过滤（对照 WebUI 2.138 ⌘/Ctrl+Shift+H：视图 + 动作 + 斜杠命令 + 主题/语言）。
// 目录构建与过滤是纯函数；执行由 CommandPalette 组件回调 store/route 完成。

import { NAV_GROUPS } from './codebuddy-schema';

export const PALETTE_KINDS = ['view', 'action', 'command', 'theme', 'language'];

const THEME_OPTIONS = ['dark', 'light', 'system'];
const LOCALE_OPTIONS = ['zh', 'en', 'system'];

export function buildPaletteCommands({ t, slashCommands = [], theme = 'dark', locale = 'system' } = {}) {
  const tr = typeof t === 'function' ? t : (key) => key;
  const commands = [];
  commands.push({ id: 'view:chat', kind: 'view', label: tr('palette.view.chat'), value: 'chat' });
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      commands.push({ id: `view:${item.id}`, kind: 'view', label: item.label, value: item.id });
    }
  }
  commands.push(
    { id: 'action:new-conversation', kind: 'action', label: tr('palette.action.newConversation'), value: 'new-conversation' },
    { id: 'action:toggle-sidebar', kind: 'action', label: tr('palette.action.toggleSidebar'), value: 'toggle-sidebar' },
    { id: 'action:session-history', kind: 'action', label: tr('palette.action.sessionHistory'), value: 'session-history' },
  );
  const seen = new Set();
  for (const command of Array.isArray(slashCommands) ? slashCommands : []) {
    const name = String(command?.name || '').trim().replace(/^\/+/, '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    commands.push({
      id: `command:${name}`,
      kind: 'command',
      label: `/${name}`,
      hint: String(command?.description || ''),
      value: name,
    });
  }
  for (const option of THEME_OPTIONS) {
    commands.push({
      id: `theme:${option}`,
      kind: 'theme',
      label: tr(`palette.theme.${option}`),
      value: option,
      active: theme === option,
    });
  }
  for (const option of LOCALE_OPTIONS) {
    commands.push({
      id: `language:${option}`,
      kind: 'language',
      label: tr(`palette.language.${option}`),
      value: option,
      active: locale === option,
    });
  }
  return commands;
}

/** 子序列模糊匹配得分：不匹配返回 -1；前缀/连续命中得分更高。 */
export function fuzzyScore(query, text) {
  const q = String(query || '').toLowerCase();
  const s = String(text || '').toLowerCase();
  if (!q) return 0;
  let score = 0;
  let index = 0;
  let streak = 0;
  for (const char of q) {
    const found = s.indexOf(char, index);
    if (found < 0) return -1;
    streak = found === index ? streak + 1 : 1;
    score += streak;
    if (found === 0) score += 2;
    index = found + 1;
  }
  score -= Math.max(0, s.length - q.length) * 0.01;
  return score;
}

export function filterPaletteCommands(commands, query, limit = 50) {
  const list = Array.isArray(commands) ? commands : [];
  const trimmed = String(query || '').trim();
  if (!trimmed) return list.slice(0, limit);
  return list
    .map((command) => ({
      command,
      score: Math.max(
        fuzzyScore(trimmed, command.label),
        command.hint ? fuzzyScore(trimmed, command.hint) * 0.5 : -1,
        fuzzyScore(trimmed, command.id) * 0.75,
      ),
    }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.command);
}

// —— 跨视图 composer 插入（palette 选择斜杠命令 → chat composer 预填）——
// 与 settings-nav 的 pending-section 模式一致：模块级 pending + 自定义事件。
let pendingComposerInsert = null;

export function requestComposerInsert(text) {
  pendingComposerInsert = String(text || '');
  window.dispatchEvent(new CustomEvent('codebuddy:composer-insert', { detail: pendingComposerInsert }));
  return pendingComposerInsert;
}

export function consumePendingComposerInsert() {
  const text = pendingComposerInsert;
  pendingComposerInsert = null;
  return text;
}
