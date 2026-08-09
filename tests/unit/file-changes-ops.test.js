import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchJson: vi.fn(),
  requestCodeBuddy: vi.fn(),
}));

vi.mock('../../src/lib/acp', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchJson: mocks.fetchJson, requestCodeBuddy: mocks.requestCodeBuddy };
});

import {
  REVERT_SCOPES,
  extractCheckpointFilePaths,
  fetchFileChangeCheckpoints,
  fetchFileChangeDiff,
  normalizeCheckpointRecord,
  revertFileChanges,
} from '../../src/lib/file-changes';
import { truncateDiffLines } from '../../src/components/ReplicaChangesView.jsx';

describe('file-changes API client', () => {
  beforeEach(() => {
    mocks.fetchJson.mockReset();
    mocks.requestCodeBuddy.mockReset();
  });

  it('exports supported revert scopes', () => {
    expect([...REVERT_SCOPES].sort()).toEqual(['Code', 'CodeAndConversation', 'Conversation']);
  });

  it('fetchFileChangeDiff posts path', async () => {
    mocks.fetchJson.mockResolvedValue({ data: { diff: '+a' } });
    await fetchFileChangeDiff('src/a.js');
    expect(mocks.fetchJson).toHaveBeenCalledWith('/internal/file-changes/diff', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ path: 'src/a.js' }),
    }));
  });

  it('fetchFileChangeCheckpoints normalizes list', async () => {
    mocks.fetchJson.mockResolvedValue({ data: { checkpoints: [{ id: 'c1' }] } });
    await expect(fetchFileChangeCheckpoints()).resolves.toEqual([
      { id: 'c1', paths: [], files: undefined },
    ]);
  });

  it('extracts absolute uris from nested fileChanges (live 2.125 event shape)', () => {
    const paths = extractCheckpointFilePaths({
      id: 'cp',
      fileChanges: {
        files: [{ uri: 'C:\\tmp\\target.txt', changeType: 'modified' }],
      },
    });
    expect(paths).toEqual(['C:\\tmp\\target.txt']);
    const normalized = normalizeCheckpointRecord({
      id: 'cp',
      fileChanges: { files: [{ uri: 'C:\\tmp\\target.txt' }] },
    });
    expect(normalized.paths).toEqual(['C:\\tmp\\target.txt']);
  });

  it('fetchFileChangeDiff accepts absolute path for 2.125 tracking', async () => {
    mocks.fetchJson.mockResolvedValue({
      data: {
        path: 'C:\\tmp\\target.txt',
        oldText: 'a\n',
        newText: 'b\n',
      },
    });
    const payload = await fetchFileChangeDiff('C:\\tmp\\target.txt');
    expect(payload).toMatchObject({ path: 'C:\\tmp\\target.txt', oldText: 'a\n', newText: 'b\n' });
  });

  it('revertFileChanges supports paths and checkpoint scopes', async () => {
    mocks.requestCodeBuddy.mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(JSON.stringify({ ok: true })),
    });
    await revertFileChanges({ paths: ['a.ts'] });
    expect(mocks.requestCodeBuddy).toHaveBeenCalledWith(
      '/internal/file-changes/revert',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ paths: ['a.ts'] }),
      }),
    );

    await revertFileChanges({ checkpointId: 'cp-1', scope: 'CodeAndConversation' });
    expect(mocks.requestCodeBuddy).toHaveBeenLastCalledWith(
      '/internal/file-changes/revert',
      expect.objectContaining({
        body: JSON.stringify({ checkpointId: 'cp-1', scope: 'CodeAndConversation' }),
      }),
    );
  });

  it('rejects invalid checkpoint scope', async () => {
    await expect(revertFileChanges({ checkpointId: 'x', scope: 'Nope' })).rejects.toThrow(/无效的回退范围/);
  });
});

describe('truncateDiffLines (M-perf diff bound)', () => {
  it('keeps small diffs untouched', () => {
    const lines = ['a', 'b', 'c'];
    expect(truncateDiffLines(lines)).toBe(lines);
  });

  it('projects head + tail with a truncation notice for huge diffs', () => {
    const lines = Array.from({ length: 6000 }, (_, i) => `line-${i}`);
    const visible = truncateDiffLines(lines, 10);
    expect(visible.length).toBe(21); // 10 head + 1 notice + 10 tail
    expect(visible[0]).toBe('line-0');
    expect(visible[9]).toBe('line-9');
    expect(visible[10]).toContain('中间 5980 行已省略');
    expect(visible[11]).toBe('line-5990');
    expect(visible[20]).toBe('line-5999');
  });

  it('handles non-array input defensively', () => {
    expect(truncateDiffLines(null)).toEqual([]);
    expect(truncateDiffLines(undefined)).toEqual([]);
  });
});
