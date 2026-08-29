// G8: 命令面板目录与模糊过滤。
import { describe, expect, it } from 'vitest';
import { buildPaletteCommands, filterPaletteCommands, fuzzyScore } from '../../src/lib/command-palette';

const t = (key) => key;

describe('buildPaletteCommands', () => {
  it('includes views, actions, slash commands, theme and language entries', () => {
    const commands = buildPaletteCommands({
      t,
      slashCommands: [{ name: 'compact', description: 'Compact context' }, { name: '/goal' }],
      theme: 'light',
      locale: 'zh',
    });
    const ids = commands.map((command) => command.id);
    expect(ids).toContain('view:chat');
    expect(ids).toContain('view:settings');
    expect(ids).toContain('view:terminal');
    expect(ids).toContain('action:new-conversation');
    expect(ids).toContain('action:toggle-sidebar');
    expect(ids).toContain('command:compact');
    expect(ids).toContain('command:goal');
    expect(ids).toContain('theme:dark');
    expect(ids).toContain('language:en');
    expect(commands.find((command) => command.id === 'theme:light')?.active).toBe(true);
    expect(commands.find((command) => command.id === 'language:zh')?.active).toBe(true);
  });

  it('dedupes slash commands and strips leading slashes', () => {
    const commands = buildPaletteCommands({ t, slashCommands: [{ name: 'goal' }, { name: '/goal' }] });
    expect(commands.filter((command) => command.id === 'command:goal')).toHaveLength(1);
    expect(commands.find((command) => command.id === 'command:goal')?.label).toBe('/goal');
  });
});

describe('fuzzyScore / filterPaletteCommands', () => {
  it('matches subsequences and rejects non-matches', () => {
    expect(fuzzyScore('cmp', 'compact')).toBeGreaterThan(0);
    expect(fuzzyScore('xyz', 'compact')).toBe(-1);
    expect(fuzzyScore('', 'anything')).toBe(0);
  });

  it('prefers prefix/continuous matches', () => {
    expect(fuzzyScore('com', 'compact')).toBeGreaterThan(fuzzyScore('cat', 'compact'));
  });

  it('filters and ranks commands by query', () => {
    const commands = buildPaletteCommands({ t, slashCommands: [{ name: 'compact' }] });
    const filtered = filterPaletteCommands(commands, 'compact');
    expect(filtered[0]?.id).toBe('command:compact');
    expect(filterPaletteCommands(commands, '')).toHaveLength(Math.min(commands.length, 50));
    expect(filterPaletteCommands(commands, 'zzzzzz')).toHaveLength(0);
  });
});
