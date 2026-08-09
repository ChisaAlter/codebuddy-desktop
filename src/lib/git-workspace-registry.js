// M1 安全面：渲染进程 → 主进程注册允许的 Git 工作目录
// 集合（workspacePath + workspaceExtraDirs + 已注册项目路径）；
// 集合无变化时不重复上报，避免流式期间高频 IPC。
// 契约：docs/workflow/specs/2026-08-06-workflow-panel-payload-contract.md §2

/**
 * 创建 Git 工作目录注册器。
 * @param {object} options
 * @param {() => object} options.getState 读取 store 状态（含 workspacePath/workspaceExtraDirs/projectsById）
 * @param {(payload: { dirs: string[] }) => void} options.register 上报回调（已含 IPC 调用的错误吞掉）
 * @returns {() => boolean} notify：返回是否发生了上报（集合变化）
 */
export function createGitWorkspaceRegistrar({ getState, register }) {
  // 哨兵用 null：空集合的签名是 ''，若初始值也是 '' 会吞掉首次空集合上报
  let lastSignature = null;

  const collectDirs = (state) => {
    const dirs = new Set();
    const push = (value) => {
      if (typeof value === 'string' && value.trim()) dirs.add(value.trim());
    };
    push(state?.workspacePath);
    for (const dir of Array.isArray(state?.workspaceExtraDirs) ? state.workspaceExtraDirs : []) push(dir);
    for (const project of Object.values(state?.projectsById || {})) {
      if (project && typeof project.workspacePath === 'string') push(project.workspacePath);
    }
    return [...dirs];
  };

  return function notify() {
    const dirs = collectDirs(getState());
    const signature = dirs.join('\u0000');
    if (signature === lastSignature) return false;
    lastSignature = signature;
    register({ dirs });
    return true;
  };
}
