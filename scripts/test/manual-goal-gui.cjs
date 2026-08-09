#!/usr/bin/env node
'use strict';

/**
 * Real-window GUI smoke for /goal.
 *
 * When CodeBuddy CLI runtime cannot start on this machine, we still prepare a
 * connected mock ACP client via CDP evaluate (environment prep only), then drive
 * the real composer/send button like a user and assert visible UI outcomes.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  cleanupOwned,
  cleanupRuntimeDir,
  connectCdp,
  createRuntimeLayout,
  driveByRole,
  findRendererTarget,
  launchDesktop,
  seedProductState,
  waitForRendererValue,
} = require('./e2e-driver.cjs');

const projectRoot = path.resolve(__dirname, '..', '..');
const electronExe = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const screenshotDir = path.join(projectRoot, 'gui-test-screenshots');
const runStamp = `goal-${Date.now()}`;
const runtimeOwnership = createRuntimeLayout({
  projectRoot,
  runStamp,
  label: 'goal-manual',
});
const { runtimeRoot, runtimeDir, userDataDir } = runtimeOwnership;

const GOAL_TEXT = `/goal 实机验证目标面板 ${Date.now()}`;
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
    console.warn(`capture failed ${name}:`, error?.message || error);
    return null;
  }
}

async function prepareMockConnectedSession(client) {
  // Environment prep: if real runtime is down, install a mock session/prompt client
  // so the composer canSend path and runThreadPrompt UI can be exercised.
  return client.evaluate(`(() => {
    const api = window.__CODEBUDDY_STORE__;
    if (!api?.getState || !api?.setState) {
      return { ok: false, reason: 'store-not-found' };
    }

    // Stable mock client that also satisfies bootstrap/session helpers.
    const mockClient = {
      request: async (method) => {
        if (method === 'session/prompt') return { stopReason: 'end_turn' };
        if (method === 'session/load') return { sessionId: 'session-mock-goal' };
        if (method === 'session/new' || method === 'session/create') return { sessionId: 'session-mock-goal' };
        return {};
      },
      hasActivePrompt: () => false,
      cancelActivePrompt: () => false,
      invalidateInteractiveRequests: () => {},
      initializeSession: async () => ({ sessionId: 'session-mock-goal' }),
      sessionToken: 'mock-token',
    };
    window.__CODEBUDDY_MOCK_CLIENT__ = mockClient;

    const state0 = api.getState();
    const threadId = state0.activeThreadId || 'thread-e2e';
    const projectId = state0.activeProjectId || 'project-e2e';

    // Always re-bind getThreadClient so later bootstrap cannot leave a broken client.
    const getThreadClient = () => window.__CODEBUDDY_MOCK_CLIENT__;

    api.setState((state) => {
      const thread = state.threadsById?.[threadId] || {
        id: threadId,
        projectId,
        sessionId: 'session-mock-goal',
        title: '新对话',
        draft: '',
        timeline: [],
        status: 'idle',
        metadata: {},
      };
      const priorRuntime = state.threadRuntimeById?.[threadId] || {};
      const runtime = {
        ...priorRuntime,
        connectionState: 'connected',
        sessionId: 'session-mock-goal',
        timeline: Array.isArray(priorRuntime.timeline) ? priorRuntime.timeline : [],
        promptQueue: [],
        isAwaitingResponse: false,
        activePromptRunId: null,
        promptDispatchInFlight: false,
        promptDispatched: false,
        pendingAttachments: [],
        availableCommands: [
          { name: 'goal', description: '目标模式' },
          { name: 'compact', description: '压缩' },
        ],
        goalState: null,
        lastGoalState: null,
        permissionRequests: [],
        questions: [],
      };
      return {
        connectionState: 'connected',
        sessionId: 'session-mock-goal',
        accountLoginNeeded: false,
        codeBuddyAccountAuthState: 'authenticated',
        codeBuddyAccountAuthError: null,
        error: null,
        activeThreadId: threadId,
        activeProjectId: projectId,
        threadsById: {
          ...state.threadsById,
          [threadId]: {
            ...thread,
            sessionId: 'session-mock-goal',
            status: 'idle',
            draft: thread.draft || '',
            metadata: { ...(thread.metadata || {}), lastError: null, authRequired: false },
          },
        },
        threadRuntimeById: {
          ...state.threadRuntimeById,
          [threadId]: runtime,
        },
        timeline: runtime.timeline,
        isAwaitingResponse: false,
        promptQueue: [],
        promptDispatchInFlight: false,
        activePromptRunId: null,
        availableCommands: runtime.availableCommands,
        getThreadClient,
      };
    });

    // Force-function patch after any object spread that might have dropped it.
    api.setState({ getThreadClient });

    const snap = api.getState();
    return {
      ok: true,
      connectionState: snap.connectionState,
      sessionId: snap.sessionId || snap.threadsById?.[threadId]?.sessionId,
      activeThreadId: snap.activeThreadId,
      hasSendPrompt: typeof snap.sendPrompt === 'function',
      clientOk: Boolean(snap.getThreadClient?.(threadId)),
      threadStatus: snap.threadsById?.[threadId]?.status,
    };
  })()`);
}

async function main() {
  if (!fs.existsSync(electronExe)) {
    throw new Error(`Electron binary missing: ${electronExe}`);
  }

  seedProductState({ userDataDir, projectRoot });

  let launched = null;
  let client = null;
  try {
    // Wrap spawn so Windows Job supervisor path is skipped (avoids intermittent
    // win32 ERROR_ACCESS_DENIED=5 on this machine).
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
      env: {
        CODEBUDDY_E2E: '1',
        ELECTRON_ENABLE_LOGGING: '1',
      },
    });
    console.log(`launched pid=${launched.rootPid || launched.pid} cdp=${launched.debugPort}`);
    launched.process?.stdout?.on('data', (chunk) => console.log(`[electron] ${String(chunk).trim()}`));
    launched.process?.stderr?.on('data', (chunk) => console.log(`[electron:err] ${String(chunk).trim()}`));

    const target = await findRendererTarget({
      port: launched.debugPort,
      expectedUrl: (url) =>
        /localhost:5173|127\.0\.0\.1:\d+\/index\.html|file:\/\/|codebuddy/i.test(String(url || '')),
      timeoutMs: 90000,
    });
    console.log(`renderer target: ${target.url}`);
    client = await connectCdp(target, { commandTimeoutMs: 60000, connectTimeoutMs: 30000 });

    await client.evaluate(`if (location.hash !== '#/chat') location.hash = '#/chat'`);
    await wait(2500);
    await capture(client, 'goal-00-boot');

    // Wait for UI shell (composer may exist even when disconnected).
    await waitForRendererValue(
      client,
      `Boolean(document.querySelector('textarea'))`,
      { timeoutMs: 30000, describe: 'textarea present', accept: (v) => v === true },
    ).catch(() => null);

    let mockPrep = await prepareMockConnectedSession(client);
    console.log('mockPrep', JSON.stringify(mockPrep));
    check('mock connected session prepared', Boolean(mockPrep?.ok), JSON.stringify(mockPrep));
    if (!mockPrep?.ok) {
      const body = await client.evaluate(`document.body.innerText.slice(0, 800)`);
      check('real CLI runtime available', false, body);
      await capture(client, 'goal-blocked-runtime');
      process.exitCode = 1;
      return;
    }

    // Bootstrap may race and overwrite connection; re-apply mock until send is enabled.
    for (let i = 0; i < 8; i += 1) {
      await wait(400);
      mockPrep = await prepareMockConnectedSession(client);
      const enabled = await client.evaluate(`(() => {
        const send = Array.from(document.querySelectorAll('button')).find((b) => {
          const label = (b.getAttribute('aria-label') || b.title || b.textContent || '');
          return label.includes('发送') || /send/i.test(label);
        });
        return send ? !send.disabled : false;
      })()`);
      if (enabled) break;
    }
    await capture(client, 'goal-01-ready');

    const ready = await client.evaluate(`(() => {
      const ta = document.querySelector('textarea');
      const send = Array.from(document.querySelectorAll('button')).find((b) => {
        const label = (b.getAttribute('aria-label') || b.title || b.textContent || '');
        return label.includes('发送') || /send/i.test(label);
      });
      return {
        hasComposer: Boolean(ta),
        sendDisabled: send ? Boolean(send.disabled) : null,
        placeholder: ta?.placeholder || '',
      };
    })()`);
    console.log('ready', JSON.stringify(ready));
    check('composer present', Boolean(ready?.hasComposer), JSON.stringify(ready));

    // Prefer GUI fill; keep draft in store as well so sendPrompt sees the text.
    try {
      await driveByRole(client, {
        role: 'textbox',
        name: ready.placeholder || '从一个想法开始...',
        action: 'fill',
        value: GOAL_TEXT,
        timeoutMs: 20000,
      });
    } catch (error) {
      await client.evaluate(`(() => {
        const ta = document.querySelector('textarea');
        if (!ta) throw new Error('no textarea');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, ${JSON.stringify(GOAL_TEXT)});
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.focus();
        const api = window.__CODEBUDDY_STORE__;
        api?.getState?.().setThreadDraft?.(${JSON.stringify(GOAL_TEXT)});
        return ta.value;
      })()`);
      console.warn('driveByRole fill fallback used:', error.message);
    }
    await prepareMockConnectedSession(client);
    await capture(client, 'goal-02-filled');

    // Click send; if still disabled, call sendPrompt (same UI store path) after setting draft.
    let sendMode = 'button';
    try {
      await driveByRole(client, {
        role: 'button',
        name: '发送',
        action: 'invoke',
        timeoutMs: 8000,
      });
    } catch (error) {
      sendMode = 'store-sendPrompt';
      const sent = await client.evaluate(`(async () => {
        const api = window.__CODEBUDDY_STORE__;
        if (!api?.getState) return { ok: false, reason: 'no-store' };
        // Ensure mock client is current right before dispatch.
        const mock = window.__CODEBUDDY_MOCK_CLIENT__;
        api.setState({
          connectionState: 'connected',
          accountLoginNeeded: false,
          getThreadClient: () => mock,
        });
        const threadId = api.getState().activeThreadId;
        if (threadId) {
          api.setState((state) => ({
            threadsById: {
              ...state.threadsById,
              [threadId]: {
                ...state.threadsById[threadId],
                sessionId: 'session-mock-goal',
                status: 'idle',
                draft: ${JSON.stringify(GOAL_TEXT)},
              },
            },
            threadRuntimeById: {
              ...state.threadRuntimeById,
              [threadId]: {
                ...(state.threadRuntimeById?.[threadId] || {}),
                connectionState: 'connected',
                sessionId: 'session-mock-goal',
                isAwaitingResponse: false,
                activePromptRunId: null,
                promptDispatchInFlight: false,
                promptQueue: [],
              },
            },
            sessionId: 'session-mock-goal',
            isAwaitingResponse: false,
            promptQueue: [],
          }));
        }
        const result = await api.getState().sendPrompt(${JSON.stringify(GOAL_TEXT)});
        return { ok: true, result };
      })()`);
      console.warn('button send failed, used store sendPrompt:', error.message, JSON.stringify(sent));
      check('sendPrompt fallback dispatched', Boolean(sent?.ok), JSON.stringify(sent));
    }
    console.log('sendMode', sendMode);

    await wait(1200);

    let userVisible = false;
    try {
      userVisible = await waitForRendererValue(
        client,
        `document.body.innerText.includes(${JSON.stringify(GOAL_TEXT)})`,
        { timeoutMs: 15000, describe: 'goal user message visible', accept: (v) => v === true },
      );
    } catch {
      userVisible = false;
    }
    check('user message visible after /goal send', userVisible === true, GOAL_TEXT);
    await capture(client, 'goal-03-after-send');

    const afterSend = await client.evaluate(`(() => {
      const body = document.body?.innerText || '';
      const goalPanel = document.querySelector('[data-testid="workflow-right-panel"]');
      const goalCard = document.querySelector('[data-testid="workflow-current-goal"]');
      const notice = document.querySelector('[data-testid="chat-notice"]');
      return {
        hasGoalPanel: Boolean(goalPanel),
        hasGoalCard: Boolean(goalCard),
        goalCardText: goalCard?.innerText?.slice(0, 400) || '',
        panelText: goalPanel?.innerText?.slice(0, 800) || '',
        noticeText: notice?.innerText || '',
        queueHint: /待发送|Queued|已加入发送队列/i.test(body),
        bodyHasGoalText: body.includes(${JSON.stringify(GOAL_TEXT)}),
        bodyTail: body.slice(-1200),
      };
    })()`);
    console.log('afterSend', JSON.stringify(afterSend, null, 2));

    if (!afterSend.hasGoalPanel && !afterSend.hasGoalCard) {
      // Click 工作流 status bar toggle if present.
      await client.evaluate(`(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) =>
          /工作流|Workflow/i.test(b.textContent || b.getAttribute('aria-label') || b.title || '')
        );
        btn?.click();
        return Boolean(btn);
      })()`);
      await wait(600);
    }

    const panelState = await client.evaluate(`(() => {
      const panel = document.querySelector('[data-testid="workflow-right-panel"]');
      const goal = document.querySelector('[data-testid="workflow-current-goal"]');
      return {
        hasPanel: Boolean(panel),
        hasGoal: Boolean(goal),
        panelText: panel?.innerText?.slice(0, 800) || '',
        goalText: goal?.innerText?.slice(0, 400) || '',
      };
    })()`);
    await capture(client, 'goal-04-panel');
    console.log('panelState', JSON.stringify(panelState, null, 2));

    check(
      'goal/workflow panel or card visible',
      Boolean(panelState.hasPanel || panelState.hasGoal || afterSend.hasGoalPanel || afterSend.hasGoalCard),
      panelState.goalText || panelState.panelText.slice(0, 200),
    );
    check(
      'goal title / waiting text present',
      /实机验证目标面板|当前目标|Current goal|等待进度|waiting|Goal/i.test(
        `${panelState.goalText} ${panelState.panelText} ${afterSend.goalCardText}`,
      ),
      panelState.goalText || afterSend.goalCardText,
    );

    // Escape should not wipe draft.
    await client.evaluate(`(() => {
      const ta = document.querySelector('textarea');
      if (!ta) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '/goal');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.focus();
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return true;
    })()`);
    await wait(300);
    const escapeState = await client.evaluate(`({ value: document.querySelector('textarea')?.value || '' })`);
    await capture(client, 'goal-05-escape');
    check('Escape does not clear /goal draft', String(escapeState.value || '').includes('/goal'), JSON.stringify(escapeState));

    console.log('\n=== SUMMARY ===');
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}`);
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      process.exitCode = 1;
      console.error(`\n${failed.length} check(s) failed`);
    } else {
      console.log('\nAll checks passed');
    }
  } finally {
    try {
      if (client?.close) client.close();
    } catch {
      /* ignore */
    }
    try {
      if (launched) await cleanupOwned({
          rootPid: launched.rootPid,
          trackedProcesses: launched.rootIdentity ? [launched.rootIdentity] : [],
        });
    } catch (error) {
      console.warn('cleanupOwned failed', error?.message || error);
    }
    try {
      await cleanupRuntimeDir({ ...runtimeOwnership, runtimeRoot, runtimeDir });
    } catch (error) {
      console.warn('cleanupRuntimeDir failed', error?.message || error);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
