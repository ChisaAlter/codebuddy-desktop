# 剩余生产性能门禁计划

状态：**已实现**（commit 27a8242，2026-08-05；本文件原状态「pending approval 仅计划」为文档滞后，已与实际对齐）

## 0. 实现落地对照

| 计划项 | 落地证据 |
|---|---|
| 阶段 0 capability probe | `scripts/test/perf-capability-probe.cjs`，输出 `out/perf-capability-probe.json` |
| ① 300 条大 transcript fixture + route soak | `scripts/test/perf-fixtures.cjs`（300 条 / 20×200KB），`manual-perf-gui.cjs --packaged` |
| ② heap/DOM/listener 预算与泄漏斜率 | `scripts/test/perf-memory.cjs` + `test:perf:memory`（基线 + p95 阈值断言） |
| ③ bundle 与已提交基线增长比较 | `scripts/test/bundle-budget.cjs` + `scripts/test/bundle-baseline.json` + `test:bundle-budget` |
| ④ 门禁写入 test/release 文档并接入 release gate | `package.json` `test:release` 已含 bundle-budget / e2e / packaged / perf:production / perf:memory |
| 伪测量消除 | `manual-perf-gui.cjs` streaming flood 已改走真实 `appendThreadTimelineEvent` reducer 路径 |

后续发布级缺口（尚未立项）：heap/DOM/listener 预算在 CI 侧的自动斜率回归（当前为打包实机验证）；keep-alive「最近 N 个」上限策略。

## 1. 范围与现状

当前已经完成并验证：

- product-state generation barrier、原子保存、保存窗口 Promise 结算。
- 项目绑定的终端快照和跨项目竞态保护。
- 聊天草稿防抖、切线程和发送期间继续输入保护。
- packaged Electron 热路径验收、路由访问、终端批处理、流式输入、进程 Job 清理。
- 绝对 bundle raw size/gzip size 门禁。

尚未完成的发布级能力：

1. 300 条大 transcript fixture，以及长时间/多轮 route soak。
2. 显式 heap、DOM node、listener 预算和泄漏斜率门禁。
3. bundle 与已提交历史基线的增长比较。
4. 将新门禁、运行成本、基线更新规则完整写入测试和 release 文档，并接入 release gate。

本计划只覆盖上述缺口，不重新改造已经通过的保存、终端、草稿和路由 keep-alive 实现。

### 已确认的代码事实

- `src/main.jsx:10` 已 `window.__CODEBUDDY_STORE__ = useStore`，现有 `manual-perf-gui.cjs` 全程通过该句柄调用 `getState()`、`patchThreadRuntime`、`appendPaneOutput`、`setRoute`。**不需要新增 bridge**。
- 真实流式 timeline 入口是 `appendThreadTimelineEvent`（`src/store/slices/product-persist.js:187`），它内部调用 `reduceAcpEvent` + `patchThreadRuntime`；对 coalesced event 类型走 `queueCoalescedTimelineEvent`。
- 现有 `manual-perf-gui.cjs:298-303` 的 streaming flood **错误地**用 `patchThreadRuntime(threadId, { timeline: [...timeline, item] })` 重建整数组，绕过了真实 reducer——这正是本计划必须消除的伪测量。
- keep-alive 实现在 `src/App.jsx:591-601`：所有已访问路由永久保留，切项目时重置。当前**没有**"最近 N 个"上限。任何上限策略都是新代码。
- `e2e-driver.cjs` 现有 CDP 调用只覆盖 `Runtime.evaluate/enable`、`Page.enable`、`Input.dispatchMouseEvent/KeyEvent`、`Page.captureScreenshot`。从未调用 `Memory.*` 或 `HeapProfiler.*`，其在 Electron 34 / Chromium 132 remote debugging 下的可用性**未验证**。
- `bundle-budget.cjs:10-13` 用 regex 匹配带 hash 的文件名，按 `label` 报告；baseline 比较应以 label 为 key。
- `package.json:41` 的 `test:release` 当前**不包含** `test:perf:production`，需要显式新增。
- 输入测量在 renderer E2E 中已证明必须用 `Input.dispatchKeyEvent`（`rawKeyDown` + 完整修饰键序列）才能触发真实全局快捷键；`setter.call(textarea, value)` + 合成 `input` event 只能测 store 响应，不能测真实键盘热路径。

