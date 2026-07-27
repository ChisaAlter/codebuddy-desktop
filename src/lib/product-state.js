export const PRODUCT_STATE_VERSION = 1;

export function emptyProductState() {
  return {
    version: PRODUCT_STATE_VERSION,
    guiSettings: {},
    projectsById: {},
    projectOrder: [],
    threadsById: {},
    threadOrderByProject: {},
    activeProjectId: null,
    activeThreadId: null,
  };
}

function randomHexFallback(bytes = 16) {
  // L4: when crypto.randomUUID is unavailable (older renderer/Node), derive an
  // id from crypto.getRandomValues instead of Math.random (collision-prone,
  // non-RFC-4122). Falls back to Math.random only if both are absent.
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.getRandomValues) {
    const buf = new Uint8Array(bytes);
    cryptoObj.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 2 + bytes)}`;
}

export function createEntityId(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}-${uuid}`;
  return `${prefix}-${randomHexFallback(16)}`;
}

export function projectNameFromPath(workspacePath) {
  const normalized = String(workspacePath || '').replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || '未命名项目';
}

export function createProjectRecord(workspacePath, overrides = {}) {
  const now = new Date().toISOString();
  const preferences = overrides.preferences && typeof overrides.preferences === 'object'
    ? overrides.preferences
    : {};
  return {
    id: overrides.id || createEntityId('project'),
    name: overrides.name || projectNameFromPath(workspacePath),
    workspacePath: String(workspacePath || ''),
    createdAt: overrides.createdAt || now,
    updatedAt: now,
    lastOpenedAt: now,
    runtimeStatus: overrides.runtimeStatus || 'idle',
    preferences: {
      ...preferences,
      sidebarExpanded: preferences.sidebarExpanded !== false,
    },
  };
}

export function createThreadRecord(projectId, overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: overrides.id || createEntityId('thread'),
    projectId,
    sessionId: overrides.sessionId || null,
    title: overrides.title || '新对话',
    draft: overrides.draft || '',
    timeline: Array.isArray(overrides.timeline) ? overrides.timeline : [],
    status: overrides.status || 'idle',
    unread: Boolean(overrides.unread),
    pinned: Boolean(overrides.pinned),
    archivedAt: typeof overrides.archivedAt === 'string' && overrides.archivedAt
      ? overrides.archivedAt
      : null,
    modelId: overrides.modelId || null,
    modeId: overrides.modeId || 'default',
    createdAt: overrides.createdAt || now,
    updatedAt: now,
    lastOpenedAt: now,
    metadata: overrides.metadata || {},
  };
}

function normalizeTimelineEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  let normalized = entry;

  // 已结束的思考若缺少 completedAt，回填为 createdAt，避免 UI 把“消息年龄”显示成思考用时。
  if (normalized.type === 'thinking' && !normalized.streaming) {
    const completedAt = Number(normalized.completedAt);
    if (!Number.isFinite(completedAt) || completedAt <= 0) {
      const startedAt = Number(normalized.createdAt);
      normalized = {
        ...normalized,
        completedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : null,
      };
    }
  }

  const historyMode = normalized.raw?._meta?.['codebuddy.ai']?.mode === 'history';
  const rawText = normalized.raw?.content?.text;
  const content = normalized.content;
  if (!historyMode || typeof rawText !== 'string' || !rawText || typeof content !== 'string') return normalized;
  const repeatCount = content.length / rawText.length;
  const repeatedContent = Number.isInteger(repeatCount)
    && repeatCount >= 2
    && rawText.repeat(repeatCount) === content;
  const metaText = normalized.meta?.content?.text;
  const corruptedMeta = typeof metaText === 'string'
    && metaText.includes('\uFFFD')
    && !rawText.includes('\uFFFD');
  if (!repeatedContent && !corruptedMeta) return normalized;
  return {
    ...normalized,
    ...(repeatedContent ? { content: rawText } : {}),
    ...(corruptedMeta ? {
      meta: {
        ...normalized.meta,
        content: { ...normalized.meta.content, text: rawText },
      },
    } : {}),
  };
}

export function normalizeProductState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyProductState();

  const sourceProjects = value.projectsById && typeof value.projectsById === 'object'
    ? value.projectsById
    : {};
  const sourceThreads = value.threadsById && typeof value.threadsById === 'object'
    ? value.threadsById
    : {};
  const projectsById = Object.fromEntries(Object.entries(sourceProjects).map(([id, project]) => {
    const preferences = project?.preferences && typeof project.preferences === 'object'
      ? project.preferences
      : {};
    return [id, {
      ...project,
      preferences: {
        ...preferences,
        sidebarExpanded: preferences.sidebarExpanded !== false,
      },
    }];
  }));
  // running/waiting/cancelling 是进程内瞬态；磁盘恢复后没有对应 ACP 请求，
  // 若原样读回会导致 UI 永久「等待模型响应 / 消息将排队」。
  const EPHEMERAL_THREAD_STATUSES = new Set(['running', 'waiting', 'cancelling', 'connecting']);
  const threadsById = Object.fromEntries(Object.entries(sourceThreads).map(([id, thread]) => {
    const rawStatus = typeof thread?.status === 'string' ? thread.status : 'idle';
    const status = EPHEMERAL_THREAD_STATUSES.has(rawStatus) ? 'idle' : rawStatus || 'idle';
    return [id, {
      ...thread,
      status,
      timeline: Array.isArray(thread?.timeline) ? thread.timeline.map(normalizeTimelineEntry) : [],
      pinned: Boolean(thread?.pinned),
      archivedAt: typeof thread?.archivedAt === 'string' && thread.archivedAt
        ? thread.archivedAt
        : null,
    }];
  }));
  const projectOrder = Array.isArray(value.projectOrder)
    ? value.projectOrder.filter((id) => typeof id === 'string' && projectsById[id])
    : [];
  const threadOrderByProject = {};

  for (const projectId of projectOrder) {
    const order = Array.isArray(value.threadOrderByProject?.[projectId])
      ? value.threadOrderByProject[projectId]
      : [];
    threadOrderByProject[projectId] = order.filter((threadId) => (
      typeof threadId === 'string' && threadsById[threadId]?.projectId === projectId
    ));
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
    guiSettings: value.guiSettings && typeof value.guiSettings === 'object' && !Array.isArray(value.guiSettings)
      ? { ...value.guiSettings }
      : {},
    projectOrder,
    threadsById,
    threadOrderByProject,
    activeProjectId,
    activeThreadId,
  };
}

export function productStateSnapshot(state) {
  return normalizeProductState({
    version: PRODUCT_STATE_VERSION,
    guiSettings: state.guiSettings,
    projectsById: state.projectsById,
    projectOrder: state.projectOrder,
    threadsById: state.threadsById,
    threadOrderByProject: state.threadOrderByProject,
    activeProjectId: state.activeProjectId,
    activeThreadId: state.activeThreadId,
  });
}

export function activeProject(state) {
  return state.projectsById?.[state.activeProjectId] || null;
}

export function activeThread(state) {
  return state.threadsById?.[state.activeThreadId] || null;
}
