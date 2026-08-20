import React, { useEffect, useMemo, useState } from 'react';
import { Bot } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import ProjectSessionTree from './ProjectSessionTree';
import { useStore } from '../store';
import { NAV_GROUPS } from '../lib/codebuddy-schema';
import { accountFooterPresentation } from '../lib/account-auth';
import { resolveLocaleMode, translate } from '../lib/i18n';
// In-app mark only — no white tile (desktop / tray keep build/icon.png).
import appIconMarkUrl from '../../build/icon-mark.png';
import { version as desktopAppVersion } from '../../package.json';

function useSidebarTranslate() {
  const localeMode = useStore((state) => state.guiSettings?.locale || 'system');
  const [systemTick, setSystemTick] = useState(0);
  useEffect(() => {
    if (localeMode !== 'system') return undefined;
    const onChange = () => setSystemTick((value) => value + 1);
    window.addEventListener('languagechange', onChange);
    return () => window.removeEventListener('languagechange', onChange);
  }, [localeMode]);
  return useMemo(() => {
    void systemTick;
    const resolved = resolveLocaleMode(localeMode);
    return (key, vars) => translate(resolved, key, vars);
  }, [localeMode, systemTick]);
}

export function sidebarAccountDotClass(authState, presentationKind) {
  if (authState === 'authenticating' || presentationKind === 'authenticating') {
    return 'bg-[var(--color-accent-yellow)]';
  }
  if (authState === 'required' || authState === 'error' || presentationKind === 'needs_login') {
    return 'bg-[var(--color-accent-red)]';
  }
  if (authState === 'authenticated' || presentationKind === 'authenticated') {
    return 'bg-[var(--color-accent-green)]';
  }
  if (presentationKind === 'cached') return 'bg-[var(--color-accent-yellow)]';
  return 'bg-[var(--color-text-muted)]';
}

function accountAvatarGlyph(label) {
  const text = String(label || '').trim();
  if (!text) return '?';
  return Array.from(text)[0]?.toUpperCase() || '?';
}

