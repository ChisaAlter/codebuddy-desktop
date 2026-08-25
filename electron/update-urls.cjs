// GUI 自更新地址白名单（从 main.cjs 抽出以便无 Electron 环境下单测）。
// 仓库已从 ChisaAlter/codebuddy-gui 更名为 ChisaAlter/codebuddy-desktop：
// - 规范地址一律指向 codebuddy-desktop；
// - 旧 slug 仍保留在白名单中（GitHub 对旧仓库名保留 301 重定向，历史
//   release 资产的 browser_download_url 也可能仍带旧路径）。
const GUI_REPO_OWNER = 'ChisaAlter';
const GUI_REPO_NAME = 'codebuddy-desktop';
const GUI_LEGACY_REPO_NAMES = Object.freeze(['codebuddy-gui']);
const GUI_REPO_SLUGS = Object.freeze([
  `${GUI_REPO_OWNER}/${GUI_REPO_NAME}`,
  ...GUI_LEGACY_REPO_NAMES.map((name) => `${GUI_REPO_OWNER}/${name}`),
]);

const GUI_RELEASES_URL = `https://github.com/${GUI_REPO_OWNER}/${GUI_REPO_NAME}/releases`;
const GUI_LATEST_RELEASE_API = `https://api.github.com/repos/${GUI_REPO_OWNER}/${GUI_REPO_NAME}/releases/latest`;

function compareVersions(left, right) {
  const parts = (value) =>
    String(value || '')
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((item) => Number.parseInt(item, 10) || 0);
  const leftParts = parts(left);
  const rightParts = parts(right);
  const length = Math.max(leftParts.length, rightParts.length, 3);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function trustedGuiReleaseUrl(value) {
  try {
    const parsed = new URL(String(value || GUI_RELEASES_URL));
    if (
      parsed.origin === 'https://github.com' &&
      GUI_REPO_SLUGS.some((slug) => parsed.pathname.startsWith(`/${slug}/releases`))
    )
      return parsed.toString();
  } catch (_) {}
  return GUI_RELEASES_URL;
}

function trustedGuiDownloadUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    const repoNames = [GUI_REPO_NAME, ...GUI_LEGACY_REPO_NAMES].join('|');
    const pattern = new RegExp(
      `^/${GUI_REPO_OWNER}/(?:${repoNames})/releases/download/v(\\d+(?:\\.\\d+){1,3})/CodeBuddy-GUI-Setup-(\\d+(?:\\.\\d+){1,3})\\.exe$`,
      'i',
    );
    const match = decodeURIComponent(parsed.pathname).match(pattern);
    // 注意 match 必须显式判真：match 为 null 时 match?.[1] === match?.[2]
    // 是 undefined === undefined（true），会放行任意 github.com 路径。
    if (
      match &&
      parsed.origin === 'https://github.com' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      match[1] === match[2]
    ) {
      return parsed.toString();
    }
  } catch (_) {}
  return null;
}

module.exports = {
  GUI_REPO_SLUGS,
  GUI_RELEASES_URL,
  GUI_LATEST_RELEASE_API,
  compareVersions,
  trustedGuiReleaseUrl,
  trustedGuiDownloadUrl,
};
