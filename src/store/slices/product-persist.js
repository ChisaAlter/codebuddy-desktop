import {
  activeProject,
  activeThread,
  createProjectRecord,
  createThreadRecord,
  emptyProductState,
  normalizeProductState,
  productStateSnapshot,
} from '../../lib/product-state';
import { normalizeGuiSettings } from '../../lib/gui-settings';
import { reduceAcpEvent } from '../../lib/timeline';
import { emptyThreadRuntime } from '../helpers/thread-runtime';
import { terminalStateFromProject, terminalStateSnapshot } from '../helpers/terminal-workspace-state';

/** High-frequency ACP stream chunks — coalesce before React store commits. */
const COALESCED_TIMELINE_EVENTS = new Set(['agent_message_chunk', 'agent_thought_chunk']);
/** Hidden only: batch stream reduces so focus-return is one paint, not a multi-second backlog. */
const TIMELINE_COALESCE_MS_HIDDEN = 200;
const TIMELINE_PERSIST_MS_VISIBLE = 1500;
const TIMELINE_PERSIST_MS_HIDDEN = 2000;
/** Draft-only persist debounce: long enough that normal typing never triggers a
 * full product-state save — only a real pause in thought does. The renderer-side
 * coalescing in persistProductState absorbs the rest. */
const DRAFT_PERSIST_MS = 1500;
/** Max timeline entries persisted to disk AND kept in the live runtime mirror
 * (store.js enforces the same cap on runtime.timeline). Keep in sync with
 * TIMELINE_MAX in src/store.js. */
const TIMELINE_MAX = 300;

function documentIsHidden() {
  return typeof document !== 'undefined' && Boolean(document.hidden);
}

/**
 * Product-state persistence and thread timeline/draft scheduling.
 * Module-level timer maps and productStateSaveChain are injected via ctx.
 */
