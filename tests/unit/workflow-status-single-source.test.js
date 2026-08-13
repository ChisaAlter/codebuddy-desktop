import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { normalizeStatus as rendererNormalize, firstValue } from '../../src/lib/workflow-normalize';
import { STATUS_LABELS } from '../../src/lib/workflow-status';

const require = createRequire(import.meta.url);
const { normalizeStatus: electronNormalize } = require('../../electron/workflow-progress.cjs');

const CORPUS = [
  'complete', 'completed', 'done', 'success', 'succeeded',
  'failed', 'failure', 'error',
  'cancelled', 'canceled', 'aborted',
  'waiting', 'blocked', 'paused',
  'pending', 'queued',
  'working', 'running', 'in_progress', 'in-progress', 'planning', 'executing',
  'custom_status', '', null, undefined, '  RUNNING  ',
];

describe('workflow status single source (M4)', () => {
  it('renderer and electron normalizeStatus agree on the full alias corpus', () => {
    for (const input of CORPUS) {
      expect(electronNormalize(input)).toBe(rendererNormalize(input), `input: ${String(input)}`);
    }
  });

  it('renderer and electron agree with explicit fallbacks', () => {
    for (const fallback of ['running', 'completed', 'idle']) {
      for (const input of CORPUS) {
        expect(electronNormalize(input, fallback)).toBe(
          rendererNormalize(input, fallback),
          `input: ${String(input)}, fallback: ${fallback}`,
        );
      }
    }
  });

  it('every canonical status normalizeStatus can emit has a STATUS_LABELS entry', () => {
    // Raw passthrough statuses (e.g. 'custom_status') intentionally have no
    // label — only the canonical vocabulary must be covered.
    const canonical = ['completed', 'failed', 'cancelled', 'waiting', 'pending', 'running'];
    for (const status of canonical) {
      expect(STATUS_LABELS[status], `STATUS_LABELS missing ${status}`).toBeTruthy();
    }
  });

  it('firstValue semantics are stable (trim + non-empty)', () => {
    expect(firstValue(undefined, null, '', '  ok  ')).toBe('  ok  ');
    expect(firstValue()).toBeUndefined();
  });
});
