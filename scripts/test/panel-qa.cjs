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
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
function ensureQaRepos() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  fs.mkdirSync(NOT_REPO, { recursive: true });
  if (!fs.existsSync(path.join(QA_REPO, '.git'))) throw new Error(`QA_REPO missing git: ${QA_REPO}`);
  if (!fs.existsSync(QA_BARE)) throw new Error(`QA_BARE missing: ${QA_BARE}`);
  git(['config', 'user.email', 'qa@local'], QA_REPO);
  git(['config', 'user.name', 'QA Tester'], QA_REPO);
  git(['remote', 'set-url', 'origin', QA_BARE], QA_REPO);
  try {
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], QA_BARE);
  } catch (_) {}
  try {
    git(['push', '-u', 'origin', 'main'], QA_REPO);
  } catch (error) {
    console.warn('[qa] initial push failed:', error?.message || error);
  }
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
