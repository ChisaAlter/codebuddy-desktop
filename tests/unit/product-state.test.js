import { describe, expect, it } from 'vitest';
import {
  createProjectRecord,
  createThreadRecord,
  createEntityId,
  normalizeProductState,
  productStateSnapshot,
} from '../../src/lib/product-state';

describe('product state sidebar fields', () => {
  it('adds backward-compatible defaults to existing projects and threads', () => {
    const normalized = normalizeProductState({
      version: 1,
      projectsById: {
        p1: {
          id: 'p1',
          name: 'Project',
          workspacePath: 'C:/Project',
          preferences: {},
        },
      },
      projectOrder: ['p1'],
      threadsById: {
        t1: { id: 't1', projectId: 'p1', title: 'Thread' },
      },
      threadOrderByProject: { p1: ['t1'] },
      activeProjectId: 'p1',
      activeThreadId: 't1',
    });

    expect(normalized.projectsById.p1.preferences.sidebarExpanded).toBe(true);
    expect(normalized.threadsById.t1.pinned).toBe(false);
    expect(normalized.threadsById.t1.archivedAt).toBeNull();
  });

  it('resets ephemeral response statuses on hydrate so messages are not permanently queued', () => {
    const normalized = normalizeProductState({
      projectsById: {
        p1: { id: 'p1', preferences: {} },
      },
      projectOrder: ['p1'],
      threadsById: {
        t1: { id: 't1', projectId: 'p1', status: 'running' },
        t2: { id: 't2', projectId: 'p1', status: 'waiting' },
        t3: { id: 't3', projectId: 'p1', status: 'cancelling' },
        t4: { id: 't4', projectId: 'p1', status: 'error' },
        t5: { id: 't5', projectId: 'p1', status: 'idle' },
      },
      threadOrderByProject: { p1: ['t1', 't2', 't3', 't4', 't5'] },
      activeProjectId: 'p1',
      activeThreadId: 't1',
    });

    expect(normalized.threadsById.t1.status).toBe('idle');
    expect(normalized.threadsById.t2.status).toBe('idle');
    expect(normalized.threadsById.t3.status).toBe('idle');
    expect(normalized.threadsById.t4.status).toBe('error');
    expect(normalized.threadsById.t5.status).toBe('idle');
  });

  it('backfills completedAt for finished thinking entries missing an end time', () => {
    const normalized = normalizeProductState({
      projectsById: {
        p1: { id: 'p1', preferences: {} },
      },
      projectOrder: ['p1'],
      threadsById: {
        t1: {
          id: 't1',
          projectId: 'p1',
          timeline: [
            {
              id: 'thought-1',
              type: 'thinking',
              createdAt: 1000,
              streaming: false,
              completedAt: null,
              content: '旧思考',
            },
            {
              id: 'thought-2',
              type: 'thinking',
              createdAt: 2000,
              streaming: true,
              completedAt: null,
              content: '仍在思考',
            },
          ],
        },
      },
      threadOrderByProject: { p1: ['t1'] },
      activeProjectId: 'p1',
      activeThreadId: 't1',
    });

    expect(normalized.threadsById.t1.timeline[0]).toMatchObject({
      id: 'thought-1',
      completedAt: 1000,
      streaming: false,
    });
    expect(normalized.threadsById.t1.timeline[1]).toMatchObject({
      id: 'thought-2',
      completedAt: null,
      streaming: true,
    });
  });

  it('preserves explicit folding, pinning, and archive values', () => {
    const normalized = normalizeProductState({
      projectsById: {
        p1: {
          id: 'p1',
          name: 'Project',
          workspacePath: 'C:/Project',
          preferences: { sidebarExpanded: false },
        },
      },
      projectOrder: ['p1'],
      threadsById: {
        t1: {
          id: 't1',
          projectId: 'p1',
          title: 'Thread',
          pinned: true,
          archivedAt: '2026-07-14T01:02:03.000Z',
        },
      },
      threadOrderByProject: { p1: ['t1'] },
      activeProjectId: 'p1',
      activeThreadId: 't1',
    });

    expect(normalized.projectsById.p1.preferences.sidebarExpanded).toBe(false);
    expect(normalized.threadsById.t1.pinned).toBe(true);
    expect(normalized.threadsById.t1.archivedAt).toBe('2026-07-14T01:02:03.000Z');
  });

  it('creates new records with sidebar defaults', () => {
    expect(createProjectRecord('C:/Project').preferences.sidebarExpanded).toBe(true);
    expect(createThreadRecord('p1')).toMatchObject({ pinned: false, archivedAt: null });
  });

  it('does not restore an archived thread as the active thread', () => {
    const normalized = normalizeProductState({
      projectsById: { p1: { id: 'p1', preferences: {} } },
      projectOrder: ['p1'],
      threadsById: {
        archived: { id: 'archived', projectId: 'p1', archivedAt: '2026-07-14T01:00:00.000Z' },
        visible: { id: 'visible', projectId: 'p1', archivedAt: null },
      },
      threadOrderByProject: { p1: ['archived', 'visible'] },
      activeProjectId: 'p1',
      activeThreadId: 'archived',
    });

    expect(normalized.activeThreadId).toBe('visible');
  });

  it('collapses history replay content that was appended repeatedly by older builds', () => {
    const normalized = normalizeProductState({
      projectsById: { p1: { id: 'p1', preferences: {} } },
      projectOrder: ['p1'],
      threadsById: {
        t1: {
          id: 't1',
          projectId: 'p1',
          timeline: [{
            id: 'message-1',
            type: 'message',
            role: 'assistant',
            content: '损坏历史损坏历史损坏历史',
            raw: {
              content: { type: 'text', text: '损坏历史' },
              _meta: { 'codebuddy.ai': { mode: 'history' } },
            },
          }],
        },
      },
      threadOrderByProject: { p1: ['t1'] },
      activeProjectId: 'p1',
      activeThreadId: 't1',
    });

    expect(normalized.threadsById.t1.timeline[0].content).toBe('损坏历史');
  });

  it('repairs corrupted history metadata from the intact raw message', () => {
    const normalized = normalizeProductState({
      projectsById: { p1: { id: 'p1', preferences: {} } },
      projectOrder: ['p1'],
      threadsById: {
        t1: {
          id: 't1',
          projectId: 'p1',
          timeline: [{
            id: 'message-1',
            type: 'message',
            role: 'assistant',
            content: '完整历史',
            raw: {
              content: { type: 'text', text: '完整历史' },
              _meta: { 'codebuddy.ai': { mode: 'history' } },
            },
            meta: { content: { type: 'text', text: '完整历���' } },
          }],
        },
      },
      threadOrderByProject: { p1: ['t1'] },
      activeProjectId: 'p1',
      activeThreadId: 't1',
    });

    expect(normalized.threadsById.t1.timeline[0].meta.content.text).toBe('完整历史');
  });

  it('persists global GUI preferences outside the renderer localStorage origin', () => {
    const snapshot = productStateSnapshot({
      projectsById: {},
      projectOrder: [],
      threadsById: {},
      threadOrderByProject: {},
      activeProjectId: null,
      activeThreadId: null,
      guiSettings: {
        theme: 'light',
        promptSuggestionEnabled: true,
        desktopNotificationsEnabled: false,
      },
    });

    expect(snapshot.guiSettings).toMatchObject({
      theme: 'light',
      promptSuggestionEnabled: true,
      desktopNotificationsEnabled: false,
    });
    expect(normalizeProductState(snapshot).guiSettings.theme).toBe('light');
  });
});

describe('createEntityId', () => {
  it('produces a prefixed unique id', () => {
    const a = createEntityId('project');
    const b = createEntityId('project');
    expect(a).toMatch(/^project-/);
    expect(b).toMatch(/^project-/);
    expect(a).not.toBe(b);
  });

  // L4: when crypto.randomUUID is unavailable, the fallback still produces
  // unique ids (via getRandomValues) instead of collision-prone Date.now+Math.random.
  it('falls back to getRandomValues when randomUUID is missing', () => {
    const original = globalThis.crypto;
    // Stub crypto with getRandomValues but no randomUUID.
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues: (buf) => { for (let i = 0; i < buf.length; i += 1) buf[i] = i + 1; return buf; } },
      configurable: true,
    });
    try {
      const id = createEntityId('thread');
      expect(id).toMatch(/^thread-[0-9a-f]+$/);
      // Deterministic fill (1,2,3,...) so the hex is stable.
      expect(id).not.toContain('undefined');
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
    }
  });
});
