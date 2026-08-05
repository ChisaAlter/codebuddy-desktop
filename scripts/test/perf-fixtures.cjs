'use strict';

/**
 * Phase A — deterministic fixtures for the production perf gates.
 *
 * Everything a perf script measures is driven from this single module so
 * runs are reproducible: transcript events, stream chunks, route sequence,
 * route ready markers and window/profile constants live here.
 *
 * The fixture builder ONLY produces serializable event descriptors and
 * hydrates them through the REAL product reducer (`reduceAcpEvent` +
 * `closeAssistantStream` from src/lib/timeline.js) — it never hand-crafts
 * timeline entries and never bypasses the product reducer.
 *
 * Fixed fixture (300 entries, seed default 1):
 *  - user / assistant / thinking / tool_call / notice timeline types;
 *  - >= 100 markdown entries;
 *  - >= 50 entries with fenced code blocks covering js/json/python/shell;
 *  - 20 assistant messages near the 200KB boundary.
 */

const crypto = require('node:crypto');

/** Deterministic PRNG (mulberry32) — same seed ⇒ same fixture. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CODE_BLOCK_SAMPLES = {
  js: `function fib(n) {
  if (n < 2) return n;
  const memo = new Map();
  function go(k) {
    if (k < 2) return k;
    if (memo.has(k)) return memo.get(k);
    const value = go(k - 1) + go(k - 2);
    memo.set(k, value);
    return value;
  }
  return go(n);
}
console.log(fib(30));`,
  json: `{
  "name": "perf-fixture",
  "version": "1.0.0",
  "scripts": {
    "build": "vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^18.2.0",
    "xterm": "^5.3.0"
  },
  "engines": {
    "node": ">=18"
  }
}`,
  python: `import asyncio
from collections import deque

async def stream_words(queue):
    for word in ["hello", "world", "from", "the", "stream"]:
        await queue.put(word)
        await asyncio.sleep(0.01)
    await queue.put(None)

async def main():
    queue = asyncio.Queue()
    task = asyncio.create_task(stream_words(queue))
    while (word := await queue.get()) is not None:
        print(word)
    await task

asyncio.run(main())`,
  shell: `#!/usr/bin/env bash
set -euo pipefail

for file in "$@"; do
  if [[ -f "$file" ]]; then
    wc -l "$file"
  else
    echo "missing: $file" >&2
    exit 1
  fi
done
`,
};

const MARKDOWN_PARAGRAPHS = [
  '这是性能验证 fixture 的示例段落，包含**加粗**、*斜体*和 [链接](https://example.com)。',
  'The quick brown fox jumps over the lazy dog while measuring render latency.',
  '多行列表：\n- 第一项\n- 第二项\n- 嵌套子项\n  - 子项 A',
  '> 引用块：保持每轮渲染成本可复现，避免随机文本影响测量。',
  '| 列 A | 列 B |\n| --- | --- |\n| 值 1 | 值 2 |\n| 值 3 | 值 4 |',
  '代码中的 `inline code` 与普通文本混合，验证行内渲染路径。',
  'Heading 与段落交替出现，模拟真实对话的排版密度。',
];

const LARGE_MESSAGE_CHARS = 195_000;

function pick(rand, list) {
  return list[Math.floor(rand() * list.length)];
}

function assistantBody(i, rand) {
  const parts = [`## 验证消息 #${i}`, ``, pick(rand, MARKDOWN_PARAGRAPHS), '', pick(rand, MARKDOWN_PARAGRAPHS)];
  // Every 2nd assistant message carries a fenced code block, cycling through
  // JavaScript / JSON / Python / shell so all four languages are covered.
  // (Code blocks sit on odd assistant indices; floor(i/2) % 4 walks the langs.)
  if (i % 2 === 1) {
    const langs = ['js', 'json', 'python', 'shell'];
    const lang = langs[Math.floor(i / 2) % 4];
    parts.push('', `\`\`\`${lang}`, CODE_BLOCK_SAMPLES[lang], '```', '');
  }
  parts.push(`这条消息的总结：完成了第 ${i} 轮验证。`);
  return parts.join('\n');
}

function largeAssistantBody(i, rand) {
  const paragraph = pick(rand, MARKDOWN_PARAGRAPHS);
  const unit = `## 边界消息 #${i}\n\n${paragraph}\n\n`;
  let body = '';
  while (body.length < LARGE_MESSAGE_CHARS) body += unit;
  return body.slice(0, LARGE_MESSAGE_CHARS);
}

function userBody(i, rand) {
  const parts = [`用户提问 #${i}：`, pick(rand, MARKDOWN_PARAGRAPHS)];
  if (i % 5 === 0) {
    parts.push('', '```js', 'const answer = await ask("fixture");', '```', '');
  }
  return parts.join('\n');
}

/**
 * Turn composition pattern: [user, assistant] core with thinking/tool mixed
 * in so the fixture covers user / assistant / thinking / tool_call / notice
 * while keeping exactly `count` entries. Average 2.8 entries per turn.
 */
