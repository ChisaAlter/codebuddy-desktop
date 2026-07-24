/** 本会话是否已跳过 CLI 启动检测弹窗（刷新应用后重新检测） */
const SESSION_SKIP_KEY = 'codebuddy-desktop:cliSetupSkippedSession';

/** 首启标记：完成过一次「开始使用」或跳过引导后，CLI 正常时不再打扰 */
const FIRST_LAUNCH_KEY = 'codebuddy-desktop:cliSetupFirstLaunchDone';

function canUseStorage(storage) {
  return typeof window !== 'undefined' && Boolean(window[storage]);
}

export function readSessionCliSetupSkipped() {
  if (!canUseStorage('sessionStorage')) return false;
  try {
    return window.sessionStorage.getItem(SESSION_SKIP_KEY) === 'true';
  } catch {
    return false;
  }
}

export function markSessionCliSetupSkipped() {
  if (!canUseStorage('sessionStorage')) return;
  try {
    window.sessionStorage.setItem(SESSION_SKIP_KEY, 'true');
  } catch {
    // ignore
  }
}

export function isCliSetupFirstLaunchDone() {
  if (!canUseStorage('localStorage')) return false;
  try {
    return window.localStorage.getItem(FIRST_LAUNCH_KEY) === 'true';
  } catch {
    return false;
  }
}

export function markCliSetupFirstLaunchDone() {
  if (!canUseStorage('localStorage')) return;
  try {
    window.localStorage.setItem(FIRST_LAUNCH_KEY, 'true');
  } catch {
    // ignore
  }
}

/** CLI 是否阻止项目运行时（与 cli-compat 一致） */
export function isCliBlockedStatus(status) {
  return status === 'missing' || status === 'outdated' || status === 'unknown';
}