## 2. 阶段 0：capability probe（新增前置）

在写任何 soak 脚本之前，先探测当前 packaged Electron 34 的 CDP 指标可用性，避免写完脚本才发现核心指标采不到。

### 工作

1. 在真实 packaged renderer 上依次执行并记录返回：
   - `client.send('Memory.enable')`
   - `client.send('Memory.getDOMCounters')`
   - `client.send('HeapProfiler.enable')`
   - `client.send('HeapProfiler.collectGarbage')`
   - `client.send('Runtime.getHeapUsage')`
   - `Performance.observe`（在页面内 `Runtime.evaluate` 注入）
2. 对每个 API 记录：`supported: true/false`、返回字段、错误消息。
3. 若 `Memory.getDOMCounters` 不支持，尝试替代：`Runtime.evaluate` 注入 `performance.memory`（Chromium 限定）+ 手动 DOM 计数 `document.querySelectorAll('*').length`。
4. 若 `HeapProfiler.collectGarbage` 不支持，尝试 `Runtime.evaluate('if (globalThis.gc) gc()')`（需 `--js-flags=--expose-gc`，记录是否可用）。
5. 把 probe 结果写入 `out/perf-capability-probe.json`，作为后续阈值的依据。

### 验收

- probe 脚本自身可重复运行，输出每个 API 的 supported 状态。
- unsupported API 必须有明确的替代采样方案或标记为发布阻塞，不得静默跳过。
- probe 结果作为阶段 C 阈值确立的输入，不作为通过/失败判定。

## 3. 完成标准

所有标准都必须在真实打包后的 Electron renderer 中验证，不能用 jsdom、直接修改 textarea value、直接替换 `threadsById` 或伪造消息数组代替主验收路径。

### 3.1 大 transcript 与输入/流式性能

固定 fixture：

- 300 条 transcript entries。
- 至少 100 条 Markdown 内容。
- 至少 50 条包含 fenced code block，覆盖 JavaScript、JSON、Python 和 shell。
- 至少 20 条接近 200KB 的边界消息。
- 包含 user、assistant、tool、thinking/status 等真实 timeline 类型。
- fixture 固定项目、线程、模型和运行状态，避免后端状态漂移影响测量。

流式数据追加方式（强制）：

- 通过 `window.__CODEBUDDY_STORE__.getState().appendThreadTimelineEvent(threadId, eventType, payload)` 逐条追加，走真实 `reduceAcpEvent` + coalesce 路径。
- **禁止**测试脚本直接 `patchThreadRuntime(threadId, { timeline: [...] })` 重建整数组。
- 新增单测断言：fixture 驱动的 `appendThreadTimelineEvent` 与真实 SSE chunk handler 调用同一 `reduceAcpEvent`，且 coalesced event 类型走 `queueCoalescedTimelineEvent`。

输入测量方式（强制）：

- 统一用 `Input.dispatchKeyEvent`（`rawKeyDown` + 完整 Ctrl/Shift/Alt 修饰键按下/抬起序列），与 `e2e-renderer.cjs` 的 Ctrl+B 验证对齐。
- 合成 `setter.call(textarea, value)` + `dispatchEvent(new Event('input'))` 仅保留用于 store 结构断言（如 `threadsById` 引用稳定性），不得作为延迟门禁的测量方式。

门限：

- 空 transcript 输入：单键 p95 <= 35ms，单键最大值不得超过 100ms。
- 300-entry transcript 输入及 streaming 期间输入：单键 p95 <= 50ms。
- 连续 10 秒测量窗口内，long task >100ms 为 0；long task >50ms 不超过 2 次。
- 300-entry chat 首次可交互时间 median <= 1.5s。
- 从 terminal/editor/settings 返回 chat 的 p95 <= 150ms。

