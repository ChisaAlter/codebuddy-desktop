import React, { lazy, Suspense, useEffect, useState } from 'react';
import { LayoutPanelLeft, ListTree } from 'lucide-react';
import { useStore } from './store';
import ReplicaSidebar from './components/ReplicaSidebar';
import ReplicaChatView from './components/ReplicaChatView';
import ActionConfirmDialog from './components/ActionConfirmDialog';
import appIconUrl from '../build/icon-mark.png';
import { guiActionForShortcut, guiShortcutAllowedInInput, shortcutFromKeyboardEvent } from './lib/gui-keybindings';
import { applyDocumentLocale, resolveLocaleMode, translate } from './lib/i18n';
import {
  deriveWorkflowViewCached,
  timelineTailFingerprint,
  workflowViewFingerprint,
} from './lib/workflow-status';
import { requestSettingsSection } from './lib/settings-nav';
import CliSetupDialog from './components/CliSetupDialog';
import CommandPalette from './components/CommandPalette';
import SessionHistoryModal from './components/SessionHistoryModal';
import RightPanelHost from './components/RightPanelHost';
import WorkflowFloatingPanelHost from './components/WorkflowFloatingPanelHost';

const ReplicaSettingsView = lazy(() => import('./components/ReplicaSettingsView'));
const ReplicaModelsView = lazy(() => import('./components/ReplicaModelsView'));
const ReplicaTerminalView = lazy(() => import('./components/ReplicaTerminalView'));
const ReplicaWorkspaceView = lazy(() => import('./components/ReplicaWorkspaceView'));
const ReplicaChangesView = lazy(() => import('./components/ReplicaChangesView'));
const ReplicaWorkersView = lazy(() => import('./components/ReplicaWorkersView'));
const ReplicaMetricsView = lazy(() => import('./components/ReplicaMetricsView'));
const ReplicaPluginsView = lazy(() => import('./components/ReplicaPluginsView'));
const ReplicaSkillsView = lazy(() => import('./components/ReplicaSkillsView'));
const ReplicaAgentsView = lazy(() => import('./components/ReplicaAgentsView'));
const ReplicaMcpView = lazy(() => import('./components/ReplicaMcpView'));
const ReplicaSandboxesView = lazy(() => import('./components/ReplicaSandboxesView'));
const ReplicaStatsView = lazy(() => import('./components/ReplicaStatsView'));
const ReplicaTracesView = lazy(() => import('./components/ReplicaTracesView'));
const ReplicaTasksView = lazy(() => import('./components/ReplicaTasksView'));
const ReplicaArchivedView = lazy(() => import('./components/ReplicaArchivedView'));
const ReplicaLogsView = lazy(() => import('./components/ReplicaLogsView'));
const ReplicaRemoteControlView = lazy(() => import('./components/ReplicaRemoteControlView'));
const ReplicaInstancesView = lazy(() => import('./components/ReplicaInstancesView'));
const ReplicaMonitorView = lazy(() => import('./components/ReplicaMonitorView'));
const ReplicaKeybindingsView = lazy(() => import('./components/ReplicaKeybindingsView'));
const ReplicaDocsView = lazy(() => import('./components/ReplicaDocsView'));

// M-perf (keep-alive): route -> component map used by MainContent. Views stay
// mounted after their first visit and are hidden with display:none, so switching
// back to chat/terminal/editor never rebuilds heavy subtrees (ReactMarkdown
// transcript, xterm + PTY reconnect, Monaco).
const MAIN_VIEW_COMPONENTS = {
  chat: ReplicaChatView,
  instances: ReplicaInstancesView,
  'remote-control': ReplicaRemoteControlView,
  terminal: ReplicaTerminalView,
  docs: ReplicaDocsView,
  models: ReplicaModelsView,
  settings: ReplicaSettingsView,
  editor: ReplicaWorkspaceView,
  changes: ReplicaChangesView,
  workers: ReplicaWorkersView,
  metrics: ReplicaMetricsView,
  plugins: ReplicaPluginsView,
  skills: ReplicaSkillsView,
  agents: ReplicaAgentsView,
  mcp: ReplicaMcpView,
  sandboxes: ReplicaSandboxesView,
  tasks: ReplicaTasksView,
  archived: ReplicaArchivedView,
  stats: ReplicaStatsView,
  traces: ReplicaTracesView,
  monitor: ReplicaMonitorView,
  keybindings: ReplicaKeybindingsView,
  logs: ReplicaLogsView,
};

