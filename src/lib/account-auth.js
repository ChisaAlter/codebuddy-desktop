/** Cloud account login helpers shared by store and sidebar footer. */

export const ACCOUNT_LOGIN_SITES = Object.freeze(['cn', 'global']);

/**
 * Soft default only when no disk OAuth and no user choice.
 * Runtime spawn always re-resolves against on-disk auth domain.
 */
export const DEFAULT_ACCOUNT_LOGIN_SITE = 'global';

export function normalizeAccountLoginSite(value) {
  return ACCOUNT_LOGIN_SITES.includes(value) ? value : DEFAULT_ACCOUNT_LOGIN_SITE;
}

/**
 * Map GUI site preference to CLI CODEBUDDY_INTERNET_ENVIRONMENT.
 * - cn → internal (China edition / codebuddy.cn / copilot.tencent.com)
 * - global → unset (international product default; do not inject ioa)
 */
export function internetEnvironmentForAccountSite(site) {
  const normalized = normalizeAccountLoginSite(site);
  if (normalized === 'cn') return 'internal';
  return null;
}

/** Map ACP authenticate methodId to login site. */
export function accountLoginSiteFromAuthMethodId(methodId) {
  const id = String(methodId || '').trim();
  if (id === 'internal') return 'cn';
  if (id === 'external' || id === 'cli-external-link') return 'global';
  return null;
}

/**
 * OAuth domain → site. Shared with electron/codebuddy-auth-site.cjs semantics.
 */
export function accountLoginSiteFromAuthDomain(domain) {
  const host = String(domain || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0];
  if (!host) return null;
  if (
    host === 'www.codebuddy.cn' ||
    host.endsWith('.codebuddy.cn') ||
    host === 'copilot.tencent.com' ||
    host.endsWith('.copilot.tencent.com') ||
    host.includes('staging-copilot.tencent.com') ||
    host.includes('staging.codebuddy.cn')
  ) {
    return 'cn';
  }
  if (
    host === 'www.codebuddy.ai' ||
    host.endsWith('.codebuddy.ai') ||
    host.includes('staging-codebuddy.tencent.com')
  ) {
    return 'global';
  }
  return null;
}

/**
 * Prefer ACP authenticate methodId by login site.
 * CLI AUTH_ENV_MAPPING: external→国际站, internal→国内站 (copilot.tencent.com).
 * Always prefer browser cloud methods before iOA/selfhosted.
 */
export function preferredAuthMethodIdsForSite(site) {
  const normalized = normalizeAccountLoginSite(site);
  if (normalized === 'cn') {
    return ['internal', 'cli-external-link', 'external', 'iOA', 'selfhosted'];
  }
  return ['external', 'cli-external-link', 'iOA', 'internal', 'selfhosted'];
}

export function pickAuthMethodId(authMethods, site) {
  const methods = Array.isArray(authMethods) ? authMethods : [];
  const preferred = preferredAuthMethodIdsForSite(site);
  return (
    preferred.find((id) => methods.some((method) => method?.id === id)) ||
    methods[0]?.id ||
    (normalizeAccountLoginSite(site) === 'cn' ? 'internal' : 'external')
  );
}

export function formatCodeBuddyAccountLabel(user) {
  if (!user || typeof user !== 'object') return null;
  const candidates = [
    user.userNickname,
    user.userName,
    user.name,
    user.displayName,
    user.email,
    user.userId,
    user.id,
  ];
  for (const item of candidates) {
    if (typeof item === 'string' && item.trim()) return item.trim();
  }
  return null;
}

/**
 * Network / proxy failures must never be treated as "need cloud login".
 * CLI often returns stopReason=refusal with category=network and a 502 HTML body.
 */