/** Identity card: avatar + ID, full CLI/Desktop versions; click opens account popover. */
export function SidebarAccountFooter({
  collapsed = false,
  connectionState = 'disconnected',
}) {
  const t = useSidebarTranslate();
  const {
    codeBuddyAccountAuthState,
    codeBuddyAccountUser,
    codeBuddyAccountAuthError,
    codeBuddyAccountAuthUrl,
    guiSettings,
    authenticateCodeBuddyAccount,
    cancelCodeBuddyAccountAuth,
    logout,
  } = useStore(
    useShallow((state) => ({
      codeBuddyAccountAuthState: state.codeBuddyAccountAuthState,
      codeBuddyAccountUser: state.codeBuddyAccountUser,
      codeBuddyAccountAuthError: state.codeBuddyAccountAuthError,
      codeBuddyAccountAuthUrl: state.codeBuddyAccountAuthUrl,
      guiSettings: state.guiSettings,
      authenticateCodeBuddyAccount: state.authenticateCodeBuddyAccount,
      cancelCodeBuddyAccountAuth: state.cancelCodeBuddyAccountAuth,
      logout: state.logout,
    })),
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const presentation = accountFooterPresentation({
    authState: codeBuddyAccountAuthState,
    user: codeBuddyAccountUser,
    lastUser: guiSettings?.lastAccountUser,
    site: guiSettings?.accountLoginSite || 'global',
  });
  const siteLabel =
    presentation.site === 'global' ? t('account.site.global') : t('account.site.cn');
  const authenticating = presentation.kind === 'authenticating';
  const accountDotClass = sidebarAccountDotClass(codeBuddyAccountAuthState, presentation.kind);
  // Desktop product version only in the identity card (CLI version lives in Settings / CLI maintenance).
  const guiVersionRaw = String(desktopAppVersion || '').replace(/^v/i, '') || null;
  const guiVersionLabel = guiVersionRaw
    ? t('sidebar.guiVersionLine', { version: guiVersionRaw })
    : t('sidebar.guiVersionUnknownLine');
  const connectionLabel =
    connectionState === 'connected'
      ? t('connection.connected')
      : connectionState === 'connecting'
        ? t('connection.connecting')
        : connectionState === 'error'
          ? t('connection.error')
          : t('connection.disconnected');

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMenuOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [menuOpen]);

  const pickSite = async (site) => {
    setMenuOpen(false);
    if (authenticating) return;
    await authenticateCodeBuddyAccount({ site });
  };

  const openMenu = () => {
    if (authenticating) return;
    setMenuOpen((open) => !open);
  };

  const cancelLogin = (event) => {
    event?.stopPropagation?.();
    cancelCodeBuddyAccountAuth?.();
    setMenuOpen(false);
  };

  const handleLogout = async (event) => {
    event?.stopPropagation?.();
    setMenuOpen(false);
    try {
      await logout?.();
    } catch (error) {
      console.warn('[account] logout failed', error);
    }
  };

  let primaryLabel = t('account.notLoggedIn');
  if (authenticating) primaryLabel = t('account.loggingIn');
  else if (presentation.kind === 'authenticated') {
    primaryLabel = presentation.label || t('account.loggedIn');
  } else if (presentation.kind === 'cached') {
    primaryLabel = presentation.label || t('account.cachedUser');
  }

  const summaryParts = [primaryLabel];
  if (presentation.kind === 'authenticated' || presentation.kind === 'cached') {
    summaryParts.push(siteLabel);
  }
  if (presentation.kind === 'cached') summaryParts.push(t('account.cachedUser'));
  summaryParts.push(guiVersionLabel, connectionLabel);
  if (codeBuddyAccountAuthError && presentation.kind === 'needs_login') {
    summaryParts.push(String(codeBuddyAccountAuthError));
  }
  const summaryText = summaryParts.filter(Boolean).join(' · ');

  const badgeTitle =
    presentation.kind === 'authenticated'
      ? t('account.loggedIn')
      : presentation.kind === 'cached'
        ? t('account.cachedUser')
        : authenticating
          ? t('account.loggingIn')
          : t('account.notLoggedIn');

  const loggedIn =
    presentation.kind === 'authenticated' || presentation.kind === 'cached';

  const menu = menuOpen ? (
    <>
      <button
        type="button"
        className="fixed inset-0 z-10"
        style={{ left: collapsed ? 60 : 'var(--sidebar-width, 252px)' }}
        onClick={() => setMenuOpen(false)}
        aria-hidden="true"
      />
      <div
        role="menu"
        aria-label={t('account.menuAccount')}
        data-testid="sidebar-account-site-menu"
        className="composer-menu composer-menu--open sidebar-account-menu absolute bottom-full left-0 z-20 mb-1"
      >
        {loggedIn ? (
          <>
            <button
              type="button"
              role="menuitem"
              className="composer-menu-item w-full px-3 py-1.5 text-left text-xs"
              onClick={() => pickSite('cn')}
            >
              {t('account.site.cn')}
            </button>
            <button
              type="button"
              role="menuitem"
              className="composer-menu-item w-full px-3 py-1.5 text-left text-xs"
              onClick={() => pickSite('global')}
            >
              {t('account.site.global')}
            </button>
            <button
              type="button"
              role="menuitem"
              className="composer-menu-item composer-menu-item--danger w-full px-3 py-1.5 text-left text-xs"
              onClick={handleLogout}
              data-testid="sidebar-account-logout"
            >
              {t('account.logout')}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              role="menuitem"
              className="composer-menu-item w-full px-3 py-1.5 text-left text-xs"
              onClick={() => pickSite('cn')}
              data-testid="sidebar-account-login"
            >
              {t('account.site.cn')}
            </button>
            <button
              type="button"
              role="menuitem"
              className="composer-menu-item w-full px-3 py-1.5 text-left text-xs"
              onClick={() => pickSite('global')}
            >
              {t('account.site.global')}
            </button>
          </>
        )}
      </div>
    </>
  ) : null;

  const avatarFace =
    presentation.kind === 'authenticated' || presentation.kind === 'cached' ? (
      <span className="sidebar-user-avatar-glyph">
        {accountAvatarGlyph(presentation.label || primaryLabel)}
      </span>
    ) : (
      <img src={appIconMarkUrl} alt="" className="sidebar-user-avatar-mark" />
    );

  const versionBlock = (
    <div className="sidebar-user-versions" data-testid="sidebar-account-status">
      <div className="sidebar-user-version-row" data-testid="sidebar-account-gui-version">
        <span className="sidebar-user-version-key">{t('sidebar.versionKey.app')}</span>
        <span className="sidebar-user-version-value">
          {guiVersionRaw ? `v${guiVersionRaw}` : '—'}
        </span>
      </div>
    </div>
  );

  if (collapsed) {
    return (
      <div className="sidebar-user-collapsed" title={summaryText}>
        <button
          type="button"
          className="sidebar-user-avatar"
          aria-label={
            authenticating
              ? t('account.cancelLogin')
              : presentation.showLogin
                ? t('account.login')
                : summaryText
          }
          aria-haspopup={authenticating ? undefined : 'menu'}
          aria-expanded={authenticating ? undefined : menuOpen}
          onClick={authenticating ? cancelLogin : openMenu}
          data-testid="sidebar-account-collapsed"
        >
          {avatarFace}
          <span className={`sidebar-user-avatar-dot ${accountDotClass}`} title={badgeTitle} />
        </button>
        {menu}
      </div>
    );
  }

  return (
    <div className="sidebar-footer-identity relative" data-testid="sidebar-account-footer">
      <div
        className="sidebar-user-card"
        data-disabled={authenticating ? 'true' : undefined}
        data-auth={presentation.kind}
      >
        {authenticating ? (
          <>
            <div className="sidebar-user-main" data-testid="sidebar-account-main" title={summaryText}>
              <div className="sidebar-user-avatar" aria-hidden="true">
                {avatarFace}
                <span className={`sidebar-user-avatar-dot ${accountDotClass}`} title={badgeTitle} />
              </div>
              <div className="sidebar-user-info">
                <div className="sidebar-user-name" data-testid="sidebar-account-name">
                  {primaryLabel}
                </div>
                {versionBlock}
              </div>
            </div>
            <button
              type="button"
              className="sidebar-user-action sidebar-user-action--danger"
              onClick={cancelLogin}
              data-testid="sidebar-account-cancel"
            >
              {t('account.cancelLogin')}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="sidebar-user-main"
            title={summaryText}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={openMenu}
            data-testid="sidebar-account-main"
          >
            <div className="sidebar-user-avatar" aria-hidden="true">
              {avatarFace}
              <span className={`sidebar-user-avatar-dot ${accountDotClass}`} title={badgeTitle} />
            </div>
            <div className="sidebar-user-info">
              <div className="sidebar-user-name" data-testid="sidebar-account-name">
                {primaryLabel}
              </div>
              {versionBlock}
            </div>
          </button>
        )}
      </div>
      {authenticating && codeBuddyAccountAuthUrl ? (
        <button
          type="button"
          className="sidebar-account-auth-url"
          title={codeBuddyAccountAuthUrl}
          data-testid="sidebar-account-auth-url"
          onClick={() => {
            const opener = window.electronAPI?.openExternal;
            if (opener) opener(codeBuddyAccountAuthUrl).catch(() => {});
          }}
        >
          {t('account.openAuthUrl')}
        </button>
      ) : null}
      {menu}
    </div>
  );
}


