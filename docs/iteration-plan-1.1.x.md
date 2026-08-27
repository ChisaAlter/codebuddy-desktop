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

### Done（第三轮：R12 CI / IPC 加固迭代）

| 条目 | 内容 | 落点 |
| --- | --- | --- |
| R12-CI (P0) | 合并/PR 门禁 CI 上线：`push`/`pull_request` 到 `master` 时在 ubuntu-latest + windows-latest 矩阵跑 `npm ci` + `npm run test:gate`；第三方 action 全部钉死到 commit SHA（供应链加固，浮动 tag 被投毒不再影响本仓库），并发去重（同 ref 新 push 取消旧跑） | `.github/workflows/ci.yml` |
| R12-IPC (P0) | IPC senderFrame 校验：`isTrustedGitSender`/`isTrustedMainSender` 增加可选第三参 `senderFrame`——null/undefined 放行（Electron 允许 frame 已销毁/跨导航时给 null）、子 frame（iframe）一律拒绝、frame 必须是 sender 自己的 mainFrame（Electron 安全清单「validate the sender frame」）；`requireTrustedMainSender` 与 git 内联校验统一传入 `event.senderFrame` | `electron/git-security.cjs`（新 `isTrustedSenderFrame`）、`electron/main.cjs`、`tests/unit/git-security.test.js` |
| R12-IPC (P0) | `ipcMain.on` 通道全量守卫：新增 `requireTrustedMainSenderOn`（布尔 + early-return，on 通道无向 renderer 抛错的信道），覆盖 rightBrowser:setBounds、window:show/minimize/maximize/close/reload/openDevTools、app:confirmQuit/acknowledgeQuit/holdQuit/resumeQuit/cancelQuit、productState:saveSync（保留 returnValue 回填）；codebuddy:closeStream 原内联校验统一改用 helper；契约测试扩展到 on 通道（含「回调首参必须是 event」与「helper 必须转发 senderFrame」两条防退化断言） | `electron/main.cjs`、`tests/unit/ipc-trusted-sender.test.js` |
| R12-VC (P1) | 版本一致性守卫收紧：RELEASE_NOTES 检查从 `includes(version)`（版本号出现在任意段落即可骗过）改为必须存在以当前版本为标题的章节行（如 `## 1.1.2（…）`） | `tests/unit/version-consistency.test.js` |
| R12-AUDIT (P2) | Expo/npm audit 治理（选 Option A）：`apps/mobile-remote` 移出根 workspaces（桌面 CI 完全不需要 Expo 树），其本地包依赖改 `file:../../packages/...` 协议、独立 `npm install`；根 lockfile 重生后再跑非破坏性 `npm audit fix`。audit 结果 42 → 14（1 critical / 10 high / 3 moderate）；剩余 14 项全部需要破坏性 major 升级（electron-builder 26、Electron 主版本、Vite/esbuild），见 Next。App 依赖树改由独立 `apps/mobile-remote/package-lock.json` 钉版（此前钉在根 lockfile） | `package.json`、`package-lock.json`、`apps/mobile-remote/package.json`（+新独立 lockfile）、`apps/mobile-remote/README.md` |
| R12-RELAY (P2) | relay 控制 socket 离线反馈：明确并钉死现有行为——客户端的离线信号是控制 socket close 处理器发出的 `close(4001 'server offline')`；半开窗口（控制 socket 已非 OPEN 但 close 未触发）内的 client 帧按设计丢弃，不注入明文通知帧（客户端把收到的文本帧一律当 E2EE 载荷解析，注入即破坏协议——如需通知需协议扩展，见 Next） | `packages/mobile-remote-relay/src/session-hub.js`（注释）、`tests/hub.test.js`（新用例） |
| — | 仓库卫生：删除已完整 merge 进 master 的陈旧远程分支 `cursor/fix-iteration-1-1-x-d363`（merge commit `e80c3f2`，PR #1） | origin |

### Next（下轮优先，按序）

