import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import { resolveThreadTimeline } from '../../src/store/helpers/thread-runtime.js';

const mocks = {
  timeline: [],
  connectionState: 'connected',
  isAwaitingResponse: false,
  promptQueue: [],
  availableCommands: [],
  historyReplayActive: false,
  agentPhase: null,
  progress: null,
  teamState: null,
  promptSuggestion: null,
  usage: null,
  sessionTitle: '/init',
  currentModel: 'x',
  currentMode: 'fullAccess',
  codeBuddyAccountAuthState: 'authenticated',
  guiSettings: {},
  activeProjectId: 'p1',
  activeThreadId: 't1',
  projectsById: { p1: { id: 'p1', workspacePath: 'C:/tmp', runtimeStatus: 'ready' } },
  threadsById: {
    t1: { id: 't1', projectId: 'p1', title: '/init', status: 'idle', timeline: [] },
  },
};

vi.mock('../../src/store', () => ({
  useStore: (selector) =>
    selector({
      ...mocks,
      timeline: mocks.timeline,
      threadsById: mocks.threadsById,
      sendPrompt: vi.fn(),
      cancelSession: vi.fn(),
      setThreadDraft: vi.fn(),
      moveQueuedPrompt: vi.fn(),
      clearPromptSuggestion: vi.fn(),
      chooseAttachments: vi.fn(),
      addDroppedAttachments: vi.fn(),
      removePendingAttachment: vi.fn(),
      restartProjectRuntime: vi.fn(),
      bootstrap: vi.fn(),
      authenticateCodeBuddyAccount: vi.fn(),
      cancelCodeBuddyAccountAuth: vi.fn(),
      setChatError: vi.fn(),
      error: null,
      promptStartedAt: null,
      activePromptRunId: null,
      pendingAttachments: [],
      thoughtLevel: null,
      thoughtLevelOptions: [],
      models: [],
      modes: [],
      settings: {},
      showTokensCounter: false,
      sessionToken: null,
      fileCwd: '.',
      workspacePath: 'C:/tmp',
    }),
}));

import ReplicaChatView from '../../src/components/ReplicaChatView';

function loadActiveProductTimeline() {
  const productPath = process.env.APPDATA
    ? `${process.env.APPDATA}/codebuddy-gui/product-state.json`
    : null;
  if (!productPath || !fs.existsSync(productPath)) return null;
  const s = JSON.parse(fs.readFileSync(productPath, 'utf8'));
  const thread = s.threadsById?.[s.activeThreadId];
  if (!thread || !Array.isArray(thread.timeline)) return null;
  return { threadId: s.activeThreadId, timeline: thread.timeline, title: thread.title };
}