### 3.2 Heap、DOM 和 listener 预算

使用 CDP 采集真实 Chromium 指标（依赖阶段 0 probe 结果）：

- `HeapProfiler.collectGarbage` 后读取 `Runtime.getHeapUsage`。
- `Memory.getDOMCounters` 读取 DOM nodes、documents、jsEventListeners；若不支持，用 `performance.memory` + 手动 DOM 计数替代。
- `PerformanceObserver` 记录 longtask、event timing。
- 每个样本记录采集时 route、active/hidden keep-alive view、transcript size、GC 前后数值。

固定预算（阈值待 baseline 确认）：

- 阈值在阶段 0 probe + 首轮采集后固化。以下为初始目标，若实测基线显著偏离，以"baseline × 倍率"替代绝对值，并在报告中记录调整理由。
- JS heap：GC 后 10 轮切换斜率目标 <= 1MiB/轮；全路由访问后 retained 增量目标 <= 80MiB（标注"待 baseline 确认"）。
- DOM nodes：相对已提交 baseline 增长 <=25%；首轮采集前不硬编码绝对上限。
- `jsEventListeners`：10 轮切换中不得持续单调增长；最终值相对首轮增加不超过 100 个。
- unsupported 指标不能作为通过理由，必须补充替代采样或标记为发布阻塞。

### 3.3 Bundle 历史增长门禁

在当前绝对预算基础上增加提交的历史基线：

- baseline JSON 以 **label**（`main entry` / `workspace route` / `terminal route`）为 key，保存 raw bytes、gzip bytes、匹配 pattern、toolchain 版本和生成 commit。
- `pattern` 只用于运行时匹配产物文件名，baseline 比较的是同一 label 下当前 raw/gzip 与历史 raw/gzip，**不比较文件名 hash**。
- 任一 chunk 的 raw size 相对 baseline 同时满足增长 >10% 且增长 >50KB 时失败。
- gzip size 同时满足增长 >10% 且增长 >10KB 时失败。
- chunk 缺失判定标准：label 对应的 pattern 在当前产物中无匹配文件时失败，而不是"hash 不一致"。
- baseline schema 不兼容或字段缺失时直接失败。
- 正常检查不得自动更新 baseline；只有显式 `npm run test:bundle-budget:update`（需 `--update-baseline` 或环境变量授权）才能更新，且必须人工审查 diff。

## 4. 文件与实现步骤

### 阶段 A：建立可复现 fixture 和报告协议

预计修改/新增：

- `scripts/test/manual-perf-gui.cjs`（改造）
- 新增 `scripts/test/perf-fixtures.cjs`
- 新增 `scripts/test/perf-report.cjs`
- 新增 `tests/unit/perf-fixtures.test.js`
- 新增 `tests/unit/perf-report.test.js`

工作内容：

1. 把 transcript fixture、stream chunk fixture、route sequence、固定窗口/profile 参数集中到 `perf-fixtures.cjs`。
2. fixture builder 只生成可序列化数据，不负责绕过产品 reducer。
3. 复用 `window.__CODEBUDDY_STORE__` 作为唯一 store 访问点；新增单测断言 build 产物中 `window.__CODEBUDDY_STORE__` 存在且暴露 `getState`、`appendThreadTimelineEvent`、`patchThreadRuntime`、`appendPaneOutput`、`setRoute` 白名单。
4. 所有测量结果统一写入 `perf-report.json`，至少包含：
   - commit、时间、OS、Electron、Node、Vite、窗口尺寸。
   - fixture hash、entry 数、Markdown/code block/large message 数量。
   - route sequence 和 keep-alive 状态。
   - 每项原始 samples、median、p95、max。
   - longtask/event timing 样本。
   - heap/DOM/listener baseline、每轮值、斜率和 verdict。
   - capability probe 结果引用。
   - cleanup/job 结果。
