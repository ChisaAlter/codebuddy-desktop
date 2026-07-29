import { beforeEach, describe, it, expect } from 'vitest';
import { reduceAcpEvent, resetSeenContent, pushUserMessage } from '../../src/lib/timeline';

beforeEach(() => resetSeenContent());

describe('reduceAcpEvent - compact 时间线条目', () => {
  it('phase=compacting 追加一条 type=compact 条目', () => {
    const base = pushUserMessage([], '你好');
    const next = reduceAcpEvent(base, 'compact', { phase: 'compacting' });
    const compact = next.find((e) => e.type === 'compact');
    expect(compact).toBeTruthy();
    expect(compact.role).toBe('system');
    expect(compact.meta.phase).toBe('compacting');
  });

  it('连续 compacting 不产生重复条目', () => {
    const base = pushUserMessage([], '你好');
    const first = reduceAcpEvent(base, 'compact', { phase: 'compacting' });
    const second = reduceAcpEvent(first, 'compact', { phase: 'compacting' });
    const compactCount = second.filter((e) => e.type === 'compact' && e.meta?.phase === 'compacting').length;
    expect(compactCount).toBe(1);
    expect(second.length).toBe(first.length);
  });

  it('phase=compacted 在 compacting 之后追加独立终态条目', () => {
    const base = pushUserMessage([], '你好');
    const afterCompacting = reduceAcpEvent(base, 'compact', { phase: 'compacting' });
    const afterCompacted = reduceAcpEvent(afterCompacting, 'compact', { phase: 'compacted' });
    const phases = afterCompacted.filter((e) => e.type === 'compact').map((e) => e.meta?.phase);
    expect(phases).toEqual(['compacting', 'compacted']);
  });

  it('phase=cancelled 追加独立条目', () => {
    const base = pushUserMessage([], '你好');
    const next = reduceAcpEvent(base, 'compact', { phase: 'cancelled' });
    const compact = next.find((e) => e.type === 'compact' && e.meta?.phase === 'cancelled');
    expect(compact).toBeTruthy();
  });

  it('payload.type=compact 也被识别（兼容 payload 形式）', () => {
    const base = pushUserMessage([], '你好');
    const next = reduceAcpEvent(base, 'status_change', { type: 'compact', phase: 'compacted' });
    const compact = next.find((e) => e.type === 'compact');
    expect(compact).toBeTruthy();
    expect(compact.meta.phase).toBe('compacted');
  });
});