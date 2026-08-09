import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../src/store';

const mocks = vi.hoisted(() => ({
  fetchJson: vi.fn(),
  createWechatChannel: vi.fn(),
  fetchWechatQr: vi.fn(),
}));

vi.mock('../../src/lib/acp', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchJson: mocks.fetchJson };
});
vi.mock('../../src/lib/ops', () => ({
  createWechatChannel: mocks.createWechatChannel,
  fetchWechatQr: mocks.fetchWechatQr,
  createWecomChannel: vi.fn(),
  channelAction: vi.fn(),
  deleteChannelInstance: vi.fn(),
}));

import ReplicaRemoteControlView from '../../src/components/ReplicaRemoteControlView';

// Regression: the component comment says the QR login poll "deliberately keeps
// running" across view switches, but the active-driven effect used to clear the
// poll timer and reset the instance state on every hide — silently aborting an
// in-progress scan with no resume. The poll must survive active flips and only
// stop on unmount.
describe('ReplicaRemoteControlView QR poll keep-alive', () => {
  let container;
  let root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    mocks.fetchJson.mockReset().mockResolvedValue({ clients: [] });
    mocks.createWechatChannel.mockReset().mockResolvedValue({ instanceId: 'wx-1' });
    mocks.fetchWechatQr.mockReset().mockResolvedValue({ ok: true, qrImage: 'data:image/png;base64,AA==' });
    useStore.setState({ route: 'remote-control', activeProjectId: 'project-1' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });

  it('keeps the QR poll running while the view is hidden and stops it on unmount', async () => {
    await act(async () => {
      root.render(React.createElement(ReplicaRemoteControlView));
      await Promise.resolve();
    });

    // Start the WeChat QR login flow.
    await act(async () => {
      const createBtn = [...container.querySelectorAll('button')].find((b) =>
        b.textContent.includes('创建并显示二维码'),
      );
      expect(createBtn).toBeTruthy();
      createBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1100));
    });
    expect(mocks.fetchWechatQr).toHaveBeenCalledTimes(1);

    // Switch away (active=false): the poll must keep running.
    await act(async () => {
      useStore.setState((s) => ({ ...s, route: 'terminal' }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1300));
    });
    expect(mocks.fetchWechatQr.mock.calls.length).toBeGreaterThan(1);

    // Unmount: the poll must stop.
    const callsBeforeUnmount = mocks.fetchWechatQr.mock.calls.length;
    await act(async () => root.unmount());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1300));
    });
    expect(mocks.fetchWechatQr.mock.calls.length).toBe(callsBeforeUnmount);
  });
});
