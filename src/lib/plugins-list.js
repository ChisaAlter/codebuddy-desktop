/**
 * Pure helpers for plugin list filtering and client-side infinite scroll.
 */

export const PLUGIN_KIND_ALL = 'all';
export const PLUGIN_KIND_OPTIONS = [
  { id: 'all', labelKey: 'plugins.kind.all' },
  { id: 'skills', labelKey: 'plugins.kind.skills' },
  { id: 'mcp', labelKey: 'plugins.kind.mcp' },
  { id: 'hooks', labelKey: 'plugins.kind.hooks' },
  { id: 'tools', labelKey: 'plugins.kind.tools' },
  { id: 'other', labelKey: 'plugins.kind.other' },
];

export function qualifyPluginId(pluginId, marketplace) {
  const id = String(pluginId || '').trim();
  if (!id) throw new Error('plugin name 不能为空');
  const marketplaceId = String(marketplace || '').trim();
  if (!marketplaceId) return id;
  const marketplaceSeparator = id.lastIndexOf('@');
  const packageSlash = id.lastIndexOf('/');
  return marketplaceSeparator > packageSlash ? id : `${id}@${marketplaceId}`;
}

export function pluginIdentity(plugin, marketplace) {
  if (typeof plugin === 'string') return qualifyPluginId(plugin, marketplace);
  const value = plugin || {};
  return qualifyPluginId(value.id || value.pluginId || value.name, marketplace || value.marketplace);
}

export function normalizePluginRecord(plugin, marketplace) {
  if (!plugin || typeof plugin !== 'object') return null;
  const sourceMarketplace = marketplace || plugin.marketplace || plugin.sourceName;
  const identity = (() => {
    try { return pluginIdentity(plugin, sourceMarketplace); } catch (_) { return ''; }
  })();
  return {
    ...plugin,
    ...(sourceMarketplace ? { marketplace: sourceMarketplace } : {}),
    ...(identity ? { pluginId: identity } : {}),
  };
}

export function pluginIdentityKey(plugin, marketplace) {
  const identity = pluginIdentity(plugin, marketplace);
  return identity.toLowerCase();
}

export function dedupePluginsByIdentity(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).filter((plugin) => {
    let key = '';
    try { key = pluginIdentityKey(plugin); } catch (_) {}
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function isPluginInstalled(plugin, installedPlugins) {
  const target = (() => {
    try { return pluginIdentityKey(plugin); } catch (_) { return ''; }
  })();
  if (!target) return false;
  return (Array.isArray(installedPlugins) ? installedPlugins : []).some((item) => {
    try { return pluginIdentityKey(item) === target; } catch (_) { return false; }
  });
}

export function pluginSearchText(plugin) {
  if (!plugin || typeof plugin !== 'object') return '';
  const values = [
    plugin.name,
    plugin.id,
    plugin.pluginId,
    plugin.description,
    plugin.marketplace,
    plugin.version,
    plugin.category,
    plugin.author?.name || plugin.author,
    plugin.license,
    plugin.homepage,
    plugin.repository,
    ...(Array.isArray(plugin.keywords) ? plugin.keywords : []),
    ...(Array.isArray(plugin.features) ? plugin.features : []),
    ...(Array.isArray(plugin.skills) ? plugin.skills.map((s) => s?.name || s) : []),
  ];
  return values.filter(Boolean).join(' ').toLowerCase();
}

export function pluginIsEnabled(plugin) {
  return plugin?.status === 'enabled' || plugin?.enabled === true;
}

export function pluginCanSwitchoff(plugin) {
  return plugin?.canSwitchoff !== false;
}

export function pluginCanRemove(plugin) {
  return plugin?.canRemove !== false;
}

export function pluginCanEdit(plugin) {
  return plugin?.canEdit !== false;
}

export async function aggregateMarketplacePlugins(marketplaces, browse) {
  const sources = (Array.isArray(marketplaces) ? marketplaces : [])
    .map((marketplace, index) => ({
      id: marketplace?.id || marketplace?.marketplaceId || marketplace?.name || marketplace?.source,
      label: marketplace?.name || marketplace?.id || marketplace?.marketplaceId || marketplace?.source || `market-${index}`,
    }))
    .filter((marketplace) => marketplace.id);
  const settled = await Promise.allSettled(sources.map(async (marketplace) => {
    const results = await browse(marketplace.id);
    return (Array.isArray(results) ? results : []).map((plugin) => normalizePluginRecord(plugin, marketplace.id));
  }));
  const results = [];
  let failures = 0;
  settled.forEach((entry, _index) => {
    if (entry.status === 'fulfilled') results.push(...entry.value.filter(Boolean));
    else failures += 1;
  });
  return {
    plugins: dedupePluginsByIdentity(results),
    failures,
    total: sources.length,
  };
}
export function detectPluginKind(plugin) {
  if (!plugin || typeof plugin !== 'object') return 'other';
  const explicit = String(plugin.kind || plugin.type || plugin.category || '').toLowerCase();
  if (['skill', 'skills'].includes(explicit)) return 'skills';
  if (['mcp', 'mcp-server', 'mcpserver'].includes(explicit)) return 'mcp';
  if (['hook', 'hooks'].includes(explicit)) return 'hooks';
  if (['tool', 'tools'].includes(explicit)) return 'tools';

  const skillCount = Array.isArray(plugin.skills) ? plugin.skills.length : 0;
  const mcpCount = Array.isArray(plugin.mcpServers)
    ? plugin.mcpServers.length
    : plugin.mcp
      ? 1
      : 0;
  const hookCount = Array.isArray(plugin.hooks) ? plugin.hooks.length : 0;
  const toolCount = Array.isArray(plugin.tools) ? plugin.tools.length : 0;
  const hits = [
    skillCount > 0 ? 'skills' : null,
    mcpCount > 0 ? 'mcp' : null,
    hookCount > 0 ? 'hooks' : null,
    toolCount > 0 ? 'tools' : null,
  ].filter(Boolean);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    const scored = [
      ['skills', skillCount],
      ['mcp', mcpCount],
      ['hooks', hookCount],
      ['tools', toolCount],
    ].sort((a, b) => b[1] - a[1]);
    if (scored[0][1] > 0) return scored[0][0];
  }
  return 'other';
}


export function filterPlugins(list, { query = '', status = 'all', kind = 'all' } = {}) {
  const term = String(query || '').trim().toLowerCase();
  return (Array.isArray(list) ? list : []).filter((p) => {
    if (!p) return false;
    const enabled = p.status === 'enabled' || p.enabled === true;
    if (status === 'enabled' && !enabled) return false;
    if (status === 'disabled' && enabled) return false;
    if (kind && kind !== 'all' && detectPluginKind(p) !== kind) return false;
    if (!term) return true;
    return pluginSearchText(p).includes(term);
  });
}

/**
 * Client-side infinite scroll window.
 * @returns {{ items: any[], visible: number, total: number, hasMore: boolean }}
 */
export function slicePluginPage(list, visibleCount, pageSize = 30) {
  const total = Array.isArray(list) ? list.length : 0;
  const size = Math.max(1, Number(pageSize) || 30);
  const visible = Math.min(total, Math.max(0, Number(visibleCount) || size));
  return {
    items: (list || []).slice(0, visible),
    visible,
    total,
    hasMore: visible < total,
    nextVisible: Math.min(total, visible + size),
  };
}