const TURN_PATTERN = [
  ['user', 'thinking', 'assistant'],
  ['user', 'assistant'],
  ['user', 'thinking', 'assistant', 'tool'],
  ['user', 'assistant', 'tool'],
  ['user', 'assistant'],
];

/**
 * Build the deterministic 300-entry transcript as raw event descriptors.
 * Returns [{ eventType, payload }]. `count` is the number of hydrated
 * timeline entries (messages/thinking/tools/notices), not raw events —
 * assistant messages emit multiple chunk events that merge into one entry.
 */
function generateTranscriptEvents(options = {}) {
  const { count = 300, seed = 1 } = options;
  const rand = mulberry32(seed);
  const events = [];
  let seq = 0;
  let assistantIndex = 0; // counts assistant MESSAGES (not chunks)
  let entries = 0;
  let turn = 0;

  const nextId = (prefix) => `perf-${prefix}-${seq++}`;

  const pushUser = () => {
    events.push({
      eventType: 'user_message_chunk',
      payload: {
        messageId: nextId('u'),
        content: userBody(seq, rand),
        sessionUpdate: 'user_message_chunk',
      },
    });
    entries += 1;
  };

  const pushThinking = () => {
    events.push({
      eventType: 'agent_thought_chunk',
      payload: {
        messageId: nextId('t'),
        content: `正在分析第 ${seq} 步：${pick(rand, ['拆分问题', '检索上下文', '规划步骤', '验证结果'])}`,
        streaming: true,
        sessionUpdate: 'agent_thought_chunk',
      },
    });
    entries += 1;
  };

  const pushAssistant = () => {
    // Large boundary message: every 5th assistant message is ~200KB (20 of ~100).
    const isLarge = assistantIndex % 5 === 4;
    const body = isLarge ? largeAssistantBody(assistantIndex, rand) : assistantBody(assistantIndex, rand);
    // Large messages split into 10 chunks; normal ones into 2-4 — exercises the
    // real merge path (reduceAcpEvent + coalesce) instead of one giant event.
    const chunkCount = isLarge ? 10 : 2 + Math.floor(rand() * 3);
    const messageId = nextId('a');
    const chunkSize = Math.ceil(body.length / chunkCount);
    for (let c = 0; c < chunkCount; c += 1) {
      events.push({
        eventType: 'agent_message_chunk',
        payload: {
          messageId,
          content: body.slice(c * chunkSize, (c + 1) * chunkSize),
          streaming: true,
          sessionUpdate: 'agent_message_chunk',
        },
      });
    }
    entries += 1;
    assistantIndex += 1;
  };

  const pushTool = () => {
    events.push({
      eventType: 'tool_call',
      payload: {
        toolCallId: nextId('tc'),
        messageId: nextId('tm'),
        title: pick(rand, ['读取文件', '执行命令', '搜索代码', '写入变更']),
        status: 'completed',
        content: `工具执行完成，共处理 ${10 + Math.floor(rand() * 90)} 项`,
        sessionUpdate: 'tool_call',
      },
    });
    entries += 1;
  };

  const pushNotice = () => {
    events.push({
      eventType: 'notice',
      payload: {
        type: 'notice',
        message: `系统提示：已完成 ${seq} 轮自动验证`,
        sessionUpdate: 'notice',
      },
    });
    entries += 1;
  };

  while (entries < count) {
    const pattern = TURN_PATTERN[turn % TURN_PATTERN.length];
    const hasNotice = turn % 10 === 0;
    const needed = pattern.length + (hasNotice ? 1 : 0);
    // Clamp: never overshoot 300. A partial turn may only add a user message
    // so every turn in the transcript stays complete (no dangling chunks).
    if (entries + needed > count) {
      if (entries + 1 <= count) pushUser();
      break;
    }
    for (const step of pattern) {
      if (step === 'user') pushUser();
      else if (step === 'thinking') pushThinking();
      else if (step === 'assistant') pushAssistant();
      else if (step === 'tool') pushTool();
    }
    if (hasNotice) pushNotice();
    turn += 1;

    // status_change is real stream chrome; the reducer drops it (no entry),
    // so it never affects the entry count.
    events.push({
      eventType: 'status_change',
      payload: { type: 'status_change', status: 'idle', sessionUpdate: 'status_change' },
    });
  }

  return events;
}

/**
 * Hydrate event descriptors through the REAL product reducer
 * (reduceAcpEvent + closeAssistantStream). Async because src/lib is ESM.
 */