export function isNetworkOrProxyFailureMessage(value) {
  const message = String(value || '');
  if (!message) return false;
  return (
    /\bECONNREFUSED\b|\bENOTFOUND\b|\bETIMEDOUT\b|\bECONNRESET\b/i.test(message) ||
    /\b502\b|\b503\b|\b504\b|Bad Gateway|Gateway Timeout|Service Unavailable/i.test(message) ||
    /连接被拒绝|代理未启动|网络代理|proxy\s*[:=]/i.test(message) ||
    /category["']?\s*[:=]\s*["']?(?:network|proxy|timeout)/i.test(message) ||
    /\bNetwork error\b/i.test(message)
  );
}

/**
 * Custom-model endpoint auth failure (wrong/missing models.json apiKey).
 * Must not be treated as CodeBuddy cloud login expiry.
 */
export function isCustomModelAuthFailureMessage(value) {
  const message = String(value || '');
  if (!message) return false;
  if (/custom_model_auth/i.test(message)) return true;
  if (/differs from the current product endpoint/i.test(message)) return true;
  // "401 Authentication failed (401) for model "grok-4.5""
  if (/Authentication failed\s*\(?\s*401\s*\)?\s*for model/i.test(message)) return true;
  if (/Missing API key/i.test(message) && /model|custom|endpoint/i.test(message)) return true;
  return false;
}

/** Explicit cloud-account auth failure (not generic model/network refusal). */
export function isCloudAuthFailureMessage(value) {
  const message = String(value || '');
  if (!message) return false;
  if (isNetworkOrProxyFailureMessage(message)) return false;
  // Custom endpoint 401s look like "Authentication failed" — not cloud login.
  if (isCustomModelAuthFailureMessage(message)) return false;
  return (
    /authentication required|鉴权失败|请.*登录|sign in to your account|auth-type:cli-external-link|token-type:undefined/i.test(
      message,
    ) ||
    // Real HTTP 401 cloud auth, not custom-model endpoint failures above.
    (/(?:^|[^\d])401(?:[^\d]|$)|status(?:Code)?["']?\s*[:=]\s*401/i.test(message) &&
      !/for model\s+"/i.test(message))
  );
}

/** UI copy for custom model API key / endpoint auth failures. */
export function formatCustomModelAuthFailureMessage(raw, extras = {}) {
  const text = String(raw || '');
  const modelId =
    extras.modelId ||
    text.match(/for model\s+"([^"]+)"/i)?.[1] ||
    text.match(/for model\s+([^\s(,;]+)/i)?.[1] ||
    null;
  const endpoint =
    text.match(/sent to\s+(https?:\/\/[^\s,]+)/i)?.[1] ||
    text.match(/https?:\/\/(?!127\.0\.0\.1|localhost)[^\s"'<>]+/i)?.[0] ||
    null;
  const parts = ['自定义模型鉴权失败（HTTP 401）'];
  if (modelId) parts.push(`模型 ${modelId}`);
  if (endpoint) parts.push(endpoint);
  return (
    parts.join(' · ') +
    '。这不是 CodeBuddy 云端登录失效；请在「模型配置」里为该自定义模型填写正确的 API Key，保存后新建会话或重启运行时再试。'
  );
}

/**
 * CLI ACP often returns errorMessage as JSON.stringify(RequestError.toErrorResponse()):
 * { code, message, data: { category, statusCode, details, ... } }
 * Unwrap that so classifiers see human text + category.
 */
export function unwrapPromptErrorPayload(value) {
  if (value == null) return { message: null, category: null, statusCode: null, data: null };
  if (typeof value === 'object' && !Array.isArray(value)) {
    const nested =
      (typeof value.message === 'string' && value.message) ||
      (typeof value.errorMessage === 'string' && value.errorMessage) ||
      (typeof value.error?.message === 'string' && value.error.message) ||
      (typeof value.details === 'string' && value.details) ||
      null;
    const category =
      value.category ||
      value.data?.category ||
      value.error?.data?.category ||
      value.error?.category ||
      null;
    const statusCode =
      value.statusCode ??
      value.data?.statusCode ??
      value.error?.data?.statusCode ??
      value.status ??
      null;
    return {
      message: nested ? String(nested).trim() : null,
      category: category ? String(category).toLowerCase() : null,
      statusCode: statusCode == null ? null : Number(statusCode) || statusCode,
      data: value.data || value,
    };
  }
  const text = String(value).trim();
  if (!text) return { message: null, category: null, statusCode: null, data: null };
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        const unwrapped = unwrapPromptErrorPayload(parsed);
        // Prefer nested message; if parse only yields empty, fall back to raw.
        return {
          message: unwrapped.message || text,
          category: unwrapped.category,
          statusCode: unwrapped.statusCode,
          data: unwrapped.data,
        };
      }
    } catch (_) {
      /* keep text */
    }
  }
  return { message: text, category: null, statusCode: null, data: null };
}

/**
 * Build a short UI-facing network/proxy failure summary from CLI text.
 * Strips nginx HTML pages and keeps proxy + HTTP status + upstream host.
 */
export function formatNetworkOrProxyFailureMessage(raw, extras = {}) {
  const text = String(raw || '');
  const status =
    extras.statusCode ||
    text.match(/\bHTTP\s*([45]\d\d)\b/i)?.[1] ||
    text.match(/\b(502|503|504|408)\b/)?.[1] ||
    null;
  // Upstream custom proxy: "unknown provider for model grok"
  const unknownProvider = text.match(/unknown provider for model\s+([^\s(,;]+)/i)?.[1] || null;
  if (unknownProvider) {
    return (
      `自定义模型端点不认识模型 ID「${unknownProvider}」` +
      (status ? `（HTTP ${status}）` : '') +
      '。请把 models.json 里的 id 改成该端点 /v1/models 返回的真实模型名（例如 grok-4.5），保存后重启运行时再试。'
    );
  }
  // CLI: "(proxy: http://127.0.0.1:10809 -> https://ayase.cn)"
  const proxyPair = text.match(/\(proxy:\s*([^)]+)\)/i)?.[1]?.trim() || null;
  const proxyLocal =
    proxyPair?.split(/\s*->\s*/)[0]?.trim() ||
    text.match(/proxy\s*[:=]\s*(https?:\/\/\S+|[\w.:+-]+)/i)?.[1]?.trim() ||
    null;
  const upstream =
    proxyPair?.split(/\s*->\s*/)[1]?.trim()?.replace(/[),.;]+$/, '') ||
    text.match(/->\s*(https?:\/\/\S+)/i)?.[1]?.replace(/[),.;]+$/, '') ||
    // Prefer non-loopback absolute URLs as the model endpoint.
    (text.match(/https?:\/\/(?!127\.0\.0\.1|localhost)[^\s"'<>]+/i)?.[0] || null)?.replace(
      /[),.;]+$/,
      '',
    ) ||
    null;

  const parts = ['模型请求失败'];
  if (status) parts.push(`HTTP ${status}`);
  if (upstream) parts.push(upstream);
  if (proxyLocal) parts.push(`经代理 ${proxyLocal}`);
  let summary = parts.join(' · ');
  if (status || proxyLocal || upstream) {
    summary += '。这不是登录失效；请检查代理、网络或自定义模型端点后重试。';
  } else {
    summary =
      '模型请求失败：网络或代理不可用（如 502 / 代理端口拒绝）。这不是登录失效，请检查代理与模型端点后重试。';
  }
  return summary;
}

/**
 * Classify prompt/session refusal: auth vs network vs generic.
 * Prefer explicit category from CLI when present.
 * CLI puts details in errorMessage JSON: { code, message, data: { category } }.
 */
export function classifyPromptRefusal(result) {
  const topCategory = String(result?.category || result?.data?.category || '').toLowerCase();
  // CLI 把模型请求失败详情放进 result._meta["codebuddy.ai/errorMessage"]（JSON 字符串），
  // 不在顶层 errorMessage/data 里。不加这一项，custom_model_auth / auth / network 信号
  // 会被丢掉，分类落到 bare refusal，UI 显示通用「请求被拒绝」而非真正的鉴权/网络提示。
  const metaErrorMessage = result?._meta?.['codebuddy.ai/errorMessage'];
  const rawCandidates = [
    result?.errorMessage,
    result?.error,
    result?.message,
    result?.data,
    result?.data?.message,
    result?.data?.errorMessage,
    result?.error?.message,
    metaErrorMessage,
  ];
  let unwrapped = { message: null, category: null, statusCode: null, data: null };
  for (const item of rawCandidates) {
    if (item == null || item === '') continue;
    const next = unwrapPromptErrorPayload(item);
    if (next.message || next.category || next.statusCode != null) {
      unwrapped = next;
      break;
    }
  }
  const category = String(unwrapped.category || topCategory || '').toLowerCase();
  let raw = unwrapped.message || null;
  // If message is still a giant HTML page, keep a compact form for downstream formatters.
  if (raw && /<\s*html/i.test(raw)) {
    const status = unwrapped.statusCode || raw.match(/\b(502|503|504)\b/)?.[1];
    const proxy = raw.match(/\(proxy:\s*([^)]+)\)/i)?.[0] || '';
    raw = [status ? `HTTP ${status}` : null, 'Bad Gateway', proxy].filter(Boolean).join(' ').trim();
  }

  if (
    category === 'custom_model_auth' ||
    isCustomModelAuthFailureMessage(raw) ||
    isCustomModelAuthFailureMessage(result?.errorMessage)
  ) {
    return { kind: 'custom_model_auth', message: raw, statusCode: unwrapped.statusCode || 401 };
  }
  if (category === 'auth') {
    return { kind: 'auth', message: raw, statusCode: unwrapped.statusCode };
  }
  if (
    category === 'network' ||
    category === 'proxy' ||
    category === 'timeout' ||
    isNetworkOrProxyFailureMessage(raw) ||
    isNetworkOrProxyFailureMessage(result?.errorMessage)
  ) {
    return { kind: 'network', message: raw, statusCode: unwrapped.statusCode };
  }
  if (isCloudAuthFailureMessage(raw) || isCloudAuthFailureMessage(result?.errorMessage)) {
    return { kind: 'auth', message: raw || String(result?.errorMessage || '').trim() || null };
  }
  if (String(result?.stopReason || '').toLowerCase() === 'refusal') {
    // Bare refusal without auth/network markers is a model/request refusal, not login.
    return { kind: 'refusal', message: raw, statusCode: unwrapped.statusCode };
  }
  return { kind: 'unknown', message: raw, statusCode: unwrapped.statusCode };
}

