import React from 'react';
import ActionConfirmDialog from './ActionConfirmDialog';
import { projectSidebarExpanded, visibleProjectThreads } from '../lib/session-sidebar';

const SESSION_PREVIEW_LIMIT = 8;

function FolderIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M1.5 4h5l1.2 1.5h6.8v7.5h-13V4z" />
    </svg>
  );
}

function PinIcon({ filled = false }) {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4">
      <path d="M5 2h6l-1 4 2 2v1H9v5l-1 1-1-1V9H4V8l2-2-1-4z" />
    </svg>
  );
}

function ArchiveIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="2" y="3" width="12" height="3" rx="1" />
      <path d="M3 6v7h10V6M6 9h4" />
    </svg>
  );
}

export function ProjectSessionTree({
  projectsById,
  projectOrder,
  threadsById,
  threadOrderByProject,
  activeProjectId,
  activeThreadId,
  projectNavigationBusy,
  projectNavigationTargetId,
  onToggleProject,
  onActivateThread,
  onPinThread,
  onArchiveThread,
  onRenameThread,
  onDeleteThread,
  onCreateProjectThread,
  onOpenProjectMenu,
}) {
  const [contextMenu, setContextMenu] = React.useState(null);
  const [renamingId, setRenamingId] = React.useState(null);
  const [renameValue, setRenameValue] = React.useState('');
  const [renameBusy, setRenameBusy] = React.useState(false);
  const [renameError, setRenameError] = React.useState('');
  const [pendingDelete, setPendingDelete] = React.useState(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState('');
  const [actionError, setActionError] = React.useState('');
  const [expandedSessionProjects, setExpandedSessionProjects] = React.useState({});
  const [sessionSearch, setSessionSearch] = React.useState('');

  React.useEffect(() => {
    if (!contextMenu) return undefined;
    const close = (event) => {
      if (!event.target.closest?.('[data-thread-context-menu]')) setContextMenu(null);
    };
    // pointerdown 在捕获阶段关菜单，不与会话行激活抢 click
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [contextMenu]);

  React.useEffect(() => {
    setContextMenu(null);
    setActionError('');
  }, [activeProjectId, activeThreadId]);

  const startRename = (thread) => {
    setContextMenu(null);
    setRenamingId(thread.id);
    setRenameValue(thread.title || '新对话');
    setRenameError('');
  };

  const submitRename = async (threadId) => {
    const title = renameValue.trim();
    if (!title) {
      setRenameError('会话名称不能为空');
      return;
    }
    setRenameBusy(true);
    setRenameError('');
    try {
      const renamed = await onRenameThread(threadId, title);
      if (renamed) setRenamingId(null);
      else setRenameError('重命名会话失败');
    } catch (error) {
      setRenameError(error?.message || '重命名会话失败');
    } finally {
      setRenameBusy(false);
    }
  };

  const runRowAction = async (action) => {
    setActionError('');
    try {
      const ok = await action();
      if (!ok) setActionError('会话操作失败，请重试');
    } catch (error) {
      setActionError(error?.message || '会话操作失败，请重试');
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete || deleteBusy) return;
    if (pendingDelete.id === activeThreadId) {
      setDeleteError('无法删除当前会话');
      return;
    }
    setDeleteBusy(true);
    setDeleteError('');
    try {
      const deleted = await onDeleteThread(pendingDelete.id);
      if (deleted) setPendingDelete(null);
      else setDeleteError('删除会话失败，请重试');
    } catch (error) {
      setDeleteError(error?.message || '删除会话失败，请重试');
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div className="space-y-1" data-project-session-tree>
      <div className="px-1 pb-1">
        <input
          type="text"
          className="w-full rounded-md border border-[var(--color-border-muted)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-accent-blue)]"
          placeholder="搜索会话"
          value={sessionSearch}
          onChange={(event) => setSessionSearch(event.target.value)}
          aria-label="搜索会话"
        />
      </div>
      {projectOrder.length === 0 ? (
        <div className="px-2 py-1 text-xs text-[var(--color-text-muted)]">尚未打开项目</div>
      ) : sessionSearch.trim() ? (
        (() => {
          const term = sessionSearch.trim().toLowerCase();
          const matched = [];
          projectOrder.forEach((projectId) => {
            const project = projectsById[projectId];
            if (!project) return;
            const projectThreads = visibleProjectThreads(projectId, threadOrderByProject, threadsById);
            const hits = projectThreads.filter((thread) => {
              const title = String(thread?.title || '新对话').toLowerCase();
              const projectName = String(project?.name || '').toLowerCase();
              return title.includes(term) || projectName.includes(term);
            });
            if (hits.length > 0) matched.push({ projectId, project, threads: hits });
          });
          if (matched.length === 0) {
            return <div className="px-2 py-1 text-xs text-[var(--color-text-muted)]">未找到匹配的会话</div>;
          }
          return matched.map(({ projectId, project, threads }) => (
            <div key={projectId} data-project-id={projectId}>
              <div className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-[var(--color-text-secondary)]">
                <span className="text-[var(--color-text-muted)]"><FolderIcon /></span>
                <span className="truncate">{project.name}</span>
              </div>
              <div className="ml-3 space-y-0.5">
                {threads.map((thread) => {
                  const isActive = thread.id === activeThreadId;
                  return (
                    <button
                      key={thread.id}
                      type="button"
                      className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs transition-colors ${isActive ? 'bg-[var(--color-bg-hover)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]'}`}
                      onClick={() => onActivateThread(thread.id)}
                    >
                      <span className="truncate">{thread.title || '新对话'}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ));
        })()
      ) : projectOrder.map((projectId) => {
        const project = projectsById[projectId];
        if (!project) return null;
        const expanded = projectSidebarExpanded(project);
        const projectThreads = visibleProjectThreads(projectId, threadOrderByProject, threadsById);
        const sessionsExpanded = Boolean(expandedSessionProjects[projectId]);
        const displayedThreads = sessionsExpanded
          ? projectThreads
          : projectThreads.slice(0, SESSION_PREVIEW_LIMIT);
        const isActiveProject = projectId === activeProjectId;
        const activeThreadBelongsToProject = threadsById[activeThreadId]?.projectId === projectId;
        const showActiveProjectHighlight = isActiveProject && !activeThreadBelongsToProject;
        const mutating = projectNavigationBusy && String(projectNavigationTargetId || '').includes(projectId);
        return (
          <div key={projectId} data-project-id={projectId}>
            <div
              className="group/project flex items-center gap-0.5"
              onContextMenu={(event) => {
                event.preventDefault();
                onOpenProjectMenu(event, project);
              }}
            >
              <button
                type="button"
                className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-sm font-medium transition-colors ${showActiveProjectHighlight ? 'bg-[var(--color-bg-hover)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]'}`}
                data-active-highlight={showActiveProjectHighlight}
                aria-label={`${expanded ? '折叠' : '展开'}项目 ${project.name}`}
                aria-expanded={expanded}
                onClick={() => onToggleProject(projectId, !expanded)}
                disabled={mutating}
                title={project.workspacePath}
              >
                <span className="text-[var(--color-text-muted)]"><FolderIcon /></span>
                <span className="truncate">{project.name}</span>
                <span className={`ml-auto h-1.5 w-1.5 shrink-0 rounded-full ${project.runtimeStatus === 'running' ? 'bg-[var(--color-accent-green)]' : project.runtimeStatus === 'error' ? 'bg-[var(--color-accent-red)]' : project.runtimeStatus === 'starting' ? 'bg-[var(--color-accent-yellow)]' : 'bg-[var(--color-text-muted)]'}`} />
              </button>
              <button
                type="button"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] group-hover/project:opacity-100 focus:opacity-100 disabled:cursor-wait disabled:opacity-50"
                aria-label={`在 ${project.name} 中新建会话`}
                title={`在 ${project.name} 中新建会话`}
                disabled={mutating}
                onClick={(event) => {
                  event.stopPropagation();
                  onCreateProjectThread(projectId);
                }}
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M8 2v12M2 8h12" />
                </svg>
              </button>
            </div>

            {expanded ? (
              // 选中背景与项目行同宽（无左侧空隙）；会话标题用 pl-7 缩进对齐文件夹名
              <div className="mt-0.5 space-y-0.5">
                {projectThreads.length === 0 ? (
                  <button
                    type="button"
                    className="w-full rounded-md py-1 pl-7 pr-2 text-left text-[13px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-secondary)]"
                    aria-label={`在 ${project.name} 中新建会话`}
                    onClick={() => onCreateProjectThread(projectId)}
                  >新建会话</button>
                ) : displayedThreads.map((thread) => {
                  const isActive = thread.id === activeThreadId;
                  const switching = projectNavigationBusy && projectNavigationTargetId === `thread:${thread.id}`;
                  const isRenaming = renamingId === thread.id;
                  const activate = () => {
                    // 全局 busy 时仍允许切换目标会话；仅跳过“已在切换自己”
                    if (switching) return;
                    Promise.resolve(onActivateThread(thread.id)).catch((error) => {
                      console.error('[session-tree] activateThread failed', thread.id, error);
                    });
                  };
                  return (
                    <div
                      key={thread.id}
                      data-session-row
                      data-session-id={thread.id}
                      role="button"
                      tabIndex={isRenaming ? -1 : 0}
                      className={`group/session relative flex min-h-8 w-full cursor-pointer items-center rounded-md pl-7 pr-1.5 transition-colors ${isActive ? 'bg-[var(--color-accent-primary-dim)] text-[var(--color-text-primary)]' : 'hover:bg-[var(--color-bg-hover)]'}`}
                      onClick={(event) => {
                        if (isRenaming) return;
                        if (event.target.closest?.('button, input, a, [data-session-action]')) return;
                        activate();
                      }}
                      onKeyDown={(event) => {
                        if (isRenaming) return;
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          activate();
                        }
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setContextMenu({ thread, x: event.clientX, y: event.clientY });
                      }}
                    >
                      {isRenaming ? (
                        <div className="min-w-0 flex-1 py-1">
                          <input
                            autoFocus
                            value={renameValue}
                            disabled={renameBusy}
                            aria-label="会话新名称"
                            className="w-full rounded border border-[var(--color-border-active)] bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-sm text-[var(--color-text-primary)]"
                            onChange={(event) => { setRenameValue(event.target.value); setRenameError(''); }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') submitRename(thread.id);
                              if (event.key === 'Escape' && !renameBusy) setRenamingId(null);
                            }}
                            onClick={(event) => event.stopPropagation()}
                          />
                          {renameError ? <div className="pt-1 text-[10px] text-[var(--color-accent-red)]">{renameError}</div> : null}
                        </div>
                      ) : (
                        <>
                          <div
                            className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-2 text-left text-sm text-[var(--color-text-secondary)]"
                            title={thread.title || '新对话'}
                          >
                            <span className={`truncate ${isActive ? 'font-medium text-[var(--color-text-primary)]' : ''}`}>{thread.title || '新对话'}</span>
                          </div>
                          <div className="flex h-6 shrink-0 items-center gap-0.5" data-session-action>
                            <div className="hidden items-center gap-0.5 group-hover/session:flex group-focus-within/session:flex">
                              <button
                                type="button"
                                className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
                                aria-label={thread.pinned ? '取消置顶会话' : '置顶会话'}
                                title={thread.pinned ? '取消置顶' : '置顶'}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  runRowAction(() => onPinThread(thread.id, !thread.pinned));
                                }}
                              ><PinIcon filled={thread.pinned} /></button>
                              <button
                                type="button"
                                className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
                                aria-label="归档会话"
                                title="归档"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  runRowAction(() => onArchiveThread(thread.id));
                                }}
                              ><ArchiveIcon /></button>
                            </div>
                            {switching || thread.status === 'running' ? (
                              <span className="h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-text-muted)] border-t-transparent" aria-label="AI处理中" />
                            ) : thread.unread ? (
                              <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent-blue)]" aria-label="未读更新" />
                            ) : null}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
                {projectThreads.length > SESSION_PREVIEW_LIMIT ? (
                  <button
                    type="button"
                    className="w-full rounded-md py-1 pl-7 pr-2 text-left text-[13px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-secondary)]"
                    aria-label={`${sessionsExpanded ? '收起' : '展开'} ${project.name} 的全部会话`}
                    onClick={() => setExpandedSessionProjects((current) => ({
                      ...current,
                      [projectId]: !sessionsExpanded,
                    }))}
                  >{sessionsExpanded ? '收起' : '展开显示'}</button>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}

      {actionError ? <div className="px-2 pt-1 text-[10px] text-[var(--color-accent-red)]">{actionError}</div> : null}

      {contextMenu ? (
        <div
          data-thread-context-menu
          role="menu"
          className="fixed z-50 w-32 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] py-1 shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            type="button"
            role="menuitem"
            data-action="rename"
            className="w-full px-3 py-1.5 text-left text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
            onClick={() => startRename(contextMenu.thread)}
          >重命名</button>
          <button
            type="button"
            role="menuitem"
            data-action="delete"
            className="w-full px-3 py-1.5 text-left text-xs text-[var(--color-accent-red)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={contextMenu.thread?.id === activeThreadId}
            title={contextMenu.thread?.id === activeThreadId ? '无法删除当前会话' : undefined}
            onClick={() => {
              if (contextMenu.thread?.id === activeThreadId) {
                setActionError('无法删除当前会话');
                setContextMenu(null);
                return;
              }
              setPendingDelete(contextMenu.thread);
              setContextMenu(null);
              setDeleteError('');
            }}
          >删除</button>
        </div>
      ) : null}

      <ActionConfirmDialog
        open={Boolean(pendingDelete)}
        title="删除会话？"
        description={pendingDelete ? `“${pendingDelete.title || '新对话'}”及其本地记录将被删除，此操作无法撤销。` : ''}
        confirmLabel="删除"
        busy={deleteBusy}
        error={deleteError}
        onCancel={() => { if (!deleteBusy) setPendingDelete(null); }}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

export default ProjectSessionTree;
