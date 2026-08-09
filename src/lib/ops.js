import { getApiBase, fetchJson, requestCodeBuddy } from './acp';
import { qualifyPluginId } from './plugins-list';

async function requestOptionalJson(path, init = {}) {
  const response = await requestCodeBuddy(path, init);
  const text = response.status === 204 ? '' : await response.text().catch(() => '');
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch (_) { payload = text; }
  }
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.error || payload?.message;
    throw new Error(detail || `${response.status} ${response.statusText}`);
  }
  return payload?.data ?? payload ?? null;
}

export async function fetchSessionStats(sessionId) {
  if (!sessionId) return null;
  const payload = await fetchJson(`/api/v1/stats/session?sessionId=${encodeURIComponent(sessionId)}`);
  return payload.data || payload;
}

/** 全局统计（GET /api/v1/stats），当前契约含会话、活跃、modelUsage、toolUsage 和 dailyActivity 等数据。 */
export async function fetchStats() {
  const payload = await fetchJson('/api/v1/stats');
  return payload.data || payload || null;
}

export async function fetchScheduledTasks(sessionId) {
  if (!sessionId) return [];
  const payload = await fetchJson(`/api/v1/scheduled-tasks?sessionId=${encodeURIComponent(sessionId)}`);
  return payload.data?.tasks || payload.tasks || [];
}

export async function createScheduledTask(sessionId, cron, prompt) {
  const payload = await fetchJson('/api/v1/scheduled-tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, cron, prompt, recurring: true, durable: true }),
  });
  return payload.data || payload;
}

export async function fetchTraceList() {
  const payload = await fetchJson('/api/v1/traces?offset=0&limit=100');
  return payload.data?.traces || payload.traces || [];
}

export async function fetchWorkerLogs(workerPid, type = 'stdout', tail = 200) {
  if (!workerPid) return '';
  const payload = await fetchJson(`/api/v1/workers/${encodeURIComponent(workerPid)}/logs?type=${encodeURIComponent(type)}&tail=${encodeURIComponent(tail)}`);
  const data = payload?.data ?? payload;
  if (typeof data === 'string') {
    return { content: data, type, availableTypes: [type], logPath: '' };
  }
  return {
    content: typeof data?.content === 'string' ? data.content : '',
    type: data?.type || type,
    availableTypes: Array.isArray(data?.availableTypes) && data.availableTypes.length ? data.availableTypes : [type],
    logPath: data?.logPath || '',
  };
}

// ===== Sessions 管理 =====

/** 删除会话（对照源 DELETE /api/v1/sessions/{id}） */
export async function deleteSession(sessionId) {
  if (!sessionId) return;
  return requestOptionalJson(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    timeoutMs: 10000,
  });
}

