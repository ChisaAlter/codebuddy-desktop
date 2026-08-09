import { describe, it, expect, vi } from 'vitest';
import {
  COMMIT_PHASES,
  PHASE_LABELS,
  RESULT,
  executeCommitTransaction,
  retryPushAfterCommitted,
} from '../../src/lib/git-commit-flow';

function happySteps({ pushError = null } = {}) {
  const add = vi.fn().mockResolvedValue(undefined);
  const commit = vi.fn().mockResolvedValue(undefined);
  const push = pushError ? vi.fn().mockRejectedValue(pushError) : vi.fn().mockResolvedValue(undefined);
  return { add, commit, push };
}

describe('executeCommitTransaction - 提交事务状态机（M1）', () => {
  it('成功路径：添加→提交→推送，阶段回调序列正确', async () => {
    const { add, commit, push } = happySteps();
    const phases = [];
    const result = await executeCommitTransaction({
      snapshotCwd: '/proj',
      message: 'msg',
      getCurrentCwd: () => '/proj',
      onPhase: (p) => phases.push(p),
      runAdd: add,
      runCommit: commit,
      runPush: push,
    });
    expect(result.status).toBe(RESULT.SUCCESS);
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    expect(phases).toEqual([COMMIT_PHASES.ADDING, COMMIT_PHASES.COMMITTING, COMMIT_PHASES.PUSHING]);
    expect(add).toHaveBeenCalledWith('/proj');
    expect(commit).toHaveBeenCalledWith('/proj', 'msg');
    expect(push).toHaveBeenCalledWith('/proj');
  });

  it('add 失败：立即失败，不执行 commit/push', async () => {
    const add = vi.fn().mockRejectedValue(new Error('add boom'));
    const { commit, push } = happySteps();
    const result = await executeCommitTransaction({
      snapshotCwd: '/proj',
      message: 'msg',
      getCurrentCwd: () => '/proj',
      runAdd: add,
      runCommit: commit,
      runPush: push,
    });
    expect(result.status).toBe(RESULT.FAILED);
    expect(result.error.message).toBe('add boom');
    expect(commit).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('commit 失败：已 add 未 commit，不执行 push', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const commit = vi.fn().mockRejectedValue(new Error('commit boom'));
    const push = vi.fn().mockResolvedValue(undefined);
    const result = await executeCommitTransaction({
      snapshotCwd: '/proj',
      message: 'msg',
      getCurrentCwd: () => '/proj',
      runAdd: add,
      runCommit: commit,
      runPush: push,
    });
    expect(result.status).toBe(RESULT.FAILED);
    expect(result.committed).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });

  it('push 失败：部分失败中间态（已提交，推送失败）', async () => {
    const { add, commit, push } = happySteps({ pushError: new Error('connection timed out') });
    const result = await executeCommitTransaction({
      snapshotCwd: '/proj',
      message: 'msg',
      getCurrentCwd: () => '/proj',
      runAdd: add,
      runCommit: commit,
      runPush: push,
    });
    expect(result.status).toBe(RESULT.COMMITTED_PUSH_FAILED);
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.error.message).toBe('connection timed out');
  });

  it('切项目（cwd 快照 ≠ 当前）：add 后立即中止，不 commit', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const commit = vi.fn().mockResolvedValue(undefined);
    const push = vi.fn().mockResolvedValue(undefined);
    let current = '/proj';
    const result = await executeCommitTransaction({
      snapshotCwd: '/proj',
      message: 'msg',
      getCurrentCwd: () => current,
      runAdd: add,
      runCommit: commit,
      runPush: push,
    });
    // 这里当前目录始终一致 → 应成功；随后模拟中途切换
    expect(result.status).toBe(RESULT.SUCCESS);
    commit.mockClear();
    push.mockClear();

    current = '/other-proj';
    const result2 = await executeCommitTransaction({
      snapshotCwd: '/proj',
      message: 'msg',
      getCurrentCwd: () => current,
      runAdd: vi.fn().mockResolvedValue(undefined),
      runCommit: commit,
      runPush: push,
    });
    expect(result2.status).toBe(RESULT.PROJECT_SWITCHED);
    expect(commit).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('commit 后切项目：返回 PROJECT_SWITCHED 且 committed=true', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const commit = vi.fn().mockResolvedValue(undefined);
    const push = vi.fn().mockResolvedValue(undefined);
    let phase = 'pre-commit';
    const result = await executeCommitTransaction({
      snapshotCwd: '/proj',
      message: 'msg',
      getCurrentCwd: () => (phase === 'post-commit' ? '/other' : '/proj'),
      onPhase: (p) => {
        if (p === COMMIT_PHASES.COMMITTING) phase = 'post-commit';
      },
      runAdd: add,
      runCommit: commit,
      runPush: push,
    });
    expect(result.status).toBe(RESULT.PROJECT_SWITCHED);
    expect(result.committed).toBe(true);
    expect(push).not.toHaveBeenCalled();
  });

  it('卸载守卫（aborted）：add 后中止返回 ABORTED，不再执行后续步骤', async () => {
    const signal = { aborted: false };
    const add = vi.fn().mockImplementation(async () => {
      signal.aborted = true; // 模拟组件卸载
    });
    const commit = vi.fn().mockResolvedValue(undefined);
    const push = vi.fn().mockResolvedValue(undefined);
    const result = await executeCommitTransaction({
      snapshotCwd: '/proj',
      message: 'msg',
      getCurrentCwd: () => '/proj',
      runAdd: add,
      runCommit: commit,
      runPush: push,
      signal,
    });
    expect(result.status).toBe(RESULT.ABORTED);
    expect(commit).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('compareCwd：大小写不敏感比较器生效（Windows 路径）', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const commit = vi.fn().mockResolvedValue(undefined);
    const push = vi.fn().mockResolvedValue(undefined);
    const result = await executeCommitTransaction({
      snapshotCwd: 'C:/Work/Proj',
      message: 'msg',
      getCurrentCwd: () => 'c:/work/proj', // 仅大小写不同
      compareCwd: (a, b) => a.toLowerCase() === b.toLowerCase(),
      runAdd: add,
      runCommit: commit,
      runPush: push,
    });
    expect(result.status).toBe(RESULT.SUCCESS);
  });
});

describe('retryPushAfterCommitted - 部分失败重试（只 push，不重复 add/commit）', () => {
  it('重试成功：只调用 push', async () => {
    const push = vi.fn().mockResolvedValue(undefined);
    const result = await retryPushAfterCommitted({
      snapshotCwd: '/proj',
      getCurrentCwd: () => '/proj',
      runPush: push,
    });
    expect(result.status).toBe(RESULT.SUCCESS);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith('/proj');
  });

  it('重试仍失败：保持 COMMITTED_PUSH_FAILED', async () => {
    const push = vi.fn().mockRejectedValue(new Error('still down'));
    const result = await retryPushAfterCommitted({
      snapshotCwd: '/proj',
      getCurrentCwd: () => '/proj',
      runPush: push,
    });
    expect(result.status).toBe(RESULT.COMMITTED_PUSH_FAILED);
    expect(result.committed).toBe(true);
  });

  it('切项目后重试：拒绝', async () => {
    const push = vi.fn().mockResolvedValue(undefined);
    const result = await retryPushAfterCommitted({
      snapshotCwd: '/proj',
      getCurrentCwd: () => '/other',
      runPush: push,
    });
    expect(result.status).toBe(RESULT.PROJECT_SWITCHED);
    expect(push).not.toHaveBeenCalled();
  });

  it('abort 信号在 push 失败时生效', async () => {
    const signal = { aborted: true };
    const push = vi.fn().mockRejectedValue(new Error('x'));
    const result = await retryPushAfterCommitted({
      snapshotCwd: '/proj',
      getCurrentCwd: () => '/proj',
      runPush: push,
      signal,
    });
    expect(result.status).toBe(RESULT.ABORTED);
  });
});

describe('PHASE_LABELS - 分步 i18n 键（与原型冻结版语义一致）', () => {
  it('三个阶段按钮/提示键', () => {
    expect(PHASE_LABELS[COMMIT_PHASES.ADDING]).toEqual({ button: 'workflow.git.adding', hint: 'workflow.git.addingHint' });
    expect(PHASE_LABELS[COMMIT_PHASES.COMMITTING]).toEqual({ button: 'workflow.git.committing', hint: 'workflow.git.committingHint' });
    expect(PHASE_LABELS[COMMIT_PHASES.PUSHING]).toEqual({ button: 'workflow.git.pushing', hint: 'workflow.git.pushingHint' });
  });
});