| 审查 ID | 内容 | 备注 / 证据 |
| --- | --- | --- |
| R11 (P3) | 巨型模块拆分：`ReplicaChatView.jsx`（约 3.6k 行）、`sessions-chat.js`（约 3.4k 行）先抽纯函数（composer 高度、prompt 载荷构造等）+ 特性目录化 | 只做安全小步抽取，每步跑 `test:gate`；R12 轮再次明确跳过（加固优先于重构） |
| — | npm audit 剩余 14 项：electron-builder 24 → 26（app-builder-lib/builder-util-runtime/tar/extract-zip 链，破坏性 major，需 Windows 全量打包验证）；Electron 34 → 修复版（主版本升级，需全量回归）；Vite 5 → 修复版（esbuild dev-server 漏洞仅影响开发期） | 均为 devDependencies / 构建期依赖，不进安装包运行时；升级各自单独开轮验证 |
| — | mobile-remote E2EE host 临时密钥（host ephemeral keys）：目前仅客户端每连接生成临时 Curve25519，host 侧密钥长期持有；改为双向 ephemeral 是协议变更（配对载荷 + 握手帧格式都要动），需版本协商 | 协议变更，单独设计后再做 |
| — | relay 控制 socket 离线时向客户端发结构化通知帧：需要协议扩展（客户端当前把文本帧一律当 E2EE 载荷）；R12 已用 `close(4001)` + 测试钉死现状 | 与上一条 E2EE 协议演进合并考虑 |
| — | CLI 推荐版本 2.135.0 → 2.138.0 评估：需真机跑 `test:gate` + packaged E2E 验证后再 bump `electron/cli-compat.cjs` | 见下方对齐调研 |
| — | 代码签名：配置 `CSC_LINK` / `CSC_KEY_PASSWORD` repository secrets 后重跑 release workflow 即出签名版（只能由维护者在 GitHub Settings 配置，见 `docs/release-checklist.md`） | 文档已就位，等证书 |
| — | ~~发版收尾：合并 PR #1 后按 `docs/release-checklist.md` 走 tag → Actions draft → 人工 publish~~ **已发布（2026-08-25）**：PR #1 merge 进 master（merge commit `e80c3f2`）→ bump 1.1.2 → tag `v1.1.2`（commit `cdbec27`）→ `release` workflow 全绿 → [Release v1.1.2 已 publish](https://github.com/ChisaAlter/codebuddy-desktop/releases/tag/v1.1.2)（未签名预览安装包，SHA256SUMS 与 Release 资产 digest 一致）。`v1.1.0`/`v1.1.1` 旧 tag 保留不动（指向不含 R1–R10 的旧提交，未发布 Release）。发版途中修复两个 CI 问题：e2e-harness 测试对 8.3 短路径的断言、release workflow 空 `CSC_LINK` env 导致 electron-builder 误判有证书 | `docs/release-checklist.md` |

### 明确不做（Out of scope）

- 不虚构/发布 GitHub Release。发布动作本身留给维护者：Windows 管线在 `release` workflow（tag push → windows-latest → draft Release），publish 仍需人工审核点按，见 `docs/release-checklist.md`。
- ~~不改 `ipcMain.on` 窗口控制通道（minimize/maximize/close 等）的 sender 校验——无返回值、无敏感数据，收益低；如后续统一再做~~ **R12 已统一**：全部 `ipcMain.on` 通道走 `requireTrustedMainSenderOn`，契约测试防回归。
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

### 第三轮（R12 CI / IPC 加固，2026-08-27）

- `npm run test:gate`（Linux，Expo 移出 workspaces 后的重生 lockfile）：见 PR 描述的最新运行结果。
- 新增/收紧测试：git-security senderFrame 7 个新用例；ipc-trusted-sender 契约扩展到 `ipcMain.on`（4 个新断言组）；version-consistency RELEASE_NOTES 标题行匹配；relay hub 控制 socket 离线用例。
- `npm audit`：42（1 low/7 moderate/33 high/1 critical）→ 14（3 moderate/10 high/1 critical）；剩余全部需破坏性 major 升级（见 Next）。
- 未跑（需 Windows / 构建产物）：同第二轮 —— windows-latest 侧由本轮新增的 `ci` workflow 在每次 PR/push 上补跑 `test:gate`。
