import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SurfacePicker from '../../src/components/SurfacePicker';
import { translate } from '../../src/lib/i18n';

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
  openRightPanel: vi.fn((type, payload = null) => {
    store.rightPanel = { type, payload };
    return true;
  }),
  closeRightPanel: vi.fn(() => {
    store.rightPanel = null;
    return true;
  }),
  toggleRightPanel: vi.fn(),
  guiSettings: { locale: 'zh' },
  threadRuntimeById: {},
  activeThreadId: 'thread-1',
  threadsById: {},
  openWorkflowPanel: vi.fn(),
  closeWorkflowPanel: vi.fn(),
  workflowFloatingPanel: null,
}));

vi.mock('../../src/store', () => ({
  useStore(selector) {
    return selector(store);
  },
}));

vi.mock('../../src/components/ReplicaTerminalView', () => ({
  default: function MockTerminal() {
    return React.createElement('div', { 'data-testid': 'mock-terminal-view' }, 'terminal');
  },
}));

vi.mock('../../src/components/ReplicaChangesView', () => ({
  default: function MockChanges() {
    return React.createElement('div', { 'data-testid': 'mock-changes-view' }, 'diff');
  },
}));

import RightPanelHost from '../../src/components/RightPanelHost';

describe('SurfacePicker (right panel chooser)', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('renders four surface cards', async () => {
    const onSelect = vi.fn();
    const t = (key) => translate('en', key);
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(SurfacePicker, { onSelect, t }));
    });
    expect(container.querySelector('[data-testid="surface-picker"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="surface-card-browser"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="surface-card-terminal"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="surface-card-files"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="surface-card-diff"]')).toBeTruthy();
    expect(container.textContent).toContain('Open a surface');
    await act(async () => {
      container
        .querySelector('[data-testid="surface-card-files"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith('files');
    root.unmount();
  });
});

describe('RightPanelHost surfaces', () => {
  let container;
  let originalElectronAPI;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    store.rightPanel = null;
    store.openRightPanel.mockClear();
    store.closeRightPanel.mockClear();
    store.openDirectory.mockReset();
    store.openFile.mockReset();
    store.setRoute.mockReset();
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

  it('shows surface chooser in the right panel', async () => {
    store.rightPanel = { type: 'surfaces', payload: null };
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(RightPanelHost)));
    expect(container.querySelector('[data-testid="right-panel"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="surface-picker"]')).toBeTruthy();
    expect(container.getAttribute('data-panel-type') || container.querySelector('[data-panel-type]')?.getAttribute('data-panel-type')).toBeTruthy();
    expect(container.querySelector('[data-panel-type="surfaces"]')).toBeTruthy();
    root.unmount();
  });

  it('opens files from the chooser inside the right panel', async () => {
    store.rightPanel = { type: 'surfaces', payload: null };
    store.openRightPanel.mockImplementation((type, payload = null) => {
      store.rightPanel = { type, payload };
      return true;
    });
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(RightPanelHost)));
    await act(async () => {
      container
        .querySelector('[data-testid="surface-card-files"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(store.openRightPanel).toHaveBeenCalledWith('files');
    // Re-render with files panel
    store.rightPanel = { type: 'files', payload: null };
    await act(async () => root.render(React.createElement(RightPanelHost)));
    expect(container.textContent).toContain('文件');
    expect(container.textContent).toContain('App.jsx');
    root.unmount();
  });

  it('embeds terminal and diff in the right panel', async () => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container);

    store.rightPanel = { type: 'terminal', payload: null };
    await act(async () => root.render(React.createElement(RightPanelHost)));
    await vi.waitFor(() => expect(container.querySelector('[data-testid="mock-terminal-view"]')).toBeTruthy());
    expect(container.querySelector('[data-panel-type="terminal"]')).toBeTruthy();

    store.rightPanel = { type: 'diff', payload: null };
    await act(async () => root.render(React.createElement(RightPanelHost)));
    await vi.waitFor(() => expect(container.querySelector('[data-testid="mock-changes-view"]')).toBeTruthy());
    expect(container.querySelector('[data-panel-type="diff"]')).toBeTruthy();

    root.unmount();
  });

  it('Escape from a surface returns to chooser; Escape on chooser closes', async () => {
    store.rightPanel = { type: 'files', payload: null };
    store.openRightPanel.mockImplementation((type, payload = null) => {
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
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(store.closeRightPanel).toHaveBeenCalled();
    root.unmount();
  });
});

describe('topbar i18n', () => {
  it('resolves English surface title', () => {
    expect(translate('en', 'topbar.surfacesTitle')).toBe('Open a surface');
    expect(translate('en', 'topbar.surface.browser')).toBe('Browser');
    expect(translate('zh', 'topbar.surfacesTitle')).toBe('打开工作面');
  });
});
