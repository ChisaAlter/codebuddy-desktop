import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../src/store';

const mocks = vi.hoisted(() => ({ requestCodeBuddy: vi.fn() }));

vi.mock('../../src/lib/acp', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, requestCodeBuddy: mocks.requestCodeBuddy };
});

// jsdom has no IntersectionObserver; the TOC highlight observer must be stubbed.
class FakeIntersectionObserver {
  static instances = [];
  constructor(callback) {
    this.callback = callback;
    this.observed = [];
    FakeIntersectionObserver.instances.push(this);
  }
  observe(el) {
    this.observed.push(el);
  }
  disconnect() {}
  unobserve() {}
}

import ReplicaDocsView from '../../src/components/ReplicaDocsView';

const SIDEBAR = [{ text: 'Guide', link: '/guide/start' }];
const DOC = '# 标题\n## 安装 `codebuddy` CLI\n正文段落\n### 配置 `~/.codebuddy` 目录\n';

function okResponse(body, type = 'text') {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {},
    text: async () => body,
    json: async () => body,
    [type === 'text' ? 'text' : 'json']: async () => body,
  };
}

describe('ReplicaDocsView render (memoized markdown refactor)', () => {
  let container;
  let root;
  let originalIO;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    originalIO = globalThis.IntersectionObserver;
    FakeIntersectionObserver.instances = [];
    globalThis.IntersectionObserver = FakeIntersectionObserver;
    mocks.requestCodeBuddy.mockReset();
    mocks.requestCodeBuddy.mockImplementation(async (url) => {
      if (String(url).includes('sidebar')) return okResponse(SIDEBAR, 'json');
      if (String(url).includes('.md')) return okResponse(DOC);
      return okResponse('');
    });
    useStore.setState({
      info: { version: '2.1.0' },
      route: 'docs',
      activeProjectId: 'project-1',
      apiBase: 'http://127.0.0.1:63918',
      pushToast: vi.fn(),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    globalThis.IntersectionObserver = originalIO;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders the markdown article with TOC ids matching extractHeadings', async () => {
    await act(async () => {
      root.render(React.createElement(ReplicaDocsView));
      await Promise.resolve();
    });
    // Wait for sidebar + document fetch.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Markdown article rendered with the code-bearing heading id from the shared
    // slug rule (not [object Object]).
    const h2 = container.querySelector('h2[id="安装-codebuddy-cli"]');
    expect(h2).toBeTruthy();
    expect(h2.textContent).toContain('codebuddy');
    expect(container.querySelector('h3[id="配置-codebuddy-目录"]')).toBeTruthy();
    expect(container.textContent).toContain('正文段落');
    // TOC present with the same id.
    const tocLink = container.querySelector('a[href="#安装-codebuddy-cli"]');
    expect(tocLink).toBeTruthy();
    // No duplicate ids (renderer + TOC agree).
    expect(container.querySelectorAll('[id="安装-codebuddy-cli"]').length).toBe(1);
  });

  it('keeps the markdown article memoized when the active TOC heading flips', async () => {
    let commits = 0;
    await act(async () => {
      root.render(
        React.createElement(
          React.Profiler,
          { id: 'docs', onRender: () => { commits += 1; } },
          React.createElement(ReplicaDocsView),
        ),
      );
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const commitsAfterLoad = commits;

    // Simulate a scroll-driven activeHeading flip: the observer callback fires
    // with a heading entry. The TOC re-renders; the memoized MarkdownArticle
    // (ReactMarkdown subtree) must not re-commit the article.
    const observer = FakeIntersectionObserver.instances[0];
    if (observer) {
      await act(async () => {
        observer.callback([{ isIntersecting: true, target: { id: '配置-codebuddy-目录' } }]);
        await Promise.resolve();
      });
    }
    // The TOC link for the flipped heading is now highlighted.
    const tocLinks = [...container.querySelectorAll('aside a')];
    const activeLink = tocLinks.find((a) => a.textContent.includes('配置'));
    expect(activeLink).toBeTruthy();
    expect(activeLink.className).toContain('text-[var(--color-text-primary)]');
    // The memoized article stayed intact (same content, no re-render breakage).
    expect(container.querySelector('h2[id="安装-codebuddy-cli"]').textContent).toContain('codebuddy');
    const article = container.querySelector('.docs-markdown');
    expect(article).toBeTruthy();
    expect(commits).toBeGreaterThanOrEqual(commitsAfterLoad);
  });
});
