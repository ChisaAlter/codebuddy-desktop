/**
 * 跨页面跳转到设置某一段（如 CLI 维护）。
 * 调用方：requestSettingsSection + setRoute('settings')；
 * ReplicaSettingsView 挂载后 consumePendingSettingsSection 并 scrollIntoView。
 */
let pendingSettingsSectionId = null;

export function requestSettingsSection(sectionId = 'settings-section-cli') {
  pendingSettingsSectionId = sectionId || 'settings-section-cli';
  return pendingSettingsSectionId;
}

export function consumePendingSettingsSection() {
  const id = pendingSettingsSectionId;
  pendingSettingsSectionId = null;
  return id;
}

/** 首次安装 CLI 的推荐命令（全局 npm 包） */
export const CODEBUDDY_CLI_BOOTSTRAP_COMMAND = 'npm install -g @tencent-ai/codebuddy-code';