export function normalizeLastAccountUser(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const label = formatCodeBuddyAccountLabel(value);
  if (!label) return null;
  const next = {};
  for (const key of ['userId', 'userName', 'userNickname', 'name', 'displayName', 'email', 'id']) {
    if (typeof value[key] === 'string' && value[key].trim()) next[key] = value[key].trim();
  }
  return Object.keys(next).length ? next : null;
}

export function accountFooterPresentation({
  authState = 'unknown',
  user = null,
  lastUser = null,
  site = 'cn',
}) {
  const normalizedSite = normalizeAccountLoginSite(site);
  const liveLabel = formatCodeBuddyAccountLabel(user);
  const cachedLabel = formatCodeBuddyAccountLabel(lastUser);

  if (authState === 'authenticating') {
    return {
      kind: 'authenticating',
      label: null,
      site: normalizedSite,
      showLogin: false,
      cached: false,
    };
  }
  if (authState === 'authenticated') {
    return {
      kind: 'authenticated',
      label: liveLabel || cachedLabel,
      site: normalizedSite,
      showLogin: false,
      cached: false,
    };
  }
  if (authState === 'required' || authState === 'error') {
    // 需要重新登录时仍可展示上次用户名（cached 样式），避免侧栏空白「未登录」。
    if (cachedLabel) {
      return {
        kind: 'cached',
        label: cachedLabel,
        site: normalizedSite,
        showLogin: true,
        cached: true,
      };
    }
    return {
      kind: 'needs_login',
      label: null,
      site: normalizedSite,
      showLogin: true,
      cached: false,
    };
  }
  // unknown: optional cached display name; never treat cache as authenticated.
  if (cachedLabel) {
    return {
      kind: 'cached',
      label: cachedLabel,
      site: normalizedSite,
      showLogin: true,
      cached: true,
    };
  }
  return {
    kind: 'needs_login',
    label: null,
    site: normalizedSite,
    showLogin: true,
    cached: false,
  };
}