/** 重命名会话（对照源 POST /api/v1/sessions/{id}/rename {name}） */
export async function renameSession(sessionId, name) {
  if (!sessionId) return null;
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('会话名不能为空');
  const payload = await fetchJson(`/api/v1/sessions/${encodeURIComponent(sessionId)}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: trimmed }),
  });
  return payload?.data || payload || null;
}

// ===== Scheduled Tasks 管理 =====

/** 删除定时任务 */
export async function deleteScheduledTask(taskId, sessionId) {
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
  return requestOptionalJson(`/api/v1/scheduled-tasks/${encodeURIComponent(taskId)}${query}`, {
    method: 'DELETE',
  });
}

// ===== Channels 管理 =====


/**
 * Channel 实例动作。当前 CodeBuddy 契约支持 start、stop 和 unbind。
 * @param {string} type - channel 类型，如 'wechat'|'wecom'|'discord'
 * @param {string} instanceId - 实例 id
 * @param {'start'|'stop'|'unbind'} action - 后端支持的动作名
 * @returns {Promise<object>} 后端响应；微信解绑会返回 needsQrScan=true
 */
export async function channelAction(type, instanceId, action) {
  if (!type || !instanceId || !action) throw new Error('type/instanceId/action 均不可为空');
  const payload = await fetchJson(`/api/v1/channels/${encodeURIComponent(type)}/${encodeURIComponent(instanceId)}/${encodeURIComponent(action)}`, {
    method: 'POST',
  });
  return payload?.data ?? payload ?? null;
}

/** 删除 channel 实例（对照源 DELETE /channels/{type}/{instance}） */
export async function deleteChannelInstance(type, instanceId) {
  if (!type || !instanceId) throw new Error('type/instanceId 均不可为空');
  const response = await requestCodeBuddy(`/api/v1/channels/${encodeURIComponent(type)}/${encodeURIComponent(instanceId)}`, {
    method: 'DELETE',
    timeoutMs: 15000,
  });
  if (!response.ok) {
    let msg = `${response.status} ${response.statusText}`;
    try { const e = await response.json(); if (e?.error) msg = e.error; } catch (_) {}
    throw new Error(msg);
  }
  const text = await response.text().catch(() => '');
  try { const parsed = JSON.parse(text); return parsed?.data || parsed || null; } catch (_) { return null; }
}

// ===== Channels: 微信/企微专属（对照源 POST /api/v1/channels/wechat|wecom）=====
// 微信：POST /api/v1/channels/wechat -> {instanceId}；二维码 GET /api/v1/channels/wechat/{id}/qr
// 企微：POST /api/v1/channels/wecom {botId,secret} -> 实例

/** 创建微信机器人 channel 实例，回 instanceId */
export async function createWechatChannel() {
  const payload = await fetchJson('/api/v1/channels/wechat', { method: 'POST' });
  return payload?.data || payload || null;
}

/** 拉微信登录二维码（对照源 GET /api/v1/channels/wechat/{instanceId}/qr）
 *  返回 { ok, qrData?: string, error?: string }
 *  bundle 未明示 body 形状，按 REST 约定尝试解析为 JSON 或直接返回 text blob
 */
export async function fetchWechatQr(instanceId) {
  if (!instanceId) return { ok: false, error: 'missing instanceId' };
  const response = await requestCodeBuddy(`/api/v1/channels/wechat/${encodeURIComponent(instanceId)}/qr`, {
    method: 'GET',
    timeoutMs: 15000,
  });
  if (!response.ok) {
    let msg = `${response.status} ${response.statusText}`;
    try { const e = await response.json(); if (e?.error) msg = e.error; } catch (_) {}
    return { ok: false, error: msg };
  }
  const ct = response.headers.get('content-type') || '';
  if (ct.includes('image/')) {
    // 后端可能直返二进制图：转 dataURL 供 <img src> 渲染
    const blob = await response.blob();
    return { ok: true, qrImage: await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => res('');
      fr.readAsDataURL(blob);
    }) };
  }
  // JSON 或 text：尝试取 url/base64 字段
  const text = await response.text();
  try {
    const json = JSON.parse(text);
    const data = json?.data ?? json ?? {};
    const type = data.type || '';
    const message = data.message || '';
    const directImage = data.qrImage || data.image || data.base64 || data.qrcode;
    if (directImage) {
      const imageValue = String(directImage).trim();
      const qrImage = /^(data:image\/|blob:|https?:\/\/)/i.test(imageValue)
        ? imageValue
        : `data:image/png;base64,${imageValue.replace(/\s+/g, '')}`;
      return { ok: true, qrImage, type, message, raw: data };
    }
    const qrContent = data.qrUrl || data.qrData || data.url || (typeof data === 'string' ? data : null);
    if (qrContent) {
      const contentValue = String(qrContent).trim();
      if (/^(data:image\/|blob:)/i.test(contentValue)) {
        return { ok: true, qrImage: contentValue, type, message, raw: data };
      }
      if (contentValue.length > 128 && /^[A-Za-z0-9+/=\s]+$/.test(contentValue)) {
        return {
          ok: true,
          qrImage: `data:image/png;base64,${contentValue.replace(/\s+/g, '')}`,
          type,
          message,
          raw: data,
        };
      }
      const { default: QRCode } = await import('qrcode');
      return {
        ok: true,
        qrImage: await QRCode.toDataURL(contentValue, { width: 240, margin: 1, errorCorrectionLevel: 'M' }),
        type,
        message,
        raw: data,
      };
    }
    if (type === 'error') return { ok: false, type, message, error: message || '二维码获取失败', raw: data };
    return { ok: true, type, message, raw: data };
  } catch (_) {
    return { ok: false, error: '二维码响应格式无法识别', raw: text };
  }
}

/** 创建企微机器人 channel（对照源 POST /api/v1/channels/wecom {botId, secret}） */
export async function createWecomChannel({ botId, secret } = {}) {
  if (!botId || !secret) throw new Error('botId 与 secret 均不可为空');
  const payload = await fetchJson('/api/v1/channels/wecom', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ botId: String(botId).trim(), secret: String(secret).trim() }),
  });
  return payload?.data || payload || null;
}

/** 终止 worker（对照源 DELETE /api/v1/workers/{pid}） */
export async function stopWorker(pid) {
  return requestOptionalJson(`/api/v1/workers/${encodeURIComponent(pid)}`, {
    method: 'DELETE',
  });
}

// ===== Plugin 管理 =====

/** 安装插件 */
export async function installPlugin(pluginId, marketplace, options = {}) {
  const plugin = qualifyPluginId(pluginId, marketplace);
  const body = { plugin };
  const scope = options.scope || (typeof options === 'string' ? options : '');
  if (scope) body.options = { scope: String(scope) };
  const payload = await fetchJson('/api/v1/plugins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return payload?.data || payload || null;
}

/** 卸载插件（对照源 bundle：POST /api/v1/plugins/uninstall {plugin}）
 *  注意：对照源用 POST /uninstall + body={plugin:<name>}，不是 DELETE /plugins/{id}。
 *  保留旧 uninstallPlugin 名，改走真实路径；调用方传 plugin 名而非 id。
 */
export async function uninstallPlugin(pluginName, marketplace) {
  const plugin = qualifyPluginId(pluginName, marketplace);
  const payload = await fetchJson('/api/v1/plugins/uninstall', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plugin }),
  });
  return payload?.data || payload || null;
}

/**
 * @deprecated 使用 uninstallPlugin(pluginName)
 * 旧 DELETE /plugins/{id} 路径保留为兜底（后端可能两条都支持）
 */
export async function uninstallPluginById(pluginId) {
  const payload = await fetchJson(`/api/v1/plugins/${encodeURIComponent(pluginId)}`, {
    method: 'DELETE',
  });
  return payload?.data || payload || null;
}

/** 启用插件 */
export async function enablePlugin(pluginId, marketplace) {
  const plugin = qualifyPluginId(pluginId, marketplace);
  const payload = await fetchJson('/api/v1/plugins/enable', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plugin }),
  });
  return payload?.data || payload || null;
}

/** 禁用插件 */
export async function disablePlugin(pluginId, marketplace) {
  const plugin = qualifyPluginId(pluginId, marketplace);
  const payload = await fetchJson('/api/v1/plugins/disable', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plugin }),
  });
  return payload?.data || payload || null;
}

/**
 * @deprecated 使用 enablePlugin / disablePlugin
 * 启用/禁用插件
 */
export async function togglePlugin(pluginId, enabled) {
  const payload = await fetchJson(`/api/v1/plugins/${encodeURIComponent(pluginId)}/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  return payload.data || payload;
}

/** 搜索可用插件 */
export async function searchPlugins(query) {
  const payload = await fetchJson(`/api/v1/plugins/search?q=${encodeURIComponent(query)}`);
  return payload.data?.plugins || payload.plugins || [];
}

// ===== Tasks Templates 管理 =====
// 对照源 GET /api/v1/tasks/templates{?sessionId} -> {templates[], error?, status}
//          POST /api/v1/tasks/templates/refresh{?sessionId} -> 同
export async function fetchTaskTemplates(sessionId) {
  const params = new URLSearchParams();
  if (sessionId) params.set('sessionId', sessionId);
  const qs = params.toString();
  const payload = await fetchJson(`/api/v1/tasks/templates${qs ? '?' + qs : ''}`);
  const data = payload?.data ?? payload ?? {};
  return {
    templates: data.templates || [],
    error: data.error || null,
    status: data.status || null,
  };
}

export async function refreshTaskTemplates(sessionId) {
  const params = new URLSearchParams();
  if (sessionId) params.set('sessionId', sessionId);
  const qs = params.toString();
  const payload = await fetchJson(`/api/v1/tasks/templates/refresh${qs ? '?' + qs : ''}`, {
    method: 'POST',
  });
  const data = payload?.data ?? payload ?? {};
  return {
    templates: data.templates || [],
    error: data.error || null,
    status: data.status || null,
  };
}

// ===== Trace 管理 =====

/** 获取 trace 详情 */
export async function fetchTraceDetail(traceId) {
  const payload = await fetchJson(`/api/v1/traces/${encodeURIComponent(traceId)}`);
  return payload.data || payload;
}

/** 搜索/筛选 traces */
export async function searchTraces(params = {}) {
  const query = new URLSearchParams();
  if (params.offset !== undefined) query.set('offset', params.offset);
  if (params.limit !== undefined) query.set('limit', params.limit);
  if (params.service) query.set('service', params.service);
  if (params.status) query.set('status', params.status);
  const payload = await fetchJson(`/api/v1/traces?${query.toString()}`);
  return {
    traces: payload.data?.traces || payload.traces || [],
    total: payload.data?.total || payload.total || 0,
  };
}

// ===== 自定义模型（对照 WebUI ModelsController：POST /models/custom/*）=====

async function postModelsCustom(path, body = {}, baseUrl = '') {
  const normalizedBase = String(baseUrl || '').replace(/\/$/, '');
  const candidates = [`/models/custom/${path}`, `/api/v1/models/custom/${path}`];
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const payload = await fetchJson(`${normalizedBase}${candidate}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      return payload?.data && typeof payload.data === 'object' && Array.isArray(payload.data.models)
        ? payload.data
        : payload;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || '');
      // 路径不存在时换候选；其它错误直接抛出
      if (!/404|Not Found|Unexpected response/i.test(message)) throw error;
    }
  }
  throw lastError || new Error(`models/custom/${path} 不可用`);
}

/** 列出用户级自定义模型（WebUI uQ） */
export async function listCustomModels(baseUrl = '', global = true) {
  return postModelsCustom('list', { global }, baseUrl);
}

/**
 * 保存自定义模型并触发 product sync（WebUI hQ）。
 * visible 默认 false，与官方 WebUI 一致：自定义模型经 models.json 的 models[]
 * 由 CLI 自动合并进可选列表，不触发 availableModels 白名单写入。
 * 显式传 visible:true 会触发 CLI product-sync 把模型加入会话 availableModels，
 * 历史上曾导致 CLI 把 custom-only 白名单写回 models.json 并当成硬白名单，
 * 丢弃所有账号/内置模型——除非有明确理由并记录在 CODEBUDDY.md，否则不要传 true。
 * @param {{model: object, previousId?: string, visible?: boolean, global?: boolean}} payload
 */
export async function saveCustomModel(payload = {}, baseUrl = '') {
  return postModelsCustom(
    'save',
    {
      model: payload.model,
      previousId: payload.previousId,
      visible: payload.visible === true,
      global: payload.global !== false,
    },
    baseUrl,
  );
}

/** 删除自定义模型（WebUI pQ） */
export async function deleteCustomModel(id, baseUrl = '', global = true) {
  return postModelsCustom('delete', { id, global }, baseUrl);
}

// ===== Settings 管理 =====

/**
 * 单项细粒度写（对照源 bundle：PUT /api/v1/settings/{rootKey}?scope=user body {value}）
 * - key 含点 "." 时：PUT 根键，value 为已在本地合并后的对象（对照源 A(I,T) 逻辑）
 * - 例如 memory.enabled → PUT /settings/memory { value: { ...memory, enabled } }
 * @param {string} key - 设置项 key 或根键，如 "theme" / "memory"
 * @param {*} value - 写入体；嵌套项应传入合并后的根对象
 * @param {string} [scope='user'] - 命名空间，对照源固定 user
 * @param {string} [baseUrl=''] - 固定写入的项目运行时地址
 * @param {{authToken?: string|null, acpSessionToken?: string|null}} [requestContext] - 写入发起时的认证上下文
 * @returns {Promise<object>}
 */
export async function updateSettingByKey(key, value, scope = 'user', baseUrl = '', requestContext = {}) {
  if (!key) throw new Error('setting key 不能为空');
  const rootKey = String(key).split('.')[0];
  if (!rootKey) throw new Error('setting key 不能为空');
  const params = new URLSearchParams();
  if (scope) params.set('scope', scope);
  const qs = params.toString();
  const normalizedBase = String(baseUrl || '').replace(/\/$/, '');
  const payload = await fetchJson(
    `${normalizedBase}/api/v1/settings/${encodeURIComponent(rootKey)}${qs ? '?' + qs : ''}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(requestContext.authToken ? { Authorization: `Bearer ${requestContext.authToken}` } : {}),
        ...(requestContext.acpSessionToken ? { 'acp-session-token': requestContext.acpSessionToken } : {}),
      },
      omitAuthToken: true,
      omitAcpSessionToken: true,
      body: JSON.stringify({ value }),
    },
  );
  return payload?.data || payload || null;
}

