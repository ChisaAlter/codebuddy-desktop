import { describe, expect, it, vi } from 'vitest';
import {
  aggregateMarketplacePlugins,
  detectPluginKind,
  filterPlugins,
  isPluginInstalled,
  pluginCanRemove,
  pluginCanSwitchoff,
  slicePluginPage,
} from '../../src/lib/plugins-list';

describe('plugins-list helpers', () => {
  const sample = [
    { name: 'skill-pack', enabled: true, skills: [{ name: 'foo' }] },
    { name: 'mcp-bridge', enabled: false, mcpServers: [{ name: 'server' }] },
    { name: 'hooks-only', status: 'enabled', hooks: [{}] },
    { name: 'tools-only', tools: [{}], description: 'utility tools' },
    { name: 'mystery', description: 'no metadata' },
  ];

  it('detectPluginKind prefers explicit and dominant metadata', () => {
    expect(detectPluginKind({ kind: 'mcp' })).toBe('mcp');
    expect(detectPluginKind({ skills: [1], mcpServers: [1, 2] })).toBe('mcp');
    expect(detectPluginKind({})).toBe('other');
  });

  it('filterPlugins applies status, kind, and query', () => {
    expect(filterPlugins(sample, { status: 'enabled' }).map((p) => p.name)).toEqual([
      'skill-pack',
      'hooks-only',
    ]);
    expect(filterPlugins(sample, { kind: 'skills' }).map((p) => p.name)).toEqual(['skill-pack']);
    expect(filterPlugins(sample, { query: 'utility' }).map((p) => p.name)).toEqual(['tools-only']);
  });

  it('aggregates marketplaces, tolerates one failure, and dedupes by qualified identity', async () => {
    const browse = vi.fn(async (id) => {
      if (id === 'broken') throw new Error('offline');
      return id === 'm1'
        ? [{ name: 'demo', version: '1' }, { name: 'shared', marketplace: 'm1' }]
        : [{ name: 'demo', version: '2' }, { name: 'shared', marketplace: 'm2' }];
    });
    const result = await aggregateMarketplacePlugins([{ name: 'm1' }, { name: 'm2' }, { name: 'broken' }], browse);
    expect(result.failures).toBe(1);
    expect(result.plugins.map((plugin) => plugin.pluginId)).toEqual(['demo@m1', 'shared@m1', 'demo@m2', 'shared@m2']);
  });

  it('uses marketplace identity for installed state and policy flags', () => {
    expect(isPluginInstalled({ name: 'demo', marketplace: 'm1' }, [{ name: 'demo', marketplace: 'm2' }])).toBe(false);
    expect(isPluginInstalled({ name: 'demo', marketplace: 'm1' }, [{ name: 'demo', marketplace: 'm1' }])).toBe(true);
    expect(pluginCanRemove({ canRemove: false })).toBe(false);
    expect(pluginCanSwitchoff({ canSwitchoff: false })).toBe(false);
  });
  it('slicePluginPage windows the list for infinite scroll', () => {
    const list = Array.from({ length: 55 }, (_, i) => ({ name: `p${i}` }));
    const first = slicePluginPage(list, 30, 30);
    expect(first.items).toHaveLength(30);
    expect(first.hasMore).toBe(true);
    expect(first.nextVisible).toBe(55);
    const full = slicePluginPage(list, 55, 30);
    expect(full.hasMore).toBe(false);
    expect(full.total).toBe(55);
  });
});
