import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROUTE_READY_MARKERS,
  fixtureHash,
  generateStreamChunks,
  generateTranscriptEvents,
  hydrateTranscript,
  mulberry32,
  routeSequence,
  summarizeFixture,
} from '../../scripts/test/perf-fixtures.cjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('perf transcript fixture', () => {
  it('hydrates to exactly 300 entries covering real timeline types', async () => {
    const events = generateTranscriptEvents({ count: 300 });
    const timeline = await hydrateTranscript(events);
    expect(timeline.length).toBe(300);
    const types = new Set(timeline.map((entry) => entry.type));
    // user + assistant are both `message`; thinking/tool_call/notice must exist.
    expect(types.has('message')).toBe(true);
    expect(types.has('thinking')).toBe(true);
    expect(types.has('tool_call')).toBe(true);
    expect(types.has('notice')).toBe(true);
    expect(timeline.some((entry) => entry.role === 'user')).toBe(true);
    expect(timeline.some((entry) => entry.role === 'assistant')).toBe(true);
  });

  it('meets the markdown / code-block / large-message quotas', async () => {
    const events = generateTranscriptEvents({ count: 300 });
    const timeline = await hydrateTranscript(events);
    const summary = summarizeFixture(events, timeline);
    expect(summary.markdownCount).toBeGreaterThanOrEqual(100);
    expect(summary.codeBlockCount).toBeGreaterThanOrEqual(50);
    expect(summary.largeMessageCount).toBeGreaterThanOrEqual(20);
    // large messages really are near the 200KB boundary
    const large = timeline.filter((entry) => String(entry.content).length >= 180_000);
    expect(large.length).toBeGreaterThanOrEqual(20);
    expect(Math.max(...large.map((entry) => String(entry.content).length))).toBeLessThanOrEqual(200_000);
  });

  it('covers JavaScript/JSON/Python/shell fenced code blocks', async () => {
    const events = generateTranscriptEvents({ count: 300 });
    const timeline = await hydrateTranscript(events);
    const langs = new Set();
    for (const entry of timeline) {
      for (const match of String(entry.content).matchAll(/```([a-z]+)/g)) langs.add(match[1]);
    }
    for (const lang of ['js', 'json', 'python', 'shell']) {
      expect(langs.has(lang), `missing fenced code block language: ${lang}`).toBe(true);
    }
  });

  it('hydrates through the real reducer: every entry is well-formed and settled', async () => {
    const events = generateTranscriptEvents({ count: 300 });
    const timeline = await hydrateTranscript(events);
    for (const entry of timeline) {
      expect(typeof entry.type).toBe('string');
      expect(entry.content).toBeTypeOf('string');
      expect(entry.streaming).toBe(false); // closeAssistantStream settled everything
      expect(entry.createdAt).toBeTypeOf('number');
    }
  });

  it('is deterministic: same seed ⇒ same events, hash and entry stats', async () => {
    const a = generateTranscriptEvents({ count: 300, seed: 7 });
    const b = generateTranscriptEvents({ count: 300, seed: 7 });
    expect(a).toEqual(b);
    expect(fixtureHash(a)).toBe(fixtureHash(b));
    const c = generateTranscriptEvents({ count: 300, seed: 8 });
    expect(fixtureHash(a)).not.toBe(fixtureHash(c));
    const summaryA = summarizeFixture(a, await hydrateTranscript(a));
    const summaryB = summarizeFixture(b, await hydrateTranscript(b));
    expect(summaryA).toEqual(summaryB);
  });

  it('generateStreamChunks is deterministic and shapes like real SSE chunks', () => {
    const a = generateStreamChunks({ count: 120, seed: 2 });
    const b = generateStreamChunks({ count: 120, seed: 2 });
    expect(a).toEqual(b);
    expect(a).toHaveLength(120);
    for (const chunk of a) {
      expect(chunk.eventType).toBe('agent_message_chunk');
      expect(chunk.payload.messageId).toBeTruthy();
      expect(typeof chunk.payload.content).toBe('string');
      expect(chunk.payload.sessionUpdate).toBe('agent_message_chunk');
    }
  });

  it('route sequence covers the four keep-alive core routes with ready markers', () => {
    const routes = routeSequence();
    expect(routes.map((route) => route.route)).toEqual(['chat', 'terminal', 'editor', 'settings']);
    for (const { route } of routes) {
      expect(typeof ROUTE_READY_MARKERS[route], `missing ready marker for ${route}`).toBe('string');
      expect(ROUTE_READY_MARKERS[route].length).toBeGreaterThan(10);
    }
  });

  it('mulberry32 is deterministic', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
    expect(seqA.every((value) => value >= 0 && value < 1)).toBe(true);
  });
});

describe('store bridge whitelist in build output', () => {
  const assetsDir = path.join(projectRoot, 'out', 'dist', 'assets');
  const exists = fs.existsSync(assetsDir);
  const mainEntry = exists
    ? fs.readdirSync(assetsDir).find((file) => /^index-[^/]+\.js$/.test(file))
    : null;

  it.runIf(Boolean(mainEntry))('main entry exposes __CODEBUDDY_STORE__ with the whitelist', () => {
    const source = fs.readFileSync(path.join(assetsDir, mainEntry), 'utf8');
    const whitelist = [
      '__CODEBUDDY_STORE__',
      'getState',
      'appendThreadTimelineEvent',
      'patchThreadRuntime',
      'appendPaneOutput',
      'setRoute',
    ];
    for (const name of whitelist) {
      expect(source.includes(`window.__CODEBUDDY_STORE__`), `window.__CODEBUDDY_STORE__ missing`).toBe(true);
      expect(source.includes(name), `whitelisted store member missing from build: ${name}`).toBe(true);
    }
  });

  it.runIf(!mainEntry)('build output exists for whitelist assertion', () => {
    expect(exists, 'out/dist/assets missing — run npm run build:dir before this test').toBe(true);
  });
});
