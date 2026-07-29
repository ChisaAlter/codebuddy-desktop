import React, { useCallback, useEffect, useState } from 'react';
import { Bot, CirclePlus, Eye, EyeOff, FolderOpen, Pencil, RefreshCw, Trash2, X } from 'lucide-react';
import { useStore } from '../store';
import { deleteCustomModel, saveCustomModel } from '../lib/ops';
import ActionConfirmDialog from './ActionConfirmDialog';

const INPUT_PRESETS = [32000, 64000, 128000, 256000];
const OUTPUT_PRESETS = [8000, 16000, 32000, 64000];

const MODEL_ID_PATTERN = /^[a-zA-Z0-9._:-]+$/;
const DEFAULT_MAX_INPUT = '128000';
const DEFAULT_MAX_OUTPUT = '16384';
const DEFAULT_TEMPERATURE = '0.7';

function emptyDraft() {
  return {
    originalId: '',
    id: '',
    name: '',
    vendor: 'Custom',
    url: '',
    apiKey: '',
    maxInputTokens: DEFAULT_MAX_INPUT,
    maxOutputTokens: DEFAULT_MAX_OUTPUT,
    temperature: DEFAULT_TEMPERATURE,
    supportsToolCall: true,
    supportsImages: false,
    supportsReasoning: false,
    useCustomProtocol: false,
    hasApiKey: false,
  };
}

function draftFromModel(model) {
  return {
    ...emptyDraft(),
    originalId: model.id,
    id: model.id,
    name: model.name || model.id,
    vendor: model.vendor || 'Custom',
    url: model.url || '',
    apiKey: model.apiKeyReference || '',
    maxInputTokens: model.maxInputTokens != null ? String(model.maxInputTokens) : '',
    maxOutputTokens: model.maxOutputTokens != null ? String(model.maxOutputTokens) : '',
    temperature: model.temperature != null ? String(model.temperature) : '',
    supportsToolCall: model.supportsToolCall !== false,
    supportsImages: Boolean(model.supportsImages),
    supportsReasoning: Boolean(model.supportsReasoning),
    useCustomProtocol: Boolean(model.useCustomProtocol),
    hasApiKey: Boolean(model.hasApiKey),
  };
}

