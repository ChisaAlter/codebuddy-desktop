import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import oneDark from 'react-syntax-highlighter/dist/esm/styles/prism/one-dark';
import oneLight from 'react-syntax-highlighter/dist/esm/styles/prism/one-light';
import { ArrowUp, Square } from 'lucide-react';
import { useStore } from '../store';
import { copyTextToClipboard } from '../lib/clipboard';
import {
  getSlashCommandSuggestions,
  slashCommandKeyboardAction,
  slashCommandSelectionText,
} from '../lib/chat-commands';
import {
  getSessionModeLabel,
  isFullAccessMode,
  isUltracodeEffort,
} from '../lib/session-mode-labels';
import {
  isNearBottom as isChatNearBottom,
  resolveChatScrollRestore,
  saveChatScrollPosition,
} from '../lib/chat-scroll';
import { groupTimelineForDisplay } from '../lib/timeline';
import { resolveLocaleMode, translate } from '../lib/i18n';
import { requestSettingsSection } from '../lib/settings-nav';
import { resolveThreadTimeline } from '../store/helpers/thread-runtime';

/** Survives route unmount so returning from settings restores transcript position. */
const chatScrollMemoryByThreadId = new Map();

function useResolvedTheme() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || 'dark');
  useEffect(() => {
    const el = document.documentElement;
    const update = () => setTheme(el.dataset.theme || 'dark');
    update();
    const observer = new MutationObserver(update);
    observer.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return theme === 'light' ? 'light' : 'dark';
}

function MarkdownTable(props) {
  const { node, children, ...tableProps } = props;
  void node;
  return (
    <div className="markdown-table-wrapper">
      <table {...tableProps}>{children}</table>
    </div>
  );
}

/** 切换 mode/model/effort 时 pill 文案 3D 翻转，不依赖 framer-motion */
function FlipLabel({ value, className = '', special = false }) {
  return (
    <span
      className={`composer-flip-label${special ? ' composer-flip-label--special' : ''} ${className}`.trim()}
    >
      <span key={value} className="composer-flip-label__text">
        {value}
      </span>
    </span>
  );
}

// 与 CSS .composer-menu transition 同步（已放慢一倍：0.16s → 0.32s）
const COMPOSER_MENU_EXIT_MS = 320;

/** 带进出动画的 composer 下拉菜单（模式 / 模型 / 思考强度） */
function ComposerAnimatedMenu({ open, onClose, className = '', children, 'data-testid': dataTestId, ...rest }) {
  const [render, setRender] = useState(open);
  const [phase, setPhase] = useState(open ? 'enter' : 'exit');
  const exitTimerRef = useRef(null);

  useEffect(() => {
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    if (open) {
      setRender(true);
      setPhase('enter');
      // 下一帧切到 shown，触发 CSS transition
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setPhase('shown'));
      });
      return () => {
        cancelAnimationFrame(raf1);
        if (raf2) cancelAnimationFrame(raf2);
      };
    }
    if (!render) return undefined;
    setPhase('exit');
    exitTimerRef.current = setTimeout(() => {
      setRender(false);
      exitTimerRef.current = null;
    }, COMPOSER_MENU_EXIT_MS);
    return () => {
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
    };
  // Only react to open; phase/render are menu-internal animation state.
  }, [open]);

  useEffect(() => {
    if (!open || typeof onClose !== 'function') return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!render) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-10"
        style={{ left: 'var(--sidebar-width, 252px)' }}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="menu"
        data-testid={dataTestId}
        className={`composer-menu absolute z-20 ${phase === 'shown' ? 'composer-menu--open' : ''} ${className}`.trim()}
        {...rest}
      >
        {children}
      </div>
    </>
  );
}

function MarkdownCodeCopyButton({ text }) {
  const t = useUiTranslate();
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef(null);

  useEffect(
    () => () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    },
    [],
  );

  const handleCopy = useCallback(async () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    try {
      await copyTextToClipboard(text);
      setCopied(true);
    } catch (_) {
      setCopied(false);
    }
    resetTimerRef.current = setTimeout(() => {
      resetTimerRef.current = null;
      setCopied(false);
    }, 2000);
  }, [text]);

  const label = copied ? t('message.copied') : t('message.copyToClipboard');
  return (
    <div className="markdown-code-copy">
      <button type="button" onClick={handleCopy} title={label} aria-label={label}>
        {copied ? (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--color-accent-green)" strokeWidth="1.5">
            <path d="M3 8l3 3 7-7" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="5" y="5" width="10" height="10" rx="1.5" />
            <path d="M11 5V3a1 1 0 00-1-1H3a1 1 0 00-1 1v7a1 1 0 001 1h2" />
          </svg>
        )}
      </button>
    </div>
  );
}

function MarkdownCode({ className, children, ...props }) {
  const theme = useResolvedTheme();
  const languageMatch = /language-(\w+)/.exec(className || '');
  const raw = String(children ?? '').replace(/\n$/, '');

  // WebUI chat lF: group relative my-3 rounded-xl overflow-hidden bg-bg-code border + Prism Ol/Bl @ 14px/1.5
  if (languageMatch) {
    const language = languageMatch[1];
    return (
      <div className="markdown-code-block group relative my-3 overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-code)]">
        <MarkdownCodeCopyButton text={raw} />
        <div className="overflow-x-auto px-3 py-3">
          <SyntaxHighlighter
            style={theme === 'dark' ? oneDark : oneLight}
            language={language}
            PreTag="div"
            customStyle={{
              margin: 0,
              padding: 0,
              border: 'none',
              background: 'transparent',
              fontSize: '14px',
              lineHeight: '1.5',
            }}
            codeTagProps={{ style: { background: 'transparent', textShadow: 'none' } }}
          >
            {raw}
          </SyntaxHighlighter>
        </div>
      </div>
    );
  }

  if (raw.includes('\n')) {
    return (
      <div className="markdown-code-block group relative my-3 overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-code)]">
        <MarkdownCodeCopyButton text={raw} />
        <pre
          className="overflow-x-auto px-3 py-3 font-mono text-[var(--color-text-primary)]"
          style={{ margin: 0, background: 'transparent', fontSize: '14px', lineHeight: 1.5, whiteSpace: 'pre' }}
        >
          {raw}
        </pre>
      </div>
    );
  }

  return (
    <code className={className} {...props}>
      {children}
    </code>
  );
}

function MarkdownImage({ src, alt, className, style, variant = 'markdown' }) {
  const t = useUiTranslate();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const imgClass =
    className ||
    (variant === 'user'
      ? 'max-w-full h-auto rounded-lg cursor-pointer hover:opacity-80 transition-opacity'
      : 'markdown-image cursor-pointer hover:opacity-90 transition-opacity');

  return (
    <>
      <img
        src={src}
        alt={alt || ''}
        className={imgClass}
        style={style || (variant === 'user' ? { maxHeight: 360 } : undefined)}
        title={src ? t('message.clickToEnlarge') : undefined}
        onClick={(event) => {
          event.preventDefault();
          if (src) setOpen(true);
        }}
      />
      {open && src ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 cursor-zoom-out"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label={t('message.clickToEnlarge')}
        >
          <img
            src={src}
            alt={alt || ''}
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      ) : null}
    </>
  );
}

/** Unwrap react-markdown's default <pre> so fenced blocks are owned by MarkdownCode. */
function MarkdownPre({ children }) {
  return <>{children}</>;
}

const MARKDOWN_COMPONENTS = {
  pre: MarkdownPre,
  code: MarkdownCode,
  table: MarkdownTable,
  img: MarkdownImage,
};

function getDayLabel(ts, t) {
  const d = new Date(typeof ts === 'number' ? ts : Date.now());
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = (today - target) / 86400000;
  if (diff === 0) return t ? t('chat.date.today') : '今天';
  if (diff === 1) return t ? t('chat.date.yesterday') : '昨天';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function readClipboardImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error(translate('zh', 'error.clipboardReadFailed')));
    reader.readAsDataURL(file);
  });
}

function getPromptSuggestionText(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value.map(getPromptSuggestionText).filter(Boolean).join('\n').trim();
  }
  if (!value || typeof value !== 'object') return '';
  for (const key of ['suggestion', 'text', 'content']) {
    const text = getPromptSuggestionText(value[key]);
    if (text) return text;
  }
  return '';
}

function CopyButton({ text }) {
  const t = useUiTranslate();
  const [copyStatus, setCopyStatus] = useState('idle');
  const resetTimerRef = useRef(null);

  useEffect(
    () => () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    },
    [],
  );

  const handleCopy = useCallback(async () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    try {
      await copyTextToClipboard(text);
      setCopyStatus('success');
    } catch (_) {
      setCopyStatus('error');
    }
    resetTimerRef.current = setTimeout(() => {
      resetTimerRef.current = null;
      setCopyStatus('idle');
    }, 1800);
  }, [text]);

  const title =
    copyStatus === 'success'
      ? t('message.copied')
      : copyStatus === 'error'
        ? t('clipboard.copyFailed')
        : t('message.copyToClipboard');

  return (
    <button
      className="ml-2 flex-shrink-0 rounded p-1 opacity-0 transition-opacity hover:opacity-100 focus:opacity-100 focus-visible:opacity-100 group-hover:opacity-100 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
      onClick={handleCopy}
      title={title}
      aria-label={title}
    >
      {copyStatus === 'success' ? (
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="var(--color-accent-green)"
          strokeWidth="1.5"
        >
          <path d="M3 8l3 3 7-7" />
        </svg>
      ) : copyStatus === 'error' ? (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--color-accent-red)" strokeWidth="1.5">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="5" y="5" width="10" height="10" rx="1.5" />
          <path d="M11 5V3a1 1 0 00-1-1H3a1 1 0 00-1 1v7a1 1 0 001 1h2" />
        </svg>
      )}
    </button>
  );
}

export function resolveThinkingEndedAt(item, now = Date.now()) {
  const startedAt = Number(item?.createdAt);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return null;

  if (item?.streaming) {
    const liveNow = Number(now);
    return Number.isFinite(liveNow) && liveNow > 0 ? Math.max(startedAt, liveNow) : startedAt;
  }

  const completedAt = Number(item?.completedAt);
  if (Number.isFinite(completedAt) && completedAt > 0) {
    return Math.max(startedAt, completedAt);
  }

  // 旧数据/历史条目可能只有 createdAt：不能用“现在”当结束时间，否则会把消息年龄当成思考用时。
  return startedAt;
}