function WindowControls({ height = 'h-11' }) {
  return (
    <div className={`titlebar-no-drag flex ${height} items-stretch`}>
      <button
        type="button"
        className="flex h-full w-11 items-center justify-center text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
        onClick={() => window.electronAPI?.windowMinimize?.()}
        title="最小化"
        aria-label="最小化窗口"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
          <path d="M2 8.5h8" />
        </svg>
      </button>
      <button
        type="button"
        className="flex h-full w-11 items-center justify-center text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
        onClick={() => window.electronAPI?.windowMaximize?.()}
        title="最大化或还原"
        aria-label="最大化或还原窗口"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
          <rect x="2.25" y="2.25" width="7.5" height="7.5" />
        </svg>
      </button>
      <button
        type="button"
        className="flex h-full w-11 items-center justify-center text-[var(--color-text-secondary)] transition-colors hover:bg-[#c42b1c] hover:text-white"
        onClick={() => window.electronAPI?.windowClose?.()}
        title="关闭到托盘"
        aria-label="关闭窗口到系统托盘"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
          <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
        </svg>
      </button>
    </div>
  );
}

function LoginView() {
  const authSubmitting = useStore((s) => s.authSubmitting);
  const authError = useStore((s) => s.authError);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const projectsById = useStore((s) => s.projectsById);
  const projectOrder = useStore((s) => s.projectOrder);
  const projectNavigationBusy = useStore((s) => s.projectNavigationBusy);
  const login = useStore((s) => s.login);
  const bootstrap = useStore((s) => s.bootstrap);
  const activateProject = useStore((s) => s.activateProject);
  const chooseWorkspace = useStore((s) => s.chooseWorkspace);
  const restartProjectRuntime = useStore((s) => s.restartProjectRuntime);
  const [password, setPassword] = React.useState('');
  const [show, setShow] = React.useState(false);
  const [accessAction, setAccessAction] = React.useState(null);
  const [accessError, setAccessError] = React.useState('');
  const mountedRef = React.useRef(true);
  const alternativeProjectIds = React.useMemo(
    () => projectOrder.filter((projectId) => projectId !== activeProjectId && projectsById[projectId]),
    [activeProjectId, projectOrder, projectsById],
  );
  const [selectedProjectId, setSelectedProjectId] = React.useState(alternativeProjectIds[0] || '');
  const accessBusy = Boolean(accessAction) || projectNavigationBusy;
  const busy = authSubmitting || accessBusy;
  const activeProjectName = projectsById[activeProjectId]?.name || '当前项目';

  React.useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  React.useEffect(() => {
    if (!alternativeProjectIds.includes(selectedProjectId)) {
      setSelectedProjectId(alternativeProjectIds[0] || '');
    }
  }, [alternativeProjectIds, selectedProjectId]);

  const onSubmit = async (event) => {
    event.preventDefault();
    if (busy || !password.trim()) return;
    setAccessError('');
    await login(password);
  };

  const finishProjectAccess = async (result, fallbackMessage) => {
    if (result === true) {
      await bootstrap();
      return;
    }
    if (result === false && mountedRef.current) {
      const state = useStore.getState();
      setAccessError(state.projectNavigationError || state.error || fallbackMessage);
    }
  };

  const switchProject = async () => {
    if (busy || !selectedProjectId) return;
    setAccessAction('switch');
    setAccessError('');
    try {
      const switched = await activateProject(selectedProjectId, { deferInitializationUntilAuth: true });
      await finishProjectAccess(switched, '切换项目失败');
    } catch (error) {
      if (mountedRef.current) setAccessError(error?.message || '切换项目失败');
    } finally {
      if (mountedRef.current) setAccessAction(null);
    }
  };

  const openOtherProject = async () => {
    if (busy) return;
    setAccessAction('workspace');
    setAccessError('');
    try {
      const opened = await chooseWorkspace({ deferInitializationUntilAuth: true });
      await finishProjectAccess(opened, '打开项目失败');
    } catch (error) {
      if (mountedRef.current) setAccessError(error?.message || '打开项目失败');
    } finally {
      if (mountedRef.current) setAccessAction(null);
    }
  };

  const restartAndRecheck = async () => {
    if (busy || !activeProjectId) return;
    setAccessAction('restart');
    setAccessError('');
    try {
      const restarted = await restartProjectRuntime(activeProjectId, { deferInitializationUntilAuth: true });
      await finishProjectAccess(restarted, '重启项目运行时失败');
    } catch (error) {
      if (mountedRef.current) setAccessError(error?.message || '重启项目运行时失败');
    } finally {
      if (mountedRef.current) setAccessAction(null);
    }
  };

  return (
    <div className="relative flex h-screen w-screen items-center justify-center bg-[var(--color-bg-primary)] px-6 text-[var(--color-text-primary)]">
      <div className="titlebar-drag absolute inset-x-0 top-0 flex h-10 justify-end border-b border-[var(--color-border-default)]">
        <WindowControls height="h-10" />
      </div>
      <div className="w-full max-w-sm rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-6 shadow-lg">
        <div className="mb-5 flex items-center gap-2">
          <img src={appIconUrl} alt="CodeBuddy Desktop" className="h-9 w-9 object-contain" />
          <div className="min-w-0">
            <div className="text-base font-semibold" style={{ color: 'var(--color-accent-brand)' }}>
              CodeBuddy Desktop
            </div>
            <div className="truncate text-xs text-[var(--color-text-muted)]" title={activeProjectName}>
              登录项目：{activeProjectName}
            </div>
          </div>
        </div>
        <form onSubmit={onSubmit} className="space-y-3">
          <label className="block">
            <span className="text-xs text-[var(--color-text-muted)]">服务密码</span>
            <div className="relative mt-1">
              <input
                type={show ? 'text' : 'password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={busy}
                autoFocus
                placeholder="请输入 CodeBuddy 服务密码"
                className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-tertiary)] px-3 py-2 pr-14 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent-brand)] focus:outline-none"
                aria-label="服务密码"
              />
              <button
                type="button"
                onClick={() => setShow((value) => !value)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                tabIndex={-1}
                aria-label={show ? '隐藏密码' : '显示密码'}
              >
                {show ? '隐藏' : '显示'}
              </button>
            </div>
          </label>
          {authError ? (
            <div
              className="rounded-md border border-[var(--color-accent-red)]/30 bg-[var(--color-accent-red)]/10 px-3 py-2 text-xs text-[var(--color-accent-red)]"
              role="alert"
            >
              {authError === 'login.error.incorrect'
                ? '密码不正确'
                : authError === 'app.connectFailed'
                  ? '无法连接到服务，请重试或重启运行时'
                  : authError}
            </div>
          ) : null}
          <button
            type="submit"
            disabled={busy || !password.trim()}
            className="btn-primary w-full justify-center px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            style={{ background: 'var(--color-accent-brand)' }}
          >
            {authSubmitting ? (
              <span className="flex items-center gap-2">
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                登录中...
              </span>
            ) : (
              '登录'
            )}
          </button>
        </form>

        <div className="mt-5 border-t border-[var(--color-border-default)] pt-4">
          <div className="mb-2 text-xs font-medium text-[var(--color-text-secondary)]">无法登录当前项目</div>
          {alternativeProjectIds.length ? (
            <div className="mb-2 flex gap-2">
              <select
                className="min-w-0 flex-1 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-tertiary)] px-2 py-1.5 text-xs text-[var(--color-text-primary)]"
                value={selectedProjectId}
                disabled={busy}
                onChange={(event) => setSelectedProjectId(event.target.value)}
                aria-label="选择其他项目"
              >
                {alternativeProjectIds.map((projectId) => (
                  <option key={projectId} value={projectId}>
                    {projectsById[projectId]?.name || projectId}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn-ghost shrink-0 px-3 py-1.5 text-xs"
                disabled={busy || !selectedProjectId}
                onClick={switchProject}
              >
                {accessAction === 'switch' ? '切换中...' : '切换'}
              </button>
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className="btn-ghost justify-center px-3 py-1.5 text-xs"
              disabled={busy}
              onClick={openOtherProject}
            >
              {accessAction === 'workspace' ? '打开中...' : '打开其他项目'}
            </button>
            <button
              type="button"
              className="btn-ghost justify-center px-3 py-1.5 text-xs"
              disabled={busy || !activeProjectId}
              onClick={restartAndRecheck}
            >
              {accessAction === 'restart' ? '重启中...' : '重启运行时'}
            </button>
          </div>
          {accessError ? (
            <div className="mt-2 text-xs text-[var(--color-accent-red)]" role="alert">
              {accessError}
            </div>
          ) : null}
        </div>
        <div className="mt-4 text-center text-[10px] text-[var(--color-text-muted)]">
          密码仅用于本次登录，应用不会保存
        </div>
      </div>
    </div>
  );
}

function AuthRecoveryView() {
  const authError = useStore((s) => s.authError);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeProjectName = useStore((s) => s.projectsById[s.activeProjectId]?.name || '当前项目');
  const projectNavigationBusy = useStore((s) => s.projectNavigationBusy);
  const refreshAuth = useStore((s) => s.refreshAuth);
  const restartProjectRuntime = useStore((s) => s.restartProjectRuntime);
  const chooseWorkspace = useStore((s) => s.chooseWorkspace);
  const [action, setAction] = React.useState(null);
  const [actionError, setActionError] = React.useState('');
  const mountedRef = React.useRef(true);
  const busy = Boolean(action) || projectNavigationBusy;

  React.useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const retry = async () => {
    if (busy) return;
    setAction('retry');
    setActionError('');
    try {
      await refreshAuth();
    } finally {
      if (mountedRef.current) setAction(null);
    }
  };

  const restartAndRetry = async () => {
    if (busy || !activeProjectId) return;
    setAction('restart');
    setActionError('');
    try {
      const restarted = await restartProjectRuntime(activeProjectId);
      if (!restarted) {
        const state = useStore.getState();
        setActionError(state.projectsById[activeProjectId]?.runtimeError || state.error || '重启项目运行时失败');
        return;
      }
      await refreshAuth();
    } catch (error) {
      setActionError(error?.message || '重启项目运行时失败');
    } finally {
      if (mountedRef.current) setAction(null);
    }
  };

  const openOtherProject = async () => {
    if (busy) return;
    setAction('workspace');
    setActionError('');
    try {
      const opened = await chooseWorkspace();
      if (opened === true) {
        await refreshAuth();
      } else if (opened === false) {
        const state = useStore.getState();
        setActionError(state.projectNavigationError || state.error || '打开项目失败');
      }
    } catch (error) {
      setActionError(error?.message || '打开项目失败');
    } finally {
      if (mountedRef.current) setAction(null);
    }
  };

  return (
    <div className="relative flex h-screen w-screen items-center justify-center bg-[var(--color-bg-primary)] px-6 text-[var(--color-text-primary)]">
      <div className="titlebar-drag absolute inset-x-0 top-0 flex h-10 justify-end border-b border-[var(--color-border-default)]">
        <WindowControls height="h-10" />
      </div>
      <div className="w-full max-w-md rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-6 shadow-lg">
        <div className="mb-2 text-base font-semibold">无法确认 CodeBuddy 服务状态</div>
        <div className="mb-2 text-xs text-[var(--color-text-muted)]">项目：{activeProjectName}</div>
        <div className="mb-5 text-sm leading-6 text-[var(--color-text-secondary)]">
          {authError || '当前项目服务暂时不可用。可以重试连接、重启项目运行时，或打开其他项目。'}
        </div>
        {actionError ? (
          <div
            className="mb-4 rounded-md border border-[rgba(239,68,68,0.35)] bg-[rgba(239,68,68,0.08)] px-3 py-2 text-xs text-[var(--color-accent-red)]"
            role="alert"
          >
            {actionError}
          </div>
        ) : null}
        <div className="space-y-2">
          <button className="btn-primary w-full justify-center px-4 py-2 text-sm" disabled={busy} onClick={retry}>
            {action === 'retry' ? '正在重试...' : '重试连接'}
          </button>
          <button
            className="btn-ghost w-full justify-center px-4 py-2 text-sm"
            disabled={busy || !activeProjectId}
            onClick={restartAndRetry}
          >
            {action === 'restart' ? '正在重启运行时...' : '重启运行时并重试'}
          </button>
          <button
            className="btn-ghost w-full justify-center px-4 py-2 text-sm"
            disabled={busy}
            onClick={openOtherProject}
          >
            {action === 'workspace' || projectNavigationBusy ? '正在打开项目...' : '打开其他项目'}
          </button>
        </div>
      </div>
    </div>
  );
}

function AuthLoadingView() {
  return (
    <div className="relative flex h-screen w-screen items-center justify-center bg-[var(--color-bg-primary)] text-[var(--color-text-primary)]">
      <div className="titlebar-drag absolute inset-x-0 top-0 flex h-10 justify-end border-b border-[var(--color-border-default)]">
        <WindowControls height="h-10" />
      </div>
      <div className="flex items-center gap-3 text-sm text-[var(--color-text-secondary)]">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--color-border-default)] border-t-[var(--color-accent-brand)]" />
        正在连接 CodeBuddy...
      </div>
    </div>
  );
}

const ROUTE_TITLES = {
  chat: '对话',
  instances: '实例列表',
  'remote-control': '远程控制',
  tasks: '任务',
  archived: '已归档',
  terminal: '终端',
  editor: '编辑器',
  changes: '变更',
  plugins: '插件',
  skills: '技能',
  agents: 'Agents',
  mcp: 'MCP',
  sandboxes: 'Sandboxes',
  stats: '统计',
  traces: '链路',
  monitor: '监控',
  logs: '日志',
  docs: '文档',
  models: '模型',
  settings: '设置',
  keybindings: '快捷键',
  workers: 'Agent 实例管理',
  metrics: '监控',
};

function StatusBar() {
  const route = useStore((s) => s.route);
  const sessionTitle = useStore((s) => s.sessionTitle);
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useStore((s) => s.setSidebarCollapsed);
  const openRightPanel = useStore((s) => s.openRightPanel);
  const toggleRightPanel = useStore((s) => s.toggleRightPanel);
  const rightPanel = useStore((s) => s.rightPanel);
  const toggleWorkflowPanel = useStore((s) => s.toggleWorkflowPanel);
  const activeThreadId = useStore((s) => s.activeThreadId);
  const localeMode = useStore((s) => s.guiSettings?.locale || 'system');
  const t = (key, vars) => translate(resolveLocaleMode(localeMode), key, vars);
  // M-perf: 顶栏高亮是布尔值，直接在 selector 里派生并用 Object.is 相等性收敛——
  // 组件只在高亮真正翻转时重渲染。旧实现把 timeline（每 chunk 换引用）放进
  // useShallow 字段导致顶栏逐 token 重渲染 + O(回合条目) 重算；现在派生走指纹
  // 键控缓存，纯 token 追加直接命中缓存。
  const workflowVisible = useStore((s) => {
    const runtime = s.threadRuntimeById?.[s.activeThreadId];
    if (!runtime) return false;
    const threadStatus = s.threadsById?.[s.activeThreadId]?.status || 'idle';
    const timelineFingerprint = timelineTailFingerprint(runtime.timeline);
    const fingerprint = workflowViewFingerprint({ runtime, threadStatus, timelineFingerprint });
    return deriveWorkflowViewCached(
      { runtime, threadStatus, timeline: runtime.timeline },
      fingerprint,
    ).highlightTopbar;
  });
  const surfaceActive = Boolean(rightPanel);

  return (
    <div
      className="topbar titlebar-drag flex h-11 shrink-0 items-center gap-3 pl-3 text-xs"
      role="banner"
      aria-label="Status bar"
      data-testid="app-topbar"
    >
      <button
        className="titlebar-no-drag flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] transition-colors"
        onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
        title={sidebarCollapsed ? t('topbar.sidebarExpand') : t('topbar.sidebarCollapse')}
        aria-label={sidebarCollapsed ? t('topbar.sidebarExpand') : t('topbar.sidebarCollapse')}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M2 2h4v12H2V2zm8 0h4v12h-4V2z" />
        </svg>
      </button>
      <div className="flex-1 flex items-center gap-2 min-w-0 text-sm">
        <span className="truncate text-[var(--color-text-secondary)]">{ROUTE_TITLES[route] || route}</span>
        {sessionTitle ? (
          <>
            <span className="text-[var(--color-text-muted)]">/</span>
            <span className="truncate text-[var(--color-text-primary)] font-medium">{sessionTitle}</span>
          </>
        ) : null}
      </div>
      <div className="titlebar-no-drag flex h-full items-center gap-0.5 pr-1">
        <button
          type="button"
          className={`topbar-icon-btn${surfaceActive ? ' is-active' : ''}`}
          onClick={() => {
            // Closed → open chooser. Chooser open → close panel. Other surface → back to chooser.
            if (!rightPanel) openRightPanel('surfaces');
            else if (rightPanel.type === 'surfaces') toggleRightPanel('surfaces');
            else openRightPanel('surfaces');
          }}
          title={t('topbar.surfaces')}
          aria-label={t('topbar.surfaces')}
          aria-haspopup="dialog"
          aria-expanded={Boolean(rightPanel)}
          data-testid="topbar-surfaces-btn"
        >
          <LayoutPanelLeft size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`topbar-icon-btn${workflowVisible ? ' is-active' : ''}`}
          onClick={() => toggleWorkflowPanel({ threadId: activeThreadId })}
          title={t('topbar.workflow')}
          aria-label={t('topbar.workflow')}
          data-testid="topbar-workflow-btn"
        >
          {workflowVisible ? <span className="topbar-icon-btn__dot" aria-hidden="true" /> : null}
          <ListTree size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <WindowControls />
      </div>
    </div>
  );
}

function MainContent() {
  const route = useStore((s) => s.route);
  const productStateLoaded = useStore((s) => s.productStateLoaded);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const chooseWorkspace = useStore((s) => s.chooseWorkspace);
  const setRoute = useStore((s) => s.setRoute);
  const localeMode = useStore((s) => s.guiSettings?.locale || 'system');
  const t = (key, vars) => translate(resolveLocaleMode(localeMode), key, vars);

  // M-perf (keep-alive): every route that has ever been visited stays mounted
  // (non-active ones hidden via display:none), so returning to a heavy view is
  // one paint instead of a full rebuild. Visited routes reset when the active
  // project changes — view content is project-scoped and must never leak across
  // projects.
  const [visitedRoutes, setVisitedRoutes] = React.useState(() => new Set([route]));
  const visitedProjectRef = React.useRef(activeProjectId);
  React.useEffect(() => {
    if (visitedProjectRef.current !== activeProjectId) {
      visitedProjectRef.current = activeProjectId;
      setVisitedRoutes(new Set([route]));
    }
  }, [activeProjectId, route]);
  React.useEffect(() => {
    setVisitedRoutes((prev) => (prev.has(route) ? prev : new Set(prev).add(route)));
  }, [route]);

  if (!productStateLoaded) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-[var(--color-bg-primary)]">
        <div className="text-sm text-[var(--color-text-muted)]">正在恢复项目...</div>
      </div>
    );
  }

  // 无项目时也允许进入设置（CLI 检测 / 首次安装引导 / 桌面偏好），避免新用户装不了 CLI。
  if (!activeProjectId && route === 'settings') {
    return (
      <Suspense fallback={<div className="flex min-h-0 flex-1 items-center justify-center text-sm text-[var(--color-text-muted)]">Loading...</div>}>
        <ReplicaSettingsView />
      </Suspense>
    );
  }

  if (!activeProjectId) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-[var(--color-bg-primary)] px-6">
        <div className="w-full max-w-md text-center">
          <div className="mb-2 text-xl font-semibold text-[var(--color-text-primary)]">{t('emptyProject.title')}</div>
          <div className="mb-3 text-sm leading-6 text-[var(--color-text-secondary)]">{t('emptyProject.desc')}</div>
          <div className="mb-5 text-xs leading-5 text-[var(--color-text-muted)]">{t('emptyProject.setupCliHint')}</div>
          <div className="flex flex-col items-center justify-center gap-2 sm:flex-row">
            <button className="btn-primary px-4 py-2 text-sm" onClick={() => chooseWorkspace()}>
              {t('emptyProject.openFolder')}
            </button>
            {typeof window !== 'undefined' && window.electronAPI ? (
              <button
                type="button"
                className="btn-ghost px-4 py-2 text-sm"
                onClick={() => {
                  requestSettingsSection('settings-section-cli');
                  setRoute('settings');
                }}
              >
                {t('emptyProject.setupCli')}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  if (!MAIN_VIEW_COMPONENTS[route]) {
    return (
      <Suspense
        fallback={
          <div className="flex min-h-0 flex-1 items-center justify-center bg-[var(--color-bg-primary)] text-sm text-[var(--color-text-muted)]">
            正在加载页面...
          </div>
        }
      >
        <div className="flex min-h-0 flex-1 items-center justify-center bg-[var(--color-bg-primary)]">
          <button className="btn-primary px-4 py-2 text-sm" onClick={() => useStore.getState().setRoute('chat')}>
            返回对话
          </button>
        </div>
      </Suspense>
    );
  }
  return (
    <Suspense
      fallback={
        <div className="flex min-h-0 flex-1 items-center justify-center bg-[var(--color-bg-primary)] text-sm text-[var(--color-text-muted)]">
          正在加载页面...
        </div>
      }
    >
      <div className="relative flex h-full min-h-0 w-full min-w-0 flex-col">
        {Array.from(visitedRoutes).map((visitedRoute) => {
          const View = MAIN_VIEW_COMPONENTS[visitedRoute];
          if (!View) return null;
          const active = visitedRoute === route;
          return (
            <div
              key={visitedRoute}
              className={`${active ? 'flex' : 'hidden'} h-full min-h-0 w-full min-w-0`}
              aria-hidden={active ? undefined : true}
            >
              <View />
            </div>
          );
        })}
      </div>
    </Suspense>
  );
}

function GlobalErrorNotice() {
  const error = useStore((state) => state.error);
  const clearError = useStore((state) => state.clearError);

  // Auto-dismiss so a sticky overlay can never permanently block the composer.
  // Long network/proxy dumps previously had no practical close affordance.
  useEffect(() => {
    if (!error) return undefined;
    const text = String(error);
    const durationMs = text.length > 240 ? 10000 : 8000;
    const timer = window.setTimeout(() => {
      const current = useStore.getState().error;
      if (current === error) clearError();
    }, durationMs);
    return () => window.clearTimeout(timer);
  }, [error, clearError]);

  if (!error) return null;

  const fullText = String(error);
  // Keep the floating card compact; full detail stays available via title tooltip.
  const displayText = fullText.length > 360 ? `${fullText.slice(0, 360).trimEnd()}…` : fullText;

  return (
    <div
      className="global-error-notice fixed bottom-5 right-5 z-[100] flex w-[min(420px,calc(100vw-1.5rem))] max-h-[min(40vh,280px)] items-start gap-2 rounded-md border border-[rgba(239,68,68,0.45)] bg-[var(--color-bg-secondary)] px-3 py-2.5 text-sm text-[var(--color-accent-red)] shadow-xl"
      role="alert"
    >
      <span className="min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words pr-1" title={fullText}>
        {displayText}
      </span>
      <button
        type="button"
        className="btn-ghost sticky top-0 shrink-0 px-2 py-1 text-xs"
        onClick={clearError}
        aria-label="关闭错误提示"
      >
        关闭
      </button>
    </div>
  );
}

function ToastStack() {
  const toasts = useStore((state) => state.toasts);
  const dismissToast = useStore((state) => state.dismissToast);
  if (!Array.isArray(toasts) || toasts.length === 0) return null;
  return (
    <div className="toast-container" role="status" aria-live="polite">
      {toasts.map((toast) => {
        const fullText = String(toast.message || '');
        const displayText = fullText.length > 280 ? `${fullText.slice(0, 280).trimEnd()}…` : fullText;
        return (
          <div
            key={toast.id}
            className={`toast items-start ${
              toast.type === 'error' ? 'toast-error' : toast.type === 'success' ? 'toast-success' : 'toast-info'
            }`}
          >
            <span
              className="min-w-0 max-h-28 flex-1 overflow-y-auto whitespace-pre-wrap break-words text-[var(--color-text-primary)]"
              title={fullText}
            >
              {displayText}
            </span>
            <button
              type="button"
              className="btn-ghost shrink-0 px-2 py-1 text-xs"
              onClick={() => dismissToast(toast.id)}
              aria-label="关闭提示"
            >
              关闭
            </button>
          </div>
        );
      })}
    </div>
  );
}

function DirtyFileConfirmDialog() {
  const confirmation = useStore((state) => state.dirtyFileConfirmation);
  const resolve = useStore((state) => state.resolveDirtyFileConfirmation);

  return (
    <ActionConfirmDialog
      open={Boolean(confirmation)}
      title="放弃未保存修改？"
      description={
        confirmation ? (
          <>
            <div className="break-all font-medium text-[var(--color-text-primary)]">{confirmation.filePath}</div>
            <div className="mt-2">{confirmation.actionLabel}将丢失当前未保存内容，此操作无法撤销。</div>
          </>
        ) : null
      }
      confirmLabel="放弃修改并继续"
      onCancel={() => resolve(false)}
      onConfirm={() => resolve(true)}
    />
  );
}

function isShortcutInputTarget(target) {
  return Boolean(target?.closest?.('input, textarea, select, [contenteditable="true"], .monaco-editor, .xterm'));
}

export default function App() {
  const bootstrap = useStore((s) => s.bootstrap);
  const settingsTheme = useStore((s) => s.guiSettings?.theme);
  const settingsLocale = useStore((s) => s.guiSettings?.locale);
  const authViewState = useStore((s) => s.authViewState);
  // G8: 命令面板（⌘/Ctrl+Shift+H）。
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  useEffect(() => {
    bootstrap().catch((error) => console.error(error));
  }, [bootstrap]);

  useEffect(() => {
    const flushProductState = () => {
      useStore.getState().flushProductStateSync?.();
    };
    window.addEventListener('beforeunload', flushProductState);
    return () => window.removeEventListener('beforeunload', flushProductState);
  }, []);

  useEffect(() => {
    // Flush coalesced stream tokens as soon as the window is visible again so
    // the chat UI does not apply a multi-second backlog in one paint.
    const flushStreamOnVisible = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      useStore.getState().flushThreadTimelineCoalesce?.();
    };
    document.addEventListener('visibilitychange', flushStreamOnVisible);
    window.addEventListener('focus', flushStreamOnVisible);
    return () => {
      document.removeEventListener('visibilitychange', flushStreamOnVisible);
      window.removeEventListener('focus', flushStreamOnVisible);
    };
  }, []);

  useEffect(() => {
    let opening = false;
    let pendingTarget = null;
    let retryTimer = null;
    let disposed = false;
    const openPendingNotification = async () => {
      if (disposed || opening || !window.electronAPI?.consumeTaskNotificationTarget) return;
      opening = true;
      try {
        if (!pendingTarget) pendingTarget = await window.electronAPI.consumeTaskNotificationTarget();
        if (!pendingTarget?.threadId) return;
        const state = useStore.getState();
        if (!state.productStateLoaded) {
          retryTimer = window.setTimeout(openPendingNotification, 250);
          return;
        }
        const target = pendingTarget;
        pendingTarget = null;
        state.setRoute('chat');
        if (!state.threadsById[target.threadId]) return;
        const opened = await state.activateThread(target.threadId);
        if (!opened) {
          useStore.setState({ error: useStore.getState().error || '无法打开通知对应的对话' });
        }
      } finally {
        opening = false;
      }
    };
    window.addEventListener('focus', openPendingNotification);
    openPendingNotification();
    return () => {
      disposed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      window.removeEventListener('focus', openPendingNotification);
    };
  }, []);

  useEffect(() => {
    let quitInProgress = false;
    const withTimeout = (promise, ms, label) =>
      Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) => {
          window.setTimeout(() => reject(new Error(`${label || 'operation'} timed out after ${ms}ms`)), ms);
        }),
      ]);
    const unsubscribe = window.electronAPI?.onQuitRequested?.(async ({ requestId } = {}) => {
      if (quitInProgress) return;
      quitInProgress = true;
      window.electronAPI?.acknowledgeQuit?.(requestId);
      const cancelQuit = (reason) => window.electronAPI?.cancelQuit?.(requestId, reason);
      try {
        const state = useStore.getState();
        // Dirty editor needs a visible window + user choice; never time-box the dialog itself.
        if (state.fileDirty && state.selectedFile) {
          try {
            window.electronAPI?.windowShow?.();
            window.electronAPI?.holdQuit?.(requestId);
            window.focus?.();
          } catch (_) {}
          const confirmed = await state.confirmDirtyFileAction('退出应用');
          if (!confirmed) {
            cancelQuit('dirty-file-cancelled');
            return;
          }
          // Dialog done — re-arm a short hard deadline for the remaining persist/confirm path.
          try {
            window.electronAPI?.resumeQuit?.(requestId, 2500);
          } catch (_) {}
        }
        // Cap disk/persist work so tray “完全退出” cannot stall for many seconds.
        try {
          await withTimeout(
            useStore.getState().persistActiveProjectWorkspaceState?.({ discardDirty: true }),
            900,
            'persist workspace',
          );
        } catch (persistError) {
          console.warn('[quit] persist workspace skipped:', persistError?.message || persistError);
        }
        try {
          useStore.getState().flushProductStateSync?.();
        } catch (flushError) {
          console.warn('[quit] flush product state failed:', flushError?.message || flushError);
        }
        // Prefer exiting over blocking: previous path cancelled quit when sync save failed.
        if (!window.electronAPI?.confirmQuit) throw new Error('应用退出接口不可用');
        window.electronAPI.confirmQuit(requestId);
      } catch (error) {
        console.warn('[quit] forcing confirm after error:', error?.message || error);
        try {
          window.electronAPI?.confirmQuit?.(requestId);
        } catch (_) {
          cancelQuit(error?.message || 'renderer-quit-error');
        }
      } finally {
        quitInProgress = false;
      }
    });
    return unsubscribe;
  }, []);

  // 主题切换：根据 GUI 本地偏好设置 data-theme 属性
  useEffect(() => {
    const theme = settingsTheme || 'dark';
    if (theme === 'system') {
      const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
      document.documentElement.dataset.theme = prefersLight ? 'light' : 'dark';
      const handler = (e) => {
        document.documentElement.dataset.theme = e.matches ? 'light' : 'dark';
      };
      const mq = window.matchMedia('(prefers-color-scheme: light)');
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
    document.documentElement.dataset.theme = theme;
  }, [settingsTheme]);

  // 界面语言：WebUI locale mode zh | en | system
  useEffect(() => {
    const apply = () => applyDocumentLocale(resolveLocaleMode(settingsLocale || 'system'));
    apply();
    if ((settingsLocale || 'system') !== 'system') return undefined;
    window.addEventListener('languagechange', apply);
    return () => window.removeEventListener('languagechange', apply);
  }, [settingsLocale]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.repeat || event.defaultPrevented) return;
      // P0-7: while a modal confirmation dialog is open (ActionConfirmDialog and
      // similar), global shortcuts must not fire — switching routes with Ctrl+1..4
      // or creating a new session with Ctrl+Alt+N would unmount the view and
      // silently cancel the dangerous-operation confirm the user is about to
      // accept. Mirrors the terminal view's M-rc9 dialog guard.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const shortcut = shortcutFromKeyboardEvent(event);
      if (isShortcutInputTarget(event.target) && !guiShortcutAllowedInInput(shortcut)) return;
      const action = guiActionForShortcut(shortcut);
      if (!action) return;
      // M-rc5: new-conversation is destructive when the user is mid-typing in an
      // input/textarea/monaco/xterm (it tears focus out and creates a fresh
      // session). guiShortcutAllowedInInput lets ctrl/alt/meta shortcuts through,
      // but new-conversation should never fire while composing — block it here.
      if (action === 'new-conversation' && isShortcutInputTarget(event.target)) return;
      const state = useStore.getState();
      if (state.authViewState !== 'authenticated') return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (action === 'command-palette') {
        setCommandPaletteOpen(true);
        return;
      }
      if (action === 'toggle-sidebar') {
        state.setSidebarCollapsed(!state.sidebarCollapsed);
        return;
      }
      if (action === 'new-conversation') {
        if (state.newSessionBusy || state.projectNavigationBusy) return;
        state.setRoute('chat');
        state.newSession().catch((error) => useStore.setState({ error: error?.message || '创建新对话失败' }));
        return;
      }
      const routeByAction = {
        'open-chat': 'chat',
        'open-terminal': 'terminal',
        'open-editor': 'editor',
        'open-changes': 'changes',
        'open-settings': 'settings',
      };
      const route = routeByAction[action];
      if (route) state.setRoute(route);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  return (
    <div className="app-shell flex h-full w-full min-w-0 overflow-hidden text-[var(--color-text-primary)]">
      {authViewState === 'loading' ? (
        <AuthLoadingView />
      ) : authViewState === 'login' ? (
        <LoginView />
      ) : authViewState === 'error' ? (
        <AuthRecoveryView />
      ) : (
        <>
          <ReplicaSidebar />
          <div className="app-main flex min-w-0 flex-1 flex-col">
            <StatusBar />
            <MainContent />
          </div>
          <RightPanelHost />
          <WorkflowFloatingPanelHost />
          <GlobalErrorNotice />
          <ToastStack />
          {/* 启动检测 CodeBuddy CLI（对齐 pi-desktop onboarding step1） */}
          <CliSetupDialog />
          <CommandPalette open={commandPaletteOpen} onClose={() => setCommandPaletteOpen(false)} />
          <SessionHistoryModal />
        </>
      )}
      <DirtyFileConfirmDialog />
    </div>
  );
}