5. 每次失败保留最后一个失败路由、当前 DOM/heap 诊断和截图路径。

验收：

- 同一 fixture hash 在同一 build 上重复运行，entry 统计和样本结构一致。
- 报告中不存在未解释的 `undefined`、空数组或吞掉的异常。
- 单测覆盖 fixture 数量、消息类型、200KB 边界、报告 schema、p95/斜率计算和 store 白名单存在性。

### 阶段 B：实现大 transcript 首次加载和 streaming 场景

主要文件：

- `scripts/test/manual-perf-gui.cjs`
- `src/store/slices/product-persist.js`（仅确认入口，不修改）
- `src/store/slices/sessions-chat.js`（仅确认 reduce 路径，不修改）
- 新增 `tests/unit/perf-timeline-path.test.js`
- `tests/unit/timeline.test.js`（扩展）
- `tests/unit/store-conversation-events.test.js`（扩展）

工作内容：

1. 启动 packaged app 后通过 `seedProductState` 注入 300-entry fixture，走真实 hydrate 和 chat 首次加载。
2. 等待 route ready marker（见下）后开始计时。
3. 记录首次可交互、首帧、最后一条 transcript 渲染完成时间。
4. 在 transcript 已稳定渲染时用 `Input.dispatchKeyEvent` 执行真实键盘输入测量。
5. 在输入期间通过 `appendThreadTimelineEvent` 分批追加 100+ streaming chunks，重复测量输入延迟。
6. 验证 chunk flood 不会把 `threadsById`、无关项目或 hidden keep-alive view 重建到热路径。
7. 每项至少 1 次预热 + 5 次正式样本；性能 gate 使用 p95/max，报告保留所有原始样本。

route ready marker 定义（用 `waitForRendererValue`，禁止固定 sleep）：

- chat：composer textarea 可交互 + 最后一条 timeline entry 已渲染。
- terminal：xterm canvas 存在 + pane output 非空或空态文案可见。
- editor：Monaco editor DOM 存在 + file tree 或空态可见。
- settings：settings section heading 可见。

streaming 路径强制约束：

- 测试脚本调用 `appendThreadTimelineEvent(threadId, 'agent_message_chunk', payload)` 走真实 `reduceAcpEvent` + coalesce。
- 新增 `perf-timeline-path.test.js` 断言：fixture 调用的 `appendThreadTimelineEvent` 与 `sessions-chat.js` SSE handler 调用同一 `reduceAcpEvent` 函数引用。
- 现有 `manual-perf-gui.cjs:298-303` 的 `patchThreadRuntime({ timeline })` 重建写法必须删除，改为 `appendThreadTimelineEvent`。

失败处理：

- 如果首次加载超时，报告必须区分网络/后端未 ready、renderer 未 ready、fixture hydrate 失败和真正渲染超时。
- 如果大 transcript 导致渲染超时，不得提高门限掩盖问题；先确认是否需要虚拟化、分段 Markdown 渲染或 transcript 上限策略，再单独提出实现变更。

### 阶段 C：实现 heap/DOM/listener soak

主要文件：

- `scripts/test/manual-perf-gui.cjs`
- 新增 `scripts/test/perf-memory.cjs`
- `tests/unit/perf-memory.test.js`
- `src/App.jsx`、keep-alive 相关组件（仅在门禁证明泄漏后修改）

工作内容：

1. **首轮只采集不判定**：执行全路由访问和 10 轮核心路由切换，记录 heap/DOM/listener 每轮值，但不做通过/失败判定。
2. 基于首轮数据确立 baseline，固化阈值（若实测显著偏离 §3.2 目标，以"baseline × 倍率"替代并记录理由）。
3. 正式 soak 流程：
   - 进入 chat，完成 fixture hydrate 并采集 baseline。
   - 依次访问 chat、terminal、editor、settings，并覆盖其余 keep-alive route；每次 route 进入后等待 ready marker。
   - 完成全部路由后强制 GC 并采集 retained 指标。
   - 重复核心 4 路由切换 10 轮，每轮记录 route ready latency、JS heap used/total、DOM nodes/documents/listeners。
   - 计算 slope、最大增量、最终 retained delta，按固化阈值判定。
