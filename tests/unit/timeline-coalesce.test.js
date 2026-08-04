import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProductPersistSlice } from '../../src/store/slices/product-persist.js';

function createHarness() {
  const threadTimelinePersistTimers = new Map();
  const threadTimelineCoalesce = new Map();
  const threadDraftPersistTimers = new Map();
  const terminalStatePersistTimers = new Map();
  const workspaceStatePersistTimers = new Map();
  let productStateSaveChain = Promise.resolve(true);
  let state = {
    productStateLoaded: true,
    threadsById: {
      t1: { id: 't1', timeline: [], updatedAt: null },
    },
    threadRuntimeById: {
      t1: {
        timeline: [],
        isAwaitingResponse: true,
        promptQueue: [],
      },
    },
  };

  const set = (partial) => {
    const next = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...next };
    if (next.threadRuntimeById) {
      state.threadRuntimeById = next.threadRuntimeById;
    }
    if (next.threadsById) {
      state.threadsById = next.threadsById;
    }
  };
  const get = () => ({
    ...state,
    ...api,
  });

  const api = createProductPersistSlice(set, get, {
    threadTimelinePersistTimers,
    threadTimelineCoalesce,
    threadDraftPersistTimers,
    terminalStatePersistTimers,
    workspaceStatePersistTimers,
    getProductStateSaveChain: () => productStateSaveChain,
    setProductStateSaveChain: (value) => {
      productStateSaveChain = value;
    },
    serializePromptQueue: (q) => q,
  });

  // Minimal patchThreadRuntime used by the slice (mirrors store behavior for tests).
  api.patchThreadRuntime = (threadId, patch) => {
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'timeline')) {
      const pending = threadTimelineCoalesce.get(threadId);
      if (pending?.timer) clearTimeout(pending.timer);
      threadTimelineCoalesce.delete(threadId);
    }
    const prev = state.threadRuntimeById[threadId] || {};
    state = {
      ...state,
      threadRuntimeById: {
        ...state.threadRuntimeById,
        [threadId]: { ...prev, ...patch },
      },
    };
  };

  return { api, getState: () => state, threadTimelineCoalesce, threadTimelinePersistTimers };
}

describe('timeline stream coalescing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => false,
    });
  });

  it('applies stream chunks immediately while the document is visible', () => {
    const { api, getState, threadTimelineCoalesce } = createHarness();

    api.appendThreadTimelineEvent('t1', 'agent_thought_chunk', {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'a' },
    });

    expect(threadTimelineCoalesce.has('t1')).toBe(false);
    const timeline = getState().threadRuntimeById.t1.timeline;
    expect(timeline.length).toBe(1);
    expect(timeline[0].type).toBe('thinking');
    expect(String(timeline[0].content || '')).toContain('a');
    expect(getState().threadRuntimeById.t1.isAwaitingResponse).toBe(false);
  });

  it('batches agent_thought_chunk updates while the document is hidden', () => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => true,
    });
    const { api, getState, threadTimelineCoalesce } = createHarness();

    api.appendThreadTimelineEvent('t1', 'agent_thought_chunk', {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'a' },
    });
    api.appendThreadTimelineEvent('t1', 'agent_thought_chunk', {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'b' },
    });
    api.appendThreadTimelineEvent('t1', 'agent_thought_chunk', {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'c' },
    });

    // Still pending — runtime not yet updated with merged text.
    expect(threadTimelineCoalesce.has('t1')).toBe(true);
    expect(getState().threadRuntimeById.t1.timeline).toEqual([]);

    vi.advanceTimersByTime(250);

    expect(threadTimelineCoalesce.has('t1')).toBe(false);
    const timeline = getState().threadRuntimeById.t1.timeline;
    expect(timeline.length).toBe(1);
    expect(timeline[0].type).toBe('thinking');
    expect(String(timeline[0].content || '')).toContain('a');
    expect(String(timeline[0].content || '')).toContain('c');
    expect(getState().threadRuntimeById.t1.isAwaitingResponse).toBe(false);
  });

  it('flushes coalesce before non-stream events so tool_call sees thought text', () => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => true,
    });
    const { api, getState } = createHarness();

    api.appendThreadTimelineEvent('t1', 'agent_thought_chunk', {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'plan' },
    });
    api.appendThreadTimelineEvent('t1', 'tool_call', {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc1',
      title: 'Read',
      status: 'pending',
    });

    const timeline = getState().threadRuntimeById.t1.timeline;
    const types = timeline.map((item) => item.type);
    expect(types).toContain('thinking');
    expect(types).toContain('tool_call');
    const thinking = timeline.find((item) => item.type === 'thinking');
    expect(String(thinking.content || '')).toContain('plan');
  });

  it('flushThreadTimelineCoalesce commits immediately', () => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => true,
    });
    const { api, getState, threadTimelineCoalesce } = createHarness();

    api.appendThreadTimelineEvent('t1', 'agent_message_chunk', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello' },
    });
    expect(threadTimelineCoalesce.has('t1')).toBe(true);

    api.flushThreadTimelineCoalesce('t1');
    expect(threadTimelineCoalesce.has('t1')).toBe(false);
    const timeline = getState().threadRuntimeById.t1.timeline;
    expect(timeline.some((item) => item.type === 'message' && String(item.content || '').includes('hello'))).toBe(
      true,
    );
  });
});

describe('persistProductState coalescing (M-perf)', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { electronAPI: { saveProductState: vi.fn().mockResolvedValue(true) } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('coalesces a burst of persist triggers into a chain with one final save', async () => {
    const { api } = createHarness();
    const saveProductState = vi.mocked(window.electronAPI.saveProductState);

    // Three full-state persist triggers in the same tick (typing pause +
    // stream pause + terminal pause all landing together).
    const first = api.persistProductState();
    const second = api.persistProductState();
    const third = api.persistProductState();
    await Promise.all([first, second, third]);

    // Exactly two writes: the in-flight save plus the chain-tail save that
    // carries the freshest state (requests that arrived while busy are not lost
    // but are folded into one final write instead of N serializations).
    expect(saveProductState).toHaveBeenCalledTimes(2);
  });

  it('persists immediately when the chain is idle', async () => {
    const { api } = createHarness();
    const saveProductState = vi.mocked(window.electronAPI.saveProductState);

    await api.persistProductState();
    expect(saveProductState).toHaveBeenCalledTimes(1);
  });
});

describe('persistProductState tail-save race (M-perf review fix)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not drop requests arriving while the tail save is in flight', async () => {
    const { api } = createHarness();
    const resolvers = [];
    const saveProductState = vi.fn().mockImplementation(
      () => new Promise((resolve) => {
        resolvers.push(resolve);
      }),
    );
    vi.stubGlobal('window', { electronAPI: { saveProductState } });

    const first = api.persistProductState();
    const second = api.persistProductState();
    // Let the chain start the first save.
    await Promise.resolve();
    await Promise.resolve();
    expect(saveProductState).toHaveBeenCalledTimes(1);

    resolvers.shift()({ ok: true }); // finish the first save
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // The tail save (for `second`) is now in flight.
    expect(saveProductState).toHaveBeenCalledTimes(2);

    const third = api.persistProductState(); // arrives during the tail save
    resolvers.shift()({ ok: true }); // finish the tail save
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // The finally block sees the dirty flag and schedules one more save.
    expect(saveProductState).toHaveBeenCalledTimes(3);
    resolvers.shift()({ ok: true });

    await Promise.all([first, second, third]);
    expect(saveProductState).toHaveBeenCalledTimes(3);
  });
});