async function hydrateTranscript(events) {
  const { closeAssistantStream, reduceAcpEvent } = await import('../../src/lib/timeline.js');
  let timeline = [];
  for (const event of events) {
    timeline = reduceAcpEvent(timeline, event.eventType, event.payload, 'perf-fixture');
  }
  return closeAssistantStream(timeline);
}

/**
 * Deterministic streaming chunk sequence for the "typing while streaming"
 * measurement. Each chunk is a small real-ish agent_message_chunk event.
 */
function generateStreamChunks(options = {}) {
  const { count = 120, seed = 2, messageId = 'perf-stream-1' } = options;
  const rand = mulberry32(seed);
  const chunks = [];
  const words = ['性能', '验证', 'stream', 'chunk', '渲染', 'latency', '测量', '输入', '响应', 'window'];
  for (let i = 0; i < count; i += 1) {
    let content = '';
    const wordCount = 2 + Math.floor(rand() * 4);
    for (let w = 0; w < wordCount; w += 1) content += `${pick(rand, words)} `;
    chunks.push({
      eventType: 'agent_message_chunk',
      payload: {
        messageId,
        content: content.trim(),
        streaming: true,
        sessionUpdate: 'agent_message_chunk',
      },
    });
  }
  return chunks;
}

/** Fixed route sequence for keep-alive soak and route-return timing. */
function routeSequence() {
  return [
    { route: 'chat', keepAlive: true, note: 'active default' },
    { route: 'terminal', keepAlive: true, note: 'core route' },
    { route: 'editor', keepAlive: true, note: 'core route' },
    { route: 'settings', keepAlive: true, note: 'core route' },
  ];
}

/**
 * Route ready markers — the ONLY acceptable readiness signal (no fixed
 * sleeps). Each expression must evaluate to true once the route is
 * interactable; used via waitForRendererValue.
 */
const ROUTE_READY_MARKERS = {
  chat: `(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return false;
    const items = document.querySelectorAll('[data-testid="timeline-item"]');
    return items.length > 0 || /验证消息|用户提问/.test(document.body.innerText);
  })()`,
  // xterm canvas exists, or the runtime-unavailable / connecting empty state
  // is visible (packaged E2E has no live CLI runtime).
  terminal: `(() => {
    if (document.querySelector('.xterm canvas, .xterm-helper-textarea')) return true;
    return /项目运行时启动失败|项目运行时已停止|终端需要运行中的|正在连接项目运行时|终端就绪中/.test(document.body.innerText);
  })()`,
  // Monaco editor DOM exists, or the editor/file-tree/workspace states are
  // visible (packaged E2E has no live runtime — the tree still lists the
  // project root and the pane shows the "select a file" placeholder).
  editor: `(() => {
    if (document.querySelector('.monaco-editor')) return true;
    return /未选择文件|从左侧选择文件以预览|项目运行时未就绪|当前目录为空|加载文件中|文件列表加载失败/.test(document.body.innerText);
  })()`,
  // settings section navigation / heading visible
  settings: `(() => {
    if (document.querySelector('.settings-toc, nav[aria-label="Settings sections"]')) return true;
    return Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]')).some(
      (el) => /设置|settings|偏好|preferences/i.test(el.textContent || ''),
    );
  })()`,
};

/** Stable sha256 hash over the event descriptors (same seed ⇒ same hash). */
function fixtureHash(events) {
  return crypto.createHash('sha256').update(JSON.stringify(events)).digest('hex');
}

/** Counts for report: types, markdown, code blocks, large messages. */
function summarizeFixture(events, timeline) {
  const entries = Array.isArray(timeline) ? timeline : [];
  const byType = {};
  for (const entry of entries) {
    const type = entry?.type || 'unknown';
    byType[type] = (byType[type] || 0) + 1;
  }
  const markdownRe = /(^|\n)#{1,6}\s|\*\*|\`\`\`|\[[^\]]*\]\([^)]*\)|(^|\n)[-*] |(^|\n)> |(^|\n)\|.*\|/;
  let markdownCount = 0;
  let codeBlockCount = 0;
  let largeMessageCount = 0;
  for (const entry of entries) {
    const content = String(entry?.content || '');
    if (markdownRe.test(content)) markdownCount += 1;
    codeBlockCount += (content.match(/```/g) || []).length / 2;
    if (content.length >= 180_000) largeMessageCount += 1;
  }
  return {
    entryCount: entries.length,
    eventCount: events.length,
    byType,
    markdownCount,
    codeBlockCount: Math.round(codeBlockCount),
    largeMessageCount,
  };
}

module.exports = {
  CODE_BLOCK_SAMPLES,
  LARGE_MESSAGE_CHARS,
  ROUTE_READY_MARKERS,
  fixtureHash,
  generateStreamChunks,
  generateTranscriptEvents,
  hydrateTranscript,
  mulberry32,
  routeSequence,
  summarizeFixture,
};