4. 失败时输出按 route、view 和 sender 分组的差异；优先定位未卸载 effect、轮询、ResizeObserver、WebSocket/SSE、xterm/Monaco 资源。

实现约束：

- 不默认修改 App 的 keep-alive 策略。
- 当前 keep-alive 是全路由保活（`App.jsx:591-601`）；"最近 N 个"上限策略仅在 soak 证明泄漏后作为可选实现变更，且需单独评估对真实用户切换行为的影响。
- 每个 cleanup 修复必须新增对应 mount/unmount 重复测试和 packaged soak 验证。

### 阶段 D：建立 bundle 历史 baseline

主要文件：

- `scripts/test/bundle-budget.cjs`（改造）
- 新增 `scripts/test/bundle-baseline.json`
- `package.json`
- 新增 `tests/unit/bundle-budget.test.js`

baseline schema：

```json
{
  "schemaVersion": 1,
  "generatedAt": "...",
  "toolchain": { "vite": "...", "node": "...", "electron": "..." },
  "commit": "...",
  "entries": {
    "main entry": { "pattern": "^index-[^/]+\\.js$", "rawBytes": 0, "gzipBytes": 0 },
    "workspace route": { "pattern": "^ReplicaWorkspaceView-[^/]+\\.js$", "rawBytes": 0, "gzipBytes": 0 },
    "terminal route": { "pattern": "^ReplicaTerminalView-[^/]+\\.js$", "rawBytes": 0, "gzipBytes": 0 }
  }
}
```

工作内容：

1. 首次基线由当前已通过 build 产物生成，人工确认三项 chunk 与当前绝对预算一致。
2. 正常 `npm run test:bundle-budget` 同时检查绝对上限和历史增长，按 label 比较。
3. 新增 `npm run test:bundle-budget:update`，要求 `--update-baseline` 或环境变量授权；普通 release gate 不得调用。
4. 单测覆盖：正常通过、raw 增长失败、gzip 增长失败、chunk 缺失失败、baseline schema 错误、pattern 匹配但 hash 变化的正常情况。
5. 报告显示 baseline 值、当前值、绝对差、百分比差和触发的规则。

### 阶段 E：release gate 与文档接线

主要文件：

- `package.json` scripts
- `TESTING.md`
- `RELEASE_NOTES.md`
- 需要时新增 `scripts/test/release-performance-gate.cjs`

当前 `test:release`（`package.json:41`）是：

```text
npm run test:gate && npm run test:bundle-budget && npm run test:e2e && npm run test:packaged
```

**不包含** `test:perf:production`。需要改为：

```text
npm run test:gate && npm run test:bundle-budget && npm run test:e2e && npm run test:packaged && npm run test:perf:production && npm run test:perf:memory
```

新增 scripts：

```text
npm run test:perf:memory
npm run test:bundle-budget:update   # 仅人工确认后使用
```

release gate 规则：

1. 普通 `npm test` 不启动 Electron soak，保持开发反馈速度。
2. `test:release` 必须包含：lint、diff check、全量单测、mobile-remote、bundle absolute+baseline、unpackaged E2E、packaged E2E、packaged performance、memory/DOM soak。
3. 任何 gate 失败都返回非零，并保留 JSON 报告路径。
4. release 脚本不得自动刷新 baseline、删除失败证据或覆盖已有报告。
5. 文档区分：快速开发检查、普通 CI gate、packaged 发布门禁、baseline 更新流程、Windows Job/AV 文件锁软失败判定。
6. `RELEASE_NOTES.md` 增加本次性能门禁能力、阈值和已知限制；不把尚未实现的内存 soak 宣称为已完成。

平台范围：

- 第一阶段只把 Windows packaged Electron 34 作为强门禁平台。
- macOS/Linux 只生成报告不作 gate。
- bundle baseline 仍以 Windows 产物为准，避免跨平台产物差异污染基线。

