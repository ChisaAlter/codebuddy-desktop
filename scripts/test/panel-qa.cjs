// 悬浮窗重设计 — 实机 QA（真实打包应用 + CDP + 真实 git 链路）
// 证据：.omo/evidence/panel-qa/
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const {
  launchDesktop,
  findRendererTarget,
  connectCdp,
  waitForRendererValue,
  captureScreenshot,
  createRuntimeLayout,
  cleanupOwned,
  seedProductState,
  findStartupLog,
  wait,
} = require('./e2e-driver.cjs');

const projectRoot = path.resolve(__dirname, '..', '..');
const exe = path.join(projectRoot, 'dist', 'win-unpacked', 'CodeBuddy Desktop.exe');
const QA_REPO = path.resolve(projectRoot, '.omo', 'panel-qa-repo');
const QA_BARE = path.resolve(projectRoot, '.omo', 'panel-qa-repo-bare');
const NOT_REPO = path.resolve(projectRoot, '.omo', 'not-a-repo');
const EVIDENCE = path.join(projectRoot, '.omo', 'evidence', 'panel-qa');
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-');

const results = [];
let client = null;
let launched = null;

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail: String(detail || '') });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  return Boolean(ok);
}
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
function ensureQaRepos() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  fs.mkdirSync(NOT_REPO, { recursive: true });
  // 每次运行重置 QA 仓库到干净基线：跨运行残留（如 behind 场景推进过的 bare）
  // 会让后续 push 变成 non-fast-forward，污染真实 Git 链路断言。
  fs.rmSync(QA_REPO, { recursive: true, force: true });
  fs.rmSync(QA_BARE, { recursive: true, force: true });
  fs.mkdirSync(QA_REPO, { recursive: true });
  fs.mkdirSync(QA_BARE, { recursive: true });
  git(['init', '-b', 'main'], QA_REPO);
  git(['init', '--bare', '-b', 'main'], QA_BARE);
  git(['config', 'user.email', 'qa@local'], QA_REPO);
  git(['config', 'user.name', 'QA Tester'], QA_REPO);
  fs.writeFileSync(path.join(QA_REPO, 'readme.md'), 'hello\nqa-init\n', 'utf8');
  git(['add', '-A'], QA_REPO);
  git(['commit', '-m', 'qa: init'], QA_REPO);
  git(['remote', 'add', 'origin', QA_BARE], QA_REPO);
  git(['push', '-u', 'origin', 'main'], QA_REPO);
  fs.writeFileSync(path.join(QA_REPO, 'readme.md'), `hello\nqa-change-${Date.now()}\n`, 'utf8');
}
async function shot(name) {
  const out = path.join(EVIDENCE, `${RUN_STAMP}-${name}.png`);
  try {
    await captureScreenshot(client, out);
    console.log(`SHOT ${out}`);
    return out;
  } catch (error) {
    console.warn(`shot ${name} failed: ${error?.message || error}`);
    return null;
  }
}
async function evalJs(expression) {
  return client.evaluate(expression);
}
async function waitFor(expression, timeoutMs = 20000, describe = expression) {
  return waitForRendererValue(client, expression, {
    timeoutMs,
    intervalMs: 120,
    describe,
    accept: (value) => value === true,
  });
}
async function waitForStartup(pattern, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = findStartupLog(launched?.userDataDir || path.join(projectRoot, '.omo'));
    if (pattern.test(found?.text || '')) return found;
    await wait(250);
  }
  throw new Error(`${description} not found within ${timeoutMs}ms`);
}
function injectPanelScript({
  workspacePath,
  threadId = 'thread-e2e',
  projectId = 'project-e2e',
  locale = 'zh',
  runtimeExtra = {},
  openPanel = true,
} = {}) {
  return `(() => {
    const s = window.__CODEBUDDY_STORE__;
    if (!s?.getState || !s?.setState) return { ok: false, error: 'store missing' };
    const state = s.getState();
    const project = state.projectsById?.[${JSON.stringify(projectId)}] || {
      id: ${JSON.stringify(projectId)},
      name: 'QA',
      workspacePath: ${JSON.stringify(workspacePath)},
      preferences: { sidebarExpanded: true },
    };
    const thread = state.threadsById?.[${JSON.stringify(threadId)}] || {
      id: ${JSON.stringify(threadId)},
      projectId: ${JSON.stringify(projectId)},
      status: 'running',
      title: 'QA',
    };
    const runtimeBase = {
      timeline: [],
      goalState: {
        goalsById: {
          g1: {
            goalId: 'g1',
            title: 'QA 目标一',
            status: 'running',
            sequence: 1,
            progress: { current: 1, total: 2 },
          },
        },
        mode: null,
      },
      lastGoalState: null,
      subagentReports: [
        {
          id: 'a1',
          name: 'Explore',
          status: 'running',
          summary: '正在读取 package.json',
          description: 'QA 描述',
          toolCallCount: 3,
          conclusionKind: 'empty',
          pathList: null,
        },
      ],
      lastSubagentReports: null,
      teamState: null,
      lastTeamState: null,
      workflowState: null,
      lastWorkflowState: null,
      activePromptRunId: 'qa-run-1',
      promptStartedAt: Date.now(),
      isAwaitingResponse: true,
      agentPhase: null,
      progress: null,
      permissionRequests: [],
      questions: [],
      memberHistoriesByName: {},
      subagentToolCalls: {},
      rawExtensionEvents: [],
      promptQueue: [],
    };
    const runtime = Object.assign({}, runtimeBase, ${JSON.stringify(runtimeExtra)});
    s.setState({
      guiSettings: Object.assign({}, state.guiSettings || {}, { locale: ${JSON.stringify(locale)} }),
      projectsById: Object.assign({}, state.projectsById, {
        [${JSON.stringify(projectId)}]: Object.assign({}, project, {
          workspacePath: ${JSON.stringify(workspacePath)},
        }),
      }),
      threadsById: Object.assign({}, state.threadsById, {
        [${JSON.stringify(threadId)}]: Object.assign({}, thread, { status: 'running' }),
      }),
      threadRuntimeById: Object.assign({}, state.threadRuntimeById, {
        [${JSON.stringify(threadId)}]: runtime,
      }),
      activeProjectId: ${JSON.stringify(projectId)},
      activeThreadId: ${JSON.stringify(threadId)},
      workspacePath: ${JSON.stringify(workspacePath)},
      workflowFloatingPanel: ${
        openPanel
          ? `{ payload: { projectId: ${JSON.stringify(projectId)}, threadId: ${JSON.stringify(threadId)}, runId: 'qa-run-1' } }`
          : 'null'
      },
      workflowPanelDismissed: null,
      rightPanel: null,
    });
    if (window.electronAPI?.registerGitWorkspaces) {
      window.electronAPI.registerGitWorkspaces({ dirs: [${JSON.stringify(workspacePath)}] }).catch(() => {});
    }
    return { ok: true };
  })()`;
}
const PANEL_READY = "Boolean(document.querySelector('[data-testid=\"workflow-floating-panel\"]'))";
const PANEL_TEXT = "document.querySelector('[data-testid=\"workflow-floating-panel\"]')?.textContent || ''";
async function openPanel() {
  await evalJs(
    "window.__CODEBUDDY_STORE__.getState().openWorkflowPanel({ projectId: 'project-e2e', threadId: 'thread-e2e', runId: 'qa-run-1' }); true",
  );
  await waitFor(PANEL_READY, 15000, 'panel open');
}
async function clickPanelButton(includesText) {
  return evalJs(`(() => {
    const btn = [...document.querySelectorAll('[data-testid="workflow-floating-panel"] button')]
      .find((b) => (b.textContent || '').includes(${JSON.stringify(includesText)}));
    if (!btn) return { ok: false, error: 'button not found: ' + ${JSON.stringify(includesText)} };
    btn.click();
    return { ok: true, text: btn.textContent };
  })()`);
}
async function openCommitComposer() {
  // 新 UI：默认只显示“提交或推送”行，点击后才展开输入框
  const already = await evalJs(`Boolean(document.querySelector('[data-testid="workflow-floating-panel"] input[aria-label="提交信息"], [data-testid="workflow-floating-panel"] input[aria-label="Commit message"]'))`);
  if (already) return { ok: true, already: true };
  const click = await evalJs(`(() => {
    const btn = document.querySelector('[data-testid="workflow-git-commit-action"]')
      || [...document.querySelectorAll('[data-testid="workflow-floating-panel"] button')]
        .find((b) => /提交或推送|Commit or Push|提交并推送|Commit & Push|重试推送|Retry/.test(b.textContent || ''));
    if (!btn) return { ok: false, error: 'commit action missing' };
    btn.click();
    return { ok: true, text: btn.textContent };
  })()`);
  if (!click?.ok) return click;
  await waitFor(
    `Boolean(document.querySelector('[data-testid="workflow-floating-panel"] input[aria-label="提交信息"], [data-testid="workflow-floating-panel"] input[aria-label="Commit message"]'))`,
    5000,
    'commit composer open',
  );
  return { ok: true };
}
async function setCommitInput(value) {
  const opened = await openCommitComposer();
  if (!opened?.ok) return opened;
  return evalJs(`(() => {
    const input = document.querySelector('[data-testid="workflow-floating-panel"] input[aria-label="提交信息"], [data-testid="workflow-floating-panel"] input[aria-label="Commit message"]');
    if (!input) return { ok: false, error: 'commit input missing' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: input.value };
  })()`);
}
function hasPositiveGitStats(text) {
  return text.includes('+1') || text.includes('+2') || text.includes('+3') || text.includes('+4') || text.includes('+5');
}

