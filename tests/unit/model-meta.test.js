import { beforeEach, describe, expect, it } from 'vitest';
import { formatModelCredits, formatContextTokens, modelMenuMeta } from '../../src/lib/model-meta';
import { useStore } from '../../src/store';

describe('model meta formatting (WebUI 2.138 对照)', () => {
  it('parses CLI credits strings into a multiplier label', () => {
    expect(formatModelCredits('0.5 credits')).toBe('0.5x');
    expect(formatModelCredits('×0.25 credits')).toBe('0.25x');
    expect(formatModelCredits('x2 credits')).toBe('2x');
    expect(formatModelCredits('1 credit-per-call')).toBe('1x');
    expect(formatModelCredits('free')).toBe('');
    expect(formatModelCredits('0 credits')).toBe('');
    expect(formatModelCredits(null)).toBe('');
    expect(formatModelCredits(undefined)).toBe('');
  });

  it('formats context window token counts like the WebUI', () => {
    expect(formatContextTokens(200000)).toBe('200K');
    expect(formatContextTokens(1048576)).toBe('1.0M');
    expect(formatContextTokens(2000000)).toBe('2M');
    expect(formatContextTokens(512)).toBe('512');
    expect(formatContextTokens(null)).toBe('');
    expect(formatContextTokens(0)).toBe('');
  });

  it('prefers credits over context window for the menu meta column', () => {
    expect(modelMenuMeta({ credits: '0.5 credits', contextWindow: 200000 })).toBe('0.5x');
    expect(modelMenuMeta({ credits: null, contextWindow: 200000 })).toBe('200K');
    expect(modelMenuMeta({ credits: null, contextWindow: null })).toBe('');
    expect(modelMenuMeta(null)).toBe('');
  });
});

function runtime() {
  return {
    connectionState: 'connected',
    timeline: [],
    permissionRequests: [],
    questions: [],
    usage: null,
    availableCommands: [],
    isAwaitingResponse: false,
    promptStartedAt: null,
    activePromptRunId: null,
    promptDispatched: false,
    promptQueue: [],
    pendingAttachments: [],
    promptSuggestion: null,
    teamState: null,
    agentPhase: null,
    progress: null,
    historyReplayActive: false,
    models: [],
    modes: [],
    currentModel: null,
    currentMode: 'default',
    capabilities: {},
  };
}

describe('store model normalization keeps credits/context metadata', () => {
  beforeEach(() => {
    useStore.setState({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      projectsById: {
        'project-1': { id: 'project-1', workspacePath: 'C:/Project' },
      },
      threadsById: {
        'thread-1': { id: 'thread-1', projectId: 'project-1', sessionId: 'session-1', metadata: {}, status: 'idle' },
      },
      threadRuntimeById: {
        'thread-1': runtime(),
      },
      ...runtime(),
      sessionId: 'session-1',
      error: null,
      getThreadClient: useStore.getInitialState().getThreadClient,
      updateThreadRecord: async (threadId, patch) => {
        useStore.setState((state) => ({
          threadsById: {
            ...state.threadsById,
            [threadId]: { ...state.threadsById[threadId], ...patch },
          },
        }));
        return true;
      },
      persistProductState: async () => true,
    });
  });

  it('model_update keeps _meta.credits and maxInputTokens on runtime models', () => {
    useStore.getState().handleConversationEvent({
      threadId: 'thread-1',
      type: 'model_update',
      detail: {
        currentModelId: 'hy3',
        availableModels: [
          {
            modelId: 'hy3',
            name: 'Hy3',
            _meta: { credits: '0.5 credits', maxInputTokens: 200000, supportsImages: true },
          },
          { modelId: 'grok-4.5', name: 'Grok 4.5', _meta: { maxInputTokens: 128000 } },
        ],
      },
    });

    const models = useStore.getState().threadRuntimeById['thread-1'].models;
    expect(models).toEqual([
      { id: 'hy3', name: 'Hy3', credits: '0.5 credits', contextWindow: 200000 },
      { id: 'grok-4.5', name: 'Grok 4.5', credits: null, contextWindow: 128000 },
    ]);
  });

  it('config_option_update without _meta backfills credits from the known model list', () => {
    useStore.setState({
      models: [{ id: 'hy3', name: 'Hy3', credits: '0.5 credits', contextWindow: 200000 }],
    });

    useStore.getState().handleSessionUpdate({
      sessionUpdate: 'config_option_update',
      configOptions: [
        {
          id: 'model',
          currentValue: 'hy3',
          options: [
            { value: 'hy3', label: 'Hy3' },
            { value: 'grok-4.5', label: 'Grok 4.5' },
          ],
        },
      ],
    });

    const models = useStore.getState().models;
    expect(models).toEqual([
      { id: 'hy3', name: 'Hy3', credits: '0.5 credits', contextWindow: 200000 },
      { id: 'grok-4.5', name: 'Grok 4.5', credits: null, contextWindow: null },
    ]);
  });
});
