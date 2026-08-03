/**
 * Production tool-output formatting (WebUI-aligned).
 * Hard rule: every kind — including unknown MCP tools — goes through
 * normalize → classify → clamp / path-list summary. Never dump raw JSON envelopes
 * as the default expanded body.
 */

const DEFAULT_MAX_LINES = 8;
const FULL_MAX_LINES = 200;
const FULL_MAX_CHARS = 50_000;
const SUMMARY_MAX = 80;
const PATH_PREVIEW = 5;

const PATH_LIKE =
  /^(?:[a-zA-Z]:\\|\\\\|\/|\.\/|\.\.\/)[^\n\r*]{1,500}$/;
const WIN_ABS = /^[a-zA-Z]:\\/;
const NODE_MODULES = /node_modules/i;

function firstString(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (_) {
    return String(value);
  }
}

function truncateOneLine(text, max = SUMMARY_MAX) {
  const one = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!one) return '';
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** WebUI Sn-style result normalizer. */
export function normalizeToolResult(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    // ACP content blocks: [{ type: 'text', text }]
    const texts = value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          if (typeof item.text === 'string') return item.text;
          if (typeof item.content === 'string') return item.content;
        }
        return '';
      })
      .filter(Boolean);
    if (texts.length) return texts.join('\n');
    return safeJsonStringify(value);
  }
  if (typeof value === 'object') {
    // Single-key string object (e.g. { stdout: "..." })
    const keys = Object.keys(value);
    if (keys.length === 1 && typeof value[keys[0]] === 'string') {
      return value[keys[0]];
    }
    if (value.type === 'text' && typeof value.text === 'string') return value.text;
    // ACP / nested content blocks before generic field pick
    if (Array.isArray(value.content)) return normalizeToolResult(value.content);
    // Prefer common string text fields only (never String(array))
    const preferred = firstString(
      typeof value.text === 'string' ? value.text : null,
      typeof value.content === 'string' ? value.content : null,
      typeof value.message === 'string' ? value.message : null,
      typeof value.stdout === 'string' ? value.stdout : null,
      typeof value.output === 'string' ? value.output : null,
      typeof value.result === 'string' ? value.result : null,
    );
    if (preferred && keys.length <= 4) {
      const rest = { ...value };
      delete rest.text;
      delete rest.content;
      delete rest.message;
      delete rest.stdout;
      delete rest.output;
      delete rest.result;
      delete rest.type;
      if (Object.keys(rest).length === 0) return preferred;
    }
    return safeJsonStringify(value);
  }
  return String(value);
}

export function normalizeToolInput(value) {
  if (value == null) return { summary: '', raw: '' };
  if (typeof value === 'string') {
    return { summary: truncateOneLine(value), raw: value };
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const preferred = firstString(
      value.command,
      value.path,
      value.file_path,
      value.filePath,
      value.pattern,
      value.query,
      value.url,
      value.description,
    );
    return {
      summary: truncateOneLine(preferred || safeJsonStringify(value)),
      raw: safeJsonStringify(value),
      fields: {
        command: value.command || null,
        path: value.path || value.file_path || value.filePath || null,
        pattern: value.pattern || null,
        query: value.query || null,
        url: value.url || null,
        description: value.description || null,
      },
    };
  }
  const raw = safeJsonStringify(value);
  return { summary: truncateOneLine(raw), raw };
}

export function summarizeToolLine(input, max = SUMMARY_MAX) {
  return normalizeToolInput(input).summary.slice(0, max + 1).replace(/…$/, '…') || truncateOneLine(normalizeToolInput(input).summary, max);
}

export function clampTextLines(text, maxLines = DEFAULT_MAX_LINES) {
  const source = String(text ?? '');
  if (!source) {
    return { visible: '', hiddenLines: 0, totalLines: 0, truncated: false };
  }
  const lines = source.split('\n');
  const totalLines = lines.length;
  if (totalLines <= maxLines) {
    return { visible: source, hiddenLines: 0, totalLines, truncated: false };
  }
  return {
    visible: lines.slice(0, maxLines).join('\n'),
    hiddenLines: totalLines - maxLines,
    totalLines,
    truncated: true,
  };
}

/** Strip shell protocol chrome (WebUI R$). */
export function stripShellChrome(text) {
  let source = String(text ?? '');
  if (!source) return '';
  // Common CLI wrappers
  source = source.replace(/^Command:\s*.+\n?/im, '');
  source = source.replace(/^Exit\s*Code:\s*.+\n?/im, '');
  source = source.replace(/^Working\s*Directory:\s*.+\n?/im, '');
  source = source.replace(/^Stdout:\s*\n?/im, '');
  source = source.replace(/^Stderr:\s*\n?/im, '');
  return source.trim();
}