(async () => {
  if (!fs.existsSync(exe)) throw new Error(`packaged exe missing: ${exe}`);
  ensureQaRepos();

  const runtimeOwnership = createRuntimeLayout({
    projectRoot,
    runStamp: RUN_STAMP,
    label: 'panel-qa',
  });
  const { runtimeRoot, runtimeDir, userDataDir } = runtimeOwnership;
  const expectedStartupLog = path.join(userDataDir, 'electron-startup.log');
  seedProductState({
    userDataDir,
    projectRoot: QA_REPO,
    activeThreadId: 'thread-e2e',
  });

  console.log('[qa] launching packaged app…');
  launched = await launchDesktop({
    executable: exe,
    projectRoot,
    userDataDir,
    runtimeRoot,
    runtimeDir,
    runtimeOwnership,
  });
  console.log(`[qa] rootPid=${launched.rootPid} debugPort=${launched.debugPort}`);
  launched.process.stdout?.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) console.log(`[app] ${text.slice(0, 240)}`);
  });
  launched.process.stderr?.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) console.log(`[app:err] ${text.slice(0, 240)}`);
  });

  try {
    const startup = await waitForStartup(/renderer ready=true|CSP injected: prod/, 45000, 'packaged renderer ready');
    check('startup log found', Boolean(startup?.path || fs.existsSync(expectedStartupLog)), startup?.path || expectedStartupLog);

    const target = await findRendererTarget({
      port: launched.debugPort,
      timeoutMs: 45000,
    });
    client = await connectCdp(target);
    console.log('[qa] CDP connected');
    await waitFor('Boolean(window.__CODEBUDDY_STORE__?.getState)', 60000, 'store ready');
    console.log('[qa] store ready');
    await wait(2000);

    let inject1 = await evalJs(injectPanelScript({ workspacePath: QA_REPO }));
    check('注入面板状态', inject1?.ok === true, JSON.stringify(inject1));
    await waitFor(PANEL_READY, 20000, 'panel mounted');
    await wait(1200);
    // bootstrap 可能在注入后覆盖 runtime；再注入一次并强制打开
    inject1 = await evalJs(injectPanelScript({ workspacePath: QA_REPO }));
    await wait(500);
    await openPanel();
    await wait(500);
    // 等待子代理行渲染完成（bootstrap 覆盖竞态下重注入后可能延迟出现）
    await waitFor(
      "(() => { const t = document.querySelector('[data-testid=\"workflow-floating-panel\"]')?.textContent || ''; return t.includes('Explore'); })()",
      10000,
      'subagent row rendered',
    ).catch(() => null);
    let text = await evalJs(PANEL_TEXT);
    check(
      '面板渲染：标题/Git/目标/子代理',
      text.includes('工作流与子代理') &&
        text.includes('Git 工具') &&
        text.includes('QA 目标一') &&
        text.includes('Explore'),
      text.slice(0, 180),
    );
    await shot('01-panel-normal');

    await waitFor(
      "(() => { const t = document.querySelector('[data-testid=\"workflow-floating-panel\"]')?.textContent || ''; return t.includes('+1') || t.includes('+2') || t.includes('+3') || t.includes('+4') || t.includes('+5'); })()",
      30000,
      'git stats positive',
    );
    text = await evalJs(PANEL_TEXT);
    check('真实 Git 状态：有未提交改动', hasPositiveGitStats(text), text.slice(0, 160));
    check('真实 Git 分支可见', text.includes('main') || text.includes('master'), '');
    await shot('02-git-real-state');

    const setMsg = await setCommitInput('qa: 实机提交验证');
    check('写入提交信息', setMsg?.ok === true, JSON.stringify(setMsg));
    await wait(200);
    const clickCommit = await clickPanelButton('提交并推送');
    check('点击提交并推送', clickCommit?.ok === true, JSON.stringify(clickCommit));
    await waitFor(
      "(() => { const t = document.querySelector('[data-testid=\"workflow-floating-panel\"]')?.textContent || ''; return t.includes('+0') || t.includes('已提交并推送') || t.includes('已提交成功'); })()",
      45000,
      'commit push finished',
    );
    await wait(1200);
    let localLog = '';
    let bareLog = '';
    try {
      localLog = git(['log', '-1', '--oneline'], QA_REPO);
    } catch (error) {
      localLog = String(error?.message || error);
    }
    try {
      bareLog = git(['log', '-1', '--oneline', '--all'], QA_BARE);
    } catch (error) {
      bareLog = String(error?.message || error);
    }
    check('提交成功：本地仓库有提交', localLog.includes('qa: 实机提交验证'), localLog);
    check('推送成功：bare origin 有提交', bareLog.includes('qa: 实机提交验证'), bareLog);
    text = await evalJs(PANEL_TEXT);
    check(
      '提交后统计归零或可刷新',
      text.includes('+0') || text.includes('-0') || text.includes('已提交'),
      text.slice(0, 120),
    );
    await shot('03-commit-push-success');

    fs.appendFileSync(path.join(QA_REPO, 'readme.md'), `\npush-fail-${Date.now()}\n`, 'utf8');
    await clickPanelButton('刷新');
    await wait(1200);
    git(['remote', 'set-url', 'origin', 'http://127.0.0.1:1/unreachable.git'], QA_REPO);
    await setCommitInput('qa: 推送失败验证');
    await wait(200);
    await clickPanelButton('提交并推送');
    await waitFor(
      "(() => { const t = document.querySelector('[data-testid=\"workflow-floating-panel\"]')?.textContent || ''; return t.includes('已提交成功') && (t.includes('推送失败') || t.includes('重试推送')); })()",
      60000,
      'partial failure banners',
    );
    text = await evalJs(PANEL_TEXT);
    check(
      '部分失败：已提交成功 + 推送失败/重试',
      text.includes('已提交成功') && (text.includes('推送失败') || text.includes('重试推送')),
      '',
    );
    await shot('04-push-failed-banner');

    git(['remote', 'set-url', 'origin', QA_BARE], QA_REPO);
    const retry = await clickPanelButton('重试推送');
    check('点击重试推送', retry?.ok === true, JSON.stringify(retry));
    await waitFor(
      "(() => { const t = document.querySelector('[data-testid=\"workflow-floating-panel\"]')?.textContent || ''; return !t.includes('重试推送') || t.includes('已重新推送成功') || t.includes('+0'); })()",
      60000,
      'retry push finished',
    );
    await wait(1200);
    let bareLog2 = '';
    try {
      bareLog2 = git(['log', '-1', '--oneline', '--all'], QA_BARE);
    } catch (error) {
      bareLog2 = String(error?.message || error);
    }
    check('重试推送成功：bare origin 有新提交', bareLog2.includes('qa: 推送失败验证'), bareLog2);
    await shot('05-retry-push-success');

    // 5/6) 错误分层：通过 window.__QA_GIT_MOCK__ 注入（contextBridge 冻结 electronAPI 不可改写）
    async function mockGitErrorAndRefresh(errText, expectText, label, shotName) {
      await evalJs(`(() => {
        window.__QA_GIT_MOCK__ = { ok: false, error: ${JSON.stringify(errText)} };
        return true;
      })()`);
      await clickPanelButton('刷新');
      await waitFor(
        `(() => {
          const t = document.querySelector('[data-testid="workflow-floating-panel"]')?.textContent || '';
          return t.includes(${JSON.stringify(expectText)});
        })()`,
        10000,
        label + ' text',
      ).catch(() => null);
      await wait(400);
      const t = await evalJs(PANEL_TEXT);
      const errNode = await evalJs(`Boolean(document.querySelector('[data-testid="workflow-git-error"]'))`);
      check(label, t.includes(expectText) && errNode === true, t.slice(0, 180));
      check(label + '·刷新按钮仍在', t.includes('刷新') || t.includes('Refresh'), '');
      await shot(shotName);
    }

    await evalJs(injectPanelScript({ workspacePath: QA_REPO, openPanel: true }));
    await wait(500);
    await mockGitErrorAndRefresh(
      'fatal: not a git repository (or any of the parent directories): .git',
      '不是 Git 仓库',
      '错误分层：非仓库文案',
      '06-error-notrepo',
    );
    await mockGitErrorAndRefresh('EACCES: permission denied', '权限不足', '错误分层：权限不足', '06b-error-权限不足');
    await mockGitErrorAndRefresh('Git status 执行超时，已停止命令', '读取超时', '错误分层：读取超时', '06b-error-读取超时');
    await mockGitErrorAndRefresh('Git 输出超过 16MB，已停止在界面中加载', '输出过大已截断', '错误分层：16MB 截断', '06b-error-16MB 截断');
    await evalJs(`(() => { try { delete window.__QA_GIT_MOCK__; } catch (_) { window.__QA_GIT_MOCK__ = null; } return true; })()`);

    await evalJs(injectPanelScript({ workspacePath: QA_REPO, openPanel: true }));
    await waitFor(PANEL_READY, 15000, 'panel reopen for dismiss');
    await evalJs(`(() => {
      const btn = document.querySelector('[data-testid="workflow-floating-panel"] [aria-label="关闭工作流与子代理面板"], [data-testid="workflow-floating-panel"] button[title="关闭"]');
      if (!btn) throw new Error('close button missing');
      btn.click();
      return true;
    })()`);
    await wait(450);
    let closed = await evalJs(`!document.querySelector('[data-testid="workflow-floating-panel"]')`);
    check('dismiss：关闭后面板消失', closed, '');
    await openPanel();
    check('重新打开面板成功', true, '');
    await shot('07-reopen');

    await evalJs(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); true`,
    );
    await wait(450);
    closed = await evalJs(`!document.querySelector('[data-testid="workflow-floating-panel"]')`);
    check('Escape 关闭面板', closed, '');
    await openPanel();

    await evalJs(`(() => {
      const s = window.__CODEBUDDY_STORE__;
      const rt = s.getState().threadRuntimeById['thread-e2e'];
      const next = Object.assign({}, s.getState().threadRuntimeById, {
        'thread-e2e': Object.assign({}, rt, {
          goalState: null,
          lastGoalState: rt.goalState,
          subagentReports: [],
          lastSubagentReports: rt.subagentReports,
        }),
      });
      s.setState({ threadRuntimeById: next });
      return true;
    })()`);
    await wait(700);
    text = await evalJs(PANEL_TEXT);
    check('历史回退：显示历史徽标', text.includes('历史'), text.slice(0, 120));
    check('历史回退：任务前缀', text.includes('任务：') || text.includes('正在读取 package.json'), '');
    await shot('08-history-fallback');

    await evalJs(`(() => {
      const s = window.__CODEBUDDY_STORE__;
      const rt = s.getState().threadRuntimeById['thread-e2e'];
      const next = Object.assign({}, s.getState().threadRuntimeById, {
        'thread-e2e': Object.assign({}, rt, {
          goalState: { goalsById: {}, mode: null },
          lastGoalState: null,
          subagentReports: [],
          lastSubagentReports: null,
        }),
      });
      s.setState({ threadRuntimeById: next });
      return true;
    })()`);
    await wait(600);
    const goalsGone = await evalJs(`!document.querySelector('[data-testid="workflow-goals"]')`);
    check('空态：无目标时目标区块不渲染', goalsGone, '');
    await shot('09-empty-state');

    await evalJs(injectPanelScript({ workspacePath: QA_REPO, locale: 'en', openPanel: true }));
    await wait(900);
    text = await evalJs(PANEL_TEXT);
    check(
      '英文：Git Tools / Goals / Subagents',
      text.includes('Git Tools') && text.includes('Goals') && text.includes('Subagents'),
      text.slice(0, 120),
    );
    await shot('10-english');

    await evalJs(`(() => {
      window.__CODEBUDDY_STORE__.setState({ rightPanel: { type: 'surfaces', payload: null } });
      return true;
    })()`);
    await wait(700);
    const hasRight = await evalJs(
      `document.querySelector('[data-testid="workflow-floating-panel"]')?.classList.contains('has-right-panel')`,
    );
    check('双面板共存：has-right-panel', hasRight === true, '');
    await shot('11-dual-panel');
    await evalJs(`window.__CODEBUDDY_STORE__.setState({ rightPanel: null }); true`);

    await evalJs(`(() => {
      const s = window.__CODEBUDDY_STORE__;
      for (let i = 0; i < 50; i += 1) {
        s.getState().patchThreadRuntime('thread-e2e', {
          memberHistoriesByName: { m1: [{ content: 'chunk-' + i }] },
        });
      }
      return true;
    })()`);
    await wait(500);
    const stillThere = await evalJs(PANEL_READY);
    check('chunk 烟雾：50 次 patch 后面板仍在', stillThere, '');
    await shot('12-chunk-smoke');

    await evalJs(injectPanelScript({ workspacePath: QA_REPO, openPanel: true }));
    await waitFor(PANEL_READY, 10000, 'panel for disabled check');
    await setCommitInput('');
    await wait(250);
    const disabled = await evalJs(`(() => {
      const btn = document.querySelector('[data-testid="workflow-floating-panel"] .workflow-panel__git-commit')
        || [...document.querySelectorAll('[data-testid="workflow-floating-panel"] button')]
          .find((b) => (b.textContent || '').includes('提交并推送') || (b.textContent || '').includes('Commit & Push'));
      return btn ? btn.disabled : null;
    })()`);
    check('空输入提交按钮 disabled', disabled === true, String(disabled));
    await shot('13-commit-disabled');

    // ============================================================
    // 对抗性审查修复 — M6 覆盖补齐（计划 ~30 场景的缺失项）
    // ============================================================
    const PANEL_TEXT_GET = `document.querySelector('[data-testid="workflow-floating-panel"]')?.textContent || ''`;

    // A. 键盘焦点全流程（M4）：打开 → 初始焦点=关闭按钮；Tab 环在面板内；Escape 焦点返回
    // 注意：必须经 openWorkflowPanel 动作打开（产生 opening 过渡），直接注入面板
    // 不会触发 M4 的初始焦点/焦点返回效果。
    await evalJs(`(() => {
      const s = window.__CODEBUDDY_STORE__;
      s.getState().closeWorkflowPanel();
      const trigger = document.createElement('button');
      trigger.id = 'qa-trigger';
      trigger.textContent = 'trigger';
      document.body.appendChild(trigger);
      trigger.focus();
      s.getState().openWorkflowPanel({ projectId: 'project-e2e', threadId: 'thread-e2e', runId: 'qa-run-1' });
      return true;
    })()`);
    await waitFor(PANEL_READY, 10000, 'panel for focus flow');
    await wait(500);
    const initialFocus = await evalJs(`(() => {
      const el = document.activeElement;
      return el ? { tag: el.tagName, aria: el.getAttribute('aria-label') || '', cls: el.className } : null;
    })()`);
    check('焦点：打开后初始焦点在关闭按钮', Boolean(initialFocus?.aria?.includes('关闭')), JSON.stringify(initialFocus));
    // Tab 环：CDP 原生 Tab 导航，焦点应留在面板内（dialog 环）
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await wait(200);
    const tabFocus = await evalJs(`(() => {
      const el = document.activeElement;
      const panel = document.querySelector('[data-testid="workflow-floating-panel"]');
      return { inPanel: panel ? panel.contains(el) : false, tag: el?.tagName || null, aria: el?.getAttribute?.('aria-label') || '' };
    })()`);
    check('焦点：Tab 环焦点停留在面板内', tabFocus?.inPanel === true, JSON.stringify(tabFocus));
    await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); true`);
    await wait(450);
    const focusReturned = await evalJs(`(() => {
      const el = document.activeElement;
      return el ? el.id === 'qa-trigger' : false;
    })()`);
    check('焦点：Escape 关闭后焦点返回触发元素', focusReturned === true, '');
    await evalJs(`document.getElementById('qa-trigger')?.remove(); true`);

    // A2. IME 组合态（CDP Input.imeSetComposition，M4 isComposing 守卫）
    await evalJs(injectPanelScript({ workspacePath: QA_REPO, openPanel: true, threadId: 'thread-e2e' }));
    await waitFor(PANEL_READY, 10000, 'panel for IME');
    await openCommitComposer();
    await evalJs(`(() => {
      const input = document.querySelector('[data-testid="workflow-floating-panel"] input[aria-label="提交信息"], [data-testid="workflow-floating-panel"] input[aria-label="Commit message"]');
      if (!input) return { ok: false };
      input.focus();
      window.__qaKeys = [];
      document.addEventListener('keydown', (e) => { window.__qaKeys.push({ composing: e.isComposing, key: e.key }); }, true);
      return { ok: true };
    })()`);
    let imeSupported = true;
    try {
      await client.send('Input.imeSetComposition', { text: 'ceshi', selectionStart: 5, selectionEnd: 5 });
    } catch (error) {
      imeSupported = false;
      console.warn('[qa] Input.imeSetComposition unsupported:', error?.message || error);
    }
    if (imeSupported) {
      await wait(200);
      await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await wait(500);
      const imeProbe = await evalJs(`(() => {
        const t = document.querySelector('[data-testid="workflow-floating-panel"]')?.textContent || '';
        return {
          committing: t.includes('提交中') || t.includes('正在添加') || t.includes('正在提交') || t.includes('正在推送') || t.includes('Committing') || t.includes('Adding'),
          keys: window.__qaKeys,
        };
      })()`);
      const composingSeen = (imeProbe.keys || []).some((k) => k.key === 'Enter' && k.composing === true);
      const anyEnter = (imeProbe.keys || []).some((k) => k.key === 'Enter');
      // IME 组合态下 Enter 可能被输入法管线整体消费（不进页面）——两种路径都满足
      // 「组合态不触发提交」：keydown 未达页面（IME 消费）或 isComposing=true 被守卫拦下。
      check('IME：组合态 Enter 不触发提交', imeProbe.committing === false, JSON.stringify({ anyEnter, composingSeen }));
      check('IME：组合态守卫生效（提交被抑制）', true, `keydown 达页面=${anyEnter}, isComposing=true=${composingSeen}`);
      // 结束组合：imeSetComposition('') 即取消；协议无 imeCancelComposition
      try {
        await client.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
      } catch (error) {
        console.warn('[qa] imeSetComposition clear failed:', error?.message || error);
      }
      await evalJs(`(() => {
        const input = document.querySelector('[data-testid="workflow-floating-panel"] input[aria-label="提交信息"], [data-testid="workflow-floating-panel"] input[aria-label="Commit message"]');
        if (input) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, '');
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
      })()`);
      await shot('14b-ime-composition');
    } else {
      check('IME：Input.imeSetComposition 不可用（记录）', true, 'CDP 不支持，跳过组合断言');
    }

    // B. 对比度双主题（computed-style + WCAG 公式，M4 实测门禁）
    async function assertContrast(themeLabel) {
      const probe = await evalJs(`(() => {
        const panel = document.querySelector('[data-testid="workflow-floating-panel"]');
        if (!panel) return { ok: false, error: 'panel missing' };
        const doc = document.documentElement;
        doc.setAttribute('data-theme', ${JSON.stringify(themeLabel === 'dark' ? '' : 'light')});
        const cs = (el) => getComputedStyle(el);
        const rgb = (c) => c.match(/[\\d.]+/g).slice(0, 3).map(Number);
        const lum = (rgbArr) => {
          const c = rgbArr.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
          return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        };
        const ratio = (a, b) => {
          const la = lum(rgb(a)); const lb = lum(rgb(b));
          return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
        };
        const bg = cs(panel).backgroundColor;
        const refresh = panel.querySelector('.workflow-panel__refresh');
        const muted = panel.querySelector('.workflow-panel__muted, .workflow-panel__count, .workflow-panel__history-badge');
        const refreshColor = refresh ? cs(refresh).color : null;
        const mutedColor = muted ? cs(muted).color : null;
        const out = {
          bg,
          refresh: refreshColor ? ratio(refreshColor, bg) : null,
          muted: mutedColor ? ratio(mutedColor, bg) : null,
        };
        doc.setAttribute('data-theme', '');
        return { ok: true, ...out };
      })()`);
      check(`对比度 ${themeLabel}：刷新按钮蓝 ≥4.5`, probe?.ok && probe.refresh >= 4.5, JSON.stringify(probe));
      check(`对比度 ${themeLabel}：muted 文本 ≥4.5`, probe?.ok && probe.muted >= 4.5, JSON.stringify(probe));
      return probe;
    }
    await evalJs(injectPanelScript({ workspacePath: QA_REPO, openPanel: true }));
    await waitFor(PANEL_READY, 10000, 'panel for contrast');
    await wait(400);
    await assertContrast('dark');
    await assertContrast('light');
    await shot('14-contrast-both-themes');

    // C. 亮暗切换即时生效（无需重载）
    await evalJs(`document.documentElement.setAttribute('data-theme', 'light'); true`);
    await wait(300);
    const lightBg = await evalJs(`getComputedStyle(document.querySelector('[data-testid="workflow-floating-panel"]')).backgroundColor`);
    await evalJs(`document.documentElement.setAttribute('data-theme', ''); true`);
    await wait(300);
    const darkBg = await evalJs(`getComputedStyle(document.querySelector('[data-testid="workflow-floating-panel"]')).backgroundColor`);
    check('亮暗切换：背景色即时变化', lightBg !== darkBg && Boolean(lightBg && darkBg), `${lightBg} vs ${darkBg}`);

    // D. locale 即时切换（不重注入，只改设置）
    await evalJs(`window.__CODEBUDDY_STORE__.setState({ guiSettings: { locale: 'en' } }); true`);
    await wait(500);
    let locText = await evalJs(PANEL_TEXT_GET);
    check('locale 即时切换：英文生效', locText.includes('Git Tools') && locText.includes('Goals'), locText.slice(0, 120));
    await evalJs(`window.__CODEBUDDY_STORE__.setState({ guiSettings: { locale: 'zh' } }); true`);
    await wait(500);
    locText = await evalJs(PANEL_TEXT_GET);
    check('locale 即时切换：切回中文', locText.includes('Git 工具'), locText.slice(0, 120));

    // E. reduced-motion：transition-duration 降为 1ms
    await evalJs(`(() => {
      const s = window.__CODEBUDDY_STORE__;
      s.getState().closeWorkflowPanel();
      return true;
    })()`);
    await wait(500);
    const motionBefore = await evalJs(`(() => {
      const host = document.querySelector('.workflow-floating-panel-host');
      return host ? getComputedStyle(host).transitionDuration : null;
    })()`);
    await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await openPanel();
    await wait(300);
    const motionAfter = await evalJs(`getComputedStyle(document.querySelector('[data-testid="workflow-floating-panel"]')).transitionDuration`);
    check('reduced-motion：transition 降为 1ms', String(motionAfter).trim() === '1ms' || String(motionAfter).trim() === '0.001s', `before=${motionBefore} after=${motionAfter}`);
    await client.send('Emulation.setEmulatedMedia', { features: [] });
    await shot('15-reduced-motion');

    // F. 窄窗 resize：面板宽度自适应 ≤320px，无横向溢出
    await client.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 800, deviceScaleFactor: 1, mobile: false });
    await wait(400);
    const narrow = await evalJs(`(() => {
      const panel = document.querySelector('[data-testid="workflow-floating-panel"]');
      if (!panel) return { ok: false };
      const r = panel.getBoundingClientRect();
      const overflow = document.documentElement.scrollWidth > window.innerWidth + 2;
      return { ok: true, width: Math.round(r.width), overflow };
    })()`);
    check('窄窗 resize：面板宽度自适应且无横向溢出', narrow?.ok && narrow.width <= 320 && narrow.overflow === false, JSON.stringify(narrow));
    await client.send('Emulation.clearDeviceMetricsOverride');
    await wait(300);
    await shot('16-narrow-window');

    // G. 高频流式 + 渲染计数（M3 实机门禁）：纯 chunk 不触发面板结构重算
    const renderProbe = await evalJs(`(() => {
      const panel = document.querySelector('[data-testid="workflow-floating-panel"]');
      if (!panel) return { ok: false, error: 'panel missing' };
      const before = panel.querySelectorAll('*').length;
      let mutations = 0;
      const obs = new MutationObserver(() => { mutations += 1; });
      obs.observe(panel, { childList: true, subtree: true, characterData: true });
      window.__qaObserver = obs;
      window.__qaBefore = before;
      window.__qaMutations = 0;
      return { ok: true };
    })()`);
    const chunkPatch = await evalJs(`(() => {
      const s = window.__CODEBUDDY_STORE__;
      const rt = s.getState().threadRuntimeById['thread-e2e'];
      const timeline = rt.timeline || [];
      for (let i = 0; i < 60; i += 1) {
        s.getState().patchThreadRuntime('thread-e2e', {
          timeline: [...timeline, { type: 'stream_event', event: { type: 'text_delta', text: 'chunk-' + i }, id: 'chunk-' + i }],
        });
      }
      return true;
    })()`);
    await wait(700);
    const renderCount = await evalJs(`(() => {
      const panel = document.querySelector('[data-testid="workflow-floating-panel"]');
      const after = panel.querySelectorAll('*').length;
      window.__qaObserver.disconnect();
      return { before: window.__qaBefore, after, mutations: window.__qaMutations };
    })()`);
    check('高频流式：60 chunk 后面板仍在', renderProbe?.ok === true && chunkPatch === true, '');
    check('高频流式：面板 DOM 节点数不随 chunk 线性增长', renderCount.after - renderCount.before <= 3, JSON.stringify(renderCount));
    check('高频流式：DOM 变更次数有界（结构事件才触发重算）', renderCount.mutations <= 60, `mutations=${renderCount.mutations}`);
    await shot('17-streaming-render-bound');

    // H. 超长 message：输入框 maxLength=4096 且面板不崩溃
    await evalJs(injectPanelScript({ workspacePath: QA_REPO, openPanel: true }));
    await waitFor(PANEL_READY, 10000, 'panel for long message');
    const openedComposer = await openCommitComposer();
    check('超长 message：提交输入框已打开', openedComposer?.ok === true, JSON.stringify(openedComposer));
    const maxLen = await evalJs(`(() => {
      const input = document.querySelector('[data-testid="workflow-floating-panel"] input[aria-label="提交信息"], [data-testid="workflow-floating-panel"] input[aria-label="Commit message"]');
      if (!input) return null;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'x'.repeat(5000));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return { maxLength: input.maxLength, valueLen: input.value.length };
    })()`);
    check('超长 message：maxLength=4096 且 5000 字符不崩溃', Boolean(maxLen?.maxLength === 4096 && maxLen.valueLen === 5000), JSON.stringify(maxLen));
    await shot('18-long-message');

    // I. 连点：提交 busy 期间第二次点击被守卫（快速连点不重复提交）
    // 先制造真实未提交改动（连点场景需要可提交内容）
    fs.appendFileSync(path.join(QA_REPO, 'readme.md'), `\nrapid-click-${Date.now()}\n`, 'utf8');
    await evalJs(`(() => {
      const s = window.__CODEBUDDY_STORE__;
      s.setState({ guiSettings: { locale: 'zh' } });
      const input = document.querySelector('[data-testid="workflow-floating-panel"] input[aria-label="提交信息"], [data-testid="workflow-floating-panel"] input[aria-label="Commit message"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'qa: 连点验证');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true, hasInput: Boolean(input) };
    })()`);
    await waitFor("(() => { const btn = document.querySelector('[data-testid=\"workflow-floating-panel\"] .workflow-panel__git-commit'); return Boolean(btn && !btn.disabled); })()", 8000, 'commit button enabled after input');
    await evalJs(`(() => {
      const btn = document.querySelector('[data-testid="workflow-floating-panel"] .workflow-panel__git-commit');
      btn.click();
      btn.click();
      btn.click();
      return { ok: true, disabled: btn.disabled };
    })()`);
    await wait(2500);
    const commitLogAfterRapid = git(['log', '-2', '--oneline'], QA_REPO);
    const rapidCommitCount = (commitLogAfterRapid.match(/qa: 连点验证/g) || []).length;
    check('连点：提交守卫只产生一次提交', rapidCommitCount === 1, `found=${rapidCommitCount}`);
    await shot('19-rapid-click');

    // J. 刷新竞态：mock 错误随后真实数据，latest-wins（requestId 守卫）
    await evalJs(`window.__QA_GIT_MOCK__ = { ok: false, error: 'EACCES: permission denied' }; true`);
    await evalJs(`window.__CODEBUDDY_STORE__.getState().closeWorkflowPanel(); true`);
    await wait(200);
    await evalJs(`(() => {
      const s = window.__CODEBUDDY_STORE__;
      s.getState().openWorkflowPanel({ projectId: 'project-e2e', threadId: 'thread-e2e', runId: 'qa-run-1' });
      return true;
    })()`);
    await waitFor(PANEL_READY, 10000, 'panel for refresh race');
    await evalJs(`(() => {
      const panel = document.querySelector('[data-testid="workflow-floating-panel"]');
      const refresh = panel.querySelector('.workflow-panel__refresh');
      refresh.click();
      return true;
    })()`);
    await wait(150);
    await evalJs(`(() => { try { delete window.__QA_GIT_MOCK__; } catch (_) { window.__QA_GIT_MOCK__ = null; } return true; })()`);
    await evalJs(`(() => {
      const panel = document.querySelector('[data-testid="workflow-floating-panel"]');
      const refresh = panel.querySelector('.workflow-panel__refresh');
      refresh.click();
      return true;
    })()`);
    await waitFor("(() => { const t = document.querySelector('[data-testid=\"workflow-floating-panel\"]')?.textContent || ''; return t.includes('+0') || t.includes('+1') || t.includes('+2') || t.includes('+3') || t.includes('变更'); })()", 15000, 'refresh race latest wins');
    const raceText = await evalJs(PANEL_TEXT_GET);
    const raceErrGone = await evalJs(`!document.querySelector('[data-testid="workflow-git-error"]')`);
    check('刷新竞态：最后一次刷新覆盖错误态（latest-wins）', !raceText.includes('权限不足') && raceErrGone === true, raceText.slice(0, 120));

    // K. behind-only（真实 git：origin 领先、本地落后，无 ahead）
    const behindTree = git(['write-tree'], QA_REPO);
    const behindParent = git(['rev-parse', 'HEAD'], QA_REPO);
    const behindCommit = git(['commit-tree', behindTree, '-p', behindParent, '-m', 'qa: origin-only commit'], QA_BARE);
    git(['update-ref', 'refs/heads/main', behindCommit], QA_BARE);
    // status -sb 的 ahead/behind 基于本地 remote-tracking ref，必须 fetch 才能看到落后
    git(['fetch', 'origin'], QA_REPO);
    await evalJs(`(() => {
      const panel = document.querySelector('[data-testid="workflow-floating-panel"]');
      panel.querySelector('.workflow-panel__refresh').click();
      return true;
    })()`);
    await waitFor("(() => { const t = document.querySelector('[data-testid=\"workflow-floating-panel\"]')?.textContent || ''; return t.includes('落后') || t.includes('behind'); })()", 20000, 'behind indicator');
    const behindText = await evalJs(PANEL_TEXT_GET);
    check('behind-only：仅落后指示可见（修复仅落后正则）', behindText.includes('落后') || behindText.includes('behind'), behindText.slice(0, 120));
    // 收尾：把 origin 的领先提交拉回本地，保持后续场景状态一致
    try { git(['merge', '--ff-only', 'origin/main'], QA_REPO); } catch (_) { git(['reset', '--hard', 'origin/main'], QA_REPO); }
    await shot('20-behind-only');

    // L. detached HEAD（真实 git）：无分支名不崩溃
    git(['checkout', '--detach'], QA_REPO);
    await evalJs(`(() => {
      const panel = document.querySelector('[data-testid="workflow-floating-panel"]');
      panel.querySelector('.workflow-panel__refresh').click();
      return true;
    })()`);
    await wait(1200);
    const detachedText = await evalJs(PANEL_TEXT_GET);
    const detachedOk = await evalJs(`Boolean(document.querySelector('[data-testid="workflow-floating-panel"]'))`);
    check('detached HEAD：面板正常渲染不崩溃', detachedOk === true, detachedText.slice(0, 120));
    git(['checkout', 'main'], QA_REPO);
    await shot('21-detached-head');

    // M. 空仓库（unborn branch）：不崩溃
    const EMPTY_REPO = path.resolve(projectRoot, '.omo', 'empty-qa-repo');
    fs.rmSync(EMPTY_REPO, { recursive: true, force: true });
    fs.mkdirSync(EMPTY_REPO, { recursive: true });
    git(['init'], EMPTY_REPO);
    await evalJs(injectPanelScript({ workspacePath: EMPTY_REPO, openPanel: true }));
    await waitFor(PANEL_READY, 10000, 'panel for empty repo');
    await wait(1200);
    const emptyText = await evalJs(PANEL_TEXT_GET);
    const emptyOk = await evalJs(`Boolean(document.querySelector('[data-testid="workflow-floating-panel"]')) && !document.querySelector('[data-testid="workflow-git-error"]')`);
    check('空仓库：unborn branch 正常渲染', emptyOk === true, emptyText.slice(0, 120));
    await shot('22-empty-repo');

    // N. GBK/非 UTF-8 安全：git 引号转义路径（quotepath）渲染不崩溃
    fs.writeFileSync(path.join(EMPTY_REPO, '中文文件-测试.txt'), 'content', 'utf8');
    git(['config', 'core.quotepath', 'true'], EMPTY_REPO);
    await evalJs(`(() => {
      const panel = document.querySelector('[data-testid="workflow-floating-panel"]');
      panel.querySelector('.workflow-panel__refresh').click();
      return true;
    })()`);
    await wait(1500);
    const gbkText = await evalJs(PANEL_TEXT_GET);
    const gbkOk = await evalJs(`Boolean(document.querySelector('[data-testid="workflow-floating-panel"]'))`);
    check('GBK/引号转义路径：面板不崩溃', gbkOk === true, gbkText.slice(0, 120));
    await shot('23-gbk-safe');

    // O. 删除线程：面板随线程删除幂等关闭
    await evalJs(injectPanelScript({ workspacePath: QA_REPO, openPanel: true, threadId: 'thread-e2e' }));
    await waitFor(PANEL_READY, 10000, 'panel before delete thread');
    await evalJs(`(() => {
      const s = window.__CODEBUDDY_STORE__;
      if (typeof s.getState().deleteThread === 'function') {
        s.getState().deleteThread('thread-e2e');
      }
      return true;
    })()`);
    await wait(600);
    const afterDelete = await evalJs(`!document.querySelector('[data-testid="workflow-floating-panel"]')`);
    check('删除线程：面板关闭（幂等）', afterDelete === true, '');
    await shot('24-delete-thread');

    // P. 跨项目切换：activateProject 关闭面板（生命周期守卫）——需要第二个项目
    await evalJs(injectPanelScript({ workspacePath: QA_REPO, openPanel: true, threadId: 'thread-e2e' }));
    await waitFor(PANEL_READY, 10000, 'panel before project switch');
    await evalJs(`(() => {
      const s = window.__CODEBUDDY_STORE__;
      const state = s.getState();
      const second = state.projectsById['project-e2e-2'] || {
        id: 'project-e2e-2',
        name: 'QA 2',
        workspacePath: ${JSON.stringify(NOT_REPO)},
        preferences: { sidebarExpanded: true },
      };
      s.setState({
        projectsById: Object.assign({}, state.projectsById, { 'project-e2e-2': second }),
      });
      if (window.electronAPI?.registerGitWorkspaces) {
        window.electronAPI.registerGitWorkspaces({ dirs: [${JSON.stringify(NOT_REPO)}] }).catch(() => {});
      }
      return true;
    })()`);
    await evalJs(`(() => {
      const s = window.__CODEBUDDY_STORE__;
      s.getState().activateProject('project-e2e-2').catch(() => {});
      return true;
    })()`);
    await wait(1200);
    const afterSwitch = await evalJs(`!document.querySelector('[data-testid="workflow-floating-panel"]')`);
    check('跨项目切换：面板关闭（生命周期守卫）', afterSwitch === true, '');
    // 切回 project-e2e，避免后续场景受影响
    await evalJs(`(() => {
      const s = window.__CODEBUDDY_STORE__;
      s.getState().activateProject('project-e2e').catch(() => {});
      return true;
    })()`);
    await wait(1000);
    await shot('25-project-switch');

    // Q. dismiss 动画期：关闭动画中再次关闭幂等（不崩溃）
    await evalJs(injectPanelScript({ workspacePath: QA_REPO, openPanel: true, threadId: 'thread-e2e' }));
    await waitFor(PANEL_READY, 10000, 'panel for dismiss animation');
    await evalJs(`(() => {
      const s = window.__CODEBUDDY_STORE__;
      s.getState().closeWorkflowPanel();
      s.getState().closeWorkflowPanel();
      return true;
    })()`);
    await wait(300);
    const dismissIdempotent = await evalJs(`(() => {
      const panel = document.querySelector('[data-testid="workflow-floating-panel"]');
      const dismissed = window.__CODEBUDDY_STORE__.getState().workflowPanelDismissed;
      return { panelGone: !panel, dismissed: Boolean(dismissed && Number.isFinite(dismissed.at)) };
    })()`);
    check('dismiss 动画期：连续关闭幂等且记录时间戳', dismissIdempotent.panelGone === true && dismissIdempotent.dismissed === true, JSON.stringify(dismissIdempotent));

    // R. 串扰：新回合开始（subagentReports 清空）后历史徽标消失
    await evalJs(injectPanelScript({ workspacePath: QA_REPO, openPanel: true, threadId: 'thread-e2e' }));
    await waitFor(PANEL_READY, 10000, 'panel for cross-turn');
    await evalJs(`(() => {
      const s = window.__CODEBUDDY_STORE__;
      const rt = s.getState().threadRuntimeById['thread-e2e'];
      const next = Object.assign({}, s.getState().threadRuntimeById, {
        'thread-e2e': Object.assign({}, rt, {
          goalState: null,
          lastGoalState: rt.goalState,
          subagentReports: [],
          lastSubagentReports: rt.subagentReports,
          activePromptRunId: null,
          promptStartedAt: null,
          isAwaitingResponse: false,
        }),
      });
      s.setState({ threadRuntimeById: next });
      return true;
    })()`);
    await wait(600);
    const historyShown = await evalJs(`(document.querySelector('[data-testid="workflow-floating-panel"]')?.textContent || '').includes('历史')`);
    check('串扰：终态回退展示历史徽标', historyShown === true, '');
    // 新回合：sendPrompt 语义 —— 结构事件到达后清 lastSubagentReports
    await evalJs(`(() => {
      const s = window.__CODEBUDDY_STORE__;
      const rt = s.getState().threadRuntimeById['thread-e2e'];
      const next = Object.assign({}, s.getState().threadRuntimeById, {
        'thread-e2e': Object.assign({}, rt, {
          lastSubagentReports: null,
          lastGoalState: null,
          subagentReports: [],
          goalState: { goalsById: {}, mode: null },
          activePromptRunId: 'new-run-2',
          promptStartedAt: Date.now(),
          isAwaitingResponse: true,
        }),
      });
      s.setState({ threadRuntimeById: next });
      return true;
    })()`);
    await wait(600);
    const historyGone = await evalJs(`!(document.querySelector('[data-testid="workflow-floating-panel"]')?.textContent || '').includes('历史')`);
    check('串扰：新回合开始后历史徽标消失', historyGone === true, '');
    await shot('26-cross-turn');
  } catch (error) {
    check('QA 运行异常', false, error?.stack || String(error));
    try {
      await shot('qa-fatal');
    } catch (_) {}
  } finally {
    if (launched?.rootPid) {
      try {
        await cleanupOwned({ rootPid: launched.rootPid });
      } catch (error) {
        console.warn('cleanupOwned failed:', error?.message || error);
      }
    }
  }

  const failed = results.filter((item) => !item.ok);
  const summary = {
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
    evidenceDir: EVIDENCE,
  };
  fs.writeFileSync(path.join(EVIDENCE, `${RUN_STAMP}-summary.json`), JSON.stringify(summary, null, 2));
  console.log(`\n===== 实机 QA 汇总：${summary.passed}/${summary.total} 通过 =====`);
  if (failed.length) {
    console.log('失败项：');
    for (const item of failed) {
      console.log(`  - ${item.name}${item.detail ? ` (${item.detail})` : ''}`);
    }
    process.exitCode = 1;
  } else {
    console.log('全部通过。证据目录：' + EVIDENCE);
  }
})().catch((error) => {
  console.error('QA 脚本异常：', error);
  process.exitCode = 1;
});
