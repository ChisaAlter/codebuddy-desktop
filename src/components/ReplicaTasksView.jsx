import React, { useState, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store';
import ActionConfirmDialog from './ActionConfirmDialog';

export default function ReplicaTasksView() {
  const { scheduledTasks, scheduledTasksError, sessionId, refreshTasks, createTask, deleteTask, taskTemplates, taskTemplatesError, taskTemplatesLoading, refreshTaskTemplatesNow } = useStore(useShallow((state) => ({
    scheduledTasks: state.scheduledTasks,
    scheduledTasksError: state.scheduledTasksError,
    sessionId: state.sessionId,
    refreshTasks: state.refreshTasks,
    createTask: state.createTask,
    deleteTask: state.deleteTask,
    taskTemplates: state.taskTemplates,
    taskTemplatesError: state.taskTemplatesError,
    taskTemplatesLoading: state.taskTemplatesLoading,
    refreshTaskTemplatesNow: state.refreshTaskTemplatesNow,
  })));
  const activeThreadId = useStore((state) => state.activeThreadId);
  const [cron, setCron] = useState('0 9 * * *');
  const [prompt, setPrompt] = useState('每日汇总当前会话进度');
  const [creating, setCreating] = useState(false);
  const [localError, setLocalError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshingTemplates, setRefreshingTemplates] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState(null);
  const [pendingDeleteTask, setPendingDeleteTask] = useState(null);
  const [deleteError, setDeleteError] = useState('');
  const sessionGenerationRef = React.useRef(0);
  const createInFlightRef = React.useRef(null);
  const refreshInFlightRef = React.useRef(null);
  const templateRefreshInFlightRef = React.useRef(null);
  const deleteInFlightRef = React.useRef(null);

  useEffect(() => {
    let active = true;
    const threadId = activeThreadId;
    const generation = ++sessionGenerationRef.current;
    setLoading(true);
    setCreating(false);
    setLocalError(null);
    setRefreshing(false);
    setRefreshingTemplates(false);
    setBusyTaskId(null);
    setPendingDeleteTask(null);
    setDeleteError('');
    setCron('0 9 * * *');
    setPrompt('每日汇总当前会话进度');
    createInFlightRef.current = null;
    refreshInFlightRef.current = null;
    templateRefreshInFlightRef.current = null;
    deleteInFlightRef.current = null;
    refreshTasks().finally(() => {
      if (active && generation === sessionGenerationRef.current && useStore.getState().activeThreadId === threadId) setLoading(false);
    });
    return () => { active = false; };
  }, [activeThreadId, sessionId, refreshTasks]);

  const handleCreate = async () => {
    if (createInFlightRef.current) return;
    const operation = {};
    createInFlightRef.current = operation;
    const threadId = activeThreadId;
    const generation = sessionGenerationRef.current;
    const nextCron = cron.trim();
    const nextPrompt = prompt.trim();
    setCreating(true);
    setLocalError(null);
    try {
      await createTask(nextCron, nextPrompt);
      if (threadId === useStore.getState().activeThreadId && generation === sessionGenerationRef.current) {
        setPrompt((current) => current.trim() === nextPrompt ? '每日汇总当前会话进度' : current);
      }
    } catch (err) {
      if (threadId === useStore.getState().activeThreadId && generation === sessionGenerationRef.current) {
        setLocalError(err.message || '创建失败');
      }
    } finally {
      if (createInFlightRef.current === operation) {
        createInFlightRef.current = null;
        if (threadId === useStore.getState().activeThreadId && generation === sessionGenerationRef.current) setCreating(false);
      }
    }
  };

  const handleRefreshTemplates = async () => {
    if (templateRefreshInFlightRef.current) return;
    const operation = {};
    templateRefreshInFlightRef.current = operation;
    const threadId = activeThreadId;
    const generation = sessionGenerationRef.current;
    setRefreshingTemplates(true);
    try {
      await refreshTaskTemplatesNow();
    } finally {
      if (templateRefreshInFlightRef.current === operation) {
        templateRefreshInFlightRef.current = null;
        if (threadId === useStore.getState().activeThreadId && generation === sessionGenerationRef.current) setRefreshingTemplates(false);
      }
    }
  };

  const handleRefresh = async () => {
    if (refreshInFlightRef.current) return;
    const operation = {};
    refreshInFlightRef.current = operation;
    const threadId = activeThreadId;
    const generation = sessionGenerationRef.current;
    setRefreshing(true);
    setLocalError(null);
    try {
      await refreshTasks();
    } finally {
      if (refreshInFlightRef.current === operation) {
        refreshInFlightRef.current = null;
        if (threadId === useStore.getState().activeThreadId && generation === sessionGenerationRef.current) setRefreshing(false);
      }
    }
  };

  const closeDeleteDialog = () => {
    if (deleteInFlightRef.current) return;
    setPendingDeleteTask(null);
    setDeleteError('');
  };

  const confirmDeleteTask = async () => {
    const taskId = pendingDeleteTask?.taskId;
    if (!taskId || deleteInFlightRef.current) return;
    const operation = {};
    deleteInFlightRef.current = operation;
    const threadId = activeThreadId;
    const generation = sessionGenerationRef.current;
    setBusyTaskId(taskId);
    setDeleteError('');
    try {
      await deleteTask(taskId);
      if (threadId === useStore.getState().activeThreadId && generation === sessionGenerationRef.current) setPendingDeleteTask(null);
    } catch (err) {
      if (threadId === useStore.getState().activeThreadId && generation === sessionGenerationRef.current) {
        setDeleteError(err.message || '删除定时任务失败');
      }
    } finally {
      if (deleteInFlightRef.current === operation) {
        deleteInFlightRef.current = null;
        if (threadId === useStore.getState().activeThreadId && generation === sessionGenerationRef.current) setBusyTaskId(null);
      }
    }
  };

  const tasksList = Array.isArray(scheduledTasks) ? scheduledTasks : [];
  const templatesList = Array.isArray(taskTemplates) ? taskTemplates : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[var(--color-bg-primary)]">
      <div className="mx-auto w-full max-w-3xl px-8 py-8">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">定时任务</h1>
          <button className="btn-ghost text-xs" disabled={refreshing} onClick={handleRefresh}>{refreshing ? '刷新中...' : '刷新'}</button>
        </div>

        {/* Error banner */}
        {(localError || scheduledTasksError) && (
          <div className="mb-4 rounded-lg border border-[rgba(248,113,113,0.2)] bg-[rgba(248,113,113,0.1)] px-4 py-2.5 text-sm text-[#f87171]">
            {localError || scheduledTasksError}
            <button className="ml-3 underline text-xs" onClick={handleRefresh}>重试</button>
          </div>
        )}

        {/* Create form */}
        <div className="mb-6 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-4">
          <h2 className="mb-3 text-sm font-medium text-[var(--color-text-primary)]">新增定时任务</h2>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs text-[var(--color-text-secondary)]">Cron 表达式</label>
              <input
                type="text" value={cron} onChange={(e) => setCron(e.target.value)}
                placeholder="0 9 * * *"
                className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-tertiary)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] outline-none focus:border-[var(--color-focus-ring)]"
              />
              <div className="mt-1.5 flex flex-wrap gap-1">
                {[
                  { label: '每天', cron: '0 9 * * *' },
                  { label: '每 2 天', cron: '0 9 */2 * *' },
                  { label: '每 3 天', cron: '0 9 */3 * *' },
                  { label: '每周', cron: '0 9 * * 1' },
                  { label: '每 2 周', cron: '0 9 * * 1/2' },
                  { label: '每月', cron: '0 9 1 * *' },
                ].map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => setCron(preset.cron)}
                    className="rounded border border-[var(--color-border-muted)] bg-[var(--color-bg-primary)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
                    title={preset.cron}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs text-[var(--color-text-secondary)]">提示词</label>
              <textarea
                rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)}
                className="w-full resize-none rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-tertiary)] px-3 py-2 text-xs text-[var(--color-text-primary)] outline-none focus:border-[var(--color-focus-ring)]"
              />
            </div>
            <button
              onClick={handleCreate} disabled={creating || !sessionId || !cron.trim() || !prompt.trim()}
              className="rounded-md bg-[#0078d4] px-4 py-2 text-sm font-medium text-white hover:brightness-110 transition-all disabled:opacity-40"
            >
              {creating ? '创建中...' : '创建任务'}
            </button>
          </div>
        </div>

        {/* Task list */}
        <h2 className="mb-1 text-sm font-medium text-[var(--color-text-primary)]">定时任务</h2>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">当前会话中的活跃定时任务</p>

        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-3">
                <div className="flex-1 min-w-0">
                  <div className="skeleton h-4 rounded mb-2" style={{ width: `${50 + i * 12}%` }} />
                  <div className="skeleton h-3 rounded" style={{ width: `${20 + i * 7}%` }} />
                </div>
              </div>
            ))}
          </div>
        ) : tasksList.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[var(--color-border-muted)] py-12 text-center">
            <p className="text-sm text-[var(--color-text-muted)]">暂无定时任务</p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">使用上方表单创建新的定时任务</p>
          </div>
        ) : (
          <div className="space-y-2">
            {tasksList.map((task, idx) => (
              <div key={task.id || idx} className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-3">
                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-[var(--color-text-primary)] truncate">{task.prompt || task.name || `任务 ${idx + 1}`}</div>
                    <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">{task.cron || task.schedule || '-'}</div>
                  </div>
                  {(() => {
                    const taskId = task.id || task.taskId;
                    const busy = busyTaskId === taskId;
                    return taskId ? (
                      <div className="ml-3 flex shrink-0 items-center gap-1.5">
                        <button
                          className="btn-ghost text-xs text-[var(--color-error)]"
                          disabled={busy}
                          onClick={() => {
                            if (deleteInFlightRef.current) return;
                            setPendingDeleteTask({ ...task, taskId });
                            setDeleteError('');
                          }}
                        >{busy ? '删除中...' : '删除'}</button>
                      </div>
                    ) : <span className="ml-3 text-[10px] text-[var(--color-text-muted)]">后端未返回任务 ID</span>;
                  })()}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 任务模板分区（对照源 GET/POST /api/v1/tasks/templates[/refresh]） */}
        <div className="mt-8">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium text-[var(--color-text-primary)]">推荐模版</h2>
            <button
              onClick={handleRefreshTemplates}
              disabled={refreshingTemplates || taskTemplatesLoading}
              className="btn-ghost text-xs"
              title="从后端刷新模板缓存"
            >
              <svg
                width="13" height="13" viewBox="0 0 16 16"
                fill="none" stroke="currentColor" strokeWidth="1.5"
                className={refreshingTemplates || taskTemplatesLoading ? 'animate-spin mr-1' : 'mr-1'}
              >
                <path d="M1 8a7 7 0 0113.29-4M15 8a7 7 0 01-13.29 4" />
                <path d="M13 1v4h-4M3 15v-4h4" />
              </svg>
              {refreshingTemplates || taskTemplatesLoading ? '刷新中...' : '刷新推荐'}
            </button>
          </div>

          {taskTemplatesError && (
            <div className="mb-3 rounded-lg border border-[rgba(248,113,113,0.2)] bg-[rgba(248,113,113,0.1)] px-3 py-2 text-xs text-[#f87171]">
              {taskTemplatesError}
              <button className="ml-2 underline" onClick={handleRefreshTemplates}>重试</button>
            </div>
          )}

          {(taskTemplatesLoading || refreshingTemplates) && templatesList.length === 0 ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-3">
                  <div className="skeleton h-4 rounded mb-2" style={{ width: `${45 + i * 10}%` }} />
                  <div className="skeleton h-3 rounded" style={{ width: `${22 + i * 6}%` }} />
                </div>
              ))}
            </div>
          ) : templatesList.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--color-border-muted)] py-10 text-center">
              <p className="text-sm text-[var(--color-text-muted)]">暂无推荐模版</p>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">点击右上"刷新推荐"从后端拉取可用模板</p>
            </div>
          ) : (
            <div className="space-y-2">
              {templatesList.map((tpl, idx) => (
                <div key={tpl.id || tpl.name || idx} className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-3">
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-[var(--color-text-primary)] truncate">{tpl.name || tpl.title || `模板 ${idx + 1}`}</div>
                      {tpl.description && (
                        <div className="mt-0.5 truncate text-xs text-[var(--color-text-muted)]">{tpl.description}</div>
                      )}
                      {tpl.cron && (
                        <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">Cron: {tpl.cron}</div>
                      )}
                    </div>
                    {tpl.prompt && (
                      <button
                        onClick={() => {
                          setPrompt(tpl.prompt);
                          if (tpl.cron) setCron(tpl.cron);
                        }}
                        className="btn-ghost ml-2 shrink-0 rounded-md px-2.5 py-1 text-xs text-[var(--color-accent-primary)]"
                        title="载入到新建表单"
                      >
                        使用
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <ActionConfirmDialog
        open={Boolean(pendingDeleteTask)}
        title="删除定时任务？"
        description={pendingDeleteTask ? (
          <><div className="font-medium text-[var(--color-text-primary)]">{pendingDeleteTask.prompt || pendingDeleteTask.name || '未命名任务'}</div><div className="mt-1">计划：{pendingDeleteTask.cron || pendingDeleteTask.schedule || '-'}</div><div className="mt-2">任务删除后不会再按计划执行，此操作无法撤销。</div></>
        ) : null}
        confirmLabel="删除任务"
        busy={Boolean(busyTaskId)}
        error={deleteError}
        onCancel={closeDeleteDialog}
        onConfirm={confirmDeleteTask}
      />
    </div>
  );
}
