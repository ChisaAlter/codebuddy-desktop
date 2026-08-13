const fs = require('node:fs');
const path = require('node:path');

const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function compressWorkspacePath(cwd) {
  return String(cwd || '')
    .replace(/[/\\:]/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .replace(/-+/g, '-');
}

function safeId(value) {
  const text = String(value || '').trim();
  return SAFE_ID.test(text) ? text : null;
}

function cleanText(value, maxLength = 2_000) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Canonical status vocabulary — MUST stay in sync with
 * src/lib/workflow-normalize.js (guarded by the workflow-status-single-source
 * unit test). Electron is CJS and cannot import the renderer ESM module, so the
 * map is duplicated here and the test asserts parity.
 */
function normalizeStatus(value, fallback = 'running') {
  const status = String(value || '').trim().toLowerCase();
  if (!status) return fallback;
  if (['complete', 'completed', 'done', 'success', 'succeeded'].includes(status)) return 'completed';
  if (['failed', 'failure', 'error'].includes(status)) return 'failed';
  if (['cancelled', 'canceled', 'aborted'].includes(status)) return 'cancelled';
  if (['waiting', 'blocked', 'paused'].includes(status)) return 'waiting';
  if (['pending', 'queued'].includes(status)) return 'pending';
  if (['working', 'running', 'in_progress', 'in-progress', 'planning', 'executing'].includes(status)) return 'running';
  return status;
}

async function readJson(file) {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readJournal(file) {
  let text;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event && typeof event === 'object' && !Array.isArray(event)) events.push(event);
    } catch {
      // The CLI appends this file in place; ignore an incomplete final line.
    }
  }
  return events;
}

function recordStartedAt(record) {
  return finiteNumber(record?.startedAt) || 0;
}

async function findWorkflowRecord({ projectSessionDir, runId, startedAfter }) {
  const workflowDir = path.join(projectSessionDir, 'workflows');
  if (runId) {
    const record = await readJson(path.join(workflowDir, `wf_${runId}.json`));
    return record?.runId === runId && recordStartedAt(record) >= startedAfter ? record : null;
  }

  let names;
  try {
    names = await fs.promises.readdir(workflowDir);
  } catch {
    return null;
  }
  let latest = null;
  for (const name of names) {
    const match = /^wf_([A-Za-z0-9_-]{1,160})\.json$/.exec(name);
    if (!match) continue;
    const record = await readJson(path.join(workflowDir, name));
    if (!record || safeId(record.runId) !== match[1] || recordStartedAt(record) < startedAfter) continue;
    if (!latest || recordStartedAt(record) > recordStartedAt(latest)) latest = record;
  }
  return latest;
}

function recordAgents(record) {
  const items = Array.isArray(record?.workflowProgress) ? record.workflowProgress : [];
  return items
    .filter((item) => item?.type === 'workflow_agent')
    .slice(0, 500)
    .map((item, index) => ({
      id: cleanText(item.agentId || item.id || `agent-${index + 1}`, 200),
      name: cleanText(item.label || item.name || item.agentId || `Agent ${index + 1}`, 500),
      phase: cleanText(item.phaseTitle || item.phase, 500),
      status: normalizeStatus(item.state || item.status),
      tokens: finiteNumber(item.tokens),
      startedAt: finiteNumber(item.startedAt),
      completedAt: finiteNumber(item.endedAt || item.completedAt),
      error: cleanText(item.error, 4_000),
      toolCallCount: finiteNumber(item.toolCalls || item.toolCallCount) || 0,
    }));
}

