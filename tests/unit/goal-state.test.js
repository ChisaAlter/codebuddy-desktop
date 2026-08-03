import { describe, expect, it } from 'vitest';
import {
  emptyGoalState,
  goalTitleFromPrompt,
  goalsFromTimeline,
  hasGoalTurnActivity,
  isGoalPrompt,
  mergeGoalEvent,
  normalizeGoalEvent,
  seedGoalStateFromPrompt,
} from '../../src/lib/goal-state';

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

  it('detects /goal prompts and strips the command prefix for titles', () => {
    expect(isGoalPrompt('/goal fix login')).toBe(true);
    expect(isGoalPrompt('/goal')).toBe(true);
    expect(isGoalPrompt('/goal\n')).toBe(true);
    expect(isGoalPrompt('/goals')).toBe(false);
    expect(isGoalPrompt('goal fix')).toBe(false);
    expect(goalTitleFromPrompt('/goal fix login bug')).toBe('fix login bug');
    expect(goalTitleFromPrompt('/goal')).toBe('/goal');
  });

  it('seeds an optimistic goal projection for /goal prompts', () => {
    const seeded = seedGoalStateFromPrompt('/goal 修复登录', 'run-1');
    expect(seeded.mode).toBe('goal');
    expect(seeded.runId).toBe('run-1');
    expect(seeded.activeGoalId).toBe('local-seed');
    expect(seeded.goalsById['local-seed']).toMatchObject({
      title: '修复登录',
      status: 'running',
      seeded: true,
    });
    // message must not duplicate title (UI shows localized waiting text instead)
    expect(seeded.goalsById['local-seed'].message || '').not.toBe('修复登录');
    expect(hasGoalTurnActivity(seeded)).toBe(true);
    expect(hasGoalTurnActivity(emptyGoalState('goal'))).toBe(false);
  });

  it('lets later CLI goal events replace the local seed via merge', () => {
    const seeded = seedGoalStateFromPrompt('/goal ship it', 'run-1');
    const merged = mergeGoalEvent(seeded, {
      goalId: 'cli-goal',
      title: 'Ship it',
      status: 'running',
      percent: 25,
      runId: 'run-1',
    }, 'goal-progress');
    expect(merged.goalsById['cli-goal']).toMatchObject({ title: 'Ship it', progress: { percent: 25 } });
    expect(merged.runId).toBe('run-1');
  });
});