const ITEM_ICONS = {
  chat: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M8 1C4.13 1 1 3.13 1 6.5c0 1.58.64 3 1.75 4.03L2 14l3.62-1.53c.76.2 1.55.3 2.38.3 3.87 0 7-2.13 7-5.5S11.87 1 8 1z" />
    </svg>
  ),
  instances: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1" y="1" width="6" height="6" rx="1" />
      <rect x="9" y="1" width="6" height="6" rx="1" />
      <rect x="1" y="9" width="6" height="6" rx="1" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </svg>
  ),
  'remote-control': (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="8" r="2" />
      <path d="M8 2v2" />
    </svg>
  ),
  tasks: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 4h3M2 8h8M2 12h6M13 5l2 2-3.5 3.5" />
    </svg>
  ),
  archived: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="3" width="12" height="3" rx="1" />
      <path d="M3 6v7h10V6M6 9h4" />
    </svg>
  ),
  terminal: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 3l4 3-4 3M8 9h6" />
    </svg>
  ),
  editor: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M11 1l4 4-8 8H3v-4l8-8z" />
    </svg>
  ),
  changes: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2" />
    </svg>
  ),
  plugins: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M8 2l2 4 4 2-4 2-2 4-2-4-4-2 4-2z" />
    </svg>
  ),
  skills: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 3h10v10H3zM6 6h4M6 9h3" />
    </svg>
  ),
  agents: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="5" cy="6" r="2" />
      <circle cx="11" cy="6" r="2" />
      <path d="M2 13c0-2 1.5-3 3-3s3 1 3 3M8 13c0-2 1.5-3 3-3s3 1 3 3" />
    </svg>
  ),
  mcp: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="4" cy="8" r="2" />
      <circle cx="12" cy="4" r="2" />
      <circle cx="12" cy="12" r="2" />
      <path d="M6 8h2.5M9.5 7l1.2-1.6M9.5 9l1.2 1.6" />
    </svg>
  ),
  sandboxes: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M8 1.5l5.5 3v7L8 14.5l-5.5-3v-7L8 1.5z" />
      <path d="M2.5 4.5L8 7.5l5.5-3M8 7.5v7" />
    </svg>
  ),
  stats: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 14V6h3v8H2zm4.5 0V1h3v13h-3zm4.5 0V4h3v10h-3z" />
    </svg>
  ),
  traces: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M1 8h14M8 1v14M3 3l10 10M13 3L3 13" />
    </svg>
  ),
  monitor: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1" y="2" width="14" height="10" rx="2" />
      <path d="M5 15h6M8 12v3" />
    </svg>
  ),
  logs: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 2h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1zm0 3h10m-10 3h6" />
    </svg>
  ),
  settings: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 1v2m0 10v2M1 8h2m10 0h2m-3.66-4.66l1.42-1.42m-9.52 9.52l1.42-1.42m9.52 0l1.42 1.42m-9.52-9.52l1.42 1.42" />
    </svg>
  ),
  models: <Bot size={16} strokeWidth={1.5} />,
  keybindings: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1" y="4" width="6" height="6" rx="1" />
      <path d="M9.5 5h3M9.5 9h3M9.5 7h5" />
    </svg>
  ),
  docs: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 1h10l2 2v10a2 2 0 01-2 2H3a2 2 0 01-2-2V3a2 2 0 012-2zm2 3h6M5 8h6M5 11h3" />
    </svg>
  ),
  workers: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="4" cy="4" r="2" />
      <circle cx="12" cy="4" r="2" />
      <circle cx="8" cy="11" r="2" />
      <path d="M2 8v6h4V8m4 0v6h4V8" />
    </svg>
  ),
  metrics: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M1 14V6h3v8H1zm4.5 0V1h3v13h-3zm4.5 0V4h3v10h-3z" />
    </svg>
  ),
};

