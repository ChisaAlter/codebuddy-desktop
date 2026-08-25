const fs = require('fs');
const path = require('path');

const PRODUCT_STATE_VERSION = 1;

function emptyProductState() {
  return {
    version: PRODUCT_STATE_VERSION,
    projectsById: {},
    guiSettings: {},
    projectOrder: [],
    threadsById: {},
    threadOrderByProject: {},
    activeProjectId: null,
    activeThreadId: null,
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTimelineEntry(entry) {
  if (!isPlainObject(entry)) return entry;
  const historyMode = entry.raw?._meta?.['codebuddy.ai']?.mode === 'history';
  const rawText = entry.raw?.content?.text;
  const content = entry.content;
  if (!historyMode || typeof rawText !== 'string' || !rawText || typeof content !== 'string') return entry;
  const repeatCount = content.length / rawText.length;
  // L3: bound the repeat comparison. A very short rawText against a huge content
  // would make repeatCount enormous, allocating a multi-MB string transiently
  // for the `=== content` check. Skip the repeat path entirely when the
  // allocation would exceed 1MB or the count exceeds 1000 (treat as non-repeated).
  const repeatSafe =
    Number.isInteger(repeatCount)
    && repeatCount >= 2
    && repeatCount <= 1000
    && rawText.length * repeatCount <= 1_000_000;
  const repeatedContent = repeatSafe && rawText.repeat(repeatCount) === content;
  const metaText = entry.meta?.content?.text;
  const corruptedMeta = typeof metaText === 'string'
    && metaText.includes('\uFFFD')
    && !rawText.includes('\uFFFD');
  if (!repeatedContent && !corruptedMeta) return entry;
  return {
    ...entry,
    ...(repeatedContent ? { content: rawText } : {}),
    ...(corruptedMeta ? {
      meta: {
        ...entry.meta,
        content: { ...entry.meta.content, text: rawText },
      },
    } : {}),
  };
}

function normalizeProductState(value) {
  if (!isPlainObject(value)) return emptyProductState();

  const sourceProjects = isPlainObject(value.projectsById) ? value.projectsById : {};
  const sourceThreads = isPlainObject(value.threadsById) ? value.threadsById : {};
  const projectsById = Object.fromEntries(Object.entries(sourceProjects).map(([id, project]) => {
    const preferences = isPlainObject(project?.preferences) ? project.preferences : {};
    return [id, {
      ...project,
      preferences: {
        ...preferences,
        sidebarExpanded: preferences.sidebarExpanded !== false,
      },
    }];
  }));
  const threadsById = Object.fromEntries(Object.entries(sourceThreads).map(([id, thread]) => [id, {
    ...thread,
    timeline: Array.isArray(thread?.timeline) ? thread.timeline.map(normalizeTimelineEntry) : [],
    pinned: Boolean(thread?.pinned),
    archivedAt: typeof thread?.archivedAt === 'string' && thread.archivedAt
      ? thread.archivedAt
      : null,
  }]));
  const projectOrder = Array.isArray(value.projectOrder)
    ? value.projectOrder.filter((id) => typeof id === 'string' && projectsById[id])
    : [];
  const threadOrderByProject = {};

  for (const projectId of projectOrder) {
    const requestedOrder = Array.isArray(value.threadOrderByProject?.[projectId])
      ? value.threadOrderByProject[projectId]
      : [];
    threadOrderByProject[projectId] = requestedOrder.filter((threadId) => {
      const thread = threadsById[threadId];
      return typeof threadId === 'string' && thread?.projectId === projectId;
    });
  }

  const activeProjectId = projectOrder.includes(value.activeProjectId)
    ? value.activeProjectId
    : (projectOrder[0] || null);
  const visibleThreadOrder = activeProjectId
    ? (threadOrderByProject[activeProjectId] || []).filter((threadId) => !threadsById[threadId]?.archivedAt)
    : [];
  const activeThreadId = visibleThreadOrder.includes(value.activeThreadId)
    ? value.activeThreadId
    : (visibleThreadOrder[0] || null);

  return {
    version: PRODUCT_STATE_VERSION,
    projectsById,
    projectOrder,
    threadsById,
    threadOrderByProject,
    activeProjectId,
    activeThreadId,
    guiSettings: isPlainObject(value.guiSettings) ? { ...value.guiSettings } : {},
  };
}

function createProductStateStore(userDataPath, logger = () => {}) {
  const stateFile = path.join(userDataPath, 'product-state.json');
  let saveGeneration = 0;
  // M-perf: load() 结果缓存。每次 productState:save 的 trust 校验会调 load()
  // 1 + 项目数×(1+额外目录) 次（workspace-trust 逐目录回查磁盘态），旧实现每次
  // 都整文件 read+parse+normalize —— 流式期间主线程被同一份多 MB 文件反复解析。
  // 以 mtime+size 校验失效；自家 save/saveSync 提交后直接写入缓存（normalized
  // 与 load 的 read+parse+normalize 输出同构）。返回值视为只读，调用方不得原地修改。
  let loadCache = null; // { mtimeMs, size, state }

  function nextSaveGeneration() {
    saveGeneration += 1;
    return saveGeneration;
  }

  function statStamp() {
    try {
      const st = fs.statSync(stateFile);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch (_) {
      return null;
    }
  }

  function refreshLoadCache(state) {
    const stamp = statStamp();
    loadCache = stamp ? { mtimeMs: stamp.mtimeMs, size: stamp.size, state } : null;
  }

  function tempFileForGeneration(generation) {
    return `${stateFile}.tmp.${process.pid}.${generation}`;
  }

  function quarantineInvalid(filePath, label = '') {
    if (!fs.existsSync(filePath)) return null;
    const suffix = label ? `-${label}` : '';
    const invalidFile = path.join(
      userDataPath,
      `product-state.invalid-${Date.now()}${suffix}.json`,
    );
    fs.renameSync(filePath, invalidFile);
    logger(`Invalid product state moved to ${invalidFile}`);
    return invalidFile;
  }

  function loadFromDisk() {
    const backupFile = `${stateFile}.bak`;
    if (!fs.existsSync(stateFile) && fs.existsSync(backupFile)) {
      try {
        fs.copyFileSync(backupFile, stateFile);
        logger(`Product state restored from backup because primary file was missing`);
      } catch (error) {
        logger(`Product state backup restore failed: ${error.message}`);
      }
    }
    if (!fs.existsSync(stateFile)) return emptyProductState();

    try {
      return normalizeProductState(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
    } catch (error) {
      logger(`Product state load failed: ${error.message}`);
      try { quarantineInvalid(stateFile); } catch (moveError) {
        logger(`Invalid product state quarantine failed: ${moveError.message}`);
      }

      if (fs.existsSync(backupFile)) {
        try {
          const recovered = normalizeProductState(JSON.parse(fs.readFileSync(backupFile, 'utf8')));
          try {
            fs.copyFileSync(backupFile, stateFile);
            logger(`Product state recovered from ${backupFile}`);
          } catch (copyError) {
            logger(`Recovered product state could not be copied to primary file: ${copyError.message}`);
          }
          return recovered;
        } catch (backupError) {
          logger(`Product state backup load failed: ${backupError.message}`);
          try { quarantineInvalid(backupFile, 'backup'); } catch (moveError) {
            logger(`Invalid product state backup quarantine failed: ${moveError.message}`);
          }
        }
      }
      return emptyProductState();
    }
  }

  function load() {
    const stamp = statStamp();
    if (!stamp) {
      loadCache = null;
      return loadFromDisk();
    }
    if (loadCache && loadCache.mtimeMs === stamp.mtimeMs && loadCache.size === stamp.size) {
      return loadCache.state;
    }
    const state = loadFromDisk();
    // loadFromDisk 可能触达 .bak 恢复/隔离改名，重新 stat 而不是复用进循环前的快照。
    refreshLoadCache(state);
    return state;
  }

  /** M-perf: compact serialization. No pretty-print — roughly halves both the
   * stringify time and file size for large timelines; the temp+rename pattern in
   * the commit helpers below preserves atomicity either way. */
  function serialize(normalized) {
    return `${JSON.stringify(normalized)}\n`;
  }

  /** Returns true when the incoming empty snapshot must be refused (disk has projects). */
  function refuseEmptyOverwrite(normalized) {
    const incomingCount = Object.keys(normalized.projectsById || {}).length;
    if (incomingCount !== 0 || !fs.existsSync(stateFile)) return false;
    try {
      const existing = normalizeProductState(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
      const existingCount = Object.keys(existing.projectsById || {}).length;
      if (existingCount > 0) {
        logger(
          `Refused to overwrite product-state with empty projects (disk has ${existingCount} project(s))`,
        );
        return true;
      }
    } catch (error) {
      logger(`Product state empty-overwrite guard read failed: ${error.message}`);
    }
    return false;
  }

  /** M-perf: async save path. Keeps the main-process event loop unblocked while
   * serializing+writing (timeline-heavy states used to freeze all IPC). */
  async function save(value) {
    const generation = nextSaveGeneration();
    const normalized = normalizeProductState(value);
    // 防护：空项目快照不得覆盖磁盘上已有项目（常见于退出时 hydrate 未完成就 beforeunload flush）。
    if (refuseEmptyOverwrite(normalized)) {
      return {
        ok: false,
        generation,
        code: 'EMPTY_OVERWRITE_REFUSED',
        error: 'Refused empty product-state overwrite',
      };
    }
    const tempFile = tempFileForGeneration(generation);
    const backupFile = `${stateFile}.bak`;
    fs.mkdirSync(userDataPath, { recursive: true });
    // L1: write with 0o600 so conversation/thread content is not world-readable
    // on multi-user machines. The temp+rename below preserves atomicity.
    await fs.promises.writeFile(tempFile, serialize(normalized), { encoding: 'utf8', mode: 0o600 });
    if (generation !== saveGeneration) {
      await fs.promises.rm(tempFile, { force: true }).catch(() => {});
      return { ok: true, generation, disposition: 'superseded', supersededBy: saveGeneration };
    }
    // Keep the primary/backup rename sequence synchronous and short. No await can
    // let saveSync interleave after primary is moved but before the new file lands.
    commitStateFileSync(tempFile, backupFile);
    refreshLoadCache(normalized);
    return { ok: true, generation, disposition: 'committed' };
  }

  /** Sync save path — only for the quit flow (sendSync), where the app must not
   * exit before the snapshot lands. */
  function saveSync(value) {
    const generation = nextSaveGeneration();
    const normalized = normalizeProductState(value);
    if (refuseEmptyOverwrite(normalized)) {
      return {
        ok: false,
        generation,
        code: 'EMPTY_OVERWRITE_REFUSED',
        error: 'Refused empty product-state overwrite',
      };
    }
    const tempFile = tempFileForGeneration(generation);
    const backupFile = `${stateFile}.bak`;
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(tempFile, serialize(normalized), { encoding: 'utf8', mode: 0o600 });
    commitStateFileSync(tempFile, backupFile);
    refreshLoadCache(normalized);
    return { ok: true, generation, disposition: 'committed' };
  }

  function commitStateFileSync(tempFile, backupFile) {
    try {
      if (fs.existsSync(backupFile)) fs.rmSync(backupFile, { force: true });
      if (fs.existsSync(stateFile)) fs.renameSync(stateFile, backupFile);
      fs.renameSync(tempFile, stateFile);
      // L1: enforce 0o600 on the final file (rename may not preserve mode on all platforms).
      try { fs.chmodSync(stateFile, 0o600); } catch { /* windows */ }
    } catch (error) {
      try {
        if (!fs.existsSync(stateFile) && fs.existsSync(backupFile)) {
          fs.copyFileSync(backupFile, stateFile);
        }
      } catch (_) {}
      try { fs.rmSync(tempFile, { force: true }); } catch (_) {}
      throw error;
    }
  }

  return { load, save, saveSync, stateFile };
}

module.exports = {
  PRODUCT_STATE_VERSION,
  createProductStateStore,
  emptyProductState,
  normalizeProductState,
};
