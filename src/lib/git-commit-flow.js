// M1 提交事务状态机（纯逻辑，可单测）：
// 分步（添加中→提交中→推送中）+ 部分失败（已提交，推送失败）+ cwd 快照归属校验 + 卸载守卫
// 契约：docs/workflow/specs/2026-08-06-workflow-panel-payload-contract.md §6；原型 B 组冻结版

export const COMMIT_PHASES = {
  IDLE: 'idle',
  ADDING: 'adding',
  COMMITTING: 'committing',
  PUSHING: 'pushing',
  COMMITTED_PUSH_FAILED: 'committedPushFailed',
};

// 分步文案（M4/M5：i18n 键，组件 t() 渲染；与原型冻结版语义一致）
export const PHASE_LABELS = {
  [COMMIT_PHASES.ADDING]: { button: 'workflow.git.adding', hint: 'workflow.git.addingHint' },
  [COMMIT_PHASES.COMMITTING]: { button: 'workflow.git.committing', hint: 'workflow.git.committingHint' },
  [COMMIT_PHASES.PUSHING]: { button: 'workflow.git.pushing', hint: 'workflow.git.pushingHint' },
};

export const RESULT = {
  SUCCESS: 'success',
  PROJECT_SWITCHED: 'project_switched',
  ABORTED: 'aborted',
  COMMITTED_PUSH_FAILED: 'committed_push_failed',
  FAILED: 'failed',
};

/**
 * 执行提交事务。
 * @param {object} options
 * @param {string} options.snapshotCwd 事务开始时的 cwd 快照（绑定）
 * @param {string} options.message 提交信息（已 trim 且非空）
 * @param {() => string|null} options.getCurrentCwd 读取当前 workspacePath（切项目即拒）
 * @param {(phase: string) => void} options.onPhase 阶段回调（UI 绑定）
 * @param {(cwd: string) => Promise<void>} options.runAdd
 * @param {(cwd: string, message: string) => Promise<void>} options.runCommit
 * @param {(cwd: string) => Promise<void>} options.runPush
 * @param {{ aborted: boolean }} options.signal 卸载守卫（组件卸载时置 true）
 * @returns {Promise<{ status: string, error?: Error, committed?: boolean, pushed?: boolean }>}
 */
export async function executeCommitTransaction({
  snapshotCwd,
  message,
  getCurrentCwd,
  onPhase = () => {},
  runAdd,
  runCommit,
  runPush,
  signal = { aborted: false },
  compareCwd = (a, b) => a === b,
}) {
  const guard = () => signal.aborted;
  const stillSameProject = () => {
    if (guard()) return false;
    const current = getCurrentCwd ? getCurrentCwd() : snapshotCwd;
    if (current && snapshotCwd && !compareCwd(current, snapshotCwd)) return false;
    return true;
  };

  // 1) 添加
  onPhase(COMMIT_PHASES.ADDING);
  try {
    await runAdd(snapshotCwd);
  } catch (error) {
    return { status: RESULT.FAILED, error, committed: false, pushed: false };
  }
  if (guard()) return { status: RESULT.ABORTED, committed: false, pushed: false };
  if (!stillSameProject()) return { status: RESULT.PROJECT_SWITCHED, committed: false, pushed: false };

  // 2) 提交
  onPhase(COMMIT_PHASES.COMMITTING);
  try {
    await runCommit(snapshotCwd, message);
  } catch (error) {
    return { status: RESULT.FAILED, error, committed: false, pushed: false };
  }
  if (guard()) return { status: RESULT.ABORTED, committed: true, pushed: false };
  if (!stillSameProject()) return { status: RESULT.PROJECT_SWITCHED, committed: true, pushed: false };

  // 3) 推送（失败 = 部分失败中间态：已提交，推送失败；重试只 push）
  onPhase(COMMIT_PHASES.PUSHING);
  try {
    await runPush(snapshotCwd);
  } catch (error) {
    return { status: RESULT.COMMITTED_PUSH_FAILED, error, committed: true, pushed: false };
  }
  return { status: RESULT.SUCCESS, committed: true, pushed: true };
}

/**
 * 部分失败后的重试推送：只执行 push，不重复 add/commit。
 * @param {object} options
 * @param {string} options.snapshotCwd
 * @param {() => string|null} options.getCurrentCwd
 * @param {(phase: string) => void} options.onPhase
 * @param {(cwd: string) => Promise<void>} options.runPush
 * @param {{ aborted: boolean }} options.signal
 */
export async function retryPushAfterCommitted({
  snapshotCwd,
  getCurrentCwd,
  onPhase = () => {},
  runPush,
  signal = { aborted: false },
  compareCwd = (a, b) => a === b,
}) {
  const current = getCurrentCwd ? getCurrentCwd() : snapshotCwd;
  if (current && snapshotCwd && !compareCwd(current, snapshotCwd)) {
    return { status: RESULT.PROJECT_SWITCHED, committed: true, pushed: false };
  }
  onPhase(COMMIT_PHASES.PUSHING);
  try {
    await runPush(snapshotCwd);
  } catch (error) {
    if (signal.aborted) return { status: RESULT.ABORTED, committed: true, pushed: false };
    return { status: RESULT.COMMITTED_PUSH_FAILED, error, committed: true, pushed: false };
  }
  return { status: RESULT.SUCCESS, committed: true, pushed: true };
}
