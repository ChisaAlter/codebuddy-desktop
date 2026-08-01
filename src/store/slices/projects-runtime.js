import {
  activeProject,
  activeThread,
  createProjectRecord,
  createThreadRecord,
} from '../../lib/product-state';
import { closeAssistantStream } from '../../lib/timeline';
import { visibleProjectThreads } from '../../lib/session-sidebar';
import { setAcpSessionToken, setAuthToken } from '../../lib/acp';
import { emptyThreadRuntime } from '../helpers/thread-runtime';
import {
  terminalStateFromProject,
  resetProjectRuntimeViews,
} from '../helpers/terminal-workspace-state';

/**
 * Project CRUD, workspace switch, and CodeBuddy runtime lifecycle.
 */
export function createProjectsRuntimeSlice(set, get, ctx) {
  const {
    conversations,
    connectActiveProjectRuntime,
    beginProjectNavigation,
    isProjectNavigationCurrent,
    finishProjectNavigation,
    isProjectMutationNavigation,
    queueProjectRuntimeOperation,
    requestDirtyFileConfirmation,
    resetFileWorkspace,
  } = ctx;

  return {
  // 切工作区：经 IPC 弹目录选择框 → set workspacePath + 持久化 → 用新 cwd 起新会话 + 重定向文件树根
  // cwd 一次性注入到 session/new，agent 工具调用就以此目录为工作根；不动后端进程
  // ⚠ 注意：CLI 协议 cwd 只在 session/new|load 一次性注入，运行中改不了 cwd。
  //   所以切工作区 = 起新会话（旧 sessionId + timeline 丢），UI 要明告知用户。
  async chooseWorkspace(options = {}) {
    if (!window.electronAPI?.chooseWorkspace) {
      set({ error: '工作区选择不可用（IPC 缺失）' });
      return false;
    }
    let path = null;
    try {
      path = await window.electronAPI.chooseWorkspace();
    } catch (err) {
      set({ error: '工作区选择失败: ' + err.message });
      return false;
    }
    if (!path) return null; // 用户取消
    return get().setWorkspace(path, options);
  },

  async setWorkspace(path, options = {}) {
    if (!path) return false;
    if (isProjectMutationNavigation(get())) return false;
    const normalizedPath = String(path);
    const navigation = beginProjectNavigation(set, `workspace:${normalizedPath}`);
    try {
      const currentProject = activeProject(get());
      if (currentProject?.workspacePath?.toLowerCase() === normalizedPath.toLowerCase()) return true;
      if (currentProject?.workspacePath?.toLowerCase() !== normalizedPath.toLowerCase()) {
        const confirmed = await requestDirtyFileConfirmation(set, get, '切换工作区');
        if (!isProjectNavigationCurrent(navigation) || !confirmed) return false;
      }
      await get().persistActiveProjectWorkspaceState({ discardDirty: true });
      if (!isProjectNavigationCurrent(navigation)) return false;
      await get().persistActiveProjectTerminalState();
      if (!isProjectNavigationCurrent(navigation)) return false;
      let project = Object.values(get().projectsById).find(
        (item) => item.workspacePath.toLowerCase() === normalizedPath.toLowerCase(),
      );
      let thread = project ? visibleProjectThreads(project.id, get().threadOrderByProject, get().threadsById)[0] : null;
      if (!project) project = createProjectRecord(normalizedPath);
      if (!thread) thread = createThreadRecord(project.id);
      const projectChanged = currentProject?.id !== project.id;

      set((state) => ({
        projectsById: {
          ...state.projectsById,
          [project.id]: { ...project, lastOpenedAt: new Date().toISOString() },
        },
        projectOrder: state.projectOrder.includes(project.id)
          ? state.projectOrder
          : [...state.projectOrder, project.id],
        threadsById: { ...state.threadsById, [thread.id]: thread },
        threadOrderByProject: {
          ...state.threadOrderByProject,
          [project.id]: state.threadOrderByProject[project.id]?.includes(thread.id)
            ? state.threadOrderByProject[project.id]
            : [...(state.threadOrderByProject[project.id] || []), thread.id],
        },
        activeProjectId: project.id,
        activeThreadId: thread.id,
        workspacePath: normalizedPath,
        ...(projectChanged ? resetProjectRuntimeViews() : {}),
        ...resetFileWorkspace(normalizedPath),
      }));
      get().loadProjectTerminalState(project.id);
      try {
        localStorage.removeItem('codebuddy-gui-workspace');
      } catch (_) {}
      const persisted = await get().persistProductState();
      if (!isProjectNavigationCurrent(navigation)) return false;
      if (!persisted) throw new Error(get().error || '保存项目状态失败');
      const runtime = await get().ensureProjectRuntime(project.id);
      if (!isProjectNavigationCurrent(navigation)) return false;
      if (!runtime) throw new Error(get().error || '项目运行时启动失败');
      if (options.deferInitializationUntilAuth) return true;
      const opened = await get().initializeWorkspace();
      if (!isProjectNavigationCurrent(navigation)) return false;
      if (!opened) throw new Error(get().error || '恢复工作区失败');
      const initialized = await get().initializeActiveThread(thread.sessionId);
      if (!isProjectNavigationCurrent(navigation)) return false;
      if (!initialized) throw new Error(get().error || '会话连接失败');
      if (projectChanged) await get().refreshProjectViews();
      else await Promise.allSettled([get().refreshStats(), get().refreshTasks(), get().refreshSessions()]);
      return true;
    } catch (error) {
      if (isProjectNavigationCurrent(navigation)) {
        const message = error?.message || '切换工作区失败';
        set({ error: message });
        finishProjectNavigation(set, navigation, message);
      }
      return false;
    } finally {
      finishProjectNavigation(set, navigation, get().projectNavigationError);
    }
  },

  async activateProject(projectId, options = {}) {
    if (isProjectMutationNavigation(get())) return false;
    const project = get().projectsById[projectId];
    if (!project || projectId === get().activeProjectId) return Boolean(project);
    const navigation = beginProjectNavigation(set, `project:${projectId}`);
    try {
      const confirmed = await requestDirtyFileConfirmation(set, get, '切换项目');
      if (!isProjectNavigationCurrent(navigation) || !confirmed) return false;
      await get().persistActiveProjectWorkspaceState({ discardDirty: true });
      if (!isProjectNavigationCurrent(navigation)) return false;
      await get().persistActiveProjectTerminalState();
      if (!isProjectNavigationCurrent(navigation)) return false;
      // preferNewThread: sidebar project "+" always opens a blank chat under B,
      // instead of resuming B's first existing session (activate/switch behavior).
      let thread = null;
      let threadId = null;
      if (options.preferNewThread) {
        thread = createThreadRecord(projectId);
        threadId = thread.id;
        set((state) => ({
          threadsById: { ...state.threadsById, [thread.id]: thread },
          threadOrderByProject: {
            ...state.threadOrderByProject,
            [projectId]: [thread.id, ...(state.threadOrderByProject[projectId] || [])],
          },
        }));
      } else {
        thread = visibleProjectThreads(projectId, get().threadOrderByProject, get().threadsById)[0] || null;
        threadId = thread?.id || null;
        if (!thread) {
          thread = createThreadRecord(projectId);
          threadId = thread.id;
          set((state) => ({
            threadsById: { ...state.threadsById, [thread.id]: thread },
            threadOrderByProject: {
              ...state.threadOrderByProject,
              [projectId]: [...(state.threadOrderByProject[projectId] || []), thread.id],
            },
          }));
        }
      }
      set({
        activeProjectId: projectId,
        activeThreadId: threadId,
        workspacePath: project.workspacePath,
        ...resetProjectRuntimeViews(),
        ...resetFileWorkspace(project.workspacePath),
      });
      get().loadProjectTerminalState(projectId);
      const persisted = await get().persistProductState();
      if (!isProjectNavigationCurrent(navigation)) return false;
      if (!persisted) throw new Error(get().error || '保存项目状态失败');
      const runtime = await get().ensureProjectRuntime(projectId);
      if (!isProjectNavigationCurrent(navigation)) return false;
      if (!runtime) throw new Error(get().error || '项目运行时启动失败');
      if (options.deferInitializationUntilAuth) return true;
      const opened = await get().initializeWorkspace();
      if (!isProjectNavigationCurrent(navigation)) return false;
      if (!opened) throw new Error(get().error || '恢复项目工作区失败');
      const initialized = await get().initializeActiveThread(thread.sessionId);
      if (!isProjectNavigationCurrent(navigation)) return false;
      if (!initialized) throw new Error(get().error || '会话连接失败');
      await get().refreshProjectViews();
      return true;
    } catch (error) {
      if (isProjectNavigationCurrent(navigation)) {
        const message = error?.message || '切换项目失败';
        set({ error: message });
        finishProjectNavigation(set, navigation, message);
      }
      return false;
    } finally {
      finishProjectNavigation(set, navigation, get().projectNavigationError);
    }
  },

  async renameProject(projectId, name) {
    if (get().projectNavigationBusy) return false;
    const project = get().projectsById[projectId];
    const nextName = String(name || '').trim();
    if (!project || !nextName) return false;
    const navigation = beginProjectNavigation(set, `project-action:rename:${projectId}`);
    try {
      set((state) => ({
        projectsById: {
          ...state.projectsById,
          [projectId]: { ...state.projectsById[projectId], name: nextName, updatedAt: new Date().toISOString() },
        },
      }));
      const persisted = await get().persistProductState();
      if (!isProjectNavigationCurrent(navigation)) return false;
      if (!persisted) {
        set((state) => {
          const current = state.projectsById[projectId];
          if (!current || current.name !== nextName) return {};
          return {
            projectsById: {
              ...state.projectsById,
              [projectId]: { ...current, name: project.name, updatedAt: project.updatedAt },
            },
          };
        });
        throw new Error(get().error || '重命名项目失败');
      }
      return true;
    } catch (error) {
      if (isProjectNavigationCurrent(navigation)) {
        const message = error?.message || '重命名项目失败';
        set({ error: message });
        finishProjectNavigation(set, navigation, message);
      }
      return false;
    } finally {
      finishProjectNavigation(set, navigation, get().projectNavigationError);
    }
  },

  async removeProject(projectId, options = {}) {
    if (get().projectNavigationBusy) return false;
    const initialState = get();
    const project = initialState.projectsById[projectId];
    if (!project) return false;
    const wasActive = initialState.activeProjectId === projectId;
    const navigation = beginProjectNavigation(set, `project-action:remove:${projectId}`);
    let removalPersisted = false;
    try {
      if (wasActive && !options.skipDirtyCheck) {
        const confirmed = await requestDirtyFileConfirmation(set, get, '移除当前项目');
        if (!isProjectNavigationCurrent(navigation) || !confirmed) return false;
      }
      const previousState = get();
      const threadIds = [...(previousState.threadOrderByProject[projectId] || [])];
      // Drop pending coalesced stream chunks for every thread in this project
      // before tearing down their runtime entries. Otherwise a hidden-window
      // coalesce timer could fire post-deletion and patchThreadRuntime would
      // resurrect zombie threadRuntimeById entries (memory leak + stale writes).
      for (const tid of threadIds) get().flushThreadTimelineCoalesce(tid);
      await get()
        .stopProjectRuntime(projectId)
        .catch(() => false);
      if (!isProjectNavigationCurrent(navigation)) return false;
      if (!get().projectsById[projectId]) return false;

      let nextProjectId = null;
      let nextThread = null;
      if (wasActive) {
        nextProjectId =
          previousState.projectOrder.find((id) => id !== projectId && previousState.projectsById[id]) || null;
        nextThread = nextProjectId
          ? visibleProjectThreads(nextProjectId, previousState.threadOrderByProject, previousState.threadsById)[0]
          : null;
        if (nextProjectId && !nextThread) nextThread = createThreadRecord(nextProjectId);
      }

      set((state) => {
        const projectsById = { ...state.projectsById };
        const threadsById = { ...state.threadsById };
        const threadRuntimeById = { ...state.threadRuntimeById };
        const threadOrderByProject = { ...state.threadOrderByProject };
        delete projectsById[projectId];
        delete threadOrderByProject[projectId];
        for (const threadId of threadIds) {
          delete threadsById[threadId];
          delete threadRuntimeById[threadId];
        }
        if (nextThread) {
          threadsById[nextThread.id] = nextThread;
          threadOrderByProject[nextProjectId] = [
            nextThread.id,
            ...(threadOrderByProject[nextProjectId] || []).filter((id) => id !== nextThread.id),
          ];
        }
        return {
          projectsById,
          projectOrder: state.projectOrder.filter((id) => id !== projectId),
          threadsById,
          threadRuntimeById,
          threadOrderByProject,
          activeProjectId: wasActive ? nextProjectId : state.activeProjectId,
          activeThreadId: wasActive ? nextThread?.id || null : state.activeThreadId,
          workspacePath: wasActive ? projectsById[nextProjectId]?.workspacePath || null : state.workspacePath,
          ...(wasActive ? resetProjectRuntimeViews() : {}),
          ...(wasActive ? resetFileWorkspace(projectsById[nextProjectId]?.workspacePath || '.') : {}),
        };
      });
      if (wasActive) {
        get().loadProjectTerminalState(nextProjectId);
        get().activateThreadRuntime(nextThread?.id || null);
      }

      const persisted = await get().persistProductState();
      if (!isProjectNavigationCurrent(navigation)) return false;
      if (!persisted) {
        const persistenceError = get().error;
        set({ ...previousState, error: persistenceError });
        if (wasActive || project.runtimeStatus === 'running') {
          const runtime = await get()
            .ensureProjectRuntime(projectId)
            .catch(() => null);
          if (runtime && wasActive) {
            const previousThread = previousState.threadsById[previousState.activeThreadId];
            await get()
              .initializeActiveThread(previousThread?.sessionId)
              .catch(() => false);
          }
        }
        throw new Error(persistenceError || '移除项目失败');
      }
      removalPersisted = true;

      if (wasActive && nextProjectId && nextThread) {
        const nextProject = get().projectsById[nextProjectId];
        const runtime = await get().ensureProjectRuntime(nextProjectId);
        if (!isProjectNavigationCurrent(navigation)) return true;
        if (!runtime || !nextProject) throw new Error(get().error || '替代项目运行时启动失败');
        const opened = await get().initializeWorkspace();
        if (!isProjectNavigationCurrent(navigation)) return true;
        if (!opened) throw new Error(get().error || '替代项目工作区恢复失败');
        const initialized = await get().initializeActiveThread(nextThread.sessionId);
        if (!isProjectNavigationCurrent(navigation)) return true;
        if (!initialized) throw new Error(get().error || '替代项目会话连接失败');
        await get().refreshProjectViews();
      } else if (wasActive) {
        set({ sessionId: null, sessionTitle: null, connectionState: 'disconnected', ...resetProjectRuntimeViews() });
        get().activateThreadRuntime(null);
      }
      return true;
    } catch (error) {
      if (isProjectNavigationCurrent(navigation)) {
        const detail = error?.message || '移除项目失败';
        const message = removalPersisted ? `项目已移除，但${detail}` : detail;
        set({ error: message });
        finishProjectNavigation(set, navigation, message);
      }
      return removalPersisted;
    } finally {
      finishProjectNavigation(set, navigation, get().projectNavigationError);
    }
  },

  applyProjectRuntimeStatus(runtime) {
    if (!runtime?.projectId) return;
    let terminalStateReset = false;
    set((state) => {
      const project = state.projectsById[runtime.projectId];
      if (!project) return {};
      const runtimeStatus = runtime.status || 'idle';
      const runtimeStartedAt = runtime.startedAt || (runtimeStatus === 'starting' ? project.runtimeStartedAt : null);
      const runtimeChanged =
        runtimeStatus === 'running' && Boolean(runtimeStartedAt) && runtimeStartedAt !== project.runtimeStartedAt;
      const runtimeUnavailable = ['stopped', 'error'].includes(runtimeStatus);
      const currentTerminalState = terminalStateFromProject(project, false);
      const hasTerminalSessions =
        currentTerminalState.panes.some((pane) => pane.sessionId) ||
        (state.activeProjectId === runtime.projectId && state.terminalPanes.some((pane) => pane.sessionId));
      const resetTerminalSessions = (runtimeChanged || runtimeUnavailable) && hasTerminalSessions;
      terminalStateReset = resetTerminalSessions;
      const terminalState = resetTerminalSessions ? terminalStateFromProject(project, true) : currentTerminalState;
      const nextProject = {
        ...project,
        runtimeStatus,
        runtimePort: runtime.port || null,
        runtimePid: runtime.pid || null,
        runtimeStartedAt,
        runtimeError: runtime.error || null,
        ...(resetTerminalSessions
          ? {
              preferences: {
                ...(project.preferences || {}),
                terminalState: {
                  activePaneId: terminalState.activePaneId,
                  panes: terminalState.panes,
                },
              },
            }
          : {}),
      };
      return {
        projectsById: { ...state.projectsById, [runtime.projectId]: nextProject },
        ...(resetTerminalSessions && state.activeProjectId === runtime.projectId
          ? {
              terminalPanes: terminalState.panes,
              activePaneId: terminalState.activePaneId,
              terminalSessions: [],
              ptySessionId: null,
            }
          : {}),
      };
    });
    const runtimeUnavailable = ['stopped', 'error'].includes(runtime.status || '');
    if (runtimeUnavailable) {
      // P1-2: runtime is gone (crash/stop) — pending permission/question requests
      // expire, but the threads are marked disconnected, not error.
      conversations.disposeProject(get().threadOrderByProject[runtime.projectId] || [], 'runtime-lost');
      if (get().activeProjectId === runtime.projectId) {
        setAcpSessionToken(null);
        setAuthToken(null);
      }
      get().disconnectProjectThreads(runtime.projectId);
    } else if (terminalStateReset) {
      get().persistProductState();
    }
  },

  async disconnectProjectThreads(projectId) {
    if (!projectId) return false;
    // Fold any pending coalesced stream chunks into runtime.timeline BEFORE we
    // closeAssistantStream, so tail chunks produced while the window was hidden
    // are not lost. Without this, closeAssistantStream would finalize a timeline
    // missing the buffered tail.
    const threadIds = [...(get().threadOrderByProject[projectId] || [])];
    for (const threadId of threadIds) get().flushThreadTimelineCoalesce(threadId);
    const disconnectedAt = new Date().toISOString();
    set((state) => {
      const threadIds = state.threadOrderByProject[projectId] || [];
      const threadsById = { ...state.threadsById };
      const threadRuntimeById = { ...state.threadRuntimeById };
      for (const threadId of threadIds) {
        const record = threadsById[threadId];
        if (record) {
          const status = ['idle', 'connecting', 'running', 'waiting', 'cancelling'].includes(record.status)
            ? 'disconnected'
            : record.status;
          threadsById[threadId] = { ...record, status, updatedAt: disconnectedAt };
        }
        const runtime = threadRuntimeById[threadId] || emptyThreadRuntime();
        threadRuntimeById[threadId] = {
          ...runtime,
          connectionState: 'disconnected',
          timeline: closeAssistantStream(runtime.timeline),
          permissionRequests: [],
          questions: [],
          isAwaitingResponse: false,
          promptStartedAt: null,
          activePromptRunId: null,
          promptDispatched: false,
          promptDispatchInFlight: false,
          teamState: null,
          lastTeamState: null,
          memberHistoriesByName: {},
          subagentToolCalls: {},
          workflowState: null,
          lastWorkflowState: null,
          rawExtensionEvents: [],
          agentPhase: null,
          progress: null,
          historyReplayActive: false,
        };
      }
      return { threadsById, threadRuntimeById };
    });
    if (get().activeProjectId === projectId) get().activateThreadRuntime(get().activeThreadId);
    return get().persistProductState();
  },

  async ensureProjectRuntime(projectId = get().activeProjectId) {
    return queueProjectRuntimeOperation(projectId, async () => {
      const project = get().projectsById[projectId];
      if (!project || !window.electronAPI?.ensureProjectRuntime) return null;
      get().applyProjectRuntimeStatus({ projectId, status: 'starting' });
      try {
        // Pass GUI preference; main process resolves against on-disk OAuth domain.
        const accountLoginSite =
          get().guiSettings?.accountLoginSite === 'cn' || get().guiSettings?.accountLoginSite === 'global'
            ? get().guiSettings.accountLoginSite
            : null;
        const runtime = await window.electronAPI.ensureProjectRuntime({
          projectId,
          cwd: project.workspacePath,
          accountLoginSite,
        });
        await connectActiveProjectRuntime(set, get, projectId, runtime);
        get().applyProjectRuntimeStatus(runtime);
        return runtime;
      } catch (error) {
        const stopped = get().projectsById[projectId]?.runtimeStatus === 'stopped';
        if (/start cancelled/i.test(error.message || '') || stopped) return null;
        get().applyProjectRuntimeStatus({ projectId, status: 'error', error: error.message });
        if (projectId === get().activeProjectId) {
          set({ connectionState: 'error', error: `项目运行时启动失败: ${error.message}` });
        }
        return null;
      }
    });
  },

  async startProjectRuntime(projectId = get().activeProjectId) {
    if (projectId === get().activeProjectId) set({ error: null });
    const runtime = await get().ensureProjectRuntime(projectId);
    if (!runtime) return false;
    if (projectId !== get().activeProjectId) return runtime;
    const thread = activeThread(get());
    if (!thread || thread.projectId !== projectId) return runtime;
    const initialized = await get().initializeActiveThread(thread.sessionId);
    if (!initialized) return false;
    await get().refreshProjectViews();
    return runtime;
  },

  async stopProjectRuntime(projectId = get().activeProjectId) {
    return queueProjectRuntimeOperation(projectId, async () => {
      if (!projectId || !window.electronAPI?.stopProjectRuntime) return false;
      // P1-2: user-initiated stop — pending permission/question requests expire,
      // but the threads are marked disconnected (not error) by
      // disconnectProjectThreads below.
      await conversations.disposeProject(get().threadOrderByProject[projectId] || [], 'project-stopped');
      await get().disconnectProjectThreads(projectId);
      if (projectId === get().activeProjectId) {
        setAcpSessionToken(null);
        setAuthToken(null);
        set({ connectionState: 'disconnected' });
      }
      try {
        const runtime = await window.electronAPI.stopProjectRuntime(projectId);
        get().applyProjectRuntimeStatus(runtime || { projectId, status: 'stopped' });
        return true;
      } catch (error) {
        set((state) => {
          const project = state.projectsById[projectId];
          if (!project) return {};
          return {
            projectsById: {
              ...state.projectsById,
              [projectId]: { ...project, runtimeError: error.message || '停止运行时失败' },
            },
          };
        });
        if (projectId === get().activeProjectId) {
          set({ connectionState: 'error', error: `停止项目运行时失败: ${error.message}` });
        }
        return false;
      }
    });
  },

  async restartProjectRuntime(projectId = get().activeProjectId, options = {}) {
    return queueProjectRuntimeOperation(projectId, async () => {
      const project = get().projectsById[projectId];
      if (!project || !window.electronAPI?.restartProjectRuntime) return false;
      await conversations.disposeProject(get().threadOrderByProject[projectId] || []);
      await get().disconnectProjectThreads(projectId);
      if (projectId === get().activeProjectId) {
        setAcpSessionToken(null);
        setAuthToken(null);
      }
      try {
        const preferredSite = options.accountLoginSite || get().guiSettings?.accountLoginSite;
        const accountLoginSite =
          preferredSite === 'cn' || preferredSite === 'global' ? preferredSite : null;
        const runtime = await window.electronAPI.restartProjectRuntime({
          projectId,
          cwd: project.workspacePath,
          accountLoginSite,
        });
        get().applyProjectRuntimeStatus(runtime);
        const connected = await connectActiveProjectRuntime(set, get, projectId, runtime);
        if (connected && projectId === get().activeProjectId) {
          if (options.deferInitializationUntilAuth) return true;
          const initialized = await get().initializeActiveThread(undefined);
          if (!initialized) return false;
          await get().refreshProjectViews();
        }
        return true;
      } catch (error) {
        get().applyProjectRuntimeStatus({ projectId, status: 'error', error: error.message });
        if (projectId === get().activeProjectId) set({ error: `重启项目运行时失败: ${error.message}` });
        return false;
      }
    });
  },

  };
}
