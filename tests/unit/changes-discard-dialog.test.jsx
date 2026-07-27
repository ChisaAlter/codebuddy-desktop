import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getGitStatus: vi.fn(),
  getCurrentBranch: vi.fn(),
  getBranches: vi.fn(),
  getDiff: vi.fn(),
  discardAll: vi.fn(),
  discardFile: vi.fn(),
  stageFile: vi.fn(),
  unstageFile: vi.fn(),
  stageAll: vi.fn(),
  unstageAll: vi.fn(),
  commit: vi.fn(),
  switchBranch: vi.fn(),
  createBranch: vi.fn(),
  pushBranch: vi.fn(),
  pullBranch: vi.fn(),
  confirmDirtyFileAction: vi.fn(),
  workspacePath: 'C:/Project',
}));

vi.mock('../../src/lib/git', () => ({
  getGitStatus: mocks.getGitStatus,
  getCurrentBranch: mocks.getCurrentBranch,
  getBranches: mocks.getBranches,
  getDiff: mocks.getDiff,
  discardAll: mocks.discardAll,
  discardFile: mocks.discardFile,
  stageFile: mocks.stageFile,
  unstageFile: mocks.unstageFile,
  stageAll: mocks.stageAll,
  unstageAll: mocks.unstageAll,
  commit: mocks.commit,
  switchBranch: mocks.switchBranch,
  createBranch: mocks.createBranch,
  pushBranch: mocks.pushBranch,
  pullBranch: mocks.pullBranch,
}));

vi.mock('../../src/store', () => {
  const state = {
    workspacePath: mocks.workspacePath,
    confirmDirtyFileAction: mocks.confirmDirtyFileAction,
  };
  const useStore = (selector) => (typeof selector === 'function' ? selector(state) : state);
  useStore.getState = () => state;
  return { useStore };
});

import ReplicaChangesView from '../../src/components/ReplicaChangesView';

describe('ReplicaChangesView discard confirm dialogs', () => {
  let container;
  let root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    mocks.workspacePath = 'C:/Project';
    mocks.confirmDirtyFileAction.mockReset().mockResolvedValue(true);
    mocks.getGitStatus.mockReset().mockResolvedValue([
      { path: 'a.js', indexStatus: 'M', worktreeStatus: ' ', originalPath: null },
      { path: 'tmp.log', indexStatus: '?', worktreeStatus: '?', originalPath: null },
    ]);
    mocks.getCurrentBranch.mockReset().mockResolvedValue('main');
    mocks.getBranches.mockReset().mockResolvedValue(['main', 'dev']);
    mocks.getDiff.mockReset().mockResolvedValue('');
    mocks.discardAll.mockReset().mockResolvedValue('');
    mocks.discardFile.mockReset().mockResolvedValue('');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderView() {
    await act(async () => {
      root.render(<ReplicaChangesView />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('opens discard-all dialog and only discards after confirm', async () => {
    await renderView();
    expect(container.textContent).toContain('a.js');

    const discardAllButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Discard All',
    );
    expect(discardAllButton).toBeTruthy();
    await act(async () => {
      discardAllButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('丢弃全部修改？');
    expect(mocks.discardAll).not.toHaveBeenCalled();

    const dialogConfirm = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === '丢弃修改',
    );
    expect(dialogConfirm).toBeTruthy();

    await act(async () => {
      dialogConfirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.discardAll).toHaveBeenCalled();
  });

  it('shows untracked warning and delete label when discarding untracked file', async () => {
    await renderView();
    expect(container.textContent).toContain('tmp.log');

    const fileButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('tmp.log'),
    );
    expect(fileButton).toBeTruthy();
    await act(async () => {
      fileButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const fileDiscard = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Discard',
    );
    expect(fileDiscard).toBeTruthy();
    await act(async () => {
      fileDiscard.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(mocks.discardFile).not.toHaveBeenCalled();
    expect(container.textContent).toContain('丢弃文件修改？');
    expect(container.textContent).toMatch(/未跟踪文件.*磁盘删除|无法撤销/);
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (button) => button.textContent?.trim() === '删除文件',
      ),
    ).toBe(true);
  });

  // H5: Pull must open a confirm dialog and only execute after confirm.
  it('opens Pull dialog and only pulls after confirm', async () => {
    await renderView();

    const pullButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Pull',
    );
    expect(pullButton).toBeTruthy();
    await act(async () => {
      pullButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('拉取远端？');
    expect(mocks.pullBranch).not.toHaveBeenCalled();

    const confirm = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === '拉取',
    );
    expect(confirm).toBeTruthy();
    await act(async () => {
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.pullBranch).toHaveBeenCalledWith('C:/Project');
  });

  // H5: Push must open a confirm dialog (danger-styled) and only execute after confirm.
  it('opens Push dialog and only pushes after confirm; cancel does not push', async () => {
    await renderView();

    const pushButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Push',
    );
    expect(pushButton).toBeTruthy();
    await act(async () => {
      pushButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('推送到远端？');
    expect(container.textContent).toContain('可能覆盖远端历史');
    expect(mocks.pushBranch).not.toHaveBeenCalled();

    const cancel = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === '取消',
    );
    expect(cancel).toBeTruthy();
    await act(async () => {
      cancel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(mocks.pushBranch).not.toHaveBeenCalled();

    // Re-open and confirm to verify push runs.
    await act(async () => {
      pushButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const confirm = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === '推送',
    );
    expect(confirm).toBeTruthy();
    await act(async () => {
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.pushBranch).toHaveBeenCalledWith('C:/Project');
  });
});
