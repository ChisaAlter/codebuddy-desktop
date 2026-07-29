/**
 * WebUI 2.124 custom models modal (bundle xQ / custom-models-*).
 * Opened from settings model section — not a separate page route.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useStore } from '../store';
import { deleteCustomModel, listCustomModels, saveCustomModel } from '../lib/ops';
import { resolveLocaleMode, translate } from '../lib/i18n';

const MODEL_ID_PATTERN = /^[a-zA-Z0-9._:-]+$/;
const INPUT_PRESETS = ['128000', '256000', '1000000'];
const OUTPUT_PRESETS = ['16384', '32768', '65536', '128000'];
const TEMP_PRESETS = ['0.3', '0.7'];

const EMPTY_DRAFT = {
  id: '',
  name: '',
  vendor: 'Custom',
  url: '',
  apiKey: '',
  maxInputTokens: '128000',
  maxOutputTokens: '16384',
  temperature: '0.7',
  supportsToolCall: true,
  supportsImages: false,
  supportsReasoning: false,
  useCustomProtocol: false,
};

function useT() {
  const localeMode = useStore((s) => s.guiSettings?.locale || 'system');
  const resolved = resolveLocaleMode(localeMode);
  return useCallback((key, vars) => translate(resolved, key, vars), [resolved]);
}

function formatTokenLabel(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (n >= 1e6 && n % 1e6 === 0) return `${n / 1e6}M`;
  if (n >= 1e3 && n % 1e3 === 0) return `${n / 1e3}k`;
  if (n >= 1024 && n % 1024 === 0) return `${n / 1024}k`;
  return String(n);
}

function draftFromModel(model) {
  return {
    id: model.id || '',
    name: model.name || '',
    vendor: model.vendor || 'Custom',
    url: model.url || '',
    apiKey: model.apiKey || '',
    maxInputTokens: model.maxInputTokens != null ? String(model.maxInputTokens) : '',
    maxOutputTokens: model.maxOutputTokens != null ? String(model.maxOutputTokens) : '',
    temperature: model.temperature != null ? String(model.temperature) : '',
    supportsToolCall: model.supportsToolCall !== false,
    supportsImages: !!model.supportsImages,
    supportsReasoning: !!model.supportsReasoning,
    useCustomProtocol: !!model.useCustomProtocol,
  };
}

function payloadFromDraft(draft) {
  const model = {
    id: draft.id.trim(),
    name: draft.name.trim() || draft.id.trim(),
    vendor: draft.vendor.trim() || 'Custom',
    url: draft.url.trim(),
    supportsToolCall: draft.supportsToolCall,
    supportsImages: draft.supportsImages,
    supportsReasoning: draft.supportsReasoning,
    useCustomProtocol: draft.useCustomProtocol,
  };
  if (draft.apiKey.trim()) model.apiKey = draft.apiKey.trim();
  if (draft.maxInputTokens.trim() !== '' && !Number.isNaN(Number(draft.maxInputTokens))) {
    model.maxInputTokens = Number(draft.maxInputTokens);
  }
  if (draft.maxOutputTokens.trim() !== '' && !Number.isNaN(Number(draft.maxOutputTokens))) {
    model.maxOutputTokens = Number(draft.maxOutputTokens);
  }
  if (draft.temperature.trim() !== '' && !Number.isNaN(Number(draft.temperature))) {
    model.temperature = Number(draft.temperature);
  }
  return model;
}

/**
 * WebUI-style preset select + Custom… number input.
 * Selecting Custom… always reveals the free-form input (even when the current
 * value already matches a preset — previously that stuck on the preset option).
 * Remount via `key` when opening create/edit so customMode re-inits from draft.
 */
