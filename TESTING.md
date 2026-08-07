# 测试与门禁

本文档是 CodeBuddy Desktop 当前提交、Electron 变更和本地发布验证的门禁说明。

## 环境前提

- 在仓库根目录执行命令。
- Node.js、npm、Electron 依赖和可用的 CodeBuddy CLI 必须已安装。
- 当前仓库没有启用 GitHub Actions；无论本机是否配置 pre-commit / pre-push hook，门禁都需要显式执行并在提交说明中报告。
- 门禁命令按顺序执行，失败即停止。不要用 `--no-verify`、跳过测试或伪造成功结果。

## 提交门禁

普通提交以及本次聊天、Markdown、右侧面板、工作流和 Goal 变更执行：

```bash
npm run test:gate
```

`test:gate` 固化以下检查：

```bash
npm run lint
git diff --check
npm test
npm run test:mobile-remote
```

通过标准：

- ESLint 无 error；warning 必须在报告中列出，且本次变更不得新增 warning。
- Git diff 无空白错误。
- Vitest 全部通过；允许仓库明确标记的 skip，但不得忽略失败 suite。
- mobile-remote protocol、crypto、relay 和 Electron mobile-remote Node tests 全部通过。

`npm run test:gate` 检查的是当前工作树，因此提交前应在 staged 前后各执行一次 `git diff --check`；提交前还应检查 staged diff，确保没有无关文件。

## Electron / 渲染层门禁

涉及 Electron 主进程、preload、渲染层、Markdown、右侧面板或工作流 UI 时，追加：

```bash
npm run build:dir
```

该命令验证 Vite 生产构建和 unpacked Electron 目录生成。它不等同于 packaged installer 验证。

本次功能的重点回归测试映射：

| 范围 | 测试 |
| --- | --- |
| Stop 立即取消、取消结果和迟到状态保护 | `tests/unit/chat-cancel.test.jsx`、`tests/unit/store-prompt-session.test.js` |
| Markdown 原始 HTML、危险链接、图片协议和单消息降级 | `tests/unit/user-msg-render.test.jsx`、`tests/unit/navigation-policy.test.js` |
| 文件 / 浏览器 / 工作流右侧面板 | `tests/unit/right-panel.test.jsx`、`tests/unit/workflow-status.test.js` |
| Goal 归一化、去重、乱序和 timeline 恢复 | `tests/unit/goal-state.test.js` |
| workflow / goal ACP 事件处理 | `tests/unit/workflow-status.test.js` 及相关 store 测试 |
| prompt idle 后的后台 workflow 进度与最终汇总 | `tests/unit/workflow-progress.test.js`、`tests/unit/acp-stream.test.js`、`tests/unit/store-conversation-events.test.js`、`tests/unit/store-prompt-session.test.js`、`tests/unit/timeline.test.js` |
| 思考强度保留 `ultracode` | `tests/unit/i18n.test.js`、`tests/unit/store-prompt-session.test.js` |
| 传输失败快速重连 / 错误分类 / 无自动重发 | `tests/unit/acp-auto-reconnect.test.js`、`tests/unit/acp-error-classify.test.js`、`tests/unit/prompt-transport-recovery.test.js`、`tests/unit/store-prompt-session.test.js` |
| 传输重连 kill switch 设置 | `tests/unit/gui-settings.test.js` |

### 传输失败快速重连（v2）门禁

涉及 `src/lib/acp.js`、`electron/main.cjs`、`electron/preload.cjs`、`sessions-chat` 传输恢复时，提交前至少执行：

```bash
npm run lint
npx vitest run \
  tests/unit/acp-auto-reconnect.test.js \
  tests/unit/acp-error-classify.test.js \
  tests/unit/prompt-transport-recovery.test.js \
  tests/unit/store-prompt-session.test.js \
  tests/unit/store-cancel.test.js \
  tests/unit/acp-stream.test.js \
  tests/unit/gui-settings.test.js
npm test
```

通过标准：

- 错误分类：401→auth、429→rate_limit、4xx→client、5xx→upstream、真网络断开→transport、长任务 idle→idle。
- 有限退避：`maxReconnectAttempts` 后触发 `reconnect_failed`，不永久 `reconnecting`。
- `restoreConnection` 成功路径：`connect` → `initialize` → `session/load`（无 active prompt 时）。
- **不自动二次** `session/prompt`；失败走历史恢复 / 错误卡 / 草稿恢复。
- turn 终态 delayed rebind：`sessionRestoreNeeded` 时补 `session/load` + `markSessionBound`。
- kill switch：`guiSettings.transportAutoReconnect=false` 时不调度自动重连。

### 后台 Workflow 汇总门禁

