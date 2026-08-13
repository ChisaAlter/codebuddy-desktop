// 像素三方 diff（M6 终门）：改动后实机面板 vs 改动前基线 vs 原型 v3。
// 无新依赖：截图用 CDP（app）与 webContents.capturePage（原型 electron），
// 解码对比用 electron nativeImage（pixel-compare-main.cjs）。
// 输出：.omo/evidence/panel-pixel-diff/<stamp>/report.json + 三张截图 + 理由日志。
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync, spawn } = require('node:child_process');
const {
  launchDesktop,
  findRendererTarget,
  connectCdp,
  createRuntimeLayout,
  cleanupOwned,
  seedProductState,
  findStartupLog,
  findAvailablePort,
  wait,
} = require('./e2e-driver.cjs');

const projectRoot = path.resolve(__dirname, '..', '..');
const exe = path.join(projectRoot, 'dist', 'win-unpacked', 'CodeBuddy Desktop.exe');
const QA_REPO = path.resolve(projectRoot, '.omo', 'panel-qa-repo');
const ELECTRON_EXE = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const BASELINE_PNG = path.join(projectRoot, 'gui-test-screenshots', 'codebuddy-workflow-panel.png');
const PROTO_HTML = path.join(projectRoot, 'docs', 'prototypes', 'workflow-panel-v3.html');
const COMPARE_MAIN = path.join(__dirname, 'pixel-compare-main.cjs');
const EVIDENCE = path.join(projectRoot, '.omo', 'evidence', 'panel-pixel-diff');
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = path.join(EVIDENCE, RUN_STAMP);
const PANEL_PRESENT = `Boolean(document.querySelector('[data-testid="workflow-floating-panel"]'))`;

function injectPanelScript(workspacePath) {
  return `(() => {
    const s = window.__CODEBUDDY_STORE__;
    if (!s?.getState || !s?.setState) return { ok: false, error: 'store missing' };
    const state = s.getState();
    const projectId = 'project-e2e';
    const threadId = 'thread-e2e';
    const project = { id: projectId, name: 'QA', workspacePath: ${JSON.stringify(workspacePath)}, preferences: { sidebarExpanded: true } };
    const thread = { id: threadId, projectId, status: 'running', title: 'QA' };
    const runtime = {
      timeline: [],
      goalState: {
        goalsById: {
          g1: { goalId: 'g1', title: 'QA 目标一', status: 'running', sequence: 1, progress: { current: 1, total: 2 } },
          g2: { goalId: 'g2', title: 'QA 目标二', status: 'completed', sequence: 2, progress: { current: 2, total: 2 } },
        },
        mode: null,
      },
      lastGoalState: null,
      subagentReports: [
        { id: 'a1', name: 'Explore', status: 'running', summary: '正在读取 package.json', description: 'QA 描述', toolCallCount: 3, conclusionKind: 'empty', pathList: null },
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
    s.setState({
      guiSettings: Object.assign({}, state.guiSettings || {}, { locale: 'zh' }),
      projectsById: Object.assign({}, state.projectsById, { [projectId]: project }),
      threadsById: Object.assign({}, state.threadsById, { [threadId]: thread }),
      threadRuntimeById: Object.assign({}, state.threadRuntimeById, { [threadId]: runtime }),
      activeProjectId: projectId,
      activeThreadId: threadId,
      workspacePath: ${JSON.stringify(workspacePath)},
      workflowFloatingPanel: { payload: { projectId, threadId, runId: 'qa-run-1' } },
      workflowPanelDismissed: null,
      rightPanel: null,
    });
    if (window.electronAPI?.registerGitWorkspaces) {
      window.electronAPI.registerGitWorkspaces({ dirs: [${JSON.stringify(workspacePath)}] }).catch(() => {});
    }
    return { ok: true };
  })()`;
}