// ===== Metrics 管理 =====

/** 带时间范围的 metrics 查询 */
export async function fetchMetricsRange(from, to) {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const payload = await fetchJson(`/api/v1/metrics?${params.toString()}`);
  return payload.data || payload;
}

// ===== 多端点批量代理 =====

/** 认证状态 */
export async function fetchAuthStatus() {
  const payload = await fetchJson('/api/v1/auth/status');
  return payload.data || payload;
}

// ===== Daemon 管理 =====

/** 获取 daemon 运行状态 */
export async function fetchDaemonStatus() {
  const payload = await fetchJson('/api/v1/daemon/status');
  return payload.data || payload;
}

/** 启动 daemon */
export async function startDaemon() {
  const payload = await fetchJson('/api/v1/daemon/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  return payload.data || payload;
}

/** 停止 daemon */
export async function stopDaemon() {
  return requestOptionalJson('/api/v1/daemon/stop', { method: 'POST' });
}

/** 重启 daemon */
export async function restartDaemon() {
  const payload = await fetchJson('/api/v1/daemon/restart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  return payload.data || payload;
}

// ===== Keybindings 管理 =====

/** 获取快捷键配置、上下文、动作与保留按键。 */
export async function fetchKeybindings() {
  const payload = await fetchJson('/api/v1/keybindings');
  return payload?.data ?? payload ?? {};
}

/** 校验用户快捷键覆盖。 */
export async function validateKeybindings(bindings) {
  return requestOptionalJson('/api/v1/keybindings/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bindings }),
  });
}

/** 保存用户快捷键覆盖。 */
export async function saveKeybindings(bindings) {
  return requestOptionalJson('/api/v1/keybindings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bindings }),
  });
}

