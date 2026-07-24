import { afterEach, describe, expect, it } from 'vitest';
import {
  isCliBlockedStatus,
  isCliSetupFirstLaunchDone,
  markCliSetupFirstLaunchDone,
  markSessionCliSetupSkipped,
  readSessionCliSetupSkipped,
} from '../../src/lib/cli-setup-gate.js';

describe('cli-setup-gate', () => {
  afterEach(() => {
    try {
      window.localStorage.clear();
      window.sessionStorage.clear();
    } catch {
      // ignore
    }
  });

  it('marks first-launch and session skip flags', () => {
    expect(isCliSetupFirstLaunchDone()).toBe(false);
    expect(readSessionCliSetupSkipped()).toBe(false);

    markCliSetupFirstLaunchDone();
    markSessionCliSetupSkipped();

    expect(isCliSetupFirstLaunchDone()).toBe(true);
    expect(readSessionCliSetupSkipped()).toBe(true);
  });

  it('classifies blocked CLI statuses', () => {
    expect(isCliBlockedStatus('missing')).toBe(true);
    expect(isCliBlockedStatus('outdated')).toBe(true);
    expect(isCliBlockedStatus('unknown')).toBe(true);
    expect(isCliBlockedStatus('ok')).toBe(false);
    expect(isCliBlockedStatus('newer')).toBe(false);
  });
});