涉及 `electron/workflow-progress.cjs`、ACP 请求归属、`sessions-chat` 工作流监视/后台接收或 timeline 流关闭时，先执行专项回归：

```powershell
npx vitest run `
  tests/unit/workflow-progress.test.js `
  tests/unit/acp-stream.test.js `
  tests/unit/store-conversation-events.test.js `
  tests/unit/store-prompt-session.test.js `
  tests/unit/timeline.test.js
```

这些测试位于 `tests/unit`，因此也由 `npm test` 和统一的 `npm run test:gate` 自动执行。专项回归通过标准：

- 只从运行时登记的可信项目目录读取对应 session/run 的 workflow record / journal，拒绝非法 ID 和调用方伪造的 cwd。
- prompt 请求进入 idle 后，活动 workflow 仍轮询真实阶段和子代理状态，并在终态开启有最大时限的后台接收窗口。
- 后台接收锁定首个 server requestId；其他、过期或带不匹配 promptRunId 的事件不得写入当前时间线。
- 同一 server requestId 的 `session_end` 关闭最终 assistant 流，保留完整正文，并设置 `streaming=false` 和有效 `completedAt`。

### staged 与提交前检查

如果这次变更包含主进程、preload、store 或 workflow 相关文件，提交前还要显式核对：

```bash
git diff --check
git diff --cached --check
git diff --cached
```

目标不是“看起来像过了”，而是确认 staged diff 只包含本次工作流修复及对应文档 / 测试门禁，不混入其他脏改动。

Electron/传输层改动还应使用全新隔离输出目录生成 unpacked 应用，再执行真实 packaged 会话验收，避免覆盖用户正在运行的 `dist`：

```powershell
npm run build:dir -- --config.directories.output=.omo/build-workflow-gate
$env:WORKFLOW_PACKAGED_EXE=(Resolve-Path '.omo/build-workflow-gate/win-unpacked/CodeBuddy Desktop.exe')
$env:WORKFLOW_AGENT_TIMEOUT_MS='240000'
node scripts/test/manual-workflow-drain-real-gui.cjs
```

实机验收必须观察到：真实工作流/子代理出现在弹窗；prompt 线程 idle 时 workflow 仍活动；最终汇总在聊天区完整可见；同一 requestId 发出 `session_end` 后消息结束流式状态；测试创建的进程全部清理。脚本将截图、workflow record、启动日志和 `summary.json` 写入 `.omo/evidence/workflow-drain-real/workflow-drain-*`，任一条件不满足均返回非零。

#### 实机验收（可选，推荐 Electron / 传输层改动后执行）

```bash
# 终端 1
npm run dev:vite

