import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  isTrustedRendererNavigation,
  normalizeExternalHttpUrl,
  rendererOriginForEntry,
} = require('../../electron/navigation-policy.cjs');

describe('Electron renderer navigation policy', () => {
  it('accepts only local HTTP renderer entries', () => {
    expect(rendererOriginForEntry('http://127.0.0.1:5173/index.html')).toBe('http://127.0.0.1:5173');
    expect(rendererOriginForEntry('http://localhost:5173/')).toBe('http://localhost:5173');
    expect(() => rendererOriginForEntry('https://example.com/app')).toThrow(/local HTTP origin/);
    expect(() => rendererOriginForEntry('file:///tmp/index.html')).toThrow(/local HTTP origin/);
  });

  it('allows same-origin routes and blocks remote or malformed navigation', () => {
    const origin = rendererOriginForEntry('http://127.0.0.1:5173/index.html');
    expect(isTrustedRendererNavigation('http://127.0.0.1:5173/#/chat', origin)).toBe(true);
    expect(isTrustedRendererNavigation('http://127.0.0.1:5174/#/chat', origin)).toBe(false);
    expect(isTrustedRendererNavigation('https://example.com/', origin)).toBe(false);
    expect(isTrustedRendererNavigation('not a url', origin)).toBe(false);
  });

  it('opens only credential-free HTTP(S) URLs outside the app', () => {
    expect(normalizeExternalHttpUrl('https://example.com/docs')).toBe('https://example.com/docs');
    expect(normalizeExternalHttpUrl('http://localhost:3000/')).toBe('http://localhost:3000/');
    expect(normalizeExternalHttpUrl('file:///C:/Windows/System32/calc.exe')).toBeNull();
    expect(normalizeExternalHttpUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeExternalHttpUrl('mailto:test@example.com')).toBeNull();
    expect(normalizeExternalHttpUrl('https://user:secret@example.com/')).toBeNull();
    expect(normalizeExternalHttpUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(normalizeExternalHttpUrl('blob:https://example.com/id')).toBeNull();
    expect(normalizeExternalHttpUrl('https://example.com/%0A/malformed')).toBe('https://example.com/%0A/malformed');
  });
});
