// WebUI 2.138 busy-send semantics (`codebuddy.composer.busySendMode`).
// queue（默认）：忙碌时新消息进入队列；immediate：立即插入当前回合。
// 斜杠命令永远排队（与 WebUI Hk 一致）——它们改变会话状态，不适合并入当前回合。

export const BUSY_SEND_MODE_KEY = 'codebuddy.composer.busySendMode';
export const DEFAULT_BUSY_SEND_MODE = 'queue';

export function normalizeBusySendMode(value) {
  return value === 'queue' || value === 'immediate' ? value : undefined;
}

/** Read the mode from the CLI user settings tree (settings.codebuddy.composer.busySendMode). */
export function busySendModeFromSettings(settings) {
  const nested = settings?.codebuddy?.composer?.busySendMode;
  return normalizeBusySendMode(nested) || DEFAULT_BUSY_SEND_MODE;
}

/** WebUI Hk: queue when mode is queue, or when the text is a slash command. */
export function shouldQueueBusyPrompt(mode, text) {
  return normalizeBusySendMode(mode) !== 'immediate' || /^\/[a-z][a-z0-9-]*(\s|$)/i.test(String(text || ''));
}
