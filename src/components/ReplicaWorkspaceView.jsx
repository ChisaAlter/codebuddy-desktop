import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { createTokenizationSupport } from 'monaco-editor/esm/vs/language/json/tokenization.js';
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js';
import { useStore } from '../store';
import { joinPath, normalizePathParts } from '../lib/fs';
import ActionConfirmDialog from './ActionConfirmDialog';

globalThis.MonacoEnvironment = {
  ...(globalThis.MonacoEnvironment || {}),
  getWorker() {
    return new EditorWorker();
  },
};

if (!monaco.languages.getLanguages().some((language) => language.id === 'json')) {
  monaco.languages.register({
    id: 'json',
    extensions: ['.json', '.bowerrc', '.jshintrc', '.jscsrc', '.eslintrc', '.babelrc'],
    aliases: ['JSON', 'json'],
    mimetypes: ['application/json'],
  });
  monaco.languages.setTokensProvider('json', createTokenizationSupport(true));
  monaco.languages.setLanguageConfiguration('json', {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [['{', '}'], ['[', ']']],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
    ],
  });
}

loader.config({ monaco });

function EntryIcon({ type }) {
  if (type === 'directory') return <span>📁</span>;
  return <span>📄</span>;
}

function normalizeComparablePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

function comparablePathKey(value) {
  const normalized = normalizeComparablePath(value);
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized;
}

function pathsEqual(left, right) {
  return comparablePathKey(left) === comparablePathKey(right);
}

