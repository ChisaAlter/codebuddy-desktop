const fs = require('fs');
const os = require('os');
const path = require('path');
const { parse: parseJsonc } = require('jsonc-parser');

const ENV_REFERENCE_PATTERN = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

function resolveModelConfigPath({ homeDir = os.homedir(), env = process.env } = {}) {
  const configRoot = String(env.CODEBUDDY_CONFIG_DIR || '').trim() || path.join(homeDir, '.codebuddy');
  return path.join(configRoot, 'models.json');
}

function parseModelConfig(text, filePath) {
  const errors = [];
  const value = parseJsonc(String(text || '').replace(/^\uFEFF/, ''), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length) {
    const offset = errors[0]?.offset;
    throw new Error(`模型配置 JSON 格式无效${Number.isFinite(offset) ? `（位置 ${offset}）` : ''}: ${filePath}`);
  }
  if (Array.isArray(value)) {
    return { shape: 'array', raw: value, models: value, availableModels: undefined };
  }
  if (!value || typeof value !== 'object') throw new Error(`模型配置必须是 JSON 对象: ${filePath}`);
  if (value.models !== undefined && !Array.isArray(value.models)) throw new Error(`models 字段必须是数组: ${filePath}`);
  if (value.availableModels !== undefined && !Array.isArray(value.availableModels)) {
    throw new Error(`availableModels 字段必须是数组: ${filePath}`);
  }
  return {
    shape: 'object',
    raw: value,
    models: Array.isArray(value.models) ? value.models : [],
    availableModels: Array.isArray(value.availableModels) ? value.availableModels : undefined,
  };
}

// 判断 availableModels 是否只剩自定义 id（或为空）——这种白名单会被 CLI 当成硬白名单，
// 丢弃所有账号/内置模型。合法的混合白名单（含非自定义 id）不会被判定为 custom-only。
function isCustomOnlyWhitelist(availableModels, models) {
  if (!Array.isArray(availableModels)) return false;
  const customIds = new Set((Array.isArray(models) ? models : []).map((m) => m?.id).filter(Boolean));
  return availableModels.length === 0 || availableModels.every((id) => customIds.has(id));
}

function readInternalModelConfig(filePath = resolveModelConfigPath()) {
  if (!fs.existsSync(filePath)) {
    return { filePath, exists: false, shape: 'object', raw: { models: [] }, models: [], availableModels: undefined };
  }
  const parsed = parseModelConfig(fs.readFileSync(filePath, 'utf8'), filePath);
  const config = { filePath, exists: true, ...parsed };
  // 读时自愈：custom-only availableModels 会被 CLI 当成硬白名单，丢弃所有账号/内置模型。
  // 静默清掉并原子写回，保证 CLI 下次启动/热重载读到干净文件。自愈失败不阻断读取。
  if (isCustomOnlyWhitelist(config.availableModels, config.models)) {
    config.availableModels = undefined;
    if (config.raw && typeof config.raw === 'object') delete config.raw.availableModels;
    try {
      writeModelConfig(config);
    } catch (_) {
      /* 自愈失败不阻断读取；下次 save/delete 仍会清理 */
    }
  }
  return config;
}

function finiteOptionalNumber(value, label, { integer = true, min, max } = {}) {
  if (value === '' || value === null || value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || (integer && !Number.isInteger(number)))
    throw new Error(`${label}必须是${integer ? '整数' : '数字'}`);
  if (min !== undefined && number < min) throw new Error(`${label}不能小于 ${min}`);
  if (max !== undefined && number > max) throw new Error(`${label}不能大于 ${max}`);
  return number;
}

function normalizeEndpoint(value) {
  const endpoint = String(value || '').trim();
  if (!endpoint) throw new Error('接口地址不能为空');
  if (ENV_REFERENCE_PATTERN.test(endpoint)) return endpoint;
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch (_) {
    throw new Error('接口地址格式无效');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('接口地址必须是有效的 HTTP 或 HTTPS 地址');
  }
  return parsed.toString();
}

// 与 WebUI settings.customModels.err.idInvalid 一致：仅字母、数字与 . _ : -
const MODEL_ID_PATTERN = /^[a-zA-Z0-9._:-]+$/;

