import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createAttachmentScope } = require('../../electron/attachment-scope.cjs');

function makeScope(projects = []) {
  const loadProductState = vi.fn(() => ({
    projectsById: Object.fromEntries(
      projects.map((cwd, index) => [`project-${index + 1}`, { workspacePath: cwd }]),
    ),
  }));
  return { scope: createAttachmentScope({ loadProductState }), loadProductState };
}

describe('attachment read scoping (H7)', () => {
  it('denies paths that are neither chosen nor inside a project workspace', () => {
    const { scope } = makeScope(['C:/Project']);
    expect(scope.allow('C:/Elsewhere/secret.env')).toBe('no');
  });

  it('allows a path inside an active project workspace', () => {
    const { scope } = makeScope(['C:/Project']);
    expect(scope.allow('C:/Project/src/a.js')).toBe('workspace');
    expect(scope.allow('C:/Project/.env')).toBe('workspace');
  });

  it('rejects traversal that escapes the workspace via ..', () => {
    const { scope } = makeScope(['C:/Project']);
    expect(scope.allow('C:/Project/../outside.env')).toBe('no');
    expect(scope.allow('C:/Project/../../etc/passwd')).toBe('no');
  });

  it('allows a chosen path even outside any workspace', () => {
    const { scope } = makeScope([]);
    scope.register(['C:/Temp/report.md']);
    expect(scope.allow('C:/Temp/report.md')).toBe('chosen');
  });

  it('denies a chosen path after its TTL expires', () => {
    const { scope } = makeScope([]);
    scope.register(['C:/Temp/report.md'], 1000); // registered with explicit now
    // Fast-forward the internal clock by mutating the chosen entry's expiry.
    const abs = 'C:/Temp/report.md'.replace(/\//g, require('path').sep);
    // Force expiry by setting the entry to the past via register with old now + advance
    scope._chosen.set(abs, 1); // already expired
    expect(scope.allow('C:/Temp/report.md')).toBe('no');
  });

  it('treats the workspace root itself as in-workspace', () => {
    const { scope } = makeScope(['C:/Project']);
    // The relative of the cwd to itself is '' which is treated as within.
    expect(scope.isWithinWorkspace('C:/Project', 'C:/Project')).toBe(true);
  });

  it('returns no project cwds when product state is empty', () => {
    const { scope, loadProductState } = makeScope([]);
    loadProductState.mockReturnValue({ projectsById: {} });
    expect(scope.projectCwds()).toEqual([]);
  });

  it('survives a loadProductState that throws', () => {
    const loadProductState = vi.fn(() => {
      throw new Error('disk gone');
    });
    const scope = createAttachmentScope({ loadProductState });
    expect(scope.allow('C:/Project/a.js')).toBe('no');
  });

  it('rejects a workspace symlink/junction that points outside the workspace (H15)', () => {
    const nodeFs = require('node:fs');
    const nodeOs = require('node:os');
    const nodePath = require('node:path');
    const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'attach-scope-'));
    const outside = nodePath.join(root, 'outside');
    const project = nodePath.join(root, 'project');
    nodeFs.mkdirSync(outside);
    nodeFs.mkdirSync(project);
    nodeFs.writeFileSync(nodePath.join(outside, 'secret.env'), 's3cret');
    try {
      if (process.platform === 'win32') {
        // Directory junction inside the workspace → outside dir.
        const junctionDir = nodePath.join(project, 'leak');
        nodeFs.symlinkSync(outside, junctionDir, 'junction');
        const { scope } = makeScope([project]);
        // String-level containment would say "inside"; realpath resolves out.
        expect(scope.allow(nodePath.join(junctionDir, 'secret.env'))).toBe('no');
      } else {
        const linkPath = nodePath.join(project, 'secret.env');
        nodeFs.symlinkSync(nodePath.join(outside, 'secret.env'), linkPath);
        const { scope } = makeScope([project]);
        expect(scope.allow(linkPath)).toBe('no');
      }
      // A real file inside the workspace stays allowed.
      nodeFs.writeFileSync(nodePath.join(project, 'real.env'), 'ok');
      const { scope: scope2 } = makeScope([project]);
      expect(scope2.allow(nodePath.join(project, 'real.env'))).toBe('workspace');
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });
});