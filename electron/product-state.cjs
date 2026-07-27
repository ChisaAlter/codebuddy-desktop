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

  function load() {
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

  function save(value) {
    const normalized = normalizeProductState(value);
    // 防护：空项目快照不得覆盖磁盘上已有项目（常见于退出时 hydrate 未完成就 beforeunload flush）。
    const incomingCount = Object.keys(normalized.projectsById || {}).length;
    if (incomingCount === 0 && fs.existsSync(stateFile)) {
      try {
        const existing = normalizeProductState(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
        const existingCount = Object.keys(existing.projectsById || {}).length;
        if (existingCount > 0) {
          logger(
            `Refused to overwrite product-state with empty projects (disk has ${existingCount} project(s))`,
          );
          return existing;
        }
      } catch (error) {
        logger(`Product state empty-overwrite guard read failed: ${error.message}`);
      }
    }
    const tempFile = `${stateFile}.tmp`;
    const backupFile = `${stateFile}.bak`;
    fs.mkdirSync(userDataPath, { recursive: true });
    // L1: write with 0o600 so conversation/thread content is not world-readable
    // on multi-user machines. The temp+rename below preserves atomicity.
    fs.writeFileSync(tempFile, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
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
    return normalized;
  }

  return { load, save, stateFile };
}

module.exports = {
  PRODUCT_STATE_VERSION,
  createProductStateStore,
  emptyProductState,
  normalizeProductState,
};
