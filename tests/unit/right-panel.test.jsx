import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  rightPanel: null,
  fileCwd: 'src',
  fileEntries: [
    { name: 'components', path: 'src/components', type: 'directory' },
    { name: 'App.jsx', path: 'src/App.jsx', type: 'file' },
  ],
  fileLoading: false,
  fileLoadError: null,
  openDirectory: vi.fn().mockResolvedValue(true),
  openFile: vi.fn().mockResolvedValue(true),
  setRoute: vi.fn(),
  openRightPanel: vi.fn(),
  closeRightPanel: vi.fn(),
  toggleRightPanel: vi.fn(),
  threadRuntimeById: {},
  activeThreadId: 'thread-1',
  threadsById: {},
  guiSettings: { locale: 'zh' },
  openWorkflowPanel: vi.fn(),
  closeWorkflowPanel: vi.fn(),
  workflowFloatingPanel: null,
}));

vi.mock('../../src/store', () => ({
  useStore(selector) {
    return selector(store);
  },
}));

import RightPanelHost from '../../src/components/RightPanelHost';

describe('RightPanelHost', () => {
  let container;
  let originalElectronAPI;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    store.rightPanel = null;
    store.openDirectory.mockReset();
    store.openFile.mockReset();
    store.setRoute.mockReset();
    store.closeRightPanel.mockReset();
    originalElectronAPI = window.electronAPI;
    window.electronAPI = {
      rightBrowserOpen: vi.fn().mockResolvedValue({ url: 'https://example.com' }),
      rightBrowserSetBounds: vi.fn(),
      rightBrowserClose: vi.fn().mockResolvedValue(true),
    };
  });

  afterEach(() => {
    window.electronAPI = originalElectronAPI;
    container.remove();
  });

  it('is collapsed by default', async () => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(RightPanelHost)));
    expect(container.querySelector('[data-testid="right-panel"]')).toBeNull();
    root.unmount();
  });

  it('renders the file browser and opens files or directories through the store', async () => {
    store.rightPanel = { type: 'files', payload: null };
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(RightPanelHost)));

    expect(container.querySelector('[data-testid="right-panel"]')).toBeTruthy();
    expect(container.textContent).toContain('文件');
    expect(container.textContent).toContain('App.jsx');
    const fileButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent.includes('App.jsx'));
    const directoryButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent.includes('components'));
    await act(async () => fileButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => directoryButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(store.openFile).toHaveBeenCalledWith('src/App.jsx');
    expect(store.openDirectory).toHaveBeenCalledWith('src/components');
    root.unmount();
  });

  it('renders the browser surface and opens a safe payload URL', async () => {
    store.rightPanel = { type: 'browser', payload: { url: 'https://example.com/docs' } };
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(RightPanelHost)));

    expect(container.querySelector('[data-testid="right-browser-surface"]')).toBeTruthy();
    await vi.waitFor(() => expect(window.electronAPI.rightBrowserOpen).toHaveBeenCalledWith('https://example.com/docs'));
    root.unmount();
  });

  it('does not render workflow in the right window host', async () => {
    store.rightPanel = { type: 'workflow', payload: { threadId: 'thread-1' } };
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(RightPanelHost)));
    expect(container.querySelector('[data-testid="right-panel"]')).toBeNull();
    root.unmount();
  });

  it('returns to surface chooser on Escape from files, and closes from chooser via close button', async () => {
    store.rightPanel = { type: 'files', payload: null };
    store.openRightPanel = vi.fn((type, payload = null) => {
      store.rightPanel = { type, payload };
      return true;
    });
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(RightPanelHost)));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(store.openRightPanel).toHaveBeenCalledWith('surfaces');

    store.rightPanel = { type: 'surfaces', payload: null };
    await act(async () => root.render(React.createElement(RightPanelHost)));
    await act(async () => {
      container.querySelector('button[aria-label="关闭右侧面板"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(store.closeRightPanel).toHaveBeenCalled();
    root.unmount();
  });
});
