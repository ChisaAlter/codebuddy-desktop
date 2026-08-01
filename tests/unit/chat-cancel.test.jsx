import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cancelSession: vi.fn(),
  connectionState: 'connected',
  isAwaitingResponse: true,
  threadStatus: 'idle',
  timeline: [],
  promptStartedAt: null,
  activePromptRunId: null,
  workflowRuntime: null,
}));

vi.mock('../../src/store', () => ({
  useStore(selector) {
    return selector({
      timeline: mocks.timeline,
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      projectsById: { 'project-1': { id: 'project-1', name: 'Project' } },
      threadsById: {
        'thread-1': { id: 'thread-1', projectId: 'project-1', draft: '', status: mocks.threadStatus },
      },
      threadRuntimeById: { 'thread-1': mocks.workflowRuntime || {} },
      guiSettings: { locale: 'zh' },
      capabilities: {},
      connectionState: mocks.connectionState,
      currentModel: 'test-model',
      currentMode: 'default',
      sessionTitle: 'Test session',
      usage: null,
      availableCommands: [],
      sendPrompt: vi.fn(),
      cancelSession: mocks.cancelSession,
      respondToInterruption: vi.fn(),
      bootstrap: vi.fn(),
      restartProjectRuntime: vi.fn(),
      isAwaitingResponse: mocks.isAwaitingResponse,
      promptStartedAt: mocks.promptStartedAt,
      activePromptRunId: mocks.activePromptRunId,
      historyReplayActive: false,
      models: [{ id: 'test-model', name: 'Test model' }],
      modes: [
        { id: 'default', name: 'Always Ask' },
        { id: 'acceptEdits', name: 'Accept Edits' },
        { id: 'plan', name: 'Plan' },
        { id: 'auto', name: 'Auto' },
        { id: 'dontAsk', name: "Don't Ask" },
        { id: 'bypassPermissions', name: 'Bypass Permissions' },
        { id: 'delegate', name: 'Delegate' },
        { id: 'fullAccess', name: 'Full Access' },
        { id: 'work', name: 'Work' },
        { id: 'ignore', name: 'Ignore' },
      ],
      setModel: vi.fn(),
      setMode: vi.fn(),
      setThoughtLevel: vi.fn(),
      thoughtLevel: 'enabled',
      thoughtLevelOptions: [],
      pendingAttachments: [],
      chooseAttachments: vi.fn(),
      removePendingAttachment: vi.fn(),
      addDroppedAttachments: vi.fn(),
      addClipboardImageAttachment: vi.fn(),
      clearPromptSuggestion: vi.fn(),
      promptSuggestion: null,
      settings: {},
      workspaceExtraDirs: [],
      workspaceDirsBusy: false,
      workspaceDirsError: null,
      chooseAndAddWorkspaceExtraDir: vi.fn(),
      removeWorkspaceExtraDir: vi.fn(),
    });
  },
}));

import { useStore } from '../../src/store';
import ReplicaChatView, {
  formatThinkingDuration,
  getResponseActivityLabel,
  resolveThinkingEndedAt,
} from '../../src/components/ReplicaChatView';

useStore.getState = () => ({
  activeProjectId: 'project-1',
  activeThreadId: 'thread-1',
});

