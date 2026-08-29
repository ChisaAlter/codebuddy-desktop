import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETTINGS_GROUPS, WEBUI_MK_SETTING_KEYS } from '../../src/lib/codebuddy-schema.js';

/**
 * Exact settings key order from CLI 2.138 web-ui bundle (SettingsView chunk `Ne=[...]`).
 * 2.124 Mk 18 keys + autoCompactWindow (2.136) + codebuddy.composer.busySendMode (2.138)
 * + new mainAgent group (codebuddy.mainAgent.enabled / allowUnopted).
 */
const WEBUI_KEYS_2_138 = [
  'model',
  'reasoningEffort',
  'alwaysThinkingEnabled',
  'autoCompactEnabled',
  'autoCompactWindow',
  'includeCoAuthoredBy',
  'fileCheckpointingEnabled',
  'promptSuggestionEnabled',
  'codebuddy.composer.busySendMode',
  'ignoreGitIgnore',
  'deferToolLoading',
  'hookOutputCollapsed',
  'memory.enabled',
  'memory.autoMemoryEnabled',
  'language',
  'codebuddy.mainAgent.enabled',
  'codebuddy.mainAgent.allowUnopted',
  'cleanupPeriodDays',
  'imageHistoryRetainRounds',
  'env',
  'sandbox.enabled',
  'sandbox.autoAllowBashIfSandboxed',
];

const WEBUI_GROUP_ORDER = [
  'modelAndReasoning',
  'behavior',
  'memory',
  'language',
  'mainAgent',
  'advanced',
  'sandbox',
];

describe('WebUI 2.138 settings schema', () => {
  it('exports the exact 22 keys in order', () => {
    expect(WEBUI_MK_SETTING_KEYS).toEqual(WEBUI_KEYS_2_138);
    expect(WEBUI_MK_SETTING_KEYS).toHaveLength(22);
  });

  it('SETTINGS_GROUPS CLI groups match key order and contain no extras', () => {
    const cliGroups = SETTINGS_GROUPS.filter((group) => group.id !== 'appearance');
    expect(cliGroups.map((group) => group.id)).toEqual(WEBUI_GROUP_ORDER);

    const keys = cliGroups.flatMap((group) => group.items.map((item) => item.key));
    expect(keys).toEqual(WEBUI_KEYS_2_138);
  });

  it('busySendMode is a queue/immediate select defaulting to queue; mainAgent toggles carry WebUI defaults', () => {
    const behavior = SETTINGS_GROUPS.find((group) => group.id === 'behavior');
    const busySend = behavior.items.find((item) => item.key === 'codebuddy.composer.busySendMode');
    expect(busySend.type).toBe('select');
    expect(busySend.defaultValue).toBe('queue');
    expect(busySend.options.map(([value]) => value)).toEqual(['queue', 'immediate']);

    const mainAgent = SETTINGS_GROUPS.find((group) => group.id === 'mainAgent');
    expect(mainAgent.items.find((item) => item.key === 'codebuddy.mainAgent.enabled').defaultValue).toBe(true);
    expect(mainAgent.items.find((item) => item.key === 'codebuddy.mainAgent.allowUnopted').defaultValue).toBe(false);
  });

  it('ReplicaSettingsView wires all 22 keys via updateSetting and section ids', () => {
    const viewPath = resolve(process.cwd(), 'src/components/ReplicaSettingsView.jsx');
    const source = readFileSync(viewPath, 'utf8');
    const updateKeys = [...source.matchAll(/updateSetting\('([^']+)'/g)].map((match) => match[1]);
    // preserve first-seen order; the G13 REPL toggle re-uses the env key.
    const ordered = [];
    for (const key of updateKeys) {
      if (!ordered.includes(key)) ordered.push(key);
    }
    expect(ordered).toEqual(WEBUI_KEYS_2_138);

    for (const groupId of WEBUI_GROUP_ORDER) {
      expect(source).toContain(`id="settings-section-settings-group-${groupId}"`);
    }
    for (const fixed of ['connection', 'appearance', 'model', 'mode', 'system']) {
      expect(source).toContain(`id="settings-section-${fixed}"`);
    }
    expect(source).toContain('data-desktop-only="true"');
  });
});
