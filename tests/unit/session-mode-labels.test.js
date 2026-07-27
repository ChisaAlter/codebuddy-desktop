import { describe, expect, it } from 'vitest';
import {
  getSessionModeLabel,
  isCliPermissionBypassMode,
  isFullAccessMode,
  isUltracodeEffort,
} from '../../src/lib/session-mode-labels';

describe('session mode labels', () => {
  it('maps known mode ids to Chinese labels', () => {
    expect(getSessionModeLabel('fullAccess')).toBe('完全访问');
    expect(getSessionModeLabel('bypassPermissions')).toBe('跳过权限确认');
    expect(getSessionModeLabel('default')).toBe('始终询问');
  });

  it('identifies CLI-side permission bypass modes (not GUI auto-approve)', () => {
    expect(isCliPermissionBypassMode('fullAccess')).toBe(true);
    expect(isCliPermissionBypassMode('fullAccessMode')).toBe(true);
    expect(isCliPermissionBypassMode('bypassPermissions')).toBe(true);
    expect(isCliPermissionBypassMode('bypassPermissionsMode')).toBe(true);
    expect(isCliPermissionBypassMode('default')).toBe(false);
    expect(isCliPermissionBypassMode('acceptEdits')).toBe(false);
    expect(isCliPermissionBypassMode('plan')).toBe(false);
    expect(isCliPermissionBypassMode('auto')).toBe(false);
  });

  it('flags full access for orange composer highlight', () => {
    expect(isFullAccessMode('fullAccess')).toBe(true);
    expect(isFullAccessMode('fullAccessMode')).toBe(true);
    expect(isFullAccessMode('bypassPermissions')).toBe(false);
    expect(isFullAccessMode('default')).toBe(false);
  });

  it('flags ultracode effort for orange composer highlight', () => {
    expect(isUltracodeEffort('ultracode')).toBe(true);
    expect(isUltracodeEffort('Ultracode')).toBe(true);
    expect(isUltracodeEffort('high')).toBe(false);
  });

  // L18: an unknown mode id returns the caller's fallback rather than leaking
  // the raw internal id into the UI. With no fallback, the id is the last resort.
  it('returns fallback for unknown modes instead of leaking the raw id', () => {
    expect(getSessionModeLabel('custom_xyz', '未知')).toBe('未知');
    expect(getSessionModeLabel({ id: 'weird', name: 'Weird' }, '默认')).toBe('Weird');
    // No fallback + unknown id → id is still returned (preserves existing no-fallback call sites).
    expect(getSessionModeLabel('custom_xyz')).toBe('custom_xyz');
  });
});
