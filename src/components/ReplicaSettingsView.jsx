import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Globe, Languages, Moon, Sun, SunMoon } from 'lucide-react';
import { useStore } from '../store';
import { copyTextToClipboard } from '../lib/clipboard';
import {
  ensureRecommendedCodeBuddyCli,
  getCliMaintenanceInfo,
  installCodeBuddyCli,
  runCliDoctor,
  updateCodeBuddyCli,
} from '../lib/cli-maintenance';
import { getSessionModeLabel } from '../lib/session-mode-labels';
import {
  nextLocaleMode,
  nextThemeMode,
  resolveLocaleMode,
  translate,
} from '../lib/i18n';
import {
  CODEBUDDY_CLI_BOOTSTRAP_COMMAND,
  consumePendingSettingsSection,
} from '../lib/settings-nav';
import ActionConfirmDialog from './ActionConfirmDialog';
import CustomModelsModal from './CustomModelsModal';
import MobileRemoteSettingsCard from './MobileRemoteSettingsCard';

/**
 * WebUI 2.124 lucide SlidersHorizontal uses path geometry (not lucide-react 0.468 line
 * geometry). Inline the bundle paths so manage-icon pixels match WebUI.
 */
function SlidersHorizontalWebUi({ size = 14, className }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className || 'lucide lucide-sliders-horizontal'}
      aria-hidden="true"
    >
      <path d="M10 5H3" />
      <path d="M12 19H3" />
      <path d="M14 3v4" />
      <path d="M16 17v4" />
      <path d="M21 12h-9" />
      <path d="M21 19h-5" />
      <path d="M21 5h-7" />
      <path d="M8 10v4" />
      <path d="M8 12H3" />
    </svg>
  );
}

/** WebUI aN: light→Sun, dark→Moon, system→SunMoon; className text-accent-brand */
function ThemeModeIcon({ mode }) {
  if (mode === 'light') return <Sun size={14} className="text-accent-brand" aria-hidden="true" />;
  if (mode === 'dark') return <Moon size={14} className="text-accent-brand" aria-hidden="true" />;
  return <SunMoon size={14} className="text-accent-brand" aria-hidden="true" />;
}

/** WebUI aN: system→Languages, else Globe; className text-accent-brand */
function LocaleModeIcon({ mode }) {
  if (mode === 'system') return <Languages size={14} className="text-accent-brand" aria-hidden="true" />;
  return <Globe size={14} className="text-accent-brand" aria-hidden="true" />;
}

function useUiLocale() {
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
    return {
      localeMode,
      resolved,
      t: (key, vars) => translate(resolved, key, vars),
    };
  }, [localeMode, systemTick]);
}

/**
 * WebUI TOC order: connection → appearance → model → mode → Mk groups → system.
 * Electron-only sections (desktop prefs / CLI / desktop app) are isolated and appended
 * after the WebUI system group so they never interleave WebUI Mk groups.
 */
function buildSettingsTocSections(t, { isDesktop = true } = {}) {
  const sections = [
    { id: 'settings-section-connection', label: t('sidebar.connectionStatus') },
    { id: 'settings-section-appearance', label: t('settings.appearance') },
    { id: 'settings-section-model', label: t('settings.model') },
    { id: 'settings-section-mode', label: t('settings.mode') },
    { id: 'settings-section-settings-group-modelAndReasoning', label: t('settings.group.modelAndReasoning') },
    { id: 'settings-section-settings-group-behavior', label: t('settings.group.behavior') },
    { id: 'settings-section-settings-group-memory', label: t('settings.group.memory') },
    { id: 'settings-section-settings-group-language', label: t('settings.group.language') },
    { id: 'settings-section-settings-group-advanced', label: t('settings.group.advanced') },
    { id: 'settings-section-settings-group-sandbox', label: t('settings.group.sandbox') },
    { id: 'settings-section-system', label: t('settings.systemInfo') },
  ];
  if (isDesktop) {
    sections.push(
      { id: 'settings-section-desktop', label: t('settings.desktop'), desktopOnly: true },
      { id: 'settings-section-mobile-remote', label: t('settings.mobileRemote'), desktopOnly: true },
      { id: 'settings-section-cli', label: t('settings.cliMaintenance'), desktopOnly: true },
      { id: 'settings-section-desktop-app', label: t('settings.desktopApp'), desktopOnly: true },
      { id: 'settings-section-about', label: t('settings.about'), desktopOnly: true },
    );
  }
  return sections;
}

function isDesktopRuntime() {
  return typeof window !== 'undefined' && Boolean(window.electronAPI);
}

function Toggle({ value, onChange }) {
  // WebUI SQ: className `settings-toggle-switch ${t ? "on" : ""}`
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      className={`settings-toggle-switch ${value ? 'on' : ''}`}
      onClick={() => onChange(!value)}
    />
  );
}

/** WebUI SQ number control: settings-input width 80, debounce 600ms */
function NumberInput({ value, onChange, scopeKey }) {
  const normalized = value == null ? '' : String(value);
  const [draft, setDraft] = useState(normalized);
  const debounceRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setDraft(normalized);
  }, [scopeKey, normalized]);

  const handleChange = (event) => {
    const next = event.target.value;
    setDraft(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      const parsed = Number(next);
      if (!Number.isNaN(parsed) && next.trim() !== '') onChange(parsed);
    }, 600);
  };

  return (
    <input
      type="number"
      className="settings-input"
      style={{ width: 80 }}
      value={draft}
      onChange={handleChange}
    />
  );
}

/** WebUI SQ text control: className settings-input (CSS width 120), debounce 600ms */
function TextInput({
  value,
  onChange,
  placeholder = '未设置',
  width,
  scopeKey,
  inputType = 'text',
  wide = false,
  debounceMs = 0,
}) {
  const normalized = String(value ?? '');
  const [draft, setDraft] = useState(normalized);
  const [saving, setSaving] = useState(false);
  const mountedRef = useRef(true);
  const saveInFlightRef = useRef(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      saveInFlightRef.current = null;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  useEffect(() => {
    saveInFlightRef.current = null;
    setSaving(false);
    setDraft(normalized);
  }, [scopeKey]);

  useEffect(() => {
    if (!saving) setDraft(normalized);
  }, [normalized, saving]);

  const commit = useCallback(
    async (nextValue) => {
      const next = nextValue === undefined ? draft : nextValue;
      if (saveInFlightRef.current || next === normalized) return;
      const operation = {};
      saveInFlightRef.current = operation;
      setSaving(true);
      let saved = false;
      try {
        saved = await onChange(next);
      } catch (_) {
        saved = false;
      } finally {
        if (mountedRef.current && saveInFlightRef.current === operation) {
          saveInFlightRef.current = null;
          setSaving(false);
          if (saved === false) setDraft(normalized);
        }
      }
    },
    [draft, normalized, onChange],
  );

  const handleChange = (event) => {
    const next = event.target.value;
    setDraft(next);
    if (!debounceMs) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      commit(next);
    }, debounceMs);
  };

  // WebUI SQ text = settings-input only (120px). Optional width override for non-Mk fields.
  const className = wide
    ? 'settings-input wide'
    : width
      ? `settings-input ${width}`
      : 'settings-input';
  const style = wide
    ? undefined
    : width === 'w-72'
      ? { width: 288 }
      : width === 'w-56'
        ? { width: 224 }
        : undefined;

  return (
    <input
      type={inputType}
      autoComplete={inputType === 'password' ? 'off' : undefined}
      spellCheck={inputType === 'password' ? false : undefined}
      className={className}
      style={style}
      value={draft}
      placeholder={placeholder}
      disabled={saving}
      onChange={handleChange}
      onBlur={() => {
        if (debounceMs) return;
        commit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !debounceMs) event.currentTarget.blur();
      }}
    />
  );
}

function Select({ value, options, onChange, disabled = false, fullWidth = false }) {
  return (
    <select
      className={fullWidth ? 'settings-select' : 'settings-inline-select'}
      value={value || ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value} title={opt.title || undefined}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

/** WebUI SQ row: label column + `flex items-center shrink-0 ml-3` control */
function SettingRow({ label, desc, control, feedback, t }) {
  const savedLabel = t ? t('settings.saved') : '已保存';
  const failedLabel = t ? t('settings.saveFailed') : '保存失败';
  return (
    <div className="settings-row">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="settings-label">{label}</span>
          {feedback ? (
            <span className={`settings-save-feedback ${feedback === 'success' ? 'success' : 'error'}`}>
              {feedback === 'success' ? savedLabel : failedLabel}
            </span>
          ) : null}
        </div>
        {desc ? <span className="settings-desc">{desc}</span> : null}
      </div>
      <div className="settings-control flex shrink-0 items-center ml-3">{control}</div>
    </div>
  );
}

/** WebUI SQ json control: settings-input wide textarea rows=3, debounce 600ms, no save button */
function JsonObjectEditor({ value, onSave, scopeKey }) {
  const serialized = value != null ? JSON.stringify(value, null, 2) : '';
  const [draft, setDraft] = useState(serialized);
  const debounceRef = useRef(null);
  const mountedRef = useRef(true);
  const saveInFlightRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      saveInFlightRef.current = null;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    saveInFlightRef.current = null;
    setDraft(serialized);
  }, [scopeKey, serialized]);

  const handleChange = (event) => {
    const next = event.target.value;
    setDraft(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      if (saveInFlightRef.current) return;
      try {
        const parsed = JSON.parse(next);
        const operation = {};
        saveInFlightRef.current = operation;
        Promise.resolve(onSave(parsed)).finally(() => {
          if (mountedRef.current && saveInFlightRef.current === operation) {
            saveInFlightRef.current = null;
          }
        });
      } catch {
        /* ignore invalid JSON while typing — WebUI same */
      }
    }, 600);
  };

  return (
    <textarea
      value={draft}
      onChange={handleChange}
      placeholder="{}"
      className="settings-input wide"
      rows={3}
      style={{ width: '100%', resize: 'vertical' }}
      aria-label="环境变量 JSON"
    />
  );
}