function normalizeModelPayload(payload = {}) {
  const id = String(payload.id || '').trim();
  if (!id) throw new Error('请填写模型 ID');
  if (id.length > 160 || !MODEL_ID_PATTERN.test(id)) {
    throw new Error('模型 ID 仅允许字母、数字与 . _ : -');
  }
  const name =
    String(payload.name || id)
      .trim()
      .slice(0, 160) || id;
  const vendor =
    String(payload.vendor || 'Custom')
      .trim()
      .slice(0, 80) || 'Custom';
  const apiKey = String(payload.apiKey || '').trim();
  if (apiKey.length > 4096) throw new Error('API Key 过长');
  return {
    id,
    name,
    vendor,
    url: normalizeEndpoint(payload.url),
    apiKey,
    // Empty key on edit keeps the existing secret on disk (renderer never receives apiKey).
    preserveApiKey: payload.preserveApiKey !== false,
    maxInputTokens: finiteOptionalNumber(payload.maxInputTokens, '最大输入 Token', { min: 1, max: 100000000 }),
    maxOutputTokens: finiteOptionalNumber(payload.maxOutputTokens, '最大输出 Token', { min: 1, max: 100000000 }),
    temperature: finiteOptionalNumber(payload.temperature, 'Temperature', { integer: false, min: 0, max: 2 }),
    supportsToolCall: payload.supportsToolCall !== false,
    supportsImages: Boolean(payload.supportsImages),
    supportsReasoning: Boolean(payload.supportsReasoning),
    useCustomProtocol: Boolean(payload.useCustomProtocol),
  };
}

function publicModel(model) {
  const apiKey = typeof model?.apiKey === 'string' ? model.apiKey : '';
  return {
    id: String(model?.id || ''),
    name: String(model?.name || model?.id || ''),
    vendor: String(model?.vendor || 'Custom'),
    url: String(model?.url || ''),
    maxInputTokens: Number.isFinite(model?.maxInputTokens) ? model.maxInputTokens : null,
    maxOutputTokens: Number.isFinite(model?.maxOutputTokens) ? model.maxOutputTokens : null,
    temperature: Number.isFinite(model?.temperature) ? model.temperature : null,
    supportsToolCall: model?.supportsToolCall !== false,
    supportsImages: Boolean(model?.supportsImages),
    supportsReasoning: Boolean(model?.supportsReasoning),
    useCustomProtocol: Boolean(model?.useCustomProtocol),
    hasApiKey: Boolean(apiKey),
    apiKeyReference: ENV_REFERENCE_PATTERN.test(apiKey) ? apiKey : '',
  };
}

function displayModelConfigPath(filePath, homeDir = os.homedir()) {
  const relative = path.relative(homeDir, filePath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return `%USERPROFILE%\\${relative.replace(/[\\/]+/g, '\\')}`;
  }
  return filePath;
}

function listModelConfig(options = {}) {
  const filePath = options.filePath || resolveModelConfigPath(options);
  const config = readInternalModelConfig(filePath);
  let updatedAt = null;
  if (config.exists) {
    try {
      updatedAt = fs.statSync(filePath).mtime.toISOString();
    } catch (_) {}
  }
  return {
    filePath,
    displayPath: displayModelConfigPath(filePath, options.homeDir || os.homedir()),
    exists: config.exists,
    updatedAt,
    models: config.models.filter((model) => model && typeof model === 'object').map(publicModel),
  };
}

function serializeModelConfig(config) {
  if (config.shape === 'array') return config.models;
  const next = { ...config.raw, models: config.models };
  if (config.availableModels === undefined) delete next.availableModels;
  else next.availableModels = config.availableModels;
  return next;
}