/** 重置快捷键绑定为默认值 */
export async function resetKeybindings() {
  return requestOptionalJson('/api/v1/keybindings/reset', { method: 'POST' });
}

// ===== Plugin Marketplaces =====

/** 获取插件市场列表 */
export async function fetchMarketplaces() {
  const payload = await fetchJson('/api/v1/plugins/marketplaces');
  const data = payload?.data ?? payload;
  if (Array.isArray(data)) return data;
  return data?.marketplaces || [];
}

/** 浏览指定市场的插件 */
export async function browseMarketplace(marketplaceId, query) {
  const payload = await fetchJson('/api/v1/plugins/marketplaces/browse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ marketplace: marketplaceId }),
  });
  const plugins = payload?.data?.plugins || payload?.plugins || payload?.data || [];
  if (!query || !Array.isArray(plugins)) return Array.isArray(plugins) ? plugins : [];
  const term = String(query).toLowerCase();
  return plugins.filter((plugin) => `${plugin.name || ''} ${plugin.description || ''}`.toLowerCase().includes(term));
}

// ===== Plugin Marketplaces 增删（对照源 bundle）=====

/** 新增插件市场（source 必填，name 可选） */
export async function addMarketplace(marketplaceId, config = {}) {
  const source = String(config.source || config.url || (typeof marketplaceId === 'string' && /^https?:\/\//i.test(marketplaceId) ? marketplaceId : '')).trim();
  const name = String(config.name || (source === String(marketplaceId || '').trim() ? '' : marketplaceId || '')).trim();
  if (!source) throw new Error('marketplace source 不能为空');
  const body = name ? { name, source } : { source };
  if (config.autoUpdate === true || config.autoUpdate === false) {
    body.autoUpdate = Boolean(config.autoUpdate);
  }
  const payload = await fetchJson('/api/v1/plugins/marketplaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return payload?.data || payload || null;
}

export async function updateMarketplace(marketplaceId, force = false) {
  const marketplace = String(marketplaceId || '').trim();
  if (!marketplace) throw new Error('marketplace 不能为空');
  const payload = await fetchJson('/api/v1/plugins/marketplaces/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ marketplace, force: Boolean(force) }),
  });
  return payload?.data || payload || null;
}

/** 开启/关闭市场自动更新（POST /api/v1/plugins/marketplaces/auto-update） */
export async function setMarketplaceAutoUpdate(marketplaceId, autoUpdate) {
  if (!marketplaceId) throw new Error('marketplace id 不能为空');
  const payload = await fetchJson('/api/v1/plugins/marketplaces/auto-update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      marketplace: String(marketplaceId).trim(),
      autoUpdate: Boolean(autoUpdate),
    }),
  });
  return payload?.data || payload || null;
}

