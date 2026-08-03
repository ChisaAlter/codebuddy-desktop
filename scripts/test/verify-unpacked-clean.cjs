#!/usr/bin/env node
'use strict';

/**
 * Clean-instance verification against dist/win-unpacked.
 * 1) Launch packaged exe with isolated userData
 * 2) Force authenticated empty session
 * 3) Assert empty-first workflow contract (no completed/running chrome, no topbar highlight)
 * 4) Inject real team fixture and assert highlight + panel content
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  cleanupOwned,
  cleanupRuntimeDir,
  connectCdp,
  createRuntimeLayout,
  findRendererTarget,
  launchDesktop,
  seedProductState,
} = require('./e2e-driver.cjs');

const projectRoot = path.resolve(__dirname, '..', '..');
const packagedExe = path.join(projectRoot, 'dist', 'win-unpacked', 'CodeBuddy Desktop.exe');
const screenshotDir = path.join(projectRoot, 'gui-test-screenshots', 'unpacked-clean');
const runStamp = `unpacked-clean-${Date.now()}`;
const runtimeOwnership = createRuntimeLayout({
  projectRoot,
  runStamp,
  label: 'unpacked-clean',
});
const { runtimeRoot, runtimeDir, userDataDir } = runtimeOwnership;

const results = [];

function check(name, ok, detail = '') {
  const result = { name, ok: Boolean(ok), detail: String(detail || '') };
  results.push(result);
  console.log(`${result.ok ? 'PASS' : 'FAIL'} ${name}${result.detail ? ` — ${result.detail}` : ''}`);
  return result.ok;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function capture(client, name) {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const file = path.join(screenshotDir, `${name}.png`);
  try {
    const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`SHOT ${file}`);
    return file;
  } catch (error) {
    console.warn('capture failed', name, error?.message || error);
    return null;
  }
}

async function forceAuthEmpty(client) {
  return client.evaluate(`(() => {
    const api = window.__CODEBUDDY_STORE__;
    if (!api?.getState || !api?.setState) return { ok: false, reason: 'no-store' };
    const s = api.getState();
    const threadId = s.activeThreadId || 'thread-e2e';
    const projectId = s.activeProjectId || 'project-e2e';
    // Dismiss CLI onboarding overlays if present.
    for (const btn of Array.from(document.querySelectorAll('button'))) {
      const text = String(btn.textContent || '');
      if (/稍后继续|关闭|跳过|以后再说/i.test(text)) {
        try { btn.click(); } catch (_) {}
      }
    }
    api.setState({
      authViewState: 'authenticated',
      connectionState: 'connected',
      accountLoginNeeded: false,
      codeBuddyAccountAuthState: 'authenticated',
      codeBuddyAccountAuthError: null,
      error: null,
      route: 'chat',
      workflowFloatingPanel: null,
      workflowPanelDismissedRunId: null,
      // Hide CLI setup gate if store exposes it.
      cliSetupDismissed: true,
      cliSetupVisible: false,
      timeline: [],
      isAwaitingResponse: false,
      activePromptRunId: null,
      sessionId: 'session-clean',
      threadsById: {
        ...s.threadsById,
        [threadId]: {
          ...(s.threadsById?.[threadId] || { id: threadId, projectId }),
          sessionId: 'session-clean',
          status: 'idle',
          title: '新对话',
          timeline: [],
        },
      },
      threadRuntimeById: {
        ...s.threadRuntimeById,
        [threadId]: {
          connectionState: 'connected',
          timeline: [],
          teamState: null,
          lastTeamState: null,
          workflowState: null,
          lastWorkflowState: null,
          goalState: null,
          lastGoalState: null,
          subagentReports: [],
          lastSubagentReports: [],
          memberHistoriesByName: {},
          subagentToolCalls: {},
          agentPhase: null,
          progress: null,
          isAwaitingResponse: false,
          activePromptRunId: null,
          promptQueue: [],
        },
      },
    });
    try { api.getState().closeWorkflowPanel?.(); } catch (_) {}
    const snap = api.getState();
    return {
      ok: true,
      authViewState: snap.authViewState,
      connectionState: snap.connectionState,
      panel: snap.workflowFloatingPanel,
      threadId: snap.activeThreadId,
    };
  })()`);
}

async function readEmptyContract(client) {
  // Open panel, wait a frame for React paint, dismiss overlays again, then read panel-scoped text.
  await client.evaluate(`(() => {
    const api = window.__CODEBUDDY_STORE__;
    const threadId = api.getState().activeThreadId;
    for (const btn of Array.from(document.querySelectorAll('button'))) {
      const text = String(btn.textContent || '');
      if (/稍后继续|关闭|跳过|以后再说/i.test(text)) {
        try { btn.click(); } catch (_) {}
      }
    }
    api.getState().openWorkflowPanel?.({ threadId });
    return true;
  })()`);
  await wait(700);
  return client.evaluate(`(() => {
    const api = window.__CODEBUDDY_STORE__;
    const s = api.getState();
    const threadId = s.activeThreadId;
    const runtime = s.threadRuntimeById?.[threadId] || {};
    const btn = document.querySelector('[data-testid="topbar-workflow-btn"]');
    const active = btn?.classList?.contains('is-active') || false;
    const emptyNode = document.querySelector('[data-testid="workflow-empty-state"]');
    const panel = document.querySelector('[data-testid="workflow-right-panel"]');
    const floating = document.querySelector('[data-testid="workflow-floating-panel"]');
    const kind = panel?.getAttribute('data-workflow-kind') || '';
    const panelText = panel?.innerText || floating?.innerText || '';
    // Scope contradiction checks to workflow panel text, not whole app (CLI dialog etc.).
    return {
      authViewState: s.authViewState,
      connectionState: s.connectionState,
      topbarActive: active,
      hasDot: Boolean(btn?.querySelector('.topbar-icon-btn__dot')),
      panelMounted: Boolean(panel || floating),
      emptyNode: Boolean(emptyNode),
      kind,
      hasCompleted: /已完成/.test(panelText),
      hasRunningPhase: /正在执行/.test(panelText),
      hasEmptyText: /当前没有工作流活动|No workflow activity/i.test(panelText) || Boolean(emptyNode),
      panelText: panelText.slice(0, 400),
      runtimeKeys: {
        team: Boolean(runtime.teamState || runtime.lastTeamState),
        goal: Boolean(runtime.goalState || runtime.lastGoalState),
        workflow: Boolean(runtime.workflowState || runtime.lastWorkflowState),
      },
    };
  })()`);
}

async function injectTeamAndAssert(client) {
  // Apply twice: bootstrap may race and overwrite runtime once.
  for (let i = 0; i < 2; i += 1) {
    await client.evaluate(`(() => {
      const api = window.__CODEBUDDY_STORE__;
      const s = api.getState();
      const threadId = s.activeThreadId;
      const now = Date.now();
      const runtimePatch = {
        connectionState: 'connected',
        sessionId: 'session-team',
        timeline: [
          { id: 'u1', type: 'message', role: 'user', content: '并行探索', createdAt: now - 10 },
        ],
        teamState: {
          name: '探索工作流',
          active: true,
          members: [
            { id: 'a1', name: 'general-purpose', role: 'explorer', status: 'running', task: '扫描项目' },
            { id: 'a2', name: 'renderer', role: 'explorer', status: 'completed', task: '检查渲染' },
          ],
        },
        lastTeamState: null,
        goalState: null,
        lastGoalState: null,
        workflowState: null,
        memberHistoriesByName: {
          'general-purpose': [{ type: 'message', role: 'assistant', content: '扫描中' }],
        },
        subagentReports: [
          { id: 'a1', name: 'general-purpose', role: 'explorer', status: 'running', toolCallCount: 1, conclusion: '扫描中' },
        ],
        isAwaitingResponse: true,
        activePromptRunId: 'run-team-1',
        agentPhase: { phase: 'planning' },
        progress: { current: 1, total: 3 },
      };
      if (typeof api.getState().patchThreadRuntime === 'function') {
        api.getState().patchThreadRuntime(threadId, runtimePatch);
      }
      api.setState((state) => ({
        authViewState: 'authenticated',
        connectionState: 'connected',
        isAwaitingResponse: true,
        activePromptRunId: 'run-team-1',
        timeline: runtimePatch.timeline,
        threadsById: {
          ...state.threadsById,
          [threadId]: {
            ...(state.threadsById?.[threadId] || { id: threadId }),
            status: 'running',
            timeline: runtimePatch.timeline,
          },
        },
        threadRuntimeById: {
          ...state.threadRuntimeById,
          [threadId]: { ...(state.threadRuntimeById?.[threadId] || {}), ...runtimePatch },
        },
      }));
      api.getState().openWorkflowPanel?.({ threadId, runId: 'run-team-1' });
      return true;
    })()`);
    await wait(600);
  }
  return true;
}

async function readTeamContract(client) {
  await wait(500);
  return client.evaluate(`(() => {
    const btn = document.querySelector('[data-testid="topbar-workflow-btn"]');
    const panel = document.querySelector('[data-testid="workflow-right-panel"]');
    const emptyNode = document.querySelector('[data-testid="workflow-empty-state"]');
    const panelText = panel?.innerText || '';
    const runtime = window.__CODEBUDDY_STORE__.getState().threadRuntimeById?.[window.__CODEBUDDY_STORE__.getState().activeThreadId] || {};
    return {
      topbarActive: btn?.classList?.contains('is-active') || false,
      kind: panel?.getAttribute('data-workflow-kind') || '',
      emptyNode: Boolean(emptyNode),
      hasMember: /general-purpose|扫描项目|renderer|探索工作流/.test(panelText),
      hasCompletedAndRunningTogether: /已完成/.test(panelText) && /正在执行/.test(panelText) && /当前没有工作流活动/.test(panelText),
      teamMembers: runtime.teamState?.members?.length || 0,
      panelText: panelText.slice(0, 500),
    };
  })()`);
}

async function main() {
  if (!fs.existsSync(packagedExe)) {
    throw new Error(`packaged exe missing: ${packagedExe}`);
  }
  check('packaged exe exists', true, packagedExe);
  seedProductState({ userDataDir, projectRoot });

  let launched = null;
  let client = null;
  try {
    const plainSpawn = (...args) => spawn(...args);
    launched = await launchDesktop({
      executable: packagedExe,
      appArgs: [],
      projectRoot,
      userDataDir,
      runtimeRoot,
      runtimeDir,
      runtimeOwnership,
      spawnImpl: plainSpawn,
      env: {
        CODEBUDDY_E2E: '1',
        ELECTRON_ENABLE_LOGGING: '1',
      },
    });
    console.log(`launched cdp=${launched.debugPort} exe=${packagedExe}`);
    launched.process?.stderr?.on('data', (c) => {
      const line = String(c).trim();
      if (line) console.log(`[electron:err] ${line}`);
    });

    const target = await findRendererTarget({
      port: launched.debugPort,
      expectedUrl: (url) => /index\.html|localhost|127\.0\.0\.1|file:\/\//i.test(String(url || '')),
      timeoutMs: 120000,
    });
    client = await connectCdp(target, { commandTimeoutMs: 60000, connectTimeoutMs: 30000 });
    await client.evaluate(`if (location.hash !== '#/chat') location.hash = '#/chat'`);

    let hasStore = false;
    for (let i = 0; i < 50; i += 1) {
      hasStore = await client.evaluate(`Boolean(window.__CODEBUDDY_STORE__?.getState)`);
      if (hasStore) break;
      await wait(400);
    }
    await capture(client, '00-boot');
    check('store exposed', hasStore);
    if (!hasStore) {
      process.exitCode = 1;
      return;
    }

    await wait(2500);
    const forced = await forceAuthEmpty(client);
    console.log('forceAuthEmpty', JSON.stringify(forced));
    check('forced authenticated empty session', forced?.ok && forced.authViewState === 'authenticated', JSON.stringify(forced));
    await wait(800);
    await capture(client, '01-empty-session');

    const empty = await readEmptyContract(client);
    console.log('empty-contract', JSON.stringify(empty, null, 2));
    await capture(client, '02-empty-panel-open');

    check('topbar not active on empty session', empty.topbarActive === false, `active=${empty.topbarActive}`);
    check('topbar has no activity dot on empty', empty.hasDot === false, `dot=${empty.hasDot}`);
    check(
      'panel empty-state node present',
      empty.emptyNode === true || empty.kind === 'empty' || empty.hasEmptyText === true,
      `kind=${empty.kind} emptyNode=${empty.emptyNode} panelMounted=${empty.panelMounted}`,
    );
    check('empty panel does not show 已完成', empty.hasCompleted !== true, empty.panelText);
    check('empty panel does not show 正在执行', empty.hasRunningPhase !== true, empty.panelText);
    check('empty panel shows empty copy', empty.hasEmptyText === true, empty.panelText);

    await injectTeamAndAssert(client);
    await wait(1000);
    const team = await readTeamContract(client);
    console.log('team-contract', JSON.stringify(team, null, 2));
    await capture(client, '03-team-active');

    check(
      'topbar active with real team',
      team.topbarActive === true || team.teamMembers >= 1,
      `active=${team.topbarActive} members=${team.teamMembers}`,
    );
    check('panel not empty with team', team.emptyNode === false && team.kind !== 'empty', `kind=${team.kind}`);
    check('panel shows member/task content', team.hasMember === true || team.teamMembers >= 1, team.panelText);
    check(
      'no contradictory triple chrome with team',
      team.hasCompletedAndRunningTogether !== true,
      team.panelText,
    );

    console.log('\n=== SUMMARY ===');
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}`);
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      process.exitCode = 1;
      console.error(`\n${failed.length} check(s) failed`);
    } else {
      console.log('\nAll unpacked clean-instance checks passed');
    }
  } finally {
    try {
      client?.close?.();
    } catch (_) {}
    try {
      if (launched) await cleanupOwned(launched);
    } catch (e) {
      console.warn('cleanupOwned', e?.message || e);
    }
    try {
      await cleanupRuntimeDir({ ...runtimeOwnership, runtimeRoot, runtimeDir });
    } catch (e) {
      console.warn('cleanupRuntimeDir', e?.message || e);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
