import { describe, expect, it } from 'vitest';
import { effectiveAutoCompactWindow, normalizeAutoCompactWindow } from '../../src/lib/autocompact.js';

describe('autocompact (G12 window baseline)', () => {
  it('normalizes only positive finite numbers', () => {
    expect(normalizeAutoCompactWindow(128000)).toBe(128000);
    expect(normalizeAutoCompactWindow('64000')).toBe(64000);
    expect(normalizeAutoCompactWindow(1.9)).toBe(1);
    expect(normalizeAutoCompactWindow(0)).toBeNull();
    expect(normalizeAutoCompactWindow(-5)).toBeNull();
    expect(normalizeAutoCompactWindow('abc')).toBeNull();
    expect(normalizeAutoCompactWindow(null)).toBeNull();
  });

  it('effective window = min(setting, model window); falls back to whichever exists', () => {
    expect(effectiveAutoCompactWindow(64000, 200000)).toBe(64000);
    expect(effectiveAutoCompactWindow(256000, 200000)).toBe(200000);
    expect(effectiveAutoCompactWindow(null, 200000)).toBe(200000);
    expect(effectiveAutoCompactWindow(64000, null)).toBe(64000);
    expect(effectiveAutoCompactWindow(null, null)).toBeNull();
  });
});
