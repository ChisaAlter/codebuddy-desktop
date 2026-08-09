import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { requestCodeBuddy } from '../lib/acp';
import { useStore } from '../store';

export function docsLangFromLocale() {
  try {
    const languages = Array.isArray(navigator.languages) ? navigator.languages : [];
    const candidates = [...languages, navigator.language].filter(Boolean);
    if (candidates.some((item) => String(item).toLowerCase().startsWith('zh'))) return 'zh';
  } catch (_) {}
  return 'en';
}

export function firstDocsLink(items) {
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.link) return item.link;
    if (item?.items?.length) {
      const nested = firstDocsLink(item.items);
      if (nested) return nested;
    }
  }
  return null;
}

export function normalizeDocsPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withSlash.replace(/\/+/g, '/');
}

/**
 * Recursively collect text from React children (heading renderers receive node
 * arrays: `['安装 ', <code>codebuddy</code>, ' CLI']`; String() on those yields
 * `[object Object]`, which used to produce broken `usage-of-object-object` ids
 * that never matched the TOC and created duplicate DOM ids).
 */
export function flattenChildren(children) {
  const parts = [];
  const visit = (node) => {
    if (node == null || typeof node === 'boolean') return;
    if (typeof node === 'string' || typeof node === 'number') parts.push(String(node));
    else if (Array.isArray(node)) node.forEach(visit);
    else if (React.isValidElement(node)) visit(node.props?.children);
  };
  visit(children);
  return parts.join('');
}

/** Shared slug rule: extractHeadings (raw markdown text) and the heading
 * renderers (React children) must produce identical ids or TOC anchors break. */
export function headingIdFromText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff\s-]/g, '')
    .replace(/\s+/g, '-');
}

