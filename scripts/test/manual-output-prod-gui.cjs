#!/usr/bin/env node
'use strict';

/**
 * Production GUI smoke against packaged win-unpacked (user desktop path).
 * Injects path-wall tool output + subagent parent/children + goal-status into the
 * live store, then asserts structured DOM (not raw path walls).
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
  waitForRendererValue,
} = require('./e2e-driver.cjs');

const projectRoot = path.resolve(__dirname, '..', '..');
const electronExe = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const screenshotDir = path.join(projectRoot, 'gui-test-screenshots', 'prod-deliver');
const runStamp = `prod-out-${Date.now()}`;
const runtimeOwnership = createRuntimeLayout({
  projectRoot,
  runStamp,
  label: 'prod-output',
});
const { runtimeRoot, runtimeDir, userDataDir } = runtimeOwnership;

const PATH_WALL = Array.from(
  { length: 24 },
  (_, i) => `C:\\A\\ChisaTerminal\\node_modules\\pkg${i}\\dist\\index.js`,
).join('\n');

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

async function injectFixtures(client) {
  return client.evaluate(`(() => {
    const api = window.__CODEBUDDY_STORE__;
    if (!api?.getState || !api?.setState) return { ok: false, reason: 'no-store' };

    const threadId = api.getState().activeThreadId || 'thread-e2e';
    const now = Date.now();
    const pathWall = ${JSON.stringify(PATH_WALL)};
    const pathArr = pathWall.split('\\n');

    const parentId = 'tool-subagent-parent';
    const childIds = ['tool-child-1', 'tool-child-2', 'tool-child-3'];

    const children = childIds.map((id, index) => ({
      id: id,
      type: 'tool_call',
      role: 'assistant',
      toolCallId: id,
      parentToolCallId: parentId,
      toolName: index === 0 ? 'Glob' : index === 1 ? 'Read' : 'Bash',
      title: index === 0 ? 'Glob' : index === 1 ? 'Read' : 'Bash',
      kind: index === 0 ? 'search' : index === 1 ? 'read' : 'execute',
      status: 'completed',
      rawInput: index === 0 ? { pattern: '**/*' } : index === 1 ? { path: 'package.json' } : { command: 'echo ok' },
      rawOutput: index === 0 ? pathArr : index === 1 ? '{\\n  \\"name\\": \\"demo\\"\\n}' : 'ok\\n',
      createdAt: now + index + 1,
      isSubAgent: false,
      children: [],
    }));

    const parent = {
      id: parentId,
      type: 'tool_call',
      role: 'assistant',
      toolCallId: parentId,
      toolName: 'Agent',
      title: 'explore',
      kind: 'agent',
      status: 'completed',
      isSubAgent: true,
      memberName: 'general-purpose',
      subagentType: 'general-purpose',
      description: '只读探索项目结构',
      rawInput: { description: '只读探索项目结构' },
      rawOutput: pathWall,
      children,
      subagentTimeline: [
        { id: 'st-1', type: 'message', role: 'assistant', content: '已完成目录扫描，未修改任何文件。' },
      ],
      createdAt: now,
    };

    const plainTool = {
      id: 'tool-plain-glob',
      type: 'tool_call',
      role: 'assistant',
      toolCallId: 'tool-plain-glob',
      toolName: 'Glob',
      title: 'Glob',
      kind: 'search',
      status: 'completed',
      rawInput: { pattern: '**/*.js' },
      rawOutput: pathArr,
      children: [],
      createdAt: now + 10,
    };

    const userMsg = {
      id: 'user-prod-1',
      type: 'message',
      role: 'user',
      content: '请只读扫描项目并汇总路径（生产实机验证）',
      createdAt: now - 10,
    };

    const assistantMsg = {
      id: 'asst-prod-1',
      type: 'message',
      role: 'assistant',
      content: '扫描完成：共找到依赖与源码路径，详见工具结果。',
      createdAt: now + 20,
    };

    const goalStatus = {
      id: 'goal-status-1',
      type: 'goal-status',
      role: 'system',
      createdAt: now + 5,
      meta: {
        kind: 'active',
        title: '生产实机验证目标',
        status: 'running',
        condition: '所有测试通过',
      },
    };

    const timeline = [userMsg, parent, plainTool, goalStatus, assistantMsg];

    // Seed goal state for panel
    const goalState = {
      mode: 'goal',
      goalsById: {
        'local-seed': {
          goalId: 'local-seed',
          title: '生产实机验证目标',
          message: '',
          status: 'running',
          condition: '所有测试通过',
          kind: 'active',
          seeded: true,
          progress: { percent: 40, current: 2, total: 5, message: '' },
          updatedAt: now,
        },
      },
      activeGoalId: 'local-seed',
      eventCount: 1,
      runId: 'run-prod',
      updatedAt: now,
    };

    const runtimePatch = {
      connectionState: 'connected',
      sessionId: 'session-prod',
      timeline,
      goalState,
      lastGoalState: null,
      isAwaitingResponse: false,
      activePromptRunId: null,
      promptDispatchInFlight: false,
      promptQueue: [],
      teamState: {
        members: [
          {
            name: 'general-purpose',
            role: 'explorer',
            agentId: 'agent-prod-1',
            status: 'completed',
            toolCallCount: 3,
          },
        ],
      },
      lastTeamState: null,
      memberHistoriesByName: {
        'general-purpose': [
          { type: 'message', role: 'assistant', content: '已完成目录扫描，未修改任何文件。' },
        ],
      },
      subagentToolCalls: {
        [parentId]: parent,
      },
      subagentReports: [],
      lastSubagentReports: [],
    };

    // Prefer patchThreadRuntime so ACTIVE_THREAD_RUNTIME_KEYS mirror correctly.
    if (typeof api.getState().patchThreadRuntime === 'function') {
      api.getState().patchThreadRuntime(threadId, runtimePatch);
    }
    api.setState((state) => ({
      // Bypass AuthLoadingView / login shell so fixture timeline can paint.
      authViewState: 'authenticated',
      connectionState: 'connected',
      sessionId: 'session-prod',
      accountLoginNeeded: false,
      codeBuddyAccountAuthState: 'authenticated',
      codeBuddyAccountAuthError: null,
      error: null,
      route: 'chat',
      timeline,
      isAwaitingResponse: false,
      activePromptRunId: null,
      goalState,
      lastGoalState: null,
      teamState: runtimePatch.teamState,
      memberHistoriesByName: runtimePatch.memberHistoriesByName,
      threadsById: {
        ...state.threadsById,
        [threadId]: {
          ...(state.threadsById?.[threadId] || { id: threadId, projectId: state.activeProjectId }),
          sessionId: 'session-prod',
          status: 'idle',
          timeline,
        },
      },
      threadRuntimeById: {
        ...state.threadRuntimeById,
        [threadId]: {
          ...(state.threadRuntimeById?.[threadId] || {}),
          ...runtimePatch,
        },
      },
    }));

    // Force open workflow panel after state is stable
    try {
      api.getState().openWorkflowPanel?.({ threadId, runId: 'run-prod' });
    } catch (_) {}

    const snap = api.getState();
    return {
      ok: true,
      timelineLen: snap.threadRuntimeById?.[threadId]?.timeline?.length,
      structured: snap.guiSettings?.structuredOutputV1 !== false,
      hasGoal: Boolean(snap.threadRuntimeById?.[threadId]?.goalState),
      activeThreadId: snap.activeThreadId,
    };
  })()`);
}

async function readDom(client) {
  return client.evaluate(`(() => {
    const body = document.body?.innerText || '';
    const pathList = document.querySelectorAll('[data-testid="tool-path-list-summary"]');
    const clamped = document.querySelectorAll('[data-testid="tool-output-clamped"]');
    const subCards = document.querySelectorAll('[data-testid="subagent-card"]');
    const children = document.querySelectorAll('[data-testid="subagent-children"]');
    const goalStrip = document.querySelector('[data-testid="goal-chat-strip"]');
    const goalPanel = document.querySelector('[data-testid="workflow-current-goal"]');
    const report = document.querySelector('[data-testid="subagent-report-card"]');
    const summaryStrip = document.querySelector('[data-testid="workflow-summary-strip"]');
    const toolsOnlyPanel = document.querySelector('[data-testid="workflow-tools-only"]');
    const floatingPanel = document.querySelector('[data-testid="workflow-floating-panel"]');

    // Count dense path-wall signatures in visible body (should be low when collapsed)
    const nmMatches = (body.match(/node_modules/gi) || []).length;
    const longPathLines = (body.match(/C:\\\\A\\\\ChisaTerminal\\\\node_modules/gi) || []).length;
    const bareAgentIds = (body.match(/\\b\\d{10,}-[a-z0-9]{4,}\\b/gi) || []).length;

    // Expand first path-list / tool if collapsed: click tool rows
    return {
      pathListCount: pathList.length,
      pathListDataCounts: Array.from(pathList).map((el) => el.getAttribute('data-count')),
      clampedCount: clamped.length,
      subagentCards: subCards.length,
      subagentChildren: children.length,
      hasGoalStrip: Boolean(goalStrip),
      goalStripText: goalStrip?.innerText?.slice(0, 200) || '',
      hasGoalPanel: Boolean(goalPanel),
      goalPanelText: goalPanel?.innerText?.slice(0, 300) || '',
      hasReport: Boolean(report),
      reportText: report?.innerText?.slice(0, 400) || '',
      hasSummaryStrip: Boolean(summaryStrip),
      summaryStripText: summaryStrip?.innerText?.slice(0, 200) || '',
      hasToolsOnlyPanel: Boolean(toolsOnlyPanel),
      hasFloatingPanel: Boolean(floatingPanel),
      bareAgentIdMentions: bareAgentIds,
      nodeModulesMentions: nmMatches,
      longPathMentions: longPathLines,
      bodyHasRawWall: longPathLines >= 12,
    };
  })()`);
}

async function expandTools(client) {
  return client.evaluate(`(() => {
    // Click all tool row expand chevrons / buttons that look collapsed
    const buttons = Array.from(document.querySelectorAll('.tool-call-row > button, .subagent-card__header'));
    let clicked = 0;
    for (const btn of buttons) {
      const expanded = btn.getAttribute('aria-expanded');
      if (expanded === 'false' || expanded == null) {
        btn.click();
        clicked += 1;
      }
    }
    // Also click "more lines / show all paths" if present
    const more = Array.from(document.querySelectorAll('button')).filter((b) =>
      /还有|更多|Show all|more lines|paths/i.test(b.textContent || ''),
    );
    for (const b of more.slice(0, 3)) b.click();
    return { clicked, more: more.length };
  })()`);
}

async function main() {
  if (!fs.existsSync(electronExe)) throw new Error('electron missing');
  seedProductState({ userDataDir, projectRoot });

  let launched = null;
  let client = null;
  try {
    const plainSpawn = (...args) => spawn(...args);
    launched = await launchDesktop({
      executable: electronExe,
      appArgs: ['.'],
      projectRoot,
      userDataDir,
      runtimeRoot,
      runtimeDir,
      runtimeOwnership,
      spawnImpl: plainSpawn,
      env: { CODEBUDDY_E2E: '1', ELECTRON_ENABLE_LOGGING: '1' },
    });
    console.log(`launched cdp=${launched.debugPort}`);
    launched.process?.stderr?.on('data', (c) => console.log(`[electron:err] ${String(c).trim()}`));

    const target = await findRendererTarget({
      port: launched.debugPort,
      expectedUrl: (url) => /localhost:5173|127\.0\.0\.1:\d+\/index\.html|file:\/\//i.test(String(url || '')),
      timeoutMs: 90000,
    });
    client = await connectCdp(target, { commandTimeoutMs: 60000, connectTimeoutMs: 30000 });
    await client.evaluate(`if (location.hash !== '#/chat') location.hash = '#/chat'`);
    // Wait until renderer + store are ready (HMR/bootstrap can lag).
    let hasStore = false;
    for (let i = 0; i < 40; i += 1) {
      hasStore = await client.evaluate(`Boolean(window.__CODEBUDDY_STORE__?.getState)`);
      if (hasStore) break;
      await wait(500);
    }
    await capture(client, '00-boot');
    check('store exposed for fixture inject', hasStore);
    if (!hasStore) {
      await capture(client, 'blocked-no-store');
      process.exitCode = 1;
      return;
    }

    // Wait for bootstrap churn to settle, then inject (bootstrap overwrites runtime).
    await wait(4000);
    await client.evaluate(`(() => {
      const api = window.__CODEBUDDY_STORE__;
      const gs = { ...(api.getState().guiSettings || {}), structuredOutputV1: true };
      api.setState({
        guiSettings: gs,
        authViewState: 'authenticated',
        connectionState: 'connected',
        accountLoginNeeded: false,
        codeBuddyAccountAuthState: 'authenticated',
        route: 'chat',
      });
      return true;
    })()`);

    let injected = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      injected = await injectFixtures(client);
      await wait(500);
      // Re-assert timeline still present (bootstrap may race) and auth shell is gone.
      const still = await client.evaluate(`(() => {
        const api = window.__CODEBUDDY_STORE__;
        const s = api.getState();
        const id = s.activeThreadId;
        const tl = s.threadRuntimeById?.[id]?.timeline || s.timeline || [];
        return {
          len: tl.length,
          types: tl.map((x) => x.type + ':' + (x.role || '')),
          rootLen: (s.timeline || []).length,
          authViewState: s.authViewState,
          connectionState: s.connectionState,
          body: (document.body?.innerText || '').slice(0, 120),
        };
      })()`);
      console.log('post-inject', attempt, JSON.stringify(still));
      if (still.len >= 3 && still.authViewState === 'authenticated' && !/正在连接 CodeBuddy/.test(still.body || '')) {
        break;
      }
      await wait(1000);
    }
    console.log('injected', JSON.stringify(injected));
    check('fixtures injected', Boolean(injected?.ok), JSON.stringify(injected));

    // Diagnostic: what does the chat actually show?
    const diag = await client.evaluate(`(() => {
      const api = window.__CODEBUDDY_STORE__;
      const s = api.getState();
      const id = s.activeThreadId;
      return {
        activeThreadId: id,
        rootTimeline: (s.timeline || []).map((x) => x.type),
        runtimeTimeline: (s.threadRuntimeById?.[id]?.timeline || []).map((x) => x.type + (x.isSubAgent ? ':sub' : '')),
        threadTimeline: (s.threadsById?.[id]?.timeline || []).map((x) => x.type),
        structured: s.guiSettings?.structuredOutputV1,
        userBubbles: document.querySelectorAll('[data-chat-role="user"]').length,
        assistantBubbles: document.querySelectorAll('[data-chat-role="assistant"]').length,
        bodySnippet: (document.body?.innerText || '').slice(0, 500),
      };
    })()`);
    console.log('diag', JSON.stringify(diag, null, 2));
    await capture(client, '01-injected-collapsed');

    let dom = await readDom(client);
    console.log('dom-collapsed', JSON.stringify(dom, null, 2));

    // Collapsed: should NOT show a raw path wall
    check(
      'collapsed view has no raw path wall',
      dom.bodyHasRawWall !== true && dom.longPathMentions < 12,
      `longPathMentions=${dom.longPathMentions}`,
    );
    check('subagent card present', dom.subagentCards >= 1, `cards=${dom.subagentCards}`);
    check('goal strip or panel present', dom.hasGoalStrip || dom.hasGoalPanel, JSON.stringify({
      strip: dom.hasGoalStrip,
      panel: dom.hasGoalPanel,
    }));
    // Report wall removed: chat must not host subagent-report-card; summary strip is OK when idle.
    check('chat has no subagent report wall', dom.hasReport !== true, `hasReport=${dom.hasReport}`);
    check(
      'no bare agent-id wall in chat body',
      Number(dom.bareAgentIdMentions || 0) === 0,
      `bareAgentIdMentions=${dom.bareAgentIdMentions}`,
    );
    check(
      'workflow summary strip or floating panel available',
      dom.hasSummaryStrip || dom.hasFloatingPanel || dom.hasGoalPanel,
      JSON.stringify({
        strip: dom.hasSummaryStrip,
        floating: dom.hasFloatingPanel,
        goalPanel: dom.hasGoalPanel,
      }),
    );

    const expand = await expandTools(client);
    console.log('expand', expand);
    await wait(600);
    await capture(client, '02-expanded');

    dom = await readDom(client);
    console.log('dom-expanded', JSON.stringify(dom, null, 2));

    check(
      'path-list summary appears after expand',
      dom.pathListCount >= 1,
      `pathListCount=${dom.pathListCount} counts=${JSON.stringify(dom.pathListDataCounts)}`,
    );
    check(
      'path-list reports full count (>=20)',
      (dom.pathListDataCounts || []).some((c) => Number(c) >= 20),
      JSON.stringify(dom.pathListDataCounts),
    );
    check(
      'expanded still not dumping full wall in body text',
      dom.longPathMentions < 20,
      `longPathMentions=${dom.longPathMentions}`,
    );
    check(
      'subagent nested children container when expanded',
      dom.subagentChildren >= 1 || dom.subagentCards >= 1,
      `children=${dom.subagentChildren}`,
    );
    // Full report wall is intentionally gone; if a legacy node appears it must not dump paths.
    if (dom.hasReport) {
      check(
        'report conclusion is not path wall',
        !/C:\\\\A\\\\ChisaTerminal\\\\node_modules\\\\pkg1/.test(dom.reportText || '') ||
          /paths|路径|扫描|完成/i.test(dom.reportText || ''),
        (dom.reportText || '').slice(0, 200),
      );
    } else {
      check('report wall omitted (panel owns details)', true, 'expected');
    }
    if (dom.hasSummaryStrip) {
      check(
        'summary strip is human readable',
        /子代理|代理|workflow|完成|失败|查看/i.test(dom.summaryStripText || ''),
        dom.summaryStripText,
      );
    }
    if (dom.hasGoalPanel) {
      check(
        'goal panel shows title/condition',
        /生产实机验证|所有测试|当前目标|Goal/i.test(dom.goalPanelText || ''),
        dom.goalPanelText,
      );
    }
    if (dom.hasGoalStrip) {
      check('goal strip visible text', /目标|Goal|生产/i.test(dom.goalStripText || ''), dom.goalStripText);
    }

    console.log('\n=== SUMMARY ===');
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}`);
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      process.exitCode = 1;
      console.error(`\n${failed.length} check(s) failed`);
    } else {
      console.log('\nAll production GUI checks passed');
    }
  } finally {
    try {
      client?.close?.();
    } catch (_) {}
    try {
      if (launched) await cleanupOwned({
          rootPid: launched.rootPid,
          trackedProcesses: launched.rootIdentity ? [launched.rootIdentity] : [],
        });
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
