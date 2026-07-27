import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createProductStateStore, emptyProductState } = require('../../electron/product-state.cjs');

describe('electron product-state store', () => {
  /** @type {string[]} */
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-product-state-'));
    tempDirs.push(dir);
    const logs = [];
    const store = createProductStateStore(dir, (message) => logs.push(message));
    return { dir, store, logs };
  }

  it('round-trips save and load', () => {
    const { store } = makeStore();
    const saved = store.save({
      version: 1,
      projectsById: {
        'project-1': {
          id: 'project-1',
          name: 'Demo',
          workspacePath: 'C:/Demo',
          preferences: { sidebarExpanded: true },
        },
      },
      projectOrder: ['project-1'],
      threadsById: {
        'thread-1': {
          id: 'thread-1',
          projectId: 'project-1',
          sessionId: 'session-1',
          title: 'Chat',
          timeline: [{ id: 'm1', type: 'message', role: 'user', content: 'hi' }],
          pinned: false,
          archivedAt: null,
        },
      },
      threadOrderByProject: { 'project-1': ['thread-1'] },
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      guiSettings: { theme: 'dark' },
    });

    expect(saved.activeProjectId).toBe('project-1');
    expect(store.load().threadsById['thread-1'].timeline[0].content).toBe('hi');
    expect(store.load().guiSettings.theme).toBe('dark');
  });

  it('recovers from backup when primary JSON is corrupt', () => {
    const { dir, store, logs } = makeStore();
    // First save creates primary; second save promotes primary to .bak.
    store.save({
      projectsById: { 'project-1': { id: 'project-1', preferences: {} } },
      projectOrder: ['project-1'],
      threadsById: {},
      threadOrderByProject: { 'project-1': [] },
      activeProjectId: 'project-1',
      activeThreadId: null,
      guiSettings: { theme: 'light' },
    });
    store.save({
      projectsById: { 'project-1': { id: 'project-1', preferences: {} } },
      projectOrder: ['project-1'],
      threadsById: {},
      threadOrderByProject: { 'project-1': [] },
      activeProjectId: 'project-1',
      activeThreadId: null,
      guiSettings: { theme: 'dark' },
    });

    fs.writeFileSync(store.stateFile, '{not-json', 'utf8');
    const loaded = store.load();
    expect(loaded.guiSettings.theme).toBe('light');
    expect(logs.some((line) => /recovered|quarantine|Invalid product state/i.test(line))).toBe(true);
    expect(fs.existsSync(store.stateFile)).toBe(true);
    expect(fs.readdirSync(dir).some((name) => name.startsWith('product-state.invalid-'))).toBe(true);
  });

  it('writes atomically and keeps a backup of the previous primary file', () => {
    const { store } = makeStore();
    store.save({
      projectsById: {},
      projectOrder: [],
      threadsById: {},
      threadOrderByProject: {},
      activeProjectId: null,
      activeThreadId: null,
      guiSettings: { step: 1 },
    });
    store.save({
      projectsById: {},
      projectOrder: [],
      threadsById: {},
      threadOrderByProject: {},
      activeProjectId: null,
      activeThreadId: null,
      guiSettings: { step: 2 },
    });

    expect(fs.existsSync(`${store.stateFile}.tmp`)).toBe(false);
    expect(fs.existsSync(`${store.stateFile}.bak`)).toBe(true);
    const backup = JSON.parse(fs.readFileSync(`${store.stateFile}.bak`, 'utf8'));
    const primary = JSON.parse(fs.readFileSync(store.stateFile, 'utf8'));
    expect(backup.guiSettings.step).toBe(1);
    expect(primary.guiSettings.step).toBe(2);
  });

  it('returns empty state when primary and backup are both invalid', () => {
    const { store } = makeStore();
    fs.writeFileSync(store.stateFile, '{bad', 'utf8');
    fs.writeFileSync(`${store.stateFile}.bak`, '{also-bad', 'utf8');
    expect(store.load()).toEqual(emptyProductState());
  });

  // L1: product-state.json must be written with 0o600 so conversation/thread
  // content is not world-readable on multi-user POSIX machines. Windows chmod is
  // a no-op so the assertion is skipped there.
  (process.platform === 'win32' ? it.skip : it)('writes the primary file with mode 0o600 (POSIX)', () => {
    const { store } = makeStore();
    store.save({ ...emptyProductState(), projectsById: { p1: { id: 'p1', workspacePath: '/x' } }, projectOrder: ['p1'] });
    const stat = fs.statSync(store.stateFile);
    // Mask to permission bits only.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  // L3: normalizeTimelineEntry must not allocate a multi-MB string when a tiny
  // rawText is "repeated" into a huge content. The repeat-comparison is skipped
  // past the cap; the entry is returned unchanged (treated as non-repeated).
  it('skips the repeat comparison for oversized repeated content', () => {
    const { store } = makeStore();
    const rawText = 'ab';
    const hugeContent = rawText.repeat(50_000); // 100k chars, repeatCount=50000 (>1000 cap)
    const thread = {
      id: 't1',
      projectId: 'p1',
      timeline: [
        {
          type: 'message',
          role: 'assistant',
          content: hugeContent,
          raw: {
            content: { text: rawText },
            _meta: { 'codebuddy.ai': { mode: 'history' } },
          },
        },
      ],
    };
    const normalized = store.load();
    // Use normalizeProductState indirectly by saving + loading.
    store.save({ ...emptyProductState(), projectsById: { p1: { id: 'p1', workspacePath: '/x' } }, projectOrder: ['p1'], threadsById: { t1: thread }, threadOrderByProject: { p1: ['t1'] } });
    const loaded = store.load();
    // Without the cap, content would be collapsed to 'ab' (rawText). With the cap,
    // the entry is treated as non-repeated and the huge content is preserved.
    const loadedEntry = loaded.threadsById.t1.timeline[0];
    expect(loadedEntry.content).toBe(hugeContent);
  });
});
