function requireCliMaintenanceApi(name) {
  const api = window.electronAPI?.[name];
  if (typeof api !== 'function') throw new Error('CodeBuddy CLI 维护接口不可用');
  return api;
}

export async function getCliMaintenanceInfo() {
  return requireCliMaintenanceApi('getCliMaintenanceInfo')();
}

export async function runCliDoctor() {
  return requireCliMaintenanceApi('runCliDoctor')();
}

export async function updateCodeBuddyCli() {
  return requireCliMaintenanceApi('updateCodeBuddyCli')();
}

export async function installCodeBuddyCli(target) {
  const raw = String(target || '').trim();
  const normalized = raw.toLowerCase() === 'latest' ? 'latest' : raw.replace(/^v/i, '');
  if (normalized !== 'latest' && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(normalized)) {
    throw new Error('请输入 latest 或完整版本号，例如 2.120.0');
  }
  return requireCliMaintenanceApi('installCodeBuddyCli')(normalized);
}

/** 一键安装/修复到 GUI 推荐版本（missing 走 npm，outdated 走 codebuddy install） */
export async function ensureRecommendedCodeBuddyCli() {
  return requireCliMaintenanceApi('ensureRecommendedCodeBuddyCli')();
}