export function replicaSidebarWidthStyle(collapsed) {
  const width = collapsed ? 60 : 'clamp(220px, 21vw, 252px)';
  // Width is animated via .sidebar-nav CSS transition; keep all three in sync for flex.
  return { width, minWidth: width, maxWidth: width };
}

export function replicaSidebarGroupInitiallyExpanded(groupId) {
  return groupId === 'primary';
}

export function replicaSidebarMainGroups() {
  return NAV_GROUPS.filter((group) => group.id !== 'preferences');
}

export function replicaSidebarGroupForRoute(route) {
  return replicaSidebarMainGroups().find((group) => group.items.some((item) => item.id === route))?.id || null;
}

export function replicaSidebarFooterItems() {
  // Models live under Settings → 模型选择; keep footer free of the old 模型 entry.
  return (NAV_GROUPS.find((group) => group.id === 'preferences')?.items || []).filter(
    (item) => item.id !== 'models',
  );
}

export default function ReplicaSidebar() {
  const {
    route,
    setRoute,
    sidebarCollapsed,
    connectionState,
    newSession,
    newSessionBusy,
    changesCount,
    projectNavigationBusy,
    projectNavigationTargetId,
    projectNavigationError,
    projectsById,
    projectOrder,
    activeProjectId,
    activeThreadId,
    fileDirty,
    selectedFile,
    threadsById,
    threadOrderByProject,
    activateProject,
    activateThread,
    renameThread,
    deleteThread,
    renameProject,
    removeProject,
    setProjectSidebarExpanded,
    setThreadPinned,
    archiveThread,
  } = useStore(
    useShallow((state) => ({
      route: state.route,
      setRoute: state.setRoute,
      sidebarCollapsed: state.sidebarCollapsed,
      connectionState: state.connectionState,
      newSession: state.newSession,
      newSessionBusy: state.newSessionBusy,
      changesCount: state.changesCount,
      projectNavigationBusy: state.projectNavigationBusy,
      projectNavigationTargetId: state.projectNavigationTargetId,
      projectNavigationError: state.projectNavigationError,
      projectsById: state.projectsById,
      projectOrder: state.projectOrder,
      activeProjectId: state.activeProjectId,
      activeThreadId: state.activeThreadId,
      fileDirty: state.fileDirty,
      selectedFile: state.selectedFile,
      threadsById: state.threadsById,
      threadOrderByProject: state.threadOrderByProject,
      activateProject: state.activateProject,
      activateThread: state.activateThread,
      renameThread: state.renameThread,
      deleteThread: state.deleteThread,
      renameProject: state.renameProject,
      removeProject: state.removeProject,
      setProjectSidebarExpanded: state.setProjectSidebarExpanded,
      setThreadPinned: state.setThreadPinned,
      archiveThread: state.archiveThread,
    })),
  );
  const [projectMenuOpenId, setProjectMenuOpenId] = React.useState(null);
  const [projectMenuPosition, setProjectMenuPosition] = React.useState({ x: 0, y: 0 });
  const [projectDialog, setProjectDialog] = React.useState(null);
  const [projectName, setProjectName] = React.useState('');
  const [projectActionBusy, setProjectActionBusy] = React.useState(false);
  const [projectActionError, setProjectActionError] = React.useState('');
  const [expandedNavGroups, setExpandedNavGroups] = React.useState(() =>
    Object.fromEntries(
      replicaSidebarMainGroups().map((group) => [group.id, replicaSidebarGroupInitiallyExpanded(group.id)]),
    ),
  );
  const scopeGenerationRef = React.useRef(0);
  const projectActionInFlightRef = React.useRef(null);

  React.useEffect(() => {
    const groupId = replicaSidebarGroupForRoute(route);
    if (!groupId) return;
    setExpandedNavGroups((current) =>
      current[groupId] ? current : { ...current, [groupId]: true },
    );
  }, [route]);

  const openProjectDialog = (mode, project) => {
    if (projectNavigationBusy || projectActionInFlightRef.current) return;
    setProjectMenuOpenId(null);
    setProjectDialog({ mode, project });
    setProjectName(project.name || '');
    setProjectActionError('');
  };

  const closeProjectDialog = () => {
    if (projectActionInFlightRef.current) return;
    setProjectDialog(null);
    setProjectActionError('');
  };

  const submitProjectDialog = async () => {
    if (!projectDialog || projectActionInFlightRef.current) return;
    const generation = scopeGenerationRef.current;
    const dialog = projectDialog;
    const { mode, project } = dialog;
    if (mode === 'rename' && !projectName.trim()) {
      setProjectActionError('项目名称不能为空');
      return;
    }
    const operation = {};
    projectActionInFlightRef.current = operation;
    setProjectActionBusy(true);
    setProjectActionError('');
    try {
      const ok =
        mode === 'rename'
          ? await renameProject(project.id, projectName.trim())
          : await removeProject(project.id, { skipDirtyCheck: true });
      if (generation !== scopeGenerationRef.current) return;
      if (!ok) {
        setProjectActionError(mode === 'rename' ? '重命名失败，请重试' : '移除失败，请重试');
        return;
      }
      setProjectDialog(null);
    } catch (error) {
      if (generation === scopeGenerationRef.current) {
        setProjectActionError(error.message || (mode === 'rename' ? '重命名失败' : '移除失败'));
      }
    } finally {
      if (projectActionInFlightRef.current === operation) {
        projectActionInFlightRef.current = null;
        if (generation === scopeGenerationRef.current) setProjectActionBusy(false);
      }
    }
  };

  React.useEffect(() => {
    scopeGenerationRef.current += 1;
    projectActionInFlightRef.current = null;
    setProjectMenuOpenId(null);
    setProjectDialog(null);
    setProjectActionBusy(false);
    setProjectActionError('');
  }, [activeProjectId, activeThreadId]);

  // 点击外部关菜单：捕获阶段 pointerdown，避免挡住会话行激活
  React.useEffect(() => {
    if (projectMenuOpenId === null) return;
    const onDoc = (e) => {
      if (!e.target.closest?.('[data-project-menu]')) setProjectMenuOpenId(null);
    };
    document.addEventListener('pointerdown', onDoc, true);
    return () => document.removeEventListener('pointerdown', onDoc, true);
  }, [projectMenuOpenId]);

  const activateSidebarThread = React.useCallback(async (threadId) => {
    setRoute('chat');
    try {
      return await activateThread(threadId);
    } catch (error) {
      // 防御：激活失败时不抛到 React 事件，避免侧栏点击表现为“无反应”
      console.error('[sidebar] activateThread failed', threadId, error);
      return false;
    }
  }, [activateThread, setRoute]);

  const createProjectThread = React.useCallback(async (projectId) => {
    setRoute('chat');
    const state = useStore.getState();
    // 新建会话前先确保项目在侧栏中展开，便于立刻看到新会话
    const project = state.projectsById[projectId];
    if (project?.preferences?.sidebarExpanded === false) {
      await setProjectSidebarExpanded(projectId, true);
    }
    const nextState = useStore.getState();
    // 跨项目点 "+"：必须在目标项目下新建空白会话，而不是只 activate 到对方第一个会话
    if (nextState.activeProjectId !== projectId) {
      return activateProject(projectId, { preferNewThread: true });
    }
    return newSession();
  }, [activateProject, newSession, setProjectSidebarExpanded, setRoute]);

  const renameSidebarThread = React.useCallback(async (threadId, title) => {
    const state = useStore.getState();
    const thread = state.threadsById[threadId];
    if (thread?.projectId !== state.activeProjectId) {
      const activated = await activateSidebarThread(threadId);
      if (!activated) return false;
    }
    return renameThread(threadId, title);
  }, [activateSidebarThread, renameThread]);

  const deleteSidebarThread = React.useCallback(async (threadId) => {
    return deleteThread(threadId);
  }, [deleteThread]);

  // M-perf: stable callback so ProjectSessionTree (memoized) does not re-render
  // when the sidebar re-renders for unrelated reasons (route, collapse state).
  const openProjectMenu = React.useCallback((event, project) => {
    setProjectMenuPosition({ x: event.clientX, y: event.clientY });
    setProjectMenuOpenId(project.id);
  }, []);

  const renderNavItem = (item) => {
    const isActive = route === item.id;
    return (
      <button
        key={item.id}
        onClick={() => setRoute(item.id)}
        className={`sidebar-nav-link group w-full ${isActive ? 'active bg-[var(--color-accent-primary-dim)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]'}`}
        title={sidebarCollapsed ? item.label : undefined}
      >
        <span
          className={`flex h-4 w-4 flex-shrink-0 items-center justify-center ${!isActive ? 'text-[var(--color-text-tertiary)] group-hover:text-[var(--color-text-secondary)]' : ''}`}
          style={isActive ? { color: 'var(--color-accent-blue)' } : undefined}
        >
          {ITEM_ICONS[item.id] || (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <circle cx="8" cy="8" r="2" />
            </svg>
          )}
        </span>
        <span className="sidebar-expand-label truncate text-left">{item.label}</span>
        {item.id === 'changes' && changesCount > 0 ? (
          <span
            className="sidebar-expand-label ml-auto rounded-full px-1.5 py-0 text-[10px] font-medium text-white"
            style={{ background: 'var(--color-accent-blue)' }}
          >
            {changesCount}
          </span>
        ) : null}
      </button>
    );
  };

  return (
    <aside
      role="navigation"
      aria-label="Main navigation"
      data-collapsed={sidebarCollapsed ? 'true' : 'false'}
      className="sidebar-nav flex h-full shrink-0 flex-col border-r border-[var(--color-border-default)] bg-[var(--color-bg-sidebar)] text-[var(--color-text-primary)]"
      style={replicaSidebarWidthStyle(sidebarCollapsed)}
    >
      {/* Brand */}
      <div className="titlebar-drag flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-border-muted)] px-3">
        <img src={appIconMarkUrl} alt="" className="h-7 w-7 shrink-0 object-contain" />
        <span
          className="sidebar-expand-label text-sm font-semibold tracking-tight"
          style={{ color: 'var(--color-accent-brand)' }}
        >
          CodeBuddy Desktop
        </span>
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden py-2.5">
        <div
          className={`sidebar-expand-panel${sidebarCollapsed ? ' is-collapsed' : ''}`}
          aria-hidden={sidebarCollapsed ? 'true' : undefined}
        >
          <div className="sidebar-expand-panel-inner">
            <div className="px-3 pb-2">
              <button
                type="button"
                aria-label="新对话"
                data-testid="sidebar-new-session"
                tabIndex={sidebarCollapsed ? -1 : undefined}
                className="sidebar-new-session-btn flex min-h-9 w-full items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] disabled:cursor-wait disabled:opacity-60"
                disabled={newSessionBusy || projectNavigationBusy}
                onClick={async () => {
                  if (newSessionBusy || projectNavigationBusy) return;
                  setRoute('chat');
                  // 点击「新对话」= 直接弹系统目录选择框，选中的目录作为新会话的工作目录
                  await useStore.getState().chooseWorkspace();
                }}
              >
                {newSessionBusy || projectNavigationBusy ? (
                  <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-[var(--color-text-muted)] border-t-transparent" />
                ) : null}
                {projectNavigationBusy ? '切换中...' : newSessionBusy ? '正在创建...' : '新对话'}
              </button>
            </div>

            <div className="mb-2 px-3">
              <ProjectSessionTree
                projectsById={projectsById}
                projectOrder={projectOrder}
                threadsById={threadsById}
                threadOrderByProject={threadOrderByProject}
                activeProjectId={activeProjectId}
                activeThreadId={activeThreadId}
                projectNavigationBusy={projectNavigationBusy || projectActionBusy}
                projectNavigationTargetId={projectNavigationTargetId}
                onToggleProject={setProjectSidebarExpanded}
                onActivateThread={activateSidebarThread}
                onPinThread={setThreadPinned}
                onArchiveThread={archiveThread}
                onRenameThread={renameSidebarThread}
                onDeleteThread={deleteSidebarThread}
                onCreateProjectThread={createProjectThread}
                onOpenProjectMenu={openProjectMenu}
              />
              {projectNavigationError ? (
                <div className="mt-1 px-1 text-[10px] text-[var(--color-accent-red)]">{projectNavigationError}</div>
              ) : null}
            </div>
          </div>
        </div>

        {replicaSidebarMainGroups().map((group) => {
          const groupExpanded = sidebarCollapsed || expandedNavGroups[group.id];
          return (
            <div key={group.id} className="mb-1">
              <div
                className={`sidebar-expand-panel${sidebarCollapsed ? ' is-collapsed' : ''}`}
                aria-hidden={sidebarCollapsed ? 'true' : undefined}
              >
                <div className="sidebar-expand-panel-inner">
                  <button
                    type="button"
                    className="sidebar-section-title flex w-full items-center justify-between text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                    aria-expanded={Boolean(groupExpanded)}
                    aria-label={`${groupExpanded ? '折叠' : '展开'}${group.title}`}
                    tabIndex={sidebarCollapsed ? -1 : undefined}
                    onClick={() =>
                      setExpandedNavGroups((current) => ({ ...current, [group.id]: !current[group.id] }))
                    }
                  >
                    <span>{group.title}</span>
                    <svg
                      className={`h-3 w-3 transition-transform ${groupExpanded ? 'rotate-90' : ''}`}
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                    >
                      <path d="M6 3l5 5-5 5" />
                    </svg>
                  </button>
                </div>
              </div>
              {groupExpanded ? <div className="space-y-0.5 px-1.5">{group.items.map(renderNavItem)}</div> : null}
            </div>
          );
        })}
      </div>

      {!sidebarCollapsed && projectMenuOpenId && projectsById[projectMenuOpenId] ? (
        <div
          data-project-menu
          className="fixed z-50 w-32 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] py-1 shadow-lg"
          style={{ left: projectMenuPosition.x, top: projectMenuPosition.y }}
        >
          <button
            className="w-full px-3 py-1.5 text-left text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
            onClick={() => openProjectDialog('rename', projectsById[projectMenuOpenId])}
          >
            重命名
          </button>
          <button
            className="w-full px-3 py-1.5 text-left text-xs text-[var(--color-accent-red)] hover:bg-[var(--color-bg-hover)]"
            onClick={() => openProjectDialog('remove', projectsById[projectMenuOpenId])}
          >
            移除项目
          </button>
        </div>
      ) : null}

      {/* 项目管理弹窗 */}
      {projectDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4"
          role="dialog"
          aria-modal="true"
          aria-label={projectDialog.mode === 'rename' ? '重命名项目' : '移除项目确认'}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeProjectDialog();
          }}
        >
          <div className="w-full max-w-sm rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-5 shadow-xl">
            <div className="text-sm font-semibold text-[var(--color-text-primary)]">
              {projectDialog.mode === 'rename' ? '重命名项目' : '从应用中移除项目？'}
            </div>
            {projectDialog.mode === 'rename' ? (
              <div className="mt-4">
                <label className="mb-1.5 block text-xs text-[var(--color-text-secondary)]" htmlFor="project-name-input">
                  项目名称
                </label>
                <input
                  id="project-name-input"
                  autoFocus
                  className="input-field w-full"
                  value={projectName}
                  disabled={projectActionBusy}
                  onChange={(event) => {
                    setProjectName(event.target.value);
                    setProjectActionError('');
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') submitProjectDialog();
                    else if (event.key === 'Escape') closeProjectDialog();
                  }}
                />
              </div>
            ) : (
              <div className="mt-3 space-y-2 text-xs leading-5 text-[var(--color-text-secondary)]">
                <p>“{projectDialog.project.name}”将从 CodeBuddy Desktop 的项目列表中移除，项目文件不会从磁盘删除。</p>
                {projectDialog.project.id === activeProjectId && fileDirty ? (
                  <p className="rounded-md border border-[rgba(239,68,68,0.35)] bg-[rgba(239,68,68,0.08)] px-3 py-2 text-[var(--color-accent-red)]">
                    {selectedFile ? `“${selectedFile}”` : '当前文件'}有未保存修改，继续移除会丢失这些修改。
                  </p>
                ) : null}
              </div>
            )}
            {projectActionError ? (
              <div className="mt-3 text-xs text-[var(--color-accent-red)]">{projectActionError}</div>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="btn-ghost px-3 py-1.5 text-xs"
                disabled={projectActionBusy}
                onClick={closeProjectDialog}
              >
                取消
              </button>
              <button
                className={
                  projectDialog.mode === 'rename'
                    ? 'btn-primary px-3 py-1.5 text-xs'
                    : 'rounded-md px-3 py-1.5 text-xs font-medium text-white'
                }
                style={projectDialog.mode === 'remove' ? { background: 'var(--color-accent-red)' } : undefined}
                disabled={projectActionBusy || (projectDialog.mode === 'rename' && !projectName.trim())}
                onClick={submitProjectDialog}
              >
                {projectActionBusy ? '处理中...' : projectDialog.mode === 'rename' ? '保存' : '移除项目'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="shrink-0 px-1.5 pb-1 pt-0.5">
        <div className="space-y-0.5">{replicaSidebarFooterItems().map(renderNavItem)}</div>
        <SidebarAccountFooter
          collapsed={sidebarCollapsed}
          connectionState={connectionState}
        />
      </div>
    </aside>
  );
}