function writeModelConfig(config) {
  const filePath = config.filePath;
  const directory = path.dirname(filePath);
  const tempFile = `${filePath}.tmp`;
  const backupFile = `${filePath}.bak`;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(tempFile, `${JSON.stringify(serializeModelConfig(config), null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    if (fs.existsSync(backupFile)) fs.rmSync(backupFile, { force: true });
    if (fs.existsSync(filePath)) fs.renameSync(filePath, backupFile);
    fs.renameSync(tempFile, filePath);
  } catch (error) {
    try {
      if (!fs.existsSync(filePath) && fs.existsSync(backupFile)) fs.copyFileSync(backupFile, filePath);
    } catch (_) {}
    try {
      fs.rmSync(tempFile, { force: true });
    } catch (_) {}
    throw error;
  }
}

function saveModelConfig(payload = {}, options = {}) {
  const filePath = options.filePath || resolveModelConfigPath(options);
  const config = readInternalModelConfig(filePath);
  const normalized = normalizeModelPayload(payload);
  const originalId = String(payload.originalId || '').trim();
  const originalIndex = originalId ? config.models.findIndex((model) => model?.id === originalId) : -1;
  const targetIndex = config.models.findIndex((model) => model?.id === normalized.id);
  if (targetIndex !== -1 && targetIndex !== originalIndex) throw new Error(`模型 “${normalized.id}” 已存在`);

  const previous = originalIndex >= 0 ? config.models[originalIndex] : null;
  const nextModel = {
    ...(previous && typeof previous === 'object' ? previous : {}),
    id: normalized.id,
    name: normalized.name,
    vendor: normalized.vendor,
    url: normalized.url,
    supportsToolCall: normalized.supportsToolCall,
    supportsImages: normalized.supportsImages,
    supportsReasoning: normalized.supportsReasoning,
    useCustomProtocol: normalized.useCustomProtocol,
  };
  if (normalized.apiKey) nextModel.apiKey = normalized.apiKey;
  else if (!normalized.preserveApiKey) delete nextModel.apiKey;
  if (normalized.maxInputTokens === undefined) delete nextModel.maxInputTokens;
  else nextModel.maxInputTokens = normalized.maxInputTokens;
  if (normalized.maxOutputTokens === undefined) delete nextModel.maxOutputTokens;
  else nextModel.maxOutputTokens = normalized.maxOutputTokens;
  if (normalized.temperature === undefined) delete nextModel.temperature;
  else nextModel.temperature = normalized.temperature;
  if (!normalized.useCustomProtocol) delete nextModel.useCustomProtocol;

  if (originalIndex >= 0) config.models.splice(originalIndex, 1, nextModel);
  else config.models.push(nextModel);

  // CRITICAL: never create/append models.json availableModels for custom models.
  // When that field is present, CLI treats it as a hard product whitelist and drops
  // all account/built-in models (log: model ids collapse to only custom-local:…).
  // Custom models belong in `models[]`; session picker membership is handled by CLI
  // product-sync (runtime POST /models/custom/save visible), not this disk whitelist.
  // Only migrate rename inside an existing whitelist if the user already had one.
  if (Array.isArray(config.availableModels)) {
    if (originalId && originalId !== normalized.id) {
      config.availableModels = config.availableModels.map((id) => (id === originalId ? normalized.id : id));
    }
    // Drop empty or custom-only whitelist (would hide account/built-in models).
    if (isCustomOnlyWhitelist(config.availableModels, config.models)) {
      config.availableModels = undefined;
      if (config.raw && typeof config.raw === 'object') delete config.raw.availableModels;
    }
  }
  writeModelConfig(config);
  return listModelConfig({ ...options, filePath });
}

function deleteModelConfig(modelId, options = {}) {
  const id = String(modelId || '').trim();
  if (!id) throw new Error('模型 ID 不能为空');
  const filePath = options.filePath || resolveModelConfigPath(options);
  const config = readInternalModelConfig(filePath);
  const nextModels = config.models.filter((model) => model?.id !== id);
  if (nextModels.length === config.models.length) throw new Error(`未找到模型 “${id}”`);
  config.models = nextModels;
  if (Array.isArray(config.availableModels))
    config.availableModels = config.availableModels.filter((value) => value !== id);
  // 删除后若白名单只剩自定义 id（或为空），清掉，避免隐藏账号/内置模型。
  if (isCustomOnlyWhitelist(config.availableModels, config.models)) {
    config.availableModels = undefined;
    if (config.raw && typeof config.raw === 'object') delete config.raw.availableModels;
  }
  writeModelConfig(config);
  return listModelConfig({ ...options, filePath });
}

function ensureModelConfigFile(options = {}) {
  const filePath = options.filePath || resolveModelConfigPath(options);
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{\n  "models": []\n}\n', { encoding: 'utf8', mode: 0o600 });
  }
  return filePath;
}

module.exports = {
  deleteModelConfig,
  displayModelConfigPath,
  ensureModelConfigFile,
  isCustomOnlyWhitelist,
  listModelConfig,
  normalizeModelPayload,
  parseModelConfig,
  readInternalModelConfig,
  resolveModelConfigPath,
  saveModelConfig,
};
