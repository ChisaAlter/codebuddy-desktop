function createQuitRequestController(options = {}) {
  // Soft timeout: force-exit if renderer never answers at all.
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 2500;
  // Hard deadline: still force-exit if renderer acked but never confirm/cancel
  // (e.g. hung persist). Long enough for a dirty-file dialog; short enough to
  // feel snappy when the UI is wedged.
  const hardDeadlineMs = Number.isFinite(options.hardDeadlineMs) ? options.hardDeadlineMs : 6000;
  // Hold fallback: hold() disarms soft+hard timers while a user dialog is open,
  // so a renderer that crashes or hangs after the dialog could otherwise pin the
  // quit request forever (hasPending() blocks every later quit attempt). This
  // timer bounds the hold: normal dirty-file dialogs resolve far sooner; a
  // wedged renderer gets force-exited instead of deadlocking tray exit.
  const holdDeadlineMs = Number.isFinite(options.holdDeadlineMs) ? options.holdDeadlineMs : 120000;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const now = options.now || Date.now;
  const onTimeout = options.onTimeout || (() => {});
  let sequence = 0;
  let pending = null;

  function clearPending() {
    if (!pending) return null;
    const current = pending;
    pending = null;
    if (current.timer !== null) clearTimer(current.timer);
    if (current.hardTimer !== null) clearTimer(current.hardTimer);
    if (current.holdTimer !== null) clearTimer(current.holdTimer);
    return current;
  }

  function matches(requestId) {
    return Boolean(pending && requestId && pending.requestId === requestId);
  }

  function fireTimeout(requestId) {
    const current = pending;
    if (!current) return;
    pending = null;
    if (current.timer !== null) clearTimer(current.timer);
    if (current.hardTimer !== null) clearTimer(current.hardTimer);
    if (current.holdTimer !== null) clearTimer(current.holdTimer);
    onTimeout(requestId);
  }

  function armTimeout(requestId, kind) {
    return setTimer(() => {
      if (!matches(requestId)) return;
      if (kind === 'soft' && pending.timer == null) return;
      fireTimeout(requestId);
    }, kind === 'hard' ? hardDeadlineMs : timeoutMs);
  }

  function armHoldFallback(requestId) {
    return setTimer(() => {
      if (!matches(requestId)) return;
      fireTimeout(requestId);
    }, holdDeadlineMs);
  }

  return {
    begin() {
      if (pending) return { started: false, requestId: pending.requestId };
      sequence += 1;
      const requestId = `quit-${now()}-${sequence}`;
      pending = {
        requestId,
        timer: armTimeout(requestId, 'soft'),
        hardTimer: armTimeout(requestId, 'hard'),
        holdTimer: null,
      };
      return { started: true, requestId };
    },

    confirm(requestId) {
      if (!matches(requestId)) return false;
      clearPending();
      return true;
    },

    acknowledge(requestId) {
      if (!matches(requestId)) return false;
      // Soft timeout only: renderer is alive. Keep hard deadline so a hung
      // confirm path cannot pin the process for tens of seconds.
      if (pending.timer !== null) clearTimer(pending.timer);
      pending.timer = null;
      return true;
    },

    /**
     * Pause the hard deadline while the renderer waits on a user dialog
     * (dirty-file confirm). Soft timeout should already be cleared via acknowledge.
     * A fallback timer still bounds the hold so a crashed/hung renderer can never
     * leave the quit request pending forever.
     */
    hold(requestId) {
      if (!matches(requestId)) return false;
      if (pending.timer !== null) clearTimer(pending.timer);
      pending.timer = null;
      if (pending.hardTimer !== null) clearTimer(pending.hardTimer);
      pending.hardTimer = null;
      pending.holdTimer = armHoldFallback(requestId);
      return true;
    },

    /**
     * Resume a short hard deadline after a user dialog (or before persist work).
     */
    resume(requestId, resumeMs) {
      if (!matches(requestId)) return false;
      if (pending.holdTimer !== null) clearTimer(pending.holdTimer);
      pending.holdTimer = null;
      if (pending.hardTimer !== null) clearTimer(pending.hardTimer);
      const deadline = Number.isFinite(resumeMs) ? resumeMs : Math.min(hardDeadlineMs, 2500);
      pending.hardTimer = setTimer(() => {
        if (!matches(requestId)) return;
        fireTimeout(requestId);
      }, deadline);
      return true;
    },

    cancel(requestId) {
      if (!matches(requestId)) return false;
      clearPending();
      return true;
    },

    hasPending() {
      return Boolean(pending);
    },

    currentRequestId() {
      return pending?.requestId || null;
    },
  };
}

module.exports = { createQuitRequestController };