/**
 * HTTP 更新已安装插件到最新（POST /api/v1/plugins/update）。
 * body: { plugin, scope?, waitForApply? }
 */
export async function updatePluginHttp(pluginId, options = {}) {
  const plugin = qualifyPluginId(pluginId, options.marketplace);
  if (!plugin) throw new Error('plugin 不能为空');
  const body = { plugin };
  if (options.scope) body.scope = String(options.scope);
  if (options.waitForApply === true || options.waitForApply === false) {
    body.waitForApply = Boolean(options.waitForApply);
  }
  const payload = await fetchJson('/api/v1/plugins/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return payload?.data || payload || null;
}

/** 删除插件市场（对照源 DELETE /api/v1/plugins/marketplaces/{id}） */
export async function removeMarketplace(marketplaceId) {
  if (!marketplaceId) throw new Error('marketplace id 不能为空');
  const response = await requestCodeBuddy(`/api/v1/plugins/marketplaces/${encodeURIComponent(marketplaceId)}`, {
    method: 'DELETE',
    timeoutMs: 15000,
  });
  if (!response.ok) {
    let msg = `${response.status} ${response.statusText}`;
    try { const e = await response.json(); if (e?.error) msg = e.error; } catch (_) {}
    throw new Error(msg);
  }
  const text = await response.text().catch(() => '');
  try { const parsed = JSON.parse(text); return parsed?.data || parsed || null; } catch (_) { return null; }
}

export { getApiBase };

// ===== Storage KV 命名空间（对照源 bundle ro 对象）=====
// 路由统一：/api/v1/storage${query}，query 由 {key|namespace, scope} 拼
// scope ∈ 'user'|'global' 等；get 返回 {data:{value}}，getNamespace 返回 {data:{...}}
const STORAGE_SCOPES = new Set(['user', 'global', 'session']);

function buildStorageQuery({ key, namespace, scope } = {}) {
  const params = new URLSearchParams();
  if (key) params.set('key', key);
  if (namespace) params.set('namespace', namespace);
  if (scope && STORAGE_SCOPES.has(scope)) params.set('scope', scope);
  const qs = params.toString();
  return qs ? '?' + qs : '';
}

/** 读单个 KV（对照源 ro.get(key,scope)） */
export async function fetchStorage({ key, scope } = {}) {
  if (!key) return null;
  const payload = await fetchJson(`/api/v1/storage${buildStorageQuery({ key, scope })}`);
  return payload?.data?.value ?? null;
}

/** 读命名空间下全部 KV（对照源 ro.getNamespace(namespace,scope)） */
export async function fetchStorageNamespace({ namespace, scope } = {}) {
  if (!namespace) return {};
  const payload = await fetchJson(`/api/v1/storage${buildStorageQuery({ namespace, scope })}`);
  return payload?.data ?? {};
}

/** 写单个 KV（对照源 ro.set(key,value,scope)） */
export async function writeStorage({ key, value, scope } = {}) {
  if (!key) throw new Error('storage key 不能为空');
  const payload = await fetchJson(`/api/v1/storage${buildStorageQuery({ scope })}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value }),
  });
  return payload?.data || payload || null;
}

/** 批量写 KV（对照源 ro.setMany(entries,scope,opts)） */
export async function writeStorageMany({ entries, scope, keepalive } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const payload = await fetchJson(`/api/v1/storage${buildStorageQuery({ scope })}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries }),
    keepalive: keepalive === true,
  });
  return payload?.data || payload || null;
}

/** 删单个 KV（对照源 ro.remove(key,scope)） */
export async function removeStorage({ key, scope } = {}) {
  if (!key) throw new Error('storage key 不能为空');
  const response = await requestCodeBuddy(`/api/v1/storage${buildStorageQuery({ key, scope })}`, {
    method: 'DELETE',
    timeoutMs: 15000,
  });
  if (!response.ok) {
    let msg = `${response.status} ${response.statusText}`;
    try { const e = await response.json(); if (e?.error) msg = e.error; } catch (_) {}
    throw new Error(msg);
  }
  return null;
}
