import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store';
import { copyTextToClipboard } from '../lib/clipboard';
import { previewPluginDependencyPrune, prunePluginDependencies } from '../lib/plugin-maintenance';
import { browseMarketplace } from '../lib/ops';
import { RefreshCw, ExternalLink, ChevronDown, ChevronRight } from 'lucide-react';
import {
  PLUGIN_KIND_OPTIONS,
  filterPlugins,
  slicePluginPage,
  aggregateMarketplacePlugins,
  isPluginInstalled,
  pluginIdentity,
  pluginSearchText,
  pluginCanSwitchoff,
  pluginCanRemove,
  pluginCanEdit,
} from '../lib/plugins-list';
import { resolveLocaleMode, translate } from '../lib/i18n';

const PLUGIN_SCOPE_LABELS = {
  user: '用户全局',
  project: '项目共享',
  local: '项目本机',
};

const PLUGIN_PAGE_SIZE = 30;

export function normalizedPluginScope(value) {
  return Object.hasOwn(PLUGIN_SCOPE_LABELS, value) ? value : 'user';
}

export function validMaintenancePluginId(value) {
  const plugin = String(value || '').trim();
  return plugin.length > 0 && plugin.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._/@-]*$/.test(plugin);
}

export default function ReplicaPluginsView() {
  const {
    plugins,
    refreshPlugins,
    marketplaces,
    pluginError,
    marketplaceError,
    pluginBusy,
    installPluginByName,
    uninstallPluginByName,
    togglePluginByName,
    addMarketplaceById,
    removeMarketplaceById,
    setMarketplaceAutoUpdateById,
    syncMarketplaces,
    updatePluginByName,
    refreshMarketplaces,
    restartProjectRuntime,
    guiSettings,
  } = useStore(useShallow((state) => ({
    plugins: state.plugins,
    refreshPlugins: state.refreshPlugins,
    marketplaces: state.marketplaces,
    pluginError: state.pluginError,
    marketplaceError: state.marketplaceError,
    pluginBusy: state.pluginBusy,
    installPluginByName: state.installPluginByName,
    uninstallPluginByName: state.uninstallPluginByName,
    togglePluginByName: state.togglePluginByName,
    addMarketplaceById: state.addMarketplaceById,
    removeMarketplaceById: state.removeMarketplaceById,
    setMarketplaceAutoUpdateById: state.setMarketplaceAutoUpdateById,
    syncMarketplaces: state.syncMarketplaces,
    updatePluginByName: state.updatePluginByName,
    refreshMarketplaces: state.refreshMarketplaces,
    restartProjectRuntime: state.restartProjectRuntime,
    guiSettings: state.guiSettings,
  })));
  const activeProjectId = useStore((state) => state.activeProjectId);
  const activeWorkspacePath = useStore((state) => state.projectsById[state.activeProjectId]?.workspacePath || '');
  const locale = resolveLocaleMode(guiSettings?.locale);
  const t = React.useCallback((key, vars) => translate(locale, key, vars), [locale]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [searchTerm, setSearchTerm] = React.useState('');
  const [activeTab, setActiveTab] = React.useState('installed');
  const [installedMarketplaceFilter, setInstalledMarketplaceFilter] = React.useState('all');
  const [expandedPluginId, setExpandedPluginId] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState('all'); // 'all' | 'enabled' | 'disabled'
  const [kindFilter, setKindFilter] = React.useState('all');
  const [visibleCount, setVisibleCount] = React.useState(PLUGIN_PAGE_SIZE);
  const [showInstallModal, setShowInstallModal] = React.useState(false);
  const [installId, setInstallId] = React.useState('');
  const [installMarketplace, setInstallMarketplace] = React.useState('');
  const [installing, setInstalling] = React.useState(false);
  const [installMsg, setInstallMsg] = React.useState(null);
  const [actionError, setActionError] = React.useState(null);
  const [actionDialog, setActionDialog] = React.useState(null);
  const [actionDialogError, setActionDialogError] = React.useState('');
  const [maintenanceScope, setMaintenanceScope] = React.useState('user');
  const [maintenanceBusy, setMaintenanceBusy] = React.useState('');
  const [maintenanceNotice, setMaintenanceNotice] = React.useState(null);
  const [maintenanceOutput, setMaintenanceOutput] = React.useState(null);
  const [restartNeeded, setRestartNeeded] = React.useState(false);
  // 市场增删表单态
  const [newMktId, setNewMktId] = React.useState('');
  const [newMktUrl, setNewMktUrl] = React.useState('');
  const [newMktAutoUpdate, setNewMktAutoUpdate] = React.useState(false);
  const [mktBusy, setMktBusy] = React.useState(false);
  const [mktMsg, setMktMsg] = React.useState(null);
  const [installScope, setInstallScope] = React.useState('user');
  const [browseScope, setBrowseScope] = React.useState('user');
  const [browseMarketId, setBrowseMarketId] = React.useState('__all__');
  const [browseAllFailures, setBrowseAllFailures] = React.useState(0);
  const [expandedBrowseId, setExpandedBrowseId] = React.useState('');
  const [browseMarket, setBrowseMarket] = React.useState(null); // { id, label }
  const [browseResults, setBrowseResults] = React.useState([]);
  const [browseLoading, setBrowseLoading] = React.useState(false);
  const [browseError, setBrowseError] = React.useState(null);
  const [browseQuery, setBrowseQuery] = React.useState('');
  const browseRequestRef = React.useRef(0);
  // M-perf: last manual (Enter) browse query — the debounced effect skips a
  // duplicate fetch when the user already queried the exact same terms.
  const lastManualQueryRef = React.useRef(null);
  const projectGenerationRef = React.useRef(0);
  const refreshRequestRef = React.useRef(0);
  const refreshInFlightRef = React.useRef(null);
  const pluginActionInFlightRef = React.useRef(null);
  const marketplaceActionInFlightRef = React.useRef(null);
  const listScrollRef = React.useRef(null);
  const loadMoreSentinelRef = React.useRef(null);

  const handleRefresh = React.useCallback(async () => {
    if (refreshInFlightRef.current) return false;
    const operation = {};
    refreshInFlightRef.current = operation;
    const projectId = activeProjectId;
    const requestId = ++refreshRequestRef.current;
    setRefreshing(true);
    setActionError(null);
    useStore.setState({ pluginError: null, marketplaceError: null });
    try {
      const results = await Promise.all([refreshPlugins(), refreshMarketplaces?.()]);
      if (requestId !== refreshRequestRef.current || useStore.getState().activeProjectId !== projectId) return false;
      if (results.some((ok) => ok === false)) {
        const current = useStore.getState();
        setActionError(current.pluginError || current.marketplaceError || '部分插件数据加载失败');
        return false;
      }
      return true;
    } catch (error) {
      if (requestId !== refreshRequestRef.current || useStore.getState().activeProjectId !== projectId) return false;
      setActionError(error?.message || '插件数据加载失败');
      return false;
    } finally {
      if (refreshInFlightRef.current === operation) {
        refreshInFlightRef.current = null;
        if (requestId === refreshRequestRef.current && useStore.getState().activeProjectId === projectId) {
          setRefreshing(false);
          setLoading(false);
        }
      }
    }
  }, [activeProjectId, refreshMarketplaces, refreshPlugins]);

  const loadBrowseResults = React.useCallback(async (marketplaceId = browseMarketId, query = browseQuery) => {
    const requestId = ++browseRequestRef.current;
    const projectId = activeProjectId;
    setBrowseLoading(true);
    setBrowseError(null);
    setBrowseAllFailures(0);
    try {
      const search = String(query || '').trim();
      let result;
      if (marketplaceId === '__all__') {
        result = await aggregateMarketplacePlugins(marketplaces, (id) => browseMarketplace(id, ''));
        if (search) {
          result.plugins = result.plugins.filter((plugin) => pluginSearchText(plugin).includes(search.toLowerCase()));
        }
      } else {
        const pluginsForMarket = await browseMarketplace(marketplaceId, search);
        result = { plugins: pluginsForMarket, failures: 0, total: 1 };
      }
      if (requestId !== browseRequestRef.current || projectId !== useStore.getState().activeProjectId) return;
      setBrowseResults(Array.isArray(result.plugins) ? result.plugins : []);
      setBrowseAllFailures(result.failures || 0);
      if (result.failures && !result.plugins.length) setBrowseError('所有市场暂时无法加载，请重试');
    } catch (error) {
      if (requestId === browseRequestRef.current && projectId === useStore.getState().activeProjectId) {
        setBrowseError(error?.message || '浏览市场失败');
      }
    } finally {
      if (requestId === browseRequestRef.current && projectId === useStore.getState().activeProjectId) setBrowseLoading(false);
    }
  }, [activeProjectId, marketplaces]);

  React.useEffect(() => {
    if (activeTab !== 'browse') return undefined;
    // M-perf: debounce keystroke-driven search — every typed character used to
    // fire a full marketplace fetch; Enter still runs immediately through
    // runBrowseQuery (which marks the manual query so the debounce skips it).
    const timer = setTimeout(() => {
      const manual = lastManualQueryRef.current;
      if (
        manual &&
        manual.marketplaceId === browseMarketId &&
        manual.query === browseQuery &&
        Date.now() - manual.at < 400
      ) {
        return; // Enter already queried this exact (marketplace, query)
      }
      loadBrowseResults(browseMarketId, browseQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [activeTab, browseMarketId, browseQuery, marketplaces, loadBrowseResults]);

  const openBrowseMarketplace = React.useCallback((marketplaceId, _label) => {
    setBrowseMarket(null);
    setBrowseMarketId(marketplaceId);
    setBrowseQuery('');
    setBrowseResults([]);
    setBrowseError(null);
    setActiveTab('browse');
  }, []);

  const runBrowseQuery = React.useCallback((marketplaceId, query) => {
    setBrowseMarketId(marketplaceId);
    setBrowseQuery(query);
    // Mark the manual (Enter) query so the debounced effect does not re-fire it.
    lastManualQueryRef.current = { marketplaceId, query, at: Date.now() };
    return loadBrowseResults(marketplaceId, query);
  }, [loadBrowseResults]);
  const closeBrowseMarketplace = React.useCallback(() => {
    setBrowseMarket(null);
    setBrowseResults([]);
    setBrowseError(null);
    setBrowseQuery('');
  }, []);

  const installFromBrowse = React.useCallback(async (pluginId, marketplaceId, scope = browseScope) => {
    if (!pluginId) return;
    setInstalling(true);
    setInstallMsg(null);
    try {
      const ok = await installPluginByName(pluginId, marketplaceId, { scope });
      if (ok) {
        setInstallMsg('安装请求已提交');
        await Promise.allSettled([refreshPlugins(), refreshMarketplaces?.()]);
        await loadBrowseResults(browseMarketId, browseQuery);
      } else {
        setInstallMsg(useStore.getState().pluginError || '安装插件失败');
      }
    } catch (error) {
      setInstallMsg(error?.message || '安装插件失败');
    } finally {
      setInstalling(false);
    }
  }, [browseMarketId, browseQuery, browseScope, installPluginByName, loadBrowseResults, refreshMarketplaces, refreshPlugins]);

  React.useEffect(() => {
    projectGenerationRef.current += 1;
    refreshRequestRef.current += 1;
    setLoading(true);
    setRefreshing(false);
    setShowInstallModal(false);
    setInstallId('');
    setInstallMarketplace('');
    setInstalling(false);
    setInstallMsg(null);
    setActionError(null);
    setActionDialog(null);
    setActionDialogError('');
    setMaintenanceScope('user');
    setMaintenanceBusy('');
    setMaintenanceNotice(null);
    setMaintenanceOutput(null);
    setRestartNeeded(false);
    closeBrowseMarketplace();
    setNewMktId('');
    setNewMktUrl('');
    setNewMktAutoUpdate(false);
    setKindFilter('all');
    setVisibleCount(PLUGIN_PAGE_SIZE);
    setMktBusy(false);
    setMktMsg(null);
    refreshInFlightRef.current = null;
    pluginActionInFlightRef.current = null;
    marketplaceActionInFlightRef.current = null;
    handleRefresh();
  }, [activeProjectId, handleRefresh]);

  const pluginsList = Array.isArray(plugins) ? plugins : [];

  const filtered = React.useMemo(
    () => filterPlugins(
      pluginsList.filter((plugin) => installedMarketplaceFilter === 'all' || plugin.marketplace === installedMarketplaceFilter),
      { query: searchTerm, status: statusFilter, kind: kindFilter },
    ),
    [pluginsList, installedMarketplaceFilter, searchTerm, statusFilter, kindFilter],
  );

  React.useEffect(() => {
    setVisibleCount(PLUGIN_PAGE_SIZE);
  }, [searchTerm, statusFilter, kindFilter, pluginsList.length]);

  const page = React.useMemo(
    () => slicePluginPage(filtered, visibleCount, PLUGIN_PAGE_SIZE),
    [filtered, visibleCount],
  );

  React.useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    const root = listScrollRef.current;
    if (!sentinel || !page.hasMore) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((current) => Math.min(filtered.length, current + PLUGIN_PAGE_SIZE));
        }
      },
      { root: root || null, rootMargin: '120px', threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [page.hasMore, filtered.length, page.visible]);

  const isEnabled = (p) => p.status === 'enabled' || p.enabled;

  const pluginOperationActive = Boolean(pluginBusy || maintenanceBusy);

  const beginPluginAction = () => {
    if (pluginActionInFlightRef.current || marketplaceActionInFlightRef.current || useStore.getState().pluginBusy) return null;
    const operation = {};
    pluginActionInFlightRef.current = operation;
    return operation;
  };

  const finishPluginAction = (operation) => {
    if (pluginActionInFlightRef.current === operation) pluginActionInFlightRef.current = null;
  };

  const beginMarketplaceAction = () => {
    if (marketplaceActionInFlightRef.current || pluginActionInFlightRef.current || useStore.getState().pluginBusy) return null;
    const operation = {};
    marketplaceActionInFlightRef.current = operation;
    return operation;
  };

  const finishMarketplaceAction = (operation) => {
    if (marketplaceActionInFlightRef.current === operation) marketplaceActionInFlightRef.current = null;
  };

  const openActionDialog = (action) => {
    if (pluginActionInFlightRef.current || marketplaceActionInFlightRef.current || useStore.getState().pluginBusy || mktBusy) return;
    setActionDialog(action);
    setActionDialogError('');
  };

  const closeActionDialog = () => {
    if (pluginActionInFlightRef.current || useStore.getState().pluginBusy) return;
    setActionDialog(null);
    setActionDialogError('');
  };

  const confirmActionDialog = async () => {
    if (!actionDialog || marketplaceActionInFlightRef.current) return;
    const operation = beginPluginAction();
    if (!operation) return;
    const projectId = activeProjectId;
    const generation = projectGenerationRef.current;
    const action = actionDialog;
    setActionDialogError('');
    setActionError(null);
    setMktMsg(null);
    try {
      let ok = true;
      if (action.type === 'uninstall') {
        ok = await uninstallPluginByName(action.id, action.marketplace);
      } else if (action.type === 'remove-marketplace') {
        ok = await removeMarketplaceById(action.id);
      } else if (action.type === 'update') {
        setMaintenanceBusy(`update:${action.id}`);
        const result = typeof updatePluginByName === 'function'
          ? await updatePluginByName(action.id, { scope: action.scope, cwd: activeWorkspacePath })
          : { ok: false, error: '更新接口不可用' };
        if (projectId !== useStore.getState().activeProjectId || generation !== projectGenerationRef.current) return;
        if (!result?.ok) {
          setActionDialogError(result?.error || useStore.getState().pluginError || '更新插件失败');
          return;
        }
        const viaLabel = result.via === 'http' ? 'HTTP' : 'CLI';
        setMaintenanceOutput({
          title: `更新输出 · ${action.label} (${viaLabel})`,
          content: result.output || `${viaLabel} 更新已完成`,
          truncated: Boolean(result.truncated),
        });
        setMaintenanceNotice({
          type: 'success',
          message: `${action.label} 已通过 ${viaLabel} 更新。重启当前项目运行时后生效。`,
        });
        setRestartNeeded(true);
      } else if (action.type === 'prune') {
        setMaintenanceBusy('prune');
        const result = await prunePluginDependencies({ scope: action.scope, cwd: activeWorkspacePath });
        if (projectId !== useStore.getState().activeProjectId || generation !== projectGenerationRef.current) return;
        setMaintenanceOutput({ title: `依赖清理输出 · ${PLUGIN_SCOPE_LABELS[action.scope]}`, content: result.output, truncated: result.truncated });
        setMaintenanceNotice({ type: 'success', message: `${PLUGIN_SCOPE_LABELS[action.scope]}的失效插件依赖已清理。重启当前项目运行时后完全生效。` });
        setRestartNeeded(true);
      }
      if (projectId !== useStore.getState().activeProjectId || generation !== projectGenerationRef.current) return;
      if (!ok) {
        const current = useStore.getState();
        const message = (action.type === 'uninstall' ? current.pluginError : current.marketplaceError)
          || (action.type === 'uninstall' ? '卸载插件失败' : '删除市场失败');
        setActionDialogError(message);
        return;
      }
      setActionDialog(null);
    } catch (error) {
      if (projectId === useStore.getState().activeProjectId && generation === projectGenerationRef.current) {
        setActionDialogError(error?.message || '插件维护操作失败');
      }
    } finally {
      if (projectId === useStore.getState().activeProjectId && generation === projectGenerationRef.current) setMaintenanceBusy('');
      finishPluginAction(operation);
    }
  };

  const previewDependencyPrune = async () => {
    const operation = beginPluginAction();
    if (!operation) return;
    const projectId = activeProjectId;
    const generation = projectGenerationRef.current;
    setMaintenanceBusy('preview-prune');
    setMaintenanceNotice({ type: 'busy', message: `正在检查${PLUGIN_SCOPE_LABELS[maintenanceScope]}的失效插件依赖...` });
    setMaintenanceOutput(null);
    setActionError(null);
    try {
      const result = await previewPluginDependencyPrune({ scope: maintenanceScope, cwd: activeWorkspacePath });
      if (projectId !== useStore.getState().activeProjectId || generation !== projectGenerationRef.current) return;
      setMaintenanceOutput({ title: `依赖检查输出 · ${PLUGIN_SCOPE_LABELS[maintenanceScope]}`, content: result.output, truncated: result.truncated });
      if (!result.hasChanges) {
        setMaintenanceNotice({ type: 'success', message: `${PLUGIN_SCOPE_LABELS[maintenanceScope]}没有可清理的失效插件依赖。` });
        return;
      }
      setMaintenanceNotice({ type: 'busy', message: `发现 ${result.items.length} 个可清理项，请确认后继续。` });
      setActionDialog({
        type: 'prune',
        id: maintenanceScope,
        scope: maintenanceScope,
        label: `${PLUGIN_SCOPE_LABELS[maintenanceScope]} · ${result.items.length} 个依赖`,
        detail: result.items.map((item) => typeof item === 'string' ? item : (item.id || item.name || JSON.stringify(item))).join('、'),
      });
    } catch (error) {
      if (projectId === useStore.getState().activeProjectId && generation === projectGenerationRef.current) {
        setMaintenanceNotice({ type: 'error', message: error?.message || '检查插件依赖失败' });
      }
    } finally {
      if (projectId === useStore.getState().activeProjectId && generation === projectGenerationRef.current) setMaintenanceBusy('');
      finishPluginAction(operation);
    }
  };

  const restartRuntimeForPluginChanges = async () => {
    const operation = beginPluginAction();
    if (!operation) return;
    const projectId = activeProjectId;
    const generation = projectGenerationRef.current;
    setMaintenanceBusy('restart');
    setMaintenanceNotice({ type: 'busy', message: '正在重启当前项目运行时...' });
    try {
      const restarted = await restartProjectRuntime(projectId);
      if (projectId !== useStore.getState().activeProjectId || generation !== projectGenerationRef.current) return;
      if (!restarted) throw new Error(useStore.getState().error || '当前项目运行时重启失败');
      await Promise.allSettled([refreshPlugins(), refreshMarketplaces?.()]);
      if (projectId !== useStore.getState().activeProjectId || generation !== projectGenerationRef.current) return;
      setRestartNeeded(false);
      setMaintenanceNotice({ type: 'success', message: '当前项目运行时已重启，插件状态已重新加载。' });
    } catch (error) {
      if (projectId === useStore.getState().activeProjectId && generation === projectGenerationRef.current) {
        setMaintenanceNotice({ type: 'error', message: error?.message || '当前项目运行时重启失败' });
      }
    } finally {
      if (projectId === useStore.getState().activeProjectId && generation === projectGenerationRef.current) setMaintenanceBusy('');
      finishPluginAction(operation);
    }
  };

  const copyMaintenanceOutput = async () => {
    if (!maintenanceOutput?.content) return;
    try {
      await copyTextToClipboard(maintenanceOutput.content);
      setMaintenanceNotice({ type: 'success', message: '插件维护输出已复制。' });
    } catch (error) {
      setMaintenanceNotice({ type: 'error', message: error?.message || '复制插件维护输出失败' });
    }
  };

  const actionDialogDestructive = actionDialog?.type === 'uninstall' || actionDialog?.type === 'remove-marketplace';
  const actionDialogTitle = actionDialog?.type === 'uninstall'
    ? '卸载插件？'
    : actionDialog?.type === 'remove-marketplace'
      ? '删除插件市场？'
      : actionDialog?.type === 'update'
        ? '更新插件？'
        : '清理失效插件依赖？';
  const actionDialogConfirmLabel = actionDialog?.type === 'uninstall'
    ? '卸载插件'
    : actionDialog?.type === 'remove-marketplace'
      ? '删除市场'
      : actionDialog?.type === 'update'
        ? '更新插件'
        : '执行清理';

  return (
    <div className="page-shell overflow-y-auto">
      <div className="page-content-wide">
        {/* Header */}
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">插件</h1>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">管理扩展、技能与插件市场</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <select
              className="h-8 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-2 text-xs text-[var(--color-text-secondary)] outline-none"
              value={maintenanceScope}
              disabled={pluginOperationActive || mktBusy}
              aria-label="插件维护作用域"
              onChange={(event) => setMaintenanceScope(event.target.value)}
            >
              {Object.entries(PLUGIN_SCOPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <button
              className="btn-ghost text-xs"
              disabled={pluginOperationActive || mktBusy || !activeWorkspacePath}
              onClick={previewDependencyPrune}
            >
              {maintenanceBusy === 'preview-prune' ? '检查中...' : maintenanceBusy === 'prune' ? '清理中...' : '清理依赖'}
            </button>
            <button
              className="btn-primary text-xs"
              disabled={pluginOperationActive || mktBusy}
              onClick={() => {
                setInstallId('');
                setInstallMarketplace('');
                setShowInstallModal(true);
              }}
            >
              + 安装插件
            </button>
            <button
              onClick={handleRefresh}
              disabled={refreshing || pluginOperationActive || mktBusy}
              className="flex items-center gap-1.5 rounded-md border border-[var(--color-border-default)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors disabled:opacity-50"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={refreshing ? 'animate-spin' : ''}>
                <path d="M1 8a7 7 0 0113.29-4M15 8a7 7 0 01-13.29 4" />
                <path d="M13 1v4h-4M3 15v-4h4" />
              </svg>
              {refreshing ? '刷新中...' : '刷新'}
            </button>
          </div>
        </div>

        <div className="mb-5 border-b border-[var(--color-border-default)]" role="tablist" aria-label="插件视图">
          {[
            ['installed', '已安装插件'],
            ['browse', '浏览市场'],
            ['marketplaces', '市场'],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={activeTab === id}
              aria-controls={`plugins-panel-${id}`}
              className={`mr-5 border-b-2 px-1 pb-2 text-sm transition-colors ${activeTab === id ? 'border-[var(--color-accent-blue)] text-[var(--color-text-primary)]' : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'}`}
              onClick={() => setActiveTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <section id="plugins-panel-installed" role="tabpanel" hidden={activeTab !== 'installed'}>

        {(pluginError || marketplaceError || actionError) && (
          <div className="mb-4 rounded-lg border border-[rgba(248,113,113,0.2)] bg-[rgba(248,113,113,0.1)] px-4 py-2.5 text-sm text-[#f87171]">
            {actionError || pluginError || marketplaceError}
            <button className="ml-3 underline text-xs" onClick={() => { setActionError(null); handleRefresh(); }}>重试</button>
          </div>
        )}

        {maintenanceNotice ? (
          <div className={`mb-4 flex flex-wrap items-center gap-2 rounded-md border px-4 py-3 text-xs ${maintenanceNotice.type === 'error' ? 'border-[rgba(248,113,113,0.25)] bg-[rgba(248,113,113,0.08)] text-[var(--color-accent-red)]' : maintenanceNotice.type === 'success' ? 'border-[rgba(74,222,128,0.25)] bg-[rgba(74,222,128,0.08)] text-[var(--color-accent-green)]' : 'border-[rgba(250,204,21,0.25)] bg-[rgba(250,204,21,0.08)] text-[var(--color-accent-yellow)]'}`}>
            <span className="min-w-0 flex-1">{maintenanceNotice.message}</span>
            {restartNeeded ? (
              <button className="btn-primary shrink-0 px-2 py-1 text-[11px]" disabled={pluginOperationActive} onClick={restartRuntimeForPluginChanges}>
                {maintenanceBusy === 'restart' ? '重启中...' : '重启当前运行时'}
              </button>
            ) : null}
          </div>
        ) : null}

        {maintenanceOutput ? (
          <div className="mb-4 overflow-hidden rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-code)]">
            <div className="flex items-center justify-between border-b border-[var(--color-border-default)] px-3 py-2">
              <span className="text-xs font-medium text-[var(--color-text-primary)]">{maintenanceOutput.title}</span>
              <div className="flex items-center gap-1">
                <button className="btn-ghost px-2 py-1 text-[11px]" onClick={copyMaintenanceOutput}>复制</button>
                <button className="btn-icon" title="关闭输出" aria-label="关闭插件维护输出" onClick={() => setMaintenanceOutput(null)}>×</button>
              </div>
            </div>
            {maintenanceOutput.truncated ? <div className="border-b border-[var(--color-border-default)] px-3 py-2 text-[11px] text-[var(--color-accent-yellow)]">输出过长，仅保留最新内容。</div> : null}
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words px-3 py-3 font-mono text-[11px] leading-5 text-[var(--color-text-secondary)]">{maintenanceOutput.content}</pre>
          </div>
        ) : null}

        {/* Toolbar: search + filter tabs */}
        <div className="mb-4 flex items-center gap-3 flex-wrap">
          <input
            className="input-field max-w-[260px]"
            type="text"
            placeholder="搜索插件名称或描述..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
            <select
              className="h-8 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-2 text-xs text-[var(--color-text-secondary)] outline-none"
              value={installedMarketplaceFilter}
              onChange={(event) => setInstalledMarketplaceFilter(event.target.value)}
              aria-label="已安装插件市场"
            >
              <option value="all">全部市场</option>
              {(marketplaces || []).map((marketplace, index) => {
                const id = marketplace.id || marketplace.marketplaceId || marketplace.name || `market-${index}`;
                return <option key={id} value={id}>{marketplace.name || id}</option>;
              })}
            </select>
          <div className="tab-group">
            <button
              className={`tab ${statusFilter === 'all' ? 'active' : ''}`}
              onClick={() => setStatusFilter('all')}
            >
              全部
            </button>
            <button
              className={`tab ${statusFilter === 'enabled' ? 'active' : ''}`}
              onClick={() => setStatusFilter('enabled')}
            >
              已启用
            </button>
            <button
              className={`tab ${statusFilter === 'disabled' ? 'active' : ''}`}
              onClick={() => setStatusFilter('disabled')}
            >
              已禁用
            </button>
          </div>
          <div className="tab-group" data-testid="plugins-kind-filter">
            {PLUGIN_KIND_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`tab ${kindFilter === option.id ? 'active' : ''}`}
                onClick={() => setKindFilter(option.id)}
              >
                {t(option.labelKey)}
              </button>
            ))}
          </div>
        </div>

        {/* Loading skeleton */}
        {loading && pluginsList.length === 0 && (
          <div className="responsive-plugin-grid">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-4 flex flex-col"
              >
                {/* Plugin name + status badge + toggle row */}
                <div className="flex items-center gap-2 mb-2">
                  <div className="skeleton h-4 w-28" />
                  <div className="skeleton h-5 w-14 rounded-full ml-auto" />
                  <div className="skeleton h-5 w-8 rounded-full" />
                </div>
                {/* Description lines */}
                <div className="skeleton h-3 w-full mb-2" />
                <div className="skeleton h-3 w-3/4 mb-2" />
                {/* Meta badges area */}
                <div className="flex items-center gap-2 mb-3">
                  <div className="skeleton h-4 w-12 rounded" />
                  <div className="skeleton h-4 w-16 rounded" />
                </div>
                {/* Bottom actions area */}
                <div className="mt-auto pt-3 border-t border-[var(--color-border-muted)]">
                  <div className="skeleton h-3 w-10" />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loading && (filtered.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[var(--color-border-muted)] py-16 text-center">
            <p className="text-sm text-[var(--color-text-muted)]">
              {pluginsList.length === 0 ? '暂无已安装插件' : '无匹配插件'}
            </p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              {pluginsList.length === 0 ? '插件将在扫描后自动列出' : '尝试更换筛选条件'}
            </p>
          </div>
        ) : (
          <div ref={listScrollRef} className="plugins-list-scroll" data-testid="plugins-list-scroll">
            {filtered.length > PLUGIN_PAGE_SIZE ? (
              <div className="mb-3 flex items-center justify-between gap-2 text-[11px] text-[var(--color-text-muted)]">
                <span data-testid="plugins-infinite-range">
                  {t('plugins.infiniteRange', { visible: page.visible, total: page.total })}
                </span>
                <button
                  type="button"
                  className="btn-ghost px-2 py-1 text-[11px]"
                  data-testid="plugins-back-to-top"
                  onClick={() => {
                    const node = listScrollRef.current;
                    if (node && typeof node.scrollTo === 'function') node.scrollTo({ top: 0, behavior: 'smooth' });
                    else window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                >
                  {t('plugins.backToTop')}
                </button>
              </div>
            ) : null}
            <div className="responsive-plugin-grid">
            {page.items.map((p, idx) => {
              const enabled = isEnabled(p);
              const scope = p.installScope || p.scope;
              const marketplaceId = String(p.marketplace || '').trim();
              const pluginId = (() => { try { return pluginIdentity(p, marketplaceId); } catch (_) { return p.id || p.name; } })();
              const pluginScope = normalizedPluginScope(scope);
              const updateAvailable = validMaintenancePluginId(pluginId) && pluginCanEdit(p);
              const canToggle = pluginCanSwitchoff(p);
              const canRemove = pluginCanRemove(p);
              const author = typeof p.author === 'string' ? p.author : p.author?.name;
              const skillCount = Array.isArray(p.skills) ? p.skills.length : 0;
              const isExpanded = expandedPluginId === pluginId;
              return (
                <div
                  key={p.name || idx}
                  className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-4 flex flex-col"
                >
                  {/* Name + status + toggle */}
                  <div className="flex items-center gap-2 mb-2">
                    <button type="button" className="btn-icon" aria-label={`${isExpanded ? '收起' : '展开'}插件详情`} onClick={() => setExpandedPluginId(isExpanded ? '' : pluginId)}>{isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>
                    <span className="text-sm font-medium text-[var(--color-text-primary)] truncate flex-1">
                      {p.name || `插件 ${idx + 1}`}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium shrink-0 ${
                        enabled
                          ? 'bg-[rgba(74,222,128,0.1)] text-[#4ade80]'
                          : 'bg-[rgba(113,113,122,0.1)] text-[var(--color-text-muted)]'
                      }`}
                    >
                      {enabled ? '已启用' : '已禁用'}
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={enabled}
                      aria-label={`${enabled ? '禁用' : '启用'}插件 ${p.name}`}
                      className={`toggle-switch shrink-0 ${enabled ? 'toggle-switch-on' : 'toggle-switch-off'} ${pluginOperationActive ? 'opacity-50 pointer-events-none' : ''}`}
                      disabled={pluginOperationActive || !canToggle}
                      onClick={async () => {
                        const operation = beginPluginAction();
                        if (!operation) return;
                        const projectId = activeProjectId;
                        const generation = projectGenerationRef.current;
                        setActionError(null);
                        try {
                          const ok = await togglePluginByName(p.name, !enabled, p.marketplace);
                          if (projectId !== useStore.getState().activeProjectId || generation !== projectGenerationRef.current) return;
                          if (!ok) setActionError(useStore.getState().pluginError || '操作失败');
                        } finally {
                          finishPluginAction(operation);
                        }
                      }}
                      title={canToggle ? (enabled ? '点击禁用' : '点击启用') : '该插件不允许切换状态'}
                    >
                      <div className={`toggle-knob ${enabled ? 'toggle-knob-on' : ''}`} />
                    </button>
                  </div>

                  {/* Description */}
                  {p.description && (
                    <p className="text-xs text-[var(--color-text-muted)] line-clamp-2 mb-2">{p.description}</p>
                  )}

                  {/* Meta info */}
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px] text-[var(--color-text-muted)]">
                    {scope && <span className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5">{scope}</span>}
                    {p.marketplace && <span>{p.marketplace}</span>}
                    {p.version && <span>v{p.version}</span>}
                    {skillCount > 0 && <span>{skillCount} 个技能</span>}
                    {p.license && <span>{p.license}</span>}
                  </div>
                  {author ? <div className="mb-1 truncate text-[10px] text-[var(--color-text-muted)]" title={author}>作者：{author}</div> : null}
                  {p.installedPath ? <div className="mb-3 truncate text-[10px] text-[var(--color-text-muted)]" title={p.installedPath}>安装位置：{p.installedPath}</div> : null}

                  {isExpanded ? <div className="mb-3 border-t border-[var(--color-border-muted)] pt-2 text-[10px] text-[var(--color-text-muted)]"><div className="grid gap-1 sm:grid-cols-2">{p.category ? <span>类别：{p.category}</span> : null}{p.source ? <span>来源：{p.source}</span> : null}{p.homepage ? <a className="text-[var(--color-accent-blue)]" href={p.homepage} target="_blank" rel="noreferrer">主页 <ExternalLink size={11} className="inline" /></a> : null}{p.repository ? <span>仓库：{p.repository}</span> : null}{p.canEdit === false ? <span>不可编辑</span> : null}{p.canRemove === false ? <span>不可卸载</span> : null}{p.canSwitchoff === false ? <span>不可切换</span> : null}</div>{Array.isArray(p.keywords) && p.keywords.length ? <div className="mt-1">关键词：{p.keywords.join(', ')}</div> : null}{Array.isArray(p.features) && p.features.length ? <div className="mt-1">能力：{p.features.join(', ')}</div> : null}</div> : null}

                  {/* Maintenance actions */}
                  <div className="mt-auto flex items-center justify-between gap-2 border-t border-[var(--color-border-muted)] pt-2">
                    <button
                      className={`text-xs text-[var(--color-accent-blue)] hover:underline ${pluginOperationActive ? 'opacity-50 pointer-events-none' : ''}`}
                      disabled={pluginOperationActive || !updateAvailable || !activeWorkspacePath}
                      title={updateAvailable ? '更新到最新版本' : '当前插件未提供可用于 CLI 更新的 ID'}
                      onClick={() => openActionDialog({
                        type: 'update',
                        id: pluginId,
                        scope: pluginScope,
                        label: p.name || pluginId,
                        detail: `${PLUGIN_SCOPE_LABELS[pluginScope]}${p.version ? ` · 当前 v${p.version}` : ''}`,
                      })}
                    >
                      {maintenanceBusy === `update:${pluginId}` ? '更新中...' : '更新'}
                    </button>
                    <button
                      className={`text-xs text-[var(--color-error)] hover:underline ${pluginOperationActive ? 'opacity-50 pointer-events-none' : ''}`}
                      disabled={pluginOperationActive || !canRemove}
                      title={canRemove ? '卸载插件' : '该插件不允许卸载'}
                      onClick={() => openActionDialog({
                        type: 'uninstall',
                        id: pluginId,
                        marketplace: marketplaceId,
                        label: p.name || '未命名插件',
                        detail: p.description || '',
                      })}
                    >
                      {pluginBusy === `uninstall:${p.name}` ? '卸载中...' : '卸载'}
                    </button>
                  </div>
                </div>
              );
            })}
            </div>
            <div
              ref={loadMoreSentinelRef}
              className="py-3 text-center text-[11px] text-[var(--color-text-muted)]"
              data-testid="plugins-infinite-sentinel"
            >
              {page.hasMore ? t('plugins.infiniteLoading') : t('plugins.infiniteEnd')}
            </div>
          </div>
        ))}

        {/* Install Modal */}
        {showInstallModal && (
          <div className="overlay" onClick={(e) => { if (!installing && e.target === e.currentTarget) setShowInstallModal(false); }}>
            <div className="modal-content w-[420px]">
              <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border-default)]">
                <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">安装插件</h3>
                <button
                  className="btn-icon"
                  onClick={() => setShowInstallModal(false)}
                  disabled={installing}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M4 4l8 8M12 4l-8 8" />
                  </svg>
                </button>
              </div>
              <div className="px-5 py-4 space-y-3">
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">插件 ID</label>
                  <input
                    className="input-field"
                    type="text"
                    placeholder="输入插件 ID"
                    value={installId}
                    onChange={(e) => setInstallId(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">Marketplace</label>
                  <select className="input-field" value={installMarketplace} onChange={(e) => setInstallMarketplace(e.target.value)}>
                    <option value="">默认来源</option>
                    {(marketplaces || []).map((marketplace, index) => {
                      const id = marketplace.id || marketplace.name || marketplace.marketplaceId || `market-${index}`;
                      return <option key={id} value={id}>{marketplace.name || id}</option>;
                    })}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">安装作用域</label>
                  <select className="input-field" value={installScope} onChange={(event) => setInstallScope(event.target.value)}>
                    <option value="user">用户全局</option>
                    <option value="project">项目共享</option>
                    <option value="local">项目本机</option>
                  </select>
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--color-border-default)]">
                <button className="btn-ghost text-xs" disabled={installing} onClick={() => setShowInstallModal(false)}>取消</button>
                <button
                  className="btn-primary text-xs"
                  disabled={!installId.trim() || installing || pluginOperationActive}
                  onClick={async () => {
                    const pluginId = installId.trim();
                    if (!pluginId || installing) return;
                    const operation = beginPluginAction();
                    if (!operation) return;
                    const marketplace = installMarketplace;
                    const projectId = activeProjectId;
                    const generation = projectGenerationRef.current;
                    setInstalling(true);
                    setInstallMsg(null);
                    try {
                      const ok = await installPluginByName(pluginId, marketplace, { scope: installScope });
                      if (projectId !== useStore.getState().activeProjectId || generation !== projectGenerationRef.current) return;
                      if (ok) {
                        setShowInstallModal(false);
                        setInstallId('');
                      } else {
                        setInstallMsg(useStore.getState().pluginError || '安装失败');
                      }
                    } finally {
                      finishPluginAction(operation);
                      if (projectId === useStore.getState().activeProjectId && generation === projectGenerationRef.current) setInstalling(false);
                    }
                  }}
                >
                  {installing ? '安装中...' : '安装'}
                </button>
              </div>
              {installMsg && <div className="px-5 pb-3 text-xs text-[var(--color-error)]">{installMsg}</div>}
            </div>
          </div>
        )}


        {actionDialog ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4"
            role="dialog"
            aria-modal="true"
            aria-label={actionDialogTitle}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeActionDialog();
            }}
          >
            <div className="w-full max-w-sm rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-5 shadow-xl">
              <div className="text-sm font-semibold text-[var(--color-text-primary)]">
                {actionDialogTitle}
              </div>
              <div className="mt-3 text-xs leading-5 text-[var(--color-text-secondary)]">
                <div className="font-medium text-[var(--color-text-primary)]">{actionDialog.label}</div>
                {actionDialog.detail ? <div className="mt-1 break-words text-[var(--color-text-muted)]">{actionDialog.detail}</div> : null}
                <p className="mt-2">
                  {actionDialog.type === 'uninstall'
                    ? '插件及其提供的技能将从本机移除，需要时可以重新安装。'
                    : actionDialog.type === 'remove-marketplace'
                      ? '该市场来源将从配置中删除，已安装插件不会在此操作中卸载。'
                      : actionDialog.type === 'update'
                        ? '将优先通过 HTTP 更新，失败时回落 CLI。更新完成后需要重启项目运行时才能应用。'
                        : '将删除 dry-run 已确认的失效自动依赖。主动安装的插件不会被此操作移除。'}
                </p>
              </div>
              {actionDialogError ? <div className="mt-3 text-xs text-[var(--color-accent-red)]">{actionDialogError}</div> : null}
              <div className="mt-5 flex justify-end gap-2">
                <button className="btn-ghost px-3 py-1.5 text-xs" disabled={pluginOperationActive} onClick={closeActionDialog}>取消</button>
                <button
                  className={actionDialogDestructive ? 'rounded-md px-3 py-1.5 text-xs font-medium text-white' : 'btn-primary px-3 py-1.5 text-xs'}
                  style={actionDialogDestructive ? { background: 'var(--color-accent-red)' } : undefined}
                  disabled={pluginOperationActive}
                  onClick={confirmActionDialog}
                >
                  {pluginOperationActive ? '处理中...' : actionDialogConfirmLabel}
                </button>
              </div>
            </div>
          </div>
        ) : null}
        </section>

        <section id="plugins-panel-browse" role="tabpanel" hidden={activeTab !== 'browse'}>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <input className="input-field max-w-[280px]" placeholder="搜索可用插件..." value={browseQuery} onChange={(event) => setBrowseQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') runBrowseQuery(browseMarketId, browseQuery); }} />
            <select className="input-field w-auto min-w-[180px]" value={browseMarketId} onChange={(event) => { setBrowseMarketId(event.target.value); setBrowseMarket(event.target.value === '__all__' ? null : { id: event.target.value, label: event.target.options[event.target.selectedIndex]?.text }); }} aria-label="浏览市场">
              <option value="__all__">全部市场</option>
              {(marketplaces || []).map((marketplace, index) => {
                const id = marketplace.id || marketplace.marketplaceId || marketplace.name || marketplace.source || `market-${index}`;
                return <option key={id} value={id}>{marketplace.name || id}</option>;
              })}
            </select>
            <select className="input-field w-auto" value={browseScope} onChange={(event) => setBrowseScope(event.target.value)} aria-label="安装作用域">
              <option value="user">用户全局</option>
              <option value="project">项目共享</option>
              <option value="local">项目本机</option>
            </select>
            <button type="button" className="btn-ghost text-xs" disabled={browseLoading} onClick={() => loadBrowseResults(browseMarketId, browseQuery)}><RefreshCw size={14} className={browseLoading ? 'mr-1 inline animate-spin' : 'mr-1 inline'} />刷新</button>
          </div>
          {browseAllFailures > 0 && browseResults.length > 0 ? <div className="mb-3 text-xs text-[var(--color-accent-yellow)]">部分市场加载失败，已显示可用结果。</div> : null}
          {browseError ? <div className="mb-3 text-xs text-[var(--color-error)]">{browseError} <button type="button" className="ml-2 underline" onClick={() => loadBrowseResults(browseMarketId, browseQuery)}>重试</button></div> : null}
          {browseLoading ? <div className="py-12 text-center text-sm text-[var(--color-text-muted)]">加载中...</div> : browseResults.length === 0 ? <div className="rounded-lg border border-dashed border-[var(--color-border-muted)] py-16 text-center text-sm text-[var(--color-text-muted)]">{browseQuery ? '无搜索结果' : '暂无可用插件'}</div> : (
            <div className="space-y-3">
              {browseResults.map((plugin, index) => {
                const pid = (() => { try { return pluginIdentity(plugin); } catch (_) { return plugin.id || plugin.name || `plugin-${index}`; } })();
                const installed = isPluginInstalled(plugin, pluginsList);
                const expanded = expandedBrowseId === pid;
                const author = typeof plugin.author === 'string' ? plugin.author : plugin.author?.name;
                return <article key={pid} className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-4">
                  <div className="flex items-start gap-3"><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h3 className="truncate text-sm font-medium text-[var(--color-text-primary)]">{plugin.name || pid}</h3>{installed ? <span className="text-[10px] text-[var(--color-accent-green)]">已安装</span> : null}</div>{plugin.description ? <p className="mt-1 text-xs text-[var(--color-text-muted)]">{plugin.description}</p> : null}<div className="mt-2 flex flex-wrap gap-2 text-[10px] text-[var(--color-text-muted)]">{plugin.marketplace ? <span>{plugin.marketplace}</span> : null}{plugin.version ? <span>v{plugin.version}</span> : null}{plugin.category ? <span>{plugin.category}</span> : null}{author ? <span>{author}</span> : null}</div></div><div className="flex shrink-0 items-center gap-1"><button type="button" className="btn-icon" aria-label={`${expanded ? '收起' : '展开'}插件详情`} title="插件详情" onClick={() => setExpandedBrowseId(expanded ? '' : pid)}>{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button><button type="button" className="btn-primary px-2.5 py-1 text-xs" disabled={installing || installed} onClick={() => installFromBrowse(plugin.name || plugin.id || plugin.pluginId, plugin.marketplace, browseScope)}>{installed ? '已安装' : installing ? '安装中...' : '安装'}</button></div></div>
                  {expanded ? <div className="mt-3 border-t border-[var(--color-border-muted)] pt-3 text-xs text-[var(--color-text-secondary)]"><div className="grid gap-1 sm:grid-cols-2">{plugin.license ? <span>License：{plugin.license}</span> : null}{plugin.source ? <span>Source：{plugin.source}</span> : null}{plugin.homepage ? <a className="text-[var(--color-accent-blue)]" href={plugin.homepage} target="_blank" rel="noreferrer">Homepage <ExternalLink size={12} className="inline" /></a> : null}{plugin.repository ? <span>Repository：{plugin.repository}</span> : null}</div>{Array.isArray(plugin.keywords) && plugin.keywords.length ? <div className="mt-2">Keywords：{plugin.keywords.join(', ')}</div> : null}</div> : null}
                </article>;
              })}
            </div>
          )}
        </section>

        <section id="plugins-panel-marketplaces" role="tabpanel" hidden={activeTab !== 'marketplaces'}>

          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">插件市场</h2>
            <button
              type="button"
              onClick={async () => {
                const operation = beginMarketplaceAction();
                if (!operation || typeof syncMarketplaces !== 'function') return;
                const projectId = activeProjectId;
                const generation = projectGenerationRef.current;
                setMktBusy(true);
                setMktMsg(null);
                try {
                  const ok = await syncMarketplaces(true);
                  if (projectId === useStore.getState().activeProjectId && generation === projectGenerationRef.current && !ok) setMktMsg(useStore.getState().marketplaceError || '同步市场失败');
                } finally {
                  finishMarketplaceAction(operation);
                  if (projectId === useStore.getState().activeProjectId && generation === projectGenerationRef.current) setMktBusy(false);
                }
              }}
              disabled={mktBusy || pluginOperationActive || typeof syncMarketplaces !== 'function'}
              className="btn-ghost text-xs"
              title="同步市场内容"
            >
              <RefreshCw size={13} className={mktBusy ? 'mr-1 inline animate-spin' : 'mr-1 inline'} />同步
            </button>

            <button
              type="button"
              onClick={async () => {
                const operation = beginMarketplaceAction();
                if (!operation) return;
                const projectId = activeProjectId;
                const generation = projectGenerationRef.current;
                setMktBusy(true);
                setMktMsg(null);
                try {
                  const ok = await refreshMarketplaces?.();
                  if (projectId !== useStore.getState().activeProjectId || generation !== projectGenerationRef.current) return;
                  if (ok === false) setMktMsg(useStore.getState().marketplaceError || '刷新市场失败');
                } finally {
                  finishMarketplaceAction(operation);
                  if (projectId === useStore.getState().activeProjectId && generation === projectGenerationRef.current) setMktBusy(false);
                }
              }}
              disabled={mktBusy || pluginOperationActive}
              className="btn-ghost text-xs"
              title="刷新市场列表"
            >
              <RefreshCw size={13} className={mktBusy ? 'mr-1 inline animate-spin' : 'mr-1 inline'} />刷新
            </button>
          </div>

          {/* 新增市场表单 */}
          <div className="responsive-market-form mb-4">
                <input
                  value={newMktId}
                  onChange={(e) => setNewMktId(e.target.value)}
                  placeholder="名称（可选）"
                  className="input-field"
                  aria-label="市场名称"
                />
                <input
                  value={newMktUrl}
                  onChange={(e) => setNewMktUrl(e.target.value)}
                  placeholder="市场源（https://...）"
                  className="input-field"
                  aria-label="市场源"
                />
            <label className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
              <input
                type="checkbox"
                checked={newMktAutoUpdate}
                onChange={(e) => setNewMktAutoUpdate(e.target.checked)}
                data-testid="marketplace-auto-update-on-add"
              />
              {t('plugins.autoUpdateOnAdd')}
            </label>
            <button
              className="btn-primary text-xs"
              disabled={mktBusy || pluginOperationActive || !newMktUrl.trim()}
              onClick={async () => {
                const marketplaceUrl = newMktUrl.trim();
                const marketplaceId = newMktId.trim() || marketplaceUrl;
                if (!marketplaceId || !marketplaceUrl) return;
                const operation = beginMarketplaceAction();
                if (!operation) return;
                const projectId = activeProjectId;
                const generation = projectGenerationRef.current;
                setMktBusy(true);
                setMktMsg(null);
                try {
                  const ok = await addMarketplaceById(marketplaceId, {
                    url: marketplaceUrl,
                    name: newMktId.trim() || undefined,
                    autoUpdate: newMktAutoUpdate,
                  });
                  if (projectId !== useStore.getState().activeProjectId || generation !== projectGenerationRef.current) return;
                  if (ok) {
                    setNewMktId((current) => current.trim() === marketplaceId ? '' : current);
                    setNewMktUrl((current) => current.trim() === marketplaceUrl ? '' : current);
                  } else {
                    setMktMsg(useStore.getState().marketplaceError || '新增市场失败');
                  }
                } finally {
                  finishMarketplaceAction(operation);
                  if (projectId === useStore.getState().activeProjectId && generation === projectGenerationRef.current) setMktBusy(false);
                }
              }}
            >
              {mktBusy && pluginBusy?.startsWith('addMkt:') ? '添加中...' : '添加市场'}
            </button>
          </div>
          {mktMsg && <div className="mb-3 text-xs text-[var(--color-error)]">{mktMsg}</div>}
          {marketplaceError && pluginBusy?.startsWith('rmMkt:') && <div className="mb-3 text-xs text-[var(--color-error)]">{marketplaceError}</div>}

          {/* 市场列表 */}
          {(marketplaces || []).length === 0 ? (
            <div className="rounded-md border border-dashed border-[var(--color-border-muted)] py-6 text-center text-xs text-[var(--color-text-muted)]">
              暂无市场，添加上方表单注册一个
            </div>
          ) : (
            <div className="space-y-1.5">
              {(marketplaces || []).map((mkt, idx) => {
                const id = mkt.id || mkt.marketplaceId || mkt.name || `mkt-${idx}`;
                const busy = pluginBusy === `rmMkt:${id}` || pluginBusy === `autoMkt:${id}`;
                const hasAutoUpdateField = typeof mkt.autoUpdate === 'boolean'
                  || typeof mkt.auto_update === 'boolean';
                const autoUpdateOn = mkt.autoUpdate === true || mkt.auto_update === true;
                return (
                  <div key={id} className="flex items-center gap-2 rounded-md border border-[var(--color-border-muted)] bg-[var(--color-bg-primary)] px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="truncate text-xs font-medium text-[var(--color-text-primary)]">{mkt.name || id}</div>
                        {mkt.type && <span className="shrink-0 rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">{mkt.type}</span>}
                      </div>
                      {mkt.description && <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-muted)]" title={mkt.description}>{mkt.description}</div>}
                      {(mkt.source || mkt.url) && <div className="truncate text-[11px] text-[var(--color-text-muted)]" title={mkt.source || mkt.url}>{mkt.source || mkt.url}</div>}
                    </div>
                    {hasAutoUpdateField && typeof setMarketplaceAutoUpdateById === 'function' ? (
                      <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-[var(--color-text-secondary)]" title={t('plugins.autoUpdate')}>
                        <input
                          type="checkbox"
                          checked={autoUpdateOn}
                          disabled={mktBusy || pluginOperationActive}
                          data-testid={`marketplace-auto-update-${id}`}
                          onChange={async (event) => {
                            const operation = beginMarketplaceAction();
                            if (!operation) return;
                            const projectId = activeProjectId;
                            const generation = projectGenerationRef.current;
                            setMktMsg(null);
                            try {
                              const ok = await setMarketplaceAutoUpdateById(id, event.target.checked);
                              if (projectId !== useStore.getState().activeProjectId || generation !== projectGenerationRef.current) return;
                              if (!ok) setMktMsg(useStore.getState().marketplaceError || '切换自动更新失败');
                            } finally {
                              finishMarketplaceAction(operation);
                            }
                          }}
                        />
                        {t('plugins.autoUpdate')}
                      </label>
                    ) : null}
                    <button
                      disabled={mktBusy || pluginOperationActive}
                      className="btn-ghost shrink-0 text-xs"
                      onClick={() => openBrowseMarketplace(id, mkt.name || id)}
                    >
                      浏览
                    </button>
                    <button
                      disabled={mktBusy || pluginOperationActive}
                      className="btn-ghost shrink-0 text-xs text-[var(--color-error)]"
                      onClick={() => openActionDialog({
                        type: 'remove-marketplace',
                        id,
                        label: mkt.name || id,
                        detail: mkt.source || mkt.url || mkt.description || '',
                      })}
                    >
                      {busy ? '处理中...' : '删除'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/* Legacy browse modal is retained only for backward-compatible callers. */}
      {browseMarket ? (
        <div className="overlay" onClick={(e) => { if (!browseLoading && !installing && e.target === e.currentTarget) closeBrowseMarketplace(); }}>
          <div className="modal-content w-[560px] max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border-default)]">
              <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">浏览市场 · {browseMarket.label}</h3>
              <button className="btn-icon" onClick={closeBrowseMarketplace} disabled={browseLoading || installing}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </div>
            <div className="px-5 py-3 border-b border-[var(--color-border-muted)]">
              <input
                className="input-field"
                type="text"
                placeholder="搜索插件名称或描述"
                value={browseQuery}
                onChange={(e) => setBrowseQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') runBrowseQuery(browseMarket.id, browseQuery); }}
              />
              <div className="mt-2 flex justify-end">
                <button className="btn-ghost text-xs" disabled={browseLoading} onClick={() => runBrowseQuery(browseMarket.id, browseQuery)}>
                  {browseLoading ? '搜索中...' : '搜索'}
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-3">
              {browseError ? (
                <div className="text-xs text-[var(--color-error)]">{browseError}</div>
              ) : browseLoading ? (
                <div className="py-8 text-center text-xs text-[var(--color-text-muted)]">加载中...</div>
              ) : browseResults.length === 0 ? (
                <div className="py-8 text-center text-xs text-[var(--color-text-muted)]">该市场暂无可用插件</div>
              ) : (
                <div className="space-y-2">
                  {browseResults.map((plugin, index) => {
                    const pid = plugin.id || plugin.name || plugin.pluginId || `plugin-${index}`;
                    const name = plugin.name || pid;
                    const desc = plugin.description || plugin.summary || '';
                    const alreadyInstalled = (plugins || []).some((p) => p.name === name || p.id === pid);
                    return (
                      <div key={pid} className="flex items-start gap-3 rounded-md border border-[var(--color-border-muted)] bg-[var(--color-bg-primary)] px-3 py-2">
                        <div className="flex-1 min-w-0">
                          <div className="truncate text-xs font-medium text-[var(--color-text-primary)]">{name}</div>
                          {desc ? <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)] line-clamp-2">{desc}</div> : null}
                        </div>
                        <button
                          className="btn-ghost shrink-0 text-xs"
                          disabled={installing || alreadyInstalled}
                          onClick={() => installFromBrowse(pid, browseMarket.id)}
                        >
                          {alreadyInstalled ? '已安装' : '安装'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              {installMsg ? <div className="mt-3 text-xs text-[var(--color-text-secondary)]">{installMsg}</div> : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