export function createProductPersistSlice(set, get, ctx) {
  const {
    threadTimelinePersistTimers,
    threadDraftPersistTimers,
    terminalStatePersistTimers,
    workspaceStatePersistTimers,
    threadTimelineCoalesce,
    getProductStateSaveChain,
    setProductStateSaveChain,
    serializePromptQueue,
  } = ctx;

  // M-perf: coalescing flags for persistProductState. While one full snapshot
  // save is queued/running, later requests only mark the chain dirty; the chain
  // tail then runs one final save with the freshest state. Drops bursts of
  // persist triggers (typing pauses, stream pauses, terminal output) to 1-2
  // actual IPC round-trips instead of N full serializations.
  let persistCoalesceBusy = false;
  let persistCoalesceDirty = false;
  let persistCoalesceTail = Promise.resolve(true);
  let persistReportErrors = false;

  const takeTimelineCoalesce = (threadId) => {
    if (!threadId || !threadTimelineCoalesce) return null;
    const entry = threadTimelineCoalesce.get(threadId);
    if (!entry) return null;
    if (entry.timer) clearTimeout(entry.timer);
    threadTimelineCoalesce.delete(threadId);
    return entry;
  };

  const flushTimelineCoalesce = (threadId) => {
    const entry = takeTimelineCoalesce(threadId);
    if (!entry) return false;
    get().patchThreadRuntime(threadId, {
      timeline: entry.timeline,
      isAwaitingResponse: entry.isAwaitingResponse,
    });
    get().scheduleThreadTimelinePersist(threadId);
    return true;
  };

  const applyTimelineEventNow = (threadId, eventType, payload, baseTimeline, baseAwaiting) => {
    get().patchThreadRuntime(threadId, {
      timeline: reduceAcpEvent(baseTimeline, eventType, payload, threadId),
      isAwaitingResponse:
        eventType === 'agent_message_chunk' || eventType === 'agent_thought_chunk' || eventType === 'tool_call'
          ? false
          : baseAwaiting,
    });
    get().scheduleThreadTimelinePersist(threadId);
  };

  const queueCoalescedTimelineEvent = (threadId, eventType, payload) => {
    if (!threadId) return;

    // Foreground: keep live streaming immediate (and unit tests deterministic).
    // Background / unfocused: reduce offline so focus-return is one paint, not a multi-second backlog.
    //
    // M-perf note (deliberate, see RELEASE_NOTES 1.1.0 perf section): foreground
    // chunks are intentionally NOT coalesced into a 50ms window. The IPC-side of
    // the stream storm is already handled in electron/main.cjs (33ms batching
    // per stream), high-frequency terminal output has its own 50ms store merge
    // (appendPaneOutput), and chat text chunks arrive at 1-5/s — a 50ms window
    // rarely contains more than one chunk, so the added 50ms display latency
    // buys nothing measurable while breaking the synchronous-assertion contract
    // of 20+ store integration tests.
    if (!documentIsHidden() || !threadTimelineCoalesce) {
      // If a hidden-window batch was mid-flight and the window became visible, fold it first.
      const pending = takeTimelineCoalesce(threadId);
      const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      const baseTimeline = pending?.timeline ?? runtime.timeline;
      const baseAwaiting = pending ? pending.isAwaitingResponse : runtime.isAwaitingResponse;
      applyTimelineEventNow(threadId, eventType, payload, baseTimeline, baseAwaiting);
      return;
    }

    let entry = threadTimelineCoalesce.get(threadId);
    if (!entry) {
      const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      entry = {
        timeline: runtime.timeline,
        isAwaitingResponse: runtime.isAwaitingResponse,
        timer: null,
      };
      threadTimelineCoalesce.set(threadId, entry);
      entry.timer = setTimeout(() => {
        flushTimelineCoalesce(threadId);
      }, TIMELINE_COALESCE_MS_HIDDEN);
    }

    entry.timeline = reduceAcpEvent(entry.timeline, eventType, payload, threadId);
    if (
      eventType === 'agent_message_chunk' ||
      eventType === 'agent_thought_chunk' ||
      eventType === 'tool_call'
    ) {
      entry.isAwaitingResponse = false;
    }
  };

  return {
  async updateThreadRecord(threadId, patch) {
    if (!threadId || !get().threadsById[threadId]) return;
    const pendingDraftTimer = threadDraftPersistTimers.get(threadId);
    if (pendingDraftTimer) {
      clearTimeout(pendingDraftTimer);
      threadDraftPersistTimers.delete(threadId);
    }
    set((state) => ({
      threadsById: {
        ...state.threadsById,
        [threadId]: {
          ...state.threadsById[threadId],
          ...patch,
          updatedAt: new Date().toISOString(),
        },
      },
    }));
    await get().persistProductState();
  },

  /**
   * Fold any pending coalesced stream chunks into the live runtime.
   * Call before terminal timeline operations that read runtime.timeline.
   */
  flushThreadTimelineCoalesce(threadId) {
    if (!threadId) {
      if (!threadTimelineCoalesce?.size) return;
      for (const id of [...threadTimelineCoalesce.keys()]) flushTimelineCoalesce(id);
      return;
    }
    flushTimelineCoalesce(threadId);
  },

  /**
   * Merge pending coalesced timeline into a patch (used by patchThreadRuntime).
   * Returns the patch to apply; may include timeline from coalesce.
   */
  consumeThreadTimelineCoalesce(threadId, patch = {}) {
    const entry = takeTimelineCoalesce(threadId);
    if (!entry) return patch;
    return {
      timeline: entry.timeline,
      isAwaitingResponse: entry.isAwaitingResponse,
      ...patch,
    };
  },

  appendThreadTimelineEvent(threadId, eventType, payload) {
    if (!threadId) return;

    // Stream tokens: reduce offline and commit on a short timer so focus-return
    // does not replay hundreds of React+markdown updates at once.
    if (COALESCED_TIMELINE_EVENTS.has(eventType)) {
      queueCoalescedTimelineEvent(threadId, eventType, payload);
      return;
    }

    const pending = takeTimelineCoalesce(threadId);
    const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
    const baseTimeline = pending?.timeline ?? runtime.timeline;
    const baseAwaiting = pending ? pending.isAwaitingResponse : runtime.isAwaitingResponse;
    // Thinking duration anchors at first thought chunk (WebUI LIVE); promptStartedAt
    // remains for response-activity chrome only — do not pass it as thinkingStartedAt.
    get().patchThreadRuntime(threadId, {
      timeline: reduceAcpEvent(baseTimeline, eventType, payload, threadId),
      isAwaitingResponse:
        eventType === 'agent_message_chunk' || eventType === 'agent_thought_chunk' || eventType === 'tool_call'
          ? false
          : baseAwaiting,
    });
    get().scheduleThreadTimelinePersist(threadId);
  },

  scheduleThreadTimelinePersist(threadId) {
    if (!threadId) return;
    const existing = threadTimelinePersistTimers.get(threadId);
    if (existing) clearTimeout(existing);
    const delay = documentIsHidden() ? TIMELINE_PERSIST_MS_HIDDEN : TIMELINE_PERSIST_MS_VISIBLE;
    const timer = setTimeout(async () => {
      // M-st5: if flushProductStateSync cleared this timer (it clears the map and
      // clears each timer), the map will no longer hold this timer id — bail out
      // before overwriting the sync snapshot with a stale runtime snapshot.
      if (threadTimelinePersistTimers.get(threadId) !== timer) return;
      threadTimelinePersistTimers.delete(threadId);
      // Fold any stream chunks that have not been committed yet.
      get().flushThreadTimelineCoalesce?.(threadId);
      const runtime = get().threadRuntimeById[threadId] || emptyThreadRuntime();
      const thread = get().threadsById[threadId];
      if (!thread) return;
      set((state) => ({
        threadsById: {
          ...state.threadsById,
          [threadId]: {
            ...state.threadsById[threadId],
            timeline: runtime.timeline.slice(-TIMELINE_MAX),
            updatedAt: new Date().toISOString(),
          },
        },
      }));
      await get().persistProductState();
    }, delay);
    threadTimelinePersistTimers.set(threadId, timer);
  },

  scheduleThreadDraftPersist(threadId) {
    if (!threadId) return;
    const existing = threadDraftPersistTimers.get(threadId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(async () => {
      // M-st5: same owner-check as scheduleThreadTimelinePersist.
      if (threadDraftPersistTimers.get(threadId) !== timer) return;
      threadDraftPersistTimers.delete(threadId);
      if (!get().threadsById[threadId]) return;
      await get().persistProductState();
    }, DRAFT_PERSIST_MS);
    threadDraftPersistTimers.set(threadId, timer);
  },

  async persistProductState(options = {}) {
    const saveProductState = window.electronAPI?.saveProductState;
    if (!saveProductState) return false;
    const silent = options?.silent === true;
    if (!silent) persistReportErrors = true;

    // Coalesce: if a save is already queued or running, remember the state
    // changed again and ride the tail of the chain; the tail performs one final
    // save with the freshest state so no update is dropped.
    if (persistCoalesceBusy) {
      persistCoalesceDirty = true;
      return persistCoalesceTail;
    }
    persistCoalesceBusy = true;

    const runSave = async () => {
      try {
        const state = get();
        // 未 hydrate 或空项目时不要落盘，避免退出/热杀时把真实项目列表写成空。
        if (!state.productStateLoaded) return false;
        const snapshot = productStateSnapshot(state);
        const projectCount = Object.keys(snapshot.projectsById || {}).length;
        if (projectCount === 0 && Object.keys(state.projectsById || {}).length === 0) {
          // 允许用户真的删光项目后保存；但若从未加载过则上面已拦。
        }
        const result = await saveProductState(snapshot);
        if (!result?.ok) throw new Error(result?.error || '项目状态保存未完成');
        return true;
      } catch (error) {
        if (persistReportErrors) set({ error: `保存项目状态失败: ${error.message}` });
        return false;
      }
    };

    const operation = getProductStateSaveChain()
      .catch(() => false)
      .then(async () => {
        // Save unconditionally, then drain requests that arrived while this save
        // was in flight. flushProductStateSync clears pre-flush dirty work; a
        // dirty flag observed here therefore always represents a newer request.
        let saved = await runSave();
        while (persistCoalesceDirty) {
          persistCoalesceDirty = false;
          saved = await runSave();
        }
        return saved;
      })
      .finally(() => {
        persistCoalesceBusy = false;
        persistReportErrors = false;
      });
    setProductStateSaveChain(operation);
    persistCoalesceTail = operation;
    return operation;
  },

  flushProductStateSync() {
    const saveSync = window.electronAPI?.saveProductStateSync;
    if (!saveSync) return false;
    if (!get().productStateLoaded) return false;

    // Commit coalesced stream chunks before snapshotting timelines to disk.
    get().flushThreadTimelineCoalesce?.();
    // Fold pending (unflushed) terminal output chunks into the panes first.
    get().flushPendingPaneOutputs?.();

    const pendingThreadIds = Array.from(threadTimelinePersistTimers.keys());
    for (const timer of threadTimelinePersistTimers.values()) clearTimeout(timer);
    threadTimelinePersistTimers.clear();

    for (const timer of threadDraftPersistTimers.values()) clearTimeout(timer);
    threadDraftPersistTimers.clear();

    const pendingTerminalStates = Array.from(terminalStatePersistTimers.entries());
    for (const [, pending] of pendingTerminalStates) clearTimeout(pending?.timer || pending);
    terminalStatePersistTimers.clear();

    const pendingWorkspaceStates = Array.from(workspaceStatePersistTimers.entries());
    for (const [, pending] of pendingWorkspaceStates) clearTimeout(pending?.timer || pending);
    workspaceStatePersistTimers.clear();

    if (pendingThreadIds.length || pendingTerminalStates.length || pendingWorkspaceStates.length) {
      set((state) => {
        const threadsById = { ...state.threadsById };
        const projectsById = { ...state.projectsById };
        const now = new Date().toISOString();

        for (const threadId of pendingThreadIds) {
          const thread = threadsById[threadId];
          if (!thread) continue;
          const runtime = state.threadRuntimeById[threadId] || emptyThreadRuntime();
          threadsById[threadId] = {
            ...thread,
            timeline: runtime.timeline.slice(-TIMELINE_MAX),
            updatedAt: now,
          };
        }

        const activeTerminalProjectId = state.activeProjectId;
        if (activeTerminalProjectId && pendingTerminalStates.some(([projectId]) => projectId === activeTerminalProjectId)) {
          const project = projectsById[activeTerminalProjectId];
          if (project) {
            const terminalState = terminalStateSnapshot(
              activeTerminalProjectId,
              state.terminalPanes,
              state.activePaneId,
            );
            projectsById[activeTerminalProjectId] = {
              ...project,
              preferences: {
                ...(project.preferences || {}),
                terminalState: {
                  activePaneId: terminalState.activePaneId,
                  panes: terminalState.panes,
                },
              },
              updatedAt: now,
            };
          }
        }

        for (const [projectId, pending] of pendingWorkspaceStates) {
          const project = projectsById[projectId];
          const snapshot = pending?.snapshot;
          if (!project || !snapshot) continue;
          projectsById[projectId] = {
            ...project,
            preferences: { ...(project.preferences || {}), workspaceState: snapshot },
            updatedAt: now,
          };
        }

        return { threadsById, projectsById };
      });
    }

    try {
      const result = saveSync(productStateSnapshot(get()));
      if (!result?.ok) {
        set({ error: `退出前保存项目状态失败: ${result?.error || '未知错误'}` });
        return false;
      }
      persistCoalesceDirty = false;
      return true;
    } catch (error) {
      set({ error: `退出前保存项目状态失败: ${error.message}` });
      return false;
    }
  },

  async hydrateProductState() {
    let loaded = emptyProductState();
    try {
      if (window.electronAPI?.loadProductState) {
        loaded = normalizeProductState(await window.electronAPI.loadProductState());
      }
    } catch (error) {
      set({ error: `加载项目状态失败: ${error.message}` });
    }

    let legacyWorkspace = null;
    if (loaded.projectOrder.length === 0) {
      try {
        legacyWorkspace = localStorage.getItem('codebuddy-gui-workspace');
      } catch (_) {}
      if (legacyWorkspace) {
        const project = createProjectRecord(legacyWorkspace);
        const thread = createThreadRecord(project.id);
        loaded = {
          ...emptyProductState(),
          projectsById: { [project.id]: project },
          projectOrder: [project.id],
          threadsById: { [thread.id]: thread },
          threadOrderByProject: { [project.id]: [thread.id] },
          activeProjectId: project.id,
          activeThreadId: thread.id,
        };
      }
    }

    const project = activeProject(loaded);
    const thread = activeThread(loaded);
    const restoredProjects = Object.fromEntries(
      Object.entries(loaded.projectsById).map(([id, item]) => {
        const terminalState = terminalStateFromProject(item, true);
        return [
          id,
          {
            ...item,
            preferences: {
              ...(item.preferences || {}),
              terminalState,
            },
            runtimeStatus: 'idle',
            runtimePort: null,
            runtimePid: null,
            runtimeError: null,
            runtimeStartedAt: null,
          },
        ];
      }),
    );
    const restoredThreadRuntime = Object.fromEntries(
      Object.entries(loaded.threadsById).map(([id, item]) => [
        id,
        {
          ...emptyThreadRuntime(),
          timeline: Array.isArray(item.timeline) ? item.timeline : [],
          promptQueue: serializePromptQueue(item.metadata?.promptQueue),
          currentModel: item.modelId || null,
          currentMode: item.modeId || 'default',
        },
      ]),
    );
    // M-st7: a snapshot taken mid-prompt restores a thread whose status is still
    // 'running'/'cancelling'/'waiting' even though the runtime is gone (process
    // restart / crash). Normalize those to 'idle' so the UI does not show a
    // phantom running thread with no live runtime to cancel; sendPrompt's
    // self-heal handles genuine resume. promptQueue is preserved so a queued
    // turn the user intended to send still drains on next send.
    const restoredThreads = Object.fromEntries(
      Object.entries(loaded.threadsById).map(([id, item]) => {
        const status = item?.status;
        const needsReset = status === 'running' || status === 'cancelling' || status === 'waiting';
        return [id, needsReset ? { ...item, status: 'idle' } : item];
      }),
    );
    const restoredTerminal = terminalStateFromProject(restoredProjects[project?.id], true);
    // Root `timeline` must mirror the active thread immediately on hydrate.
    // Leaving it as the initial `[]` hides user bubbles until initializeActiveThread
    // finishes (and stays empty if connect fails).
    const activeRuntimeTimeline = thread
      ? restoredThreadRuntime[thread.id]?.timeline || thread.timeline || []
      : [];
    set({
      projectsById: restoredProjects,
      projectOrder: loaded.projectOrder,
      threadsById: restoredThreads,
      threadOrderByProject: loaded.threadOrderByProject,
      activeProjectId: loaded.activeProjectId,
      activeThreadId: loaded.activeThreadId,
      threadRuntimeById: restoredThreadRuntime,
      terminalPanes: restoredTerminal.panes,
      activePaneId: restoredTerminal.activePaneId,
      workspacePath: project?.workspacePath || null,
      fileCwd: project?.workspacePath || '.',
      sessionId: thread?.sessionId || null,
      sessionTitle: thread?.title || null,
      timeline: Array.isArray(activeRuntimeTimeline) ? activeRuntimeTimeline : [],
      guiSettings: normalizeGuiSettings(loaded.guiSettings || get().guiSettings),
      currentModel: thread?.modelId || null,
      currentMode: thread?.modeId || 'default',
      productStateLoaded: true,
    });

    if (legacyWorkspace && window.electronAPI?.saveProductState) {
      await get().persistProductState();
    } else if (loaded.projectOrder.length > 0) {
      await get().persistProductState();
    }
  },

  };
}
