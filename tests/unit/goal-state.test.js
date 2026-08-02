import { describe, expect, it } from 'vitest';
import { emptyGoalState, goalsFromTimeline, mergeGoalEvent, normalizeGoalEvent } from '../../src/lib/goal-state';

describe('goal state projection', () => {
  it('normalizes aliases and derives percentage', () => {
    const goal = normalizeGoalEvent({ id: 'g1', name: '检查项目', completed: 2, total: 4, message: '扫描中' }, 'goal-progress');
    expect(goal).toMatchObject({ goalId: 'g1', title: '检查项目', status: 'running', message: '扫描中' });
    expect(goal.progress).toMatchObject({ current: 2, total: 4, percent: 50 });
  });

  it('ignores an out-of-order sequence update', () => {
    const first = mergeGoalEvent(emptyGoalState(), { goalId: 'g1', sequence: 2, percent: 80 }, 'goal-progress');
    const next = mergeGoalEvent(first, { goalId: 'g1', sequence: 1, percent: 20 }, 'goal-progress');
    expect(next).toEqual(first);
  });

  it('rebuilds goal projection from persisted timeline events', () => {
    const state = goalsFromTimeline([
      { id: 'event-1', type: 'goal-progress', meta: { id: 'g1', title: '构建', current: 1, total: 2 } },
      { id: 'event-2', type: 'goal-status', meta: { id: 'g1', title: '构建', status: 'completed', percent: 100 } },
    ]);
    expect(state.eventCount).toBe(2);
    expect(state.goalsById.g1).toMatchObject({ status: 'completed', progress: { percent: 100 } });
  });
});