export function extractHeadings(markdown) {
  const lines = String(markdown || '').split('\n');
  const headings = [];
  let inCode = false;
  for (const line of lines) {
    if (line.startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const match = line.match(/^(#{2,3})\s+(.+)$/);
    if (!match) continue;
    const text = match[2].trim();
    const id = headingIdFromText(text);
    headings.push({ id, text, level: match[1].length });
  }
  return headings;
}

function DocsTreeItem({ item, currentPath, onSelect, depth = 0 }) {
  const hasChildren = Array.isArray(item?.items) && item.items.length > 0;
  const [expanded, setExpanded] = useState(!item?.collapsed);
  const active = item?.link === currentPath;
  const groupOnly = hasChildren && !item?.link;

  const onClick = () => {
    if (item?.link) onSelect(item.link);
    if (hasChildren) setExpanded((value) => !value);
  };

  if (groupOnly && depth === 0) {
    return (
      <div className="mt-3 first:mt-0">
        <button
          type="button"
          onClick={onClick}
          className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
        >
          <span className={`transition-transform ${expanded ? 'rotate-90' : ''}`}>▸</span>
          <span className="truncate">{item.text || item.title || '章节'}</span>
        </button>
        {expanded
          ? item.items.map((child, index) => (
              <DocsTreeItem
                key={child.link || `${child.text || child.title}-${index}`}
                item={child}
                currentPath={currentPath}
                onSelect={onSelect}
                depth={depth + 1}
              />
            ))
          : null}
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        className={`flex w-full items-center gap-1.5 rounded-md px-3 py-1.5 text-left text-xs transition-colors ${
          active
            ? 'bg-[var(--color-accent-primary-dim)] text-[var(--color-text-primary)]'
            : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]'
        }`}
        style={{ paddingLeft: `${12 + depth * 12}px` }}
      >
        {hasChildren ? <span className={`text-[10px] transition-transform ${expanded ? 'rotate-90' : ''}`}>▸</span> : null}
        <span className="truncate">{item.text || item.title || item.link || '文档'}</span>
      </button>
      {hasChildren && expanded
        ? item.items.map((child, index) => (
            <DocsTreeItem
              key={child.link || `${child.text || child.title}-${index}`}
              item={child}
              currentPath={currentPath}
              onSelect={onSelect}
              depth={depth + 1}
            />
          ))
        : null}
    </div>
  );
}

/**
 * M-perf: the markdown article is memoized so TOC scroll-highlight updates
 * (activeHeading flips while scrolling) re-render only the TOC, not the whole
 * ReactMarkdown tree. `components` must stay referentially stable (useMemo in
 * DocsMarkdown) or the memo is defeated.
 */
const MarkdownArticle = React.memo(function MarkdownArticle({ content, components }) {
  const containerRef = useRef(null);

  useEffect(() => {
    containerRef.current?.scrollTo?.(0, 0);
  }, [content]);

  return (
    <div ref={containerRef} className="min-w-0 flex-1 overflow-y-auto px-6 py-6">
      <article className="docs-markdown mx-auto max-w-3xl">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {content}
        </ReactMarkdown>
      </article>
    </div>
  );
});

function DocsToc({ headings, activeHeading }) {
  if (!headings.length) return null;
  return (
    <aside className="hidden w-52 shrink-0 overflow-y-auto border-l border-[var(--color-border-muted)] px-3 py-6 xl:block">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">目录</div>
      <div className="space-y-1">
        {headings.map((heading) => (
          <a
            key={`${heading.level}-${heading.id}`}
            href={`#${heading.id}`}
            className={`block truncate text-xs transition-colors ${
              activeHeading === heading.id
                ? 'text-[var(--color-text-primary)]'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
            }`}
            style={{ paddingLeft: heading.level === 3 ? 12 : 0 }}
            onClick={(event) => {
              event.preventDefault();
              document.getElementById(heading.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
          >
            {heading.text}
          </a>
        ))}
      </div>
    </aside>
  );
}

function DocsMarkdown({ content, onNavigate }) {
  const headings = useMemo(() => extractHeadings(content), [content]);
  const [activeHeading, setActiveHeading] = useState('');

  useEffect(() => {
    if (!headings.length) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActiveHeading(entry.target.id);
        }
      },
      { rootMargin: '-80px 0px -70% 0px' },
    );
    for (const heading of headings) {
      const node = document.getElementById(heading.id);
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [headings]);

  // M-perf: stable components mapping — without useMemo every DocsMarkdown
  // render (e.g. each scroll-driven activeHeading flip) would build a new
  // components object and force the memoized MarkdownArticle to re-render.
  const handleInternalLink = (event) => {
    const href = event.currentTarget.getAttribute('href');
    if (!href?.startsWith('/cli/')) return;
    event.preventDefault();
    onNavigate(href);
  };

  const components = useMemo(
    () => ({
      h1: ({ children, ...props }) => (
        <h1 className="mb-4 text-2xl font-bold text-[var(--color-text-primary)]" {...props}>
          {children}
        </h1>
      ),
      h2: ({ children, ...props }) => {
        const id = headingIdFromText(flattenChildren(children));
        return (
          <h2 id={id} className="mb-3 mt-8 scroll-mt-20 text-xl font-semibold text-[var(--color-text-primary)]" {...props}>
            {children}
          </h2>
        );
      },
      h3: ({ children, ...props }) => {
        const id = headingIdFromText(flattenChildren(children));
        return (
          <h3 id={id} className="mb-2 mt-6 scroll-mt-20 text-lg font-medium text-[var(--color-text-primary)]" {...props}>
            {children}
          </h3>
        );
      },
      p: ({ children, ...props }) => (
        <p className="mb-4 text-sm leading-7 text-[var(--color-text-secondary)]" {...props}>
          {children}
        </p>
      ),
      a: ({ children, href, ...props }) => (
        <a
          href={href}
          onClick={href?.startsWith('/cli/') ? handleInternalLink : undefined}
          className="text-[var(--color-accent-brand)] hover:underline"
          target={href?.startsWith('http') ? '_blank' : undefined}
          rel={href?.startsWith('http') ? 'noopener noreferrer' : undefined}
          {...props}
        >
          {children}
        </a>
      ),
      ul: ({ children, ...props }) => (
        <ul className="mb-4 list-disc space-y-1 pl-5 text-sm text-[var(--color-text-secondary)]" {...props}>
          {children}
        </ul>
      ),
      ol: ({ children, ...props }) => (
        <ol className="mb-4 list-decimal space-y-1 pl-5 text-sm text-[var(--color-text-secondary)]" {...props}>
          {children}
        </ol>
      ),
      code: ({ className, children, ...props }) => {
        const language = /language-(\w+)/.exec(className || '')?.[1];
        const text = String(children).replace(/\n$/, '');
        if (language) {
          return (
            <pre className="my-3 overflow-x-auto rounded-lg border border-[var(--color-border-muted)] bg-[var(--color-bg-secondary)] p-3 text-[13px] leading-6 text-[var(--color-text-secondary)]">
              <code {...props}>{text}</code>
            </pre>
          );
        }
        return (
          <code
            className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[13px] text-[var(--color-text-primary)]"
            {...props}
          >
            {children}
          </code>
        );
      },
      table: ({ children, ...props }) => (
        <div className="markdown-table-wrap my-4 overflow-x-auto">
          <table className="min-w-full text-left text-sm" {...props}>
            {children}
          </table>
        </div>
      ),
    }),
    // Stable across renders: onNavigate is a stable parent callback.
    [onNavigate],
  );

  return (
    <div className="flex h-full min-h-0 gap-6">
      <MarkdownArticle content={content} components={components} />
      <DocsToc headings={headings} activeHeading={activeHeading} />
    </div>
  );
}

export default function ReplicaDocsView() {
  const info = useStore((state) => state.info);
  const lang = docsLangFromLocale();
  const contentLang = lang === 'zh' ? 'cn' : 'en';
  const [sidebar, setSidebar] = useState(null);
  const [sidebarLoading, setSidebarLoading] = useState(true);
  const [sidebarError, setSidebarError] = useState(null);
  const [currentPath, setCurrentPath] = useState(null);
  const [content, setContent] = useState(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState(null);
  const loadSeqRef = useRef(0);

  const subtitle = info?.version && info.version !== 'dev'
    ? `CodeBuddy Code CLI v${String(info.version).replace(/^v/i, '')}`
    : 'CodeBuddy Code CLI';

  const loadDocument = useCallback(async (path) => {
    const normalized = normalizeDocsPath(path);
    if (!normalized) return;
    const seq = ++loadSeqRef.current;
    setCurrentPath(normalized);
    setContentLoading(true);
    setContentError(null);
    try {
      const response = await requestCodeBuddy(`/docs/${contentLang}${normalized}.md`, {
        method: 'GET',
        omitAcpSessionToken: true,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (loadSeqRef.current !== seq) return;
      setContent(text);
      setContentLoading(false);
    } catch (error) {
      if (loadSeqRef.current !== seq) return;
      setContent(null);
      setContentLoading(false);
      setContentError(error?.message || normalized);
    }
  }, [contentLang]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setSidebarLoading(true);
      setSidebarError(null);
      try {
        const response = await requestCodeBuddy(`/docs/sidebar-${lang}.json`, {
          method: 'GET',
          omitAcpSessionToken: true,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (cancelled) return;
        const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
        setSidebar(items);
        setSidebarLoading(false);
        const initial = firstDocsLink(items);
        if (initial) await loadDocument(initial);
      } catch (error) {
        if (cancelled) return;
        setSidebar(null);
        setSidebarLoading(false);
        setSidebarError(error?.message || '文档目录加载失败');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lang, loadDocument]);

  const openApiDocs = async () => {
    try {
      const base = String(useStore.getState().apiBase || '').replace(/\/$/, '');
      if (!base) throw new Error('当前运行时未连接');
      const target = `${base}/api/docs`;
      if (window.electronAPI?.openBackgroundSessionEndpoint) {
        await window.electronAPI.openBackgroundSessionEndpoint(target);
        return;
      }
      window.open(target, '_blank', 'noopener,noreferrer');
    } catch (error) {
      useStore.getState().pushToast?.({
        type: 'error',
        message: error?.message || '无法打开 API 文档',
      });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--color-bg-primary)]">
      <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-border-default)] px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">文档中心</h1>
          <p className="mt-0.5 text-sm text-[var(--color-text-muted)]">{subtitle}</p>
        </div>
        <button
          type="button"
          className="hidden items-center gap-1.5 rounded-lg border border-[var(--color-border-default)] px-3 py-2 text-sm text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent-brand)]/50 hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text-primary)] sm:flex"
          onClick={openApiDocs}
        >
          API 文档
        </button>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="hidden w-64 shrink-0 overflow-y-auto border-r border-[var(--color-border-default)] bg-[var(--color-bg-primary)] md:block">
          {sidebarLoading ? (
            <div className="px-4 py-8 text-sm text-[var(--color-text-muted)]">加载中...</div>
          ) : sidebarError ? (
            <div className="px-4 py-8 text-sm text-[var(--color-text-muted)]">{sidebarError}</div>
          ) : sidebar?.length ? (
            <nav className="py-2">
              {sidebar.map((item, index) => (
                <DocsTreeItem
                  key={item.link || `${item.text || item.title}-${index}`}
                  item={item}
                  currentPath={currentPath}
                  onSelect={loadDocument}
                />
              ))}
            </nav>
          ) : (
            <div className="px-4 py-8 text-sm text-[var(--color-text-muted)]">暂无文档目录</div>
          )}
        </aside>

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {contentLoading ? (
            <div className="flex flex-1 items-center justify-center text-sm text-[var(--color-text-muted)]">加载中...</div>
          ) : contentError ? (
            <div className="flex flex-1 flex-col items-center justify-center text-sm text-[var(--color-text-secondary)]">
              <div className="mb-2">未找到该文档</div>
              <div className="text-xs text-[var(--color-text-muted)]">{contentError}</div>
            </div>
          ) : content ? (
            <DocsMarkdown content={content} onNavigate={loadDocument} />
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-[var(--color-text-muted)]">选择左侧文档开始阅读</div>
          )}
        </div>
      </div>
    </div>
  );
}
