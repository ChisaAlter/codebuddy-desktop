// G4: 后台智能体工作台 REST 契约（WebUI 2.138 /api/v1/jobs）。
// dispatch payload：{prompt, cwd?, name?, bash?|{agent,model,effort,permissionMode,bgIsolation,sourceSessionId}}
// `!` 前缀 → shell 任务（bash:true，attachments 不适用）。

import { fetchJson } from './acp';

const JOBS_BASE = '/api/v1/jobs';

export const JOB_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];

export function normalizeJobPermissionMode(value) {
  if (value === 'fullAccess') return 'bypassPermissions';
  return JOB_PERMISSION_MODES.includes(value) ? value : '';
}

/** WebUI qt/Vn：`!cmd` → shell 任务，其余为智能体任务。 */
export function parseJobPrompt(raw) {
  const text = String(raw || '');
  const isShell = text.trimStart().startsWith('!');
  const prompt = isShell ? text.trim().slice(1).trim() : text.trim();
  return { isShell, prompt };
}

/**
 * 构建 POST /api/v1/jobs 请求体（对照 WebUI 新建智能体 wr 回调）。
 * startFrom: 'blank' | 'continue'（sourceSessionId 生效时等价 continue/所选会话）。
 */
export function buildJobDispatchPayload({
  prompt,
  cwd = null,
  name = '',
  agent = '',
  model = '',
  effort = '',
  permissionMode = '',
  worktree = false,
  sourceSessionId = null,
} = {}) {
  const { isShell, prompt: text } = parseJobPrompt(prompt);
  if (!text) return null;
  const normalizedMode = normalizeJobPermissionMode(permissionMode);
  const base = {
    prompt: text,
    ...(cwd ? { cwd } : {}),
    ...(String(name || '').trim() ? { name: String(name).trim() } : {}),
  };
  if (isShell) return { ...base, bash: true };
  return {
    ...base,
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    // WebUI: minimal agent + plan 模式组合无效，回退默认。
    ...(normalizedMode && !(agent === 'minimal' && normalizedMode === 'plan') ? { permissionMode: normalizedMode } : {}),
    bgIsolation: worktree ? 'worktree' : 'none',
    ...(sourceSessionId ? { sourceSessionId } : {}),
  };
}

function unwrap(payload) {
  const data = payload?.data ?? payload;
  if (data == null || typeof data !== 'object') throw new Error('后台任务接口返回异常');
  return data;
}

export async function listJobs({ cwd = null, all = false } = {}) {
  const params = new URLSearchParams();
  if (cwd) params.set('cwd', cwd);
  if (all) params.set('all', '1');
  const query = params.toString();
  const data = unwrap(await fetchJson(`${JOBS_BASE}${query ? `?${query}` : ''}`));
  return Array.isArray(data.jobs) ? data.jobs : [];
}

export async function createJob(payload) {
  if (!payload) throw new Error('后台任务内容不能为空');
  return unwrap(
    await fetchJson(JOBS_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );
}

function jobPath(jobId, suffix = '') {
  return `${JOBS_BASE}/${encodeURIComponent(jobId)}${suffix}`;
}

export async function renameJob(jobId, name) {
  const data = unwrap(
    await fetchJson(jobPath(jobId, '/name'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  );
  return data.job ?? data;
}

export async function stopJob(jobId) {
  return unwrap(await fetchJson(jobPath(jobId, '/stop'), { method: 'POST' }));
}

export async function respawnJob(jobId) {
  const data = unwrap(await fetchJson(jobPath(jobId, '/respawn'), { method: 'POST' }));
  return data.job ?? data;
}

export async function deleteJob(jobId) {
  return unwrap(await fetchJson(jobPath(jobId), { method: 'DELETE' }));
}

export async function fetchJobTranscript(jobId) {
  return unwrap(await fetchJson(jobPath(jobId, '/transcript')));
}

/** 智能体任务状态归一（列表徽标用）。 */
export function normalizeJobStatus(job) {
  const status = String(job?.status || job?.state || '').toLowerCase();
  if (['running', 'active', 'working'].includes(status)) return 'running';
  if (['pending', 'starting', 'queued'].includes(status)) return 'pending';
  if (['stopped', 'cancelled', 'canceled'].includes(status)) return 'stopped';
  if (['failed', 'error'].includes(status)) return 'failed';
  if (['completed', 'done', 'succeeded', 'finished'].includes(status)) return 'completed';
  return 'unknown';
}

// ===== G4: create-by-ai（WebUI mainAgent 预设「用 AI 快速创建」）=====

export async function createAgentByAI(description) {
  const text = String(description || '').trim();
  if (!text) throw new Error('请输入智能体描述');
  const payload = await fetchJson('/api/v1/agents/create-by-ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: text }),
  });
  const data = payload?.data ?? payload;
  if (data?.success !== true) throw new Error(data?.error?.message || data?.message || '生成智能体失败');
  return data;
}
