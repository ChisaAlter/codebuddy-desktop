import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createProductStateSaveController } = require('../../electron/product-state-save-controller.cjs');

function createTimers() {
  const callbacks = [];
  return {
    callbacks,
    setTimer(callback) {
      callbacks.push(callback);
      return callback;
    },
    clearTimer(timer) {
      const index = callbacks.indexOf(timer);
      if (index >= 0) callbacks.splice(index, 1);
    },
  };
}

describe('product state save controller', () => {
  it('coalesces a window to the latest snapshot and settles every caller', async () => {
    const timers = createTimers();
    const store = {
      save: vi.fn().mockResolvedValue({ ok: true, generation: 1, disposition: 'committed' }),
      saveSync: vi.fn(),
    };
    const controller = createProductStateSaveController({ store, ...timers });

    const first = controller.request({ step: 1 });
    const second = controller.request({ step: 2 });
    expect(timers.callbacks).toHaveLength(1);
    timers.callbacks.shift()();

    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).resolves.toMatchObject({ ok: true });
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(store.save).toHaveBeenCalledWith({ step: 2 });
  });

  it('settles a pending async window when a sync save supersedes it', async () => {
    const timers = createTimers();
    const store = {
      save: vi.fn(),
      saveSync: vi.fn().mockReturnValue({ ok: true, generation: 2, disposition: 'committed' }),
    };
    const controller = createProductStateSaveController({ store, ...timers });

    const pending = controller.request({ step: 1 });
    expect(controller.saveSync({ step: 2 })).toMatchObject({ ok: true, disposition: 'committed' });
    await expect(pending).resolves.toMatchObject({
      ok: true,
      disposition: 'superseded',
      supersededWindow: true,
    });
    expect(timers.callbacks).toHaveLength(0);
    expect(store.save).not.toHaveBeenCalled();
  });

  it('returns structured failures for thrown and malformed store results', async () => {
    const timers = createTimers();
    const store = {
      save: vi.fn().mockRejectedValue(new Error('disk full')),
      saveSync: vi.fn().mockReturnValue(null),
    };
    const controller = createProductStateSaveController({ store, ...timers });

    const pending = controller.request({ step: 1 });
    timers.callbacks.shift()();
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'WRITE_FAILED', error: 'disk full' });
    expect(controller.saveSync({ step: 2 })).toMatchObject({ ok: false, code: 'INVALID_RESULT' });
  });
});
