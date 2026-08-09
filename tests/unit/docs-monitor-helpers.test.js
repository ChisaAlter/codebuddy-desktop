import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  docsLangFromLocale,
  extractHeadings,
  firstDocsLink,
  flattenChildren,
  headingIdFromText,
  normalizeDocsPath,
} from '../../src/components/ReplicaDocsView.jsx';
import {
  formatDiskUsage,
  unwrapPayload,
} from '../../src/components/ReplicaMonitorView.jsx';

describe('ReplicaDocsView helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('detects docs language from navigator locales', () => {
    vi.stubGlobal('navigator', { languages: ['en-US', 'zh-CN'], language: 'en-US' });
    expect(docsLangFromLocale()).toBe('zh');
    vi.stubGlobal('navigator', { languages: ['en-US'], language: 'en-US' });
    expect(docsLangFromLocale()).toBe('en');
  });

  it('finds the first nested docs link', () => {
    expect(firstDocsLink(null)).toBeNull();
    expect(
      firstDocsLink([
        { text: 'A', items: [{ text: 'A1' }, { text: 'A2', link: '/docs/a2' }] },
        { text: 'B', link: '/docs/b' },
      ]),
    ).toBe('/docs/a2');
  });

  it('normalizes docs paths', () => {
    expect(normalizeDocsPath('')).toBeNull();
    expect(normalizeDocsPath('guide/start')).toBe('/guide/start');
    expect(normalizeDocsPath('//guide//start/')).toBe('/guide/start/');
  });

  it('extracts markdown headings while ignoring fenced code', () => {
    const md = ['# Title', '## One', '```', '## not-a-heading', '```', '### Two', '## 中文标题'].join('\n');
    const headings = extractHeadings(md);
    expect(headings.map((item) => item.text)).toEqual(['One', 'Two', '中文标题']);
    expect(headings[0].level).toBe(2);
    expect(headings[1].level).toBe(3);
    expect(headings[2].id).toContain('中文');
  });

  it('produces identical heading ids from raw markdown and React children', () => {
    // Regression: heading renderers used String(children), which yields
    // "[object Object]" for inline <code> nodes — TOC anchors broke and every
    // code-bearing heading got the same bogus id.
    const md = '## 安装 `codebuddy` CLI\n### 配置 ~/.codebuddy 目录\n';
    const headings = extractHeadings(md);
    expect(headings[0].id).toBe('安装-codebuddy-cli');
    expect(headings[1].id).toBe('配置-codebuddy-目录');

    const h2Children = ['安装 ', React.createElement('code', null, 'codebuddy'), ' CLI'];
    const h3Children = ['配置 ', React.createElement('code', null, '~/.codebuddy'), ' 目录'];
    expect(flattenChildren(h2Children)).toBe('安装 codebuddy CLI');
    expect(flattenChildren(h3Children)).toBe('配置 ~/.codebuddy 目录');
    // The renderer id must match the TOC id computed from the raw markdown.
    expect(headingIdFromText(flattenChildren(h2Children))).toBe(headings[0].id);
    expect(headingIdFromText(flattenChildren(h3Children))).toBe(headings[1].id);
    // No [object Object] anywhere.
    expect(headingIdFromText(flattenChildren(h2Children))).not.toContain('object');
  });
});

describe('ReplicaMonitorView helpers', () => {
  it('unwraps API payloads', () => {
    expect(unwrapPayload({ data: { ok: 1 } })).toEqual({ ok: 1 });
    expect(unwrapPayload({ ok: 2 })).toEqual({ ok: 2 });
    expect(unwrapPayload(null)).toBeNull();
  });

  it('formats disk usage from GiB fields or raw bytes', () => {
    expect(formatDiskUsage(null)).toBe('-');
    expect(formatDiskUsage({ diskUsedGiB: 1.25, diskTotalGiB: 10 })).toBe('1.3 / 10.0 GiB');
    const oneGiB = 1024 * 1024 * 1024;
    expect(formatDiskUsage({ diskUsed: oneGiB, diskTotal: 2 * oneGiB })).toBe('1.0 / 2.0 GiB');
    expect(formatDiskUsage({ diskUsed: 'x', diskTotal: 'y' })).toBe('-');
  });
});
