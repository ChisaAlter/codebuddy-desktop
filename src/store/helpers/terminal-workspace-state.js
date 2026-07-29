function newPaneId() {
  // L1: pane id is the persistent identity used in activePaneId matching; derive
  // from crypto.randomUUID (renderer always has it) instead of Math.random.
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `pane-${uuid}`;
  const c = globalThis.crypto;
  if (c?.getRandomValues) {
    const buf = new Uint8Array(8);
    c.getRandomValues(buf);
    return `pane-${Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
  return `pane-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function makePane(title = 'Terminal') {
  return {
    id: newPaneId(),
    title,
    status: 'idle',
    sessionId: null,
    // Last known shell cwd for this pane. Reused when recreating the PTY after
    // close/reconnect/app restart so "cd" survives session teardown.
    cwd: null,
    output: '',
    split: 'single',
  };
}

function normalizePaneCwd(value) {
  const cwd = typeof value === 'string' ? value.trim() : '';
  return cwd || null;
}

export function terminalStateFromProject(project, resetSessions = false) {
  const saved = project?.preferences?.terminalState;
  const panes =
    Array.isArray(saved?.panes) && saved.panes.length
      ? saved.panes.map((pane) => ({
          ...makePane(pane.title || 'Terminal'),
          ...pane,
          output: String(pane.output || '').slice(-200000),
          // Always keep cwd across runtime resets — only live sessionId is dropped.
          cwd: normalizePaneCwd(pane.cwd),
          sessionId: resetSessions ? null : pane.sessionId || null,
          status: resetSessions ? 'idle' : pane.status || 'idle',
        }))
      : [makePane()];
  const activePaneId = panes.some((pane) => pane.id === saved?.activePaneId) ? saved.activePaneId : panes[0].id;
  return { panes, activePaneId };
}

export function workspaceStateFromProject(project) {
  const saved = project?.preferences?.workspaceState || {};
  const selectedFile = typeof saved.selectedFile === 'string' && saved.selectedFile ? saved.selectedFile : null;
  const fileDirty = Boolean(selectedFile && saved.fileDirty && typeof saved.filePreview === 'string');
  return {
    fileCwd: typeof saved.fileCwd === 'string' && saved.fileCwd ? saved.fileCwd : project?.workspacePath || '.',
    selectedFile,
    filePreview: fileDirty ? saved.filePreview : '',
    fileSavedContent: fileDirty && typeof saved.fileSavedContent === 'string' ? saved.fileSavedContent : '',
    fileDirty,
    updatedAt: saved.updatedAt || null,
  };
}

export function workspaceStateSnapshot(state, projectId, discardDirty = false) {
  const project = state.projectsById?.[projectId];
  const selectedFile = state.activeProjectId === projectId ? state.selectedFile : null;
  const fileDirty = !discardDirty && Boolean(selectedFile && state.fileDirty);
  return {
    fileCwd:
      state.activeProjectId === projectId
        ? state.fileCwd || project?.workspacePath || '.'
        : project?.workspacePath || '.',
    selectedFile: selectedFile || null,
    fileDirty,
    filePreview: fileDirty ? String(state.filePreview || '') : '',
    fileSavedContent: fileDirty ? String(state.fileSavedContent || '') : '',
    updatedAt: new Date().toISOString(),
  };
}

export function resetProjectRuntimeViews() {
  return {
    info: null,
    infoLoaded: false,
    settings: null,
    settingsLoaded: false,
    sessions: [],
    workers: [],
    workersError: null,
    plugins: [],
    marketplaces: [],
    pluginError: null,
    marketplaceError: null,
    pluginBusy: null,
    workspaceExtraDirs: [],
    workspaceDirsBusy: false,
    workspaceDirsError: null,
    metrics: null,
    metricsError: null,
    stats: null,
    statsError: null,
    statsLoading: false,
    sessionStats: null,
    scheduledTasks: [],
    scheduledTasksError: null,
    taskTemplates: [],
    taskTemplatesError: null,
    taskTemplatesLoading: false,
    traces: [],
  };
}