function PresetField({ label, value, presets, disabled, step, formatLabel, onChange, customLabel = 'Custom…' }) {
  const [customMode, setCustomMode] = useState(
    () => String(value || '') !== '' && !presets.includes(String(value)),
  );
  const inPresets = !customMode && presets.includes(String(value));
  const selectValue = inPresets ? String(value) : '__custom__';
  const fmt = formatLabel || ((v) => v);

  return (
    <label className="custom-models-field">
      <span>{label}</span>
      <select
        className="custom-models-select"
        value={selectValue}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          if (next === '__custom__') {
            setCustomMode(true);
            // Keep a numeric seed so the input is not blank, but stay in custom mode.
            if (!value || Number.isNaN(Number(value))) onChange(presets[0]);
            return;
          }
          setCustomMode(false);
          onChange(next);
        }}
      >
        {presets.map((preset) => (
          <option key={preset} value={preset}>
            {fmt(preset)}
          </option>
        ))}
        <option value="__custom__">{customLabel}</option>
      </select>
      {!inPresets ? (
        <input
          className="settings-input"
          type="number"
          step={step}
          value={value}
          disabled={disabled}
          onChange={(event) => {
            setCustomMode(true);
            onChange(event.target.value);
          }}
          placeholder={presets[0]}
        />
      ) : null}
    </label>
  );
}

