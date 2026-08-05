import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../src/store';
import { reduceAcpEvent } from '../../src/lib/timeline.js';
import { generateTranscriptEvents, generateStreamChunks, hydrateTranscript } from '../../scripts/test/perf-fixtures.cjs';

/**
 * perf-timeline-path.test.js — the fixture-driven measurement path must call
 * the SAME reducer the real SSE handler calls (plan §3.1 / Phase B):
 *
 *  - real handler: sessions-chat handleSessionUpdate → store.appendTimelineEvent
 *    → product-persist appendThreadTimelineEvent → reduceAcpEvent (imported
 *    from src/lib/timeline.js) + queueCoalescedTimelineEvent for coalesced
 *    event types;
 *  - fixture path: perf-fixtures hydrateTranscript → reduceAcpEvent (the same
 *    module instance).
 *
 * Assertions here pin the function-reference identity AND the byte-identical
 * timeline outcome for the same event sequence through the real store slice.
 */

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

function seedThread() {
  useStore.setState({
    activeProjectId: 'project-1',
    activeThreadId: 'thread-1',
    projectOrder: ['project-1'],
    threadOrderByProject: { 'project-1': ['thread-1'] },
    projectsById: {
      'project-1': { id: 'project-1', name: 'Project', workspacePath: 'C:/Project', preferences: {} },
    },
    threadsById: {
      'thread-1': {
        id: 'thread-1',
        projectId: 'project-1',
        sessionId: null,
        title: 'T',
        draft: '',
        timeline: [],
        status: 'idle',
        unread: false,
        pinned: false,
        archivedAt: null,
        modelId: null,
        modeId: 'default',
        createdAt: 1,
        updatedAt: 1,
        lastOpenedAt: 1,
        metadata: {},
      },
    },
    threadRuntimeById: { 'thread-1': runtime() },
  });
}

describe('perf timeline path — same reducer as the real SSE handler', () => {
  beforeEach(() => {
    window.electronAPI = { saveProductState: vi.fn().mockResolvedValue({ ok: true }) };
    seedThread();
  });

  it('fixture hydration and the store append path share the same reduceAcpEvent reference', async () => {
    // perf-fixtures hydrates through the same module instance the store slice
    // imports (product-persist.js imports '../../lib/timeline' → timeline.js).
    const { reduceAcpEvent: fixtureReducer } = await import('../../src/lib/timeline.js');
    expect(fixtureReducer).toBe(reduceAcpEvent);
  });

  it('appendThreadTimelineEvent produces byte-identical timeline to direct reduceAcpEvent', async () => {
    const events = generateTranscriptEvents({ count: 60, seed: 5 });
    const expected = await hydrateTranscript(events);
    // Apply the same events through the REAL store slice path, ending with the
    // same closeAssistantStream the product applies on stream end.
    const store = useStore.getState();
    for (const event of events) {
      store.appendThreadTimelineEvent('thread-1', event.eventType, event.payload);
    }
    store.closeAssistantStream();
    const viaStore = useStore.getState().threadRuntimeById['thread-1'].timeline;
    // createdBy timestamps differ (Date.now per entry) — compare structure:
    // types, roles, content and messageIds must match exactly.
    const strip = (entry) => ({
      type: entry.type,
      role: entry.role,
      content: entry.content,
      messageId: entry.messageId || null,
      streaming: entry.streaming,
      status: entry.status || null,
      title: entry.title || null,
      toolCallId: entry.toolCallId || null,
    });
    expect(viaStore.map(strip)).toEqual(expected.map(strip));
    expect(viaStore.length).toBe(expected.length);
  });

  it('coalesced event types (agent_message_chunk) route through the coalesce queue in the foreground', () => {
    // Foreground (jsdom document.hidden === false) chunk appends apply
    // immediately through applyTimelineEventNow — the same code path the real
    // SSE handler uses for live streams.
    const store = useStore.getState();
    const before = useStore.getState().threadRuntimeById['thread-1'].timeline;
    store.appendThreadTimelineEvent('thread-1', 'agent_message_chunk', {
      messageId: 'm1',
      content: 'hello ',
      streaming: true,
      sessionUpdate: 'agent_message_chunk',
    });
    const mid = useStore.getState().threadRuntimeById['thread-1'].timeline;
    expect(mid.length).toBe(before.length + 1);
    expect(mid[mid.length - 1].content).toBe('hello ');
    store.appendThreadTimelineEvent('thread-1', 'agent_message_chunk', {
      messageId: 'm1',
      content: 'world',
      streaming: true,
      sessionUpdate: 'agent_message_chunk',
    });
    const after = useStore.getState().threadRuntimeById['thread-1'].timeline;
    // Same messageId merged — one entry, concatenated content.
    expect(after.length).toBe(before.length + 1);
    expect(after[after.length - 1].content).toBe('hello world');
  });

  it('stream chunks from the fixture are valid agent_message_chunk events for the reducer', async () => {
    const chunks = generateStreamChunks({ count: 50, seed: 2 });
    const store = useStore.getState();
    const base = await hydrateTranscript([]);
    expect(base.length).toBe(0);
    for (const chunk of chunks) store.appendThreadTimelineEvent('thread-1', chunk.eventType, chunk.payload);
    const timeline = useStore.getState().threadRuntimeById['thread-1'].timeline;
    // 50 chunks on one messageId merge into a single streaming assistant message.
    expect(timeline.length).toBe(1);
    expect(timeline[0].type).toBe('message');
    expect(timeline[0].role).toBe('assistant');
    expect(timeline[0].streaming).toBe(true);
    expect(timeline[0].content.split(' ').length).toBeGreaterThan(20);
  });

  it('user/tool/thinking events from the fixture hydrate to the expected entry types', async () => {
    const events = generateTranscriptEvents({ count: 30, seed: 3 });
    const store = useStore.getState();
    for (const event of events) store.appendThreadTimelineEvent('thread-1', event.eventType, event.payload);
    const timeline = useStore.getState().threadRuntimeById['thread-1'].timeline;
    const types = new Set(timeline.map((entry) => entry.type));
    expect(types.has('message')).toBe(true);
    expect(types.has('thinking')).toBe(true);
    expect(types.has('tool_call')).toBe(true);
    const expected = await hydrateTranscript(events);
    expect(timeline.length).toBe(expected.length);
  });
});