function formatTokenValue(value) {
  if (!Number.isFinite(value)) return '默认';
  if (value >= 1000000) return `${Math.round(value / 100000) / 10}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

function Field({ label, children }) {
  return (
    <label className="model-form-field">
      <span className="model-form-label">{label}</span>
      {children}
    </label>
  );
}

function CapabilityCheckbox({ checked, disabled = false, label, onChange }) {
  return (
    <label className={`model-capability ${disabled ? 'model-capability-disabled' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function TokenPresetInput({ value, onChange, presets, placeholder }) {
  return (
    <div>
      <input
        className="model-form-input"
        type="number"
        min="1"
        step="1"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="model-token-presets">
        {presets.map((preset) => (
          <button key={preset} type="button" onClick={() => onChange(String(preset))}>
            {formatTokenValue(preset)}
          </button>
        ))}
      </div>
    </div>
  );
}

function ModelEditorDialog({ draft, error, saving, onCancel, onChange, onSave }) {
  const [showApiKey, setShowApiKey] = useState(false);
  const isEditing = Boolean(draft.originalId);

  useEffect(() => {
    setShowApiKey(false);
  }, [draft.originalId]);

  return (
    <div
      className="model-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={isEditing ? '编辑模型' : '添加模型'}
      onMouseDown={(event) => {
        if (!saving && event.target === event.currentTarget) onCancel();
      }}
    >
      <form
        className="model-modal"
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        <div className="model-modal-header">
          <div className="flex min-w-0 items-center gap-3">
            <h2>{isEditing ? '编辑模型' : '添加模型'}</h2>
            <span className="model-modal-badge">仅支持 OpenAI 兼容协议 API</span>
          </div>
          <button
            type="button"
            className="model-icon-button"
            title="关闭"
            aria-label="关闭"
            disabled={saving}
            onClick={onCancel}
          >
            <X size={18} />
          </button>
        </div>

        <div className="model-modal-body">
          <Field label="提供商">
            <input
              className="model-form-input"
              value={draft.vendor}
              placeholder="Custom"
              onChange={(event) => onChange('vendor', event.target.value)}
            />
          </Field>

          <Field label="接口 URL">
            <input
              className="model-form-input"
              autoFocus={!isEditing}
              value={draft.url}
              placeholder="https://api.example.com/v1/chat/completions"
              onChange={(event) => onChange('url', event.target.value)}
            />
          </Field>

          <Field label="API Key">
            <div className="model-secret-input">
              <input
                type={showApiKey ? 'text' : 'password'}
                value={draft.apiKey}
                autoComplete="off"
                spellCheck={false}
                placeholder={isEditing && draft.hasApiKey ? '留空则保留原密钥' : '输入 API Key 或 ${ENV_NAME}'}
                onChange={(event) => onChange('apiKey', event.target.value)}
              />
              <button
                type="button"
                title={showApiKey ? '隐藏 API Key' : '显示 API Key'}
                aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
                onClick={() => setShowApiKey((value) => !value)}
              >
                {showApiKey ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
            {isEditing && draft.hasApiKey && !draft.apiKey ? (
              <span className="model-field-hint">留空则保留原密钥（不会显示在页面中）。</span>
            ) : null}
          </Field>

          <Field label="模型 ID">
            <input
              className="model-form-input"
              value={draft.id}
              placeholder="例如 gpt-4o 或 openai:gpt-4o"
              onChange={(event) => onChange('id', event.target.value)}
            />
          </Field>

          <Field label="显示名称">
            <input
              className="model-form-input"
              value={draft.name}
              placeholder="可选，默认与模型 ID 相同"
              onChange={(event) => onChange('name', event.target.value)}
            />
          </Field>

          <div className="model-advanced-title">高级配置</div>
          <div className="model-capability-grid">
            <CapabilityCheckbox
              checked={draft.supportsToolCall}
              label="支持工具调用"
              onChange={(value) => onChange('supportsToolCall', value)}
            />
            <CapabilityCheckbox
              checked={draft.supportsImages}
              label="支持图片"
              onChange={(value) => onChange('supportsImages', value)}
            />
            <CapabilityCheckbox
              checked={draft.supportsReasoning}
              label="支持推理"
              onChange={(value) => onChange('supportsReasoning', value)}
            />
            <CapabilityCheckbox
              checked={draft.useCustomProtocol}
              label="自定义协议（不自动补 /chat/completions）"
              onChange={(value) => onChange('useCustomProtocol', value)}
            />
          </div>

          <div className="model-token-grid">
            <Field label="最大输入 Tokens">
              <TokenPresetInput
                value={draft.maxInputTokens}
                presets={INPUT_PRESETS}
                placeholder="128000"
                onChange={(value) => onChange('maxInputTokens', value)}
              />
            </Field>
            <Field label="最大输出 Tokens">
              <TokenPresetInput
                value={draft.maxOutputTokens}
                presets={OUTPUT_PRESETS}
                placeholder="16384"
                onChange={(value) => onChange('maxOutputTokens', value)}
              />
            </Field>
          </div>

          <Field label="Temperature">
            <input
              className="model-form-input"
              type="number"
              min="0"
              max="2"
              step="0.1"
              value={draft.temperature}
              placeholder="0.7"
              onChange={(event) => onChange('temperature', event.target.value)}
            />
          </Field>

          {error ? (
            <div className="model-form-error" role="alert">
              {error}
            </div>
          ) : null}
        </div>

        <div className="model-modal-footer">
          <button type="button" className="model-secondary-button" disabled={saving} onClick={onCancel}>
            取消
          </button>
          <button
            type="submit"
            className="model-save-button"
            disabled={saving || !draft.id.trim() || !draft.url.trim()}
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function ReplicaModelsView() {
  const activeProjectId = useStore((state) => state.activeProjectId);
  const restartProjectRuntime = useStore((state) => state.restartProjectRuntime);
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [editorDraft, setEditorDraft] = useState(null);
  const [editorError, setEditorError] = useState('');
  const [saving, setSaving] = useState(false);
  const [deletingModel, setDeletingModel] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState(null);
  const [openingFile, setOpeningFile] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    setLoadError('');
    try {
      if (!window.electronAPI?.listModelConfigs) throw new Error('模型配置接口不可用');
      const next = await window.electronAPI.listModelConfigs();
      setSnapshot(next);
      return next;
    } catch (error) {
      setLoadError(error?.message || '读取模型配置失败');
      return null;
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!notice || notice.type === 'dirty') return undefined;
    const timer = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(timer);
  }, [notice]);

  const openCreate = () => {
    setEditorError('');
    setEditorDraft(emptyDraft());
  };

  const openEdit = (model) => {
    setEditorError('');
    setEditorDraft(draftFromModel(model));
  };

  const updateDraft = (key, value) => {
    setEditorError('');
    setEditorDraft((current) => ({ ...current, [key]: value }));
  };

  const buildRuntimeModelPayload = (draft, id, url) => {
    const model = {
      id,
      name: (draft.name || '').trim() || id,
      vendor: (draft.vendor || '').trim() || 'Custom',
      url,
      supportsToolCall: draft.supportsToolCall !== false,
      supportsImages: Boolean(draft.supportsImages),
      supportsReasoning: Boolean(draft.supportsReasoning),
      useCustomProtocol: Boolean(draft.useCustomProtocol),
    };
    if (draft.apiKey?.trim()) model.apiKey = draft.apiKey.trim();
    if (draft.maxInputTokens !== '' && Number.isFinite(Number(draft.maxInputTokens))) {
      model.maxInputTokens = Number(draft.maxInputTokens);
    }
    if (draft.maxOutputTokens !== '' && Number.isFinite(Number(draft.maxOutputTokens))) {
      model.maxOutputTokens = Number(draft.maxOutputTokens);
    }
    if (draft.temperature !== '' && Number.isFinite(Number(draft.temperature))) {
      model.temperature = Number(draft.temperature);
    }
    return model;
  };

  const save = async () => {
    if (!editorDraft || saving) return;
    const id = editorDraft.id.trim();
    const url = editorDraft.url.trim();
    if (!id) {
      setEditorError('请填写模型 ID');
      return;
    }
    if (!MODEL_ID_PATTERN.test(id)) {
      setEditorError('模型 ID 仅允许字母、数字与 . _ : -');
      return;
    }
    if (!url) {
      setEditorError('请填写接口 URL');
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      setEditorError('URL 需以 http:// 或 https:// 开头');
      return;
    }
    setSaving(true);
    setEditorError('');
    try {
      if (!window.electronAPI?.saveModelConfig) throw new Error('模型保存接口不可用');
      const name = (editorDraft.name || '').trim() || id;
      const previousId = editorDraft.originalId || '';
      const next = await window.electronAPI.saveModelConfig({
        ...editorDraft,
        id,
        name,
        url,
        // Never write models.json availableModels (would hide account/built-in models).
        preserveApiKey: true,
        originalId: previousId || undefined,
      });
      setSnapshot(next);
      setEditorDraft(null);

      // Always notify running CLI after disk write so custom models appear in pickers.
      // Runtime save may omit apiKey on edit (preserve on disk); still pass current fields.
      const apiBase = useStore.getState().apiBase;
      let runtimeSynced = false;
      if (apiBase) {
        try {
          await saveCustomModel(
            {
              model: buildRuntimeModelPayload(editorDraft, id, url),
              previousId: previousId && previousId !== id ? previousId : undefined,
              // 不传 visible：保持官方默认 false，理由同 CustomModelsModal
              // （见 CODEBUDDY.md「自定义模型与白名单」）。
              global: true,
            },
            apiBase,
          );
          runtimeSynced = true;
        } catch (_) {
          runtimeSynced = false;
        }
      }

      setNotice({
        type: runtimeSynced ? 'success' : 'dirty',
        message: runtimeSynced
          ? '模型配置已保存，并已通知当前运行时刷新模型列表。'
          : '模型配置已保存到 models.json。若会话模型列表未更新，请点击下方「重启当前运行时」。',
      });
    } catch (error) {
      setEditorError(error?.message || '保存模型失败');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deletingModel || deleting) return;
    setDeleting(true);
    try {
      if (!window.electronAPI?.deleteModelConfig) throw new Error('模型删除接口不可用');
      const modelId = deletingModel.id;
      const next = await window.electronAPI.deleteModelConfig(modelId);
      setSnapshot(next);
      setDeletingModel(null);

      const apiBase = useStore.getState().apiBase;
      let runtimeSynced = false;
      if (apiBase) {
        try {
          await deleteCustomModel(modelId, apiBase, true);
          runtimeSynced = true;
        } catch (_) {
          runtimeSynced = false;
        }
      }

      setNotice({
        type: 'dirty',
        message: runtimeSynced
          ? `已删除 ${deletingModel.name || modelId}，并已通知当前运行时刷新。`
          : `已删除 ${deletingModel.name || modelId}。模型列表会自动热重载。`,
      });
    } catch (error) {
      setNotice({ type: 'error', message: error?.message || '删除模型失败' });
    } finally {
      setDeleting(false);
    }
  };

  const openConfigFile = async () => {
    if (openingFile) return;
    setOpeningFile(true);
    try {
      if (!window.electronAPI?.openModelConfig) throw new Error('打开配置文件接口不可用');
      await window.electronAPI.openModelConfig();
    } catch (error) {
      setNotice({ type: 'error', message: error?.message || '打开模型配置文件失败' });
    } finally {
      setOpeningFile(false);
    }
  };

  const restartRuntime = async () => {
    if (!activeProjectId || restarting) return;
    setRestarting(true);
    try {
      const restarted = await restartProjectRuntime(activeProjectId);
      if (!restarted) throw new Error(useStore.getState().error || '运行时重启失败');
      await load({ quiet: true });
      setNotice({ type: 'success', message: '当前项目运行时已重启，新模型配置已重新加载。' });
    } catch (error) {
      setNotice({ type: 'error', message: error?.message || '运行时重启失败' });
    } finally {
      setRestarting(false);
    }
  };

  const models = snapshot?.models || [];

  return (
    <div className="page-shell overflow-y-auto">
      <main className="model-page">
        <div className="model-page-heading">
          <div>
            <h1>自定义模型</h1>
            <p>添加 OpenAI 兼容端点，支持增删改；数据保存在本机 ~/.codebuddy/models.json</p>
          </div>
          <button
            type="button"
            className="model-icon-button"
            title="刷新模型配置"
            aria-label="刷新模型配置"
            disabled={loading}
            onClick={() => load()}
          >
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        {loadError ? (
          <div className="model-alert model-alert-error">
            <span>{loadError}</span>
            <button type="button" onClick={() => load()}>
              重试
            </button>
          </div>
        ) : null}
        {notice ? (
          <div
            className={`model-alert ${notice.type === 'error' ? 'model-alert-error' : notice.type === 'success' ? 'model-alert-success' : ''}`}
          >
            <span>{notice.message}</span>
            {notice.type === 'dirty' && activeProjectId ? (
              <button type="button" disabled={restarting} onClick={restartRuntime}>
                {restarting ? '重启中...' : '重启当前运行时'}
              </button>
            ) : null}
          </div>
        ) : null}

        <section className="model-section" aria-labelledby="custom-models-heading">
          <h2 id="custom-models-heading">自定义模型</h2>
          <div className="model-config-strip">
            <div className="min-w-0">
              <div className="model-config-title">本地配置文件</div>
              <div className="model-config-description">
                管理写入到
                <button type="button" className="model-path-button" disabled={openingFile} onClick={openConfigFile}>
                  {snapshot?.displayPath || '%USERPROFILE%\\.codebuddy\\models.json'}
                </button>
                的本地自定义模型配置。
              </div>
            </div>
            <button type="button" className="model-add-button" onClick={openCreate}>
              <CirclePlus size={16} />
              添加模型
            </button>
          </div>
        </section>

        <section className="model-section" aria-labelledby="saved-models-heading">
          <div className="model-section-heading-row">
            <h2 id="saved-models-heading">已保存模型</h2>
            <button
              type="button"
              className="model-open-file-button"
              disabled={openingFile}
              title="在文件管理器中显示配置文件"
              onClick={openConfigFile}
            >
              <FolderOpen size={15} />
              配置文件
            </button>
          </div>

          {loading ? (
            <div className="model-list" aria-label="正在加载模型">
              {[1, 2, 3].map((item) => (
                <div key={item} className="model-row model-row-skeleton" />
              ))}
            </div>
          ) : models.length ? (
            <div className="model-list">
              {models.map((model) => (
                <article className="model-row" key={model.id}>
                  <CirclePlus size={19} className="model-row-leading-icon" />
                  <div className="model-row-content">
                    <div className="model-row-name">{model.name || model.id}</div>
                    <div className="model-row-meta">
                      <span className="font-mono">{model.id}</span>
                      {model.vendor ? <span>· {model.vendor}</span> : null}
                      {model.maxInputTokens ? <span>· {formatTokenValue(model.maxInputTokens)} 输入</span> : null}
                    </div>
                    {model.url ? (
                      <div className="model-row-url" title={model.url}>
                        {model.url}
                      </div>
                    ) : null}
                  </div>
                  <div className="model-row-actions">
                    <button
                      type="button"
                      className="model-icon-button"
                      title={`编辑 ${model.name || model.id}`}
                      aria-label={`编辑 ${model.name || model.id}`}
                      onClick={() => openEdit(model)}
                    >
                      <Pencil size={17} />
                    </button>
                    <button
                      type="button"
                      className="model-icon-button model-delete-button"
                      title={`删除 ${model.name || model.id}`}
                      aria-label={`删除 ${model.name || model.id}`}
                      onClick={() => setDeletingModel(model)}
                    >
                      <Trash2 size={17} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="model-empty-state">
              <Bot size={24} />
              <div>
                <div className="font-medium text-[var(--color-text-primary)]">还没有自定义模型</div>
                <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                  添加后会出现在 CodeBuddy 的模型选择列表中。
                </div>
              </div>
              <button type="button" className="model-add-button" onClick={openCreate}>
                添加模型
              </button>
            </div>
          )}
        </section>
      </main>

      {editorDraft ? (
        <ModelEditorDialog
          draft={editorDraft}
          error={editorError}
          saving={saving}
          onCancel={() => {
            if (!saving) setEditorDraft(null);
          }}
          onChange={updateDraft}
          onSave={save}
        />
      ) : null}

      <ActionConfirmDialog
        open={Boolean(deletingModel)}
        title="删除模型？"
        description={
          deletingModel
            ? `“${deletingModel.name || deletingModel.id}”将从本地 models.json 中移除。此操作会保留自动备份文件。`
            : null
        }
        confirmLabel={deleting ? '删除中...' : '删除模型'}
        busy={deleting}
        danger
        onCancel={() => {
          if (!deleting) setDeletingModel(null);
        }}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