function ConfirmDialog({ title, message, danger, confirmLabel, cancelLabel, onConfirm, onCancel }) {
  const confirmRef = useRef(null);
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center" onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <div className="absolute inset-0 bg-black/30" onClick={onCancel} />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        className="relative bg-[var(--color-bg-card)] border border-[var(--color-border-default)] rounded-xl shadow-2xl w-full max-w-[400px] mx-4 overflow-hidden"
      >
        <div className="px-5 pt-5 pb-4">
          {danger ? (
            <div className="w-10 h-10 rounded-full bg-[color-mix(in_srgb,var(--color-accent-red)_12%,transparent)] flex items-center justify-center mb-3">
              <AlertCircle size={20} className="text-[var(--color-accent-red)]" />
            </div>
          ) : null}
          <h3 id="confirm-title" className="text-[var(--color-text-primary)] text-[15px] font-semibold mb-1">
            {title}
          </h3>
          {message ? (
            <p className="text-[var(--color-text-secondary)] text-[13px] leading-relaxed">{message}</p>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 pb-4">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-1.5 text-[13px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={[
              'px-4 py-1.5 text-[13px] font-medium rounded-lg transition-colors',
              danger
                ? 'bg-[var(--color-accent-red)] text-white hover:opacity-90'
                : 'bg-[var(--color-accent-brand)] text-[var(--color-accent-brand-foreground,#fff)] hover:opacity-90',
            ].join(' ')}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * @param {{ onClose: () => void }} props
 */
export default function CustomModelsModal({ onClose }) {
  const t = useT();
  const apiBase = useStore((s) => s.apiBase || '');
  const [view, setView] = useState('list');
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState(undefined);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Prefer disk (source of truth for Desktop). Merge with runtime list when available
      // so a successful runtime-only create still appears before the next disk reload.
      let diskList = [];
      if (window.electronAPI?.listModelConfigs) {
        try {
          const snap = await window.electronAPI.listModelConfigs();
          diskList = Array.isArray(snap?.models) ? snap.models : [];
        } catch {
          diskList = [];
        }
      }
      let runtimeList = [];
      if (apiBase) {
        try {
          const payload = await listCustomModels(apiBase, true);
          runtimeList = Array.isArray(payload?.models) ? payload.models : Array.isArray(payload) ? payload : [];
        } catch {
          runtimeList = [];
        }
      }
      if (diskList.length) {
        const byId = new Map(diskList.map((m) => [m.id, m]));
        for (const model of runtimeList) {
          if (model?.id && !byId.has(model.id)) byId.set(model.id, model);
        }
        setModels(Array.from(byId.values()));
      } else {
        setModels(runtimeList);
      }
    } catch (err) {
      setError(err?.message || t('settings.customModels.loadFailed'));
      setModels([]);
    } finally {
      setLoading(false);
    }
  }, [apiBase, t]);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      if (deleteTarget) {
        setDeleteTarget(null);
        return;
      }
      if (view === 'form') {
        setView('list');
        setError(null);
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deleteTarget, view, onClose]);

  const openCreate = () => {
    setDraft({ ...EMPTY_DRAFT });
    setEditingId(undefined);
    setError(null);
    setView('form');
  };

  const openEdit = (model) => {
    setDraft(draftFromModel(model));
    setEditingId(model.id);
    setError(null);
    setView('form');
  };

  const backToList = () => {
    setView('list');
    setError(null);
    setEditingId(undefined);
  };

  const setField = (key, value) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const save = async () => {
    const id = draft.id.trim();
    const url = draft.url.trim();
    if (!id) {
      setError(t('settings.customModels.err.idRequired'));
      return;
    }
    if (!MODEL_ID_PATTERN.test(id)) {
      setError(t('settings.customModels.err.idInvalid'));
      return;
    }
    if (!url) {
      setError(t('settings.customModels.err.urlRequired'));
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      setError(t('settings.customModels.err.urlInvalid'));
      return;
    }
    if ((!editingId || editingId !== id) && models.some((m) => m.id === id)) {
      setError(t('settings.customModels.err.idDuplicate'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const model = payloadFromDraft(draft);
      if (editingId && !draft.apiKey.trim()) {
        const prev = models.find((m) => m.id === editingId);
        // Electron list redacts secrets; keep key only when runtime still returned it.
        if (prev?.apiKey) model.apiKey = prev.apiKey;
      }

      // Always persist to models.json first (WebUI + Desktop share this file).
      // Then notify the running CLI so product sync / model_update can refresh pickers.
      let diskSaved = false;
      if (window.electronAPI?.saveModelConfig) {
        const next = await window.electronAPI.saveModelConfig({
          ...draft,
          id,
          name: model.name,
          url,
          // Never write models.json availableModels (CLI hard whitelist would hide built-ins).
          preserveApiKey: true,
          originalId: editingId || undefined,
        });
        setModels(Array.isArray(next?.models) ? next.models : []);
        diskSaved = true;
      }

      if (apiBase) {
        try {
          const result = await saveCustomModel(
            {
              model,
              previousId: editingId && editingId !== id ? editingId : undefined,
              // 不传 visible：保持官方默认 false，自定义模型经 models.json 的 models[]
              // 由 CLI 自动合并进可选列表，不触发 availableModels 白名单写入
              // （见 CODEBUDDY.md「自定义模型与白名单」）。
              global: true,
            },
            apiBase,
          );
          if (Array.isArray(result?.models) && result.models.length) {
            setModels(result.models);
          }
        } catch (runtimeError) {
          // Disk is source of truth when runtime is down or rejects; surface soft error only if no disk write.
          if (!diskSaved) throw runtimeError;
          console.warn('[custom-models] runtime save failed after disk write:', runtimeError?.message || runtimeError);
        }
      } else if (!diskSaved) {
        throw new Error(t('settings.customModels.saveFailed'));
      }
      // refresh from source of truth
      await load();
      setView('list');
      setEditingId(undefined);
    } catch (err) {
      setError(err?.message || t('settings.customModels.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setSaving(true);
    setError(null);
    try {
      let diskDeleted = false;
      if (window.electronAPI?.deleteModelConfig) {
        const next = await window.electronAPI.deleteModelConfig(deleteTarget.id);
        setModels(Array.isArray(next?.models) ? next.models : []);
        diskDeleted = true;
      }
      if (apiBase) {
        try {
          const result = await deleteCustomModel(deleteTarget.id, apiBase, true);
          if (Array.isArray(result?.models)) setModels(result.models);
        } catch (runtimeError) {
          if (!diskDeleted) throw runtimeError;
          console.warn('[custom-models] runtime delete failed after disk delete:', runtimeError?.message || runtimeError);
        }
      } else if (!diskDeleted) {
        throw new Error(t('settings.customModels.deleteFailed'));
      }
      await load();
      setDeleteTarget(null);
    } catch (err) {
      setError(err?.message || t('settings.customModels.deleteFailed'));
      setDeleteTarget(null);
    } finally {
      setSaving(false);
    }
  };

  const titleKey =
    view === 'list'
      ? 'settings.customModels.title'
      : editingId
        ? 'settings.customModels.editTitle'
        : 'settings.customModels.addTitle';

  return (
    <>
      <div className="custom-models-overlay" onClick={onClose}>
        <div
          className="custom-models-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="custom-models-title"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="custom-models-header">
            <h2 id="custom-models-title" className="custom-models-title">
              {t(titleKey)}
            </h2>
            <button
              type="button"
              className="custom-models-icon-btn"
              onClick={onClose}
              title={t('settings.customModels.close')}
              aria-label={t('settings.customModels.close')}
            >
              <X size={16} />
            </button>
          </div>

          {error ? <div className="custom-models-error">{error}</div> : null}

          {view === 'list' ? (
            <div className="custom-models-body">
              <div className="custom-models-toolbar">
                <span className="custom-models-hint">{t('settings.customModels.hint')}</span>
                <button type="button" className="settings-toggle-btn" onClick={openCreate}>
                  <Plus size={14} />
                  <span>{t('settings.customModels.add')}</span>
                </button>
              </div>
              {loading ? (
                <div className="custom-models-empty">{t('settings.loading')}</div>
              ) : models.length === 0 ? (
                <div className="custom-models-empty">{t('settings.customModels.empty')}</div>
              ) : (
                <ul className="custom-models-list">
                  {models.map((model) => (
                    <li key={model.id} className="custom-models-row">
                      <div className="custom-models-row-main">
                        <div className="custom-models-row-name">{model.name || model.id}</div>
                        <div className="custom-models-row-meta">
                          <span className="font-mono">{model.id}</span>
                          {model.vendor ? <span>· {model.vendor}</span> : null}
                        </div>
                        {model.url ? (
                          <div className="custom-models-row-url" title={model.url}>
                            {model.url}
                          </div>
                        ) : null}
                      </div>
                      <div className="custom-models-row-actions">
                        <button
                          type="button"
                          className="custom-models-icon-btn"
                          onClick={() => openEdit(model)}
                          title={t('settings.customModels.edit')}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          type="button"
                          className="custom-models-icon-btn danger"
                          onClick={() => setDeleteTarget(model)}
                          title={t('settings.customModels.delete')}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <div className="custom-models-body custom-models-form">
              <label className="custom-models-field">
                <span>
                  {t('settings.customModels.field.id')} *
                </span>
                <input
                  className="settings-input"
                  value={draft.id}
                  onChange={(e) => setField('id', e.target.value)}
                  placeholder="my-openai-model"
                  disabled={saving}
                />
              </label>
              <label className="custom-models-field">
                <span>{t('settings.customModels.field.name')}</span>
                <input
                  className="settings-input"
                  value={draft.name}
                  onChange={(e) => setField('name', e.target.value)}
                  disabled={saving}
                />
              </label>
              <label className="custom-models-field">
                <span>{t('settings.customModels.field.vendor')}</span>
                <input
                  className="settings-input"
                  value={draft.vendor}
                  onChange={(e) => setField('vendor', e.target.value)}
                  placeholder="OpenAI / Anthropic / Custom"
                  disabled={saving}
                />
              </label>
              <label className="custom-models-field">
                <span>
                  {t('settings.customModels.field.url')} *
                </span>
                <input
                  className="settings-input"
                  value={draft.url}
                  onChange={(e) => setField('url', e.target.value)}
                  placeholder="https://api.example.com/v1/chat/completions"
                  disabled={saving}
                />
              </label>
              <label className="custom-models-field">
                <span>{t('settings.customModels.field.apiKey')}</span>
                <input
                  className="settings-input"
                  type="password"
                  autoComplete="off"
                  value={draft.apiKey}
                  onChange={(e) => setField('apiKey', e.target.value)}
                  placeholder={editingId ? t('settings.customModels.apiKeyKeep') : ''}
                  disabled={saving}
                />
              </label>
              <div className="custom-models-field-row">
                <PresetField
                  key={`maxInput-${editingId || 'new'}-${view}`}
                  label={t('settings.customModels.field.maxInputTokens')}
                  value={draft.maxInputTokens}
                  presets={INPUT_PRESETS}
                  formatLabel={formatTokenLabel}
                  disabled={saving}
                  onChange={(v) => setField('maxInputTokens', v)}
                />
                <PresetField
                  key={`maxOutput-${editingId || 'new'}-${view}`}
                  label={t('settings.customModels.field.maxOutputTokens')}
                  value={draft.maxOutputTokens}
                  presets={OUTPUT_PRESETS}
                  formatLabel={formatTokenLabel}
                  disabled={saving}
                  onChange={(v) => setField('maxOutputTokens', v)}
                />
                <PresetField
                  key={`temp-${editingId || 'new'}-${view}`}
                  label={t('settings.customModels.field.temperature')}
                  value={draft.temperature}
                  presets={TEMP_PRESETS}
                  step="0.1"
                  disabled={saving}
                  onChange={(v) => setField('temperature', v)}
                />
              </div>
              <div className="custom-models-toggles">
                <label className="custom-models-toggle">
                  <span>{t('settings.customModels.field.supportsToolCall')}</span>
                  <button
                    type="button"
                    className={`settings-toggle-switch ${draft.supportsToolCall ? 'on' : ''}`}
                    onClick={() => setField('supportsToolCall', !draft.supportsToolCall)}
                  />
                </label>
                <label className="custom-models-toggle">
                  <span>{t('settings.customModels.field.supportsImages')}</span>
                  <button
                    type="button"
                    className={`settings-toggle-switch ${draft.supportsImages ? 'on' : ''}`}
                    onClick={() => setField('supportsImages', !draft.supportsImages)}
                  />
                </label>
                <label className="custom-models-toggle">
                  <span>{t('settings.customModels.field.supportsReasoning')}</span>
                  <button
                    type="button"
                    className={`settings-toggle-switch ${draft.supportsReasoning ? 'on' : ''}`}
                    onClick={() => setField('supportsReasoning', !draft.supportsReasoning)}
                  />
                </label>
                <label className="custom-models-toggle">
                  <span>{t('settings.customModels.field.useCustomProtocol')}</span>
                  <button
                    type="button"
                    className={`settings-toggle-switch ${draft.useCustomProtocol ? 'on' : ''}`}
                    onClick={() => setField('useCustomProtocol', !draft.useCustomProtocol)}
                  />
                </label>
              </div>
              <div className="custom-models-form-actions">
                <button type="button" className="settings-toggle-btn" onClick={backToList} disabled={saving}>
                  {t('settings.customModels.cancel')}
                </button>
                <button
                  type="button"
                  className="custom-models-primary-btn"
                  onClick={() => {
                    save().catch(() => {});
                  }}
                  disabled={saving}
                >
                  {t(saving ? 'settings.loading' : 'settings.customModels.save')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {deleteTarget ? (
        <ConfirmDialog
          title={t('settings.customModels.deleteTitle')}
          message={t('settings.customModels.deleteMessage', { id: deleteTarget.id }).replace(
            '{id}',
            deleteTarget.id,
          )}
          danger
          confirmLabel={t('settings.customModels.delete')}
          cancelLabel={t('settings.customModels.cancel')}
          onConfirm={() => {
            confirmDelete().catch(() => {});
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      ) : null}
    </>
  );
}