function pathContains(root, candidate) {
  const normalizedRoot = comparablePathKey(root);
  const normalizedCandidate = comparablePathKey(candidate);
  if (!normalizedRoot || !normalizedCandidate) return false;
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function SearchPanel() {
  const fileSearchQuery = useStore((s) => s.fileSearchQuery);
  const setFileSearchQuery = useStore((s) => s.setFileSearchQuery);
  const runFileSearch = useStore((s) => s.runFileSearch);
  const fileSearchResults = useStore((s) => s.fileSearchResults);
  const fileSearching = useStore((s) => s.fileSearching);
  const openFile = useStore((s) => s.openFile);
  const openDirectory = useStore((s) => s.openDirectory);

  // 文件名搜索（对照源 GET /api/v1/fs/search?query&limit=15）
  const fileNameQuery = useStore((s) => s.fileNameQuery);
  const setFileNameQuery = useStore((s) => s.setFileNameQuery);
  const runFileNameSearch = useStore((s) => s.runFileNameSearch);
  const fileNameResults = useStore((s) => s.fileNameResults);
  const fileNameSearching = useStore((s) => s.fileNameSearching);
  // 轻输入防抖：对照源 bundle 用 150ms setTimeout，键停后自动搜
  const debounceRef = React.useRef(null);
  const onNameChange = (val) => {
    setFileNameQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!String(val || '').trim()) return;
    debounceRef.current = setTimeout(() => {
      runFileNameSearch();
      debounceRef.current = null;
    }, 200);
  };
  React.useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  return (
    <div className="border-b border-[var(--color-border-default)] p-3">
      {/* 文件名快速搜索（补全/打开文件） */}
      <div className="mb-2 text-[11px] uppercase tracking-wide text-[var(--color-text-muted)]">搜索文件名</div>
      <div className="relative">
        <input
          value={fileNameQuery}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="输入文件名片段实时搜索..."
          className="input-field w-full"
          aria-label="搜索文件名"
        />
        {fileNameSearching && (
          <div className="absolute right-2 top-1/2 -translate-y-1/2">
            <div className="h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-border-muted)] border-t-[var(--color-accent-brand)]" />
          </div>
        )}
      </div>
      {fileNameResults.length > 0 && (
        <div className="mt-2 max-h-44 overflow-y-auto rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-primary)]">
          {fileNameResults.slice(0, 15).map((item, idx) => {
            const p = item.path || item.file || item.name || '';
            const name = item.name || (p.split('/').pop() || p);
            const isDirectory = item.type === 'directory' || item.type === 'dir' || item.is_dir || p.endsWith('/');
            return (
              <button
                key={`${p}-${idx}`}
                className="block w-full border-b border-[var(--color-border-muted)] px-3 py-1.5 text-left last:border-b-0 hover:bg-[var(--color-bg-hover)]"
                onClick={async () => {
                  const opened = isDirectory ? await openDirectory(p) : await openFile(p);
                  if (opened) setFileNameQuery('');
                }}
                title={p}
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-xs">{isDirectory ? '📁' : '📄'}</span>
                  <span className="truncate text-xs text-[var(--color-text-primary)]">{name}</span>
                </div>
                <div className="truncate text-[11px] text-[var(--color-text-muted)]">{p}</div>
              </button>
            );
          })}
        </div>
      )}

      {/* 内容搜索（原 fsSearchContent） */}
      <div className="mt-3 mb-2 text-[11px] uppercase tracking-wide text-[var(--color-text-muted)]">搜索内容</div>
      <div className="flex gap-2">
        <input
          value={fileSearchQuery}
          onChange={(e) => setFileSearchQuery(e.target.value)}
          placeholder="搜索文件内容..."
          className="input-field"
        />
        <button className="btn-primary" onClick={() => runFileSearch()} disabled={!fileSearchQuery.trim() || fileSearching}>搜索</button>
      </div>
      {fileSearchResults.length > 0 && (
        <div className="mt-3 max-h-52 overflow-y-auto rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-primary)]">
          {fileSearchResults.slice(0, 20).map((item, idx) => (
            <button key={`${item.path}-${idx}`} className="block w-full border-b border-[var(--color-border-muted)] px-3 py-2 text-left last:border-b-0" onClick={() => openFile(item.path)}>
              <div className="truncate text-xs text-[var(--color-accent-blue)]">{item.path}</div>
              <div className="mt-1 text-[11px] text-[var(--color-text-secondary)]">{item.line || item.lineNumber || '-'}: {item.preview || item.text || item.content || ''}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Breadcrumbs() {
  const fileCwd = useStore((s) => s.fileCwd);
  const openDirectory = useStore((s) => s.openDirectory);
  const parts = normalizePathParts(fileCwd);

  return (
    <div className="flex items-center gap-2 overflow-x-auto px-3 py-2 text-xs text-[var(--color-text-secondary)]">
      <button className="btn-ghost" onClick={() => openDirectory('.')}>根目录</button>
      {parts.map((part, index) => {
        const path = parts.slice(0, index + 1).join('/');
        return (
          <React.Fragment key={path}>
            <span className="text-[var(--color-text-muted)]">/</span>
            <button className="btn-ghost" onClick={() => openDirectory(path)}>{part}</button>
          </React.Fragment>
        );
      })}
    </div>
  );
}

function FileTree({ onContextMenu }) {
  const fileEntries = useStore((s) => s.fileEntries);
  const fileLoading = useStore((s) => s.fileLoading);
  const openDirectory = useStore((s) => s.openDirectory);
  const fileCwd = useStore((s) => s.fileCwd);
  const openFile = useStore((s) => s.openFile);
  const selectedFile = useStore((s) => s.selectedFile);

  if (fileLoading) {
    return <div className="p-4 text-sm text-[var(--color-text-muted)]">加载文件中...</div>;
  }
  if (fileEntries.length === 0) {
    return <div className="flex flex-1 items-center justify-center p-4 text-sm text-[var(--color-text-muted)]">当前目录为空</div>;
  }

  return (
    <div className="flex-1 overflow-y-auto p-2">
      <div className="space-y-1">
        {fileEntries.map((entry) => {
          const path = entry.path || joinPath(fileCwd, entry.name);
          const isDirectory = entry.type === 'directory' || entry.is_dir;
          const active = selectedFile === path;
          return (
            <button
              key={path}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition"
              style={{
                background: active ? 'rgba(0,120,212,0.12)' : 'transparent',
                color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
              }}
              onClick={() => (isDirectory ? openDirectory(path) : openFile(path))}
              onContextMenu={(e) => onContextMenu && onContextMenu(e, entry)}
            >
              <EntryIcon type={isDirectory ? 'directory' : 'file'} />
              <span className="truncate">{entry.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function detectLanguage(path = '') {
  const ext = path.split('.').pop()?.toLowerCase();
  const map = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    json: 'json',
    md: 'markdown',
    py: 'python',
    css: 'css',
    html: 'html',
    yml: 'yaml',
    yaml: 'yaml',
    sh: 'shell',
    cjs: 'javascript',
    mjs: 'javascript',
  };
  return map[ext] || 'plaintext';
}

export function EditorPane() {
  const selectedFile = useStore((s) => s.selectedFile);
  const filePreview = useStore((s) => s.filePreview);
  const filePreviewLoading = useStore((s) => s.filePreviewLoading);
  const fileDirty = useStore((s) => s.fileDirty);
  const fileSaving = useStore((s) => s.fileSaving);
  const fileExternalChange = useStore((s) => s.fileExternalChange);
  const settingsTheme = useStore((s) => s.guiSettings?.theme);
  const setFilePreview = useStore((s) => s.setFilePreview);
  const saveSelectedFile = useStore((s) => s.saveSelectedFile);
  const checkSelectedFileForExternalChanges = useStore((s) => s.checkSelectedFileForExternalChanges);
  const reloadExternalFileContent = useStore((s) => s.reloadExternalFileContent);
  const keepCurrentFileContent = useStore((s) => s.keepCurrentFileContent);
  const [saveStatus, setSaveStatus] = useState(null);
  const [systemPrefersLight, setSystemPrefersLight] = useState(() => window.matchMedia('(prefers-color-scheme: light)').matches);

  const language = useMemo(() => detectLanguage(selectedFile || ''), [selectedFile]);
  const resolvedTheme = settingsTheme || document.documentElement.dataset.theme || 'dark';
  const editorTheme = resolvedTheme === 'light' || (resolvedTheme === 'system' && systemPrefersLight) ? 'vs' : 'vs-dark';

  useEffect(() => {
    setSaveStatus(null);
  }, [selectedFile]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const handleChange = (event) => setSystemPrefersLight(event.matches);
    setSystemPrefersLight(media.matches);
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    if (!saveStatus || saveStatus.type === 'error') return undefined;
    const timer = setTimeout(() => setSaveStatus(null), 3000);
    return () => clearTimeout(timer);
  }, [saveStatus]);

  const handleSave = useCallback(async () => {
    const state = useStore.getState();
    const path = state.selectedFile;
    if (!path || !state.fileDirty || state.fileSaving) return;
    setSaveStatus(null);
    const saved = await saveSelectedFile();
    const current = useStore.getState();
    if (current.selectedFile !== path) return;
    if (!saved) {
      setSaveStatus({ type: 'error', message: '保存失败，未保存内容仍保留' });
    } else if (current.fileDirty) {
      setSaveStatus({ type: 'warning', message: '已保存此前内容，仍有新修改未保存' });
    } else {
      setSaveStatus({ type: 'success', message: '已保存' });
    }
  }, [saveSelectedFile]);

  const handleEditorChange = useCallback((value) => {
    setSaveStatus(null);
    setFilePreview(value || '');
  }, [setFilePreview]);

  const saveStatusColor = {
    error: 'var(--color-accent-red)',
    success: '#4ade80',
    warning: '#fbbf24',
  }[saveStatus?.type] || 'var(--color-text-muted)';

  return (
    <div className="flex min-h-0 flex-1 flex-col border-l border-[var(--color-border-default)] bg-[var(--color-bg-primary)]">
      <div className="flex h-12 items-center justify-between border-b border-[var(--color-border-default)] px-4">
        <div className="min-w-0">
          <div className="truncate text-sm text-[var(--color-text-primary)]">
            {selectedFile || '未选择文件'}{fileDirty ? ' •' : ''}
          </div>
          <div className="text-xs" style={{ color: saveStatusColor }}>{saveStatus?.message || language}</div>
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={!selectedFile || !fileDirty || fileSaving}
          className="rounded px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] disabled:cursor-default disabled:opacity-40"
          title="保存文件 (Ctrl+S)"
        >
          {fileSaving ? '保存中...' : '保存'}
        </button>
      </div>
      {fileExternalChange && (
        <div
          className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2 text-xs"
          style={{
            borderColor: 'rgba(245, 158, 11, 0.35)',
            background: 'rgba(245, 158, 11, 0.1)',
            color: '#fbbf24',
          }}
        >
          <span className="min-w-[220px] flex-1 break-words">
            {fileExternalChange.error
              ? `无法读取磁盘上的文件：${fileExternalChange.error}。当前编辑内容已保留。`
              : '磁盘上的文件已被其他程序修改。请选择重新载入，或保留当前编辑内容。'}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            {fileExternalChange.error ? (
              <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => checkSelectedFileForExternalChanges()}>
                重新检查
              </button>
            ) : (
              <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={reloadExternalFileContent}>
                重新载入
              </button>
            )}
            <button type="button" className="btn-primary px-2 py-1 text-xs" onClick={keepCurrentFileContent}>
              保留当前内容
            </button>
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        {selectedFile ? (
          filePreviewLoading ? (
            <div className="p-4 text-sm text-[var(--color-text-muted)]">读取文件中...</div>
          ) : (
            <Editor
              theme={editorTheme}
              language={language}
              value={filePreview}
              onChange={handleEditorChange}
              onMount={(editor, monaco) => {
                editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, handleSave);
              }}
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace",
                wordWrap: 'on',
                automaticLayout: true,
                smoothScrolling: true,
                padding: { top: 12, bottom: 12 },
                scrollBeyondLastLine: false,
              }}
            />
          )
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">从左侧选择文件以预览</div>
        )}
      </div>
    </div>
  );
}

export default function ReplicaWorkspaceView() {
  const initializeWorkspace = useStore((s) => s.initializeWorkspace);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const runtimePort = useStore((s) => s.projectsById[s.activeProjectId]?.runtimePort || null);
  const fileCwd = useStore((s) => s.fileCwd);
  const fileEntries = useStore((s) => s.fileEntries);
  const fileLoading = useStore((s) => s.fileLoading);
  const openDirectory = useStore((s) => s.openDirectory);
  const refreshFileEntries = useStore((s) => s.refreshFileEntries);
  const startWatcher = useStore((s) => s.startWatcher);
  const pollWatcher = useStore((s) => s.pollWatcher);
  const stopWatcher = useStore((s) => s.stopWatcher);
  const checkSelectedFileForExternalChanges = useStore((s) => s.checkSelectedFileForExternalChanges);
  const openFile = useStore((s) => s.openFile);
  const setSelectedFile = useStore((s) => s.setSelectedFile);
  const createFile = useStore((s) => s.fsWrite);
  const createFolder = useStore((s) => s.fsMkdir);
  const moveEntry = useStore((s) => s.fsMove);
  const removeEntry = useStore((s) => s.fsRemove);

  const [newFileName, setNewFileName] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFileInput, setShowNewFileInput] = useState(false);
  const [showNewFolderInput, setShowNewFolderInput] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);
  const [renameEntry, setRenameEntry] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState('');
  const [renameDirtyConfirmOpen, setRenameDirtyConfirmOpen] = useState(false);
  const [pendingDeleteEntry, setPendingDeleteEntry] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [workspaceError, setWorkspaceError] = useState(null);
  const [createBusy, setCreateBusy] = useState(false);
  const workspaceGenerationRef = useRef(0);
  const createInFlightRef = useRef(false);
  const workspaceMutationBusy = createBusy || renameBusy || deleteBusy;

  useEffect(() => {
    if (runtimePort) initializeWorkspace();
  }, [initializeWorkspace, runtimePort]);

  useEffect(() => {
    if (!runtimePort || !fileCwd) return undefined;
    let disposed = false;
    let polling = false;
    let fallbackTicks = 0;
    // M-rc8: guard against double-startWatcher. The eager call below and the
    // pollWorkspace fallback can both fire before watcherId lands in the store
    // (RPC in flight), leaking a native watcher handle. This flag serializes starts.
    let startInFlight = false;
    const safeStartWatcher = async () => {
      if (disposed || startInFlight) return;
      startInFlight = true;
      try {
        await startWatcher(fileCwd);
      } finally {
        startInFlight = false;
      }
    };

    const pollWorkspace = async () => {
      if (disposed || polling) return;
      polling = true;
      try {
        const state = useStore.getState();
        if (state.watcherId) {
          const events = await pollWatcher();
          if (!disposed && events.length > 0) {
            await Promise.all([
              refreshFileEntries({ silent: true }),
              checkSelectedFileForExternalChanges(),
            ]);
          }
        } else {
          fallbackTicks += 1;
          if (fallbackTicks % 4 === 0) await safeStartWatcher();
          if (!disposed && fallbackTicks % 3 === 0) {
            await Promise.all([
              refreshFileEntries({ silent: true }),
              checkSelectedFileForExternalChanges(),
            ]);
          }
        }
      } finally {
        polling = false;
      }
    };

    safeStartWatcher().then(() => {
      if (!disposed) pollWorkspace();
    });
    const timer = setInterval(pollWorkspace, 1800);
    return () => {
      disposed = true;
      clearInterval(timer);
      stopWatcher();
    };
  }, [
    checkSelectedFileForExternalChanges,
    fileCwd,
    pollWatcher,
    refreshFileEntries,
    runtimePort,
    startWatcher,
    stopWatcher,
  ]);

  useEffect(() => {
    workspaceGenerationRef.current += 1;
    createInFlightRef.current = false;
    setContextMenu(null);
    setRenameEntry(null);
    setRenameValue('');
    setRenameError('');
    setRenameDirtyConfirmOpen(false);
    setPendingDeleteEntry(null);
    setDeleteError('');
    setRenameBusy(false);
    setDeleteBusy(false);
    setCreateBusy(false);
    setShowNewFileInput(false);
    setShowNewFolderInput(false);
    setNewFileName('');
    setNewFolderName('');
    setStatusMessage('');
    setWorkspaceError(null);
  }, [activeProjectId, fileCwd]);

  useEffect(() => {
    if (!workspaceError) return;
    const timer = setTimeout(() => setWorkspaceError(null), 8000);
    return () => clearTimeout(timer);
  }, [workspaceError]);

  useEffect(() => {
    if (!statusMessage) return undefined;
    const timer = setTimeout(() => setStatusMessage(''), 4000);
    return () => clearTimeout(timer);
  }, [statusMessage]);

  const handleNewFile = () => {
    if (workspaceMutationBusy || fileLoading) return;
    setShowNewFolderInput(false);
    setShowNewFileInput(!showNewFileInput);
    setNewFileName('');
  };

  const handleNewFolder = () => {
    if (workspaceMutationBusy || fileLoading) return;
    setShowNewFileInput(false);
    setShowNewFolderInput(!showNewFolderInput);
    setNewFolderName('');
  };

  const handleRefresh = async () => {
    setWorkspaceError(null);
    const refreshed = await refreshFileEntries();
    if (!refreshed) setWorkspaceError(useStore.getState().error || '刷新目录失败');
  };

  const validateEntryName = (value) => {
    const name = String(value || '').trim();
    if (!name) return '名称不能为空';
    if (name === '.' || name === '..' || /[\\/]/.test(name)) return '名称不能包含路径分隔符';
    return null;
  };

  const pathForEntry = (entry) => entry?.path || joinPath(fileCwd || '.', entry?.name || '');

  const findNameConflict = (name, sourcePath = null) => fileEntries.find((entry) => {
    const entryPath = pathForEntry(entry);
    if (sourcePath && pathsEqual(entryPath, sourcePath)) return false;
    const normalizedEntryPath = normalizeComparablePath(entryPath);
    const left = String(entry?.name || normalizedEntryPath.split('/').pop() || '');
    const right = String(name || '');
    const windowsDirectory = /^[A-Za-z]:/.test(String(fileCwd || ''));
    return windowsDirectory ? left.toLowerCase() === right.toLowerCase() : left === right;
  }) || null;

  const handleCreateFile = async () => {
    if (createInFlightRef.current) return;
    const name = newFileName.trim();
    const nameError = validateEntryName(name);
    if (nameError) { setWorkspaceError(nameError); return; }
    const conflict = findNameConflict(name);
    if (conflict) { setWorkspaceError(`“${name}”已存在，不会覆盖原文件或目录`); return; }
    const scope = { projectId: activeProjectId, cwd: fileCwd, generation: workspaceGenerationRef.current };
    const isCurrent = () => (
      scope.generation === workspaceGenerationRef.current
      && scope.projectId === useStore.getState().activeProjectId
      && scope.cwd === useStore.getState().fileCwd
    );
    const path = joinPath(scope.cwd || '.', name);
    createInFlightRef.current = true;
    setCreateBusy(true);
    setWorkspaceError(null);
    try {
      const created = await createFile(path, '');
      if (!isCurrent()) return;
      if (!created) { setWorkspaceError(useStore.getState().error || '创建文件失败'); return; }
      setShowNewFileInput(false);
      setNewFileName('');
      setStatusMessage(`已创建 ${name}`);
      const opened = await openFile(path);
      if (isCurrent() && !opened) setWorkspaceError('文件已创建，但无法打开');
    } finally {
      if (isCurrent()) {
        createInFlightRef.current = false;
        setCreateBusy(false);
      }
    }
  };

  const handleCreateFolder = async () => {
    if (createInFlightRef.current) return;
    const name = newFolderName.trim();
    const nameError = validateEntryName(name);
    if (nameError) { setWorkspaceError(nameError); return; }
    const conflict = findNameConflict(name);
    if (conflict) { setWorkspaceError(`“${name}”已存在，不会覆盖原文件或目录`); return; }
    const scope = { projectId: activeProjectId, cwd: fileCwd, generation: workspaceGenerationRef.current };
    const isCurrent = () => (
      scope.generation === workspaceGenerationRef.current
      && scope.projectId === useStore.getState().activeProjectId
      && scope.cwd === useStore.getState().fileCwd
    );
    createInFlightRef.current = true;
    setCreateBusy(true);
    setWorkspaceError(null);
    try {
      const created = await createFolder(joinPath(scope.cwd || '.', name));
      if (!isCurrent()) return;
      if (!created) { setWorkspaceError(useStore.getState().error || '创建目录失败'); return; }
      setShowNewFolderInput(false);
      setNewFolderName('');
      setStatusMessage(`已创建目录 ${name}`);
    } finally {
      if (isCurrent()) {
        createInFlightRef.current = false;
        setCreateBusy(false);
      }
    }
  };

  const startRename = (entry) => {
    setRenameError('');
    setRenameDirtyConfirmOpen(false);
    setRenameEntry(entry);
    setRenameValue(entry?.name || '');
    setContextMenu(null);
  };

  const performRename = async (discardDirty = false) => {
    const nextName = renameValue.trim();
    const nameError = validateEntryName(nextName);
    if (nameError) { setRenameError(nameError); return; }
    const scope = { projectId: activeProjectId, cwd: fileCwd, generation: workspaceGenerationRef.current };
    const isCurrent = () => (
      scope.generation === workspaceGenerationRef.current
      && scope.projectId === useStore.getState().activeProjectId
      && scope.cwd === useStore.getState().fileCwd
    );
    const source = renameEntry?.path || joinPath(scope.cwd || '.', renameEntry?.name || '');
    const destination = joinPath(scope.cwd || '.', nextName);
    if (pathsEqual(source, destination)) { setRenameEntry(null); return; }
    const conflict = findNameConflict(nextName, source);
    if (conflict) { setRenameError(`“${nextName}”已存在，不会覆盖原文件或目录`); return; }

    const state = useStore.getState();
    const selectedFile = state.selectedFile;
    const affectsSelectedFile = pathContains(source, selectedFile);
    if (affectsSelectedFile && state.fileDirty && !discardDirty) {
      setRenameDirtyConfirmOpen(true);
      setRenameError('');
      return;
    }

    setRenameBusy(true);
    setRenameError('');
    try {
      const moved = await moveEntry(source, destination);
      if (!isCurrent()) return;
      if (!moved) throw new Error(useStore.getState().error || '重命名失败');
      if (affectsSelectedFile) {
        const normalizedSource = normalizeComparablePath(source);
        const normalizedSelected = normalizeComparablePath(selectedFile);
        const selectedSuffix = normalizedSelected.slice(normalizedSource.length);
        const nextSelectedFile = `${normalizeComparablePath(destination)}${selectedSuffix}`;
        setSelectedFile(null);
        const reopened = await openFile(nextSelectedFile);
        if (!isCurrent()) return;
        if (!reopened) setWorkspaceError('重命名成功，但无法重新打开原文件');
      }
      setStatusMessage(`已重命名为 ${nextName}`);
      setRenameEntry(null);
      setRenameDirtyConfirmOpen(false);
    } catch (error) {
      if (isCurrent()) setRenameError(error.message || '重命名失败');
    } finally {
      if (isCurrent()) setRenameBusy(false);
    }
  };

  const submitRename = () => performRename(false);

  const requestDelete = (entry) => {
    const path = pathForEntry(entry);
    const state = useStore.getState();
    const affectsSelectedFile = pathContains(path, state.selectedFile);
    setContextMenu(null);
    setPendingDeleteEntry({
      entry,
      path,
      affectsSelectedFile,
      discardsDirtyFile: affectsSelectedFile && state.fileDirty,
    });
    setDeleteError('');
  };

  const closeDeleteDialog = () => {
    if (deleteBusy) return;
    setPendingDeleteEntry(null);
    setDeleteError('');
  };

  const confirmDelete = async () => {
    if (!pendingDeleteEntry?.path || deleteBusy) return;
    const target = pendingDeleteEntry;
    const scope = { projectId: activeProjectId, cwd: fileCwd, generation: workspaceGenerationRef.current };
    const isCurrent = () => (
      scope.generation === workspaceGenerationRef.current
      && scope.projectId === useStore.getState().activeProjectId
      && scope.cwd === useStore.getState().fileCwd
    );
    setDeleteBusy(true);
    setDeleteError('');
    try {
      const removed = await removeEntry(target.path);
      if (!isCurrent()) return;
      if (!removed) throw new Error(useStore.getState().error || '删除失败');
      if (target.affectsSelectedFile) setSelectedFile(null);
      setStatusMessage(`已删除 ${target.entry?.name || target.path}`);
      setPendingDeleteEntry(null);
    } catch (error) {
      if (isCurrent()) setDeleteError(error.message || '删除失败');
    } finally {
      if (isCurrent()) setDeleteBusy(false);
    }
  };

  const handleContextMenu = (e, entry) => {
    e.preventDefault();
    if (workspaceMutationBusy) return;
    setContextMenu({ x: e.clientX, y: e.clientY, entry });
  };

  useEffect(() => {
    const handler = () => setContextMenu(null);
    if (contextMenu) {
      window.addEventListener('click', handler);
      return () => window.removeEventListener('click', handler);
    }
  }, [contextMenu]);

  return (
    <div className="flex min-h-0 flex-1 bg-[var(--color-bg-primary)]">
      <div className="flex min-h-0 w-[clamp(280px,30vw,360px)] shrink-0 flex-col border-r border-[var(--color-border-default)] bg-[var(--color-bg-secondary)]">
        <SearchPanel />
        <div className="flex items-center border-b border-[var(--color-border-default)]">
          <Breadcrumbs />
          <div className="flex items-center gap-0.5 ml-auto pr-2 shrink-0">
            <button
              onClick={handleNewFile}
              disabled={workspaceMutationBusy || fileLoading}
              className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors disabled:cursor-wait disabled:opacity-50"
              title="新建文件"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3 2h7l3 3v9a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" />
                <path d="M10 2v3h3M8 7v4M6 9h4" />
              </svg>
            </button>
            <button
              onClick={handleNewFolder}
              disabled={workspaceMutationBusy || fileLoading}
              className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors disabled:cursor-wait disabled:opacity-50"
              title="新建文件夹"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M1 4a1 1 0 011-1h4l1.5 2H14a1 1 0 011 1v7a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" />
                <path d="M8 9v4M6 11h4" />
              </svg>
            </button>
            <button
              onClick={handleRefresh}
              disabled={fileLoading || workspaceMutationBusy}
              className={`flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors disabled:cursor-wait disabled:opacity-50 ${fileLoading ? 'animate-spin' : ''}`}
              title="刷新"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M1 8a7 7 0 0113.29-4M15 8a7 7 0 01-13.29 4" />
                <path d="M13 1v4h-4M3 15v-4h4" />
              </svg>
            </button>
          </div>
          {statusMessage && (
            <div className="px-3 pb-2">
              <div className="rounded-md bg-[rgba(0,120,212,0.1)] border border-[rgba(0,120,212,0.2)] px-3 py-1.5 text-xs text-[#0078d4]">{statusMessage}</div>
            </div>
          )}
        </div>
        {showNewFileInput && (
          <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[var(--color-border-default)]">
            <input
              type="text"
              value={newFileName}
              disabled={createBusy}
              onChange={e => setNewFileName(e.target.value)}
              placeholder="文件名..."
              onKeyDown={e => { if (e.key === 'Enter' && !createBusy) handleCreateFile(); if (e.key === 'Escape' && !createBusy) setShowNewFileInput(false); }}
              className="flex-1 rounded border border-[var(--color-border-default)] bg-[var(--color-bg-tertiary)] px-2 py-1 text-xs text-[var(--color-text-primary)] outline-none focus:border-[#60a5fa]"
              autoFocus
            />
            <button disabled={createBusy} onClick={handleCreateFile} className="text-xs text-[#4ade80] hover:underline disabled:opacity-50">{createBusy ? '创建中...' : '确定'}</button>
            <button disabled={createBusy} onClick={() => setShowNewFileInput(false)} className="text-xs text-[var(--color-text-muted)] hover:underline disabled:opacity-50">取消</button>
          </div>
        )}
        {showNewFolderInput && (
          <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[var(--color-border-default)]">
            <input
              type="text"
              value={newFolderName}
              disabled={createBusy}
              onChange={e => setNewFolderName(e.target.value)}
              placeholder="文件夹名..."
              onKeyDown={e => { if (e.key === 'Enter' && !createBusy) handleCreateFolder(); if (e.key === 'Escape' && !createBusy) setShowNewFolderInput(false); }}
              className="flex-1 rounded border border-[var(--color-border-default)] bg-[var(--color-bg-tertiary)] px-2 py-1 text-xs text-[var(--color-text-primary)] outline-none focus:border-[#60a5fa]"
              autoFocus
            />
            <button disabled={createBusy} onClick={handleCreateFolder} className="text-xs text-[#4ade80] hover:underline disabled:opacity-50">{createBusy ? '创建中...' : '确定'}</button>
            <button disabled={createBusy} onClick={() => setShowNewFolderInput(false)} className="text-xs text-[var(--color-text-muted)] hover:underline disabled:opacity-50">取消</button>
          </div>
        )}
        {workspaceError && (
          <div className="mx-2 mb-2 p-2 rounded flex items-center justify-between text-xs"
               style={{ background: 'var(--color-error-bg, rgba(248,113,113,0.1))', border: '1px solid var(--color-accent-red)', color: 'var(--color-accent-red)' }}>
            <span>{workspaceError}</span>
            <button className="underline" onClick={() => setWorkspaceError(null)}>关闭</button>
          </div>
        )}
        <FileTree onContextMenu={handleContextMenu} />
        {contextMenu && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setContextMenu(null)} />
            <div
              className="fixed z-50 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] shadow-xl py-1 min-w-[160px]"
              style={{ left: contextMenu.x, top: contextMenu.y }}
            >
              <button className="w-full text-left px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
                onClick={() => {
                  const entry = contextMenu.entry;
                  const path = pathForEntry(entry);
                  if (entry.type === 'directory' || entry.is_dir) openDirectory(path);
                  else openFile(path);
                  setContextMenu(null);
                }}>
                打开
              </button>
              <button className="w-full text-left px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
                onClick={() => startRename(contextMenu.entry)}>
                重命名
              </button>
              <div className="h-px bg-[var(--color-border-muted)] my-1" />
              <button className="w-full text-left px-3 py-1.5 text-xs text-[#f87171] hover:bg-[var(--color-bg-hover)] transition-colors"
                onClick={() => requestDelete(contextMenu.entry)}>
                删除
              </button>
            </div>
          </>
        )}
      </div>
      {renameEntry && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45" role="dialog" aria-modal="true" aria-label="重命名文件或目录">
          <div className="w-80 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-4 shadow-xl">
            <div className="mb-3 text-sm font-medium text-[var(--color-text-primary)]">重命名</div>
            <input
              autoFocus
              value={renameValue}
              disabled={renameBusy}
              onChange={(event) => {
                setRenameValue(event.target.value);
                setRenameError('');
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submitRename();
                if (event.key === 'Escape' && !renameBusy) setRenameEntry(null);
              }}
              className="w-full rounded border border-[var(--color-border-default)] bg-[var(--color-bg-tertiary)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent-blue)]"
            />
            {renameError ? <div className="mt-2 text-xs text-[var(--color-accent-red)]">{renameError}</div> : null}
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn-ghost px-3 py-1.5 text-xs" disabled={renameBusy} onClick={() => setRenameEntry(null)}>取消</button>
              <button className="btn-primary px-3 py-1.5 text-xs" disabled={renameBusy || !renameValue.trim()} onClick={submitRename}>{renameBusy ? '保存中...' : '保存'}</button>
            </div>
          </div>
        </div>
      )}
      <EditorPane />
      <ActionConfirmDialog
        open={renameDirtyConfirmOpen}
        title="重命名并丢失未保存修改？"
        description={renameEntry ? `“${pathForEntry(renameEntry)}”包含当前正在编辑且尚未保存的文件。继续重命名会重新读取新路径，未保存内容将丢失。` : null}
        confirmLabel="继续重命名"
        busy={renameBusy}
        error={renameError}
        onCancel={() => { if (!renameBusy) setRenameDirtyConfirmOpen(false); }}
        onConfirm={() => performRename(true)}
      />
      <ActionConfirmDialog
        open={Boolean(pendingDeleteEntry)}
        title={pendingDeleteEntry?.entry?.type === 'directory' || pendingDeleteEntry?.entry?.is_dir ? '删除目录？' : '删除文件？'}
        description={pendingDeleteEntry ? (
          <><div className="font-medium text-[var(--color-text-primary)]">{pendingDeleteEntry.entry?.name || pendingDeleteEntry.path}</div><div className="mt-1 break-words text-[var(--color-text-muted)]">{pendingDeleteEntry.path}</div>{pendingDeleteEntry.discardsDirtyFile ? <div className="mt-2 text-[var(--color-accent-red)]">其中包含当前未保存的编辑内容，删除后这些内容也会丢失。</div> : null}<div className="mt-2">此操作无法撤销。</div></>
        ) : null}
        confirmLabel={pendingDeleteEntry?.entry?.type === 'directory' || pendingDeleteEntry?.entry?.is_dir ? '删除目录' : '删除文件'}
        busy={deleteBusy}
        error={deleteError}
        onCancel={closeDeleteDialog}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
