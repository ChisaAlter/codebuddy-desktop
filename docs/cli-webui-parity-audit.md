# CLI WebUI ↔ Desktop 功能对齐审计（CLI 2.138.0）

> 审计日期：2026-08-27。
> 参照源：`@tencent-ai/codebuddy-code@2.138.0` npm 包（`npm pack` 解包，检查 `dist/web-ui/` bundle、`dist/web-ui/docs/`、包根 `CHANGELOG.md`）。
> Desktop 侧：master（1.1.2，推荐 CLI 2.135.0）+ PR #3 草稿分支 `cursor/release-1-1-3-r13-2173`（1.1.3，推荐 CLI 2.138.0）。
> 性质：**只读分析**，不实现功能。结论供维护者排期。

## 1. 对照方法

- WebUI bundle 经 `js-beautify` 美化后静态提取：视图集合（`Kx` Set）、侧栏分组（`sidebar.group.*` 与导航按钮接线）、命令面板视图表（`t4`）、设置 schema（SettingsView chunk 的分组数组）、全部 i18n key（约 500 个前缀分组）、HTTP/WS API 字面量。
- Desktop 侧对照 `src/lib/routes.js`、`src/lib/codebuddy-schema.js`、`src/components/Replica*.jsx`、`src/lib/*.js` 的 API 调用面、`electron/main.cjs`/`preload.cjs` IPC 面，以及 `CODEBUDDY.md` / `RELEASE_NOTES.md` / `docs/iteration-plan-1.1.x.md` 声明的有意差异。
- 分类口径：**缺失**（WebUI 有、Desktop 无）/ **部分**（实现不同或不完整）/ **有意跳过**（有文档记录）/ **Desktop 独有** / **传输差异**（UX 等价、实现不同）。

## 2. WebUI 2.138.0 结构快照

### 2.1 视图 / 路由（bundle `Kx` 集合，18 项）

`chat`、`tasks`、`plugins`、`terminal`、`canvas`、`canvas-pane`（Canvas 磁贴独立窗）、`remote-control`、`settings`、`docs`、`editor`、`editor-page`（编辑器独立窗）、`changes`、`metrics`、`workers`、`logs`、`keybindings`、`stats`、`traces`。

侧栏分组：工具（tasks / canvas / editor / plugins / remote-control）、可观测（changes / workers / stats / traces / metrics / logs）、配置（settings / keybindings / docs）；chat 与 terminal 为主区；侧栏页脚含工作区 / 运行信息组（cwd、版本、模型、权限模式、tunnel URL、gateway 模式等）。

### 2.2 设置 schema（8 组 / 22 键）

相对 Desktop 钉住的 2.124 版 `Mk`（6 组 / 18 键），2.138 **新增 1 组 4 键**：

| 新增键 | 组 | 引入版本 | 说明 |
| --- | --- | --- | --- |
| `autoCompactWindow` | behavior | 2.136 | 自动压缩窗口基准值（token），配套 `--autocompact` / `/autocompact` |
| `codebuddy.composer.busySendMode` | behavior | 2.138 | 忙碌时新消息「排队」或「立即插入当前回合」（默认 queue） |
| `codebuddy.mainAgent.enabled` | mainAgent（新组「Agent 预设」） | 2.13x | 主 Agent 开关（默认开） |
| `codebuddy.mainAgent.allowUnopted` | mainAgent | 2.13x | 允许未 opt-in 的 Agent（默认关） |

### 2.3 WebUI 使用而 Desktop 未调用的 API

`/api/v1/agent-home`（Agent Home 频道/房间）、`/api/v1/goal` + `/goal/pause|resume|clear`（目标条 REST）、`/api/v1/jobs`（后台 shell 任务派发）、`/api/v1/runtime-defaults`、`/api/v1/agents/create-by-ai|open|delete`（后台智能体工作台）、`/api/v1/auth/account/login|logout|status`（WebUI 账号态）、`/api/v1/settings/codebuddy`、`/api/v1/settings/permissions`。

其余端点（acp / pty / fs / files / search-content / workspace-dirs / settings / sessions / workers / scheduled-tasks / stats(+session) / metrics / traces / channels wechat+wecom / keybindings(+validate/reset) / daemon / plugins 全家桶 / internal/mcp / internal/file-changes / models/custom）Desktop 均已覆盖，且部分超出 WebUI（如 plugins/update、marketplaces auto-update、keybindings/validate）。

