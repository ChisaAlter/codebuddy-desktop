#!/usr/bin/env node
'use strict';

/**
 * Real packaged-app acceptance test for asynchronous Workflow runs.
 *
 * This harness seeds only an empty project/thread. It uses the packaged app's
 * real CodeBuddy runtime and records observed store/DOM state without injecting
 * workflow events, agents, timeline entries, or an ACP client.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  cleanupOwned,
  cleanupRuntimeDir,
  connectCdp,
  createRuntimeLayout,
  findRendererTarget,
  launchDesktop,
  requireUsableCodeBuddyStartup,
  seedProductState,
  waitForRendererValue,
} = require('./e2e-driver.cjs');

const projectRoot = path.resolve(__dirname, '..', '..');
const packagedExe = process.env.WORKFLOW_PACKAGED_EXE
  ? path.resolve(process.env.WORKFLOW_PACKAGED_EXE)
  : path.join(
      projectRoot,
      '.omo',
      'build-validation-final',
      'win-unpacked',
      'CodeBuddy Desktop.exe',
    );
const runId = `workflow-drain-${Date.now()}`;
const runtimeOwnership = createRuntimeLayout({ projectRoot, runStamp: runId, label: 'workflow-drain-real' });
const { runtimeRoot, runtimeDir, userDataDir } = runtimeOwnership;
const evidenceDir = path.join(projectRoot, '.omo', 'evidence', 'workflow-drain-real', runId);
const startupLogPath = path.join(userDataDir, 'electron-startup.log');
const workflowAgentTimeoutMs = Number(process.env.WORKFLOW_AGENT_TIMEOUT_MS) || 180000;
const promptText = [
  '请使用 Workflow 工具，把下面代码原样作为唯一的 script 参数（不要同时传 name），启动 1 代理、1 阶段的后台工作流：',
  '```js',
  'export const meta = {',
  "  name: 'package-read-qa',",
  "  description: '只读核对 package.json 的 name 和 version',",
  "  phases: [{ title: 'Inspect', detail: '只读核对 package 元数据' }],",
  '}',
  '',
  "phase('Inspect')",
  'const results = await parallel([',
  '  () => agent(',
  "    `In C:/Users/48818/Documents/CodeBuddyGUI perform a strictly read-only verification. Read package.json and report its exact name and version. Also cross-check package-lock.json's root package metadata and run a read-only git diff check for package.json. Do not modify any file. Return a concise structured result.`,",
  "    { label: 'package-reader', phase: 'Inspect', schema: {",
  "      type: 'object',",
  "      properties: {",
  "        name: { type: 'string' },",
  "        version: { type: 'string' }",
  '      },',
  "      required: ['name', 'version']",
  '    }}',
  '  ),',
  '])',
  '',
  'return { package: results[0] }',
  '```',
  '调用 Workflow 成功后，当前回合只回复“工作流已启动”并立即结束；当前回合禁止调用 TaskOutput、Read、Bash 或任何轮询/取结果工具。后台完成通知到达以后，允许读取通知给出的输出文件，然后输出包含 name/version 的最终汇总。',
].join('\n');

let launched = null;
let client = null;
let ownershipController = null;
let summary = {
  runId,
  startedAt: new Date().toISOString(),
  packagedExe,
  userDataDir,
  promptText,
  checks: {},
  screenshots: {},
  observations: {},
};

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serializeError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    stack: error?.stack || null,
  };
}

function recordCheck(name, ok, detail = null) {
  summary.checks[name] = { ok: Boolean(ok), detail };
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail == null ? '' : ` - ${JSON.stringify(detail)}`}`);
  return Boolean(ok);
}

async function waitForStartup(pattern, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  do {
    if (fs.existsSync(startupLogPath)) text = fs.readFileSync(startupLogPath, 'utf8');
    pattern.lastIndex = 0;
    if (pattern.test(text)) return text;
    await wait(250);
  } while (Date.now() < deadline);
  throw new Error(`${label} did not appear in ${startupLogPath} within ${timeoutMs}ms`);
}

async function capture(name) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const file = path.join(evidenceDir, `${name}.png`);
  const shot = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  summary.screenshots[name] = file;
  console.log(`SHOT ${file}`);
  return file;
}

const snapshotExpression = `(() => {
  const api = window.__CODEBUDDY_STORE__;
  const state = api?.getState?.();
  const threadId = state?.activeThreadId || null;
  const thread = threadId ? state?.threadsById?.[threadId] : null;
  const runtime = threadId ? state?.threadRuntimeById?.[threadId] : null;
  const workflow = runtime?.workflowState || runtime?.lastWorkflowState || null;
  const timeline = Array.isArray(runtime?.timeline) ? runtime.timeline : [];
  const assistants = timeline
    .filter((item) => item?.type === 'message' && item?.role === 'assistant')
    .map((item) => ({
      id: item.id || null,
      content: String(item.content || ''),
      streaming: Boolean(item.streaming),
      createdAt: Number(item.createdAt) || 0,
      completedAt: Number(item.completedAt) || 0,
    }));
  const panel = document.querySelector('[data-testid="workflow-floating-panel"]');
  const subagentSection = panel?.querySelector('[data-testid="workflow-subagents"]');
  const subagentRows = subagentSection?.querySelectorAll('.workflow-panel__subagent') || [];
  return {
    at: Date.now(),
    activeProjectId: state?.activeProjectId || null,
    threadId,
    threadStatus: thread?.status || null,
    sessionId: thread?.sessionId || runtime?.sessionId || state?.sessionId || null,
    connectionState: runtime?.connectionState || state?.connectionState || null,
    accountLoginNeeded: Boolean(state?.accountLoginNeeded),
    authState: state?.codeBuddyAccountAuthState || state?.authViewState || null,
    error: state?.error || null,
    hasRealClient: Boolean(threadId && state?.getThreadClient?.(threadId)),
    isAwaitingResponse: Boolean(runtime?.isAwaitingResponse),
    activePromptRunId: runtime?.activePromptRunId || null,
    backgroundDrainRunId: runtime?.backgroundDrainRunId || null,
    backgroundDrainUntil: Number(runtime?.backgroundDrainUntil) || 0,
    backgroundDrainMaxUntil: Number(runtime?.backgroundDrainMaxUntil) || 0,
    workflow: workflow ? {
      runId: workflow.runId || null,
      name: workflow.name || null,
      status: workflow.status || null,
      active: workflow.active === true,
      phase: workflow.phase || workflow.currentPhase || null,
      agents: Array.isArray(workflow.agents) ? workflow.agents.map((agent) => ({
        id: agent?.id || agent?.agentId || null,
        name: agent?.name || agent?.agentName || null,
        phase: agent?.phase || agent?.currentPhase || null,
        status: agent?.status || null,
        description: agent?.description || agent?.task || null,
      })) : [],
    } : null,
    assistants,
    timelineLength: timeline.length,
    panel: {
      visible: Boolean(panel),
      text: String(panel?.innerText || '').slice(0, 4000),
      subagentRows: subagentRows.length,
      subagentText: String(subagentSection?.innerText || '').slice(0, 2000),
    },
  };
})()`;

async function observe() {
  return client.evaluate(snapshotExpression);
}

async function clickVisibleButtonExact(label) {
  return client.evaluate(`(() => {
    const label = ${JSON.stringify(label)};
    const button = Array.from(document.querySelectorAll('button')).find((candidate) =>
      (candidate.offsetWidth || candidate.offsetHeight) &&
      !candidate.disabled &&
      String(candidate.innerText || candidate.getAttribute('aria-label') || '').trim() === label
    );
    if (!button) return { clicked: false };
    button.click();
    return { clicked: true, label };
  })()`);
}

async function setFullAccessMode() {
  return client.evaluate(`(async () => {
    const state = window.__CODEBUDDY_STORE__.getState();
    const modes = Array.isArray(state.modes) ? state.modes : [];
    const exactFullAccess = modes.find((candidate) => {
      const id = String(candidate?.id || candidate?.modeId || '');
      const name = String(candidate?.name || candidate?.label || '');
      return id.replace(/[^a-z]/gi, '').toLowerCase() === 'fullaccess' || /完全访问/.test(name);
    });
    const mode = exactFullAccess || modes.find((candidate) => {
      const id = String(candidate?.id || candidate?.modeId || '');
      const name = String(candidate?.name || candidate?.label || '');
      return /bypasspermissions/i.test(id.replace(/[^a-z]/gi, '')) || /跳过权限/.test(name);
    });
    const modeId = mode?.id || mode?.modeId || null;
    if (!modeId) {
      return { ok: false, reason: 'full-access-mode-not-found', modes };
    }
    const changed = await state.setMode(modeId);
    const latest = window.__CODEBUDDY_STORE__.getState();
    return {
      ok: changed === true,
      modeId,
      currentMode: latest.currentMode,
      modes,
      error: latest.error || null,
    };
  })()`);
}

async function waitForWorkflowAgents(timeoutMs) {
  const startedAt = Date.now();
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let permissionApprovals = 0;
  let fallbackPanelOpened = false;
  do {
    last = await observe();
    if (last?.workflow?.runId && (last.workflow.agents?.length || 0) > 0) {
      return { snapshot: last, permissionApprovals };
    }
    if (last?.threadStatus === 'waiting') {
      const approved = await clickVisibleButtonExact('允许');
      if (approved.clicked) {
        permissionApprovals += 1;
        console.log(`ACTION approved expected workflow permission #${permissionApprovals}`);
        await wait(500);
      }
    }
    if (
      !fallbackPanelOpened &&
      Date.now() - startedAt >= 15000 &&
      last?.threadStatus === 'idle' &&
      !last?.panel?.visible
    ) {
      fallbackPanelOpened = true;
      await client.evaluate(`(() => {
        const state = window.__CODEBUDDY_STORE__.getState();
        state.openWorkflowPanel({
          projectId: state.activeProjectId || null,
          threadId: state.activeThreadId,
          runId: null,
        });
        return true;
      })()`);
      await wait(300);
      const fallbackPanel = await observe();
      summary.observations.fallbackPanelDuringBackground = fallbackPanel.panel;
      await capture('01-panel-during-background');
    }
    await wait(250);
  } while (Date.now() < deadline);
  throw new Error(`real workflow agents were not observed within ${timeoutMs}ms; last=${JSON.stringify(last)}`);
}

async function dispatchPrompt(slot, text) {
  return client.evaluate(`(() => {
    const api = window.__CODEBUDDY_STORE__;
    const qa = window.__workflowDrainQa || (window.__workflowDrainQa = {});
    const slot = ${JSON.stringify(slot)};
    const prompt = ${JSON.stringify(text)};
    const startedAt = Date.now();
    qa[slot] = { startedAt, settled: false, result: null, error: null, settledAt: 0, assistantMessages: [] };
    Promise.resolve(api.getState().sendPrompt(prompt)).then(
      (result) => {
        const state = api.getState();
        const threadId = state.activeThreadId;
        const runtime = state.threadRuntimeById?.[threadId];
        qa[slot] = {
          ...qa[slot],
          settled: true,
          settledAt: Date.now(),
          result,
          assistantMessages: (runtime?.timeline || [])
            .filter((item) => item?.type === 'message' && item?.role === 'assistant' && Number(item.createdAt || 0) >= startedAt - 1000)
            .map((item) => ({ id: item.id || null, content: String(item.content || ''), createdAt: item.createdAt || 0 })),
        };
      },
      (error) => {
        qa[slot] = { ...qa[slot], settled: true, settledAt: Date.now(), error: error?.message || String(error) };
      },
    );
    return { dispatched: true, startedAt };
  })()`);
}

async function installTrace() {
  return client.evaluate(`(() => {
    const api = window.__CODEBUDDY_STORE__;
    const qa = window.__workflowDrainQa || (window.__workflowDrainQa = {});
    qa.trace = [];
    qa.clientEvents = [];
    qa.lastSignature = '';
    qa.unsubscribe?.();
    qa.unsubscribeClient?.();
    qa.unsubscribeRawExtension?.();
    const liveClient = api.getState().getThreadClient?.(api.getState().activeThreadId);
    const recordClientEvent = (type, detail) => {
      const update = detail?.update || {};
      const metadata = update?._meta || {};
      qa.clientEvents.push({
        at: Date.now(),
        type,
        sessionId: detail?.sessionId || null,
        source: detail?._client?.source || null,
        promptRunId: detail?._client?.promptRunId || null,
        serverInitiated: detail?._client?.serverInitiated === true,
        sessionUpdate: update?.sessionUpdate || update?.session_update || update?.type || null,
        requestId:
          detail?._client?.requestId ||
          metadata?.['codebuddy.ai/requestId'] ||
          metadata?.['codebuddy.ai']?.requestId ||
          null,
        workflowEventKind: metadata?.['codebuddy.ai/workflowEventKind'] || null,
        text: String(update?.content?.text || update?.content || '').slice(0, 2000),
      });
      if (qa.clientEvents.length > 4000) qa.clientEvents.shift();
    };
    qa.unsubscribeClient = liveClient?.on?.('session/update', (event) =>
      recordClientEvent('session/update', event?.detail || null)
    );
    qa.unsubscribeRawExtension = liveClient?.on?.('raw_extension', (event) =>
      recordClientEvent('raw_extension', event?.detail || null)
    );
    const capture = (state) => {
      const threadId = state.activeThreadId;
      const thread = state.threadsById?.[threadId];
      const runtime = state.threadRuntimeById?.[threadId];
      const workflow = runtime?.workflowState || runtime?.lastWorkflowState || null;
      const assistants = (runtime?.timeline || [])
        .filter((item) => item?.type === 'message' && item?.role === 'assistant')
        .map((item) => ({ id: item.id || null, content: String(item.content || ''), streaming: Boolean(item.streaming) }));
      const rawWorkflowEvents = (runtime?.rawExtensionEvents || [])
        .filter((event) => /workflow/i.test(String(event?.type || event?.payload?.key || '')))
        .slice(-20)
        .map((event) => ({
          id: event?.id || null,
          type: event?.type || null,
          value: event?.payload?.value ?? null,
          receivedAt: event?.receivedAt || null,
        }));
      const entry = {
        at: Date.now(),
        threadStatus: thread?.status || null,
        isAwaitingResponse: Boolean(runtime?.isAwaitingResponse),
        activePromptRunId: runtime?.activePromptRunId || null,
        workflowRunId: workflow?.runId || null,
        workflowStatus: workflow?.status || null,
        workflowActive: workflow?.active === true,
        workflowPhase: workflow?.phase || workflow?.currentPhase || null,
        workflowAgents: Array.isArray(workflow?.agents) ? workflow.agents.map((agent) => ({
          id: agent?.id || agent?.agentId || null,
          name: agent?.name || agent?.agentName || null,
          phase: agent?.phase || agent?.currentPhase || null,
          status: agent?.status || null,
          description: agent?.description || agent?.task || null,
        })) : [],
        backgroundDrainRunId: runtime?.backgroundDrainRunId || null,
        backgroundDrainUntil: Number(runtime?.backgroundDrainUntil) || 0,
        backgroundDrainMaxUntil: Number(runtime?.backgroundDrainMaxUntil) || 0,
        rawWorkflowEvents,
        assistants,
      };
      const signature = JSON.stringify({
        threadStatus: entry.threadStatus,
        isAwaitingResponse: entry.isAwaitingResponse,
        activePromptRunId: entry.activePromptRunId,
        workflowRunId: entry.workflowRunId,
        workflowStatus: entry.workflowStatus,
        workflowActive: entry.workflowActive,
        workflowPhase: entry.workflowPhase,
        workflowAgents: entry.workflowAgents,
        backgroundDrainRunId: entry.backgroundDrainRunId,
        backgroundDrainUntil: entry.backgroundDrainUntil,
        rawWorkflowEvents: entry.rawWorkflowEvents,
        assistantIds: entry.assistants.map((item) => [item.id, item.content.length, item.streaming]),
      });
      if (signature !== qa.lastSignature) {
        qa.lastSignature = signature;
        qa.trace.push(entry);
        if (qa.trace.length > 2000) qa.trace.shift();
      }
    };
    qa.unsubscribe = api.subscribe(capture);
    capture(api.getState());
    return true;
  })()`);
}

async function readQaState() {
  return client.evaluate(`(() => {
    const qa = window.__workflowDrainQa || {};
    return {
      effort: qa.effort || null,
      primary: qa.primary || null,
      trace: qa.trace || [],
      clientEvents: qa.clientEvents || [],
    };
  })()`);
}

async function main() {
  if (!fs.existsSync(packagedExe)) throw new Error(`fresh packaged executable not found: ${packagedExe}`);
  fs.mkdirSync(evidenceDir, { recursive: true });
  seedProductState({ userDataDir, projectRoot });

  const npmGlobalDir = path.join(process.env.APPDATA || '', 'npm');
  launched = await launchDesktop({
    executable: packagedExe,
    projectRoot,
    userDataDir,
    runtimeRoot,
    runtimeDir,
    runtimeOwnership,
    onOwnershipController(controller) {
      ownershipController = controller;
    },
    env: { PATH: [npmGlobalDir, process.env.PATH].filter(Boolean).join(path.delimiter) },
  });
  console.log(`LAUNCHED rootPid=${launched.rootPid} debugPort=${launched.debugPort}`);

  let startup = await waitForStartup(/renderer ready=true/, 60000, 'renderer ready marker');
  startup = await waitForStartup(/CodeBuddy runtime ready project=\S+ port=\d+\b/, 90000, 'real CodeBuddy runtime');
  const startupContract = requireUsableCodeBuddyStartup(startup);
  summary.observations.runtimePort = startupContract.port;
  recordCheck('real packaged CodeBuddy runtime started', startupContract.state === 'ready', startupContract);

  const target = await findRendererTarget({
    port: launched.debugPort,
    expectedUrl: /^http:\/\/127\.0\.0\.1:\d+\/index\.html$/,
    timeoutMs: 60000,
  });
  client = await connectCdp(target, { commandTimeoutMs: 120000, connectTimeoutMs: 30000 });
  await waitForRendererValue(client, 'Boolean(window.__CODEBUDDY_STORE__?.getState)', {
    timeoutMs: 30000,
    describe: 'packaged store readiness',
  });
  await client.evaluate(`if (location.hash !== '#/chat') location.hash = '#/chat'`);

  const ready = await waitForRendererValue(client, snapshotExpression, {
    timeoutMs: 120000,
    intervalMs: 250,
    describe: 'real CLI session connection',
    accept: (value) =>
      Boolean(value?.sessionId) && value?.connectionState === 'connected' && value?.hasRealClient && !value?.accountLoginNeeded,
  });
  summary.observations.ready = ready;
  recordCheck('real CLI session connected', true, {
    sessionId: ready.sessionId,
    connectionState: ready.connectionState,
    authState: ready.authState,
  });

  const firstUse = await clickVisibleButtonExact('开始使用');
  summary.observations.firstUse = firstUse;
  if (firstUse.clicked) await wait(500);
  await capture('00-real-session-ready');

  await dispatchPrompt('effort', '/effort ultracode');
  const effort = await waitForRendererValue(
    client,
    `(() => {
      const qa = window.__workflowDrainQa || {};
      const state = window.__CODEBUDDY_STORE__.getState();
      const thread = state.threadsById?.[state.activeThreadId];
      return { command: qa.effort || null, threadStatus: thread?.status || null, error: state.error || null };
    })()`,
    {
      timeoutMs: 240000,
      intervalMs: 250,
      describe: '/effort ultracode completion',
      accept: (value) => Boolean(value?.command?.settled) && !['running', 'waiting', 'cancelling'].includes(value?.threadStatus),
    },
  );
  summary.observations.effort = effort;
  recordCheck('/effort ultracode completed through real CLI', !effort.command.error, effort.command);

  const fullAccess = await setFullAccessMode();
  summary.observations.fullAccess = fullAccess;
  recordCheck('real CLI session switched to full access', fullAccess.ok, fullAccess);
  if (!fullAccess.ok) throw new Error(`full access mode setup failed: ${JSON.stringify(fullAccess)}`);

  await installTrace();
  const dispatched = await dispatchPrompt('primary', promptText);
  summary.observations.primaryDispatch = dispatched;
  console.log(`PROMPT dispatched at ${new Date(dispatched.startedAt).toISOString()}`);

  const workflowStart = await waitForWorkflowAgents(workflowAgentTimeoutMs);
  const withAgents = workflowStart.snapshot;
  summary.observations.withAgents = withAgents;
  summary.observations.permissionApprovals = workflowStart.permissionApprovals;
  recordCheck('Workflow permission path was satisfied', fullAccess.ok || workflowStart.permissionApprovals > 0, {
    fullAccessMode: fullAccess.modeId,
    approvals: workflowStart.permissionApprovals,
  });
  recordCheck('real workflow exposes agent metadata', true, withAgents.workflow);

  let panel = withAgents.panel;
  let manualPanelOpen = false;
  if (!panel.visible) {
    manualPanelOpen = true;
    await client.evaluate(`(() => {
      const state = window.__CODEBUDDY_STORE__.getState();
      const threadId = state.activeThreadId;
      const runtime = state.threadRuntimeById?.[threadId];
      const workflow = runtime?.workflowState || runtime?.lastWorkflowState;
      state.openWorkflowPanel({ projectId: state.activeProjectId, threadId, runId: workflow?.runId || null });
      return true;
    })()`);
  }
  const panelWithAgents = await waitForRendererValue(client, snapshotExpression, {
    timeoutMs: 30000,
    intervalMs: 100,
    describe: 'workflow panel agent rows',
    accept: (value) => value?.panel?.visible && value.panel.subagentRows > 0,
  });
  summary.observations.panelWithAgents = panelWithAgents.panel;
  summary.observations.manualPanelOpen = manualPanelOpen;
  recordCheck('workflow popup shows real agent rows', panelWithAgents.panel.subagentRows > 0, panelWithAgents.panel);
  recordCheck(
    'workflow popup no longer says no subagents',
    !/暂无子代理活动/.test(panelWithAgents.panel.subagentText),
    panelWithAgents.panel.subagentText,
  );
  await capture('01-real-workflow-agents');

  const idleWhileActive = await waitForRendererValue(
    client,
    `(() => {
      const qa = window.__workflowDrainQa || {};
      const current = ${snapshotExpression};
      const traced = (qa.trace || []).find((item) => item.threadStatus === 'idle' && item.workflowActive === true) || null;
      return { current, traced };
    })()`,
    {
      timeoutMs: 480000,
      intervalMs: 250,
      describe: 'idle thread with active background workflow',
      accept: (value) => Boolean(value?.traced),
    },
  );
  summary.observations.idleWhileActive = idleWhileActive.traced;
  recordCheck('workflow remains active after prompt thread becomes idle', true, idleWhileActive.traced);
  if (idleWhileActive.current?.threadStatus === 'idle' && idleWhileActive.current?.workflow?.active) {
    await capture('02-idle-thread-active-workflow');
  }

  const drain = await waitForRendererValue(
    client,
    `(() => {
      const trace = window.__workflowDrainQa?.trace || [];
      return trace.find((item) =>
        item.backgroundDrainRunId &&
        item.backgroundDrainUntil > item.at &&
        item.backgroundDrainMaxUntil >= item.backgroundDrainUntil
      ) || null;
    })()`,
    {
      timeoutMs: 480000,
      intervalMs: 250,
      describe: 'workflow background drain window',
    },
  );
  summary.observations.backgroundDrain = drain;
  recordCheck('workflow finish opens a bounded background drain window', true, drain);

  const finalState = await waitForRendererValue(client, snapshotExpression, {
    timeoutMs: 600000,
    intervalMs: 250,
    describe: 'background workflow final assistant summary',
    accept: (value) => {
      const afterPrompt = (value?.assistants || []).filter((item) => item.createdAt >= dispatched.startedAt - 1000);
      return afterPrompt.some((item) => /codebuddy-gui/i.test(item.content) && /1\.1\.0/.test(item.content));
    },
  });
  summary.observations.final = finalState;
  const afterPrompt = finalState.assistants.filter((item) => item.createdAt >= dispatched.startedAt - 1000);
  recordCheck('background final summary reached chat', true, afterPrompt);
  recordCheck(
    'final summary arrived as a post-start assistant update',
    afterPrompt.some((item) => /codebuddy-gui/i.test(item.content) && /1\.1\.0/.test(item.content)),
    { assistantMessages: afterPrompt.length },
  );
  const renderedFinal = await waitForRendererValue(
    client,
    `(() => {
      const text = document.body?.innerText || '';
      return {
        visible: /codebuddy-gui/i.test(text) && /1\\.1\\.0/.test(text),
        hasName: /codebuddy-gui/i.test(text),
        hasVersion: /1\\.1\\.0/.test(text),
      };
    })()`,
    {
      timeoutMs: 30000,
      intervalMs: 100,
      describe: 'background workflow final summary rendered in chat',
      accept: (value) => value?.visible === true,
    },
  );
  summary.observations.renderedFinal = renderedFinal;
  recordCheck('background final summary is visibly rendered in chat', renderedFinal.visible, renderedFinal);

  const settledFinal = await waitForRendererValue(client, snapshotExpression, {
    timeoutMs: 30000,
    intervalMs: 100,
    describe: 'background workflow final assistant stream closure',
    accept: (value) => {
      const candidates = (value?.assistants || []).filter((item) => item.createdAt >= dispatched.startedAt - 1000);
      return candidates.some(
        (item) =>
          /codebuddy-gui/i.test(item.content) &&
          /1\.1\.0/.test(item.content) &&
          item.streaming === false &&
          Number(item.completedAt) > 0,
      );
    },
  });
  summary.observations.settledFinal = settledFinal;
  recordCheck('background final assistant stream closed', true);
  await capture('03-background-final-summary');

  const qaState = await readQaState();
  summary.observations.promptPromise = qaState.primary;
  summary.trace = qaState.trace;
  summary.clientEvents = qaState.clientEvents;
  summary.completedAt = new Date().toISOString();
  const failed = Object.values(summary.checks).filter((check) => !check.ok);
  summary.ok = failed.length === 0;
  if (!summary.ok) throw new Error(`${failed.length} acceptance check(s) failed`);
}

async function finalize() {
  if (client) {
    try {
      const qaState = await readQaState();
      if (!summary.trace) summary.trace = qaState.trace;
      if (!summary.clientEvents) summary.clientEvents = qaState.clientEvents;
      summary.observations.promptPromise ||= qaState.primary;
      await client.evaluate(`(() => {
        window.__workflowDrainQa?.unsubscribe?.();
        window.__workflowDrainQa?.unsubscribeClient?.();
        window.__workflowDrainQa?.unsubscribeRawExtension?.();
        return true;
      })()`).catch(() => {});
    } catch (_) {}
  }
  if (fs.existsSync(startupLogPath)) {
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.copyFileSync(startupLogPath, path.join(evidenceDir, 'electron-startup.log'));
  }
  const sessionId = summary.observations.ready?.sessionId;
  if (sessionId && process.env.USERPROFILE) {
    const workflowDir = path.join(
      process.env.USERPROFILE,
      '.codebuddy',
      'projects',
      'c-Users-48818-Documents-CodeBuddyGUI',
      sessionId,
      'workflows',
    );
    if (fs.existsSync(workflowDir)) {
      const records = fs.readdirSync(workflowDir)
        .filter((name) => /^wf_.*\.json$/i.test(name))
        .map((name) => ({ name, mtimeMs: fs.statSync(path.join(workflowDir, name)).mtimeMs }))
        .sort((left, right) => right.mtimeMs - left.mtimeMs);
      if (records.length) {
        const source = path.join(workflowDir, records[0].name);
        const destination = path.join(evidenceDir, 'workflow-record.json');
        fs.copyFileSync(source, destination);
        const record = JSON.parse(fs.readFileSync(source, 'utf8'));
        summary.observations.cliWorkflowRecord = {
          path: destination,
          runId: record.runId || null,
          status: record.status || null,
          phaseCount: Number(record.phaseCount) || 0,
          agentCount: Number(record.agentCount) || 0,
          durationMs: Number(record.durationMs) || 0,
          error: record.error || null,
        };
      }
    }
  }
  try {
    client?.close?.();
  } catch (_) {}
  if (ownershipController) {
    const cleanup = await ownershipController.close().catch((error) => ({ error: error.message }));
    summary.cleanup = cleanup;
  } else if (launched) {
    await cleanupOwned({
      rootPid: launched.rootPid,
      trackedProcesses: launched.rootIdentity ? [launched.rootIdentity] : [],
    }).catch((error) => console.warn(`cleanupOwned: ${error.message}`));
  }
  await cleanupRuntimeDir({ ...runtimeOwnership, runtimeRoot, runtimeDir }).catch((error) =>
    console.warn(`cleanupRuntimeDir: ${error.message}`),
  );
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`EVIDENCE ${evidenceDir}`);
}

main()
  .catch(async (error) => {
    summary.ok = false;
    summary.completedAt = new Date().toISOString();
    summary.error = serializeError(error);
    console.error(error);
    if (client) await capture('failure').catch(() => {});
    process.exitCode = 1;
  })
  .finally(finalize);
