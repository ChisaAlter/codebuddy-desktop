# CodeBuddy Desktop 1.1.x 修复/优化迭代计划

> 依据 2026-08 全量代码审查结论 + 最新 CodeBuddy CLI / WebUI 对齐调研制定。
> 本文件随迭代滚动更新；条目编号沿用审查报告（R1–R11）。

## 本轮目标

1. 关闭仓库更名（codebuddy-gui → codebuddy-desktop）引入的应用内更新断链（P0）。
2. 消除版本/文档漂移，并加护栏防复发（P1）。
3. 修复 PTY SSE 空闲 30s 误杀，静默终端不再丢输出（P0）。
4. 让 `npm test` / `test:gate` 在 Linux（无构建产物）可跑通，为跨平台 CI 铺路（P1）。
5. 顺手关闭低风险 P2：`codebuddy:request` sender-abort 断线、IPC 信任边界统一。

## 待办总表（Done / Doing / Next）

### Done（本轮 PR 已实现）

| 审查 ID | 内容 | 落点 |
| --- | --- | --- |
| R1 (P0) | 更新下载白名单接受 `codebuddy-desktop`（保留 `codebuddy-gui` 兼容 GitHub 301 与历史资产地址）；白名单逻辑抽为 `electron/update-urls.cjs` 并补单测。**额外发现并修复**：原 `trustedGuiDownloadUrl` 在正则不匹配时 `match?.[1] === match?.[2]` 为 `undefined === undefined`（true），会放行任意无凭据/查询串的 github.com 地址 | `electron/update-urls.cjs`、`electron/main.cjs`、`src/components/ReplicaSettingsView.jsx`、`tests/unit/update-urls.test.js` |
| R2 (P1) | README「当前版本」1.1.0 → 1.1.1（tag `v1.1.1` 已存在于 origin，不虚构 Release）；package-lock version 字段同步 1.1.1；新增版本一致性守卫测试（README / lockfile / RELEASE_NOTES 必须跟随 package.json） | `README.md`、`package-lock.json`、`tests/unit/version-consistency.test.js` |
| R3 (P0) | PTY SSE 输出流补 `timeoutMs: 0`（与 `acp.js` ACP 通知流一致），静默终端不再被主进程默认 30s chunk 空闲超时误杀；真实断线仍走 `onEnd(ok:false)`/`onError` 重连路径；补请求形状单测 | `src/lib/pty.js`、`tests/unit/pty.test.js` |
| R4 (P1) | `codebuddy-cli-path` Windows 形状用例改 `it.runIf(win32)`（原先部分用例在 Linux 直接失败、部分用 early-return 假通过）；`perf-fixtures` 构建产物断言默认跳过、`CODEBUDDY_REQUIRE_BUILD=1` 时强制执行 | `tests/unit/codebuddy-cli-path.test.js`、`tests/unit/perf-fixtures.test.js` |
| R5 (P2) | `createTimeoutSignal` 暴露 `controller`，`codebuddy:request` 的 renderer 销毁中断由静默 no-op 变为真实 abort；stream contract 测试钉死接线 | `electron/main.cjs`、`tests/unit/main-process-stream-contract.test.js` |
| R6 (P2) | 所有 `ipcMain.handle` 通道统一 `requireTrustedMainSender`（此前 `runtime:list`、`app:openExternal`、`app:checkForUpdates`、`workspace:choose` 等约 21 个通道未校验 sender）；新增源码契约测试防回归 | `electron/main.cjs`、`tests/unit/ipc-trusted-sender.test.js` |
| R7 (P2) | bridge `session/prompt` 改发 ACP 内容块数组 `[{ type:'text', text }]`（与桌面端 `sessions-chat.js` 同形）；完成判定改为 JSON-RPC 响应（匹配 `id` 的 `result`/`error`）+ `result.stopReason`，`result.done` 仅作旧版兜底；`prompt_done` 现携带 `stopReason` 且只发一次；流自然结束无响应帧时补发 `stopReason:'stream_end'` 终止事件 | `electron/mobile-remote/bridge.cjs`、`electron/mobile-remote/tests/bridge.test.cjs`（5 个新用例含契约形状） |
| R8 (P2) | prompt 流 120s wall-clock（`tMax`）改为主进程 openStream 同款 per-chunk 空闲窗口（每次 read 前重新 arm；`timeoutMs: 0` 关闭）；长工具运行只要持续出帧就不再被截断；新增 idle-vs-wall-clock 两个用例（持续出帧超总时长存活 / 静默超窗中止） | `electron/mobile-remote/bridge.cjs`（`PROMPT_IDLE_TIMEOUT_MS`、`armIdleTimeout`、测试钩子 `deps.promptIdleTimeoutMs`） |
| R9 (P2) | relay pending 帧补字节上限 `MAX_PENDING_BYTES_PER_CLIENT = 1 MiB`（条数上限之外，超限丢最旧；单帧超预算直接丢弃不清空队列）；data-socket 关闭后 client 帧改回缓冲（`#attachClientBuffering`），新 data-socket attach 时 flush，不再静默丢帧；陈旧 data-socket 的 close 不会拆掉替换后的接线（`clientState.dataWs` 归属校验）；4 个新中继用例 | `packages/mobile-remote-relay/src/session-hub.js`、`tests/hub.test.js` |
| R10 (P2) | Lint 收紧落地：`no-undef` 打开、`no-unused-vars`/`no-empty`/`no-irregular-whitespace` warn → error；`no-undef` 抓到 1 个真实缺陷（`plugins-list.test.js` 用 `vi` 未 import）已修；全量 `npm run lint` 零告警 | `eslint.config.js`、`tests/unit/plugins-list.test.js` |
| — | 发版自动化：新增 `release` workflow（v* tag push / workflow_dispatch 指定既有 tag → windows-latest → `test:gate` → `prepare-release.ps1` → **draft** Release 附 exe/blockmap/latest.yml/SHA256SUMS）；无 `CSC_LINK` secrets 时自动 `-AllowUnsigned` 出未签名预览；维护者手册见 `docs/release-checklist.md` | `.github/workflows/release.yml`、`docs/release-checklist.md` |