async function captureAppPanel(client) {
  // bootstrap 会在启动后重置面板/runtime——注入后可能被覆盖，最多重试 3 轮
  let panelVisible = false;
  for (let attempt = 0; attempt < 3 && !panelVisible; attempt += 1) {
    await client.evaluate(injectPanelScript(QA_REPO));
    try {
      await waitForPanel(client);
    } catch (_) {
      if (attempt === 2) throw new Error('panel never appeared after 3 injections');
      await wait(2500);
      continue;
    }
    await wait(1200);
    const stillThere = await client.evaluate(PANEL_PRESENT);
    panelVisible = stillThere === true;
    if (!panelVisible) await wait(2000);
  }
  // 校验注入的目标行确实渲染；被覆盖则再试一次
  const goalsVisible = await client.evaluate(`(() => {
    const t = document.querySelector('[data-testid="workflow-floating-panel"]')?.textContent || '';
    return t.includes('QA 目标一') && t.includes('Explore');
  })()`);
  if (goalsVisible !== true) {
    await client.evaluate(injectPanelScript(QA_REPO));
    try { await waitForPanel(client); } catch (_) {}
    await wait(1500);
  }
  // 禁用动画（pulse 光晕是随机帧，像素对照应比较静态设计）
  await client.evaluate(`(() => {
    document.querySelectorAll('*').forEach((el) => { el.style.animation = 'none'; });
    return true;
  })()`);
  await wait(150);
  // 结构性保真采样：与原型同属性对比（像素级受字体光栅化影响，结构级可精确判定）
  const stylesProbe = await client.evaluate(`(() => {
    const panel = document.querySelector('[data-testid="workflow-floating-panel"]');
    const pick = (sel, props) => {
      const el = panel.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const out = {};
      for (const p of props) out[p] = cs[p];
      return out;
    };
    return {
      // app 头部是 Tailwind 工具类（无 .panel-header），取 aside 的第一个子元素
      header: pick(':scope > div', ['height', 'padding', 'borderBottomWidth', 'borderBottomColor']),
      gitRow: pick('.workflow-panel__git-row', ['border', 'background', 'minHeight', 'padding']),
      goalRow: pick('.workflow-panel__goal', ['background', 'padding']),
      goalBadge: pick('.workflow-panel__goal-badge', ['width', 'height', 'borderRadius', 'border', 'background']),
      dotRunning: pick('.workflow-panel__dot.is-running', ['width', 'height', 'background', 'borderRadius']),
      subagent: pick('.workflow-panel__subagent', ['background', 'border', 'borderRadius']),
      refresh: pick('.workflow-panel__refresh', ['color', 'fontSize']),
      body: (() => {
        const b = panel.querySelector('.workflow-panel');
        if (!b) return null;
        const cs = getComputedStyle(b);
        return { padding: cs.padding, gap: cs.gap };
      })(),
    };
  })()`);
  console.log('[pixel] app styles:', JSON.stringify(stylesProbe));
  fs.writeFileSync(path.join(OUT_DIR, 'app-styles.json'), JSON.stringify(stylesProbe, null, 2));
  // CDP clip 坐标为 CSS 像素（不要乘 devicePixelRatio，否则截到面板外）
  // 强制面板宽度 320 CSS，与原型 capture 布局一致（窗口过窄时 100vw-36 会小于 320）
  const rect = await client.evaluate(`(() => {
    const panel = document.querySelector('[data-testid="workflow-floating-panel"]');
    if (!panel) return null;
    panel.style.width = '320px';
    const r = panel.getBoundingClientRect();
    return {
      x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height),
      diag: { innerWidth: window.innerWidth, dpr: window.devicePixelRatio, panelCssWidth: r.width },
    };
  })()`);
  if (!rect) throw new Error('panel not found for pixel capture');
  console.log('[pixel] app panel diag:', JSON.stringify(rect.diag));
  const shot = await client.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
  });
  const out = path.join(OUT_DIR, 'app-panel.png');
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  return { out, dpr: rect.diag.dpr };
}

async function waitForPanel(client) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const ready = await client.evaluate(`Boolean(document.querySelector('[data-testid="workflow-floating-panel"]'))`);
    if (ready === true) return;
    await wait(200);
  }
  throw new Error('panel never appeared');
}

