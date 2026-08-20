import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  newSession: vi.fn().mockResolvedValue(true),
  chooseWorkspace: vi.fn().mockResolvedValue(true),
  setRoute: vi.fn(),
  state: null,
}));

vi.mock('../../src/store', () => {
  const useStore = (selector) => {
    if (typeof selector === 'function') return selector(mocks.state);
    return mocks.state;
  };
  useStore.getState = () => mocks.state;
  return { useStore };
});

// Sidebar pulls many icons/components; keep ProjectSessionTree light.
vi.mock('../../src/components/ProjectSessionTree', () => ({
  __esModule: true,
  default: () => <div data-testid="project-session-tree" />,
}));

import ReplicaSidebar from '../../src/components/ReplicaSidebar';

function baseState(overrides = {}) {
  return {
    route: 'chat',
    sidebarCollapsed: false,
    setRoute: mocks.setRoute,
    setSidebarCollapsed: vi.fn(),
    projectsById: {
      'project-1': {
        id: 'project-1',
        name: 'Demo',
        workspacePath: 'C:/Project',
        preferences: { sidebarExpanded: true },
      },
    },
    projectOrder: ['project-1'],
    threadsById: {
      'thread-1': {
        id: 'thread-1',
        projectId: 'project-1',
        title: 'Current',
        status: 'idle',
        archivedAt: null,
      },
    },
    threadOrderByProject: { 'project-1': ['thread-1'] },
    activeProjectId: 'project-1',
    activeThreadId: 'thread-1',
    connectionState: 'connected',
    projectNavigationBusy: false,
    projectNavigationTargetId: null,
    newSessionBusy: false,
    newSession: mocks.newSession,
    chooseWorkspace: mocks.chooseWorkspace,
    activateThread: vi.fn(),
    activateProject: vi.fn(),
    renameThread: vi.fn(),
    deleteThread: vi.fn(),
    pinThread: vi.fn(),
    archiveThread: vi.fn(),
    setProjectSidebarExpanded: vi.fn(),
    openProjectMenu: vi.fn(),
    ...overrides,
  };
}

describe('ReplicaSidebar new chat button', () => {
  let container;
  let root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    mocks.newSession.mockReset().mockResolvedValue(true);
    mocks.chooseWorkspace.mockReset().mockResolvedValue(true);
    mocks.setRoute.mockReset();
    mocks.state = baseState();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });

  it('opens the workspace picker even when a project is active', async () => {
    await act(async () => {
      root.render(<ReplicaSidebar />);
    });
    const button = container.querySelector('button[aria-label="新对话"]');
    expect(button).toBeTruthy();
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(mocks.setRoute).toHaveBeenCalledWith('chat');
    expect(mocks.chooseWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.newSession).not.toHaveBeenCalled();
  });

  it('opens workspace picker when no project is active', async () => {
    mocks.state = baseState({
      activeProjectId: null,
      projectsById: {},
      projectOrder: [],
      threadsById: {},
      threadOrderByProject: {},
      activeThreadId: null,
    });
    await act(async () => {
      root.render(<ReplicaSidebar />);
    });
    const button = container.querySelector('button[aria-label="新对话"]');
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(mocks.chooseWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.newSession).not.toHaveBeenCalled();
  });

  it('does nothing when the workspace picker is cancelled', async () => {
    mocks.chooseWorkspace.mockResolvedValueOnce(null);
    await act(async () => {
      root.render(<ReplicaSidebar />);
    });
    const button = container.querySelector('button[aria-label="新对话"]');
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(mocks.chooseWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.newSession).not.toHaveBeenCalled();
  });

  it('does not fire when busy', async () => {
    mocks.state = baseState({ newSessionBusy: true });
    await act(async () => {
      root.render(<ReplicaSidebar />);
    });
    const button = container.querySelector('button[aria-label="新对话"]');
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(mocks.chooseWorkspace).not.toHaveBeenCalled();
    expect(mocks.newSession).not.toHaveBeenCalled();
  });
});
