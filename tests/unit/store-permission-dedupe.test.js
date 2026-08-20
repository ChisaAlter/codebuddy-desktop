import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../src/store';

function runtime(overrides = {}) {
  return {
    connectionState: 'connected',
    sessionId: 'session-1',
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
    ...overrides,
  };
}

describe('store permission request dedupe and respond', () => {
  let respondToPermissionRequest;
  let request;

  beforeEach(() => {
    respondToPermissionRequest = vi.fn().mockResolvedValue(true);
    request = vi.fn().mockResolvedValue(true);
    useStore.setState({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      sessionId: 'session-1',
      projectsById: {
        'project-1': { id: 'project-1', workspacePath: 'C:/Project' },
      },
      threadsById: {
        'thread-1': {
          id: 'thread-1',
          projectId: 'project-1',
          sessionId: 'session-1',
          metadata: {},
          status: 'waiting',
          timeline: [],
        },
      },
      threadRuntimeById: {
        'thread-1': runtime(),
      },
      ...runtime(),
      error: null,
      getThreadClient: () => ({
        respondToPermissionRequest,
        request,
      }),
      persistProductState: vi.fn().mockResolvedValue(true),
    });
  });

  function emitPermission(detail) {
    useStore.getState().handleConversationEvent({
      threadId: 'thread-1',
      type: 'interruption_request',
      detail,
    });
  }

  it('merges same toolCallId with different interruptionIds into one card', () => {
    emitPermission({
      sessionUpdate: 'interruption_request',
      sessionId: 'session-1',
      interruptionId: 'ir-a',
      toolCallId: 'tool-1',
    });
    emitPermission({
      sessionUpdate: 'interruption_request',
      sessionId: 'session-1',
      interruptionId: 'ir-b',
      toolCallId: 'tool-1',
    });

    const state = useStore.getState().threadRuntimeById['thread-1'];
    expect(state.permissionRequests).toHaveLength(1);
    expect(state.timeline.filter((item) => item.type === 'interruption')).toHaveLength(1);
  });


  it('merges same interruptionId when toolCallId differs or is missing', () => {
    emitPermission({
      sessionUpdate: 'interruption_request',
      sessionId: 'session-1',
      interruptionId: 'ir-shared',
      toolCallId: 'tool-1',
    });
    emitPermission({
      sessionUpdate: 'interruption_request',
      sessionId: 'session-1',
      interruptionId: 'ir-shared',
      toolCallId: 'tool-other',
    });
    emitPermission({
      sessionUpdate: 'interruption_request',
      sessionId: 'session-1',
      interruptionId: 'ir-shared',
    });

    expect(useStore.getState().threadRuntimeById['thread-1'].permissionRequests).toHaveLength(1);
  });

  it('ignores an exact duplicate permission payload', () => {
    const payload = {
      sessionUpdate: 'interruption_request',
      sessionId: 'session-1',
      interruptionId: 'ir-dup',
      toolCallId: 'tool-dup',
    };
    emitPermission(payload);
    emitPermission(payload);
    emitPermission(payload);

    expect(useStore.getState().threadRuntimeById['thread-1'].permissionRequests).toHaveLength(1);
  });

  it('only performs one successful allow when respond is clicked twice quickly', async () => {
    emitPermission({
      sessionUpdate: 'interruption_request',
      sessionId: 'session-1',
      interruptionId: 'ir-double',
      toolCallId: 'tool-double',
    });

    let releaseFirst;
    const firstEntered = new Promise((resolve) => {
      respondToPermissionRequest.mockImplementationOnce(
        () =>
          new Promise((resolveAllow) => {
            releaseFirst = () => resolveAllow(true);
            resolve();
          }),
      );
    });

    const first = useStore.getState().respondToInterruption('ir-double', 'allow', 'tool-double');
    const second = useStore.getState().respondToInterruption('ir-double', 'allow', 'tool-double');
    await firstEntered;
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);

    expect(respondToPermissionRequest).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(useStore.getState().threadRuntimeById['thread-1'].permissionRequests).toHaveLength(0);
    expect(
      useStore.getState().threadRuntimeById['thread-1'].timeline.find((item) => item.type === 'interruption')?.status,
    ).toBe('resolved');
  });

  it('resolves the card when JSON-RPC respond fails but extension resolve succeeds', async () => {
    emitPermission({
      sessionUpdate: 'interruption_request',
      sessionId: 'session-1',
      interruptionId: 'ir-fallback',
      toolCallId: 'tool-fallback',
    });
    respondToPermissionRequest.mockRejectedValueOnce(new Error('json-rpc failed'));
    request.mockResolvedValueOnce(true);

    await expect(useStore.getState().respondToInterruption('ir-fallback', 'allow', 'tool-fallback')).resolves.toBe(true);

    expect(useStore.getState().threadRuntimeById['thread-1'].permissionRequests).toHaveLength(0);
    expect(useStore.getState().error).toBeNull();
  });

  it('expires permission cards on interaction_requests_invalidated and blocks further respond', async () => {
    emitPermission({
      sessionUpdate: 'interruption_request',
      sessionId: 'session-1',
      interruptionId: 'ir-gone',
      toolCallId: 'tool-gone',
    });

    useStore.getState().handleConversationEvent({
      threadId: 'thread-1',
      type: 'interaction_requests_invalidated',
      detail: {
        interruptionIds: ['ir-gone', 'tool-gone'],
        reason: 'connection-replaced',
      },
    });

    const state = useStore.getState().threadRuntimeById['thread-1'];
    expect(state.permissionRequests).toHaveLength(0);
    expect(state.timeline.find((item) => item.type === 'interruption')?.status).toBe('expired');
    expect(useStore.getState().threadsById['thread-1'].status).toBe('error');

    await expect(useStore.getState().respondToInterruption('ir-gone', 'allow', 'tool-gone')).resolves.toBe(false);
    expect(respondToPermissionRequest).not.toHaveBeenCalled();
  });

  it('leaves waiting when other permission cards remain after one allow', async () => {
    emitPermission({
      sessionUpdate: 'interruption_request',
      sessionId: 'session-1',
      interruptionId: 'ir-1',
      toolCallId: 'tool-1',
    });
    emitPermission({
      sessionUpdate: 'interruption_request',
      sessionId: 'session-1',
      interruptionId: 'ir-2',
      toolCallId: 'tool-2',
    });

    await expect(useStore.getState().respondToInterruption('ir-1', 'allow', 'tool-1')).resolves.toBe(true);

    expect(useStore.getState().threadRuntimeById['thread-1'].permissionRequests).toHaveLength(1);
    expect(useStore.getState().threadsById['thread-1'].status).toBe('waiting');
  });

  it('allows an interruption on a background thread even when activeThread is different', async () => {
    useStore.setState({
      activeThreadId: 'thread-1',
      sessionId: 'session-1',
      threadsById: {
        ...useStore.getState().threadsById,
        'thread-2': {
          id: 'thread-2',
          projectId: 'project-1',
          sessionId: 'session-2',
          metadata: {},
          status: 'waiting',
          timeline: [],
        },
      },
      threadRuntimeById: {
        ...useStore.getState().threadRuntimeById,
        'thread-2': runtime({
          sessionId: 'session-2',
          permissionRequests: [{ interruptionId: 'ir-bg', toolCallId: 'tool-bg' }],
          timeline: [
            {
              type: 'interruption',
              status: 'pending',
              interruptionId: 'ir-bg',
              toolCallId: 'tool-bg',
            },
          ],
        }),
      },
    });

    await expect(
      useStore.getState().respondToInterruption('ir-bg', 'allow', 'tool-bg', 'thread-2'),
    ).resolves.toBe(true);

    expect(respondToPermissionRequest).toHaveBeenCalledWith('ir-bg', 'tool-bg', 'allow');
    expect(useStore.getState().threadRuntimeById['thread-2'].permissionRequests).toHaveLength(0);
    expect(useStore.getState().activeThreadId).toBe('thread-1');
  });
});