function looksLikePath(line) {
  const s = String(line || '').trim().replace(/^["']|["']$/g, '');
  if (!s || s.length > 500) return false;
  if (PATH_LIKE.test(s)) return true;
  if (WIN_ABS.test(s)) return true;
  if (s.includes('/') && !s.includes(' ') && s.length > 3) return true;
  if (s.includes('\\') && s.length > 3) return true;
  return false;
}

export function isPathHeavyText(text) {
  const source = String(text || '');
  if (!source.trim()) return false;
  const lines = source.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return false;
  const pathLines = lines.filter(looksLikePath);
  const ratio = pathLines.length / lines.length;
  if (pathLines.length >= 5 && ratio >= 0.6) return true;
  if (NODE_MODULES.test(source) && pathLines.length >= 3) return true;
  // Dense single-line JSON array of paths
  if (source.length > 200 && (source.match(/\\/g) || []).length > 20 && pathLines.length >= 1) {
    return true;
  }
  return false;
}

function pathsFromArray(arr) {
  const paths = [];
  for (const item of arr) {
    if (typeof item === 'string' && looksLikePath(item)) paths.push(item.trim());
    else if (item && typeof item === 'object') {
      const p = firstString(item.path, item.file, item.filePath, item.file_path, item.name);
      if (p && looksLikePath(p)) paths.push(p);
    }
  }
  return paths;
}

export function extractPathList(value) {
  if (value == null) return null;

  if (Array.isArray(value)) {
    const paths = pathsFromArray(value);
    if (paths.length >= 2) {
      return {
        count: paths.length,
        preview: paths.slice(0, PATH_PREVIEW),
        paths,
      };
    }
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['paths', 'files', 'results', 'matches', 'items']) {
      if (Array.isArray(value[key])) {
        const extracted = extractPathList(value[key]);
        if (extracted) return extracted;
      }
    }
  }

  let text = typeof value === 'string' ? value : normalizeToolResult(value);
  text = text.trim();
  if (!text) return null;

  // JSON array string
  if ((text.startsWith('[') && text.endsWith(']')) || (text.startsWith('{') && text.includes('['))) {
    try {
      const parsed = JSON.parse(text);
      const extracted = extractPathList(parsed);
      if (extracted) return extracted;
    } catch (_) {
      /* fall through */
    }
  }

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    // strip common list prefixes
    .map((l) => l.replace(/^[-*•]\s+/, '').replace(/^\d+\.\s+/, ''))
    .map((l) => l.replace(/^["']|["']$/g, ''));

  const paths = lines.filter(looksLikePath);
  if (paths.length >= 2 && paths.length / lines.length >= 0.5) {
    return {
      count: paths.length,
      preview: paths.slice(0, PATH_PREVIEW),
      paths,
    };
  }

  // Comma / semicolon separated single line
  if (lines.length === 1 && (text.includes(',') || text.includes(';'))) {
    const parts = text.split(/[,;]/).map((p) => p.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    const partPaths = parts.filter(looksLikePath);
    if (partPaths.length >= 3) {
      return {
        count: partPaths.length,
        preview: partPaths.slice(0, PATH_PREVIEW),
        paths: partPaths,
      };
    }
  }

  return null;
}

export function classifyToolPayload(value) {
  if (value == null || value === '') return 'empty';
  const pathList = extractPathList(value);
  if (pathList && pathList.count >= 2) return 'path_list';

  const text = normalizeToolResult(value);
  if (!text.trim()) return 'empty';
  if (isPathHeavyText(text)) return 'path_list';
  if (/^data:|^\ufffd|binary/i.test(text.slice(0, 64)) && text.length > 200) return 'binary_hint';

  const trimmed = text.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    // Prefer path_list if JSON paths; else json
    if (pathList) return 'path_list';
    return 'json';
  }
  return 'text';
}

export function shortenPath(path) {
  const raw = String(path || '');
  if (!raw) return '';
  const normalized = raw.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  const base = parts[parts.length - 1] || raw;
  return base;
}

export function getToolKind(item) {
  const raw = String(item?.kind || item?.toolName || item?.name || item?.title || '')
    .toLowerCase()
    .replace(/tool$/, '');
  if (!raw) return 'default';
  if (['execute', 'bash', 'shell', 'run_terminal_cmd', 'run_command'].some((k) => raw.includes(k))) {
    return 'execute';
  }
  if (['read', 'read_file', 'readfile'].some((k) => raw === k || raw.includes('read_file'))) return 'read';
  if (raw === 'read') return 'read';
  if (['search', 'grep', 'glob', 'find', 'list_dir', 'listdir'].some((k) => raw.includes(k))) return 'search';
  if (['edit', 'write', 'apply_patch', 'search_replace'].some((k) => raw.includes(k))) return 'edit';
  if (['fetch', 'webfetch', 'web_fetch', 'http'].some((k) => raw.includes(k))) return 'fetch';
  if (['websearch', 'web_search'].some((k) => raw.includes(k))) return 'web_search';
  if (['task', 'todo'].some((k) => raw.includes(k))) return 'task';
  if (['sendmessage', 'team', 'member'].some((k) => raw.includes(k))) return 'team';
  return 'default';
}

export function formatToolCollapsedSummary(item) {
  const fromInput = summarizeToolLine(item?.rawInput);
  if (fromInput) return fromInput;
  if (item?.content) return truncateOneLine(item.content);
  const out = normalizeToolResult(item?.rawOutput);
  if (out) {
    const pathList = extractPathList(item?.rawOutput) || extractPathList(out);
    if (pathList) return `${pathList.count} paths`;
    return truncateOneLine(out);
  }
  return '';
}

/**
 * Unified expanded view for every tool kind.
 * @param {object} item timeline tool_call
 * @param {{ maxLines?: number, full?: boolean }} options
 */
export function formatToolExpandedView(item, options = {}) {
  const full = Boolean(options.full);
  const maxLines = full ? FULL_MAX_LINES : options.maxLines ?? DEFAULT_MAX_LINES;
  const kind = getToolKind(item);
  const inputInfo = normalizeToolInput(item?.rawInput);
  let outputText = normalizeToolResult(item?.rawOutput ?? item?.content);
  if (kind === 'execute') outputText = stripShellChrome(outputText);

  const pathList =
    extractPathList(item?.rawOutput) ||
    extractPathList(outputText) ||
    (isPathHeavyText(outputText) ? extractPathList(outputText.split('\n')) : null);

  // Path-list mode (production: never wall)
  if (pathList && pathList.count >= 2 && !full) {
    return {
      kind,
      mode: 'path_list',
      summary: inputInfo.summary || formatToolCollapsedSummary(item),
      inputSummary: inputInfo.summary,
      pathList: {
        count: pathList.count,
        preview: pathList.preview.map((p) => ({
          full: p,
          short: shortenPath(p),
        })),
      },
      body: '',
      hiddenLines: Math.max(0, pathList.count - PATH_PREVIEW),
      totalLines: pathList.count,
      truncated: pathList.count > PATH_PREVIEW,
      rawAvailable: true,
      locations: normalizeLocations(item?.locations),
    };
  }

  if (full && outputText.length > FULL_MAX_CHARS) {
    outputText = `${outputText.slice(0, FULL_MAX_CHARS)}\n…`;
  }

  const clamped = clampTextLines(outputText, maxLines);
  // Even in full mode, enforce FULL_MAX_LINES
  const bodyClamp = full ? clampTextLines(outputText, FULL_MAX_LINES) : clamped;

  return {
    kind,
    mode: classifyToolPayload(item?.rawOutput ?? item?.content) === 'json' ? 'json' : 'text',
    summary: inputInfo.summary || formatToolCollapsedSummary(item),
    inputSummary: inputInfo.summary,
    inputRaw: inputInfo.raw,
    inputFields: inputInfo.fields || null,
    body: bodyClamp.visible,
    hiddenLines: bodyClamp.hiddenLines,
    totalLines: bodyClamp.totalLines,
    truncated: bodyClamp.truncated || (full && String(item?.rawOutput || '').length > FULL_MAX_CHARS),
    rawAvailable: Boolean(item?.rawOutput || item?.rawInput || item?.content),
    locations: normalizeLocations(item?.locations),
    command: inputInfo.fields?.command || (kind === 'execute' ? inputInfo.summary : null),
  };
}

function normalizeLocations(locations) {
  if (!Array.isArray(locations)) return [];
  return locations
    .map((loc) => {
      if (typeof loc === 'string') return { full: loc, short: shortenPath(loc) };
      if (loc && typeof loc === 'object') {
        const full = firstString(loc.path, loc.file, loc.uri, loc.filePath);
        if (!full) return null;
        return { full, short: shortenPath(full), line: loc.line || loc.lineNumber || null };
      }
      return null;
    })
    .filter(Boolean)
    .slice(0, 20);
}

export function formatLocationsSummary(locations) {
  const list = normalizeLocations(locations);
  if (!list.length) return '';
  if (list.length === 1) return list[0].short;
  return `${list[0].short} +${list.length - 1}`;
}

export {
  DEFAULT_MAX_LINES,
  FULL_MAX_LINES,
  FULL_MAX_CHARS,
  PATH_PREVIEW,
  truncateOneLine,
};