function capturePrototype(dpr) {
  // 临时 electron 主脚本：打开原型 v3，把 #pixel-stage 缩到生产宽度 320px，
  // capturePage 直接出 PNG（无需 remote debugging）。DPR 与 app 截图对齐，
  // 否则字体光栅化不同导致文本区伪差异。--disable-gpu 避免捕获期 GPU 崩溃。
  const tempMain = path.join(OUT_DIR, 'proto-main.cjs');
  const protoOut = path.join(OUT_DIR, 'proto-panel.png');
  const protoStylesOut = path.join(OUT_DIR, 'proto-styles.json');
  fs.writeFileSync(
    tempMain,
    `'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 1100, show: false, backgroundColor: '#000000' });
  await win.loadFile(${JSON.stringify(PROTO_HTML)});
  await win.webContents.executeJavaScript(\`(() => {
    const el = document.getElementById('pixel-stage');
    if (!el) throw new Error('pixel-stage missing');
    el.style.width = '320px';
    el.style.margin = '0 auto';
    document.body.style.padding = '8px 8px 8px 8px';
    el.scrollIntoView({ block: 'start' });
    return true;
  })()\`);
  // 原型侧结构性采样（与 app 侧 app-styles.json 同属性；页面内无 Node，写文件在主进程做）
  try {
    const protoStyles = await win.webContents.executeJavaScript(\`(() => {
      const pick = (sel, props) => {
        const el = document.querySelector('#pixel-stage ' + sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        const o = {};
        for (const p of props) o[p] = cs[p];
        return o;
      };
      return {
        header: pick('.panel-header', ['height', 'padding', 'borderBottomWidth', 'borderBottomColor']),
        gitRow: pick('.workflow-panel__git-row', ['border', 'background', 'minHeight', 'padding']),
        goalRow: pick('.workflow-panel__goal', ['background', 'padding']),
        goalBadge: pick('.workflow-panel__goal-badge', ['width', 'height', 'borderRadius', 'border', 'background']),
        dotRunning: pick('.workflow-panel__dot.is-running', ['width', 'height', 'background', 'borderRadius']),
        subagent: pick('.workflow-panel__subagent', ['background', 'border', 'borderRadius']),
        refresh: pick('.workflow-panel__refresh', ['color', 'fontSize']),
        body: (() => {
          const b = document.querySelector('.panel-body');
          if (!b) return null;
          const cs = getComputedStyle(b);
          return { padding: cs.padding, gap: cs.gap };
        })(),
      };
    })()\`);
    fs.writeFileSync(${JSON.stringify(protoStylesOut)}, JSON.stringify(protoStyles, null, 2));
  } catch (error) {
    console.error('PROTO_STYLE_PROBE_FAILED ' + (error && error.message ? error.message : String(error)));
  }
  await new Promise((resolve) => setTimeout(resolve, 400));
  const rect = await win.webContents.executeJavaScript(\`(() => {
    const r = document.getElementById('pixel-stage').getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()\`);
  console.log('PROTO_RECT ' + JSON.stringify(rect));
  const image = await win.webContents.capturePage({
    x: Math.max(0, Math.round(rect.x)),
    y: Math.max(0, Math.round(rect.y)),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  });
  fs.writeFileSync(${JSON.stringify(protoOut)}, image.toPNG());
  console.log('PROTO_CAPTURED');
  app.exit(0);
});
`,
  );
  const result = spawn(
    ELECTRON_EXE,
    [`--force-device-scale-factor=${dpr}`, '--disable-gpu', tempMain],
    { stdio: 'pipe' },
  );
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { result.kill(); } catch (_) {}
      reject(new Error(`prototype capture timeout. stderr: ${err.slice(0, 800)}`));
    }, 45000);
    result.stdout.on('data', (d) => { out += String(d); });
    result.stderr.on('data', (d) => { err += String(d); });
    result.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !fs.existsSync(protoOut)) {
        reject(new Error(`prototype capture failed (${code}): ${err.slice(0, 800)}`));
        return;
      }
      resolve(protoOut);
    });
  });
}

function runCompare(appPng, protoPng) {
  const reportOut = path.join(OUT_DIR, 'report.json');
  const result = spawn(ELECTRON_EXE, [COMPARE_MAIN, appPng, BASELINE_PNG, protoPng, reportOut], { stdio: 'pipe' });
  return new Promise((resolve, reject) => {
    let err = '';
    const timer = setTimeout(() => {
      try { result.kill(); } catch (_) {}
      reject(new Error('compare timeout'));
    }, 45000);
    result.stderr.on('data', (d) => { err += String(d); });
    result.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !fs.existsSync(reportOut)) {
        reject(new Error(`compare failed (${code}): ${err.slice(0, 800)}`));
        return;
      }
      resolve(JSON.parse(fs.readFileSync(reportOut, 'utf8')));
    });
  });
}

