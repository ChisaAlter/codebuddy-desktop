'use strict';

const path = require('path');

/**
 * Main-process workspace trust (renderer cannot invent cwd / workspacePath).
 *
 * Trusted dirs = dialog-chosen paths (TTL) ∪ on-disk product-state
 * `projectsById.*.workspacePath` ∪ `preferences.workspaceExtraDirs`.
 */

const DEFAULT_CHOSEN_TTL_MS = 10 * 60 * 1000;

function normalizeAbs(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return path.resolve(value.trim());
  } catch (_) {
    return null;
  }
}

function createWorkspaceTrust({ loadProductState, ttlMs = DEFAULT_CHOSEN_TTL_MS } = {}) {
  const chosen = new Map(); // absPath -> expireAt

  function prune(now = Date.now()) {
    for (const [p, expireAt] of chosen) {
      if (expireAt <= now) chosen.delete(p);
    }
  }

  function registerChosen(absPath, now = Date.now()) {
    const normalized = normalizeAbs(absPath);
    if (!normalized) return false;
    chosen.set(normalized, now + ttlMs);
    return true;
  }

  function diskTrustedDirs() {
    const dirs = new Set();
    let state = null;
    try {
      state = typeof loadProductState === 'function' ? loadProductState() : null;
    } catch (_) {
      return dirs;
    }
    const projects = (state && state.projectsById) || {};
    for (const project of Object.values(projects)) {
      const workspace = normalizeAbs(project?.workspacePath);
      if (workspace) dirs.add(workspace);
      const extra = project?.preferences?.workspaceExtraDirs;
      if (Array.isArray(extra)) {
        for (const dir of extra) {
          const abs = normalizeAbs(dir);
          if (abs) dirs.add(abs);
        }
      }
    }
    return dirs;
  }

  function listTrustedDirs(now = Date.now()) {
    prune(now);
    const dirs = diskTrustedDirs();
    for (const p of chosen.keys()) dirs.add(p);
    return dirs;
  }

  function isTrustedCwd(absPath, now = Date.now()) {
    const normalized = normalizeAbs(absPath);
    if (!normalized) return false;
    return listTrustedDirs(now).has(normalized);
  }

  function sanitizeIncomingState(incoming, previous) {
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return previous && typeof previous === 'object' ? previous : incoming;
    }
    const prevProjects =
      previous && typeof previous === 'object' && previous.projectsById && typeof previous.projectsById === 'object'
        ? previous.projectsById
        : {};
    const incomingProjects =
      incoming.projectsById && typeof incoming.projectsById === 'object' && !Array.isArray(incoming.projectsById)
        ? incoming.projectsById
        : {};
    // M-perf: 信任集只算一次。旧实现对每个项目/每个额外目录各调一次 isTrustedCwd，
    // 每次都会经 listTrustedDirs → loadProductState 全量重读磁盘状态文件。
    const trustedDirs = listTrustedDirs();
    const isTrustedPath = (value) => {
      const normalized = normalizeAbs(value);
      return Boolean(normalized) && trustedDirs.has(normalized);
    };
    const nextProjects = {};
    for (const [id, project] of Object.entries(incomingProjects)) {
      if (!project || typeof project !== 'object') continue;
      const prev = prevProjects[id];
      let workspacePath = typeof project.workspacePath === 'string' ? project.workspacePath : null;
      if (workspacePath && workspacePath.trim()) {
        if (!isTrustedPath(workspacePath)) {
          workspacePath = typeof prev?.workspacePath === 'string' ? prev.workspacePath : null;
        }
      } else {
        workspacePath = typeof prev?.workspacePath === 'string' ? prev.workspacePath : null;
      }
      if (!workspacePath || !String(workspacePath).trim()) continue;

      const prefs =
        project.preferences && typeof project.preferences === 'object' && !Array.isArray(project.preferences)
          ? { ...project.preferences }
          : {};
      const extraDirs = Array.isArray(prefs.workspaceExtraDirs) ? prefs.workspaceExtraDirs : [];
      prefs.workspaceExtraDirs = extraDirs.filter((dir) => isTrustedPath(dir));
      nextProjects[id] = {
        ...project,
        workspacePath,
        preferences: prefs,
      };
    }
    return { ...incoming, projectsById: nextProjects };
  }

  return {
    registerChosen,
    isTrustedCwd,
    listTrustedDirs,
    sanitizeIncomingState,
    _chosen: chosen,
  };
}

module.exports = {
  createWorkspaceTrust,
  DEFAULT_CHOSEN_TTL_MS,
};