describe('ReplicaChatView cancellation', () => {
  let container;
  let root;
  let originalScrollIntoView;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = vi.fn();
    mocks.cancelSession.mockReset();
    mocks.connectionState = 'connected';
    mocks.isAwaitingResponse = true;
    mocks.threadStatus = 'idle';
    mocks.timeline = [];
    mocks.promptStartedAt = null;
    mocks.activePromptRunId = null;
    mocks.workflowRuntime = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    Element.prototype.scrollIntoView = originalScrollIntoView;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });

  it('cancels the active CodeBuddy session when Stop is clicked', async () => {
    await act(async () => root.render(React.createElement(ReplicaChatView)));

    // WebUI input.stop / input.send titles
    const stopButton = container.querySelector('button[title="停止"]');
    expect(stopButton).toBeTruthy();
    expect(container.querySelector('button[title="加入待发送队列"]')).toBeNull();
    expect(container.querySelector('button[title="发送"]')).toBeNull();

    await act(async () => {
      stopButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.cancelSession).toHaveBeenCalledTimes(1);
  });

  it('keeps Stop visible while the thread is running between streamed events', async () => {
    mocks.isAwaitingResponse = false;
    mocks.threadStatus = 'running';
    await act(async () => root.render(React.createElement(ReplicaChatView)));

    expect(container.querySelector('button[title="停止"]')).toBeTruthy();
    expect(container.querySelector('button[title="发送"]')).toBeNull();
  });

  it('does not let a stale streaming timeline entry replace Send with Stop in an idle thread', async () => {
    mocks.isAwaitingResponse = false;
    mocks.threadStatus = 'idle';
    mocks.activePromptRunId = null;
    mocks.timeline = [
      { id: 'stale-assistant', type: 'message', role: 'assistant', content: 'Old stream', streaming: true },
    ];
    await act(async () => root.render(React.createElement(ReplicaChatView)));

    expect(container.querySelector('button[title="停止"]')).toBeNull();
    expect(container.querySelector('button[title="发送"]')).toBeTruthy();
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it('does not show Stop while the session is disconnected', async () => {
    mocks.connectionState = 'error';
    await act(async () => root.render(React.createElement(ReplicaChatView)));

    expect(container.querySelector('button[title="停止"]')).toBeNull();
    // WebUI keeps send control (disabled) with input.send title
    expect(container.querySelector('button[title="发送"]')).toBeTruthy();
  });

  it('shows Chinese permission modes and anchors the model picker inside the window', async () => {
    mocks.isAwaitingResponse = false;
    await act(async () => root.render(React.createElement(ReplicaChatView)));

    const findButton = (label) =>
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent.trim() === label);
    const modeButton = findButton('始终询问');
    expect(modeButton).toBeTruthy();

    await act(async () => {
      modeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const modeText = container.textContent;
    expect(modeText).toContain('接受编辑');
    expect(modeText).toContain('计划模式');
    expect(modeText).toContain('自动执行');
    expect(modeText).toContain('不再询问');
    expect(modeText).toContain('跳过权限确认');
    expect(modeText).toContain('协调模式');
    expect(modeText).toContain('完全访问');
    expect(modeText).toContain('工作模式');
    expect(modeText).toContain('继承主会话模式');
    expect(modeText).not.toContain('Bypass Permissions');
    expect(modeText).not.toContain('Full Access');

    await act(async () => {
      modeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      findButton('Test model').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const modelPicker = container.querySelector('[data-model-picker]');
    expect(modelPicker).toBeTruthy();
    expect(modelPicker.className).toContain('right-0');
    expect(modelPicker.className).not.toContain('left-0');
  });

  it('disables model and mode changes while a response is running', async () => {
    mocks.isAwaitingResponse = false;
    mocks.threadStatus = 'running';
    await act(async () => root.render(React.createElement(ReplicaChatView)));

    const findButton = (label) =>
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent.trim() === label);
    expect(findButton('始终询问').disabled).toBe(true);
    expect(findButton('Test model').disabled).toBe(true);
  });

  it('pauses automatic following when the reader scrolls upward and resumes from the latest button', async () => {
    mocks.timeline = [
      { id: 'assistant-1', type: 'message', role: 'assistant', content: 'Streaming', streaming: true },
    ];
    await act(async () => root.render(React.createElement(ReplicaChatView)));

    const initialScrollCalls = Element.prototype.scrollIntoView.mock.calls.length;
    const scrollContainer = container.querySelector('.overflow-y-auto');
    Object.defineProperties(scrollContainer, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 500 },
    });
    await act(async () => {
      scrollContainer.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }));
    });
    expect(container.querySelector('button[title="跳到最新"]')).toBeTruthy();

    mocks.timeline = [
      ...mocks.timeline,
      { id: 'assistant-2', type: 'message', role: 'assistant', content: 'More', streaming: true },
    ];
    await act(async () => root.render(React.createElement(ReplicaChatView)));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(initialScrollCalls);

    await act(async () => {
      container.querySelector('button[title="跳到最新"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(initialScrollCalls + 1);
    expect(container.querySelector('button[title="跳到最新"]')).toBeNull();
  });

  it('renders a visible workflow panel for parallel subagents and preserves manual collapse', async () => {
    mocks.isAwaitingResponse = false;
    mocks.threadStatus = 'running';
    mocks.activePromptRunId = 'run-workflow';
    mocks.timeline = [
      { id: 'user-workflow', type: 'message', role: 'user', content: '检查项目', createdAt: 1000 },
    ];
    mocks.workflowRuntime = {
      timeline: mocks.timeline,
      promptStartedAt: 1000,
      activePromptRunId: mocks.activePromptRunId,
      agentPhase: { phase: 'planning', startedAt: 1000 },
      progress: { current: 2, total: 6, message: '正在并行探索' },
      teamState: {
        name: '探索工作流',
        members: Array.from({ length: 6 }, (_, index) => ({
          id: `agent-${index}`,
          name: `子代理 ${index + 1}`,
          task: `检查子系统 ${index + 1}`,
          status: index < 2 ? 'running' : 'completed',
        })),
      },
    };
    await act(async () => root.render(React.createElement(ReplicaChatView)));

    const panel = container.querySelector('[data-testid="workflow-status-panel"]');
    expect(panel).toBeTruthy();
    expect(panel.textContent).toContain('6 个子代理');
    expect(panel.textContent).toContain('子代理 1');
    expect(panel.textContent).toContain('2 个进行中');
    expect(panel.textContent).toContain('2/6');
    const header = panel.querySelector('button[aria-expanded="true"]');
    expect(header).toBeTruthy();
    await act(async () => header.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(panel.querySelector('button[aria-expanded="false"]')).toBeTruthy();
  });

  it('falls back to readable workflow copy for new ACP phases', async () => {
    mocks.isAwaitingResponse = false;
    mocks.threadStatus = 'running';
    mocks.activePromptRunId = 'run-new-phase';
    mocks.timeline = [{ id: 'user-new-phase', type: 'message', role: 'user', content: '启动工作流', createdAt: 1000 }];
    mocks.workflowRuntime = {
      timeline: mocks.timeline,
      promptStartedAt: 1000,
      activePromptRunId: mocks.activePromptRunId,
      agentPhase: { phase: 'future_phase' },
    };

    await act(async () => root.render(React.createElement(ReplicaChatView)));

    const panel = container.querySelector('[data-testid="workflow-status-panel"]');
    expect(panel).toBeTruthy();
    expect(panel.textContent).toContain('正在执行');
    expect(panel.textContent).not.toContain('workflow.phase.future_phase');
  });

  it('keeps the workflow panel visible while permission is pending', async () => {
    mocks.isAwaitingResponse = false;
    mocks.threadStatus = 'idle';
    mocks.workflowRuntime = {
      promptStartedAt: 1000,
      permissionRequests: [{ interruptionId: 'permission-1', status: 'pending', toolName: 'Bash' }],
    };

    await act(async () => root.render(React.createElement(ReplicaChatView)));

    const panel = container.querySelector('[data-testid="workflow-status-panel"]');
    expect(panel).toBeTruthy();
    expect(panel.textContent).toContain('等待权限确认');
    expect(panel.textContent).toContain('等待你的权限确认');
  });

  it('keeps tool records manually collapsible without status updates reopening them', async () => {
    mocks.isAwaitingResponse = false;
    // WebUI: ≥2 finished tools auto-collapse into “N 个工具已执行”; single tools stay as light rows.

    mocks.timeline = [
      { id: 'user-1', type: 'message', role: 'user', content: '检查项目' },
      {
        id: 'tool-1',
        type: 'tool_call',
        role: 'assistant',
        status: 'running',
        title: 'Read files',
        toolName: 'Read',
        rawInput: { path: 'src/a.js' },
      },
      {
        id: 'tool-2',
        type: 'tool_call',
        role: 'assistant',
        status: 'running',
        title: 'Grep',
        toolName: 'Grep',
        rawInput: { pattern: 'foo' },
      },
    ];
    await act(async () => root.render(React.createElement(ReplicaChatView)));

    // While tools are running the list stays expanded (no collapsed summary yet).
    expect(container.textContent).toContain('Read files');
    expect(container.textContent).toContain('Grep');
    expect(container.textContent).not.toContain('执行记录');

    const findToolButton = (label) =>
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent.includes(label));

    await act(async () => {
      findToolButton('Read files').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(findToolButton('Read files').getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('输入');

    mocks.timeline = [
      mocks.timeline[0],
      { ...mocks.timeline[1], status: 'completed' },
      { ...mocks.timeline[2], status: 'completed' },
    ];
    await act(async () => root.render(React.createElement(ReplicaChatView)));
    // Completing tools must not reset a manually expanded detail row.
    expect(findToolButton('Read files').getAttribute('aria-expanded')).toBe('true');

    mocks.timeline = [
      ...mocks.timeline,
      { id: 'final-1', type: 'message', role: 'assistant', content: '最终回答', streaming: false },
    ];
    await act(async () => root.render(React.createElement(ReplicaChatView)));

    const findCollapsedSummary = () =>
      Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent.includes('个工具已执行'),
      );
    expect(findCollapsedSummary()).toBeTruthy();
    expect(findCollapsedSummary().getAttribute('aria-expanded')).toBe('false');
    // Collapsed summary hides individual tool chrome until reopened.
    expect(container.textContent).not.toContain('Read files');

    await act(async () => {
      findCollapsedSummary().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('Read files');
    expect(container.textContent).toContain('Grep');
  });

  it('shows a live response activity indicator before the first model chunk arrives', async () => {
    mocks.isAwaitingResponse = true;
    mocks.promptStartedAt = Date.now() - 5000;
    await act(async () => root.render(React.createElement(ReplicaChatView)));

    const indicator = container.querySelector('[data-response-activity]');
    expect(indicator).toBeTruthy();
    // WebUI phase.modelRequesting (zh)
    expect(indicator.textContent).toContain('等待模型响应');
    expect(indicator.textContent).toContain('秒');
    expect(indicator.querySelectorAll('.response-activity-dot')).toHaveLength(3);
  });

  it('distinguishes thinking, tool execution, answer generation, waiting, and cancellation phases', () => {
    const base = {
      connectionState: 'connected',
      historyReplayActive: false,
      activeThreadStatus: 'running',
      isAwaitingResponse: false,
      activePromptRunId: 'run-1',
      timeline: [],
    };
    expect(
      getResponseActivityLabel({
        ...base,
        timeline: [{ type: 'thinking', streaming: true }],
      }),
    ).toBe('正在思考');
    expect(
      getResponseActivityLabel({
        ...base,
        timeline: [{ type: 'tool_call', status: 'running' }],
      }),
    ).toBe('执行工具');
    expect(
      getResponseActivityLabel({
        ...base,
        timeline: [{ type: 'message', role: 'assistant', streaming: true }],
      }),
    ).toBe('正在生成回答');
    expect(getResponseActivityLabel({ ...base, activeThreadStatus: 'waiting' })).toBe('正在等待你的操作');
    expect(getResponseActivityLabel({ ...base, activeThreadStatus: 'cancelling' })).toBe('正在停止任务');
  });

  it('ignores stale streaming and tool entries when the current thread is idle', () => {
    expect(
      getResponseActivityLabel({
        connectionState: 'connected',
        historyReplayActive: false,
        activeThreadStatus: 'idle',
        isAwaitingResponse: false,
        activePromptRunId: null,
        timeline: [
          { type: 'thinking', streaming: true },
          { type: 'tool_call', status: 'running' },
        ],
      }),
    ).toBeNull();
  });

  it('derives activity from the current prompt turn instead of an older unfinished tool', () => {
    expect(
      getResponseActivityLabel({
        connectionState: 'connected',
        historyReplayActive: false,
        activeThreadStatus: 'running',
        isAwaitingResponse: false,
        activePromptRunId: 'run-current',
        promptStartedAt: 2000,
        timeline: [
          { type: 'message', role: 'user', createdAt: 1000, content: '旧问题' },
          { type: 'tool_call', status: 'running', createdAt: 1100 },
          { type: 'message', role: 'user', createdAt: 2000, content: '新问题' },
          { type: 'message', role: 'assistant', streaming: true, createdAt: 2100, content: '新回答' },
        ],
      }),
    ).toBe('正在生成回答');
  });

  it('hides checkpoint identifiers and does not show merged-internal chrome under tools', async () => {
    mocks.isAwaitingResponse = false;
    mocks.timeline = [
      { id: 'user-compact', type: 'message', role: 'user', content: '继续' },
      { id: 'tool-compact', type: 'tool_call', role: 'assistant', status: 'completed', title: 'Edit file' },
      {
        id: 'checkpoint-compact',
        type: 'checkpoint',
        role: 'assistant',
        status: 'completed',
        content: '352ef271-15b4-4bcd-94b5-c057e5faa7ad',
      },
    ];
    await act(async () => root.render(React.createElement(ReplicaChatView)));

    // Tool row stays visible; checkpoint raw ids / internal-progress footer stay hidden.
    expect(container.textContent).toContain('Edit file');
    expect(container.textContent).not.toContain('已合并');
    expect(container.textContent).not.toContain('内部进度');
    expect(container.textContent).not.toContain('352ef271-15b4-4bcd-94b5-c057e5faa7ad');
    expect(container.textContent).not.toContain('执行记录');
  });
  it('renders resolved permissions as a compact row without protocol identifiers', async () => {
    mocks.isAwaitingResponse = false;
    mocks.timeline = [
      { id: 'user-permission', type: 'message', role: 'user', content: '检查项目' },
      {
        id: 'permission-resolved',
        type: 'interruption',
        role: 'assistant',
        status: 'resolved',
        meta: {
          interruptionId: 'ir-secret-identifier',
          toolCallId: 'tool-secret-identifier',
          toolName: 'Bash',
          toolTitle: '运行命令',
          toolInput: { command: 'npm test', description: '运行测试' },
          resolution: 'allowAll',
        },
      },
    ];
    await act(async () => root.render(React.createElement(ReplicaChatView)));

    expect(container.textContent).toContain('需要授权');
    expect(container.textContent).toContain('运行命令 · 运行测试');
    expect(container.textContent).toContain('已始终允许');
    expect(container.textContent).not.toContain('ir-secret-identifier');
    expect(container.textContent).not.toContain('tool-secret-identifier');
    expect(container.querySelector('pre')).toBeNull();
  });

  it('renders standard Markdown tables as readable HTML tables', async () => {
    mocks.isAwaitingResponse = false;
    mocks.timeline = [
      {
        id: 'assistant-table',
        type: 'message',
        role: 'assistant',
        content: '| 模块 | 职责 |\n|------|------|\n| 主进程 | 窗口与 IPC |\n| 渲染进程 | React UI |',
      },
    ];
    await act(async () => root.render(React.createElement(ReplicaChatView)));

    const table = container.querySelector('.markdown-table-wrapper table, .markdown-table-wrap table');
    expect(table).toBeTruthy();
    expect(container.querySelector('.markdown-body.text-chat')).toBeTruthy();
    expect(Array.from(table.querySelectorAll('th')).map((cell) => cell.textContent)).toEqual(['模块', '职责']);
    expect(Array.from(table.querySelectorAll('td')).map((cell) => cell.textContent)).toEqual([
      '主进程',
      '窗口与 IPC',
      '渲染进程',
      'React UI',
    ]);
  });

  it('does not end a turn with empty-tool / merged-internal execution chrome', async () => {
    mocks.isAwaitingResponse = false;
    mocks.timeline = [
      { id: 'user-1', type: 'message', role: 'user', content: '打包' },
      { id: 'think-1', type: 'thinking', role: 'assistant', content: '检查打包脚本', streaming: false },
      { id: 'cp-1', type: 'checkpoint', meta: { event: 'created' } },
      {
        id: 'answer-1',
        type: 'message',
        role: 'assistant',
        content: '打包完成',
        streaming: false,
      },
    ];
    await act(async () => root.render(React.createElement(ReplicaChatView)));

    expect(container.textContent).toContain('打包完成');
    expect(container.textContent).not.toContain('本轮没有可展示的工具调用');
    expect(container.textContent).not.toContain('已合并');
    expect(container.textContent).not.toContain('内部进度');
  });

  it('co-locates thinking with the following assistant answer like WebUI Px', async () => {
    mocks.isAwaitingResponse = false;
    mocks.timeline = [
      { id: 'user-co', type: 'message', role: 'user', content: '你好' },
      {
        id: 'think-co',
        type: 'thinking',
        role: 'assistant',
        content: '先打个招呼',
        streaming: false,
        createdAt: 1000,
        completedAt: 4500,
      },
      {
        id: 'answer-co',
        type: 'message',
        role: 'assistant',
        content: '你好，有什么可以帮忙的？',
        streaming: false,
      },
    ];
    await act(async () => root.render(React.createElement(ReplicaChatView)));

    // WebUI: 已思考（用时 N 秒） with integer seconds, then markdown in one unit.
    expect(container.textContent).toContain('已思考');
    expect(container.textContent).toContain('（用时 4 秒）');
    expect(container.textContent).toContain('你好，有什么可以帮忙的？');
    const assistantUnit = container.querySelector('[data-chat-role="assistant"]');
    expect(assistantUnit).toBeTruthy();
    expect(assistantUnit.querySelector('.thinking-block')).toBeTruthy();
    expect(assistantUnit.querySelector('.markdown-body.text-chat')).toBeTruthy();
    // Collapsed by default when not streaming (WebUI default).
    expect(assistantUnit.querySelector('.thinking-block-content')).toBeNull();
  });

  it('does not render a completed sub-second thought as zero seconds', () => {
    expect(formatThinkingDuration(1000, 1500, false)).toBe('<1 秒');
    expect(formatThinkingDuration(1000, 5500, false)).toBe('4 秒');
  });

  it('does not treat message age as thinking duration when completedAt is missing', () => {
    const now = 1000 + 63 * 3600 * 1000 + 8 * 60 * 1000;
    const endedAt = resolveThinkingEndedAt(
      { type: 'thinking', createdAt: 1000, streaming: false, completedAt: null },
      now,
    );
    expect(endedAt).toBe(1000);
    expect(formatThinkingDuration(1000, endedAt, false)).toBe('<1 秒');
  });

  it('keeps live thinking duration while the thought is still streaming', () => {
    const endedAt = resolveThinkingEndedAt(
      { type: 'thinking', createdAt: 1000, streaming: true, completedAt: null },
      6500,
    );
    expect(endedAt).toBe(6500);
    expect(formatThinkingDuration(1000, endedAt, true)).toBe('5 秒');
  });
});