function CliVersionInstallDialog({ open, busy, error, currentVersion, onCancel, onSubmit }) {
  const [target, setTarget] = useState('latest');
  const [validationError, setValidationError] = useState('');

  useEffect(() => {
    if (!open) return;
    setTarget('latest');
    setValidationError('');
  }, [open]);

  if (!open) return null;

  const submit = () => {
    const raw = target.trim();
    const normalized = raw.toLowerCase() === 'latest' ? 'latest' : raw.replace(/^v/i, '');
    if (normalized !== 'latest' && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(normalized)) {
      setValidationError('请输入 latest 或完整版本号，例如 2.120.0');
      return;
    }
    setValidationError('');
    onSubmit(normalized);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4" role="dialog" aria-modal="true" aria-label="安装 CodeBuddy CLI 版本" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onCancel(); }}>
      <div className="w-full max-w-md rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-5 shadow-xl">
        <div className="text-sm font-semibold text-[var(--color-text-primary)]">安装 CodeBuddy CLI 版本</div>
        <div className="mt-3 text-xs leading-5 text-[var(--color-text-secondary)]">运行真实的 <span className="font-mono text-[var(--color-text-primary)]">codebuddy install &lt;target&gt;</span>。填写 <span className="font-mono">latest</span> 安装最新版，填写旧版本号可执行回滚。</div>
        <label className="mt-4 block text-xs text-[var(--color-text-secondary)]">安装目标
          <input className="input-field mt-1 w-full font-mono" value={target} disabled={busy} placeholder="latest 或 2.120.0" onChange={(event) => { setTarget(event.target.value); setValidationError(''); }} onKeyDown={(event) => { if (event.key === 'Enter' && !busy) submit(); }} />
        </label>
        <div className="mt-2 text-[11px] text-[var(--color-text-muted)]">当前版本：{currentVersion ? `v${currentVersion}` : '未知'}。安装完成后，已运行的项目进程仍需重启。</div>
        {(validationError || error) ? <div className="mt-3 text-xs text-[var(--color-accent-red)]">{validationError || error}</div> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost px-3 py-1.5 text-xs" disabled={busy} onClick={onCancel}>取消</button>
          <button className="btn-primary px-3 py-1.5 text-xs" disabled={busy || !target.trim()} onClick={submit}>{busy ? '安装中...' : '安装版本'}</button>
        </div>
      </div>
    </div>
  );
}

export default function ReplicaSettingsView() {
  const { localeMode, t } = useUiLocale();
  const {
    info, connectionState, currentModel, models, modes, currentMode,
    settings, guiSettings, infoLoaded, settingsLoaded, sessionId, setModel, setMode, updateSetting: persistSetting, updateGuiSetting: persistGuiSetting, refreshInfo, refreshSettings, restartProjectRuntime,
  } = useStore(useShallow((state) => ({
    info: state.info,
    connectionState: state.connectionState,
    currentModel: state.currentModel,
    models: state.models,
    modes: state.modes,
    currentMode: state.currentMode,
    settings: state.settings,
    guiSettings: state.guiSettings,
    infoLoaded: state.infoLoaded,
    settingsLoaded: state.settingsLoaded,
    sessionId: state.sessionId,
    setModel: state.setModel,
    setMode: state.setMode,
    updateSetting: state.updateSetting,
    updateGuiSetting: state.updateGuiSetting,
    refreshInfo: state.refreshInfo,
    refreshSettings: state.refreshSettings,
    restartProjectRuntime: state.restartProjectRuntime,
  })));
  const [loadError, setLoadError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [appInfo, setAppInfo] = useState(null);
  const [appInfoError, setAppInfoError] = useState('');
  const [systemAction, setSystemAction] = useState(null);
  const [openingUserData, setOpeningUserData] = useState(false);
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false);
  const [checkingForUpdates, setCheckingForUpdates] = useState(false);
  const [openingUpdateDownload, setOpeningUpdateDownload] = useState(false);
  const [updateStatus, setUpdateStatus] = useState(null);
  const [cliInfo, setCliInfo] = useState(null);
  const [cliInfoLoading, setCliInfoLoading] = useState(true);
  const [cliInfoError, setCliInfoError] = useState('');
  const [cliOperation, setCliOperation] = useState('');
  const [cliNotice, setCliNotice] = useState(null);
  const [cliOutput, setCliOutput] = useState(null);
  const [cliUpdateOpen, setCliUpdateOpen] = useState(false);
  const [cliUpdateError, setCliUpdateError] = useState('');
  const [cliInstallOpen, setCliInstallOpen] = useState(false);
  const [cliInstallError, setCliInstallError] = useState('');
  const [cliRestartNeeded, setCliRestartNeeded] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [selectionStatus, setSelectionStatus] = useState(null);
  const [customModelsOpen, setCustomModelsOpen] = useState(false);
  const [rowFeedback, setRowFeedback] = useState({});
  const activeProjectId = useStore((state) => state.activeProjectId);
  const activeThreadId = useStore((state) => state.activeThreadId);
  const reloadRequestIdRef = useRef(0);
  const saveFeedbackVersionRef = useRef(0);
  const rowFeedbackTimersRef = useRef({});
  const mountedRef = useRef(true);
  const cliOperationRef = useRef('');

  const loadCliInfo = useCallback(async ({ showLoading = true } = {}) => {
    if (showLoading) setCliInfoLoading(true);
    setCliInfoError('');
    try {
      const value = await getCliMaintenanceInfo();
      if (!mountedRef.current) return null;
      setCliInfo(value);
      if (value?.compat?.status === 'missing' || value?.compat?.status === 'outdated' || value?.compat?.status === 'unknown') {
        setCliInfoError(value.compat.message || value.error || 'CodeBuddy CLI 版本不可用');
      }
      return value;
    } catch (error) {
      if (mountedRef.current) {
        setCliInfo(null);
        setCliInfoError(error?.message || '读取 CodeBuddy CLI 版本失败');
      }
      return null;
    } finally {
      if (mountedRef.current && showLoading) setCliInfoLoading(false);
    }
  }, []);

  const flashRowFeedback = useCallback((key, status) => {
    if (!key) return;
    setRowFeedback((current) => ({ ...current, [key]: status }));
    if (rowFeedbackTimersRef.current[key]) clearTimeout(rowFeedbackTimersRef.current[key]);
    rowFeedbackTimersRef.current[key] = setTimeout(() => {
      if (!mountedRef.current) return;
      setRowFeedback((current) => {
        if (current[key] !== status) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
      delete rowFeedbackTimersRef.current[key];
    }, 1500);
  }, []);

  const updateSetting = useCallback(async (key, value) => {
    const projectId = activeProjectId;
    const feedbackVersion = ++saveFeedbackVersionRef.current;
    setSaveError('');
    const saved = await persistSetting(key, value);
    if (!mountedRef.current || projectId !== useStore.getState().activeProjectId || feedbackVersion !== saveFeedbackVersionRef.current) {
      return saved;
    }
    if (saved === false) {
      flashRowFeedback(key, 'error');
      setSaveError(useStore.getState().error || `设置“${key}”保存失败，已恢复原值`);
    } else {
      flashRowFeedback(key, 'success');
    }
    return saved;
  }, [activeProjectId, flashRowFeedback, persistSetting]);

  const updateGuiSetting = useCallback(async (key, value) => {
    const feedbackVersion = ++saveFeedbackVersionRef.current;
    setSaveError('');
    const saved = await persistGuiSetting(key, value);
    if (!mountedRef.current || feedbackVersion !== saveFeedbackVersionRef.current) return saved;
    if (saved === false) {
      flashRowFeedback(key, 'error');
      setSaveError(useStore.getState().error || `GUI 设置“${key}”保存失败`);
    } else {
      flashRowFeedback(key, 'success');
    }
    return saved;
  }, [flashRowFeedback, persistGuiSetting]);

  const reload = useCallback(async () => {
    const projectId = activeProjectId;
    // 无项目时不打 serve API，避免 401/网络错误把用户踢回登录，并保持 CLI/桌面段可用。
    if (!projectId) {
      if (mountedRef.current) {
        setLoadError('');
        setRefreshing(false);
      }
      return true;
    }
    const requestId = ++reloadRequestIdRef.current;
    setRefreshing(true);
    setLoadError('');
    try {
      const [infoResult, settingsResult] = await Promise.allSettled([refreshInfo(), refreshSettings()]);
      if (!mountedRef.current || requestId !== reloadRequestIdRef.current || projectId !== useStore.getState().activeProjectId) return false;
      const current = useStore.getState();
      const failures = [];
      if (infoResult.status === 'rejected') failures.push(`系统信息：${infoResult.reason?.message || '加载失败'}`);
      else if (infoResult.value === false && !current.infoLoaded) failures.push('系统信息：请求未完成');
      if (settingsResult.status === 'rejected') failures.push(`设置：${settingsResult.reason?.message || '加载失败'}`);
      else if (settingsResult.value === false && !current.settingsLoaded) failures.push('设置：请求未完成');
      if (failures.length) {
        setLoadError(failures.join('；'));
        return false;
      }
      setLoadError('');
      return true;
    } finally {
      if (mountedRef.current && requestId === reloadRequestIdRef.current && projectId === useStore.getState().activeProjectId) {
        setRefreshing(false);
      }
    }
  }, [activeProjectId, refreshInfo, refreshSettings]);

  // 无项目时不要求 serve 的 info/settings 已加载，否则整页骨架屏会挡住 CLI 安装引导。
  const isLoading = Boolean(activeProjectId) && !loadError && (!infoLoaded || !settingsLoaded);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      reloadRequestIdRef.current += 1;
      saveFeedbackVersionRef.current += 1;
      Object.values(rowFeedbackTimersRef.current).forEach(clearTimeout);
      rowFeedbackTimersRef.current = {};
    };
  }, []);

  useEffect(() => {
    loadCliInfo();
  }, [loadCliInfo]);

  // 用户从终端装完 CLI 切回窗口时自动重探（节流）。仅在 CLI 仍不可用时触发，
  // 避免生成中切回前台时 spawn `codebuddy --version` 抢主进程/渲染线程。
  useEffect(() => {
    if (!isDesktopRuntime()) return undefined;
    let lastFocusProbeAt = 0;
    const onFocus = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (cliOperationRef.current) return;
      const status = cliInfo?.compat?.status;
      const needsProbe = !cliInfo || ['missing', 'outdated', 'unknown'].includes(status);
      if (!needsProbe) return;
      const now = Date.now();
      if (now - lastFocusProbeAt < 2000) return;
      lastFocusProbeAt = now;
      loadCliInfo({ showLoading: false });
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadCliInfo, cliInfo]);

  useEffect(() => {
    reloadRequestIdRef.current += 1;
    saveFeedbackVersionRef.current += 1;
    setLoadError('');
    setSaveError('');
    setSelectionStatus(null);
    reload();
  }, [activeProjectId, reload]);

  useEffect(() => {
    setSelectionStatus(null);
  }, [activeThreadId]);

  useEffect(() => {
    if (selectionStatus?.type !== 'success') return undefined;
    const timer = setTimeout(() => setSelectionStatus(null), 3000);
    return () => clearTimeout(timer);
  }, [selectionStatus]);

  useEffect(() => {
    let active = true;
    setAppInfoError('');
    const request = window.electronAPI?.getAppInfo?.();
    if (!request) {
      setAppInfoError('应用信息接口不可用');
      return () => { active = false; };
    }
    request
      .then((value) => {
        if (!active) return;
        setAppInfo(value);
        setAppInfoError('');
      })
      .catch((error) => {
        if (active) setAppInfoError(error?.message || '加载应用信息失败');
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (systemAction?.type !== 'success') return undefined;
    const timer = setTimeout(() => setSystemAction(null), 3000);
    return () => clearTimeout(timer);
  }, [systemAction]);

  const copySystemPath = async (value, label) => {
    if (!value) return;
    setSystemAction(null);
    try {
      await copyTextToClipboard(value);
      if (mountedRef.current) setSystemAction({ type: 'success', message: `已复制${label}` });
    } catch (error) {
      if (mountedRef.current) setSystemAction({ type: 'error', message: error?.message || `复制${label}失败` });
    }
  };

  const openUserDataDirectory = async () => {
    if (openingUserData) return;
    setOpeningUserData(true);
    setSystemAction(null);
    try {
      if (!window.electronAPI?.openUserData) throw new Error('打开目录接口不可用');
      await window.electronAPI.openUserData();
      if (mountedRef.current) setSystemAction({ type: 'success', message: '已打开用户数据目录' });
    } catch (error) {
      if (mountedRef.current) setSystemAction({ type: 'error', message: error?.message || '打开用户数据目录失败' });
    } finally {
      if (mountedRef.current) setOpeningUserData(false);
    }
  };

  const exportDiagnostics = async () => {
    if (exportingDiagnostics) return;
    setExportingDiagnostics(true);
    setSystemAction(null);
    try {
      if (!window.electronAPI?.exportDiagnostics) throw new Error('诊断报告导出接口不可用');
      const result = await window.electronAPI.exportDiagnostics();
      if (!mountedRef.current || result?.canceled) return;
      setSystemAction({ type: 'success', message: `诊断报告已保存：${result.path}` });
    } catch (error) {
      if (mountedRef.current) setSystemAction({ type: 'error', message: error?.message || '导出诊断报告失败' });
    } finally {
      if (mountedRef.current) setExportingDiagnostics(false);
    }
  };

  const checkForGuiUpdates = async () => {
    if (checkingForUpdates) return;
    setCheckingForUpdates(true);
    setUpdateStatus({ type: 'checking', message: '正在检查 GitHub Releases...' });
    try {
      if (!window.electronAPI?.checkForUpdates) throw new Error('更新检查接口不可用');
      const result = await window.electronAPI.checkForUpdates();
      if (!mountedRef.current) return;
      if (result?.status === 'error') throw new Error(result.error || '更新检查失败');
      if (result?.updateAvailable) {
        setUpdateStatus({
          type: 'update',
          message: result.downloadUrl
            ? `发现新版本 v${result.latestVersion}，当前为 v${result.currentVersion}。`
            : `发现新版本 v${result.latestVersion}，但未找到对应的 Windows 安装包，请打开发布页。`,
          latestVersion: result.latestVersion,
          releaseUrl: result.releaseUrl,
          downloadUrl: result.downloadUrl,
        });
      } else if (result?.latestVersion) {
        setUpdateStatus({
          type: 'current',
          message: `已是最新版本 v${result.currentVersion}。`,
          releaseUrl: result.releaseUrl,
        });
      } else {
        setUpdateStatus({
          type: 'no-release',
          message: `GitHub 暂无正式发布，当前版本 v${result?.currentVersion || appInfo?.version || '-'}。`,
          releaseUrl: result?.releaseUrl,
        });
      }
    } catch (error) {
      if (mountedRef.current) setUpdateStatus({ type: 'error', message: error?.message || '更新检查失败' });
    } finally {
      if (mountedRef.current) setCheckingForUpdates(false);
    }
  };

  const openGuiReleasePage = async () => {
    try {
      if (!window.electronAPI?.openReleasePage) throw new Error('发布页打开接口不可用');
      await window.electronAPI.openReleasePage(updateStatus?.releaseUrl);
    } catch (error) {
      if (mountedRef.current) setUpdateStatus((current) => ({ ...(current || {}), type: current?.type || 'error', message: error?.message || '打开发布页失败' }));
    }
  };

  const openGuiChangelog = async () => {
    try {
      if (!window.electronAPI?.openReleasePage) throw new Error('发布页打开接口不可用');
      // Changelog lives on the releases page; open it directly.
      await window.electronAPI.openReleasePage(
        updateStatus?.releaseUrl || 'https://github.com/ChisaAlter/codebuddy-desktop/releases',
      );
    } catch (error) {
      if (mountedRef.current) setUpdateStatus((current) => ({ ...(current || {}), type: current?.type || 'error', message: error?.message || '打开更新日志失败' }));
    }
  };

  const openAboutLink = async (url) => {
    try {
      if (!window.electronAPI?.openReleasePage) throw new Error('链接打开接口不可用');
      await window.electronAPI.openReleasePage(url);
    } catch (error) {
      if (mountedRef.current) setUpdateStatus((current) => ({ ...(current || {}), type: current?.type || 'error', message: error?.message || '打开链接失败' }));
    }
  };

  const openGuiUpdateDownload = async () => {
    if (openingUpdateDownload) return;
    setOpeningUpdateDownload(true);
    try {
      if (!updateStatus?.downloadUrl) throw new Error('当前发布未提供 Windows 安装包');
      if (!window.electronAPI?.openUpdateDownload) throw new Error('安装包下载接口不可用');
      await window.electronAPI.openUpdateDownload(updateStatus.downloadUrl);
      if (mountedRef.current) {
        setUpdateStatus((current) => ({
          ...(current || {}),
          message: `已在默认浏览器中开始下载 v${current?.latestVersion || ''} 安装包。`,
        }));
      }
    } catch (error) {
      if (mountedRef.current) {
        setUpdateStatus((current) => ({
          ...(current || {}),
          message: error?.message || '下载安装包失败，请打开发布页重试',
        }));
      }
    } finally {
      if (mountedRef.current) setOpeningUpdateDownload(false);
    }
  };

  const runCliDiagnostics = async () => {
    if (cliOperationRef.current) return;
    cliOperationRef.current = 'doctor';
    setCliOperation('doctor');
    setCliNotice({ type: 'busy', message: '正在运行 CodeBuddy CLI 诊断，最长等待 45 秒...' });
    setCliOutput(null);
    try {
      const result = await runCliDoctor();
      if (!mountedRef.current) return;
      setCliOutput({ title: '诊断输出', content: result.output, truncated: result.truncated });
      setCliNotice({ type: 'success', message: 'CodeBuddy CLI 诊断已完成。' });
    } catch (error) {
      if (mountedRef.current) setCliNotice({ type: 'error', message: error?.message || 'CodeBuddy CLI 诊断失败' });
    } finally {
      if (cliOperationRef.current === 'doctor') cliOperationRef.current = '';
      if (mountedRef.current) setCliOperation('');
    }
  };

  const confirmCliUpdate = async () => {
    if (cliOperationRef.current) return;
    cliOperationRef.current = 'update';
    setCliOperation('update');
    setCliUpdateError('');
    setCliNotice({ type: 'busy', message: '正在检查并更新 CodeBuddy CLI，请勿关闭应用...' });
    setCliOutput(null);
    try {
      const result = await updateCodeBuddyCli();
      if (!mountedRef.current) return;
      setCliInfo((current) => ({
        ...(current || {}),
        version: result.afterVersion,
        output: result.afterVersion,
        compat: result.compat || current?.compat,
      }));
      setCliOutput({ title: '更新输出', content: result.output, truncated: result.truncated });
      setCliUpdateOpen(false);
      if (result.changed) {
        setCliRestartNeeded(true);
        setCliNotice({
          type: 'success',
          message: `CodeBuddy CLI 已从 ${result.beforeVersion} 更新到 ${result.afterVersion}。现有项目运行时仍在使用更新前的进程。`,
        });
      } else {
        setCliNotice({ type: 'success', message: `CodeBuddy CLI 已是当前版本 ${result.afterVersion}。` });
      }
      await loadCliInfo({ showLoading: false });
    } catch (error) {
      if (!mountedRef.current) return;
      const message = error?.message || 'CodeBuddy CLI 更新失败';
      setCliUpdateError(message);
      setCliNotice({ type: 'error', message });
      await loadCliInfo({ showLoading: false });
    } finally {
      if (cliOperationRef.current === 'update') cliOperationRef.current = '';
      if (mountedRef.current) setCliOperation('');
    }
  };

  const confirmCliInstall = async (target) => {
    if (cliOperationRef.current) return;
    cliOperationRef.current = 'install';
    setCliOperation('install');
    setCliInstallError('');
    setCliNotice({ type: 'busy', message: `正在安装 CodeBuddy CLI ${target}，请勿关闭应用...` });
    setCliOutput(null);
    try {
      const result = await installCodeBuddyCli(target);
      if (!mountedRef.current) return;
      setCliInfo((current) => ({
        ...(current || {}),
        version: result.afterVersion,
        output: result.afterVersion,
        compat: result.compat || current?.compat,
      }));
      setCliOutput({ title: `安装输出 · ${result.target}`, content: result.output, truncated: result.truncated });
      setCliInstallOpen(false);
      setCliRestartNeeded(true);
      setCliNotice({
        type: 'success',
        message: result.changed
          ? `CodeBuddy CLI 已从 ${result.beforeVersion || '未知'} 切换到 ${result.afterVersion}。现有项目运行时仍在使用安装前的进程。`
          : `CodeBuddy CLI ${result.afterVersion} 安装命令已完成。请重启现有项目运行时以重新加载安装结果。`,
      });
      await loadCliInfo({ showLoading: false });
    } catch (error) {
      if (!mountedRef.current) return;
      const message = error?.message || 'CodeBuddy CLI 版本安装失败';
      setCliInstallError(message);
      setCliNotice({ type: 'error', message });
      await loadCliInfo({ showLoading: false });
    } finally {
      if (cliOperationRef.current === 'install') cliOperationRef.current = '';
      if (mountedRef.current) setCliOperation('');
    }
  };

  const restartCurrentRuntimeAfterCliUpdate = async () => {
    if (cliOperationRef.current) return;
    const projectId = activeProjectId;
    if (!projectId) {
      setCliNotice({ type: 'error', message: '当前没有可重启的项目运行时。' });
      return;
    }
    cliOperationRef.current = 'restart';
    setCliOperation('restart');
    setCliNotice({ type: 'busy', message: '正在重启当前项目运行时...' });
    try {
      const restarted = await restartProjectRuntime(projectId);
      if (!mountedRef.current || projectId !== useStore.getState().activeProjectId) return;
      if (!restarted) throw new Error(useStore.getState().error || '当前项目运行时重启失败');
      setCliRestartNeeded(false);
      setCliNotice({ type: 'success', message: '当前项目运行时已使用新版 CodeBuddy CLI 重新启动。' });
    } catch (error) {
      if (mountedRef.current && projectId === useStore.getState().activeProjectId) {
        setCliNotice({ type: 'error', message: error?.message || '当前项目运行时重启失败' });
      }
    } finally {
      if (cliOperationRef.current === 'restart') cliOperationRef.current = '';
      if (mountedRef.current) setCliOperation('');
    }
  };

  const installRecommendedCli = async () => {
    // 一键修复：missing 走 npm，outdated/unknown 走 codebuddy install（失败再 npm）
    if (cliOperationRef.current) return;
    const target = cliInfo?.compat?.recommendedVersion || '2.138.0';
    cliOperationRef.current = 'install';
    setCliOperation('install');
    setCliInstallError('');
    setCliNotice({ type: 'busy', message: t('cli.installingRecommended', { version: target }) });
    setCliOutput(null);
    try {
      const result = await ensureRecommendedCodeBuddyCli();
      if (!mountedRef.current) return;
      setCliInfo((current) => ({
        ...(current || {}),
        version: result.afterVersion,
        output: result.afterVersion,
        compat: result.compat || current?.compat,
      }));
      setCliOutput({
        title: result.method === 'npm' ? t('cli.installOutputNpm') : t('cli.installOutput'),
        content: result.output,
        truncated: result.truncated,
      });
      if (result.method !== 'noop') setCliRestartNeeded(true);
      setCliNotice({
        type: 'success',
        message: result.changed
          ? t('cli.installSuccessChanged', {
              before: result.beforeVersion || t('cli.unavailable'),
              after: result.afterVersion,
            })
          : t('cli.installSuccessSame', { version: result.afterVersion || target }),
      });
      await loadCliInfo({ showLoading: false });
    } catch (error) {
      if (!mountedRef.current) return;
      const message = error?.message || t('cli.installFailed');
      setCliInstallError(message);
      setCliNotice({ type: 'error', message });
      await loadCliInfo({ showLoading: false });
    } finally {
      if (cliOperationRef.current === 'install') cliOperationRef.current = '';
      if (mountedRef.current) setCliOperation('');
    }
  };

  const cliCompat = cliInfo?.compat || null;
  const cliBlocked = cliCompat && ['missing', 'outdated', 'unknown'].includes(cliCompat.status);
  const cliCompatLabel =
    cliCompat?.status === 'ok'
      ? '兼容'
      : cliCompat?.status === 'newer'
        ? '高于验证版本'
        : cliCompat?.status === 'outdated'
          ? '过低'
          : cliCompat?.status === 'missing'
            ? '未安装'
            : cliCompat?.status === 'unknown'
              ? '无法识别'
              : cliInfoLoading
                ? '检查中'
                : '未知';
  const cliCompatTone =
    cliCompat?.status === 'ok'
      ? 'text-[var(--color-accent-green)]'
      : cliCompat?.status === 'newer'
        ? 'text-[var(--color-accent-yellow)]'
        : 'text-[var(--color-accent-red)]';

  const copyCliOutput = async () => {
    if (!cliOutput?.content) return;
    try {
      await copyTextToClipboard(cliOutput.content);
      if (mountedRef.current) setCliNotice({ type: 'success', message: 'CLI 输出已复制。' });
    } catch (error) {
      if (mountedRef.current) setCliNotice({ type: 'error', message: error?.message || '复制 CLI 输出失败' });
    }
  };

  const modelOptions = (models || []).map((m) => ({
    value: m.id || m.modelId,
    label: m.name || m.id || m.modelId,
  }));
  const currentModelName = useStore((s) => s.models.find(m => m.id === s.currentModel || m.modelId === s.currentModel)?.name || s.currentModel || '');
  // User default model (CLI settings.model): prefer picker from known models, keep free-typed id if missing.
  const defaultModelValue = String(settings?.model || currentModel || '').trim();
  const defaultModelOptions = (() => {
    const seen = new Set();
    const options = [{ value: '', label: t('settings.item.model.unset') || '—' }];
    for (const opt of modelOptions) {
      const value = String(opt.value || '').trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      options.push({ value, label: opt.label || value });
    }
    if (defaultModelValue && !seen.has(defaultModelValue)) {
      options.push({ value: defaultModelValue, label: defaultModelValue });
    }
    return options;
  })();
  const modeOptions = (modes || []).map((m) => ({
    value: m.id || m.modeId,
    label: getSessionModeLabel(m, m.id || m.modeId),
  }));

  const changeSessionSetting = async (kind, value) => {
    if (selectionStatus?.type === 'busy') return;
    const threadId = activeThreadId;
    const label = kind === 'model' ? '模型' : '模式';
    setSelectionStatus({ kind, type: 'busy', message: `正在切换${label}...` });
    const changed = kind === 'model' ? await setModel(value) : await setMode(value);
    if (!mountedRef.current || threadId !== useStore.getState().activeThreadId) return;
    if (changed) {
      setSelectionStatus({ kind, type: 'success', message: `${label}已切换` });
    } else {
      setSelectionStatus({
        kind,
        type: 'error',
        message: useStore.getState().error || `${label}切换失败`,
      });
    }
  };

  const selectionBusy = selectionStatus?.type === 'busy';
  const selectionDisabled = selectionBusy || !sessionId || connectionState !== 'connected';

  const isDesktop = isDesktopRuntime();
  const settingsContentRef = useRef(null);
  const tocSections = useMemo(() => buildSettingsTocSections(t, { isDesktop }), [t, isDesktop]);
  const [activeTocId, setActiveTocId] = useState(() => tocSections[0]?.id || 'settings-section-connection');
  useEffect(() => {
    if (!tocSections.some((section) => section.id === activeTocId) && tocSections[0]) {
      setActiveTocId(tocSections[0].id);
    }
  }, [tocSections, activeTocId]);

  const scrollToSettingsSection = useCallback((sectionId) => {
    const root = settingsContentRef.current;
    const el =
      (root?.querySelector(`#${CSS.escape(sectionId)}`)) ||
      document.getElementById(sectionId);
    if (!el) return;
    setActiveTocId(sectionId);
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // 从空状态 / 聊天恢复区跳转时滚到 CLI 段
  useEffect(() => {
    if (isLoading) return undefined;
    const sectionId = consumePendingSettingsSection();
    if (!sectionId) return undefined;
    const timer = window.setTimeout(() => scrollToSettingsSection(sectionId), 80);
    return () => window.clearTimeout(timer);
  }, [isLoading, scrollToSettingsSection]);

  const copyBootstrapCommand = async () => {
    try {
      await copyTextToClipboard(CODEBUDDY_CLI_BOOTSTRAP_COMMAND);
      if (mountedRef.current) setCliNotice({ type: 'success', message: t('cli.commandCopied') });
    } catch (error) {
      if (mountedRef.current) setCliNotice({ type: 'error', message: error?.message || t('cli.copyCommandFailed') });
    }
  };

  useEffect(() => {
    const root = settingsContentRef.current;
    if (!root || isLoading) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const id = visible?.target?.id;
        if (id) setActiveTocId(id);
      },
      { root, rootMargin: '-12% 0px -70% 0px', threshold: [0, 0.1, 0.25, 0.5, 1] },
    );
    for (const section of tocSections) {
      const el = root.querySelector(`#${CSS.escape(section.id)}`);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [isLoading, tocSections]);

  return (
    <div className="settings-view page-shell">
      <div className="settings-content" ref={settingsContentRef}>
        <nav className="settings-toc" aria-label="Settings sections">
          <div className="settings-toc-inner">
            {tocSections.map((section) => (
              <button
                key={section.id}
                type="button"
                className={`settings-toc-item${activeTocId === section.id ? ' active' : ''}`}
                onClick={() => scrollToSettingsSection(section.id)}
              >
                {section.label}
              </button>
            ))}
          </div>
        </nav>
        <div className="settings-sections">
        {/* WebUI 2.124: settings-sections starts at connection group — no page title/subtitle block */}

        {loadError ? (
          <div className="flex items-center justify-between rounded-xl border border-[rgba(239,68,68,0.35)] bg-[rgba(239,68,68,0.08)] px-4 py-3 text-sm text-[var(--color-accent-red)]">
            <span>{loadError}</span>
            <button className="btn-ghost px-3 py-1 text-xs" disabled={refreshing} onClick={reload}>{refreshing ? '...' : '↻'}</button>
          </div>
        ) : null}

        {saveError ? (
          <div className="flex items-center justify-between rounded-xl border border-[rgba(239,68,68,0.35)] bg-[rgba(239,68,68,0.08)] px-4 py-3 text-sm text-[var(--color-accent-red)]">
            <span>{saveError}</span>
            <button className="btn-ghost px-3 py-1 text-xs" onClick={() => setSaveError('')}>×</button>
          </div>
        ) : null}
        {!activeProjectId ? (
          <div className="rounded-xl border border-[rgba(96,165,250,0.35)] bg-[rgba(96,165,250,0.08)] px-4 py-3 text-sm text-[var(--color-text-secondary)]">
            {t('settings.projectRequired')}
          </div>
        ) : null}
        {isLoading ? (
          <>
            {[1, 2, 3].map((n) => (
              <div key={n} className="settings-card px-4 py-4">
                <div className="skeleton animate-pulse h-5 w-1/3 rounded mb-4" style={{background:'var(--color-bg-hover)'}} />
                <div className="skeleton animate-pulse h-4 w-full rounded mb-2" style={{background:'var(--color-bg-hover)'}} />
                <div className="skeleton animate-pulse h-4 w-5/6 rounded mb-2" style={{background:'var(--color-bg-hover)'}} />
                <div className="skeleton animate-pulse h-4 w-4/6 rounded mb-2" style={{background:'var(--color-bg-hover)'}} />
                <div className="skeleton animate-pulse h-4 w-3/6 rounded" style={{background:'var(--color-bg-hover)'}} />
              </div>
            ))}
          </>
        ) : (
          <>

        {/* 连接状态 */}
        <div id="settings-section-connection" className="settings-group">
          <h2 className="settings-group-title">{t('sidebar.connectionStatus')}</h2>
          <div className="settings-card">
            <SettingRow t={t} label={t('sidebar.status')} control={
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${connectionState === 'connected' ? 'bg-[var(--color-accent-green)]' : connectionState === 'error' ? 'bg-[var(--color-accent-red)]' : 'bg-[var(--color-accent-yellow)] animate-pulse'}`} />
                <span className="settings-value">
                  {connectionState === 'connected'
                    ? t('connection.connected')
                    : connectionState === 'error'
                      ? t('connection.error')
                      : connectionState === 'disconnected'
                        ? t('connection.disconnected')
                        : t('connection.connecting')}
                </span>
              </div>
            } />
            <SettingRow
              t={t}
              label={t('sidebar.sessionId')}
              control={
                <span className="settings-value font-mono text-[12px]">
                  {sessionId ? `${sessionId.slice(0, 12)}...` : t('sidebar.notConnected')}
                </span>
              }
            />
          </div>
        </div>

        {/* 外观 — WebUI aN exact: settings-row > settings-label + settings-toggle-btn */}
        <div id="settings-section-appearance" className="settings-group">
          <h2 className="settings-group-title">{t('settings.appearance')}</h2>
          <div className="settings-card">
            <div className="settings-row">
              <span className="settings-label">{t('sidebar.theme')}</span>
              <button
                type="button"
                className="settings-toggle-btn"
                onClick={() => updateGuiSetting('theme', nextThemeMode(guiSettings?.theme || 'dark'))}
              >
                <ThemeModeIcon mode={guiSettings?.theme || 'dark'} />
                <span>
                  {t(
                    (guiSettings?.theme || 'dark') === 'light'
                      ? 'theme.light'
                      : (guiSettings?.theme || 'dark') === 'dark'
                        ? 'theme.dark'
                        : 'theme.system',
                  )}
                </span>
              </button>
            </div>
            <div className="settings-row">
              <span className="settings-label">{t('sidebar.language')}</span>
              <button
                type="button"
                className="settings-toggle-btn"
                onClick={() => updateGuiSetting('locale', nextLocaleMode(localeMode))}
              >
                <LocaleModeIcon mode={localeMode} />
                <span>
                  {t(
                    localeMode === 'zh'
                      ? 'locale.zh'
                      : localeMode === 'en'
                        ? 'locale.en'
                        : 'locale.system',
                  )}
                </span>
              </button>
            </div>
          </div>
        </div>

        {/* 模型选择 — WebUI: full-width select in settings-row-stack + 自定义模型入口 */}
        <div id="settings-section-model" className="settings-group">
          <h2 className="settings-group-title">{t('settings.model')}</h2>
          <div className="settings-card">
            {modelOptions.length > 0 ? (
              <div className="settings-row settings-row-stack">
                <Select
                  value={currentModel}
                  options={modelOptions}
                  disabled={selectionDisabled}
                  fullWidth
                  onChange={(value) => changeSessionSetting('model', value)}
                />
                {selectionStatus && selectionStatus.kind !== 'mode' ? (
                  <div className={`text-xs ${
                    selectionStatus.type === 'error' ? 'text-[var(--color-accent-red)]' :
                    selectionStatus.type === 'success' ? 'text-[var(--color-accent-green)]' :
                    'text-[var(--color-text-muted)]'
                  }`}>{selectionStatus.message}</div>
                ) : null}
              </div>
            ) : (
              <div className="settings-row">
                <span className="settings-value">{t('sidebar.noModels')}</span>
              </div>
            )}
            <SettingRow
              t={t}
              label={t('settings.customModels.entryLabel')}
              desc={t('settings.customModels.entryDesc')}
              control={
                <button
                  type="button"
                  className="settings-toggle-btn"
                  onClick={() => setCustomModelsOpen(true)}
                >
                  {/* WebUI 2.124: gM = SlidersHorizontal path geometry size 14 + text-accent-brand */}
                  <SlidersHorizontalWebUi size={14} className="lucide lucide-sliders-horizontal text-accent-brand" />
                  <span>{t('settings.customModels.manage')}</span>
                </button>
              }
            />
          </div>
        </div>
        {customModelsOpen ? (
          <CustomModelsModal onClose={() => setCustomModelsOpen(false)} />
        ) : null}

        {/* 权限模式 — WebUI full-width select only */}
        <div id="settings-section-mode" className="settings-group">
          <h2 className="settings-group-title">{t('settings.mode')}</h2>
          <div className="settings-card">
            {modeOptions.length > 0 ? (
              <div className="settings-row settings-row-stack">
                <Select
                  value={currentMode}
                  options={modeOptions}
                  disabled={selectionDisabled}
                  fullWidth
                  onChange={(value) => changeSessionSetting('mode', value)}
                />
                {selectionStatus && selectionStatus.kind === 'mode' ? (
                  <div className={`text-xs ${
                    selectionStatus.type === 'error' ? 'text-[var(--color-accent-red)]' :
                    selectionStatus.type === 'success' ? 'text-[var(--color-accent-green)]' :
                    'text-[var(--color-text-muted)]'
                  }`}>{selectionStatus.message}</div>
                ) : null}
              </div>
            ) : (
              <div className="settings-row">
                <span className="settings-value">{t('sidebar.noModes')}</span>
              </div>
            )}
          </div>
        </div>

        {/* 模型与推理 — WebUI Mk titleKey settings.group.modelAndReasoning */}
        <div id="settings-section-settings-group-modelAndReasoning" className="settings-group">
          <h2 className="settings-group-title">{t('settings.group.modelAndReasoning')}</h2>
          <div className="settings-card">
            <SettingRow
              t={t}
              label={t('settings.item.model')}
              desc={t('settings.item.model.desc')}
              feedback={rowFeedback.model}
              control={
                modelOptions.length > 0 || defaultModelValue ? (
                  <Select
                    value={defaultModelValue}
                    options={defaultModelOptions}
                    onChange={(value) => updateSetting('model', value || undefined)}
                  />
                ) : (
                  <TextInput
                    scopeKey={activeProjectId}
                    value={settings?.model || currentModelName || currentModel || ''}
                    debounceMs={600}
                    onChange={(v) => updateSetting('model', v)}
                  />
                )
              }
            />
            <SettingRow
              t={t}
              label={t('settings.item.reasoningEffort')}
              desc={t('settings.item.reasoningEffort.desc')}
              feedback={rowFeedback.reasoningEffort}
              control={
                <Select
                  value={settings?.reasoningEffort || ''}
                  options={[
                    { value: '', label: '-' },
                    { value: 'minimal', label: t('settings.effort.minimal') },
                    { value: 'low', label: t('settings.effort.low') },
                    { value: 'medium', label: t('settings.effort.medium') },
                    { value: 'high', label: t('settings.effort.high') },
                    { value: 'xhigh', label: t('settings.effort.xhigh') },
                    { value: 'max', label: t('settings.effort.max') },
                  ]}
                  onChange={(value) => updateSetting('reasoningEffort', value || undefined)}
                />
              }
            />
            <SettingRow
              t={t}
              label={t('settings.item.alwaysThinkingEnabled')}
              feedback={rowFeedback.alwaysThinkingEnabled}
              control={<Toggle value={!!settings?.alwaysThinkingEnabled} onChange={(v) => updateSetting('alwaysThinkingEnabled', v)} />}
            />
          </div>
        </div>

        {/* 行为 — WebUI Mk exact keys/order */}
        <div id="settings-section-settings-group-behavior" className="settings-group">
          <h2 className="settings-group-title">{t('settings.group.behavior')}</h2>
          <div className="settings-card">
            <SettingRow t={t} label={t('settings.item.autoCompactEnabled')} feedback={rowFeedback.autoCompactEnabled} control={<Toggle value={!!settings?.autoCompactEnabled} onChange={(v) => updateSetting('autoCompactEnabled', v)} />} />
            <SettingRow t={t} label={t('settings.item.includeCoAuthoredBy')} feedback={rowFeedback.includeCoAuthoredBy} control={<Toggle value={!!settings?.includeCoAuthoredBy} onChange={(v) => updateSetting('includeCoAuthoredBy', v)} />} />
            <SettingRow t={t} label={t('settings.item.fileCheckpointingEnabled')} desc={t('settings.item.fileCheckpointingEnabled.desc')} feedback={rowFeedback.fileCheckpointingEnabled} control={<Toggle value={!!settings?.fileCheckpointingEnabled} onChange={(v) => updateSetting('fileCheckpointingEnabled', v)} />} />
            <SettingRow
              t={t}
              label={t('settings.item.promptSuggestionEnabled')}
              feedback={rowFeedback.promptSuggestionEnabled}
              control={
                <Toggle
                  value={!!(settings?.promptSuggestionEnabled || guiSettings?.promptSuggestionEnabled)}
                  onChange={async (v) => {
                    await updateGuiSetting('promptSuggestionEnabled', v);
                    return updateSetting('promptSuggestionEnabled', v);
                  }}
                />
              }
            />
            <SettingRow t={t} label={t('settings.item.ignoreGitIgnore')} desc={t('settings.item.ignoreGitIgnore.desc')} feedback={rowFeedback.ignoreGitIgnore} control={<Toggle value={!!(settings?.ignoreGitIgnore ?? settings?.ignoreGitignore)} onChange={(v) => updateSetting('ignoreGitIgnore', v)} />} />
            <SettingRow t={t} label={t('settings.item.deferToolLoading')} feedback={rowFeedback.deferToolLoading} control={<Toggle value={!!(settings?.deferToolLoading ?? settings?.lazyLoadTools)} onChange={(v) => updateSetting('deferToolLoading', v)} />} />
            <SettingRow t={t} label={t('settings.item.hookOutputCollapsed')} feedback={rowFeedback.hookOutputCollapsed} control={<Toggle value={!!settings?.hookOutputCollapsed} onChange={(v) => updateSetting('hookOutputCollapsed', v)} />} />
          </div>
        </div>

        {/* 记忆 — WebUI Mk */}
        <div id="settings-section-settings-group-memory" className="settings-group">
          <h2 className="settings-group-title">{t('settings.group.memory')}</h2>
          <div className="settings-card">
            <SettingRow t={t} label={t('settings.item.memory.enabled')} feedback={rowFeedback['memory.enabled']} control={<Toggle value={!!settings?.memory?.enabled} onChange={(v) => updateSetting('memory.enabled', v)} />} />
            <SettingRow t={t} label={t('settings.item.memory.autoMemoryEnabled')} desc={t('settings.item.memory.autoMemoryEnabled.desc')} feedback={rowFeedback['memory.autoMemoryEnabled']} control={<Toggle value={!!settings?.memory?.autoMemoryEnabled} onChange={(v) => updateSetting('memory.autoMemoryEnabled', v)} />} />
          </div>
        </div>

        {/* 语言 — WebUI Mk: language only */}
        <div id="settings-section-settings-group-language" className="settings-group">
          <h2 className="settings-group-title">{t('settings.group.language')}</h2>
          <div className="settings-card">
            <SettingRow
              t={t}
              label={t('settings.item.language')}
              desc={t('settings.item.language.desc')}
              feedback={rowFeedback.language}
              control={
                <TextInput
                  scopeKey={activeProjectId}
                  value={settings?.language || ''}
                  placeholder={t('settings.notSet')}
                  debounceMs={600}
                  onChange={(value) => updateSetting('language', value)}
                />
              }
            />
          </div>
        </div>

        {/* 高级 — WebUI Mk: cleanupPeriodDays, imageHistoryRetainRounds, env */}
        <div id="settings-section-settings-group-advanced" className="settings-group">
          <h2 className="settings-group-title">{t('settings.group.advanced')}</h2>
          <div className="settings-card">
            <SettingRow t={t} label={t('settings.item.cleanupPeriodDays')} feedback={rowFeedback.cleanupPeriodDays} control={
              <NumberInput scopeKey={activeProjectId} value={settings?.cleanupPeriodDays} onChange={(v) => updateSetting('cleanupPeriodDays', v)} />
            } />
            <SettingRow t={t} label={t('settings.item.imageHistoryRetainRounds')} desc={t('settings.item.imageHistoryRetainRounds.desc')} feedback={rowFeedback.imageHistoryRetainRounds} control={
              <NumberInput scopeKey={activeProjectId} value={settings?.imageHistoryRetainRounds} onChange={(v) => updateSetting('imageHistoryRetainRounds', v)} />
            } />
            <SettingRow t={t} label={t('settings.item.env')} desc={t('settings.item.env.desc')} feedback={rowFeedback.env} control={
              <JsonObjectEditor scopeKey={activeProjectId} value={settings?.env} onSave={(value) => updateSetting('env', value)} />
            } />
          </div>
        </div>

        {/* 安全沙箱 — WebUI Mk (2 keys) */}
        <div id="settings-section-settings-group-sandbox" className="settings-group">
          <h2 className="settings-group-title">{t('settings.group.sandbox')}</h2>
          <div className="settings-card">
            <SettingRow t={t} label={t('settings.item.sandbox.enabled')} desc={t('settings.item.sandbox.enabled.desc')} feedback={rowFeedback['sandbox.enabled']} control={<Toggle value={!!settings?.sandbox?.enabled} onChange={(v) => updateSetting('sandbox.enabled', v)} />} />
            <SettingRow t={t} label={t('settings.item.sandbox.autoAllowBashIfSandboxed')} desc={t('settings.item.sandbox.autoAllowBashIfSandboxed.desc')} feedback={rowFeedback['sandbox.autoAllowBashIfSandboxed']} control={<Toggle value={!!settings?.sandbox?.autoAllowBashIfSandboxed} onChange={(v) => updateSetting('sandbox.autoAllowBashIfSandboxed', v)} />} />
          </div>
        </div>

        {/* 系统信息 — WebUI exact fields/order: cwd, os, node, gateway, tunnel */}
        <div id="settings-section-system" className="settings-group">
          <h2 className="settings-group-title">{t('settings.systemInfo')}</h2>
          <div className="settings-card">
            <SettingRow
              t={t}
              label={t('sidebar.cwd')}
              control={
                <button
                  type="button"
                  className="settings-copy-btn"
                  title={info?.cwd || ''}
                  disabled={!info?.cwd}
                  onClick={() => copySystemPath(info?.cwd, t('sidebar.cwd'))}
                >
                  <span className="truncate cursor-pointer hover:underline hover:text-[var(--color-accent-brand)]">
                    {info?.cwd || '-'}
                  </span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                  </svg>
                </button>
              }
            />
            <SettingRow
              t={t}
              label={t('sidebar.os')}
              control={<span className="settings-value">{info?.os || '-'}{info?.arch ? ` ${info.arch}` : ''}</span>}
            />
            <SettingRow
              t={t}
              label={t('sidebar.nodeVersion')}
              control={<span className="settings-value">{info?.nodeVersion || '-'}</span>}
            />
            <SettingRow
              t={t}
              label={t('sidebar.gatewayMode')}
              control={<span className="settings-value capitalize">{info?.gatewayMode || '-'}</span>}
            />
            {info?.tunnelUrl ? (
              <SettingRow
                t={t}
                label={t('sidebar.tunnelUrl')}
                control={
                  <button
                    type="button"
                    className="settings-copy-btn"
                    title={info.tunnelUrl}
                    onClick={() => copySystemPath(info.tunnelUrl, t('sidebar.tunnelUrl'))}
                  >
                    <span className="truncate">{String(info.tunnelUrl).replace(/^https?:\/\//, '')}</span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                    </svg>
                  </button>
                }
              />
            ) : null}
          </div>
          {systemAction ? (
            <div className={`mt-2 text-xs ${systemAction.type === 'success' ? 'text-[var(--color-accent-green)]' : 'text-[var(--color-accent-red)]'}`}>
              {systemAction.message}
            </div>
          ) : null}
        </div>

        {/* Electron-only: desktop preferences (after WebUI system group) */}
        {isDesktop ? (
          <div id="settings-section-desktop" className="settings-group" data-desktop-only="true">
            <h2 className="settings-group-title">{t('settings.desktop')}</h2>
            <div className="settings-card">
              <SettingRow
                t={t}
                label={t('desktop.pasteImage')}
                desc={t('desktop.pasteImage.desc')}
                feedback={rowFeedback.enablePasteImageFromClipboard}
                control={<Toggle value={!!guiSettings?.enablePasteImageFromClipboard} onChange={(v) => updateGuiSetting('enablePasteImageFromClipboard', v)} />}
              />
              <SettingRow
                t={t}
                label={t('desktop.showTokens')}
                desc={t('desktop.showTokens.desc')}
                feedback={rowFeedback.showTokensCounter}
                control={<Toggle value={!!guiSettings?.showTokensCounter} onChange={(v) => updateGuiSetting('showTokensCounter', v)} />}
              />
              <SettingRow
                t={t}
                label={t('desktop.notifications')}
                desc={t('desktop.notifications.desc')}
                feedback={rowFeedback.desktopNotificationsEnabled}
                control={<Toggle value={guiSettings?.desktopNotificationsEnabled !== false} onChange={(v) => updateGuiSetting('desktopNotificationsEnabled', v)} />}
              />
              <SettingRow
                t={t}
                label={t('desktop.doNotDisturb')}
                desc={t('desktop.doNotDisturb.desc')}
                feedback={rowFeedback.doNotDisturb}
                control={<Toggle value={guiSettings?.doNotDisturb === true} onChange={(v) => updateGuiSetting('doNotDisturb', v)} />}
              />
              <SettingRow
                t={t}
                label={t('settings.item.sessionAutoAllowFileEdits')}
                desc={t('settings.item.sessionAutoAllowFileEdits.desc')}
                feedback={rowFeedback.sessionAutoAllowFileEdits}
                control={<Toggle value={guiSettings?.sessionAutoAllowFileEdits === true} onChange={(v) => updateGuiSetting('sessionAutoAllowFileEdits', v)} />}
              />
              <SettingRow
                t={t}
                label={t('settings.item.requestPermissionOnFirstToolUse')}
                desc={t('settings.item.requestPermissionOnFirstToolUse.desc')}
                feedback={rowFeedback.requestPermissionOnFirstToolUse}
                control={<Toggle value={guiSettings?.requestPermissionOnFirstToolUse === true} onChange={(v) => updateGuiSetting('requestPermissionOnFirstToolUse', v)} />}
              />
              <SettingRow
                t={t}
                label={t('settings.item.transportAutoReconnect')}
                desc={t('settings.item.transportAutoReconnect.desc')}
                feedback={rowFeedback.transportAutoReconnect}
                control={
                  <Toggle
                    value={guiSettings?.transportAutoReconnect !== false}
                    onChange={(v) => updateGuiSetting('transportAutoReconnect', v)}
                  />
                }
              />
            </div>
          </div>
        ) : null}

        {/* Electron-only: 手机远程（非微信/企微 channel 远程控制） */}
        {isDesktop ? (
          <div id="settings-section-mobile-remote" className="settings-group" data-desktop-only="true">
            <h2 className="settings-group-title">{t('settings.mobileRemote')}</h2>
            <MobileRemoteSettingsCard t={t} />
          </div>
        ) : null}

        {/* Electron-only: CLI maintenance */}
        {isDesktop ? (
          <div id="settings-section-cli" className="settings-group" data-desktop-only="true">
            <h2 className="settings-group-title">{t('settings.cliMaintenance')}</h2>
            <div className="settings-card">
              <SettingRow
                t={t}
                label={t('cli.installedVersion')}
                desc={cliInfoError || cliCompat?.message || t('cli.installedVersion.desc')}
                control={
                <div className="flex items-center gap-2">
                  <span className={`text-xs ${cliInfoError || cliBlocked ? 'text-[var(--color-accent-red)]' : 'text-[var(--color-text-secondary)]'}`}>
                    {cliInfoLoading ? t('cli.reading') : cliInfo?.version ? `v${cliInfo.version}` : t('cli.unavailable')}
                  </span>
                  <button className="btn-ghost shrink-0 px-2 py-1 text-[11px]" disabled={cliInfoLoading || Boolean(cliOperation)} onClick={() => loadCliInfo()}>
                    {t('cli.refresh')}
                  </button>
                </div>
              } />
              <SettingRow
                t={t}
                label={t('cli.compatStatus')}
                desc={t('cli.compatStatus.desc', {
                  min: cliCompat?.minVersion || '2.125.0',
                  rec: cliCompat?.recommendedVersion || '2.138.0',
                })}
                control={<span className={`text-xs font-medium ${cliCompatTone}`}>{cliCompatLabel}</span>}
              />
              {cliBlocked ? (
                <div className="border-t border-[var(--color-border-default)] px-4 py-3">
                  <div className="text-sm font-medium text-[var(--color-text-primary)]">
                    {cliCompat?.status === 'missing' ? t('cli.bootstrapTitle') : t('cli.fixCompat')}
                  </div>
                  <div className="mt-1 text-xs leading-5 text-[var(--color-text-secondary)]">
                    {cliCompat?.status === 'missing' ? t('cli.bootstrapDesc') : t('cli.fixCompat.desc')}
                  </div>
                  {cliCompat?.status === 'missing' ? (
                    <div className="mt-3 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-code)] px-3 py-2">
                      <div className="mb-1 text-[11px] text-[var(--color-text-muted)]">{t('cli.bootstrapCommand')}</div>
                      <code className="block break-all font-mono text-[12px] text-[var(--color-text-primary)]">
                        {CODEBUDDY_CLI_BOOTSTRAP_COMMAND}
                      </code>
                    </div>
                  ) : null}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="btn-primary px-2 py-1 text-[11px]"
                      disabled={Boolean(cliOperation)}
                      onClick={installRecommendedCli}
                    >
                      {cliOperation === 'install'
                        ? t('cli.installing')
                        : t('cli.oneClickInstall', { version: cliCompat?.recommendedVersion || '2.138.0' })}
                    </button>
                    {cliCompat?.status === 'missing' ? (
                      <button type="button" className="btn-ghost px-2 py-1 text-[11px]" onClick={copyBootstrapCommand}>
                        {t('cli.copyCommand')}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn-ghost px-2 py-1 text-[11px]"
                      disabled={cliInfoLoading || Boolean(cliOperation)}
                      onClick={() => loadCliInfo()}
                    >
                      {t('cli.refresh')}
                    </button>
                  </div>
                  <div className="mt-2 text-[11px] leading-5 text-[var(--color-text-muted)]">{t('cli.afterInstallHint')}</div>
                </div>
              ) : null}
              <SettingRow
                t={t}
                label={t('cli.maintenance')}
                desc={t('cli.maintenance.desc')}
                control={
                <div className="flex flex-wrap items-center justify-end gap-1">
                  <button className="btn-ghost shrink-0 px-2 py-1 text-[11px]" disabled={Boolean(cliOperation)} onClick={runCliDiagnostics}>
                    {cliOperation === 'doctor' ? t('cli.diagnosing') : t('cli.runDoctor')}
                  </button>
                  <button className="btn-primary shrink-0 px-2 py-1 text-[11px]" disabled={Boolean(cliOperation)} onClick={() => { setCliUpdateError(''); setCliUpdateOpen(true); }}>
                    {cliOperation === 'update' ? t('cli.updating') : t('cli.checkUpdate')}
                  </button>
                  <button className="btn-ghost shrink-0 px-2 py-1 text-[11px]" disabled={Boolean(cliOperation)} onClick={() => { setCliInstallError(''); setCliInstallOpen(true); }}>
                    {cliOperation === 'install' ? t('cli.installing') : t('cli.installVersion')}
                  </button>
                </div>
              } />
              {cliRestartNeeded ? (
                <SettingRow
                  t={t}
                  label={t('cli.restartNeeded')}
                  desc={t('cli.restartNeeded.desc')}
                  control={
                <button className="btn-primary shrink-0 px-2 py-1 text-[11px]" disabled={Boolean(cliOperation)} onClick={restartCurrentRuntimeAfterCliUpdate}>
                  {cliOperation === 'restart' ? t('cli.restarting') : t('cli.restartRuntime')}
                </button>
              } />
              ) : null}
            </div>
            {cliNotice ? (
              <div className={`mt-2 text-xs ${cliNotice.type === 'success' ? 'text-[var(--color-accent-green)]' : cliNotice.type === 'error' ? 'text-[var(--color-accent-red)]' : 'text-[var(--color-accent-yellow)]'}`}>
                {cliNotice.message}
              </div>
            ) : null}
            {cliOutput ? (
              <div className="mt-3 overflow-hidden rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-code)]">
                <div className="flex items-center justify-between border-b border-[var(--color-border-default)] px-3 py-2">
                  <span className="text-xs font-medium text-[var(--color-text-primary)]">{cliOutput.title}</span>
                  <div className="flex items-center gap-1">
                    <button className="btn-ghost px-2 py-1 text-[11px]" onClick={copyCliOutput}>{t('cli.copy')}</button>
                    <button className="btn-icon" title={t('cli.closeOutput')} aria-label={t('cli.closeOutput')} onClick={() => setCliOutput(null)}>×</button>
                  </div>
                </div>
                {cliOutput.truncated ? <div className="border-b border-[var(--color-border-default)] px-3 py-2 text-[11px] text-[var(--color-accent-yellow)]">{t('cli.outputTruncated')}</div> : null}
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-3 py-3 font-mono text-[11px] leading-5 text-[var(--color-text-secondary)]">{cliOutput.content}</pre>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Electron-only: desktop app version / updates / diagnostics (not in WebUI system card) */}
        {isDesktop ? (
          <>
          <div id="settings-section-desktop-app" className="settings-group" data-desktop-only="true">
            <h2 className="settings-group-title">{t('settings.desktopApp')}</h2>
            <div className="settings-card">
              <SettingRow
                t={t}
                label={t('desktop.appVersion')}
                control={
                  <span className="settings-value">
                    {appInfoError ? '—' : appInfo?.version ? `v${appInfo.version}` : t('settings.loading')}
                  </span>
                }
              />
              <SettingRow
                t={t}
                label={t('desktop.appMode')}
                control={
                  <span className="settings-value">
                    {appInfo
                      ? appInfo.packaged
                        ? t('desktop.appMode.packaged')
                        : t('desktop.appMode.dev')
                      : '-'}
                  </span>
                }
              />
              <SettingRow
                t={t}
                label={t('desktop.guiUpdate')}
                desc={updateStatus?.message || t('desktop.guiUpdate.desc')}
                control={
                  <div className="flex items-center gap-1">
                    <button className="btn-ghost shrink-0 px-2 py-1 text-[11px]" disabled={checkingForUpdates || openingUpdateDownload} onClick={checkForGuiUpdates}>
                      {checkingForUpdates ? '...' : updateStatus ? t('desktop.recheck') : t('desktop.checkUpdate')}
                    </button>
                    {updateStatus?.type === 'update' && updateStatus?.downloadUrl ? (
                      <button className="btn-primary shrink-0 px-2 py-1 text-[11px]" disabled={openingUpdateDownload} onClick={openGuiUpdateDownload}>
                        {openingUpdateDownload ? '...' : t('desktop.download')}
                      </button>
                    ) : null}
                    <button className="btn-ghost shrink-0 px-2 py-1 text-[11px]" disabled={openingUpdateDownload} onClick={openGuiReleasePage}>
                      {t('desktop.releases')}
                    </button>
                    <button className="btn-ghost shrink-0 px-2 py-1 text-[11px]" disabled={openingUpdateDownload} onClick={openGuiChangelog}>
                      {t('desktop.changelog')}
                    </button>
                  </div>
                }
              />
              <SettingRow
                t={t}
                label={t('desktop.diagnostics')}
                desc={t('desktop.diagnostics.desc')}
                control={
                  <button className="btn-ghost shrink-0 px-2 py-1 text-[11px]" disabled={exportingDiagnostics} onClick={exportDiagnostics}>
                    {exportingDiagnostics ? '...' : t('desktop.export')}
                  </button>
                }
              />
              <SettingRow
                t={t}
                label={t('desktop.userData')}
                desc={t('desktop.userData.desc')}
                control={
                  <div className="flex min-w-0 items-center gap-1">
                    <button
                      type="button"
                      className="settings-copy-btn"
                      title={appInfo?.userDataPath || ''}
                      disabled={!appInfo?.userDataPath}
                      onClick={() => copySystemPath(appInfo?.userDataPath, t('desktop.userData'))}
                    >
                      <span className="truncate">{appInfo?.userDataPath || '-'}</span>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                      </svg>
                    </button>
                    <button className="btn-ghost shrink-0 px-2 py-1 text-[11px]" disabled={openingUserData || !appInfo?.userDataPath} onClick={openUserDataDirectory}>
                      {openingUserData ? '...' : t('desktop.open')}
                    </button>
                  </div>
                }
              />
            </div>
            {appInfoError ? <div className="mt-2 text-xs text-[var(--color-accent-red)]">{appInfoError}</div> : null}
          </div>

          <div id="settings-section-about" className="settings-group" data-desktop-only="true">
            <h2 className="settings-group-title">{t('settings.about')}</h2>
            <div className="settings-card">
              <SettingRow
                t={t}
                label={t('about.version')}
                control={
                  <span className="settings-value">
                    {appInfoError ? '—' : appInfo?.version ? `v${appInfo.version}` : t('settings.loading')}
                  </span>
                }
              />
              <SettingRow
                t={t}
                label={t('about.license')}
                desc={t('about.license.desc')}
                control={
                  <div className="flex items-center gap-1">
                    <span className="settings-value">MIT</span>
                    <button className="btn-ghost shrink-0 px-2 py-1 text-[11px]" disabled={openingUpdateDownload} onClick={openGuiReleasePage}>
                      {t('about.viewLicense')}
                    </button>
                  </div>
                }
              />
              <SettingRow
                t={t}
                label={t('about.terms')}
                control={
                  <button className="btn-ghost shrink-0 px-2 py-1 text-[11px]" disabled={openingUpdateDownload} onClick={() => openAboutLink('https://github.com/ChisaAlter/codebuddy-desktop/releases')}>
                    {t('about.openExternal')}
                  </button>
                }
              />
              <SettingRow
                t={t}
                label={t('about.privacy')}
                control={
                  <button className="btn-ghost shrink-0 px-2 py-1 text-[11px]" disabled={openingUpdateDownload} onClick={() => openAboutLink('https://github.com/ChisaAlter/codebuddy-desktop/releases')}>
                    {t('about.openExternal')}
                  </button>
                }
              />
            </div>
          </div>
          </>
        ) : null}

        </>)}
        </div>
      </div>
      <ActionConfirmDialog
        open={cliUpdateOpen}
        title="检查并更新 CodeBuddy CLI？"
        description={<><div>将运行真实的 <span className="font-mono text-[var(--color-text-primary)]">codebuddy update</span>。该命令会检查新版本，并在可用时直接修改本机 CLI 安装。</div><div className="mt-2">若更新后的版本高于 GUI 验证版本，部分功能可能未覆盖验证。更新不会自动重启已经运行的项目进程；版本变化后请使用设置页的运行时重启入口。</div></>}
        confirmLabel="检查并更新"
        busy={cliOperation === 'update'}
        error={cliUpdateError}
        danger={false}
        onCancel={() => { if (cliOperation !== 'update') { setCliUpdateOpen(false); setCliUpdateError(''); } }}
        onConfirm={confirmCliUpdate}
      />
      <CliVersionInstallDialog
        open={cliInstallOpen}
        busy={cliOperation === 'install'}
        error={cliInstallError}
        currentVersion={cliInfo?.version}
        onCancel={() => { if (cliOperation !== 'install') { setCliInstallOpen(false); setCliInstallError(''); } }}
        onSubmit={confirmCliInstall}
      />
    </div>
  );
}
