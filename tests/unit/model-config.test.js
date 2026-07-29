import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  deleteModelConfig,
  isCustomOnlyWhitelist,
  listModelConfig,
  resolveModelConfigPath,
  saveModelConfig,
} = require('../../electron/model-config.cjs');

const tempDirectories = [];

function createTempConfig(initialValue) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-model-config-'));
  tempDirectories.push(directory);
  const filePath = path.join(directory, 'models.json');
  if (initialValue !== undefined) fs.writeFileSync(filePath, `${JSON.stringify(initialValue, null, 2)}\n`, 'utf8');
  return filePath;
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('model config storage', () => {
  it('resolves the user-level CodeBuddy models.json path', () => {
    expect(resolveModelConfigPath({ homeDir: 'C:/Users/Test', env: {} })).toBe(
      path.join('C:/Users/Test', '.codebuddy', 'models.json'),
    );
    expect(
      resolveModelConfigPath({ homeDir: 'C:/Users/Test', env: { CODEBUDDY_CONFIG_DIR: 'D:/CodeBuddyConfig' } }),
    ).toBe(path.join('D:/CodeBuddyConfig', 'models.json'));
  });

  it('creates a model without exposing its API key to the renderer', () => {
    const filePath = createTempConfig();
    const snapshot = saveModelConfig(
      {
        id: 'openai:gpt-4o',
        url: 'https://api.example.com/v1/chat/completions',
        apiKey: 'sk-secret-value',
        maxInputTokens: 128000,
        maxOutputTokens: 8192,
        supportsToolCall: true,
        supportsImages: true,
      },
      { filePath, homeDir: path.dirname(filePath) },
    );

    expect(snapshot.models[0]).toMatchObject({
      id: 'openai:gpt-4o',
      name: 'openai:gpt-4o',
      hasApiKey: true,
      apiKeyReference: '',
      maxInputTokens: 128000,
      supportsImages: true,
    });
    expect(snapshot.models[0]).not.toHaveProperty('apiKey');
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).models[0].apiKey).toBe('sk-secret-value');
  });

  it('preserves an existing key and unknown model fields when editing', () => {
    const filePath = createTempConfig({
      models: [
        {
          id: 'custom-old',
          name: 'Custom Old',
          vendor: 'Vendor',
          url: 'https://old.example.com/v1/chat/completions',
          apiKey: 'sk-existing',
          relatedModels: { lite: 'custom-lite' },
        },
      ],
      customTopLevel: true,
    });

    saveModelConfig(
      {
        originalId: 'custom-old',
        id: 'custom-new',
        name: 'Custom Old',
        vendor: 'Vendor',
        url: 'https://new.example.com/v1/chat/completions',
        apiKey: '',
        preserveApiKey: true,
        supportsReasoning: true,
      },
      { filePath },
    );

    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(written.customTopLevel).toBe(true);
    // Disk must not create availableModels — that field becomes a hard CLI whitelist
    // and would hide all built-in / account models.
    expect(written.availableModels).toBeUndefined();
    expect(written.models[0]).toMatchObject({
      id: 'custom-new',
      apiKey: 'sk-existing',
      relatedModels: { lite: 'custom-lite' },
      supportsReasoning: true,
    });
    expect(fs.existsSync(`${filePath}.bak`)).toBe(true);
  });

  it('never appends custom models to availableModels (keeps built-in models visible)', () => {
    const filePath = createTempConfig({
      models: [{ id: 'keep' }],
    });
    saveModelConfig(
      {
        id: 'openai:gpt-4o',
        url: 'https://api.example.com/v1/chat/completions',
        apiKey: 'sk-new',
        visible: true,
        includeInAvailableModels: true,
      },
      { filePath },
    );
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(written.models.map((model) => model.id)).toEqual(['keep', 'openai:gpt-4o']);
    expect(written.availableModels).toBeUndefined();
  });

  it('strips degenerate availableModels that only lists custom model ids', () => {
    const filePath = createTempConfig({
      models: [
        {
          id: 'grok-4.5',
          url: 'http://example/v1',
          apiKey: 'sk-keep',
        },
      ],
      availableModels: ['grok-4.5'],
    });
    saveModelConfig(
      {
        originalId: 'grok-4.5',
        id: 'grok-4.5',
        url: 'http://example/v1',
        apiKey: '',
        preserveApiKey: true,
        maxInputTokens: 256000,
      },
      { filePath },
    );
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(written.availableModels).toBeUndefined();
    expect(written.models[0].apiKey).toBe('sk-keep');
    expect(written.models[0].maxInputTokens).toBe(256000);
  });

  it('persists useCustomProtocol and validates model id charset', () => {
    const filePath = createTempConfig({ models: [] });
    saveModelConfig(
      {
        id: 'vendor:model-v1',
        url: 'https://api.example.com/v1',
        useCustomProtocol: true,
      },
      { filePath },
    );
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(written.models[0]).toMatchObject({ id: 'vendor:model-v1', useCustomProtocol: true });
    expect(() =>
      saveModelConfig({ id: 'bad model', url: 'https://api.example.com/v1' }, { filePath }),
    ).toThrow('字母、数字');
    expect(() =>
      saveModelConfig({ id: 'org/model', url: 'https://api.example.com/v1' }, { filePath }),
    ).toThrow('字母、数字');
  });

  it('supports environment variable key references and returns the reference safely', () => {
    const filePath = createTempConfig({ models: [] });
    const snapshot = saveModelConfig(
      {
        id: 'env-model',
        url: '${CUSTOM_MODEL_URL}',
        apiKey: '${CUSTOM_MODEL_KEY}',
      },
      { filePath },
    );

    expect(snapshot.models[0]).toMatchObject({
      hasApiKey: true,
      apiKeyReference: '${CUSTOM_MODEL_KEY}',
      url: '${CUSTOM_MODEL_URL}',
    });
  });

  it('removes a model from both models and availableModels, keeping non-custom whitelist entries', () => {
    // 白名单含非自定义 id（account:gpt-4o）时，删除自定义模型后剩余白名单仍合法，
    // 不应被自愈清掉——验证 delete 不误清合法混合白名单。
    const filePath = createTempConfig({
      models: [{ id: 'keep' }, { id: 'remove' }],
      availableModels: ['account:gpt-4o', 'keep', 'remove'],
    });
    const snapshot = deleteModelConfig('remove', { filePath });
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    expect(snapshot.models.map((model) => model.id)).toEqual(['keep']);
    expect(written.availableModels).toEqual(['account:gpt-4o', 'keep']);
  });

  it('self-heals custom-only availableModels on delete (drops the whitelist)', () => {
    // 删除后白名单只剩自定义 id（keep）→ 属 custom-only，自愈清掉，避免隐藏内置模型。
    const filePath = createTempConfig({
      models: [{ id: 'keep' }, { id: 'remove' }],
      availableModels: ['keep', 'remove'],
    });
    deleteModelConfig('remove', { filePath });
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(written.availableModels).toBeUndefined();
  });

  it('self-heals custom-only availableModels on read (writes back a clean file)', () => {
    // 模拟 CLI 写回的脏白名单：只有自定义 id。读取应静默清掉并写回干净文件。
    const filePath = createTempConfig({
      models: [{ id: 'grok-4.5', url: 'http://example/v1', apiKey: 'sk-keep' }],
      availableModels: ['grok-4.5'],
    });
    listModelConfig({ filePath });
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(written.availableModels).toBeUndefined();
    expect(written.models[0].apiKey).toBe('sk-keep');
  });

  it('leaves mixed (non-custom) availableModels untouched on read', () => {
    const filePath = createTempConfig({
      models: [{ id: 'grok-4.5', url: 'http://example/v1', apiKey: 'sk-keep' }],
      availableModels: ['account:gpt-4o', 'grok-4.5'],
    });
    listModelConfig({ filePath });
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(written.availableModels).toEqual(['account:gpt-4o', 'grok-4.5']);
  });

  it('isCustomOnlyWhitelist detects custom-only and empty whitelists', () => {
    const models = [{ id: 'a' }, { id: 'b' }];
    expect(isCustomOnlyWhitelist(['a', 'b'], models)).toBe(true);
    expect(isCustomOnlyWhitelist(['a'], models)).toBe(true);
    expect(isCustomOnlyWhitelist([], models)).toBe(true);
    expect(isCustomOnlyWhitelist(['a', 'account:x'], models)).toBe(false);
    expect(isCustomOnlyWhitelist(undefined, models)).toBe(false);
    expect(isCustomOnlyWhitelist(['a'], [])).toBe(false);
  });

  it('rejects duplicate model ids and invalid endpoints', () => {
    const filePath = createTempConfig({ models: [{ id: 'duplicate' }] });
    expect(() =>
      saveModelConfig({ id: 'duplicate', url: 'https://api.example.com/v1/chat/completions' }, { filePath }),
    ).toThrow('已存在');
    expect(() => saveModelConfig({ id: 'new-model', url: 'file:///tmp/model' }, { filePath })).toThrow('HTTP 或 HTTPS');
  });

  it('reads legacy array-shaped files without exposing secrets', () => {
    const filePath = createTempConfig([
      { id: 'legacy', apiKey: 'secret', url: 'http://localhost/v1/chat/completions' },
    ]);
    const snapshot = listModelConfig({ filePath });
    expect(snapshot.models[0]).toMatchObject({ id: 'legacy', hasApiKey: true });
    expect(snapshot.models[0]).not.toHaveProperty('apiKey');
  });
});
