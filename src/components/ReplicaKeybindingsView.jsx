import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import ActionConfirmDialog from './ActionConfirmDialog';
import {
  fetchKeybindings,
  resetKeybindings,
  saveKeybindings,
  validateKeybindings,
} from '../lib/ops';
import {
  GUI_KEYBINDING_ACTIONS,
  guiShortcutValidationError,
  loadGuiKeybindings,
  normalizeShortcut as normalizeGuiShortcut,
  resetGuiKeybindings,
  saveGuiKeybindings,
  shortcutFromKeyboardEvent,
} from '../lib/gui-keybindings';

export function normalizeCliShortcut(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s*\+\s*/g, '+')
    .replace(/\s+/g, ' ');
}

export function normalizeConfig(value) {
  const config = value && typeof value === 'object' ? value : {};
  return {
    defaults: Array.isArray(config.defaults) ? config.defaults : [],
    user: Array.isArray(config.user) ? config.user : [],
    warnings: Array.isArray(config.warnings) ? config.warnings : [],
    contexts: Array.isArray(config.contexts) ? config.contexts : [],
    actions: Array.isArray(config.actions) ? config.actions : [],
    reserved: Array.isArray(config.reserved) ? config.reserved : [],
    filePath: config.filePath || '',
  };
}

// Map known CLI context names to the localized labels/descriptions used by the
// real WebUI. Falls back to the backend-provided name/description when unknown.
const CONTEXT_LABELS = {
  chat_input: { label: '聊天输入框处于活跃状态时', desc: '聊天输入框获得焦点时' },
  chat: { label: '聊天输入框处于活跃状态时', desc: '聊天输入框获得焦点时' },
  terminal: { label: '终端视图处于活跃状态时', desc: '终端视图处于活跃状态时' },
  settings: { label: '设置面板打开时', desc: '设置面板打开时' },
  help: { label: '帮助页面打开时', desc: '帮助页面打开时' },
  palette: { label: '命令面板打开时', desc: '命令面板打开时' },
  command_palette: { label: '命令面板打开时', desc: '命令面板打开时' },
  plugins: { label: '插件对话框打开时', desc: '插件对话框打开时' },
  plugin_dialog: { label: '插件对话框打开时', desc: '插件对话框打开时' },
  permission: { label: '工具权限对话框显示时', desc: '工具权限对话框显示时' },
  permission_dialog: { label: '工具权限对话框显示时', desc: '工具权限对话框显示时' },
  autocomplete: { label: '自动补全菜单显示时', desc: '自动补全菜单显示时' },
  message_selector: { label: '消息选择器 (rewind) 打开时', desc: '消息选择器 (rewind) 打开时' },
  rewind: { label: '消息选择器 (rewind) 打开时', desc: '消息选择器 (rewind) 打开时' },
};

export function contextLabel(name) {
  const key = String(name || '').toLowerCase().replace(/[-\s]/g, '_');
  return CONTEXT_LABELS[key]?.label || name;
}

export function contextDescription(name, fallback = '') {
  const key = String(name || '').toLowerCase().replace(/[-\s]/g, '_');
  return CONTEXT_LABELS[key]?.desc || fallback || '';
}

export function cloneBindings(groups) {
  return groups.map((group) => ({
    context: group.context,
    bindings: { ...(group.bindings || {}) },
  }));
}

export function removeUserBinding(groups, context, shortcut) {
  return cloneBindings(groups)
    .map((group) => {
      if (group.context !== context) return group;
      const bindings = { ...group.bindings };
      delete bindings[shortcut];
      return { ...group, bindings };
    })
    .filter((group) => Object.keys(group.bindings).length > 0);
}

export function upsertUserBinding(groups, context, shortcut, action) {
  const next = cloneBindings(groups);
  const group = next.find((item) => item.context === context);
  if (group) group.bindings[shortcut] = action;
  else next.push({ context, bindings: { [shortcut]: action } });
  return next;
}

