// CLI `env` 设置键上的布尔开关（如 2.138 REPL 模式 CODEBUDDY_REPL_ENABLED）。
// env 是 settings 的 JSON 对象；这里只做纯变换，写入仍走 updateSetting('env', …)。

export const REPL_ENV_KEY = 'CODEBUDDY_REPL_ENABLED';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function envFlagEnabled(env, key) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return false;
  const value = env[key];
  if (value === true) return true;
  return TRUTHY.has(String(value ?? '').trim().toLowerCase());
}

/** Returns a new env object with the flag set to '1' or removed entirely. */
export function setEnvFlag(env, key, enabled) {
  const base = env && typeof env === 'object' && !Array.isArray(env) ? { ...env } : {};
  if (enabled) {
    base[key] = '1';
    return base;
  }
  delete base[key];
  return base;
}
