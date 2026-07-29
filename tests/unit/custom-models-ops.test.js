import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchJson: vi.fn(),
}));

vi.mock('../../src/lib/acp', () => ({
  getApiBase: () => 'http://127.0.0.1:9',
  fetchJson: mocks.fetchJson,
  requestCodeBuddy: vi.fn(),
}));

import { saveCustomModel } from '../../src/lib/ops';

describe('saveCustomModel visibility', () => {
  beforeEach(() => {
    mocks.fetchJson.mockReset();
    mocks.fetchJson.mockResolvedValue({ models: [] });
  });

  it('defaults visible:false (WebUI whitelist-off path, avoids custom-only whitelist writeback)', async () => {
    await saveCustomModel({ model: { id: 'grok', url: 'http://example/v1' } }, 'http://127.0.0.1:4000');
    expect(mocks.fetchJson).toHaveBeenCalled();
    const [, init] = mocks.fetchJson.mock.calls[0];
    expect(JSON.parse(init.body)).toMatchObject({
      model: { id: 'grok' },
      visible: false,
      global: true,
    });
  });

  it('allows explicit visible:true (opt-in product sync)', async () => {
    await saveCustomModel(
      { model: { id: 'grok', url: 'http://example/v1' }, visible: true },
      'http://127.0.0.1:4000',
    );
    const [, init] = mocks.fetchJson.mock.calls[0];
    expect(JSON.parse(init.body)).toMatchObject({ visible: true });
  });
});
