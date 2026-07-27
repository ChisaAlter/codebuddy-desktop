'use strict';

const path = require('path');

/**
 * Attachment read scoping (H7).
 *
 * `attachment:read` must not read arbitrary local files the renderer hands it;
 * reads are allowed only for paths the user actively chose (via attachment:choose
 * or drag-drop) or that live inside an active project workspace. This module
 * holds the pure helpers so unit tests can lock the allow/deny logic without
 * mocking the Electron main process.
 */

const DEFAULT_CHOSEN_TTL_MS = 10 * 60 * 1000;

function createAttachmentScope({ loadProductState }) {
  const chosen = new Map(); // absPath -> expireAt

  function prune() {
    const now = Date.now();
    for (const [p, expireAt] of chosen) {
      if (expireAt <= now) chosen.delete(p);
    }
  }

  function register(filePaths, now = Date.now()) {
    for (const p of filePaths) {
      if (typeof p !== 'string' || !p.trim()) continue;
      try { chosen.set(path.resolve(p), now + DEFAULT_CHOSEN_TTL_MS); } catch (_) {}
    }
  }

  function isWithinWorkspace(absPath, cwd) {
    if (!cwd) return false;
    let rel;
    try { rel = path.relative(cwd, absPath); } catch (_) { return false; }
    if (rel === '') return true;
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  function projectCwds() {
    try {
      const state = loadProductState();
      const projects = (state && state.projectsById) || {};
      const cwds = [];
      for (const project of Object.values(projects)) {
        const cwd = project?.workspacePath;
        if (typeof cwd === 'string' && cwd.trim()) {
          try { cwds.push(path.resolve(cwd)); } catch (_) {}
        }
      }
      return cwds;
    } catch (_) {
      return [];
    }
  }

  /**
   * Decide whether a path may be read as an attachment.
   * @param {string} filePath
   * @returns {'chosen' | 'workspace' | 'no'}
   */
  function allow(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) return 'no';
    prune();
    let abs;
    try { abs = path.resolve(filePath); } catch (_) { return 'no'; }
    if (chosen.has(abs)) return 'chosen';
    for (const cwd of projectCwds()) {
      if (isWithinWorkspace(abs, cwd)) return 'workspace';
    }
    return 'no';
  }

  return { register, allow, isWithinWorkspace, projectCwds, _chosen: chosen };
}

module.exports = { createAttachmentScope, DEFAULT_CHOSEN_TTL_MS };