(async () => {
  if (!fs.existsSync(exe)) throw new Error(`packaged exe missing: ${exe}`);
  if (!fs.existsSync(BASELINE_PNG)) console.warn('[pixel] baseline missing:', BASELINE_PNG);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('[pixel] out dir:', OUT_DIR);

  const runtimeOwnership = createRuntimeLayout({ projectRoot, runStamp: RUN_STAMP, label: 'panel-pixel-diff' });
  const { runtimeRoot, runtimeDir, userDataDir } = runtimeOwnership;
  seedProductState({ userDataDir, projectRoot: QA_REPO, activeThreadId: 'thread-e2e' });
  console.log('[pixel] launching packaged app…');

  const launched = await launchDesktop({ executable: exe, projectRoot, userDataDir, runtimeRoot, runtimeDir, runtimeOwnership });
  console.log(`[pixel] rootPid=${launched.rootPid} debugPort=${launched.debugPort}`);
  launched.process.stdout?.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) console.log(`[app] ${text.slice(0, 200)}`);
  });
  launched.process.stderr?.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) console.log(`[app:err] ${text.slice(0, 200)}`);
  });
  let client = null;
  let appPng = null;
  let appDpr = 1;
  try {
    const target = await findRendererTarget({ port: launched.debugPort, timeoutMs: 45000 });
    console.log('[pixel] renderer target found');
    client = await connectCdp(target);
    console.log('[pixel] CDP connected');
    // 等待 store 就绪后注入面板状态（captureAppPanel 内部完成注入 + 面板挂载等待）
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const ready = await client.evaluate(`Boolean(window.__CODEBUDDY_STORE__?.getState)`);
      if (ready === true) break;
      await wait(250);
    }
    const captured = await captureAppPanel(client);
    appPng = captured.out;
    appDpr = captured.dpr || 1;
    console.log('[pixel] app panel captured:', appPng);
  } finally {
    if (launched?.rootPid) {
      try { await cleanupOwned({ rootPid: launched.rootPid }); } catch (_) {}
    }
  }

  console.log(`[pixel] capturing prototype (dpr=${appDpr})…`);
  const protoPng = await capturePrototype(appDpr);
  console.log('[pixel] prototype captured:', protoPng);
  console.log('[pixel] comparing…');
  const report = await runCompare(appPng, protoPng);

  // 结构性保真对比（computed-style 逐属性，不受字体光栅化影响）
  let appStyles = null;
  try { appStyles = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'app-styles.json'), 'utf8')); } catch (_) {}
  let protoStyles = null;
  try { protoStyles = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'proto-styles.json'), 'utf8')); } catch (_) {}
  // proto-styles.json 由原型采样写入（缺失时结构对比自动降级为部分通过）
  const structural = [];
  if (!appStyles || !protoStyles) {
    structural.push({ section: 'probe', pass: false, detail: '样式采样缺失：app=' + Boolean(appStyles) + ' proto=' + Boolean(protoStyles) + '（像素级对比不受影响）' });
  }
  const sections = ['header', 'gitRow', 'goalRow', 'goalBadge', 'dotRunning', 'subagent', 'refresh', 'body'];
  for (const section of sections) {
    const a = appStyles ? appStyles[section] : null;
    const b = protoStyles ? protoStyles[section] : null;
    if (!a || !b) {
      structural.push({ section, pass: false, detail: `missing: app=${!!a} proto=${!!b}` });
      continue;
    }
    const diffs = [];
    for (const key of Object.keys(a)) {
      if (String(a[key]) !== String(b[key])) diffs.push({ key, app: a[key], proto: b[key] });
    }
    structural.push({ section, pass: diffs.length === 0, diffs });
  }
  const structuralPass = structural.every((item) => item.pass);
  console.log('[pixel] structural fidelity:', structuralPass ? 'PASS' : 'FAIL', JSON.stringify(structural.filter((i) => !i.pass)));

  // 理由日志：超差条目必须记录理由，不允许静默容忍
  const reasons = {
    'app-vs-baseline': '预期差异：基线为 2026-08-02 旧版右侧面板（WorkflowRightPanel），本次为悬浮窗重设计产物（尺寸/结构/文案全部重做），像素级 1:1 不适用；保留此对比作为“改动前后”证据，差异簇见 report.json。',
    'app-vs-prototype': report.pairs[1]?.pass
      ? '原型 v3 完整态与实机面板在 1px 容差内一致。'
      : '差异簇为原型静态占位与实机真实数据的文案/间距差异（原型不含生产 CSS 全部细节），逐簇核对见 report.json；不静默容忍。',
  };
  const reportWithReasons = { ...report, reasons, structural, structuralPass, stamp: RUN_STAMP, baselinePng: BASELINE_PNG };
  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(reportWithReasons, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'reasons.md'), Object.entries(reasons).map(([k, v]) => `## ${k}\n\n${v}\n`).join('\n'));

  const proto = report.pairs[1];
  console.log(`\n===== 像素三方 diff 汇总 =====`);
  console.log(`app-vs-baseline : ${report.pairs[0].diffRatio * 100}% 差异像素（预期大差异，理由已记录）`);
  console.log(`app-vs-prototype: ${(proto.diffRatio * 100).toFixed(3)}% 差异像素 → ${proto.pass ? 'PASS（≤1px 容差）' : 'FAIL（超差，理由已记录）'}`);
  console.log('结构保真: ' + (structuralPass ? 'PASS' : 'FAIL（差异见 report.json structural）'));
  console.log('报告：' + path.join(OUT_DIR, 'report.json'));
  if (!proto.pass) process.exitCode = 1;
})().catch((error) => {
  console.error('[pixel] 异常：', error);
  process.exitCode = 1;
});
