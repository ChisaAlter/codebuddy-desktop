function failureResult(error, code = 'WRITE_FAILED') {
  return {
    ok: false,
    code,
    error: error?.message || String(error || 'Unknown product-state save error'),
  };
}

function normalizeResult(result) {
  if (result && typeof result === 'object' && typeof result.ok === 'boolean') return result;
  return failureResult(new Error('Product-state store returned an invalid result'), 'INVALID_RESULT');
}

function createProductStateSaveController(options = {}) {
  const store = options.store;
  const delayMs = Number.isFinite(options.delayMs) ? options.delayMs : 800;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const logger = options.logger || (() => {});
  let chain = Promise.resolve(null);
  let pendingWindow = null;

  function runAsyncSave(snapshot) {
    const operation = chain
      .catch(() => null)
      .then(async () => {
        try {
          return normalizeResult(await store.save(snapshot));
        } catch (error) {
          logger(`Product state save failed: ${error.message}`);
          return failureResult(error);
        }
      });
    chain = operation;
    return operation;
  }

  function dispatchWindow(window) {
    if (pendingWindow !== window) return;
    pendingWindow = null;
    window.timer = null;
    runAsyncSave(window.snapshot).then(window.resolve);
  }

  return {
    request(snapshot) {
      if (pendingWindow) {
        pendingWindow.snapshot = snapshot;
        return pendingWindow.promise;
      }
      const window = { snapshot, timer: null, resolve: null, promise: null };
      window.promise = new Promise((resolve) => {
        window.resolve = resolve;
      });
      window.timer = setTimer(() => dispatchWindow(window), delayMs);
      pendingWindow = window;
      return window.promise;
    },

    saveSync(snapshot) {
      const window = pendingWindow;
      if (window) {
        pendingWindow = null;
        if (window.timer !== null) clearTimer(window.timer);
        window.timer = null;
      }
      let result;
      try {
        result = normalizeResult(store.saveSync(snapshot));
      } catch (error) {
        logger(`Synchronous product state save failed: ${error.message}`);
        result = failureResult(error);
      }
      if (window) {
        window.resolve(
          result.ok
            ? { ...result, disposition: 'superseded', supersededWindow: true }
            : result,
        );
      }
      return result;
    },
  };
}

module.exports = { createProductStateSaveController };
