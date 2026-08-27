// G5: Agent Home REST 契约（WebUI 2.138 /api/v1/agent-home）。
// 快照：GET → {enabled, defaultAgentId, agents, jobAssignments, groups, channels, sections}
// 智能体：POST /agents、PATCH|DELETE /agents/:id；房间(group)：POST /groups、PATCH|DELETE /groups/:id
// 频道：POST /channels、PATCH|DELETE /channels/:id；消息：GET|POST /channels/:id/messages
// WebUI 走 SSE /channels/:id/events；Desktop 采用轮询（与 instances/jobs 视图一致）。

import { fetchJson } from './acp';

const BASE = '/api/v1/agent-home';

/** WebUI va：房间/频道成员上限。 */
export const HOME_MAX_MEMBERS = 6;

function unwrap(payload) {
  return payload?.data ?? payload ?? null;
}

async function homeRequest(path, init) {
  return unwrap(await fetchJson(`${BASE}${path}`, init));
}

function postJson(path, body, method = 'POST') {
  return homeRequest(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

/** WebUI DM：消息数组归一（仅保留 id/at/from/text 合法的记录）。 */
export function normalizeHomeMessages(payload) {
  const list = Array.isArray(payload?.messages) ? payload.messages : Array.isArray(payload) ? payload : [];
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    if (typeof raw.id !== 'string' || typeof raw.text !== 'string') continue;
    if (raw.from !== 'user' && raw.from !== 'agent') continue;
    if (typeof raw.at !== 'number' || !Number.isFinite(raw.at)) continue;
    const mentions = Array.isArray(raw.mentionAgentIds)
      ? raw.mentionAgentIds.filter((id) => typeof id === 'string' && id.trim())
      : [];
    out.push({
      id: raw.id,
      at: raw.at,
      from: raw.from,
      text: raw.text,
      ...(typeof raw.agentId === 'string' ? { agentId: raw.agentId } : {}),
      ...(mentions.length > 0 ? { mentionAgentIds: mentions } : {}),
    });
  }
  return out;
}

/** WebUI load：房间列表 = groups 去掉主智能体成员后仍 ≥2 人的分组。 */
export function roomsFromGroups(groups, defaultAgentId) {
  return (Array.isArray(groups) ? groups : [])
    .map((group) => {
      const members = Array.isArray(group?.memberAgentIds) ? group.memberAgentIds : [];
      return defaultAgentId && members.includes(defaultAgentId)
        ? { ...group, memberAgentIds: members.filter((id) => id !== defaultAgentId) }
        : { ...group, memberAgentIds: members };
    })
    .filter((group) => group.memberAgentIds.length >= 2);
}

/** 从消息文本提取 @提及（@名称，长名优先且已匹配片段不再复配，大小写不敏感）。 */
export function extractMentionAgentIds(text, agents) {
  let source = String(text || '').toLowerCase();
  if (!source.includes('@')) return [];
  const candidates = (Array.isArray(agents) ? agents : [])
    .filter((agent) => agent?.id && typeof agent.name === 'string' && agent.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  const found = [];
  for (const agent of candidates) {
    const pattern = `@${agent.name.trim().toLowerCase()}`;
    if (!source.includes(pattern)) continue;
    if (!found.includes(agent.id)) found.push(agent.id);
    // 长名优先：命中后遮蔽该片段，避免「Reviewer」再命中「@Reviewer Pro」内部。
    source = source.split(pattern).join('\u0000'.repeat(pattern.length));
  }
  return found;
}

export async function fetchAgentHomeSnapshot() {
  const data = (await homeRequest('')) || {};
  const defaultAgentId = typeof data.defaultAgentId === 'string' ? data.defaultAgentId : null;
  return {
    enabled: data.enabled === true,
    defaultAgentId,
    agents: Array.isArray(data.agents) ? data.agents : [],
    jobAssignments: data.jobAssignments && typeof data.jobAssignments === 'object' ? data.jobAssignments : {},
    rooms: roomsFromGroups(data.groups, defaultAgentId),
    channels: Array.isArray(data.channels) ? data.channels : [],
    sections: Array.isArray(data.sections) ? data.sections : [],
  };
}

export async function createHomeAgent(payload = {}) {
  const data = await postJson('/agents', payload);
  return data?.agent ?? data;
}

export async function updateHomeAgent(agentId, patch) {
  return postJson(`/agents/${encodeURIComponent(agentId)}`, patch, 'PATCH');
}

export async function deleteHomeAgent(agentId) {
  return homeRequest(`/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' });
}

export async function createHomeRoom(payload) {
  const data = await postJson('/groups', payload);
  return data?.group ?? data;
}

export async function updateHomeRoom(roomId, patch) {
  const data = await postJson(`/groups/${encodeURIComponent(roomId)}`, patch, 'PATCH');
  return data?.group ?? data;
}

export async function deleteHomeRoom(roomId) {
  return homeRequest(`/groups/${encodeURIComponent(roomId)}`, { method: 'DELETE' });
}

export async function createHomeChannel(payload) {
  const data = await postJson('/channels', payload);
  return data?.channel ?? data;
}

export async function updateHomeChannel(channelId, patch) {
  const data = await postJson(`/channels/${encodeURIComponent(channelId)}`, patch, 'PATCH');
  return data?.channel ?? data;
}

export async function deleteHomeChannel(channelId) {
  return homeRequest(`/channels/${encodeURIComponent(channelId)}`, { method: 'DELETE' });
}

export async function fetchChannelMessages(channelId) {
  const data = await homeRequest(`/channels/${encodeURIComponent(channelId)}/messages`);
  return normalizeHomeMessages(data);
}

export async function sendChannelMessage(channelId, { text, mentionAgentIds = [] }) {
  const body = {
    text: String(text || ''),
    ...(mentionAgentIds.length > 0 ? { mentionAgentIds } : {}),
  };
  const data = await postJson(`/channels/${encodeURIComponent(channelId)}/messages`, body);
  return { message: data?.message ?? null, channel: data?.channel ?? null };
}