# 终端 2
node scripts/test/manual-transport-reconnect-gui.cjs
```

该脚本启动真实 Electron 窗口，通过 CDP 在渲染进程执行 8 项验收（有限重连、restore、401、分类、kill switch、无重发、delayed rebind、设置默认值）。截图与 JSON 报告写入 `gui-test-screenshots/transport-reconnect-*`。

#### 实机性能验收（推荐，UI 热路径或 Electron 运行时改动后执行）

```bash
npm run test:perf:production
```

该脚本先构建并启动真实 Windows packaged Electron 窗口，通过 CDP 严格确认 renderer 来自 `127.0.0.1:<port>/index.html`，再验收：打字不重建 `threadsById`、1500ms 草稿防抖、流式期间输入响应、终端输出 50ms 合并、keep-alive 视图实例保留，以及进程树和临时 profile 清理。切换耗时只记录稳定样本，不再错误地要求“返回一定快于首次挂载”。截图与 JSON 报告写入 `gui-test-screenshots/perf-*`。

Bundle 预算单独执行：

```bash
npm run build:dir
npm run test:bundle-budget
```

预算报告写入 `out/bundle-budget-report.json`，用于阻止入口、编辑器或终端 chunk 无意增长。

`test:bundle-budget` 同时检查绝对预算（每个 chunk 的 maxBytes）和已提交历史基线 `scripts/test/bundle-baseline.json` 的增长率（raw >10% 且 >50KB，gzip >10% 且 >10KB 才失败，按 label 比较、不比较文件名 hash）。**普通检查永远不会自动更新基线**；只有显式执行下面命令（需人工审查 diff）才会更新：

```bash
npm run test:bundle-budget:update
```

### 实机内存 / DOM / listener soak

```bash
npm run build:dir
npm run test:perf:probe          # 首次或升级 Electron 后探测 CDP 指标可用性 → out/perf-capability-probe.json
node scripts/test/perf-memory.cjs --collect-baseline   # 首轮只采集，写入 scripts/test/perf-memory-baseline.json
npm run test:perf:memory         # 正式门禁：按基线判定 slope / retained / DOM / listener
```

soak 启动真实 packaged 窗口并加载 300 条 transcript fixture，强制 GC 后采样 `Runtime.getHeapUsage` 与 `Memory.getDOMCounters`，核心 4 路由（chat/terminal/editor/settings）切换 10 轮，按以下规则判定（阈值见 `perf-memory.cjs` 的 `RULES`）：

- heap slope ≤ 1 MiB/轮；
- 全路由访问 + GC 后 retained heap 增量 ≤ 80 MiB（相对已提交基线）；
- DOM nodes ≤ 基线 × 1.25；
- jsEventListeners 末轮 − 首轮 ≤ 100，且不得出现连续 3 轮单调增长。

报告写入 `out/perf-memory-report.json`。任何不支持的内存指标都会阻塞门禁（记录替代采样或阻塞原因），不会静默跳过。

## 发布门禁

发布或跨 Electron 运行时变更执行：

```bash
npm run test:release
```

当前 `test:release` 等价于：

```bash
npm run test:gate
npm run test:bundle-budget
npm run test:e2e
npm run test:packaged
npm run test:perf:production
npm run test:perf:memory
```

其中：

- `test:gate` = lint + `git diff --check` + 全量单测（含 perf fixtures/report/timeline-path/bundle-budget/perf-memory 单测）+ mobile-remote 单测。
- `test:e2e` 先构建 renderer，再执行 unpackaged Electron launch / renderer 场景。
- `test:packaged` 先执行 `build:dir`，再执行 packaged-style Electron 场景。
- `test:perf:production` 先执行 `build:dir`，再运行 packaged 实机性能门禁（300-entry 首次可交互、真实按键输入、流式输入、long-task 预算、路由返回、草稿防抖、终端批处理、进程清理），报告 `out/perf-report.json` + `gui-test-screenshots/perf-*`。
- `test:perf:memory` 运行 packaged 内存/DOM/listener soak（需要 `scripts/test/perf-memory-baseline.json` 已提交；缺失时先按上文 collect-baseline 流程建立并人工审查）。
- 任一 gate 失败都返回非零并保留 JSON 报告路径；release 脚本不会自动刷新基线、删除失败证据或覆盖已有报告。
- packaged-style 测试通过后，仍需按发布需求执行 `npm run release:prepare`，检查安装包、签名、`latest.yml` 和 `SHA256SUMS.txt`。

门禁分层：

- 快速开发检查：`npm test` / `npm run test:gate`（不启动 Electron soak，保持反馈速度）。
- 普通 CI gate：`test:gate` + `test:bundle-budget` + `test:e2e`。
- packaged 发布门禁：`test:release`（含性能与内存 soak，固定 fixture/profile/窗口，预计运行 10-20 分钟）。
- 基线更新流程：bundle / memory baseline 都只能显式更新并人工审查 diff。
- Windows Job / AV 文件锁软失败：见下文「当前环境限制与处理原则」。

## 当前环境限制与处理原则

Windows 本地验证可能遇到以下环境问题：

- `tests/unit/e2e-harness.test.js` 或 E2E driver 报 `Windows Job supervisor exited before ownership was established (exit=2, win32=5)`：这是 Job / 权限环境阻塞。记录为门禁未完整通过，先在有足够权限的干净环境重跑；不能把它改写成测试通过。
- Electron Builder 删除或覆盖 `dist/win-unpacked/CodeBuddy Desktop.exe` 报 `Access is denied`：通常是已有 Electron 进程或系统锁持有产物。记录为打包阻塞；不要为了通过门禁强制关闭用户进程或重启应用。确认锁解除后再重跑 `npm run build:dir` / `npm run test:packaged`。

如果 `test:gate`、`build:dir`、unpackaged E2E 或 packaged E2E 中任一项因上述原因失败，提交报告必须分别列出实际命令、退出原因和未完成的门禁；只有全部命令真实成功时才能声明发布门禁通过。

- Packaged Electron harness 当前基础启动和 renderer 身份检查已通过，但导航回归项可能因历史选择器与当前导航文案不一致而失败。例如本次 `npm run test:packaged` 的实际失败是找不到名为 `实例` 的按钮（当前界面使用更新后的导航标签），不是打包产物启动失败；该项应记录为 E2E 选择器/产品文案契约待同步，不能标记为完整 packaged gate 通过。

## 交付前 Git 检查

```bash
git status --short --branch
git diff --check
git diff --stat
git diff --cached --stat
git diff --cached --check
git diff --cached
```

提交后确认：

```bash
git status --short --branch
git log -1 --oneline
git push -u origin <feature-branch>
```

推送结果、commit hash、分支、每个门禁命令的真实结果，以及任何留在工作区的文件都必须在交付报告中说明。
