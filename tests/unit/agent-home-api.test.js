// G5: Agent Home 纯逻辑（消息归一、房间过滤、@提及提取）。
import { describe, expect, it } from 'vitest';
import { normalizeHomeMessages, roomsFromGroups, extractMentionAgentIds } from '../../src/lib/agent-home-api';

describe('normalizeHomeMessages', () => {
  it('keeps only valid messages and strips bad mention ids', () => {
    const payload = {
      messages: [
        { id: 'm1', at: 100, from: 'user', text: 'hi' },
        { id: 'm2', at: 200, from: 'agent', text: 'yo', agentId: 'a1', mentionAgentIds: ['a2', '', 3] },
        { id: 'm3', at: 'nope', from: 'user', text: 'bad at' },
        { id: 4, at: 300, from: 'user', text: 'bad id' },
        { id: 'm5', at: 400, from: 'system', text: 'bad from' },
        null,
      ],
    };
    expect(normalizeHomeMessages(payload)).toEqual([
      { id: 'm1', at: 100, from: 'user', text: 'hi' },
      { id: 'm2', at: 200, from: 'agent', text: 'yo', agentId: 'a1', mentionAgentIds: ['a2'] },
    ]);
  });

  it('handles missing payloads', () => {
    expect(normalizeHomeMessages(null)).toEqual([]);
    expect(normalizeHomeMessages({})).toEqual([]);
  });
});

describe('roomsFromGroups', () => {
  it('drops the default agent from members and filters <2-member groups (WebUI load)', () => {
    const groups = [
      { id: 'g1', memberAgentIds: ['main', 'a1', 'a2'] },
      { id: 'g2', memberAgentIds: ['main', 'a1'] },
      { id: 'g3', memberAgentIds: ['a1', 'a2'] },
    ];
    expect(roomsFromGroups(groups, 'main').map((g) => g.id)).toEqual(['g1', 'g3']);
    expect(roomsFromGroups(groups, 'main')[0].memberAgentIds).toEqual(['a1', 'a2']);
  });

  it('tolerates missing input', () => {
    expect(roomsFromGroups(null, null)).toEqual([]);
  });
});

describe('extractMentionAgentIds', () => {
  const agents = [
    { id: 'a1', name: 'Reviewer' },
    { id: 'a2', name: 'Reviewer Pro' },
    { id: 'a3', name: 'Builder' },
  ];

  it('matches @name case-insensitively, longest names first, deduped', () => {
    expect(extractMentionAgentIds('hey @reviewer pro and @builder', agents)).toEqual(['a2', 'a3']);
    expect(extractMentionAgentIds('ping @Reviewer twice @reviewer', agents)).toEqual(['a1']);
  });

  it('returns empty without @ or matches', () => {
    expect(extractMentionAgentIds('no mentions', agents)).toEqual([]);
    expect(extractMentionAgentIds('@nobody', agents)).toEqual([]);
    expect(extractMentionAgentIds('', agents)).toEqual([]);
  });
});