function journalProjection(record, events) {
  const runId = record.runId;
  const agents = new Map();
  let runStatus = normalizeStatus(record.status);
  let completedAt = finiteNumber(record.endedAt || record.completedAt);
  let updatedAt = finiteNumber(record.timestamp) || recordStartedAt(record);
  let journalPhase = null;

  for (const event of events) {
    if (event.runId && event.runId !== runId) continue;
    const eventAt = finiteNumber(event.endedAt || event.completedAt || event.startedAt || event.updatedAt);
    if (eventAt) updatedAt = Math.max(updatedAt || 0, eventAt);
    if (event.type === 'run_finished') {
      runStatus = normalizeStatus(event.status, 'completed');
      completedAt = finiteNumber(event.endedAt || event.completedAt) || completedAt;
      continue;
    }
    if (!['agent_started', 'agent_finished', 'agent_failed'].includes(event.type)) continue;
    const key = cleanText(event.key || event.agentId || event.sessionId, 200);
    if (!key) continue;
    const previous = agents.get(key) || {};
    const phase = cleanText(event.phase || previous.phase, 500);
    if (phase) journalPhase = phase;
    const failed = event.type === 'agent_failed' || Boolean(event.error);
    const completed = event.type === 'agent_finished';
    agents.set(key, {
      ...previous,
      id: key,
      name: cleanText(event.label || event.name || previous.name || key, 500),
      phase,
      status: failed ? 'failed' : completed ? 'completed' : 'running',
      tokens: finiteNumber(event.tokens) ?? previous.tokens ?? null,
      startedAt: finiteNumber(event.startedAt) ?? previous.startedAt ?? null,
      completedAt: finiteNumber(event.endedAt || event.completedAt) ?? previous.completedAt ?? null,
      error: cleanText(event.error, 4_000) || previous.error || null,
      toolCallCount: finiteNumber(event.toolCalls || event.toolCallCount) ?? previous.toolCallCount ?? 0,
    });
  }

  return {
    agents: agents.size ? Array.from(agents.values()).slice(0, 500) : recordAgents(record),
    status: runStatus,
    completedAt,
    updatedAt,
    phase: journalPhase,
  };
}

function recordPhase(record) {
  const progress = Array.isArray(record?.workflowProgress) ? record.workflowProgress : [];
  for (let index = progress.length - 1; index >= 0; index -= 1) {
    const item = progress[index];
    const phase = cleanText(item?.phaseTitle || item?.title || item?.phase, 500);
    if (phase) return phase;
  }
  const phases = Array.isArray(record?.phases) ? record.phases : [];
  return cleanText(phases[0]?.title || phases[0]?.name, 500);
}

async function readLatestWorkflowProgress({ configRoot, cwd, sessionId, startedAfter = 0, runId = null } = {}) {
  const safeSessionId = safeId(sessionId);
  const safeRunId = runId == null || runId === '' ? null : safeId(runId);
  const workspaceKey = compressWorkspacePath(cwd);
  const cutoff = Math.max(0, finiteNumber(startedAfter) || 0);
  if (!safeSessionId || (runId && !safeRunId) || !configRoot || !workspaceKey || ['.', '..'].includes(workspaceKey)) {
    return null;
  }

  const projectSessionDir = path.join(String(configRoot), 'projects', workspaceKey, safeSessionId);
  const record = await findWorkflowRecord({ projectSessionDir, runId: safeRunId, startedAfter: cutoff });
  const recordRunId = safeId(record?.runId);
  if (!record || !recordRunId || (record.sessionId && record.sessionId !== safeSessionId)) return null;

  const journal = await readJournal(
    path.join(projectSessionDir, 'subagents', 'workflows', `wf_${recordRunId}`, 'journal.jsonl'),
  );
  const projection = journalProjection(record, journal);
  const status = normalizeStatus(projection.status || record.status);
  const phases = Array.isArray(record.phases) ? record.phases : [];
  const phaseCount = finiteNumber(record.phaseCount) ?? phases.length;
  const agentCount = finiteNumber(record.agentCount) ?? projection.agents.length;

  return {
    runId: recordRunId,
    name: cleanText(record.name || record.workflowName, 500),
    description: cleanText(record.description, 2_000),
    status,
    active: !TERMINAL_STATUSES.has(status),
    phase: projection.phase || recordPhase(record),
    phaseCount,
    agentCount,
    cachedAgentCount: finiteNumber(record.cachedAgentCount) || 0,
    startedAt: recordStartedAt(record) || null,
    completedAt: projection.completedAt,
    updatedAt: projection.updatedAt || recordStartedAt(record) || null,
    error: cleanText(record.error, 4_000),
    agents: projection.agents,
  };
}

async function readProjectWorkflowProgress({ runtimeManager, configRoot, request = {} } = {}) {
  const projectId = String(request.projectId || '').trim();
  const runtime = runtimeManager
    ?.list?.()
    ?.find((entry) => entry?.projectId === projectId && typeof entry?.cwd === 'string' && entry.cwd.trim());
  if (!runtime) return null;
  return readLatestWorkflowProgress({
    configRoot,
    cwd: runtime.cwd,
    sessionId: request.sessionId,
    startedAfter: request.startedAfter,
    runId: request.runId,
  });
}

module.exports = {
  compressWorkspacePath,
  normalizeStatus,
  readLatestWorkflowProgress,
  readProjectWorkflowProgress,
};
