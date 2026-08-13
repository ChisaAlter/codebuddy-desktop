import { describe, it, expect, vi, afterEach } from 'vitest';
import { DISMISS_WINDOW_MS, shouldWorkflowAutoOpen } from '../../src/lib/workflow-status';
import {
  getPanelGoalState,
  getPanelGoals,
  getPanelReports,
  isWorkflowHistory,
} from '../../src/lib/workflow-panel-data';

const readyView = { empty: false, shouldAutoOpen: true, runId: 'run-1' };

describe('shouldWorkflowAutoOpen - M2 dismissed 竞态（时间窗 + 同 run 抑制）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('无 dismissed 记录：允许自动打开', () => {
    expect(shouldWorkflowAutoOpen(readyView, { dismissed: null })).toBe(true);
  });

  it('empty / shouldAutoOpen false：拒绝', () => {
    expect(shouldWorkflowAutoOpen({ empty: true, shouldAutoOpen: true }, { dismissed: null })).toBe(false);
    expect(shouldWorkflowAutoOpen({ empty: false, shouldAutoOpen: false }, { dismissed: null })).toBe(false);
    expect(shouldWorkflowAutoOpen(null, { dismissed: null })).toBe(false);
  });

  it('时间窗内（< DISMISS_WINDOW_MS）：即使不同 run 也抑制（防 closing 220ms 闪回）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    const dismissed = { runId: 'run-old', at: 10000 - (DISMISS_WINDOW_MS - 100) };
    expect(shouldWorkflowAutoOpen(readyView, { dismissed, runId: 'run-new' })).toBe(false);
  });

  it('超窗 + 同 run：仍抑制（用户手动关闭的意图）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    const dismissed = { runId: 'run-1', at: 10000 - DISMISS_WINDOW_MS - 5000 };
    expect(shouldWorkflowAutoOpen(readyView, { dismissed, runId: 'run-1' })).toBe(false);
  });

  it('超窗 + 不同 run：允许自动打开', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    const dismissed = { runId: 'run-old', at: 10000 - DISMISS_WINDOW_MS - 5000 };
    expect(shouldWorkflowAutoOpen(readyView, { dismissed, runId: 'run-new' })).toBe(true);
  });

  it('runId 缺失时以 status.runId 兜底比较', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    const dismissed = { runId: 'run-9', at: 10000 - DISMISS_WINDOW_MS - 5000 };
    expect(shouldWorkflowAutoOpen({ ...readyView, runId: 'run-9' }, { dismissed })).toBe(false);
  });

  it('dismissed.at 非数字（异常形态）不触发时间窗，仅同 run 抑制', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    expect(shouldWorkflowAutoOpen(readyView, { dismissed: { runId: 'x', at: null }, runId: 'new' })).toBe(true);
    expect(shouldWorkflowAutoOpen(readyView, { dismissed: { runId: 'run-1', at: null }, runId: 'run-1' })).toBe(false);
  });

  it('runId 均为空时：超窗后允许（无同 run 可比）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    const dismissed = { runId: null, at: 10000 - DISMISS_WINDOW_MS - 5000 };
    expect(shouldWorkflowAutoOpen({ ...readyView, runId: null }, { dismissed, runId: null })).toBe(true);
  });
});

describe('workflow-panel-data - M2 终态回退', () => {
  const goal = { goalId: 'g1', title: '目标一', status: 'completed' };
  const report = { id: 'r1', name: 'Explore', summary: '找到文件' };

  it('有实时 goalState 时优先实时', () => {
    const runtime = { goalState: { goalsById: { g1: goal } }, lastGoalState: { goalsById: { g0: { goalId: 'g0' } } } };
    expect(getPanelGoalState(runtime)).toBe(runtime.goalState);
    expect(getPanelGoals(runtime)).toEqual([goal]);
    expect(isWorkflowHistory(runtime)).toBe(false);
  });

  it('无实时 goalState 时回退 lastGoalState（历史）', () => {
    const runtime = { goalState: null, lastGoalState: { goalsById: { g1: goal } } };
    expect(getPanelGoals(runtime)).toEqual([goal]);
    expect(isWorkflowHistory(runtime)).toBe(true);
  });

  it('两者皆无：空列表 + 非历史', () => {
    expect(getPanelGoals(null)).toEqual([]);
    expect(getPanelGoals({})).toEqual([]);
    expect(isWorkflowHistory({})).toBe(false);
    expect(isWorkflowHistory(null)).toBe(false);
  });

  it('goalState 为空对象（新回合种子）时回退 lastGoalState？否——空对象视为实时空态', () => {
    const runtime = { goalState: { goalsById: {} }, lastGoalState: { goalsById: { g1: goal } } };
    expect(getPanelGoals(runtime)).toEqual([]);
    expect(isWorkflowHistory(runtime)).toBe(false);
  });

  it('subagentReports 优先实时，缺失回退 lastSubagentReports', () => {
    expect(getPanelReports({ subagentReports: [report] })).toEqual([report]);
    expect(getPanelReports({ subagentReports: [], lastSubagentReports: [report] })).toEqual([report]);
    expect(getPanelReports({ lastSubagentReports: [report] })).toEqual([report]);
    expect(getPanelReports({})).toEqual([]);
    expect(getPanelReports(null)).toEqual([]);
  });
});