describe('user messages visible', () => {
  let container;
  let root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.timeline = [];
    mocks.threadsById = {
      t1: { id: 't1', projectId: 'p1', title: '/init', status: 'idle', timeline: [] },
    };
    mocks.activeThreadId = 't1';
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders user bubbles from product-state timeline', async () => {
    const product = loadActiveProductTimeline();
    if (!product) {
      mocks.timeline = [
        { id: 'u1', type: 'message', role: 'user', content: '一打开就自动再进 CodeBuddy能实现吗', createdAt: 1 },
        { id: 'a1', type: 'message', role: 'assistant', content: '能实现', createdAt: 2, streaming: false },
      ];
      mocks.threadsById.t1.timeline = mocks.timeline;
    } else {
      mocks.timeline = product.timeline;
      mocks.threadsById = {
        t1: {
          id: 't1',
          projectId: 'p1',
          title: product.title || '/init',
          status: 'idle',
          timeline: product.timeline,
        },
      };
    }

    const expectedUsers = mocks.timeline.filter((i) => {
      if (!(i.type === 'message' && i.role === 'user')) return false;
      const text = String(i.content || '').trim();
      // UI hides pure /effort system prompts injected by the effort picker.
      return !/^\/effort(?:\s+\S+)?$/i.test(text);
    });
    expect(expectedUsers.length).toBeGreaterThan(0);

    await act(async () => {
      root.render(React.createElement(ReplicaChatView));
    });

    const users = container.querySelectorAll('[data-chat-role="user"]');
    expect(users.length).toBe(expectedUsers.length);
    expect(container.textContent).toContain(expectedUsers[0].content);
    expect(container.querySelector('[data-testid="chat-user-message"]')).toBeTruthy();
  });

  it('still shows disk user bubbles when live timeline is assistant/tools only', async () => {
    const product = loadActiveProductTimeline();
    const disk = product?.timeline || [
      { id: 'u1', type: 'message', role: 'user', content: '磁盘上的用户消息应显示', createdAt: 1 },
      { id: 'a1', type: 'message', role: 'assistant', content: '旧回复', createdAt: 2, streaming: false },
      { id: 't1', type: 'thinking', role: 'assistant', content: 'thinking…', createdAt: 3, streaming: true },
      { id: 'c1', type: 'tool_call', role: 'assistant', toolCallId: 'x', status: 'running', createdAt: 4 },
    ];
    const degradedLive = disk.filter((item) => !(item.type === 'message' && item.role === 'user'));
    expect(degradedLive.some((item) => item.role === 'user')).toBe(false);

    mocks.timeline = degradedLive;
    mocks.threadsById = {
      t1: { id: 't1', projectId: 'p1', title: '/init', status: 'idle', timeline: disk },
    };

    const expected = resolveThreadTimeline(degradedLive, disk).filter((item) => {
      if (!(item.type === 'message' && item.role === 'user')) return false;
      const text = String(item.content || '').trim();
      return !/^\/effort(?:\s+\S+)?$/i.test(text);
    });
    expect(expected.length).toBeGreaterThan(0);

    await act(async () => {
      root.render(React.createElement(ReplicaChatView));
    });

    const users = container.querySelectorAll('[data-chat-role="user"]');
    expect(users.length).toBe(expected.length);
    expect(container.textContent).toContain(expected[0].content);
  });

  it('shows user bubbles when root timeline is still empty after hydrate', async () => {
    // Mirrors the pre-fix bug: threadRuntime/disk has history, root timeline is [].
    const disk = [
      { id: 'u1', type: 'message', role: 'user', content: 'hydrate后应立刻可见的用户消息', createdAt: 1 },
      { id: 'a1', type: 'message', role: 'assistant', content: '助手', createdAt: 2, streaming: false },
    ];
    mocks.timeline = [];
    mocks.threadsById = {
      t1: { id: 't1', projectId: 'p1', title: '/init', status: 'idle', timeline: disk },
    };

    await act(async () => {
      root.render(React.createElement(ReplicaChatView));
    });

    expect(container.querySelectorAll('[data-chat-role="user"]').length).toBe(1);
    expect(container.textContent).toContain('hydrate后应立刻可见的用户消息');
  });

  it('renders a simple user+assistant pair', async () => {
    mocks.timeline = [
      { id: 'u1', type: 'message', role: 'user', content: '用户可见测试消息XYZ', createdAt: 1 },
      { id: 'a1', type: 'message', role: 'assistant', content: '助手回复ABC', createdAt: 2, streaming: false },
    ];
    mocks.threadsById.t1.timeline = mocks.timeline;
    await act(async () => {
      root.render(React.createElement(ReplicaChatView));
    });
    expect(container.querySelectorAll('[data-chat-role="user"]').length).toBe(1);
    expect(container.textContent).toContain('用户可见测试消息XYZ');
    expect(container.textContent).toContain('助手回复ABC');
  });

  it('renders user content from ContentBlock objects', async () => {
    mocks.timeline = [
      {
        id: 'u-block',
        type: 'message',
        role: 'user',
        content: { type: 'text', text: '块格式用户消息' },
        createdAt: 1,
      },
      {
        id: 'a-block',
        type: 'message',
        role: 'assistant',
        content: 'ok',
        createdAt: 2,
        streaming: false,
      },
    ];
    mocks.threadsById.t1.timeline = mocks.timeline;
    await act(async () => {
      root.render(React.createElement(ReplicaChatView));
    });
    expect(container.querySelectorAll('[data-chat-role="user"]').length).toBe(1);
    expect(container.textContent).toContain('块格式用户消息');
  });

  it('hides pure /effort system prompts from the transcript', async () => {
    mocks.timeline = [
      { id: 'u1', type: 'message', role: 'user', content: '手输消息应显示', createdAt: 1 },
      { id: 'e1', type: 'message', role: 'user', content: '/effort ultracode', createdAt: 2 },
      { id: 'a1', type: 'message', role: 'assistant', content: '助手', createdAt: 3, streaming: false },
      { id: 'e2', type: 'message', role: 'user', content: '/effort high', createdAt: 4 },
    ];
    mocks.threadsById.t1.timeline = mocks.timeline;
    await act(async () => {
      root.render(React.createElement(ReplicaChatView));
    });
    const users = container.querySelectorAll('[data-chat-role="user"]');
    expect(users.length).toBe(1);
    expect(container.textContent).toContain('手输消息应显示');
    expect(container.textContent).not.toContain('/effort ultracode');
    expect(container.textContent).not.toContain('/effort high');
  });
});
