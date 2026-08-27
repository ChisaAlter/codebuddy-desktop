import { describe, expect, it } from 'vitest';
import {
  BUSY_SEND_MODE_KEY,
  busySendModeFromSettings,
  normalizeBusySendMode,
  shouldQueueBusyPrompt,
} from '../../src/lib/busy-send.js';

describe('busy-send (WebUI 2.138 busySendMode semantics)', () => {
  it('normalizes only queue/immediate', () => {
    expect(normalizeBusySendMode('queue')).toBe('queue');
    expect(normalizeBusySendMode('immediate')).toBe('immediate');
    expect(normalizeBusySendMode('later')).toBeUndefined();
    expect(normalizeBusySendMode(null)).toBeUndefined();
  });

  it('reads nested settings key with queue default', () => {
    expect(BUSY_SEND_MODE_KEY).toBe('codebuddy.composer.busySendMode');
    expect(busySendModeFromSettings(undefined)).toBe('queue');
    expect(busySendModeFromSettings({})).toBe('queue');
    expect(busySendModeFromSettings({ codebuddy: { composer: { busySendMode: 'immediate' } } })).toBe('immediate');
    expect(busySendModeFromSettings({ codebuddy: { composer: { busySendMode: 'bogus' } } })).toBe('queue');
  });

  it('queue mode always queues; immediate injects except slash commands (WebUI Hk)', () => {
    expect(shouldQueueBusyPrompt('queue', 'hello')).toBe(true);
    expect(shouldQueueBusyPrompt('immediate', 'hello')).toBe(false);
    expect(shouldQueueBusyPrompt('immediate', '/goal all tests pass')).toBe(true);
    expect(shouldQueueBusyPrompt('immediate', '/compact')).toBe(true);
    expect(shouldQueueBusyPrompt('immediate', 'a /slash later')).toBe(false);
    // unknown mode falls back to queue semantics
    expect(shouldQueueBusyPrompt(undefined, 'hello')).toBe(true);
  });
});