export function formatThinkingDuration(createdAt, endedAt, streaming) {
  const startedAt = Number(createdAt);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return '0 秒';
  const finishedAt = Number(endedAt);
  const safeEndedAt = Number.isFinite(finishedAt) ? finishedAt : startedAt;
  const elapsedMs = Math.max(0, safeEndedAt - startedAt);
  if (!streaming && elapsedMs < 1000) return '<1 秒';
  const elapsed = Math.floor(elapsedMs / 1000);
  if (elapsed < 60) return `${elapsed} 秒`;
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`;
  return `${Math.floor(elapsed / 3600)} 时 ${Math.floor((elapsed % 3600) / 60)} 分`;
}

export function getResponseActivityLabel({
  connectionState,
  historyReplayActive,
  activeThreadStatus,
  isAwaitingResponse,
  activePromptRunId,
  promptStartedAt,
  timeline,
  t,
}) {
  // Default to zh so unit tests / pure callers keep WebUI Chinese chrome without locale wiring.
  const tr = typeof t === 'function' ? t : (key) => translate('zh', key);
  if (connectionState !== 'connected') return null;
  if (historyReplayActive) return tr('phase.loadingHistory');
  if (activeThreadStatus === 'cancelling') return tr('phase.cancelling');
  if (activeThreadStatus === 'waiting') return tr('phase.waitingUser');
  const responseActive =
    activeThreadStatus === 'running' || Boolean(isAwaitingResponse) || Boolean(activePromptRunId);
  if (!responseActive) return null;
  if (isAwaitingResponse) return tr('phase.modelRequesting');

  const entries = Array.isArray(timeline) ? timeline : [];
  const normalizedStartedAt = Number(promptStartedAt);
  let turnStart = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const item = entries[index];
    if (item?.type !== 'message' || item?.role !== 'user') continue;
    const createdAt = Number(item.createdAt);
    if (
      !Number.isFinite(normalizedStartedAt) ||
      normalizedStartedAt <= 0 ||
      !Number.isFinite(createdAt) ||
      createdAt >= normalizedStartedAt
    ) {
      turnStart = index;
      break;
    }
  }
  const currentTurn = entries.slice(turnStart + 1);
  const activeEntry = [...currentTurn].reverse().find((item) => {
    if (item?.streaming) return true;
    return (
      item?.type === 'tool_call' &&
      !['completed', 'done', 'failed', 'error', 'cancelled', 'canceled'].includes(item?.status)
    );
  });
  if (activeEntry?.type === 'thinking') return tr('phase.thinking');
  if (activeEntry?.type === 'tool_call') return tr('phase.toolExecuting');
  if (activeEntry?.type === 'message' && activeEntry?.role === 'assistant') return tr('phase.generating');
  if (activePromptRunId || activeThreadStatus === 'running') return tr('phase.processing');
  return null;
}

function ResponseActivityIndicator({ label, startedAt }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!label) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [label, startedAt]);

  if (!label) return null;
  const normalizedStartedAt = Number(startedAt);
  const elapsed =
    Number.isFinite(normalizedStartedAt) && normalizedStartedAt > 0
      ? formatThinkingDuration(normalizedStartedAt, now, true)
      : null;
  return (
    <div
      className="response-activity-indicator shrink-0 flex items-center justify-center gap-2 px-4 pb-1 pt-2 text-xs text-[var(--color-text-muted)]"
      data-response-activity
    >
      <span className="sr-only" role="status" aria-live="polite">
        {label}
      </span>
      <span className="contents" aria-hidden="true">
        <span className="flex items-end gap-1">
          {[0, 1, 2].map((index) => (
            <span
              key={index}
              className="response-activity-dot h-1.5 w-1.5 rounded-full bg-[var(--color-accent-blue)]"
              style={{ animationDelay: `${index * 140}ms` }}
            />
          ))}
        </span>
        <span>{label}</span>
        {elapsed ? <span className="tabular-nums">· {elapsed}</span> : null}
      </span>
    </div>
  );
}

function useUiTranslate() {
  const localeMode = useStore((state) => state.guiSettings?.locale || 'system');
  const [systemTick, setSystemTick] = useState(0);
  useEffect(() => {
    if (localeMode !== 'system') return undefined;
    const onChange = () => setSystemTick((value) => value + 1);
    window.addEventListener('languagechange', onChange);
    return () => window.removeEventListener('languagechange', onChange);
  }, [localeMode]);
  return useMemo(() => {
    void systemTick;
    const resolved = resolveLocaleMode(localeMode);
    return (key, vars) => translate(resolved, key, vars);
  }, [localeMode, systemTick]);
}

function ThinkingCard({ item }) {
  // null = follow WebUI default (expanded while streaming); boolean = user override
  const t = useUiTranslate();
  const [expandedOverride, setExpandedOverride] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const contentRef = useRef(null);
  const streaming = Boolean(item.streaming);
  const expanded = expandedOverride !== null ? expandedOverride : streaming;
  const content = typeof item.content === 'string' ? item.content : '';
  const hasContent = content.trim().length > 0;

  useEffect(() => {
    if (!streaming) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [streaming, item.createdAt]);

  useEffect(() => {
    if (streaming && expanded && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [item.content, streaming, expanded]);

  // WebUI uF: duration is whole seconds — streaming ticks live; done uses stored
  // thinkingDuration (integer). Header is 已思考（用时 {n} 秒）, not a mixed duration string.
  const durationSeconds = useMemo(() => {
    const startedAt = Number(item.createdAt);
    if (!Number.isFinite(startedAt) || startedAt <= 0) return 0;
    if (streaming) {
      return Math.max(0, Math.round((now - startedAt) / 1000));
    }
    const endedAt = resolveThinkingEndedAt(item, now);
    return Math.max(0, Math.round((endedAt - startedAt) / 1000));
  }, [item.createdAt, item.completedAt, item.streaming, now, streaming]);

  const headerText = streaming
    ? t('thinking.thinking')
    : `${t('thinking.done')}${t('thinking.seconds', { n: durationSeconds })}`;

  if (!streaming && !hasContent) return null;

  return (
    <div className={`thinking-block${streaming ? ' thinking-block-streaming' : ''}`}>
      <div
        className="thinking-block-header"
        onClick={() => setExpandedOverride((prev) => (prev !== null ? !prev : !streaming))}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setExpandedOverride((prev) => (prev !== null ? !prev : !streaming));
          }
        }}
      >
        <span className="thinking-block-header-text">{headerText}</span>
        {streaming ? <span className="thinking-dot" aria-hidden="true" /> : null}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`thinking-block-toggle${expanded ? ' expanded' : ''}`}
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </div>
      {expanded && hasContent ? (
        <div ref={contentRef} className="thinking-block-content">
          {content}
        </div>
      ) : null}
    </div>
  );
}

/** WebUI status dot — running pulse / failed red / completed green */
function ToolStatusDot({ status }) {
  if (status === 'running' || status === 'pending' || status === 'in_progress') {
    return (
      <span
        className="tool-status-dot tool-status-dot--running"
        aria-hidden="true"
      />
    );
  }
  if (status === 'failed' || status === 'error') {
    return <span className="tool-status-dot tool-status-dot--failed" aria-hidden="true" />;
  }
  if (status === 'completed' || status === 'done') {
    return <span className="tool-status-dot tool-status-dot--completed" aria-hidden="true" />;
  }
  return null;
}

function ToolKindIcon({ kind, completed }) {
  const color = completed ? 'var(--color-text-tertiary)' : 'var(--color-text-secondary)';
  const common = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: 1.75, className: 'shrink-0' };
  const k = String(kind || '').toLowerCase();
  if (k === 'read' || k === 'search' || k.includes('read') || k.includes('search') || k.includes('grep') || k.includes('glob')) {
    return (
      <svg {...common} aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (k === 'edit' || k === 'write' || k.includes('edit') || k.includes('write')) {
    return (
      <svg {...common} aria-hidden="true">
        <path d="M12 20h9" strokeLinecap="round" />
        <path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z" strokeLinejoin="round" />
      </svg>
    );
  }
  if (k === 'execute' || k === 'shell' || k.includes('bash') || k.includes('terminal') || k.includes('exec')) {
    return (
      <svg {...common} aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M7 9l3 3-3 3M12 15h5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  // default wrench / tool
  return (
    <svg {...common} aria-hidden="true">
      <path d="M14.7 6.3a4 4 0 00-5.6 5.2L4 17l3 3 5.5-5.1a4 4 0 005.2-5.6l-2.5 2.5-2.5-2.5 2.5-2.5z" strokeLinejoin="round" />
    </svg>
  );
}

function formatToolPayload(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch (_) {
    return String(value);
  }
}

function toolCallDisplayTitle(item, t) {
  return (
    item?.title ||
    item?.name ||
    item?.toolName ||
    item?.kind ||
    t('tool.defaultName')
  );
}

function toolCallSummary(item) {
  const input = item?.rawInput;
  if (input == null) return '';
  if (typeof input === 'string') {
    const oneLine = input.replace(/\s+/g, ' ').trim();
    return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
  }
  if (typeof input === 'object') {
    const preferred =
      input.command ||
      input.path ||
      input.file_path ||
      input.filePath ||
      input.pattern ||
      input.query ||
      input.url ||
      input.description ||
      null;
    if (preferred) {
      const text = String(preferred).replace(/\s+/g, ' ').trim();
      return text.length > 80 ? `${text.slice(0, 80)}…` : text;
    }
  }
  return '';
}

function ToolCallBlock({ item }) {
  const t = useUiTranslate();
  const isCompleted = item.status === 'completed' || item.status === 'done';
  const isFailed = item.status === 'failed' || item.status === 'error';
  const isRunning = !isCompleted && !isFailed;
  const hasDetails = Boolean(item.rawInput || item.rawOutput || item.content);
  // WebUI: auto-expand failed; expand running Write/edit; otherwise collapsed
  const [expanded, setExpanded] = useState(
    () => isFailed || ((item.kind === 'edit' || item.toolName === 'Write') && isRunning),
  );

  useEffect(() => {
    if (isFailed) setExpanded(true);
  }, [isFailed]);

  const title = toolCallDisplayTitle(item, t);
  const summary = toolCallSummary(item);
  const canToggle = hasDetails && (isCompleted || isFailed || isRunning);

  return (
    <div className="tool-call-row mb-0.5">
      <button
        type="button"
        onClick={() => canToggle && setExpanded((value) => !value)}
        className={[
          'flex w-full items-center gap-1.5 rounded-lg px-1 py-1 text-left transition-colors',
          canToggle ? 'cursor-pointer hover:bg-[var(--color-bg-hover)]/60' : 'cursor-default',
        ].join(' ')}
        aria-expanded={canToggle ? expanded : undefined}
      >
        <ToolKindIcon kind={item.kind || item.toolName || item.title} completed={isCompleted && !isFailed} />
        <span className={`tool-call-title truncate text-[13px] font-medium ${isCompleted && !isFailed ? 'is-done' : ''}`}>
          {title}
        </span>
        {summary ? (
          <span className={`tool-call-summary min-w-0 flex-1 truncate text-[12px] ${isCompleted && !isFailed ? 'is-done' : ''}`}>
            {summary}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <ToolStatusDot status={item.status} />
        {canToggle ? (
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className={`shrink-0 text-[var(--color-text-tertiary)] transition-transform duration-150 ${
              expanded ? 'rotate-90' : ''
            }`}
            aria-hidden="true"
          >
            <path d="M6 3l5 5-5 5" />
          </svg>
        ) : null}
      </button>
      {canToggle && expanded ? (
        <div className="tool-call-detail pl-5">
          <div className="mb-1 mt-0.5 space-y-1.5">
            {item.rawInput ? (
              <div>
                <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                  {t('tool.input')}
                </div>
                <pre className="tool-call-payload max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md px-2.5 py-1.5 text-[11px] leading-4">
                  {formatToolPayload(item.rawInput)}
                </pre>
              </div>
            ) : null}
            {item.rawOutput ? (
              <div>
                <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                  {t('tool.output')}
                </div>
                <pre className="tool-call-payload max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md px-2.5 py-1.5 text-[11px] leading-4">
                  {formatToolPayload(item.rawOutput)}
                </pre>
              </div>
            ) : null}
            {item.content && !item.rawInput && !item.rawOutput ? (
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-4 text-[var(--color-text-secondary)]">
                {item.content}
              </pre>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function toolNameHistogram(toolItems) {
  const counts = new Map();
  for (const item of toolItems) {
    const name = String(item?.toolName || item?.title || item?.name || item?.kind || 'tool').replace(/Tool$/, '');
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
    .join(', ');
}

function ExecutionGroup({ items, autoCollapse = false }) {
  const t = useUiTranslate();
  const toolItems = items.filter((item) => item?.type === 'tool_call');
  const internalEventCount = Math.max(0, items.length - toolItems.length);
  const toolCount = toolItems.length;
  const failedCount = toolItems.filter((item) => ['failed', 'error'].includes(item?.status)).length;
  const running = toolItems.some(
    (item) => !['completed', 'done', 'failed', 'error'].includes(item?.status),
  );
  // WebUI: auto-collapse when ≥2 tools and turn finished (autoCollapse) and nothing running/failed pending UI
  const preferCollapsed = Boolean(autoCollapse) && !running && toolCount >= 2;
  const userOverrideRef = useRef(null);
  const [expandedOverride, setExpandedOverride] = useState(null);
  const expanded = expandedOverride !== null ? expandedOverride : !preferCollapsed;

  useEffect(() => {
    // When autoCollapse flips true after final answer, snap to collapsed unless user already toggled.
    if (!autoCollapse) return;
    if (userOverrideRef.current !== null) return;
    setExpandedOverride(null);
  }, [autoCollapse]);

  const countLabel =
    toolCount === 1
      ? `1 ${t('tool.toolSingular')}`
      : t('tool.toolsExecuted', { count: toolCount });
  const nameHint = toolNameHistogram(toolItems);

  const toggle = () => {
    const next = !expanded;
    userOverrideRef.current = next;
    setExpandedOverride(next);
  };

  // Pure checkpoint / task / goal noise with zero tool rows must not become a fake
  // “turn ended” footer (“本轮没有可展示的工具调用” + “已合并 N 条内部进度”).
  if (toolCount === 0) return null;

  // Single running/finished tool with no siblings: render the row directly (WebUI does not wrap in a summary).
  if (toolCount === 1 && internalEventCount === 0 && !preferCollapsed) {
    return (
      <div className="execution-group mb-2 w-full">
        <ToolCallBlock item={toolItems[0]} />
      </div>
    );
  }

  // WebUI only shows the “N 个工具已执行” chrome when the group is (or can be) collapsed.
  // While tools are still running, just list the light rows with an optional left rail.
  const showGroupChrome = preferCollapsed || expandedOverride !== null || (!running && toolCount >= 2);
  // Internal events stay folded silently — no “已合并 N 条内部进度” footer (felt like a wrong ending).
  const showRail = toolCount > 1;

  return (
    <div className="execution-group mb-2 flex w-full flex-col gap-0">
      {expanded ? (
        <>
          {showGroupChrome ? (
            <button
              type="button"
              onClick={toggle}
              className="flex items-center gap-2 rounded-lg px-1.5 py-0.5 text-left transition-colors hover:bg-[var(--color-bg-hover)]/50"
              aria-expanded={true}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                className="shrink-0 text-[var(--color-text-tertiary)]"
                aria-hidden="true"
              >
                <path d="M4 6l4 4 4-4" />
              </svg>
              <span className="text-[12px] text-[var(--color-text-tertiary)]">{countLabel}</span>
              {failedCount > 0 ? (
                <span className="inline-flex items-center gap-1 text-[12px] text-[var(--color-accent-red)]">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-accent-red)]" />
                  {t('tool.failedCount', { count: failedCount })}
                </span>
              ) : null}
            </button>
          ) : null}
          <div className={`relative ${showRail ? 'ml-1.5 pl-4' : ''}`}>
            {showRail ? (
              <div className="absolute bottom-1 left-0 top-1 w-px bg-[var(--color-border-default)]" aria-hidden="true" />
            ) : null}
            <div className="flex flex-col gap-0.5">
              {toolItems.map((item, index) => (
                <ToolCallBlock key={item.id || index} item={item} />
              ))}
            </div>
          </div>
        </>
      ) : (
        <button
          type="button"
          onClick={toggle}
          className="group flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-[var(--color-bg-hover)]/50"
          aria-expanded={false}
          aria-label={countLabel}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className="shrink-0 text-[var(--color-text-tertiary)]"
            aria-hidden="true"
          >
            <path d="M6 3l5 5-5 5" />
          </svg>
          <span className="text-[12px] text-[var(--color-text-tertiary)]">{countLabel}</span>
          {failedCount > 0 ? (
            <span className="inline-flex items-center gap-1 text-[12px] text-[var(--color-accent-red)]">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-accent-red)]" />
              {t('tool.failedCount', { count: failedCount })}
            </span>
          ) : null}
          {nameHint ? (
            <span className="tool-group-hint min-w-0 flex-1 truncate text-[11px] opacity-0 transition-opacity group-hover:opacity-100">
              {nameHint}
            </span>
          ) : (
            <span className="flex-1" />
          )}
        </button>
      )}
    </div>
  );
}

function EventDetails({ value }) {
  const t = useUiTranslate();
  const [expanded, setExpanded] = useState(false);
  const details = useMemo(() => {
    if (!value || typeof value !== 'object') return '';
    try {
      const text = JSON.stringify(value, null, 2);
      return text.length > 20000 ? text.slice(0, 20000) + '\n...' : text;
    } catch (_) {
      return '';
    }
  }, [value]);
  if (!details) return null;
  return (
    <div className="mt-2">
      <button
        type="button"
        className="text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? t('tool.collapse') : t('tool.expand')}
      </button>
      {expanded ? (
        <pre className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--color-bg-primary)] p-2 text-[10px] leading-4 text-[var(--color-text-secondary)]">
          {details}
        </pre>
      ) : null}
    </div>
  );
}

function isAuthRelatedMessage(message) {
  return /鉴权|登录|authentication|sign in|auth-type:cli-external-link|云账号|云端账号|401/i.test(
    String(message || ''),
  );
}

function ErrorTimelineCard({ item }) {
  const t = useUiTranslate();
  const accountLoginNeeded = useStore((s) =>
    ['required', 'authenticating', 'error'].includes(s.codeBuddyAccountAuthState),
  );
  const payload = item.meta || item.raw || {};
  const message = item.content || payload.message || payload.error?.message || t('execution.failedDefault');
  // 已有「需要登录」恢复卡时，隐藏同文案的执行失败时间线条，避免三连红。
  if (accountLoginNeeded && isAuthRelatedMessage(message)) return null;
  return (
    <div className="my-3 rounded-md border border-[rgba(239,68,68,0.35)] bg-[rgba(239,68,68,0.08)] px-3 py-2.5">
      <div className="flex items-start gap-2">
        <svg
          className="mt-0.5 shrink-0 text-[var(--color-accent-red)]"
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6.5" />
          <path d="M8 4.5v4M8 11.5v.1" />
        </svg>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-[var(--color-accent-red)]">{t('execution.failedTitle')}</div>
          <div className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-[var(--color-text-secondary)]">
            {message}
          </div>
          <EventDetails value={payload} />
        </div>
      </div>
    </div>
  );
}

function ArtifactTimelineCard({ item }) {
  const t = useUiTranslate();
  const payload = item.meta || item.raw || {};
  const artifact = payload.artifact && typeof payload.artifact === 'object' ? payload.artifact : payload;
  const tasks = Array.isArray(artifact.tasks) ? artifact.tasks : [];
  const title = artifact.title || artifact.name || artifact.type || t('artifact.defaultTitle');
  const eventLabels = {
    created: t('artifact.created'),
    updated: t('artifact.updated'),
    deleted: t('artifact.deleted'),
  };
  const eventLabel = eventLabels[payload.event] || t('artifact.label');
  const summary = getPromptSuggestionText(artifact.description || artifact.content || artifact.text);
  const statusLabels = {
    completed: t('artifact.status.completed'),
    in_progress: t('artifact.status.in_progress'),
    pending: t('artifact.status.pending'),
    failed: t('artifact.status.failed'),
  };
  return (
    <div className="my-3 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3 py-2.5">
      <div className="flex items-start gap-2">
        <svg
          className="mt-0.5 shrink-0 text-[var(--color-accent-blue)]"
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M3 2.5h6l4 4V14H3V2.5z" />
          <path d="M9 2.5V7h4" />
        </svg>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs font-medium text-[var(--color-text-primary)]">{title}</span>
            <span className="text-[10px] text-[var(--color-text-muted)]">{eventLabel}</span>
            {artifact.mimeType ? (
              <span className="text-[10px] text-[var(--color-text-muted)]">{artifact.mimeType}</span>
            ) : null}
          </div>
          {summary ? (
            <div className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-[var(--color-text-secondary)]">
              {summary}
            </div>
          ) : null}
          {tasks.length ? (
            <div className="mt-2 space-y-1">
              {tasks.map((task, index) => (
                <div key={task.id || index} className="flex items-start gap-2 text-xs">
                  <span
                    className={
                      task.status === 'completed'
                        ? 'text-[var(--color-accent-green)]'
                        : task.status === 'failed'
                          ? 'text-[var(--color-accent-red)]'
                          : 'text-[var(--color-text-muted)]'
                    }
                  >
                    {task.status === 'completed' ? '✓' : task.status === 'failed' ? '×' : '•'}
                  </span>
                  <span className="min-w-0 flex-1 break-words text-[var(--color-text-secondary)]">
                    {task.content || task.subject || task.title || task.id || t('artifact.taskUntitled')}
                  </span>
                  <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
                    {statusLabels[task.status] || task.status || ''}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {artifact.uri ? (
            <div className="mt-2 truncate font-mono text-[10px] text-[var(--color-text-muted)]" title={artifact.uri}>
              {artifact.uri}
            </div>
          ) : null}
          <EventDetails value={payload} />
        </div>
      </div>
    </div>
  );
}

function consumeStoreError(fallback) {
  const state = useStore.getState();
  const message = state.error || fallback;
  if (state.error) state.clearError();
  return message;
}
function ActivityTimelineCard({ item }) {
  const t = useUiTranslate();
  const payload = item.meta || item.raw || {};
  const source =
    payload.checkpoint && typeof payload.checkpoint === 'object'
      ? payload.checkpoint
      : payload.task && typeof payload.task === 'object'
        ? payload.task
        : payload;
  const labels = {
    checkpoint: t('activity.checkpoint'),
    taskCreated: t('activity.taskCreated'),
    taskStatus: t('activity.taskStatus'),
    'goal-progress': t('activity.goalProgress'),
    'goal-status': t('activity.goalStatus'),
    question_answered: t('activity.questionAnswered'),
  };
  const eventLabels = {
    created: t('activity.created'),
    updated: t('activity.updated'),
    reverted: t('activity.reverted'),
  };
  const title =
    item.type === 'checkpoint'
      ? t('activity.checkpoint') + (eventLabels[payload.event] ? ' · ' + eventLabels[payload.event] : '')
      : labels[item.type] || t('activity.fallback');
  const summary =
    item.content ||
    source.title ||
    source.name ||
    source.subject ||
    source.condition ||
    source.reason ||
    source.message ||
    source.status ||
    source.id ||
    '';
  return (
    <div className="my-2 border-l-2 border-[var(--color-border-default)] py-1 pl-3">
      <div className="text-[10px] font-medium text-[var(--color-text-muted)]">{title}</div>
      {summary ? (
        <div className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-5 text-[var(--color-text-secondary)]">
          {String(summary)}
        </div>
      ) : null}
      <EventDetails value={payload} />
    </div>
  );
}

function SessionActivityStatus({ historyReplayActive, agentPhase, progress }) {
  const t = useUiTranslate();
  const phase = typeof agentPhase === 'string' ? agentPhase : agentPhase?.type || agentPhase?.phase || '';
  const progressType = typeof progress === 'string' ? progress : progress?.type || '';
  const current = historyReplayActive ? 'history-replay' : progressType || phase;
  if (!current || ['idle', 'completed', 'done', 'ready'].includes(current)) return null;
  const labels = {
    'history-replay': t('sessionActivity.historyReplay'),
    compacting: t('sessionActivity.compacting'),
    thinking: t('sessionActivity.thinking'),
    reasoning: t('sessionActivity.reasoning'),
    responding: t('sessionActivity.responding'),
    tool: t('sessionActivity.tool'),
    tool_use: t('sessionActivity.tool'),
    planning: t('sessionActivity.planning'),
  };
  return (
    <div className="mb-3 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
      <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--color-accent-blue)]" />
      <span>{labels[current] || String(current)}</span>
    </div>
  );
}

function TeamStatusPanel({ teamState }) {
  const t = useUiTranslate();
  if (!teamState) return null;
  const members = Array.isArray(teamState.members) ? teamState.members : [];
  const teamName = teamState.teamName || teamState.name || t('team.defaultName');
  const statusLabels = {
    working: t('team.status.working'),
    running: t('team.status.working'),
    in_progress: t('team.status.working'),
    idle: t('team.status.idle'),
    completed: t('team.status.completed'),
    failed: t('team.status.failed'),
    waiting: t('team.status.waiting'),
  };
  return (
    <div className="mb-3 border-b border-[var(--color-border-muted)] pb-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-[var(--color-text-primary)]">{teamName}</span>
        {teamState.isAutoTeam ? (
          <span className="text-[10px] text-[var(--color-text-muted)]">{t('team.auto')}</span>
        ) : null}
        <span className="text-[10px] text-[var(--color-text-muted)]">
          {t('team.memberCount', { n: members.length })}
        </span>
      </div>
      {members.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {members.map((member, index) => {
            const name = member.name || member.agentName || member.role || t('team.memberFallback', { n: index + 1 });
            const status = member.status || member.state || 'idle';
            const active = ['working', 'running', 'in_progress'].includes(status);
            return (
              <div
                key={member.id || member.name || index}
                className="flex min-w-0 max-w-[240px] items-center gap-1.5 rounded border border-[var(--color-border-muted)] bg-[var(--color-bg-secondary)] px-2 py-1 text-[10px]"
              >
                <span
                  className={
                    'h-1.5 w-1.5 shrink-0 rounded-full ' +
                    (status === 'failed'
                      ? 'bg-[var(--color-accent-red)]'
                      : active
                        ? 'bg-[var(--color-accent-blue)]'
                        : status === 'completed'
                          ? 'bg-[var(--color-accent-green)]'
                          : 'bg-[var(--color-text-muted)]')
                  }
                />
                <span className="truncate text-[var(--color-text-secondary)]" title={name}>
                  {name}
                </span>
                <span className="shrink-0 text-[var(--color-text-muted)]">{statusLabels[status] || status}</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function InterruptionCard({ item }) {
  const t = useUiTranslate();
  const respondToInterruption = useStore((s) => s.respondToInterruption);
  const payload = item.meta || item.raw || {};
  const interruptionId =
    payload.interruptionId || payload.toolCallId || item.raw?.interruptionId || item.raw?.toolCallId || item.toolCallId;
  const toolCallId = payload.toolCallId || item.raw?.toolCallId || item.toolCallId || null;
  const permissionOptions = payload.options || item.raw?.options || [];
  const toolInput = payload.toolInput && typeof payload.toolInput === 'object' ? payload.toolInput : {};
  const toolName = payload.toolTitle || payload.toolName || item.title || t('interruption.defaultTool');
  const description = toolInput.description || payload.toolDescription || '';
  const command = typeof toolInput.command === 'string' ? toolInput.command : '';
  const expired = item.status === 'expired';
  const resolved = item.status === 'resolved';
  const resolution = payload.resolution;
  const resolutionLabels = {
    allow: t('interruption.approved'),
    allowAll: t('interruption.approvedAlways'),
    deny: t('interruption.denied'),
    reject: t('interruption.denied'),
    rejectAndExitPlan: t('interruption.rejectAndExitPlan'),
  };
  const resolutionDenied = ['deny', 'reject', 'rejectAndExitPlan'].includes(resolution);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const resolve = async (decision) => {
    if (!interruptionId || busy || resolved || expired) return;
    setBusy(true);
    setError('');
    try {
      const ok = await respondToInterruption(interruptionId, decision, toolCallId);
      if (!ok) setError(useStore.getState().error || t('interruption.respondFailed'));
    } catch (responseError) {
      setError(responseError?.message || t('interruption.respondFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (resolved || expired) {
    const statusLabel = expired ? t('interruption.expired') : resolutionLabels[resolution] || t('interruption.resolved');
    return (
      <div className="my-2 flex min-w-0 items-center gap-2 border-y border-[var(--color-border-muted)] py-2 text-xs">
        <svg
          className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent-yellow)]"
          viewBox="0 0 16 16"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M8 1l7 13H1L8 1zm0 5v3m0 2v1" />
        </svg>
        <span className="shrink-0 font-medium text-[var(--color-text-primary)]">{t('interruption.title')}</span>
        <span className="truncate text-[var(--color-text-muted)]" title={[toolName, description].filter(Boolean).join(' · ')}>
          {toolName}
          {description ? ` · ${description}` : ''}
        </span>
        <span
          className={
            'ml-auto shrink-0 font-medium ' +
            (expired
              ? 'text-[var(--color-text-muted)]'
              : resolutionDenied
                ? 'text-[var(--color-accent-red)]'
                : 'text-[var(--color-accent-green)]')
          }
        >
          {statusLabel}
        </span>
      </div>
    );
  }

  return (
    <div
      className="my-2 rounded-lg px-4 py-3"
      style={{
        border: '1px solid var(--color-accent-yellow, rgba(245,158,11,0.35))',
        background: 'var(--color-warning-bg, rgba(245,158,11,0.08))',
      }}
    >
      <div className="mb-1 flex items-center gap-2">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="var(--color-accent-yellow)" aria-hidden="true">
          <path d="M8 1l7 13H1L8 1zm0 5v3m0 2v1" />
        </svg>
        <div className="text-sm font-medium text-[var(--color-text-primary)]">
          {t('interruption.needsPermission', { name: toolName })}
        </div>
      </div>
      <div className="mb-3 text-xs leading-5 text-[var(--color-text-secondary)]">
        {description || t('interruption.defaultDesc')}
      </div>
      {command ? (
        <pre className="mb-3 max-h-20 overflow-x-auto whitespace-pre-wrap break-words rounded bg-[var(--color-bg-primary)] p-2 text-xs text-[var(--color-text-secondary)]">
          {command}
        </pre>
      ) : null}
      {interruptionId ? (
        <div className="flex flex-wrap gap-2">
          <button
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-xs font-medium text-white hover:brightness-110 disabled:opacity-50"
            style={{ background: 'var(--color-accent-blue)' }}
            onClick={() => resolve('allow')}
          >
            {busy ? t('question.busy') : t('interruption.allow')}
          </button>
          {permissionOptions.some((option) =>
            ['allow_always', 'allowAll'].includes(typeof option === 'string' ? option : option.optionId || option.name),
          ) ? (
            <button
              disabled={busy}
              className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
              onClick={() => resolve('allowAll')}
            >
              {t('interruption.allowAll')}
            </button>
          ) : null}
          <button
            disabled={busy}
            className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
            onClick={() => resolve('deny')}
          >
            {t('interruption.deny')}
          </button>
          {permissionOptions.some((option) =>
            ['reject_and_exit_plan', 'rejectAndExitPlan'].includes(
              typeof option === 'string' ? option : option.optionId || option.name,
            ),
          ) ? (
            <button
              disabled={busy}
              className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
              onClick={() => resolve('rejectAndExitPlan')}
            >
              {t('interruption.rejectAndExitPlan')}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="text-xs text-[var(--color-accent-red)]">{t('interruption.missingId')}</div>
      )}
      {error ? <div className="mt-2 text-xs text-[var(--color-accent-red)]">{error}</div> : null}
    </div>
  );
}
function QuestionCard({ item }) {
  const t = useUiTranslate();
  const submitQuestionAnswers = useStore((s) => s.submitQuestionAnswers);
  const cancelQuestionAnswers = useStore((s) => s.cancelQuestionAnswers);
  const toolCallId = item.meta?.toolCallId || item.raw?.toolCallId || item.toolCallId;
  const questions = item.meta?.questions || item.raw?.questions || [];
  const resolved = item.status === 'answered' || item.status === 'cancelled' || item.status === 'expired';
  // json-rpc: `_codebuddy.ai/question` cancel → { outcome: 'cancelled' }
  // interruption: AskUserQuestion permission path → resolveInterruption(deny) / skip (WebUI parity)
  const responseMode = item.meta?.responseMode || item.raw?.responseMode;
  const source = item.meta?.source || item.raw?.source;
  const cancellable = responseMode === 'json-rpc' || responseMode === 'interruption' || source === 'interruption';
  const [answers, setAnswers] = useState(item.meta?.submittedAnswers || {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const allAnswered =
    questions.length > 0 &&
    questions.every((question, index) => {
      const answer = answers[question.id || index];
      return Array.isArray(answer) ? answer.length > 0 : String(answer || '').trim();
    });

  const submit = async () => {
    if (!toolCallId || busy || resolved || !allAnswered) return;
    setBusy(true);
    setError('');
    try {
      const ok = await submitQuestionAnswers(toolCallId, answers);
      if (!ok) setError(useStore.getState().error || t('question.submitFailed'));
    } catch (submitError) {
      setError(submitError?.message || t('question.submitFailed'));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!toolCallId || busy || resolved || !cancellable) return;
    setBusy(true);
    setError('');
    try {
      const ok = await cancelQuestionAnswers(toolCallId);
      if (!ok) setError(useStore.getState().error || t('question.cancelFailed'));
    } catch (cancelError) {
      setError(cancelError?.message || t('question.cancelFailed'));
    } finally {
      setBusy(false);
    }
  };

  const toggleOption = (key, value) => {
    setAnswers((previous) => {
      const selected = Array.isArray(previous[key]) ? previous[key] : [];
      return {
        ...previous,
        [key]: selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value],
      };
    });
  };

  return (
    <div
      className="my-2 rounded-xl px-4 py-3"
      style={{
        border: '1px solid var(--color-accent-blue, rgba(0,120,212,0.35))',
        background: 'var(--color-info-bg, rgba(0,120,212,0.08))',
      }}
    >
      <div className="mb-2 flex items-center gap-2">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="var(--color-accent-blue)">
          <path d="M8 1C4.1 1 1 4.1 1 8s3.1 7 7 7 7-3.1 7-7-3.1-7-7-7zm0 2.5c.7 0 1.3.6 1.3 1.3s-.6 1.3-1.3 1.3-1.3-.6-1.3-1.3.6-1.3 1.3-1.3zm1.5 9H6.5v-1h1V8H6.5V7h2.5v4.5H9.5V12z" />
        </svg>
        <span className="text-sm font-medium text-[var(--color-text-primary)]">
          {questions.length > 1
            ? t('question.titleWithCount', { count: questions.length })
            : t('question.singleTitle')}
        </span>
      </div>
      {resolved ? (
        <div
          className={
            'text-xs font-medium ' +
            (item.status === 'answered' ? 'text-[var(--color-accent-green)]' : 'text-[var(--color-text-muted)]')
          }
        >
          {item.status === 'expired'
            ? t('question.expired')
            : item.status === 'cancelled'
              ? t('question.cancelled')
              : t('question.answered')}
        </div>
      ) : (
        <>
          <div className="space-y-3">
            {questions.map((question, index) => {
              const key = question.id || index;
              const options = Array.isArray(question.options)
                ? question.options
                : Array.isArray(question.choices)
                  ? question.choices
                  : [];
              return (
                <div key={key}>
                  {question.header ? (
                    <div className="mb-1 text-[10px] font-medium text-[var(--color-text-muted)]">{question.header}</div>
                  ) : null}
                  <div className="mb-1 text-xs text-[var(--color-text-primary)]">
                    {question.question || question.prompt || t('question.fallback', { n: index + 1 })}
                  </div>
                  {options.length > 0 && question.multiSelect ? (
                    <div className="space-y-1">
                      {options.map((option, optionIndex) => {
                        const value = typeof option === 'string' ? option : option.value || option.id || option.label;
                        const label = typeof option === 'string' ? option : option.label || option.name || value;
                        const description = typeof option === 'string' ? '' : option.description || '';
                        const checked = Array.isArray(answers[key]) && answers[key].includes(value);
                        return value ? (
                          <label
                            key={value || optionIndex}
                            className="flex cursor-pointer items-start gap-2 rounded-md border border-[var(--color-border-muted)] px-2.5 py-2 hover:bg-[var(--color-bg-hover)]"
                          >
                            <input
                              type="checkbox"
                              className="mt-0.5"
                              checked={checked}
                              disabled={busy}
                              onChange={() => toggleOption(key, value)}
                            />
                            <span className="min-w-0">
                              <span className="block text-xs text-[var(--color-text-primary)]">{label}</span>
                              {description ? (
                                <span className="mt-0.5 block text-[10px] leading-4 text-[var(--color-text-muted)]">
                                  {description}
                                </span>
                              ) : null}
                            </span>
                          </label>
                        ) : null;
                      })}
                    </div>
                  ) : options.length > 0 ? (
                    <select
                      className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent-blue)]"
                      value={answers[key] || ''}
                      disabled={busy}
                      onChange={(event) => setAnswers((previous) => ({ ...previous, [key]: event.target.value }))}
                    >
                      <option value="">{t('question.selectPlaceholder')}</option>
                      {options.map((option, optionIndex) => {
                        const value = typeof option === 'string' ? option : option.value || option.id || option.label;
                        const label = typeof option === 'string' ? option : option.label || option.name || value;
                        return value ? (
                          <option key={value || optionIndex} value={value}>
                            {label}
                          </option>
                        ) : null;
                      })}
                    </select>
                  ) : (
                    <input
                      className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent-blue)]"
                      value={answers[key] || ''}
                      disabled={busy}
                      onChange={(event) => setAnswers((previous) => ({ ...previous, [key]: event.target.value }))}
                      placeholder={t('question.answerPlaceholder')}
                    />
                  )}
                </div>
              );
            })}
          </div>
          {toolCallId ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                disabled={busy || !allAnswered}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-white hover:brightness-110 disabled:opacity-50"
                style={{ background: 'var(--color-accent-blue)' }}
                onClick={submit}
              >
                {busy ? t('question.busy') : t('question.submit')}
              </button>
              {cancellable ? (
                <button
                  disabled={busy}
                  className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
                  onClick={cancel}
                >
                  {t('question.cancel')}
                </button>
              ) : null}
            </div>
          ) : (
            <div className="mt-3 text-xs text-[var(--color-accent-red)]">{t('question.missingId')}</div>
          )}
        </>
      )}
      {error ? <div className="mt-2 text-xs text-[var(--color-accent-red)]">{error}</div> : null}
    </div>
  );
}

function DateSeparator({ label }) {
  return (
    <div className="flex items-center gap-3 my-5">
      <div className="flex-1 h-px bg-[var(--color-border-muted)]" />
      <span className="text-xs text-[var(--color-text-muted)] flex-shrink-0">{label}</span>
      <div className="flex-1 h-px bg-[var(--color-border-muted)]" />
    </div>
  );
}

function getProtocolEventLabel(type, t) {
  const map = {
    config_option_update: t('protocol.configOptionUpdate'),
    session_info_update: t('protocol.sessionInfoUpdate'),
    available_commands_update: t('protocol.availableCommandsUpdate'),
    initialized: t('protocol.initialized'),
    status_change: t('protocol.statusChange'),
    model_update: t('protocol.modelUpdate'),
    mode_update: t('protocol.modeUpdate'),
    current_mode_update: t('protocol.modeUpdate'),
  };
  return map[type] || null;
}

const TimelineItem = React.memo(function TimelineItem({ item }) {
  const t = useUiTranslate();
  if (item.type === 'execution_group') {
    return <ExecutionGroup items={item.items || []} autoCollapse={item.autoCollapse} />;
  }

  if (item.type === 'error') {
    return <ErrorTimelineCard item={item} />;
  }

  if (item.type === 'artifact') {
    return <ArtifactTimelineCard item={item} />;
  }

  if (
    ['checkpoint', 'taskCreated', 'taskStatus', 'goal-progress', 'goal-status', 'question_answered'].includes(item.type)
  ) {
    return <ActivityTimelineCard item={item} />;
  }

  if (item.type === 'thinking') {
    return <ThinkingCard item={item} />;
  }

  if (item.type === 'tool_call') {
    return <ToolCallBlock item={item} />;
  }

  if (item.type === 'interruption') {
    return <InterruptionCard item={item} />;
  }

  if (item.type === 'question') {
    return <QuestionCard item={item} />;
  }

  // 历史会话里可能仍有 mode_update / status_change / model_update；不在对话记录展示。
  if (
    item.type === 'mode_update' ||
    item.type === 'current_mode_update' ||
    item.type === 'status_change' ||
    item.type === 'model_update'
  ) {
    return null;
  }

  const protocolLabel = getProtocolEventLabel(item.type, t);
  if (protocolLabel) {
    return (
      <div className="flex items-center gap-3 my-4">
        <div className="flex-1 h-px bg-[var(--color-border-muted)]" />
        <span className="text-xs text-[var(--color-text-muted)] flex-shrink-0">{protocolLabel}</span>
        <div className="flex-1 h-px bg-[var(--color-border-muted)]" />
      </div>
    );
  }

  if (item.role === 'user') {
    const attachments = Array.isArray(item.attachments) ? item.attachments : [];
    const images = attachments.filter((attachment) => attachment?.kind === 'image');
    const files = attachments.filter((attachment) => attachment?.kind !== 'image');
    // getText-compatible: content may be a ContentBlock / array after imperfect rehydrate
    const text =
      typeof item.content === 'string'
        ? item.content
        : item.content == null
          ? ''
          : Array.isArray(item.content)
            ? item.content
                .map((block) =>
                  typeof block === 'string'
                    ? block
                    : block && typeof block === 'object'
                      ? block.text || block.content || ''
                      : '',
                )
                .join('')
            : typeof item.content === 'object'
              ? item.content.text || item.content.content || ''
              : String(item.content);
    if (!text && images.length === 0 && files.length === 0) return null;
    // Effort picker injects `/effort …` as a real prompt so CLI switches mode, but it is not
    // a human chat turn. Showing it at the bottom makes it look like "only system messages exist".
    const trimmed = String(text || '').trim();
    if (
      !images.length &&
      !files.length &&
      /^\/effort(?:\s+\S+)?$/i.test(trimmed)
    ) {
      return null;
    }
    return (
      <div className="mb-6 flex justify-end" data-chat-role="user" data-testid="chat-user-message">
        <div className="max-w-[85%] sm:max-w-[75%] rounded-2xl rounded-tr-sm border border-[color-mix(in_srgb,var(--color-accent-blue)_28%,var(--color-border-muted))] bg-[var(--color-bg-user)] px-5 py-3 shadow-sm text-[var(--color-text-user)]">
          {images.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-2">
              {images.map((attachment, index) => {
                const src =
                  attachment.url ||
                  (attachment.data
                    ? attachment.data.startsWith('data:')
                      ? attachment.data
                      : `data:${attachment.mimeType || 'image/png'};base64,${attachment.data}`
                    : null);
                if (!src) return null;
                return (
                  <MarkdownImage
                    key={`${attachment.path || attachment.name || 'img'}-${index}`}
                    src={src}
                    alt={attachment.name || ''}
                    variant="user"
                  />
                );
              })}
            </div>
          ) : null}
          {files.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-2">
              {files.map((attachment, index) => (
                <div
                  key={`${attachment.path || attachment.name || 'file'}-${index}`}
                  className="flex max-w-[180px] items-center gap-1.5 rounded-lg border border-[var(--color-border-muted)]/30 bg-[var(--color-bg-primary)]/50 px-2.5 py-1.5"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                    <path d="M14 2v6h6" />
                  </svg>
                  <span className="truncate text-[12px] text-[var(--color-text-primary)]" title={attachment.name || attachment.path || ''}>
                    {attachment.name || attachment.path || t('attachment.unnamedFile')}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {text ? (
            <p className="whitespace-pre-wrap break-words text-chat text-[var(--color-text-user)]">{text}</p>
          ) : null}
        </div>
      </div>
    );
  }

  if (item.role === 'assistant') {
    // Thinking + markdown share one unit (no double card gap); outer mb-6 matches user turn rhythm.
    const thinking = item.thinking && typeof item.thinking === 'object' ? item.thinking : null;
    const text = typeof item.content === 'string' ? item.content : '';
    const hasText = text.trim().length > 0;
    if (!thinking && !hasText && !item.streaming) return null;
    return (
      <div className="mb-6 w-full" data-chat-role="assistant">
        {thinking ? <ThinkingCard item={thinking} /> : null}
        {hasText || item.streaming ? (
          <div className="chat-assistant-message group">
            {/* WebUI: markdown-body text-chat text-text-primary */}
            <div className="markdown-body text-chat text-text-primary text-[var(--color-text-primary)]">
              {hasText ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                  {text}
                </ReactMarkdown>
              ) : (
                '...'
              )}
            </div>
            {hasText ? <CopyButton text={text} /> : null}
          </div>
        ) : null}
      </div>
    );
  }

  return null;
});

export default function ReplicaChatView() {
  const t = useUiTranslate();
  // NOTE: remaining hooks follow; `t` used for WebUI chrome i18n
  const messagesEndRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const shouldAutoScrollRef = useRef(true);
  const scrollRestorePendingRef = useRef(true);
  const userDetachedScrollRef = useRef(false);
  const textareaRef = useRef(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  // Prefer live runtime timeline, but heal missing user bubbles from disk history.
  // Root `timeline`, per-thread runtime, and persisted thread.timeline can diverge after
  // reconnect; always resolve across all three so user bubbles never disappear.
  const timeline = useStore((s) => {
    const threadId = s.activeThreadId;
    const thread = s.threadsById[threadId];
    const runtimeTimeline = s.threadRuntimeById?.[threadId]?.timeline;
    const live = resolveThreadTimeline(s.timeline, runtimeTimeline);
    return resolveThreadTimeline(live, thread?.timeline);
  });
  const connectionState = useStore((s) => s.connectionState);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeProject = useStore((s) => s.projectsById[s.activeProjectId] || null);
  const recoveryError = useStore(
    (s) =>
      s.threadsById[s.activeThreadId]?.metadata?.lastError || s.projectsById[s.activeProjectId]?.runtimeError || '',
  );
  const restartProjectRuntime = useStore((s) => s.restartProjectRuntime);
  const bootstrap = useStore((s) => s.bootstrap);
  const codeBuddyAccountAuthState = useStore((s) => s.codeBuddyAccountAuthState);
  const codeBuddyAccountAuthError = useStore((s) => s.codeBuddyAccountAuthError);
  const authenticateCodeBuddyAccount = useStore((s) => s.authenticateCodeBuddyAccount);
  const cancelCodeBuddyAccountAuth = useStore((s) => s.cancelCodeBuddyAccountAuth);
  const currentModel = useStore((s) => s.currentModel);
  const currentMode = useStore((s) => s.currentMode);
  const usage = useStore((s) => s.usage);
  const showTokensCounter = useStore((s) => Boolean(s.guiSettings?.showTokensCounter));
  const pasteImageEnabled = useStore((s) => Boolean(s.guiSettings?.enablePasteImageFromClipboard));
  // CLI setting enables runtime suggestions; GUI setting controls input-area display (either on is enough).
  const promptSuggestionEnabled = useStore(
    (s) => Boolean(s.guiSettings?.promptSuggestionEnabled || s.settings?.promptSuggestionEnabled),
  );
  const promptSuggestion = useStore((s) => s.promptSuggestion);
  const clearPromptSuggestion = useStore((s) => s.clearPromptSuggestion);
  const teamState = useStore((s) => s.teamState);
  const agentPhase = useStore((s) => s.agentPhase);
  const progress = useStore((s) => s.progress);
  const historyReplayActive = useStore((s) => s.historyReplayActive);
  const availableCommands = useStore((s) => s.availableCommands);
  const sendPrompt = useStore((s) => s.sendPrompt);
  const cancelSession = useStore((s) => s.cancelSession);
  const isAwaitingResponse = useStore((s) => s.isAwaitingResponse);
  const promptStartedAt = useStore((s) => s.promptStartedAt);
  const activePromptRunId = useStore((s) => s.activePromptRunId);
  const activeThreadId = useStore((s) => s.activeThreadId);
  const activeThreadStatus = useStore((s) => s.threadsById[s.activeThreadId]?.status || 'idle');
  const promptQueue = useStore((s) => s.promptQueue || []);
  const moveQueuedPrompt = useStore((s) => s.moveQueuedPrompt);
  const removeQueuedPrompt = useStore((s) => s.removeQueuedPrompt);
  const drainThreadPromptQueue = useStore((s) => s.drainThreadPromptQueue);
  const pendingAttachments = useStore((s) => s.pendingAttachments || []);
  const chooseAttachments = useStore((s) => s.chooseAttachments);
  const addDroppedAttachments = useStore((s) => s.addDroppedAttachments);
  const addClipboardImageAttachment = useStore((s) => s.addClipboardImageAttachment);
  const removePendingAttachment = useStore((s) => s.removePendingAttachment);
  const capabilities = useStore((s) => s.capabilities || {});
  const models = useStore((s) => s.models);
  const modes = useStore((s) => s.modes);
  const setModel = useStore((s) => s.setModel);
  const setMode = useStore((s) => s.setMode);
  const setThoughtLevel = useStore((s) => s.setThoughtLevel);
  const thoughtLevel = useStore((s) => s.thoughtLevel);
  const thoughtLevelOptions = useStore((s) => s.thoughtLevelOptions);
  const currentModelName = useStore(
    (s) => s.models.find((m) => m.id === s.currentModel || m.modelId === s.currentModel)?.name || s.currentModel || '',
  );
  const input = useStore((s) => s.threadsById[s.activeThreadId]?.draft || '');
  const setInput = useStore((s) => s.setThreadDraft);
  const [chatError, setChatError] = useState(null);
  const [draggingAttachments, setDraggingAttachments] = useState(false);
  const [droppingAttachments, setDroppingAttachments] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showModePicker, setShowModePicker] = useState(false);
  const [showEffortPicker, setShowEffortPicker] = useState(false);
  const [selectedSlashCommandIndex, setSelectedSlashCommandIndex] = useState(0);
  const sessionSelectionRequestRef = useRef(0);
  const sessionSelectionInFlightRef = useRef(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const cancelRequestRef = useRef(0);
  const cancelInFlightRef = useRef(null);
  const [queueActionBusy, setQueueActionBusy] = useState(false);
  const queueActionRequestRef = useRef(0);
  const queueActionInFlightRef = useRef(null);
  const recoveryInFlightRef = useRef(null);
  const sendLaunchInFlightRef = useRef(null);
  const pasteImageInFlightRef = useRef(null);
  const dropAttachmentsInFlightRef = useRef(null);
  // Auto-dismiss error banner after 8 seconds
  useEffect(() => {
    if (!chatError) return;
    const timer = setTimeout(() => setChatError(null), 8000);
    return () => clearTimeout(timer);
  }, [chatError]);
  useEffect(() => {
    sessionSelectionRequestRef.current += 1;
    cancelRequestRef.current += 1;
    queueActionRequestRef.current += 1;
    sessionSelectionInFlightRef.current = null;
    cancelInFlightRef.current = null;
    queueActionInFlightRef.current = null;
    recoveryInFlightRef.current = null;
    sendLaunchInFlightRef.current = null;
    pasteImageInFlightRef.current = null;
    dropAttachmentsInFlightRef.current = null;
    setDraggingAttachments(false);
    setDroppingAttachments(false);
    setRecovering(false);
    setChatError(null);
    setCancelBusy(false);
    setQueueActionBusy(false);
    setShowModelPicker(false);
    setShowModePicker(false);
    setShowEffortPicker(false);
  }, [activeProjectId, activeThreadId]);
  const modeOptions = useMemo(() => {
    const items = (Array.isArray(modes) ? modes : [])
      .map((mode) => {
        const id = mode.id || mode.modeId;
        return id ? { id, name: getSessionModeLabel(mode, id) } : null;
      })
      .filter(Boolean);
    if (currentMode && !items.some((item) => item.id === currentMode)) {
      items.unshift({ id: currentMode, name: getSessionModeLabel(currentMode, currentMode) });
    }
    if (items.length === 0) items.push({ id: 'default', name: getSessionModeLabel('default') });
    return items;
  }, [currentMode, modes]);
  const currentModeName =
    modeOptions.find((m) => m.id === currentMode)?.name || getSessionModeLabel(currentMode, t('mode.default'));
  const effortOptions = useMemo(() => {
    const FALLBACK = [
      { id: 'disabled', name: t('composer.effort.disabled') },
      { id: 'enabled', name: t('composer.effort.enabled') },
      { id: 'low', name: 'Low' },
      { id: 'medium', name: 'Medium' },
      { id: 'high', name: 'High' },
      { id: 'xhigh', name: 'Xhigh' },
      { id: 'max', name: 'Max' },
    ];
    // 服务端回推的 options 已按当前模型过滤（如某些模型不支持 max/disabled）
    const serverItems = (Array.isArray(thoughtLevelOptions) ? thoughtLevelOptions : [])
      .map((o) => {
        const id = o.id || o.value;
        if (!id) return null;
        // 给 enabled/disabled 起可读档位名，其余沿用服务端 name
        const name =
          id === 'disabled'
            ? t('composer.effort.disabled')
            : id === 'enabled'
              ? t('composer.effort.enabled')
              : o.name || id;
        return { id, name };
      })
      .filter(Boolean);
    const base = serverItems.length > 0 ? serverItems : FALLBACK;
    // ultracode 始终作为附加项（复合模式，仅 /effort ultracode 触发，服务端 thought_level 不含此值）
    if (!base.some((o) => o.id === 'ultracode')) base.push({ id: 'ultracode', name: 'Ultracode' });
    return base;
  }, [t, thoughtLevelOptions]);
  const currentEffortName = useMemo(() => {
    if (!thoughtLevel) return t('composer.effort.enabled');
    if (thoughtLevel === 'disabled') return t('composer.effort.disabled');
    if (thoughtLevel === 'enabled') return t('composer.effort.enabled');
    if (thoughtLevel === 'ultracode') return 'Ultracode';
    const hit = effortOptions.find((o) => o.id === thoughtLevel);
    return hit ? hit.name : thoughtLevel;
  }, [effortOptions, t, thoughtLevel]);
  const promptSuggestionText = useMemo(() => getPromptSuggestionText(promptSuggestion), [promptSuggestion]);

  const applyPromptSuggestion = useCallback(() => {
    if (!promptSuggestionText || !activeThreadId) return;
    const currentDraft = String(input || '').trimEnd();
    setInput(currentDraft ? `${currentDraft}\n\n${promptSuggestionText}` : promptSuggestionText);
    clearPromptSuggestion(activeThreadId);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [activeThreadId, clearPromptSuggestion, input, promptSuggestionText, setInput]);

  const dismissPromptSuggestion = useCallback(() => {
    clearPromptSuggestion(activeThreadId);
  }, [activeThreadId, clearPromptSuggestion]);

  const runtimeStatus = activeProject?.runtimeStatus || 'idle';
  const runtimeUnavailable = runtimeStatus === 'error' || runtimeStatus === 'stopped';
  const accountLoginNeeded = ['required', 'authenticating', 'error'].includes(codeBuddyAccountAuthState);
  const connectionNeedsRecovery =
    runtimeUnavailable ||
    accountLoginNeeded ||
    connectionState === 'error' ||
    (connectionState === 'disconnected' && runtimeStatus === 'running');
  const canSend = connectionState === 'connected' && !accountLoginNeeded;
  const recoveryMessage =
    codeBuddyAccountAuthState === 'required'
      ? codeBuddyAccountAuthError || t('recovery.accountExpired')
      : codeBuddyAccountAuthState === 'authenticating'
        ? t('recovery.authInProgress')
        : codeBuddyAccountAuthState === 'error'
          ? codeBuddyAccountAuthError || t('recovery.authIncomplete')
          : activeProject?.runtimeError ||
            recoveryError ||
            (runtimeStatus === 'stopped' ? t('recovery.runtimeStopped') : t('recovery.sessionDisconnected'));
  const runtimeErrorText = String(activeProject?.runtimeError || recoveryError || recoveryMessage || '');
  const cliSetupLikelyNeeded =
    runtimeUnavailable &&
    !accountLoginNeeded &&
    /CodeBuddy CLI|CLI_INCOMPATIBLE|未找到|过低|无法识别|not found|ENOENT|最低支持|推荐版本|npm install -g/i.test(
      runtimeErrorText,
    );

  const changeSessionSetting = useCallback(
    async (kind, value) => {
      if (
        connectionState !== 'connected' ||
        !activeThreadId ||
        !value ||
        ['running', 'waiting', 'cancelling'].includes(activeThreadStatus) ||
        isAwaitingResponse
      )
        return;

      // 同 kind 防重入（不同 kind 可并行），避免连点同一选项重复 RPC
      if (sessionSelectionInFlightRef.current?.[kind]) return;

      const projectId = activeProjectId;
      const threadId = activeThreadId;
      // 仅用于切换会话后丢弃过期结果；不同 kind 可并发，不共用序号互斥
      const epoch = sessionSelectionRequestRef.current;
      const label =
        kind === 'model'
          ? t('composer.label.model')
          : kind === 'mode'
            ? t('composer.label.mode')
            : t('composer.label.effort');
      const isCurrent = () =>
        epoch === sessionSelectionRequestRef.current &&
        projectId === useStore.getState().activeProjectId &&
        threadId === useStore.getState().activeThreadId;

      // 立刻关菜单；store 侧乐观更新 pill 文案，不再用 busy 灰掉三个按钮
      if (kind === 'model') setShowModelPicker(false);
      else if (kind === 'mode') setShowModePicker(false);
      else setShowEffortPicker(false);

      const flight = { ...(sessionSelectionInFlightRef.current || {}), [kind]: true };
      sessionSelectionInFlightRef.current = flight;

      try {
        let changed;
        if (kind === 'model') {
          changed = await setModel(value);
        } else if (kind === 'mode') {
          changed = await setMode(value);
        } else if (kind === 'effort') {
          if (value === 'ultracode') {
            // ultracode 是复合模式，仅 /effort 斜杠命令触发（无 thought_level 值）。
            // 先乐观写 pill，再发命令；失败则回滚。
            const previousLevel =
              useStore.getState().threadRuntimeById[threadId]?.thoughtLevel ??
              useStore.getState().thoughtLevel;
            useStore.getState().patchThreadRuntime(threadId, { thoughtLevel: 'ultracode' });
            if (useStore.getState().activeThreadId === threadId) {
              useStore.setState({ thoughtLevel: 'ultracode' });
            }
            changed = await sendPrompt('/effort ultracode');
            if (!changed && isCurrent()) {
              useStore.getState().patchThreadRuntime(threadId, { thoughtLevel: previousLevel });
              if (useStore.getState().activeThreadId === threadId) {
                useStore.setState({ thoughtLevel: previousLevel });
              }
            }
          } else {
            changed = await setThoughtLevel(value);
          }
        } else {
          changed = false;
        }
        if (!isCurrent()) return;
        if (!changed) {
          setChatError(consumeStoreError(t('composer.switchFailed', { label })));
        }
      } catch (error) {
        if (isCurrent()) {
          setChatError(error?.message || t('composer.switchFailed', { label }));
        }
      } finally {
        if (sessionSelectionInFlightRef.current) {
          const next = { ...sessionSelectionInFlightRef.current };
          delete next[kind];
          sessionSelectionInFlightRef.current = Object.keys(next).length ? next : null;
        }
      }
    },
    [
      activeProjectId,
      activeThreadId,
      activeThreadStatus,
      connectionState,
      isAwaitingResponse,
      sendPrompt,
      setMode,
      setModel,
      setThoughtLevel,
      t,
    ],
  );

  const cancelActiveSession = useCallback(async () => {
    if (cancelInFlightRef.current || !activeThreadId) return;
    const operation = {};
    cancelInFlightRef.current = operation;
    const projectId = activeProjectId;
    const threadId = activeThreadId;
    const requestId = ++cancelRequestRef.current;
    const isCurrent = () =>
      requestId === cancelRequestRef.current &&
      projectId === useStore.getState().activeProjectId &&
      threadId === useStore.getState().activeThreadId;
    setCancelBusy(true);
    setChatError(null);
    try {
      const cancelled = await cancelSession();
      if (isCurrent() && !cancelled) setChatError(consumeStoreError(t('error.cancelFailed')));
    } catch (cancelError) {
      if (isCurrent()) setChatError(consumeStoreError(cancelError?.message || t('error.cancelFailed')));
    } finally {
      if (cancelInFlightRef.current === operation) {
        cancelInFlightRef.current = null;
        if (isCurrent()) setCancelBusy(false);
      }
    }
  }, [activeProjectId, activeThreadId, cancelSession, t]);

  const recoverConnection = async () => {
    if (!activeProjectId || recoveryInFlightRef.current) return;
    const operation = {};
    recoveryInFlightRef.current = operation;
    const projectId = activeProjectId;
    const threadId = activeThreadId;
    const isCurrent = () =>
      projectId === useStore.getState().activeProjectId && threadId === useStore.getState().activeThreadId;
    setRecovering(true);
    setChatError(null);
    try {
      const recovered = accountLoginNeeded
        ? // 一键用侧栏已选站点；切站在侧栏账号菜单完成。
          await authenticateCodeBuddyAccount({
            site: useStore.getState().guiSettings?.accountLoginSite || 'global',
          })
        : runtimeUnavailable
          ? await restartProjectRuntime(projectId)
          : await bootstrap();
      if (!isCurrent()) return;
      if (!recovered) {
        const currentError = useStore.getState().error;
        setChatError(
          useStore.getState().codeBuddyAccountAuthError ||
            currentError ||
            (accountLoginNeeded ? t('error.loginIncomplete') : t('error.reconnectFailed')),
        );
      }
    } catch (error) {
      if (isCurrent())
        setChatError(t('error.reconnectFailedDetail', { message: error?.message || t('error.unknown') }));
    } finally {
      if (recoveryInFlightRef.current === operation) {
        recoveryInFlightRef.current = null;
        if (isCurrent()) setRecovering(false);
      }
    }
  };

  const isStreaming = useMemo(
    () =>
      connectionState === 'connected' &&
      (['running', 'waiting', 'cancelling'].includes(activeThreadStatus) ||
        isAwaitingResponse ||
        Boolean(activePromptRunId)),
    [activeThreadStatus, connectionState, isAwaitingResponse, activePromptRunId],
  );
  const sessionResponseBusy =
    ['running', 'waiting', 'cancelling'].includes(activeThreadStatus) || isAwaitingResponse || activePromptRunId;
  const responseActivityLabel = useMemo(
    () =>
      getResponseActivityLabel({
        connectionState,
        historyReplayActive,
        activeThreadStatus,
        isAwaitingResponse,
        activePromptRunId,
        promptStartedAt,
        timeline,
        t,
      }),
    [
      connectionState,
      historyReplayActive,
      activeThreadStatus,
      isAwaitingResponse,
      activePromptRunId,
      promptStartedAt,
      timeline,
      t,
    ],
  );
  const slashSuggestions = useMemo(
    () => getSlashCommandSuggestions(input, availableCommands),
    [availableCommands, input],
  );

  useEffect(() => {
    setSelectedSlashCommandIndex(0);
  }, [input, slashSuggestions.length]);

  const selectSlashCommand = useCallback(
    (command) => {
      const nextInput = slashCommandSelectionText(command);
      if (!nextInput) return;
      setInput(nextInput);
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    [setInput],
  );

  const persistScrollPosition = useCallback(() => {
    const el = scrollContainerRef.current;
    const threadId = activeThreadId;
    if (!el || !threadId) return;
    saveChatScrollPosition(chatScrollMemoryByThreadId, threadId, {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
  }, [activeThreadId]);

  // Thread change or remount: restore saved scroll (or bottom) after layout paints.
  useEffect(() => {
    scrollRestorePendingRef.current = true;
    userDetachedScrollRef.current = false;
    const threadId = activeThreadId;
    let cancelled = false;
    let attempts = 0;

    const applyRestore = () => {
      if (cancelled) return;
      // User already scrolled away; do not yank them back to saved/bottom.
      if (userDetachedScrollRef.current) {
        scrollRestorePendingRef.current = false;
        return;
      }
      const el = scrollContainerRef.current;
      if (!el) {
        if (attempts < 12) {
          attempts += 1;
          requestAnimationFrame(applyRestore);
        } else {
          scrollRestorePendingRef.current = false;
        }
        return;
      }
      const hasMessages = (timeline || []).length > 0;
      // Wait one more frame if tall content hasn't laid out yet.
      if (hasMessages && el.scrollHeight <= el.clientHeight + 1 && attempts < 12) {
        attempts += 1;
        requestAnimationFrame(applyRestore);
        return;
      }
      if (userDetachedScrollRef.current) {
        scrollRestorePendingRef.current = false;
        return;
      }
      const saved = threadId ? chatScrollMemoryByThreadId.get(threadId) : null;
      const restored = resolveChatScrollRestore(saved, {
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        hasMessages,
      });
      el.scrollTop = restored.scrollTop;
      shouldAutoScrollRef.current = restored.stickBottom;
      setShowScrollBtn(restored.showScrollBtn);
      scrollRestorePendingRef.current = false;
    };

    requestAnimationFrame(applyRestore);
    return () => {
      cancelled = true;
      // Capture position before unmount (settings / other routes).
      persistScrollPosition();
    };
    // Intentionally not depending on timeline: streaming tokens must not re-trigger restore.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restore on thread/route remount
  }, [activeThreadId, activeProjectId, persistScrollPosition]);

  // History / late layout: re-apply saved mid-scroll if content arrived after first paint at top.
  useEffect(() => {
    if (scrollRestorePendingRef.current || userDetachedScrollRef.current) return;
    const el = scrollContainerRef.current;
    const threadId = activeThreadId;
    if (!el || !threadId) return;
    const saved = chatScrollMemoryByThreadId.get(threadId);
    if (!saved || saved.stickBottom) return;
    if (el.scrollTop > 0 || el.scrollHeight <= el.clientHeight + 1) return;
    if (!(Number(saved.top) > 0)) return;
    const restored = resolveChatScrollRestore(saved, {
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      hasMessages: (timeline || []).length > 0,
    });
    el.scrollTop = restored.scrollTop;
    shouldAutoScrollRef.current = restored.stickBottom;
    setShowScrollBtn(restored.showScrollBtn);
  }, [timeline.length, activeThreadId]);

  const scrollTranscriptToBottom = useCallback(
    (behavior = 'auto') => {
      const el = scrollContainerRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
      if (behavior === 'smooth') {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
      } else {
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
      }
      if (el && activeThreadId) {
        saveChatScrollPosition(chatScrollMemoryByThreadId, activeThreadId, {
          scrollTop: el.scrollHeight,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        });
      }
      setShowScrollBtn(false);
    },
    [activeThreadId],
  );

  // Stick to bottom while following: new messages, streaming tokens, or busy status.
  useEffect(() => {
    if (scrollRestorePendingRef.current) return;
    if (!shouldAutoScrollRef.current || userDetachedScrollRef.current) return;
    if (!isStreaming && (timeline || []).length === 0) return;
    scrollTranscriptToBottom('auto');
  }, [timeline, isStreaming, scrollTranscriptToBottom]);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (scrollRestorePendingRef.current && !userDetachedScrollRef.current) return;
    const nearBottom = isChatNearBottom({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
    shouldAutoScrollRef.current = nearBottom;
    // Only mark detached when clearly not at bottom (user scrolled up).
    if (!nearBottom) userDetachedScrollRef.current = true;
    else userDetachedScrollRef.current = false;
    setShowScrollBtn(!nearBottom);
    if (activeThreadId) {
      saveChatScrollPosition(chatScrollMemoryByThreadId, activeThreadId, {
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      });
    }
  }, [activeThreadId]);

  const handleWheel = useCallback(
    (event) => {
      const el = scrollContainerRef.current;
      if (event.deltaY >= 0 || !el || el.scrollHeight <= el.clientHeight + 1) return;
      shouldAutoScrollRef.current = false;
      userDetachedScrollRef.current = true;
      scrollRestorePendingRef.current = false;
      setShowScrollBtn(true);
      if (activeThreadId) {
        saveChatScrollPosition(chatScrollMemoryByThreadId, activeThreadId, {
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        });
        const saved = chatScrollMemoryByThreadId.get(activeThreadId);
        if (saved) {
          chatScrollMemoryByThreadId.set(activeThreadId, { ...saved, stickBottom: false });
        }
      }
    },
    [activeThreadId],
  );

  const jumpToLatest = useCallback(() => {
    shouldAutoScrollRef.current = true;
    userDetachedScrollRef.current = false;
    scrollRestorePendingRef.current = false;
    scrollTranscriptToBottom('smooth');
  }, [scrollTranscriptToBottom]);

  const onSubmit = useCallback(async () => {
    const value = input.trim();
    if ((!value && pendingAttachments.length === 0) || sendLaunchInFlightRef.current) return;
    if (!canSend) {
      setChatError(t('error.notConnected'));
      return;
    }
    const operation = {};
    sendLaunchInFlightRef.current = operation;
    const projectId = activeProjectId;
    const threadId = activeThreadId;
    const isCurrent = () =>
      projectId === useStore.getState().activeProjectId && threadId === useStore.getState().activeThreadId;
    const releaseTimer = setTimeout(() => {
      if (sendLaunchInFlightRef.current === operation) sendLaunchInFlightRef.current = null;
    }, 0);
    setChatError(null);
    // Sending always re-engages follow-latest (even if user was reading older messages).
    shouldAutoScrollRef.current = true;
    userDetachedScrollRef.current = false;
    scrollRestorePendingRef.current = false;
    scrollTranscriptToBottom('auto');
    try {
      const sent = await sendPrompt(value);
      if (isCurrent() && !sent) {
        setChatError(consumeStoreError(t('error.sendFailedRestored')));
      } else if (isCurrent()) {
        // User bubble / first token may paint after await — stick again.
        requestAnimationFrame(() => {
          if (!shouldAutoScrollRef.current || userDetachedScrollRef.current) return;
          scrollTranscriptToBottom('auto');
        });
      }
    } catch (err) {
      if (isCurrent())
        setChatError(t('error.sendFailedDetail', { message: err.message || t('error.unknown') }));
    } finally {
      clearTimeout(releaseTimer);
      if (sendLaunchInFlightRef.current === operation) sendLaunchInFlightRef.current = null;
    }
  }, [
    activeProjectId,
    activeThreadId,
    canSend,
    input,
    pendingAttachments.length,
    scrollTranscriptToBottom,
    sendPrompt,
    t,
  ]);

  const resumePromptQueue = useCallback(async () => {
    if (queueActionInFlightRef.current || !activeThreadId || !canSend || isStreaming) return;
    const operation = {};
    queueActionInFlightRef.current = operation;
    const projectId = activeProjectId;
    const threadId = activeThreadId;
    const requestId = ++queueActionRequestRef.current;
    const isCurrent = () =>
      requestId === queueActionRequestRef.current &&
      projectId === useStore.getState().activeProjectId &&
      threadId === useStore.getState().activeThreadId;
    setQueueActionBusy(true);
    setChatError(null);
    try {
      const resumed = await drainThreadPromptQueue(threadId);
      if (!isCurrent()) return;
      if (!resumed) setChatError(consumeStoreError(t('error.queueResumeFailed')));
    } catch (error) {
      if (isCurrent()) setChatError(error?.message || t('error.queueResumeFailedDetail'));
    } finally {
      if (queueActionInFlightRef.current === operation) {
        queueActionInFlightRef.current = null;
        if (isCurrent()) setQueueActionBusy(false);
      }
    }
  }, [activeProjectId, activeThreadId, canSend, drainThreadPromptQueue, isStreaming, t]);

  const movePromptInQueue = useCallback(
    async (promptId, direction) => {
      if (queueActionInFlightRef.current || !activeThreadId) return;
      const operation = {};
      queueActionInFlightRef.current = operation;
      const projectId = activeProjectId;
      const threadId = activeThreadId;
      const requestId = ++queueActionRequestRef.current;
      const isCurrent = () =>
        requestId === queueActionRequestRef.current &&
        projectId === useStore.getState().activeProjectId &&
        threadId === useStore.getState().activeThreadId;
      setQueueActionBusy(true);
      setChatError(null);
      try {
        const moved = await moveQueuedPrompt(threadId, promptId, direction);
        if (isCurrent() && !moved) setChatError(consumeStoreError(t('error.queueReorderFailed')));
      } catch (error) {
        if (isCurrent()) setChatError(error?.message || t('error.queueReorderFailed'));
      } finally {
        if (queueActionInFlightRef.current === operation) {
          queueActionInFlightRef.current = null;
          if (isCurrent()) setQueueActionBusy(false);
        }
      }
    },
    [activeProjectId, activeThreadId, moveQueuedPrompt, t],
  );

  const removePromptFromQueue = useCallback(
    async (promptId) => {
      if (queueActionInFlightRef.current || !activeThreadId) return;
      const operation = {};
      queueActionInFlightRef.current = operation;
      const projectId = activeProjectId;
      const threadId = activeThreadId;
      const requestId = ++queueActionRequestRef.current;
      const isCurrent = () =>
        requestId === queueActionRequestRef.current &&
        projectId === useStore.getState().activeProjectId &&
        threadId === useStore.getState().activeThreadId;
      setQueueActionBusy(true);
      setChatError(null);
      try {
        const removed = await removeQueuedPrompt(threadId, promptId);
        if (isCurrent() && !removed) setChatError(consumeStoreError(t('error.queueRemoveFailed')));
      } catch (error) {
        if (isCurrent()) setChatError(error?.message || t('error.queueRemoveFailed'));
      } finally {
        if (queueActionInFlightRef.current === operation) {
          queueActionInFlightRef.current = null;
          if (isCurrent()) setQueueActionBusy(false);
        }
      }
    },
    [activeProjectId, activeThreadId, removeQueuedPrompt, t],
  );

  const handlePaste = useCallback(
    async (event) => {
      if (!pasteImageEnabled) return;
      const files = Array.from(event.clipboardData?.items || [])
        .filter((item) => item.kind === 'file' && String(item.type || '').startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter(Boolean);
      if (!files.length) return;
      if (!event.clipboardData?.getData('text/plain')) event.preventDefault();
      if (pasteImageInFlightRef.current) return;
      const operation = {};
      pasteImageInFlightRef.current = operation;
      const projectId = activeProjectId;
      const threadId = activeThreadId;
      const isCurrent = () =>
        projectId === useStore.getState().activeProjectId && threadId === useStore.getState().activeThreadId;
      setChatError(null);
      try {
        for (const file of files) {
          if (file.size > 20 * 1024 * 1024) throw new Error(t('error.pasteImageTooLarge'));
          const dataBase64 = await readClipboardImage(file);
          if (!isCurrent()) return;
          const added = await addClipboardImageAttachment({
            name: file.name || 'clipboard-image',
            mimeType: file.type,
            size: file.size,
            dataBase64,
          });
          if (!isCurrent()) return;
          if (!added.length) throw new Error(useStore.getState().error || t('error.pasteImageFailed'));
        }
      } catch (error) {
        if (isCurrent()) setChatError(error?.message || t('error.pasteImageFailed'));
      } finally {
        if (pasteImageInFlightRef.current === operation) pasteImageInFlightRef.current = null;
      }
    },
    [activeProjectId, activeThreadId, addClipboardImageAttachment, pasteImageEnabled, t],
  );

  const hasDraggedFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');

  const handleDragEnter = useCallback((event) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    setDraggingAttachments(true);
  }, []);

  const handleDragOver = useCallback(
    (event) => {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      if (!draggingAttachments) setDraggingAttachments(true);
    },
    [draggingAttachments],
  );

  const handleDragLeave = useCallback((event) => {
    if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget)) return;
    setDraggingAttachments(false);
  }, []);

  const handleDrop = useCallback(
    async (event) => {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      setDraggingAttachments(false);
      if (dropAttachmentsInFlightRef.current) return;
      const files = Array.from(event.dataTransfer?.files || []);
      if (!files.length) return;
      const operation = {};
      dropAttachmentsInFlightRef.current = operation;
      const projectId = activeProjectId;
      const threadId = activeThreadId;
      const isCurrent = () =>
        projectId === useStore.getState().activeProjectId && threadId === useStore.getState().activeThreadId;
      setDroppingAttachments(true);
      setChatError(null);
      try {
        const result = await addDroppedAttachments(files);
        if (isCurrent() && result?.error) setChatError(result.error);
      } catch (error) {
        if (isCurrent()) setChatError(error?.message || t('error.dropFailed'));
      } finally {
        if (dropAttachmentsInFlightRef.current === operation) {
          dropAttachmentsInFlightRef.current = null;
          if (isCurrent()) setDroppingAttachments(false);
        }
      }
    },
    [activeProjectId, activeThreadId, addDroppedAttachments, t],
  );

  const handleKeyDown = useCallback(
    (e) => {
      if (e.nativeEvent?.isComposing || e.isComposing) return;
      const commandAction = slashCommandKeyboardAction(e.key, slashSuggestions.length > 0);
      if (commandAction === 'next') {
        e.preventDefault();
        setSelectedSlashCommandIndex((index) => (index + 1) % slashSuggestions.length);
        return;
      }
      if (commandAction === 'previous') {
        e.preventDefault();
        setSelectedSlashCommandIndex((index) => (index - 1 + slashSuggestions.length) % slashSuggestions.length);
        return;
      }
      if (commandAction === 'select') {
        e.preventDefault();
        selectSlashCommand(slashSuggestions[selectedSlashCommandIndex]);
        return;
      }
      if (commandAction === 'dismiss') {
        e.preventDefault();
        setInput('');
        return;
      }
      if (commandAction === 'submit' && !e.shiftKey) {
        e.preventDefault();
        onSubmit();
      }
    },
    [onSubmit, selectSlashCommand, selectedSlashCommandIndex, setInput, slashSuggestions],
  );

  // Group by date without cloning timeline items (keeps React.memo identity stable).
  const timelineWithDates = useMemo(() => {
    let lastDay = '';
    return groupTimelineForDisplay(timeline).map((item, index) => {
      const day = getDayLabel(item.createdAt, t);
      const showDate = day !== lastDay && index > 0;
      lastDay = day;
      return { item, showDate };
    });
  }, [t, timeline]);
  const recoveryNotice = connectionNeedsRecovery ? (
    <div
      className={`${timeline.length === 0 ? 'mt-16 ' : ''}mb-4 rounded-md border border-[rgba(248,113,113,0.3)] bg-[rgba(248,113,113,0.08)] px-4 py-4 text-center`}
    >
      <div className="text-sm font-medium text-[var(--color-accent-red)]">
        {accountLoginNeeded
          ? t('recovery.loginRequired')
          : runtimeUnavailable
            ? t('recovery.runtimeUnavailable')
            : t('recovery.connectionFailed')}
      </div>
      <div className="mt-2 break-words text-xs leading-5 text-[var(--color-text-secondary)]">{recoveryMessage}</div>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        {cliSetupLikelyNeeded ? (
          <button
            type="button"
            className="btn-primary px-4 py-2 text-xs"
            onClick={() => {
              requestSettingsSection('settings-section-cli');
              useStore.getState().setRoute('settings');
            }}
            data-testid="chat-open-cli-settings"
          >
            {t('recovery.openCliSettings')}
          </button>
        ) : null}
        <button
          type="button"
          className={`${cliSetupLikelyNeeded ? 'btn-ghost' : 'btn-primary'} px-4 py-2 text-xs`}
          disabled={recovering || codeBuddyAccountAuthState === 'authenticating'}
          onClick={recoverConnection}
        >
          {codeBuddyAccountAuthState === 'authenticating'
            ? t('recovery.waitLogin')
            : recovering
              ? t('recovery.recovering')
              : accountLoginNeeded
                ? t('recovery.login')
                : runtimeUnavailable
                  ? t('recovery.restartConnect')
                  : t('recovery.reconnect')}
        </button>
        {codeBuddyAccountAuthState === 'authenticating' ? (
          <button
            type="button"
            className="btn-ghost px-3 py-2 text-xs"
            onClick={() => cancelCodeBuddyAccountAuth?.()}
            data-testid="chat-account-cancel"
          >
            {t('account.cancelLogin')}
          </button>
        ) : null}
      </div>
    </div>
  ) : null;

  return (
    <div className="page-shell">
      {/* Messages area */}
      <div
        className="flex-1 overflow-y-auto"
        ref={scrollContainerRef}
        onScroll={handleScroll}
        onWheel={handleWheel}
      >
        <div className="mx-auto max-w-[820px] px-6 py-6">
          <SessionActivityStatus
            historyReplayActive={historyReplayActive}
            agentPhase={agentPhase}
            progress={progress}
          />
          <TeamStatusPanel teamState={teamState} />
          {timeline.length === 0 ? (
            connectionState === 'connecting' || runtimeStatus === 'starting' ? (
              <div className="flex items-center justify-center h-64">
                <div className="flex flex-col items-center gap-3">
                  <div className="animate-spin w-6 h-6 border-2 border-[var(--color-border-default)] border-t-[var(--color-accent-blue)] rounded-full" />
                  <span className="text-sm" style={{ color: 'var(--color-text-tertiary)' }}>
                    {t('chat.loading')}
                  </span>
                </div>
              </div>
            ) : connectionNeedsRecovery ? (
              recoveryNotice
            ) : (
              <div className="flex flex-col items-center justify-center pt-20">
                <div className="mb-3 text-2xl font-semibold text-[var(--color-text-primary)]">{t('chat.empty.title')}</div>
                <div className="mb-4 text-sm text-[var(--color-text-secondary)]">{t('chat.empty.subtitle')}</div>
                <div className="flex flex-wrap items-center justify-center gap-2 text-xs">
                  {[
                    'chat.empty.tag.slides',
                    'chat.empty.tag.research',
                    'chat.empty.tag.docs',
                    'chat.empty.tag.data',
                  ].map((key) => (
                    <button
                      key={key}
                      type="button"
                      className="rounded-full bg-[var(--color-bg-secondary)] border border-[var(--color-border-muted)] px-3 py-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-border-default)] transition-colors"
                      onClick={() => setInput(t('chat.empty.tagPrompt', { topic: t(key) }))}
                    >
                      {t(key)}
                    </button>
                  ))}
                </div>
              </div>
            )
          ) : (
            <div>
              <div className="text-xs text-[var(--color-text-muted)] text-center py-2">{t('chat.disclaimer')}</div>
              {timelineWithDates.map(({ item, showDate }, idx) => (
                <React.Fragment key={item.id || idx}>
                  {showDate && <DateSeparator label={getDayLabel(item.createdAt, t)} />}
                  <TimelineItem item={item} />
                </React.Fragment>
              ))}
            </div>
          )}
          {timeline.length > 0 ? recoveryNotice : null}
          {chatError && !(accountLoginNeeded && isAuthRelatedMessage(chatError)) ? (
            <div
              className="mx-0 mb-4 p-3 rounded-lg flex items-center justify-between"
              style={{
                background: 'var(--color-error-bg)',
                border: '1px solid var(--color-error)',
                color: 'var(--color-error)',
              }}
            >
              <span className="text-sm">{chatError}</span>
              <button
                className="btn-ghost text-sm"
                style={{ color: 'var(--color-error)' }}
                onClick={() => setChatError(null)}
              >
                {t('composer.closeError')}
              </button>
            </div>
          ) : null}
          <div ref={messagesEndRef} />

        </div>
      </div>

      {showScrollBtn ? (
        <div className="relative z-30 h-0">
          <button
            type="button"
            className="absolute bottom-3 left-1/2 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-[var(--color-border-default)] bg-[var(--color-bg-card)] text-[var(--color-text-primary)] shadow-lg transition-colors hover:bg-[var(--color-bg-hover)]"
            onClick={jumpToLatest}
            title={t('chat.scrollToLatest')}
            aria-label={t('chat.scrollToLatest')}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 6l4 4 4-4" />
            </svg>
          </button>
        </div>
      ) : null}

      {/* 固定在输入框上方，不随时间线滚动 */}
      <ResponseActivityIndicator label={responseActivityLabel} startedAt={promptStartedAt} />

      <ChatComposer
        textareaRef={textareaRef}
        promptSuggestionEnabled={promptSuggestionEnabled}
        promptSuggestionText={promptSuggestionText}
        applyPromptSuggestion={applyPromptSuggestion}
        dismissPromptSuggestion={dismissPromptSuggestion}
        pendingAttachments={pendingAttachments}
        removePendingAttachment={removePendingAttachment}
        promptQueue={promptQueue}
        queueActionBusy={queueActionBusy}
        canSend={canSend}
        isStreaming={isStreaming}
        resumePromptQueue={resumePromptQueue}
        movePromptInQueue={movePromptInQueue}
        removePromptFromQueue={removePromptFromQueue}
        draggingAttachments={draggingAttachments}
        droppingAttachments={droppingAttachments}
        handleDragEnter={handleDragEnter}
        handleDragOver={handleDragOver}
        handleDragLeave={handleDragLeave}
        handleDrop={handleDrop}
        slashSuggestions={slashSuggestions}
        selectedSlashCommandIndex={selectedSlashCommandIndex}
        setSelectedSlashCommandIndex={setSelectedSlashCommandIndex}
        selectSlashCommand={selectSlashCommand}
        input={input}
        setInput={setInput}
        handlePaste={handlePaste}
        handleKeyDown={handleKeyDown}
        chooseAttachments={chooseAttachments}
        capabilities={capabilities}
        connectionState={connectionState}
        sessionResponseBusy={sessionResponseBusy}
        showModePicker={showModePicker}
        setShowModePicker={setShowModePicker}
        modeOptions={modeOptions}
        currentMode={currentMode}
        currentModeName={currentModeName}
        changeSessionSetting={changeSessionSetting}
        showModelPicker={showModelPicker}
        setShowModelPicker={setShowModelPicker}
        models={models}
        currentModel={currentModel}
        currentModelName={currentModelName}
        showEffortPicker={showEffortPicker}
        setShowEffortPicker={setShowEffortPicker}
        effortOptions={effortOptions}
        thoughtLevel={thoughtLevel}
        currentEffortName={currentEffortName}
        cancelBusy={cancelBusy}
        cancelActiveSession={cancelActiveSession}
        onSubmit={onSubmit}
        showTokensCounter={showTokensCounter}
        usage={usage}
      />
    </div>
  );
}

const COMPOSER_HEIGHT_STORAGE_KEY = 'codebuddy-gui-composer-height';
const COMPOSER_MIN_HEIGHT = 52;
const COMPOSER_DEFAULT_HEIGHT = 64;
const COMPOSER_MAX_HEIGHT = 360;

function clampComposerHeight(value) {
  const maxHeight =
    typeof window === 'undefined' ? COMPOSER_MAX_HEIGHT : Math.min(COMPOSER_MAX_HEIGHT, Math.round(window.innerHeight * 0.5));
  return Math.max(COMPOSER_MIN_HEIGHT, Math.min(maxHeight, Math.round(Number(value) || COMPOSER_DEFAULT_HEIGHT)));
}

function readStoredComposerHeight() {
  try {
    const raw = localStorage.getItem(COMPOSER_HEIGHT_STORAGE_KEY);
    if (!raw) return COMPOSER_DEFAULT_HEIGHT;
    return clampComposerHeight(raw);
  } catch (_) {
    return COMPOSER_DEFAULT_HEIGHT;
  }
}

const ChatComposer = React.memo(function ChatComposer({
  textareaRef,
  promptSuggestionEnabled,
  promptSuggestionText,
  applyPromptSuggestion,
  dismissPromptSuggestion,
  pendingAttachments,
  removePendingAttachment,
  promptQueue,
  queueActionBusy,
  canSend,
  isStreaming,
  resumePromptQueue,
  movePromptInQueue,
  removePromptFromQueue,
  draggingAttachments,
  droppingAttachments,
  handleDragEnter,
  handleDragOver,
  handleDragLeave,
  handleDrop,
  slashSuggestions,
  selectedSlashCommandIndex,
  setSelectedSlashCommandIndex,
  selectSlashCommand,
  input,
  setInput,
  handlePaste,
  handleKeyDown,
  chooseAttachments,
  capabilities,
  connectionState,
  sessionResponseBusy,
  showModePicker,
  setShowModePicker,
  modeOptions,
  currentMode,
  currentModeName,
  changeSessionSetting,
  showModelPicker,
  setShowModelPicker,
  models,
  currentModel,
  currentModelName,
  showEffortPicker,
  setShowEffortPicker,
  effortOptions,
  thoughtLevel,
  currentEffortName,
  cancelBusy,
  cancelActiveSession,
  onSubmit,
  showTokensCounter,
  usage,
}) {
  const t = useUiTranslate();
  const [composerHeight, setComposerHeight] = useState(readStoredComposerHeight);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [showWorkspaceDirsMenu, setShowWorkspaceDirsMenu] = useState(false);
  const workspaceExtraDirs = useStore((s) => s.workspaceExtraDirs || []);
  const workspaceDirsBusy = useStore((s) => s.workspaceDirsBusy);
  const workspaceDirsError = useStore((s) => s.workspaceDirsError);
  const chooseAndAddWorkspaceExtraDir = useStore((s) => s.chooseAndAddWorkspaceExtraDir);
  const removeWorkspaceExtraDir = useStore((s) => s.removeWorkspaceExtraDir);
  const resizeDragRef = useRef(null);
  const imageCapability = Boolean(
    capabilities?.promptCapabilities?.image || capabilities?.prompt_capabilities?.image,
  );

  const closeAttachMenu = useCallback(() => setShowAttachMenu(false), []);
  const closeWorkspaceDirsMenu = useCallback(() => setShowWorkspaceDirsMenu(false), []);
  const pickAttachments = useCallback(
    async (kind) => {
      setShowAttachMenu(false);
      setShowWorkspaceDirsMenu(false);
      await chooseAttachments({ kind });
    },
    [chooseAttachments],
  );

  useEffect(() => {
    if (showModePicker || showModelPicker || showEffortPicker) {
      setShowAttachMenu(false);
      setShowWorkspaceDirsMenu(false);
    }
  }, [showModePicker, showModelPicker, showEffortPicker]);

  useEffect(() => {
    if (!showAttachMenu && !showWorkspaceDirsMenu) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setShowAttachMenu(false);
        setShowWorkspaceDirsMenu(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showAttachMenu, showWorkspaceDirsMenu]);

  useEffect(() => {
    try {
      localStorage.setItem(COMPOSER_HEIGHT_STORAGE_KEY, String(composerHeight));
    } catch (_) {}
  }, [composerHeight]);

  useEffect(() => {
    const onResize = () => setComposerHeight((current) => clampComposerHeight(current));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const onPointerMove = (event) => {
      const drag = resizeDragRef.current;
      if (!drag) return;
      // 向上拖增高，向下拖变矮
      const next = clampComposerHeight(drag.startHeight + (drag.startY - event.clientY));
      setComposerHeight(next);
    };
    const endDrag = () => {
      if (!resizeDragRef.current) return;
      resizeDragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
    };
  }, []);

  const beginComposerResize = (event) => {
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    resizeDragRef.current = {
      startY: event.clientY,
      startHeight: composerHeight,
    };
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <div className="chat-composer-wrap shrink-0">
      <div className="mx-auto max-w-[820px]">
        {promptSuggestionEnabled && promptSuggestionText ? (
          <div className="mb-2 flex items-start gap-2 rounded-md border border-[rgba(59,130,246,0.3)] bg-[rgba(59,130,246,0.08)] px-3 py-2">
            <svg
              className="mt-0.5 shrink-0 text-[var(--color-accent-blue)]"
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M8 1.5l1.1 3.1L12 6l-2.9 1.4L8 10.5 6.9 7.4 4 6l2.9-1.4L8 1.5zM12.5 10l.6 1.6 1.4.7-1.4.7-.6 1.5-.6-1.5-1.4-.7 1.4-.7.6-1.6z" />
            </svg>
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={applyPromptSuggestion}
              title={promptSuggestionText}
            >
              <span className="block text-[10px] font-medium uppercase text-[var(--color-accent-blue)]">
                {t('suggestion.title')}
              </span>
              <span className="mt-0.5 line-clamp-3 block whitespace-pre-wrap break-words text-xs leading-5 text-[var(--color-text-secondary)]">
                {promptSuggestionText}
              </span>
            </button>
            <button
              type="button"
              className="shrink-0 rounded px-2 py-1 text-xs font-medium text-[var(--color-accent-blue)] hover:bg-[var(--color-bg-hover)]"
              onClick={applyPromptSuggestion}
            >
              {t('suggestion.apply')}
            </button>
            <button
              type="button"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
              onClick={dismissPromptSuggestion}
              title={t('suggestion.dismiss')}
              aria-label={t('suggestion.dismiss')}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3 3l10 10M13 3L3 13" />
              </svg>
            </button>
          </div>
        ) : null}
        {pendingAttachments.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {pendingAttachments.map((attachment) => (
              <div
                key={attachment.path}
                className="flex max-w-full items-center gap-1.5 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-2 py-1 text-xs text-[var(--color-text-secondary)]"
              >
                <span>{attachment.kind === 'image' ? t('attachment.image') : t('attachment.file')}</span>
                <span className="max-w-[220px] truncate" title={attachment.path}>
                  {attachment.name}
                </span>
                <button
                  className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                  onClick={() => removePendingAttachment(attachment.path)}
                  title={t('attachment.remove')}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {promptQueue.length > 0 ? (
          <div className="mb-2 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3 py-2">
            <div className="mb-1 flex items-center justify-between gap-2">
              <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
                {t('queue.title', { n: promptQueue.length })}
              </div>
              <button
                className="rounded px-2 py-0.5 text-[10px] text-[var(--color-accent-blue)] hover:bg-[var(--color-bg-hover)] disabled:cursor-wait disabled:opacity-50"
                disabled={queueActionBusy || !canSend || isStreaming}
                onClick={resumePromptQueue}
                title={
                  !canSend
                    ? t('queue.waitConnection')
                    : isStreaming
                      ? t('queue.waitStream')
                      : t('queue.sendNext')
                }
              >
                {queueActionBusy ? t('queue.busy') : t('queue.resume')}
              </button>
            </div>
            <div className="space-y-1">
              {promptQueue.map((item, index) => (
                <div key={item.id} className="flex items-center gap-2 text-xs">
                  <span className="text-[var(--color-text-muted)]">{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-[var(--color-text-secondary)]" title={item.text}>
                    {item.text}
                  </span>
                  <button
                    className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-30"
                    disabled={queueActionBusy || index === 0}
                    onClick={() => movePromptInQueue(item.id, 'up')}
                    title={t('queue.moveUp')}
                    aria-label={t('queue.moveUpAria')}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M4 10l4-4 4 4" />
                    </svg>
                  </button>
                  <button
                    className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-30"
                    disabled={queueActionBusy || index === promptQueue.length - 1}
                    onClick={() => movePromptInQueue(item.id, 'down')}
                    title={t('queue.moveDown')}
                    aria-label={t('queue.moveDownAria')}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M4 6l4 4 4-4" />
                    </svg>
                  </button>
                  <button
                    className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] disabled:cursor-wait disabled:opacity-50"
                    disabled={queueActionBusy}
                    onClick={() => removePromptFromQueue(item.id)}
                    title={t('queue.remove')}
                    aria-label={t('queue.remove')}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M3 3l10 10M13 3L3 13" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <div
          className={`chat-composer relative rounded-lg border bg-[var(--color-bg-card)] transition-colors ${draggingAttachments || droppingAttachments ? 'border-[var(--color-accent-blue)]' : 'border-[var(--color-border-default)]'}`}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div
            className="chat-composer-resize-handle"
            role="separator"
            aria-orientation="horizontal"
            aria-label={t('composer.resize')}
            title={t('composer.resize')}
            onPointerDown={beginComposerResize}
          >
            <span className="chat-composer-resize-grip" aria-hidden="true" />
          </div>
          {draggingAttachments || droppingAttachments ? (
            <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-lg bg-[var(--color-bg-secondary)]/95 text-sm font-medium text-[var(--color-accent-blue)]">
              {droppingAttachments ? t('attachment.dropReading') : t('attachment.dropRelease')}
            </div>
          ) : null}
          {slashSuggestions.length > 0 ? (
            <div
              data-slash-command-menu
              className="absolute bottom-full left-0 right-0 z-20 mb-2 max-h-64 overflow-y-auto rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] py-1 shadow-xl"
            >
              {slashSuggestions.map((command, index) => (
                <button
                  key={command.name}
                  data-slash-command-name={command.name}
                  className={`flex w-full items-start gap-3 px-3 py-2 text-left ${index === selectedSlashCommandIndex ? 'bg-[var(--color-bg-hover)]' : 'hover:bg-[var(--color-bg-hover)]'}`}
                  onMouseEnter={() => setSelectedSlashCommandIndex(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    selectSlashCommand(command);
                  }}
                >
                  <span className="shrink-0 font-mono text-xs text-[var(--color-accent-blue)]">/{command.name}</span>
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 block text-xs text-[var(--color-text-secondary)]">
                      {command.description || ''}
                    </span>
                    {command.input?.hint ? (
                      <span className="mt-0.5 block font-mono text-[10px] text-[var(--color-text-muted)]">
                        {command.input.hint}
                      </span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={handlePaste}
            onKeyDown={handleKeyDown}
            placeholder={
              canSend
                ? isStreaming
                  ? t('input.placeholderRunning')
                  : t('input.placeholder')
                : t('input.placeholderDisconnected')
            }
            style={{ height: `${composerHeight}px` }}
            className="chat-composer-input w-full resize-none bg-transparent px-4 pt-2 pb-1 text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)]"
          />
          <div className="flex min-w-0 items-center justify-between gap-2 px-3 pb-3">
            <div className="flex shrink-0 items-center gap-1">
              <div className="relative">
                <button
                  type="button"
                  className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowModePicker(false);
                    setShowModelPicker(false);
                    setShowEffortPicker(false);
                    setShowWorkspaceDirsMenu(false);
                    setShowAttachMenu((open) => !open);
                  }}
                  disabled={droppingAttachments}
                  title={t('input.addAttachment')}
                  aria-label={t('input.addAttachment')}
                  aria-expanded={showAttachMenu}
                  aria-haspopup="menu"
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M5.5 8.5l4.2-4.2a2.1 2.1 0 013 3L7.2 12.8a3.2 3.2 0 01-4.5-4.5l5.1-5.1" />
                  </svg>
                </button>
                {showAttachMenu && (
                  <>
                    <div
                      className="fixed inset-0 z-10"
                      style={{ left: 'var(--sidebar-width, 252px)' }}
                      onClick={closeAttachMenu}
                      aria-hidden="true"
                    />
                    <div
                      role="menu"
                      aria-label={t('input.addAttachment')}
                      data-testid="composer-attach-menu"
                      className="composer-menu composer-menu--open absolute bottom-full left-0 mb-1 z-20 w-36"
                    >
                      <button
                        type="button"
                        role="menuitem"
                        disabled={droppingAttachments || !imageCapability}
                        title={
                          imageCapability
                            ? t('input.addImage')
                            : t('input.imageCapabilityUnavailable')
                        }
                        aria-label={t('input.addImage')}
                        className="composer-menu-item w-full px-3 py-1.5 text-left text-xs disabled:cursor-not-allowed disabled:opacity-40"
                        onClick={() => pickAttachments('image')}
                      >
                        {t('input.menu.image')}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={droppingAttachments}
                        title={t('input.addFile')}
                        aria-label={t('input.addFile')}
                        className="composer-menu-item w-full px-3 py-1.5 text-left text-xs disabled:opacity-50"
                        onClick={() => pickAttachments('file')}
                      >
                        {t('input.menu.file')}
                      </button>
                    </div>
                  </>
                )}
              </div>
              <div className="relative">
                <button
                  type="button"
                  className="flex h-7 items-center justify-center gap-0.5 rounded-full px-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowModePicker(false);
                    setShowModelPicker(false);
                    setShowEffortPicker(false);
                    setShowAttachMenu(false);
                    setShowWorkspaceDirsMenu((open) => !open);
                  }}
                  disabled={connectionState !== 'connected' || workspaceDirsBusy}
                  title={t('composer.workspaceDirs')}
                  aria-label={t('composer.workspaceDirs')}
                  aria-expanded={showWorkspaceDirsMenu}
                  aria-haspopup="menu"
                  data-testid="composer-workspace-dirs-btn"
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M2 4.5h4l1.2 1.5H14v6.5a1 1 0 01-1 1H3a1 1 0 01-1-1V4.5z" />
                    <path d="M5 8h6M8 5.5v5" />
                  </svg>
                  {workspaceExtraDirs.length > 0 ? (
                    <span className="min-w-[14px] rounded-full bg-[var(--color-bg-tertiary)] px-1 text-[10px] leading-4 text-[var(--color-text-secondary)]">
                      {workspaceExtraDirs.length}
                    </span>
                  ) : null}
                </button>
                {showWorkspaceDirsMenu && (
                  <>
                    <div
                      className="fixed inset-0 z-10"
                      style={{ left: 'var(--sidebar-width, 252px)' }}
                      onClick={closeWorkspaceDirsMenu}
                      aria-hidden="true"
                    />
                    <div
                      role="menu"
                      aria-label={t('composer.workspaceDirs')}
                      data-testid="composer-workspace-dirs-menu"
                      className="composer-menu composer-menu--open absolute bottom-full left-0 mb-1 z-20 w-72"
                    >
                      <div className="border-b border-[var(--color-border-muted)] px-3 py-2 text-[11px] font-medium text-[var(--color-text-secondary)]">
                        {t('composer.workspaceDirs')}
                        {workspaceDirsBusy ? ` · ${t('composer.workspaceDirs.syncing')}` : ''}
                      </div>
                      {workspaceExtraDirs.length === 0 ? (
                        <div className="px-3 py-2 text-[11px] leading-4 text-[var(--color-text-muted)]">
                          {t('composer.workspaceDirs.empty')}
                        </div>
                      ) : (
                        <ul className="max-h-48 overflow-auto py-1">
                          {workspaceExtraDirs.map((dir) => (
                            <li
                              key={dir}
                              className="flex items-start gap-2 px-3 py-1.5 text-[11px] text-[var(--color-text-primary)]"
                            >
                              <span className="min-w-0 flex-1 break-all" title={dir}>{dir}</span>
                              <button
                                type="button"
                                role="menuitem"
                                className="shrink-0 text-[var(--color-error)] hover:underline disabled:opacity-50"
                                disabled={workspaceDirsBusy}
                                onClick={async () => {
                                  await removeWorkspaceExtraDir(dir);
                                }}
                              >
                                {t('composer.workspaceDirs.remove')}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                      {workspaceDirsError ? (
                        <div className="border-t border-[var(--color-border-muted)] px-3 py-1.5 text-[11px] text-[var(--color-error)]">
                          {workspaceDirsError}
                        </div>
                      ) : null}
                      <div className="border-t border-[var(--color-border-muted)] p-1">
                        <button
                          type="button"
                          role="menuitem"
                          className="composer-menu-item w-full px-3 py-1.5 text-left text-xs disabled:opacity-50"
                          disabled={workspaceDirsBusy || connectionState !== 'connected'}
                          onClick={async () => {
                            const result = await chooseAndAddWorkspaceExtraDir();
                            if (result) setShowWorkspaceDirsMenu(true);
                          }}
                        >
                          {t('composer.workspaceDirs.add')}
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
              <div className="relative">
                <button
                  type="button"
                  className={`composer-picker-trigger flex items-center gap-1 rounded-full border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-2.5 py-1 text-xs transition-colors disabled:opacity-50 ${
                    isFullAccessMode(currentMode)
                      ? 'composer-picker-trigger--special'
                      : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                  }`}
                  disabled={connectionState !== 'connected' || sessionResponseBusy}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowAttachMenu(false);
                    setShowWorkspaceDirsMenu(false);
                    setShowModePicker(!showModePicker);
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M8 2c-1.5 0-3 .5-4 1.5l1.5 1.5C6.5 4.5 7.5 4 8 4c2 0 4 1.5 4 4h-1.5l2 2.5 2-2.5H13c0-2.5-2-4-5-4z" />
                    <path d="M8 14c1.5 0 3-.5 4-1.5L10.5 11C9.5 11.5 8.5 12 8 12c-2 0-4-1.5-4-4h1.5l-2-2.5-2 2.5H3c0 2.5 2 4 5 4z" />
                  </svg>
                  <FlipLabel value={currentModeName} special={isFullAccessMode(currentMode)} />
                </button>
                <ComposerAnimatedMenu
                  open={showModePicker}
                  onClose={() => setShowModePicker(false)}
                  className="bottom-full left-0 mb-1 w-40"
                >
                  {modeOptions.map((m) => {
                    const special = isFullAccessMode(m.id);
                    const selected = m.id === currentMode;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        role="menuitem"
                        disabled={sessionResponseBusy}
                        className={`composer-menu-item w-full px-3 py-1.5 text-left text-xs disabled:opacity-50${
                          special ? ' composer-menu-item--special' : ''
                        }${selected ? ' is-selected' : ''}`}
                        style={
                          special
                            ? undefined
                            : {
                                color: selected
                                  ? 'var(--color-accent-blue)'
                                  : 'var(--color-text-secondary)',
                              }
                        }
                        onClick={() => changeSessionSetting('mode', m.id)}
                      >
                        {m.name}
                      </button>
                    );
                  })}
                </ComposerAnimatedMenu>
              </div>
            </div>
            <div className="composer-controls-right flex min-w-0 items-center">
              {/* 模型 + 思考强度贴在一组；与发送键拉开间距，窄窗时优先保留本组 */}
              <div className="composer-picker-cluster flex min-w-0 items-center gap-1.5">
                <div className="relative min-w-0">
                  <button
                    type="button"
                    className="composer-picker-trigger max-w-[min(9.5rem,28vw)] truncate rounded-full border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-2.5 py-1 text-xs text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] disabled:opacity-50"
                    disabled={connectionState !== 'connected' || sessionResponseBusy}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowAttachMenu(false);
                      setShowWorkspaceDirsMenu(false);
                      setShowModelPicker(!showModelPicker);
                    }}
                  >
                    <FlipLabel value={currentModelName || currentModel || t('composer.selectModel')} />
                  </button>
                  <ComposerAnimatedMenu
                    open={showModelPicker}
                    onClose={() => setShowModelPicker(false)}
                    data-model-picker
                    className="bottom-full right-0 mb-1 w-56 max-w-[calc(100vw-1rem)] max-h-60 overflow-y-auto"
                  >
                    {models.length > 0 ? (
                      models.map((m) => {
                        const modelId = m.id || m.modelId || m.name;
                        return (
                          <button
                            key={modelId}
                            type="button"
                            role="menuitem"
                            disabled={sessionResponseBusy}
                            className="composer-menu-item w-full px-3 py-1.5 text-left text-xs disabled:opacity-50"
                            style={{
                              color:
                                modelId === currentModel
                                  ? 'var(--color-accent-blue)'
                                  : 'var(--color-text-secondary)',
                            }}
                            onClick={() => changeSessionSetting('model', modelId)}
                          >
                            {m.name || m.id || m.modelId}
                          </button>
                        );
                      })
                    ) : (
                      <div className="px-3 py-2 text-xs text-[var(--color-text-muted)]">加载中...</div>
                    )}
                  </ComposerAnimatedMenu>
                </div>
                <div className="relative min-w-0 shrink-0">
                  <button
                    type="button"
                    className={`composer-picker-trigger max-w-[min(7.5rem,24vw)] truncate rounded-full border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-2.5 py-1 text-xs transition-colors disabled:opacity-50 ${
                      isUltracodeEffort(thoughtLevel)
                        ? 'composer-picker-trigger--special'
                        : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                    }`}
                    disabled={connectionState !== 'connected' || sessionResponseBusy}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowAttachMenu(false);
                      setShowWorkspaceDirsMenu(false);
                      setShowEffortPicker(!showEffortPicker);
                    }}
                    title={t('composer.effort')}
                  >
                    <FlipLabel value={currentEffortName} special={isUltracodeEffort(thoughtLevel)} />
                  </button>
                  <ComposerAnimatedMenu
                    open={showEffortPicker}
                    onClose={() => setShowEffortPicker(false)}
                    data-effort-picker
                    className="bottom-full right-0 mb-1 w-44 max-w-[calc(100vw-1rem)] max-h-60 overflow-y-auto"
                  >
                    {effortOptions.map((o) => {
                      const level = thoughtLevel || 'enabled';
                      const special = isUltracodeEffort(o.id);
                      const selected = o.id === level;
                      return (
                        <button
                          key={o.id}
                          type="button"
                          role="menuitem"
                          disabled={sessionResponseBusy}
                          className={`composer-menu-item w-full px-3 py-1.5 text-left text-xs disabled:opacity-50${
                            special ? ' composer-menu-item--special' : ''
                          }${selected ? ' is-selected' : ''}`}
                          style={
                            special
                              ? undefined
                              : {
                                  color: selected
                                    ? 'var(--color-accent-blue)'
                                    : 'var(--color-text-secondary)',
                                }
                          }
                          onClick={() => changeSessionSetting('effort', o.id)}
                        >
                          {o.name}
                        </button>
                      );
                    })}
                  </ComposerAnimatedMenu>
                </div>
              </div>
              {isStreaming ? (
                <button
                  type="button"
                  className="composer-action-btn composer-action-btn--stop ml-4 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-primary)] hover:text-[var(--color-text-primary)] disabled:cursor-wait disabled:opacity-60"
                  disabled={cancelBusy}
                  onClick={cancelActiveSession}
                  title={cancelBusy ? t('input.stopping') : t('input.stop')}
                  aria-label={cancelBusy ? t('input.stopping') : t('input.stop')}
                >
                  {cancelBusy ? (
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[var(--color-border-default)] border-t-[var(--color-text-primary)]" />
                  ) : (
                    <Square size={14} fill="currentColor" strokeWidth={0} />
                  )}
                </button>
              ) : (
                <button
                  type="button"
                  className="composer-action-btn composer-action-btn--send ml-4 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-text-primary)] text-[var(--color-bg-primary)] shadow-sm transition-all hover:scale-105 active:scale-95 disabled:opacity-40 disabled:hover:scale-100"
                  onClick={onSubmit}
                  disabled={!canSend || (!input.trim() && pendingAttachments.length === 0)}
                  title={t('input.send')}
                  aria-label={t('input.send')}
                >
                  <ArrowUp size={18} strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>
        </div>

        {showTokensCounter && usage && (
          <div className="mt-2 text-center text-[10px] text-[var(--color-text-muted)]">
            用量: {usage.used ?? '-'} / {usage.size ?? '-'}
          </div>
        )}
      </div>
    </div>
  );
});
