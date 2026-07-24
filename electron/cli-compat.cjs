const MIN_VERSION = '2.125.0';
const RECOMMENDED_VERSION = '2.125.0';

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

function buildCompatStatus(version, { missing = false, unknown = false } = {}) {
  const minVersion = MIN_VERSION;
  const recommendedVersion = RECOMMENDED_VERSION;
  if (missing) {
    return {
      status: 'missing',
      minVersion,
      recommendedVersion,
      message: `未找到 CodeBuddy CLI。请打开「设置 → CodeBuddy CLI 维护」按引导安装，或在终端执行 npm install -g @tencent-ai/codebuddy-code 后点刷新检测。推荐版本 v${recommendedVersion}。`,
    };
  }
  if (unknown || !version) {
    return {
      status: 'unknown',
      minVersion,
      recommendedVersion,
      message: '无法识别 CodeBuddy CLI 版本。请打开「设置 → CodeBuddy CLI 维护」刷新检测，或确认 PATH 中的 codebuddy 可正常输出 --version。',
    };
  }
  if (compareVersions(version, minVersion) < 0) {
    return {
      status: 'outdated',
      minVersion,
      recommendedVersion,
      message: `当前 CodeBuddy CLI v${version} 低于 GUI 最低支持版本 v${minVersion}。请打开「设置 → CodeBuddy CLI 维护」安装推荐版本 v${recommendedVersion} 后再启动项目运行时。`,
    };
  }
  if (compareVersions(version, recommendedVersion) > 0) {
    return {
      status: 'newer',
      minVersion,
      recommendedVersion,
      message: `当前 CodeBuddy CLI v${version} 高于 GUI 验证版本 v${recommendedVersion}，部分功能可能未覆盖验证。`,
    };
  }
  return {
    status: 'ok',
    minVersion,
    recommendedVersion,
    message: `当前 CodeBuddy CLI v${version} 与 GUI 兼容。`,
  };
}

function assertCliCompatibleForRuntime(compat) {
  if (!compat || compat.status === 'ok' || compat.status === 'newer') return;
  const error = new Error(compat.message || 'CodeBuddy CLI 版本不兼容');
  error.code = 'CLI_INCOMPATIBLE';
  error.compat = compat;
  throw error;
}

module.exports = {
  MIN_VERSION,
  RECOMMENDED_VERSION,
  compareVersions,
  buildCompatStatus,
  assertCliCompatibleForRuntime,
};
