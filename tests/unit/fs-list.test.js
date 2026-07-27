import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the acp fetchJson so fsList can be tested in isolation.
vi.mock('../../src/lib/acp', () => ({
  fetchJson: vi.fn(),
  requestCodeBuddy: vi.fn(),
}));

import { fetchJson } from '../../src/lib/acp';
import { fsList, joinPath } from '../../src/lib/fs';

describe('fsList depth cap', () => {
  beforeEach(() => {
    fetchJson.mockReset();
  });

  it('caps depth at 10 to bound the backend payload', async () => {
    fetchJson.mockResolvedValue({ data: { entries: [] } });
    await fsList('.', 9999);
    const body = JSON.parse(fetchJson.mock.calls[0][1].body);
    expect(body.depth).toBe(10);
  });

  it('passes through depths within the cap', async () => {
    fetchJson.mockResolvedValue({ data: { entries: [] } });
    await fsList('.', 3);
    const body = JSON.parse(fetchJson.mock.calls[0][1].body);
    expect(body.depth).toBe(3);
  });

  it('clamps a non-finite depth to 1', async () => {
    fetchJson.mockResolvedValue({ data: { entries: [] } });
    await fsList('.', NaN);
    const body = JSON.parse(fetchJson.mock.calls[0][1].body);
    expect(body.depth).toBe(1);
  });
});

describe('joinPath', () => {
  it('joins base and child', () => {
    expect(joinPath('a', 'b')).toBe('a/b');
  });

  it('returns child when base is empty or "."', () => {
    expect(joinPath('', 'b')).toBe('b');
    expect(joinPath('.', 'b')).toBe('b');
  });
});