## 5. 风险与处理

### 风险 1：大 transcript 测试自身制造了非产品性卡顿

处理：固定 fixture hash、分开测量 hydrate/render/input；先采集 CPU/longtask 和 DOM 节点，再决定是否需要虚拟化，不直接放宽阈值。

### 风险 2：GC/heap 指标在 Electron 版本中不稳定或不可用

处理：阶段 0 先探测 CDP 指标可用性；固定 Electron 34、显式调用 CDP GC、每个样本重复采集；同时使用 heap、DOM、listener 三类指标。任何不支持的指标都必须报告为阻塞项或提供替代采样。

### 风险 3：keep-alive 全路由保活设计本身造成 retained heap 增长

处理：先通过 10 轮 slope 证明泄漏，再考虑上限策略；当前基线是全路由保活（`App.jsx:591-601`），任何"最近 N 个"上限都是新代码，需单独评估对真实用户切换行为的影响。

### 风险 4：bundle baseline 因 toolchain/hash 变动产生误报

处理：baseline 按 label 保存，不比较 hash；记录 Vite/Node/Electron 版本，toolchain 变化要求重新生成基线并人工审查，而不是自动接受。

### 风险 5：发布时间过长导致门禁无人运行

处理：把快速 gate 和 release gate 分层；报告支持阶段失败定位；发布 gate 使用固定 fixture/profile/窗口并明确预计运行时长。

### 风险 6：平台差异导致阈值漂移

处理：第一阶段只把 Windows packaged Electron 34 作为强门禁平台；macOS/Linux 只生成报告不作 gate，bundle baseline 仍以 Windows 产物为准。

### 风险 7：streaming 测试绕过真实 reducer

处理：强制使用 `appendThreadTimelineEvent`，禁止 `patchThreadRuntime({ timeline })` 重建；新增单测断言 fixture 与 SSE handler 共用同一 `reduceAcpEvent` 引用；删除现有 `manual-perf-gui.cjs` 中的重建写法。

### 风险 8：heap/DOM 绝对阈值在无 baseline 时误报

处理：阶段 C 首轮只采集不判定，用真实数据确立 baseline 后再固化阈值；绝对上限改为相对 baseline 增长倍率，不硬编码未经实测的数字。

## 6. 实施顺序

1. **阶段 0**：CDP capability probe，确认可用指标和替代方案。
2. **阶段 A**：固定 fixture、报告 schema、store 白名单单测。
3. **阶段 B**：实现 300-entry transcript 首次加载和真实 streaming 测量；删除现有 `patchThreadRuntime` 重建写法。
4. **阶段 C 首轮**：heap/DOM/listener 只采集，确立 baseline。
5. **阶段 C 正式**：固化阈值，运行 soak 判定。
6. **阶段 D**：生成并人工审查 bundle baseline，接入增长比较。
7. **阶段 E**：更新 release scripts、`TESTING.md`、`RELEASE_NOTES.md`。
8. 先跑单测和脚本契约，再跑 unpackaged/packaged E2E。
9. 跑性能、memory/DOM soak，修复有证据支持的产品泄漏。
10. 按 release 顺序执行全部门禁并保存报告。

## 7. 最终验收命令

```bash
npm run lint
git diff --check
npm test
npm run test:mobile-remote
npm run build
npm run test:e2e
npm run test:packaged
npm run test:bundle-budget
npm run test:perf:production
npm run test:perf:memory
npm run test:release
```

最终必须同时满足：

- 300-entry transcript、真实 streaming、长时间 route soak 全部有原始样本和 JSON 报告。
- heap、DOM nodes、listeners 均有 baseline、斜率、最终 retained 值和 verdict。
- bundle 增长比较使用已提交 baseline，未自动更新。
- release gate 包含上述检查且失败可定位到具体场景。
- `git status` 不包含测试脚本临时诊断字段，不删除用户已有未跟踪内容，不创建 commit，除非用户另行要求。