## 3. 已对齐功能（摘要）

- **聊天 / Composer**：流式、Stop 本地先行取消、模型 / 模式 / 思考强度乐观切换、`ultracode` 复合模式、图片 / 文件附件（选择器 + 剪贴板贴图 + 拖放）、附加工作目录（workspace-dirs，CLI 2.121+）、斜杠命令建议、提示建议（promptSuggestion）、上下文用量环形指示器（对齐 2.128 五分类 + 一键压缩）、欢迎页建议标签、忙碌排队（自管 promptQueue，含队列编辑）。
- **AskUserQuestion**（2.125 中断语义：取消仅 `{outcome:'cancelled'}`）、**文件检查点回退**（`/internal/file-changes/*`）、权限请求交互。
- **会话**：多项目 × 多线程、独立 runtime 端口 / token、session 恢复、置顶 / 重命名 / 归档。
- **工作流 / Goal 展示**：右侧工作流面板、团队 / 子代理、Goal 进度归一化 + timeline 恢复（展示链路完整；缺 REST 控制面见下表）。
- **终端**：项目级多面板 PTY（传输差异：Electron 下主进程 SSE 代理 + Bearer，WebUI 为 WS query-token；已在迭代计划记录为有意保留）。
- **编辑器 / 文件**：Monaco（本地打包）、文件树、文件名与内容搜索、增删移动、上传下载、watcher。
- **Git / 变更**：Changes 视图 + git 全命令（Desktop 经主进程 `git:run`，WebUI 依赖 CLI 接口——实现更强）。
- **插件**：安装 / 卸载 / 启停 / 市场浏览 / marketplace 增删 + 自动更新；**MCP**：user/project/local JSONC + internal/mcp 真接口。
- **Tasks（定时任务）**、**Stats / Traces / Metrics / Logs / Workers（含 daemon start/stop/restart + 系统服务安装，超出 WebUI）**、**Docs**（ACP /docs/*）、**Keybindings**（CLI 运行时绑定 + GUI 本地快捷键）、**远程控制**（微信 / 企微 channel + 扫码，另有 Desktop 独有 mobile-remote）。
- **设置**：2.124 Mk 18 键全量 + GUI 专属外观组 + 自定义模型管理（含 custom-only 白名单自愈，超出 WebUI）。

## 4. 缺失 / 差异清单

| # | 功能 | WebUI 位置 | Desktop 状态 | 分类 | 优先级 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| G1 | 设置新键 ×4（autoCompactWindow / busySendMode / mainAgent.enabled / mainAgent.allowUnopted） | settings（behavior + 新组 mainAgent） | 缺（schema 钉在 2.124 的 18 键） | 缺失 | **P1** | 写入通道（PUT /settings/{rootKey}）已通；只需扩 `codebuddy-schema.js` + 渲染 |
| G2 | 目标条（Goal Bar）：设置进行中目标、暂停 / 恢复 / 清除 / 编辑、达成 recap 卡片 | chat 顶部 goal bar；REST `/api/v1/goal(/pause|resume|clear)` | 部分：`/goal` 斜杠 + 右侧面板展示进度；无 REST 控制、无暂停/恢复 | 部分 | **P1** | 2.138 新特性「进行中目标 + 暂停后续跑」 |
| G3 | 忙碌时「立即插入当前回合」（busySendMode=immediate） | composer（排队条目也可点立即发送） | 部分：仅自管队列（queue 语义），无 immediate 注入 | 部分 | **P1** | 与 G1 的 busySendMode 键联动；CLI 2.138 修复了上层自管队列的丢失问题，Desktop 现状安全 |
| G4 | 后台智能体工作台：新建 Agent（类型 / 模型 / 强度 / 权限模式 / 目录 / **worktree 开关** / **startFrom 空白·继续·历史会话** / 附件与 shell 任务派发）、AI 代建（create-by-ai）、pin / restart / 新窗打开 | agents 列表 + `agents.input.*`；`/api/v1/agents/*`、`/api/v1/jobs` | 部分：Desktop 以「多项目 × 多线程 + instances / background-sessions 视图」承载并发会话；无 worktree、startFrom、shell job、per-agent 权限模式 | 部分（架构性） | **P2** | Desktop 的项目模型是有意设计（CODEBUDDY.md 多项目章节）；worktree / startFrom 是可移植的增量能力 |
| G5 | Agent Home：频道 / 房间 / 分区、成员管理、@提及、短 ID | chat 主区（`agentHome.*` 约 100 键）；`/api/v1/agent-home`、`/api/v1/channels` | 缺 | 缺失 | **P2** | 2.138 主打特性（频道与房间专属表面）；依赖主 Agent 常驻形态，与 Desktop 每项目 runtime 模型有张力，需先做形态设计 |
| G6 | MCP Apps 交互式界面（`ui://` 资源、sandbox_proxy iframe 池，inline / fullscreen / pip） | 聊天工具卡片「点击加载交互式界面」 | 缺 | 缺失 | **P2** | Desktop 安全边界禁止主 renderer iframe（CODEBUDDY.md）；需隔离 Electron view 方案，不是简单移植 |
| G7 | 回合耗时展示（`✔ Worked for …`、showTurnDuration、后台任务独立耗时） | chat 回合尾部 | 缺 | 缺失 | P2 | 2.138 新增；纯展示，事件里已有时间戳可推导 |
| G8 | 命令面板（⌘/Ctrl+Shift+H：视图 + 动作 + 斜杠命令，含主题 / 语言切换） | 全局 | 缺（有 GUI 快捷键表但无面板） | 缺失 | P2 | Desktop keybindings 页已管理 CLI palette 上下文，仅缺 GUI 面板本体 |
| G9 | 会话历史浏览器（按项目分组、restore / rename / delete、后台会话入口） | history 面板（`history.*` 29 键） | 部分：归档视图 + 项目会话树覆盖自有线程；无「浏览 CLI 全量历史并恢复为新会话」 | 部分 | P2 | Desktop 决策不做右侧历史抽屉（见 §6-1 文档缺失问题） |
| G10 | Canvas 终端磁贴画布（加终端磁贴、缩放 / 平铺 / 最大化、canvas-pane 独立窗） | canvas / canvas-pane 视图 | 有意跳过：1.1.1 以「无真实后端能力」移除 | 有意跳过（依据已过时） | P3 | 2.138 的 Canvas 是真实 PTY 磁贴画布（canvas-store 含 tiles/viewport/terminal）；移除依据需重评。Desktop 多面板终端已覆盖基础场景 |
| G11 | 编辑器多标签（pin / 关闭其他 / 左右滚动）、Quick Open 模糊打开、「加入对话」（addToChat）、markdown / 图片 / PDF / SVG / 二进制预览、新窗打开（editor-page） | editor 视图（`editor.*` 74 键） | 部分：单文件 Monaco + 文件树 + 搜索 + 文件操作 | 部分 | P3 | addToChat 与 md/图片预览对日常体验增益最大 |
| G12 | `/autocompact` 面板配置与展示 | settings + `/config` | 缺（随 G1 的 autoCompactWindow 键） | 缺失 | P3 | 斜杠命令本身经 CLI 透传可用 |
| G13 | REPL 代码执行模式开关（`CODEBUDDY_REPL_ENABLED`） | 无独立 UI（env 开关，默认关） | 缺专属 UI；可经 settings `env` 键配置 | 部分 | P3 | 2.138 新特性；工具调用渲染走通用链路即可 |
| G14 | WebUI 密码鉴权 UI（`/api/v1/auth/login` 密码表单）、PWA（manifest / service worker） | 登录页 / 浏览器安装 | 不适用：Desktop 走本机 runtime token + 账号 OAuth | 不适用 | — | `auth/status` / `auth/login` 通道 Desktop 已实现（acp.js） |

### Desktop 独有（WebUI 无，非缺陷）

多项目管理与项目级独立 runtime、Instances / Background-Sessions 视图、MCP 配置页、Skills 页、Agents（子代理定义）页、Sandboxes 页、Models 页（含 custom-only 白名单自愈）、Monitor 页、Archived 视图、mobile-remote（E2EE relay + Expo App）、CLI 版本探测 / 一键安装 / 回滚、工作区信任模型、窗口状态 / 托盘 / 桌面通知、应用内更新、Windows 安装包。

### 传输差异（UX 等价，保留）

PTY：Electron 主进程 SSE 代理 + Bearer header vs WebUI WS query-token（迭代计划已记录）；ACP 事件流经 `codebuddy:openStream` IPC 代理 vs WebUI 浏览器直连；Git 走主进程真 git 而非 CLI HTTP。

## 5. CLI 2.133–2.138 增量（对 Desktop 的影响）

| 版本 | 特性 | Desktop 影响 |
| --- | --- | --- |
| 2.136 | `autoCompactWindow` 设置 / `--autocompact` / `/autocompact` | G1 / G12 |
| 2.136 | stream-json result 带 modelUsage / 上下文分类细拆 | Desktop 走 ACP 流，上下文环已对齐 2.128 形态；无需改 |
| 2.137 | `--brief` + `SendUserMessage` 工具、`CODEBUDDY_CUSTOM_HEADERS` | headless/SDK 面，GUI 不适用 |
| 2.138 | busySendMode（排队 / 立即插入） | G1 / G3 |
| 2.138 | Web UI 目标条（设定进行中目标、暂停后续跑） | G2 |
| 2.138 | 后台智能体 iframe 池、附件 / 文件派发 | G4（Desktop 架构不同，评估增量吸收） |
| 2.138 | Agent Home 频道与房间 | G5 |
| 2.138 | 回合与后台任务耗时（showTurnDuration） | G7 |
| 2.138 | REPL 模式（env 开关） | G13 |
| 2.138 | 排队消息不再丢失（上层自管队列修复） | 利好：Desktop 自管 promptQueue 的兜底更稳，无需改动 |
| 2.138 | 专家团会话恢复保留成员状态 | Desktop 工作流面板从 runtime + timeline 恢复，需真机回归验证（不改代码） |

## 6. 审计过程中发现的问题（非功能 gap）

1. **文档断链**：`CODEBUDDY.md` 两处引用 `docs/composer-actions-decision.md`（composer 附件双档、不用加号网格 / 历史抽屉的决策依据），该文件在仓库中**不存在**。建议补回或改引 RELEASE_NOTES 对应段落。
2. **迭代计划陈述过时**：`docs/iteration-plan-1.1.x.md` 称「2.133–2.138 无公开 user-facing 说明」。实际 2.138.0 npm 包根部 `CHANGELOG.md` 含 2.133–2.138 全量中文条目（`dist/web-ui/docs` 的 release-notes 索引确实只到 v2.132.0，两处口径不同）。
3. **Canvas 移除依据过时**：1.1.1 以「无真实后端能力」移除 Canvas 占位路由（当时正确）；2.138 的 Canvas 已是真实 PTY 磁贴画布。CODEBUDDY.md「Canvas 无真实后端能力」表述应更新为「2.138 起 WebUI Canvas 为真实终端磁贴画布，Desktop 暂以多面板终端覆盖，是否补齐另行决策」。
4. **设置 schema 版本钉扎**：`src/lib/codebuddy-schema.js` 注释明确镜像「WebUI 2.124 Mk」。推荐 CLI 已提至 2.138（PR #3），schema 未同步（G1）。建议在 cli-compat bump 流程中加入「settings schema diff」检查项。
5. **npm 已发布 2.140.0**：推荐版本钉 2.138.0 是有意纪律（真机验证后才 bump），非问题；记录现状。
6. **`.gitignore` 误伤 `docs/`**：根 `.gitignore` 第 45 行（「IDE/工具本地数据」段落）忽略了整个 `docs/`，而仓库已跟踪 5 个 docs 文件（iteration-plan、release-checklist、prototypes、workflow/qa）。已跟踪文件不受影响，但**新增文档会被静默忽略**（本审计文档即需 `git add -f`）。建议把该规则改为具体工具目录或删除。

## 7. 建议路线（按优先级）

1. **P1（下一迭代）**：G1 设置 4 键补齐（低风险，纯 schema + 渲染）→ 顺带 G12；G2 目标条 REST（pause/resume/clear）+ composer goal 状态条；G3 busySendMode=immediate 支持（队列条目「立即发送」按钮 + 设置键联动）。
2. **P2（单独开轮）**：G7 回合耗时展示（小）；G8 命令面板（中）；G9 历史浏览器恢复（中，需先补 §6-1 决策文档）；G4 增量吸收 worktree / startFrom（中）；G5 Agent Home 与 G6 MCP Apps 先出形态 / 安全设计文档再排期（大，且都触碰 Desktop 的 renderer 安全边界与 runtime 形态）。
3. **P3（机会性）**：G10 Canvas 重评（先改文档口径）；G11 编辑器 addToChat + 预览；G13 REPL 开关 UI。
4. **文档修复（随下一个 PR）**：§6-1 补回 composer 决策文档、§6-2 修正迭代计划陈述、§6-3 更新 CODEBUDDY.md Canvas 表述。