export function buildEffectiveRows(defaultGroups, userGroups) {
  const rows = new Map();
  for (const group of defaultGroups) {
    for (const [shortcut, action] of Object.entries(group.bindings || {})) {
      rows.set(`${group.context}\u0000${shortcut}`, {
        context: group.context,
        shortcut,
        action,
        defaultAction: action,
        custom: false,
      });
    }
  }
  for (const group of userGroups) {
    for (const [shortcut, action] of Object.entries(group.bindings || {})) {
      const key = `${group.context}\u0000${shortcut}`;
      const current = rows.get(key);
      rows.set(key, {
        context: group.context,
        shortcut,
        action,
        defaultAction: current?.defaultAction || null,
        custom: true,
      });
    }
  }
  return [...rows.values()].sort((left, right) => (
    left.context.localeCompare(right.context) || left.shortcut.localeCompare(right.shortcut)
  ));
}

export function warningMessage(warning) {
  if (typeof warning === 'string') return warning;
  return warning?.message || warning?.reason || warning?.key || JSON.stringify(warning);
}

export default function ReplicaKeybindingsView() {
  const activeProjectId = useStore((state) => state.activeProjectId);
  const requestRef = useRef(0);
  const writeInFlightRef = useRef(null);
  const projectGenerationRef = useRef(0);
  const renderedProjectRef = useRef(activeProjectId);
  if (renderedProjectRef.current !== activeProjectId) {
    renderedProjectRef.current = activeProjectId;
    projectGenerationRef.current += 1;
    requestRef.current += 1;
    writeInFlightRef.current = null;
  }
  const [config, setConfig] = useState(() => normalizeConfig(null));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [contextFilter, setContextFilter] = useState('all');
  const [editor, setEditor] = useState(null);
  const [guiBindings, setGuiBindings] = useState(() => loadGuiKeybindings());
  const [guiEditor, setGuiEditor] = useState(null);
  const [guiError, setGuiError] = useState('');
  const [guiNotice, setGuiNotice] = useState('');

  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resetError, setResetError] = useState('');

  const load = useCallback(async ({ silent = false } = {}) => {
    const requestId = ++requestRef.current;
    const projectId = activeProjectId;
    if (!silent) setLoading(true);
    setError('');
    try {
      const next = normalizeConfig(await fetchKeybindings());
      if (requestId !== requestRef.current || useStore.getState().activeProjectId !== projectId) return false;
      setConfig(next);
      return true;
    } catch (loadError) {
      if (requestId === requestRef.current && useStore.getState().activeProjectId === projectId) {
        setError(loadError?.message || '加载快捷键失败');
      }
      return false;
    } finally {
      if (requestId === requestRef.current && useStore.getState().activeProjectId === projectId) setLoading(false);
    }
  }, [activeProjectId]);

  useEffect(() => {
    setConfig(normalizeConfig(null));
    setLoading(true);
    writeInFlightRef.current = null;
    setSaving(false);
    setError('');
    setEditor(null);
    setNotice('');
    setGuiBindings(loadGuiKeybindings());
    setGuiEditor(null);
    setGuiError('');
    setGuiNotice('');
    setResetDialogOpen(false);
    setResetError('');
    load();
  }, [activeProjectId, load]);

  const contextDescriptions = useMemo(
    () => new Map(config.contexts.map((context) => [context.name, context.description])),
    [config.contexts],
  );
  const rows = useMemo(
    () => buildEffectiveRows(config.defaults, config.user),
    [config.defaults, config.user],
  );
  const contextNames = useMemo(() => {
    const names = new Set(config.contexts.map((context) => context.name));
    rows.forEach((row) => names.add(row.context));
    return [...names].sort();
  }, [config.contexts, rows]);
  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (contextFilter !== 'all' && row.context !== contextFilter) return false;
      if (!term) return true;
      return `${row.context} ${row.shortcut} ${row.action}`.toLowerCase().includes(term);
    });
  }, [contextFilter, rows, search]);
  const customCount = rows.filter((row) => row.custom).length;

  const beginWriteOperation = () => {
    if (writeInFlightRef.current) return null;
    const operation = {};
    writeInFlightRef.current = operation;
    return operation;
  };

  const finishWriteOperation = (operation, isCurrent) => {
    if (writeInFlightRef.current !== operation) return;
    writeInFlightRef.current = null;
    if (isCurrent()) setSaving(false);
  };

  const persist = async (bindings, successMessage) => {
    const operation = beginWriteOperation();
    if (!operation) return false;
    const projectId = activeProjectId;
    const generation = projectGenerationRef.current;
    const isCurrent = () => (
      projectId === useStore.getState().activeProjectId && generation === projectGenerationRef.current
    );
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const validation = await validateKeybindings(bindings);
      if (!isCurrent()) return false;
      if (validation?.valid === false) {
        const details = (validation.warnings || []).map(warningMessage).filter(Boolean).join('；');
        throw new Error(details || '快捷键配置未通过校验');
      }
      await saveKeybindings(bindings);
      if (!isCurrent()) return false;
      await load({ silent: true });
      if (!isCurrent()) return false;
      const warningText = (validation?.warnings || []).map(warningMessage).filter(Boolean).join('；');
      setNotice(warningText ? `${successMessage}；${warningText}` : successMessage);
      return true;
    } catch (saveError) {
      if (isCurrent()) setError(saveError?.message || '保存快捷键失败');
      return false;
    } finally {
      finishWriteOperation(operation, isCurrent);
    }
  };

  const openAdd = () => {
    if (writeInFlightRef.current) return;
    setEditor({
      context: contextFilter !== 'all'
        ? contextFilter
        : (contextNames.includes('Global') ? 'Global' : (contextNames[0] || 'Global')),
      shortcut: '',
      action: config.actions[0] || '',
      original: null,
    });
  };

  const openEdit = (row) => {
    if (writeInFlightRef.current) return;
    setEditor({
      context: row.context,
      shortcut: row.shortcut,
      action: row.action,
      original: row.custom ? { context: row.context, shortcut: row.shortcut } : null,
    });
  };

  const submitEditor = async () => {
    if (!editor) return;
    const context = editor.context.trim();
    const shortcut = normalizeCliShortcut(editor.shortcut);
    const action = editor.action.trim();
    if (!context || !shortcut || !action) {
      setError('上下文、快捷键和动作均不能为空');
      return;
    }
    let next = config.user;
    if (editor.original) next = removeUserBinding(next, editor.original.context, editor.original.shortcut);
    next = upsertUserBinding(next, context, shortcut, action);
    if (await persist(next, '快捷键已保存')) setEditor(null);
  };

  const removeOverride = async (row) => {
    if (!row.custom) return;
    const next = removeUserBinding(config.user, row.context, row.shortcut);
    await persist(next, row.defaultAction ? '已恢复该项默认绑定' : '自定义绑定已删除');
  };

  const handleReset = async () => {
    const operation = beginWriteOperation();
    if (!operation) return;
    const projectId = activeProjectId;
    const generation = projectGenerationRef.current;
    const isCurrent = () => (
      projectId === useStore.getState().activeProjectId && generation === projectGenerationRef.current
    );
    setSaving(true);
    setError('');
    setNotice('');
    setResetError('');
    try {
      await resetKeybindings();
      if (!isCurrent()) return;
      await load({ silent: true });
      if (!isCurrent()) return;
      setEditor(null);
      setNotice('已恢复默认快捷键');
      setResetDialogOpen(false);
    } catch (caughtError) {
      if (isCurrent()) setResetError(caughtError?.message || '恢复默认快捷键失败');
    } finally {
      finishWriteOperation(operation, isCurrent);
    }
  };

  const openGuiEditor = (action) => {
    setGuiEditor({ actionId: action.id, shortcut: guiBindings[action.id] || action.defaultShortcut });
    setGuiError('');
    setGuiNotice('');
  };

  const captureGuiShortcut = (event) => {
    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
      setGuiEditor(null);
      setGuiError('');
      return;
    }
    if ((event.key === 'Backspace' || event.key === 'Delete') && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
      setGuiEditor((current) => current ? { ...current, shortcut: '' } : current);
      return;
    }
    const shortcut = shortcutFromKeyboardEvent(event);
    if (shortcut) setGuiEditor((current) => current ? { ...current, shortcut } : current);
  };

  const saveGuiEditor = () => {
    if (!guiEditor) return;
    const shortcut = normalizeGuiShortcut(guiEditor.shortcut);
    const validationError = guiShortcutValidationError(shortcut);
    if (validationError) { setGuiError(validationError); return; }
    const duplicate = GUI_KEYBINDING_ACTIONS.find((action) => (
      action.id !== guiEditor.actionId && guiBindings[action.id] === shortcut
    ));
    if (duplicate) { setGuiError(`已被“${duplicate.label}”使用`); return; }
    try {
      const next = saveGuiKeybindings({ ...guiBindings, [guiEditor.actionId]: shortcut });
      setGuiBindings(next);
      setGuiEditor(null);
      setGuiError('');
      setGuiNotice('GUI 快捷键已生效');
    } catch (caughtError) {
      setGuiError(caughtError?.message || '保存 GUI 快捷键失败');
    }
  };

  const restoreGuiDefaults = () => {
    try {
      const next = resetGuiKeybindings();
      setGuiBindings(next);
      setGuiEditor(null);
      setGuiError('');
      setGuiNotice('已恢复 GUI 默认快捷键');
    } catch (caughtError) {
      setGuiError(caughtError?.message || '恢复 GUI 默认快捷键失败');
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--color-bg-primary)]">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--color-border-default)] px-6">
        <h2 className="text-base font-semibold text-[var(--color-text-primary)]">快捷键</h2>
        <div className="flex items-center gap-2">
          <button className="btn-ghost text-xs" disabled={loading || saving} onClick={() => load()}>
            {loading ? '刷新中...' : '刷新'}
          </button>
          <button className="btn-ghost text-xs text-[var(--color-error)]" disabled={loading || saving || customCount === 0} onClick={() => { if (writeInFlightRef.current) return; setResetDialogOpen(true); setResetError(''); }}>
            恢复 CLI 默认
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-6xl">
          <section className="mb-8">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">CodeBuddy Desktop</h3>
              <button className="btn-ghost text-xs" onClick={restoreGuiDefaults}>恢复 GUI 默认</button>
            </div>
            {guiError ? (
              <div className="mb-3 flex items-center justify-between gap-3 rounded-md border border-[rgba(248,113,113,0.25)] bg-[var(--color-error-bg)] px-3 py-2 text-xs text-[var(--color-error)]">
                <span>{guiError}</span>
                <button className="btn-ghost text-xs" onClick={() => setGuiError('')}>关闭</button>
              </div>
            ) : null}
            {guiNotice ? (
              <div className="mb-3 flex items-center justify-between gap-3 rounded-md border border-[rgba(34,197,94,0.25)] bg-[rgba(34,197,94,0.08)] px-3 py-2 text-xs text-[var(--color-success)]">
                <span>{guiNotice}</span>
                <button className="btn-ghost text-xs" onClick={() => setGuiNotice('')}>关闭</button>
              </div>
            ) : null}
            <div className="overflow-hidden rounded-md border border-[var(--color-border-default)]">
              {GUI_KEYBINDING_ACTIONS.map((action) => (
                <div key={action.id} className="flex items-center gap-4 border-b border-[var(--color-border-muted)] px-4 py-3 text-xs last:border-0">
                  <span className="min-w-0 flex-1 text-[var(--color-text-primary)]">{action.label}</span>
                  <kbd className="rounded border border-[var(--color-border-default)] bg-[var(--color-bg-tertiary)] px-2 py-1 font-mono text-[var(--color-text-primary)]">{guiBindings[action.id]}</kbd>
                  <button className="btn-ghost text-xs" onClick={() => openGuiEditor(action)}>修改</button>
                </div>
              ))}
            </div>
            {guiEditor ? (
              <div className="mt-3 flex flex-wrap items-end gap-3 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-4">
                <label className="min-w-[240px] flex-1 text-xs text-[var(--color-text-secondary)]">
                  <span className="mb-1 block">按下新的快捷键</span>
                  <input
                    autoFocus
                    readOnly
                    className="input-field w-full font-mono"
                    value={guiEditor.shortcut}
                    placeholder="按下组合键"
                    onKeyDown={captureGuiShortcut}
                  />
                </label>
                <button className="btn-primary text-xs" disabled={!guiEditor.shortcut} onClick={saveGuiEditor}>保存</button>
                <button className="btn-ghost text-xs" onClick={() => { setGuiEditor(null); setGuiError(''); }}>取消</button>
              </div>
            ) : null}
          </section>

          <div className="mb-3 border-t border-[var(--color-border-default)] pt-6">
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">CodeBuddy CLI</h3>
          </div>
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-[var(--color-text-muted)]">
              有效绑定 {rows.length} · 用户覆盖 {customCount} · 上下文 {contextNames.length}
            </div>
            <button className="btn-primary text-xs" disabled={loading || saving} onClick={openAdd}>添加绑定</button>
          </div>

          <div className="mb-4 flex flex-wrap items-center gap-3">
            <input
              className="input-field max-w-[320px]"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索快捷键、动作或上下文..."
            />
            <select className="input-field max-w-[220px]" value={contextFilter} onChange={(event) => setContextFilter(event.target.value)}>
              <option value="all">全部上下文</option>
              {contextNames.map((name) => <option key={name} value={name}>{contextLabel(name)}</option>)}
            </select>
          </div>

          {error ? (
            <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-[rgba(248,113,113,0.25)] bg-[var(--color-error-bg)] px-4 py-3 text-sm text-[var(--color-error)]">
              <span>{error}</span>
              <button className="btn-ghost text-xs" onClick={() => setError('')}>关闭</button>
            </div>
          ) : null}
          {notice ? (
            <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-[rgba(34,197,94,0.25)] bg-[rgba(34,197,94,0.08)] px-4 py-3 text-sm text-[var(--color-success)]">
              <span>{notice}</span>
              <button className="btn-ghost text-xs" onClick={() => setNotice('')}>关闭</button>
            </div>
          ) : null}
          {config.warnings.length ? (
            <div className="mb-4 rounded-lg border border-[rgba(245,158,11,0.25)] bg-[rgba(245,158,11,0.08)] px-4 py-3 text-xs text-[var(--color-warning)]">
              {config.warnings.map((warning, index) => <div key={index}>{warningMessage(warning)}</div>)}
            </div>
          ) : null}

          {editor ? (
            <div className="mb-5 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-4">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-[180px_1fr_1.4fr_auto] md:items-end">
                <label className="text-xs text-[var(--color-text-secondary)]">
                  <span className="mb-1 block">上下文</span>
                  <select className="input-field" value={editor.context} onChange={(event) => setEditor((current) => ({ ...current, context: event.target.value }))}>
                    {contextNames.map((name) => <option key={name} value={name}>{contextLabel(name)}</option>)}
                  </select>
                </label>
                <label className="text-xs text-[var(--color-text-secondary)]">
                  <span className="mb-1 block">快捷键</span>
                  <input className="input-field font-mono" value={editor.shortcut} onChange={(event) => setEditor((current) => ({ ...current, shortcut: event.target.value }))} placeholder="ctrl+shift+p" />
                </label>
                <label className="text-xs text-[var(--color-text-secondary)]">
                  <span className="mb-1 block">动作</span>
                  <select className="input-field font-mono" value={editor.action} onChange={(event) => setEditor((current) => ({ ...current, action: event.target.value }))}>
                    {config.actions.map((action) => <option key={action} value={action}>{action}</option>)}
                  </select>
                </label>
                <div className="flex items-center gap-2">
                  <button className="btn-primary text-xs" disabled={saving} onClick={submitEditor}>{saving ? '保存中...' : '保存'}</button>
                  <button className="btn-ghost text-xs" disabled={saving} onClick={() => { if (!writeInFlightRef.current) setEditor(null); }}>取消</button>
                </div>
              </div>
              {(() => {
                const desc = contextDescriptions.get(editor.context) || contextDescription(editor.context);
                return desc ? <div className="mt-2 text-[11px] text-[var(--color-text-muted)]">{desc}</div> : null;
              })()}
            </div>
          ) : null}

          <div className="overflow-hidden rounded-lg border border-[var(--color-border-default)]">
            <div className="overflow-x-auto">
              <table className="min-w-[760px] w-full text-xs">
                <thead className="bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)]">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">上下文</th>
                    <th className="px-4 py-3 text-left font-medium">快捷键</th>
                    <th className="px-4 py-3 text-left font-medium">动作</th>
                    <th className="px-4 py-3 text-left font-medium">来源</th>
                    <th className="px-4 py-3 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    Array.from({ length: 8 }).map((_, index) => (
                      <tr key={index} className="border-t border-[var(--color-border-muted)]">
                        <td className="px-4 py-3"><div className="skeleton h-3 w-20" /></td>
                        <td className="px-4 py-3"><div className="skeleton h-6 w-28" /></td>
                        <td className="px-4 py-3"><div className="skeleton h-3 w-40" /></td>
                        <td className="px-4 py-3"><div className="skeleton h-3 w-12" /></td>
                        <td className="px-4 py-3" />
                      </tr>
                    ))
                  ) : filteredRows.length ? filteredRows.map((row) => (
                    <tr key={`${row.context}-${row.shortcut}`} className="border-t border-[var(--color-border-muted)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">
                      <td className="px-4 py-3" title={contextDescriptions.get(row.context) || contextDescription(row.context)}>{contextLabel(row.context)}</td>
                      <td className="px-4 py-3"><kbd className="rounded border border-[var(--color-border-default)] bg-[var(--color-bg-tertiary)] px-2 py-1 font-mono text-[var(--color-text-primary)]">{row.shortcut}</kbd></td>
                      <td className="px-4 py-3 font-mono text-[var(--color-text-primary)]">{row.action}</td>
                      <td className="px-4 py-3">{row.custom ? <span className="text-[var(--color-accent-blue)]">用户覆盖</span> : '默认'}</td>
                      <td className="px-4 py-3 text-right">
                        <button className="btn-ghost text-xs" disabled={saving} onClick={() => openEdit(row)}>{row.custom ? '修改' : '覆盖'}</button>
                        {row.custom ? <button className="btn-ghost ml-1 text-xs text-[var(--color-error)]" disabled={saving} onClick={() => removeOverride(row)}>{row.defaultAction ? '恢复默认' : '删除'}</button> : null}
                      </td>
                    </tr>
                  )) : (
                    <tr><td colSpan={5} className="px-4 py-14 text-center text-sm text-[var(--color-text-muted)]">暂无匹配快捷键</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {config.reserved.length ? (
            <section className="mt-6">
              <h3 className="mb-3 text-sm font-medium text-[var(--color-text-primary)]">保留按键</h3>
              <div className="overflow-hidden rounded-lg border border-[var(--color-border-default)]">
                {config.reserved.map((item) => (
                  <div key={item.key} className="flex items-center gap-4 border-b border-[var(--color-border-muted)] px-4 py-3 text-xs last:border-0">
                    <kbd className="shrink-0 rounded border border-[var(--color-border-default)] bg-[var(--color-bg-tertiary)] px-2 py-1 font-mono text-[var(--color-text-primary)]">{item.key}</kbd>
                    <span className="min-w-0 flex-1 text-[var(--color-text-secondary)]">{item.reason || '-'}</span>
                    <span className={item.severity === 'error' ? 'text-[var(--color-error)]' : 'text-[var(--color-warning)]'}>{item.severity || 'warning'}</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {config.filePath ? <div className="mt-4 truncate text-[11px] text-[var(--color-text-muted)]" title={config.filePath}>配置文件：{config.filePath}</div> : null}
        </div>
      </div>
      <ActionConfirmDialog
        open={resetDialogOpen}
        title="恢复全部默认快捷键？"
        description={`将删除 ${customCount} 项用户覆盖并恢复 CodeBuddy 默认绑定。此操作完成后仍可重新添加自定义绑定。`}
        confirmLabel="恢复默认"
        busy={saving}
        error={resetError}
        onCancel={() => { if (writeInFlightRef.current) return; setResetDialogOpen(false); setResetError(''); }}
        onConfirm={handleReset}
      />
    </div>
  );
}