### Next（下轮优先，按序）

| 审查 ID | 内容 | 备注 / 证据 |
| --- | --- | --- |
| R11 (P3) | 巨型模块拆分：`ReplicaChatView.jsx`（约 3.6k 行）、`sessions-chat.js`（约 3.4k 行）先抽纯函数（composer 高度、prompt 载荷构造等）+ 特性目录化 | 只做安全小步抽取，每步跑 `test:gate`；本轮明确跳过（发版优先于重构） |
| — | CLI 推荐版本 2.135.0 → 2.138.0 评估：需真机跑 `test:gate` + packaged E2E 验证后再 bump `electron/cli-compat.cjs` | 见下方对齐调研 |
| — | 发版收尾：合并 PR #1 后按 `docs/release-checklist.md` 走 tag → Actions draft → 人工 publish（v1.1.1 tag 已存在但指向不含本轮修复的旧提交，推荐直接出 1.1.2，见清单「当前状态提示」） | `docs/release-checklist.md` |

### 明确不做（Out of scope）

- 不虚构/发布 GitHub Release（最新已发布 Release 仍是 v1.0.5）。发布动作本身留给维护者：本轮已把 Windows 管线搬进 `release` workflow（tag push → windows-latest → draft Release），publish 仍需人工审核点按，见 `docs/release-checklist.md`。
- 不改 `ipcMain.on` 窗口控制通道（minimize/maximize/close 等）的 sender 校验——无返回值、无敏感数据，收益低；如后续统一再做。
- 不盲目 bump CLI 最低/推荐版本：`cli-compat.cjs` 的 `newer` 状态本来就只警告不阻断，2.136–2.138 用户不受影响。
- 不重写 PTY 传输层（WS query-token vs header 等 WebUI 行为差异见下节，当前实现已对照源 bundle）。

## CLI / WebUI 对齐调研（2026-08-25）

- **npm 最新稳定版**：`@tencent-ai/codebuddy-code` **2.138.0**（2026-08-24 发布）；2.135.0 之后还有 2.136.0 / 2.137.0 / 2.137.1。仓库当前最低 2.125.0、推荐 2.135.0（`electron/cli-compat.cjs`）。
- **CLI 自带文档滞后**：2.138.0 包内 `dist/web-ui/docs` 的 release-notes 索引只到 v2.132.0（2026-08-02），2.133–2.138 无公开 user-facing 说明；bump 推荐版本前需真机验证（`test:gate` + packaged E2E + 手动会话/工作流/PTY 冒烟），不能仅凭版本号。
- **WebUI 参照源**：CLI npm 包内嵌 `dist/web-ui/`（即 `src/lib/pty.js` 注释所称“对照源 bundle”）。已对齐项：
  - PTY WS 路由 `…/pty/{id}/ws?token=`（query token 鉴权）与 HTTP 输入 `POST …/input/send`；桌面端 Electron 下改走主进程 SSE 代理 + Bearer header，本轮补齐 `timeoutMs: 0` 后行为与 WebUI 常驻输出流一致。
  - AskUserQuestion 取消 / 跳过仅 `{ outcome: 'cancelled' }`，不整轮 `session/cancel`（CLI 2.125 中断语义）。
  - Changes 面板走 CLI 2.125 `/internal/file-changes/*`；额外工作目录走 `workspace-dirs`（CLI 2.121+）。
- **仍存差异（记录，暂不动）**：
  - 桌面端 PTY 在 Electron 下用 SSE 代理而非 WebUI 的 WS 直连——功能等价，且规避 renderer 直连本地端口；保留。
  - mobile-remote bridge 的 prompt 载荷/终止判定与桌面端、WebUI 不一致（R7/R8，下轮修）。

## 验证记录

### 第一轮（R1–R6）

- `npx vitest run`：126 files passed，1041 passed / 18 skipped / 0 failed（Linux，无构建产物）。
- `npm run test:mobile-remote`：全部通过（protocol / crypto / relay / bridge node:test）。
- `npm run lint`：零告警。

### 第二轮（R7–R10 + 发版自动化，2026-08-25）

- `npm run test:gate`（= lint + git diff --check + vitest + mobile-remote）：见 PR 描述的最新运行结果。
- bridge node:test：17 passed（新增 5：内容块形状 / 响应帧单次完成 / legacy done 兜底 / idle 窗口存活 / idle 超窗中止）。
- relay node:test：新增 4（字节上限逐旧驱逐 / 超大单帧丢弃 / data-socket 断开重缓冲 / 陈旧 close 不拆新接线）。
- `npm run lint`：规则收紧（no-undef on、warn→error）后零告警。
- 未跑（需 Windows / 构建产物）：`test:e2e*`、`test:packaged`、`test:perf:*`、`CODEBUDDY_REQUIRE_BUILD=1` 构建断言 —— 由 `release` workflow 在 windows-latest 上补 `test:gate` + 完整构建。
