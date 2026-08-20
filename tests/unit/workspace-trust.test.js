import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createWorkspaceTrust } = require('../../electron/workspace-trust.cjs');

const PROJ = path.resolve('C:/Project');
const EXTRA = path.resolve('C:/Extra');
const CHOSEN = path.resolve('C:/Chosen');
const EVIL = path.resolve('C:/Windows/System32');

function makeTrust(projects = {}, extras = {}) {
  const loadProductState = vi.fn(() => ({
    projectsById: Object.fromEntries(
      Object.entries(projects).map(([id, workspacePath]) => [
        id,
        {
          workspacePath,
          preferences: { workspaceExtraDirs: extras[id] || [] },
        },
      ]),
    ),
  }));
  return { trust: createWorkspaceTrust({ loadProductState }), loadProductState };
}

describe('workspace trust', () => {
  it('trusts on-disk project workspacePath and extra dirs, not invented paths', () => {
    const { trust } = makeTrust({ p1: 'C:/Project' }, { p1: ['C:/Extra'] });
    expect(trust.isTrustedCwd('C:/Project')).toBe(true);
    expect(trust.isTrustedCwd('C:/Extra')).toBe(true);
    expect(trust.isTrustedCwd('C:/Windows/System32')).toBe(false);
    expect([...trust.listTrustedDirs()].sort()).toEqual([EXTRA, PROJ].sort());
  });

  it('trusts a dialog-chosen path before it is persisted', () => {
    const { trust } = makeTrust({});
    expect(trust.isTrustedCwd('C:/Chosen')).toBe(false);
    expect(trust.registerChosen('C:/Chosen')).toBe(true);
    expect(trust.isTrustedCwd('C:/Chosen')).toBe(true);
  });

  it('expires chosen paths after TTL', () => {
    const { trust } = makeTrust({});
    trust.registerChosen('C:/Chosen', 1000);
    expect(trust.isTrustedCwd('C:/Chosen', 1000)).toBe(true);
    expect(trust.isTrustedCwd('C:/Chosen', 1000 + 10 * 60 * 1000 + 1)).toBe(false);
  });

  it('refuses a forged incoming workspacePath and keeps the previous one', () => {
    const previous = {
      projectsById: {
        p1: { workspacePath: 'C:/Project', preferences: { workspaceExtraDirs: ['C:/Extra'] } },
      },
    };
    const { trust } = makeTrust({ p1: 'C:/Project' }, { p1: ['C:/Extra'] });
    const sanitized = trust.sanitizeIncomingState(
      {
        projectsById: {
          p1: { workspacePath: 'C:/Windows/System32', preferences: { workspaceExtraDirs: ['C:/Extra', EVIL] } },
        },
      },
      previous,
    );
    expect(path.resolve(sanitized.projectsById.p1.workspacePath)).toBe(PROJ);
    expect(sanitized.projectsById.p1.preferences.workspaceExtraDirs.map((d) => path.resolve(d))).toEqual([EXTRA]);
  });

  it('drops a brand-new project whose workspacePath was never chosen or persisted', () => {
    const { trust } = makeTrust({ p1: 'C:/Project' });
    const sanitized = trust.sanitizeIncomingState(
      {
        projectsById: {
          p1: { workspacePath: 'C:/Project' },
          'p-evil': { workspacePath: 'C:/Windows/System32' },
        },
      },
      { projectsById: { p1: { workspacePath: 'C:/Project' } } },
    );
    expect(sanitized.projectsById['p-evil']).toBeUndefined();
    expect(path.resolve(sanitized.projectsById.p1.workspacePath)).toBe(PROJ);
  });

  it('accepts a newly chosen workspacePath on a new project', () => {
    const { trust } = makeTrust({});
    trust.registerChosen('C:/Chosen');
    const sanitized = trust.sanitizeIncomingState(
      { projectsById: { p2: { workspacePath: 'C:/Chosen', preferences: {} } } },
      { projectsById: {} },
    );
    expect(path.resolve(sanitized.projectsById.p2.workspacePath)).toBe(CHOSEN);
  });

  it('survives loadProductState throwing', () => {
    const trust = createWorkspaceTrust({
      loadProductState: () => {
        throw new Error('disk gone');
      },
    });
    expect(trust.isTrustedCwd('C:/Project')).toBe(false);
    trust.registerChosen('C:/Chosen');
    expect(trust.isTrustedCwd('C:/Chosen')).toBe(true);
  });
});
