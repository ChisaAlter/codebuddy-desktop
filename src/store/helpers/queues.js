export function createQueueHelpers({
  runtimeOperationChains,
  sessionSettingChains,
  threadMutationChains,
  sessionActionOperations,
  promptQueueOperationChains,
  scopedRequestVersions,
  getProjectNavigationVersion,
  incrementProjectNavigationVersion,
}) {
  function beginProjectNavigation(set, targetId) {
    const token = { version: incrementProjectNavigationVersion(), targetId };
    set({ projectNavigationBusy: true, projectNavigationTargetId: targetId, projectNavigationError: null, error: null });
    return token;
  }

  function isProjectNavigationCurrent(token) {
    return token.version === getProjectNavigationVersion();
  }

  function finishProjectNavigation(set, token, error = null) {
    if (!isProjectNavigationCurrent(token)) return;
    set({
      projectNavigationBusy: false,
      projectNavigationTargetId: null,
      projectNavigationError: error,
    });
  }

  function isProjectMutationNavigation(state) {
    return Boolean(
      state.projectNavigationBusy && String(state.projectNavigationTargetId || '').startsWith('project-action:'),
    );
  }

  function beginScopedRequest(key, state, scope = 'project') {
    const version = (scopedRequestVersions.get(key) || 0) + 1;
    scopedRequestVersions.set(key, version);
    return {
      key,
      version,
      scope,
      projectId: state.activeProjectId,
      threadId: state.activeThreadId,
      sessionId: state.sessionId,
    };
  }

  function isScopedRequestCurrent(token, state) {
    if (scopedRequestVersions.get(token.key) !== token.version) return false;
    if (token.projectId !== state.activeProjectId) return false;
    if (token.scope === 'threadId' || token.scope === 'thread') {
      if (token.threadId !== state.activeThreadId) return false;
    }

    if (token.scope === 'thread' && token.sessionId !== state.sessionId) return false;
    return true;
  }

  function queueProjectRuntimeOperation(projectId, operation) {
    if (!projectId) return Promise.resolve(null);
    const previous = runtimeOperationChains.get(projectId) || Promise.resolve();
    const next = previous.catch(() => null).then(operation);
    const tracked = next.finally(() => {
      if (runtimeOperationChains.get(projectId) === tracked) runtimeOperationChains.delete(projectId);
    });
    runtimeOperationChains.set(projectId, tracked);
    return tracked;
  }

  function queueSessionSettingOperation(key, operation) {
    const previous = sessionSettingChains.get(key) || Promise.resolve();
    const next = previous.catch(() => false).then(operation);
    const tracked = next.finally(() => {
      if (sessionSettingChains.get(key) === tracked) sessionSettingChains.delete(key);
    });
    sessionSettingChains.set(key, tracked);
    return tracked;
  }

  function queueThreadMutation(threadId, operation) {
    const previous = threadMutationChains.get(threadId) || Promise.resolve();
    const next = previous.catch(() => false).then(operation);
    const tracked = next.finally(() => {
      if (threadMutationChains.get(threadId) === tracked) threadMutationChains.delete(threadId);
    });
    threadMutationChains.set(threadId, tracked);
    return tracked;
  }

  function runUniqueSessionAction(key, operation) {
    const existing = sessionActionOperations.get(key);
    if (existing) return existing;
    const tracked = Promise.resolve()
      .then(operation)
      .finally(() => {
        if (sessionActionOperations.get(key) === tracked) sessionActionOperations.delete(key);
      });
    // M-st4: attach a no-op catch so a rejected unique action does not surface as
    // an unhandledRejection warning when the original caller has already detached
    // (e.g. a double-clicked cancel whose first call rejected). The first caller
    // still receives the rejection via the returned `tracked` promise; this shadow
    // only swallows the global unhandled-rejection report.
    tracked.catch(() => {});
    sessionActionOperations.set(key, tracked);
    return tracked;
  }

  function queuePromptQueueOperation(threadId, operation) {
    const previous = promptQueueOperationChains.get(threadId) || Promise.resolve();
    const next = previous.catch(() => false).then(operation);
    const tracked = next.finally(() => {
      if (promptQueueOperationChains.get(threadId) === tracked) promptQueueOperationChains.delete(threadId);
    });
    promptQueueOperationChains.set(threadId, tracked);
    return tracked;
  }

  return {
    beginProjectNavigation,
    isProjectNavigationCurrent,
    finishProjectNavigation,
    isProjectMutationNavigation,
    beginScopedRequest,
    isScopedRequestCurrent,
    queueProjectRuntimeOperation,
    queueSessionSettingOperation,
    queueThreadMutation,
    runUniqueSessionAction,
    queuePromptQueueOperation,
  };
}
