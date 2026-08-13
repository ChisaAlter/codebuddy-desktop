# CODEBUDDY.md

This file describes the current CodeBuddy GUI product architecture and the conventions to follow when changing it.

## 项目定位

CodeBuddy GUI 是 CodeBuddy CLI 的本地 Electron 桌面客户端。产品目标是让用户在一个桌面应用中管理多个代码项目、多个独立对话、文件、Git 和终端，而不是加载远程网页或保留只有外观的占位页面。

产品行为以当前安装的 CodeBuddy CLI 能力为准。后端不支持的操作应显示真实的不可用或错误状态，不能模拟成功。

GUI 在 `electron/cli-compat.cjs` 中声明最低/推荐 CLI 版本（当前均为 `2.125.0`）。`runtime:ensure` / `runtime:restart` 会在启动前探测版本：低于最低版本、缺失或无法识别时硬阻断，并引导用户在设置页安装推荐版本。高于推荐版本仅警告，不阻断。

## 常用命令

开发模式需要两个终端：

```bash
npm run dev
npm run dev:electron
```

生产构建和 Windows 安装包：

```bash
npm run build
```

只生成 unpacked 应用目录：

```bash
npm run build:dir
```

静态检查和格式化：

```bash
npm run lint
npm run lint:fix
npm run format
```

## 技术栈

- 渲染层：React 18、Vite 5、Zustand、Tailwind、Monaco Editor、xterm.js。
- Electron 主进程：CommonJS 文件 `electron/main.cjs`、`electron/preload.cjs`。
- 产品状态：`src/lib/product-state.js` 定义数据模型，`electron/product-state.cjs` 在 Electron `userData` 下原子读写。
- CodeBuddy 运行时：`electron/codebuddy-runtime-manager.cjs` 按项目 ID 管理独立的 `codebuddy --serve` 进程。

## 启动流程

1. `App.jsx` 调用 `store.bootstrap()`。
2. `hydrateProductState()` 恢复项目、对话、活动选择和持久化终端状态。
3. `ensureProjectRuntime(projectId)` 为活动项目启动或复用独立 CodeBuddy 运行时。
4. 渲染层将活动项目的真实端口写入 `src/lib/acp.js`。
5. 完成运行时认证后，`ConversationManager` 连接或恢复活动对话。
6. 文件树和次级数据在项目运行时就绪后加载。

开发模式加载 `http://localhost:5173`，生产模式加载 `out/dist/index.html`。Vite 的 `base: './'` 是 Electron `file://` 生产加载所必需的。

## 多项目与多对话

`src/store.js` 是产品状态协调中心，但项目和对话不是单一全局记录：

- `projectsById` 和 `projectOrder` 保存项目。
- `threadsById` 和 `threadOrderByProject` 保存项目下的对话。
- 每个项目拥有独立运行时端口、进程状态、终端状态和工作目录。
- 每个对话拥有独立 session ID、timeline、草稿、模型、模式、队列、附件、未读和连接状态。
- `src/lib/conversation-manager.js` 按 thread ID 保持 ACP 客户端，切换页面或项目不会主动中断后台对话。

跨项目操作必须携带明确的项目或工作目录上下文。不能重新引入一个全局 CodeBuddy 进程、一个全局会话或固定端口假设。

## 聊天输入栏（Composer）

主实现：`src/components/ReplicaChatView.jsx`（`ChatComposer`）与 `src/store/slices/sessions-chat.js`。

- **模式 / 模型 / 思考强度**：`setMode` / `setModel` / `setThoughtLevel` 采用 **乐观更新**——先写 runtime/store 再发 RPC；失败回滚。model/mode 的 `updateThreadRecord` 持久化不阻塞 UI。
- **UI**：`FlipLabel` 负责选中值翻转入场；`ComposerAnimatedMenu` 负责下拉进出动画。切换时不要再加整栏 `busy` 禁用。
- **布局**：模型与思考强度放在 `composer-picker-cluster` 中贴近排列，与发送键用 `ml-4` 拉开；窄窗依赖 `truncate` + `min-w-0`，发送键 `shrink-0`。
- **发送 / 停止**：对齐 WebUI——圆形 `ArrowUp` 发送、圆形 `Square` 停止（`lucide-react`）。用户点击 Stop 时必须先同步完成本地流关闭、运行态清理和 `cancelled` 终态；后端 `session/cancel` 仅作为异步 best-effort 通知，确认失败不能把正常取消变成发送失败或红色错误。取消后的迟到事件不得把线程重新改回 `running`、`idle` 或 `error`。
- **AI 消息渲染**：assistant Markdown 必须使用 `skipHtml`，不得执行原始 HTML；链接只允许无凭据的绝对 HTTP(S)，不得让主 renderer 承载网页导航。超长或异常消息应按单条消息降级，不得卸载整个应用。受控图片只允许安全 HTTP(S) 或白名单 `data:image/*`。
- **右侧面板**：文件、浏览器和工作流面板默认关闭，属于运行时 UI 状态，不写入项目或会话持久化。内置浏览器使用隔离的 Electron view，不能在主 renderer 中使用 iframe 承载外部网页；文件面板必须复用当前项目的真实文件状态和操作。
- **思考强度**：`ultracode` 是保留的复合模式名称，中文和英文均显示原始小写字符串；切换仍通过现有 `/effort ultracode` 行为完成，不把它作为普通服务端 `thought_level` 发送。
- **附件**：回形针菜单仅 **图片 / 文件** 两档；主进程 `attachment:choose` 按 `kind` 过滤。不做 WebUI 加号网格 / 右侧历史抽屉（见 `docs/composer-actions-decision.md`）。
- **附加工作目录**（CLI 2.121+）：composer 旁文件夹按钮管理 `workspaceExtraDirs`（项目 `preferences` 持久化），经 `POST/DELETE /api/v1/workspace-dirs` 与 `PUT .../sync` 同步到运行时。
- **插件更新**：优先 `POST /api/v1/plugins/update`，失败回落 `pluginMaintenance:update` CLI；市场支持 `autoUpdate`。
- **Agent 文件检查点回退**：变更页调用 `/internal/file-changes/*`；AskUserQuestion 取消仅 `{ outcome: 'cancelled' }`，不得整轮 `session/cancel`。
- **品牌图标**：`build/icon.png` + `build/icon.ico`（窗口、托盘、通知、登录、侧栏、安装包）；`tests/unit/branding-icons.test.js` 用 SHA256 锁定。

## 持久化

Electron 产品状态保存以下核心数据：

- 项目和排序、活动项目。
- 对话和排序、活动对话、草稿、timeline 与恢复元数据。
- 项目级终端面板、输出、布局和活动面板。
- 项目偏好和运行恢复所需状态。

应用重启后 PTY 进程本身不会复用；已有输出和布局会恢复，进入终端时为项目创建新的 PTY 会话。
产品状态使用临时文件原子替换，并保留最近一次有效的 `product-state.json.bak`。主文件损坏或缺失时优先恢复备份，主备份都不可用时才回到空状态。


## 工作流、Goal 与右侧面板

工作流、团队/子代理和 `/goal` 状态使用同一条 thread runtime 链路归属。维护相关功能时遵守以下约定：

- `src/components/WorkflowRightPanel.jsx` 是工作流状态的主要展示面板；`RightPanelHost` 只负责面板类型和生命周期，不在聊天组件中复制工作流 UI。
- 右侧面板从当前 thread 的 runtime 与持久化 timeline 恢复状态。工作流 bookkeeping（checkpoint、task、Goal progress/status 等）不应重新渲染为聊天顶部的大卡片；普通消息、工具调用和权限/问题交互仍保留在聊天时间线。
- Goal 事件必须经过归一化、稳定 identity 去重和 sequence 乱序保护。runtime projection 不完整时，应从 timeline 恢复目标进度，而不是显示空状态。
- 成员消息写入对应的 `memberHistoriesByName`，不复制到 leader timeline；同一事件附带的 team、workflow、progress 或 Goal metadata 仍必须正常处理。
- 运行中的 `workflowState`/`goalState` 与终态的 `lastWorkflowState`/`lastGoalState` 分离保存，使工作流完成、失败或取消后仍能从右侧面板查看最终快照。
- 自动打开面板只针对当前活动线程本轮首次工作流活动；用户手动关闭后，同一 `runId` 不应再次自动打开。
- 工作流阶段与成员状态以 CLI workflow record / journal 为准。主进程只能使用 runtime manager 登记的真实 cwd 解析记录，并校验 sessionId/runId；不得信任渲染层传入的路径。
- prompt RPC 进入 idle 不代表后台 workflow 已结束。活动 workflow 继续轮询；workflow 终态后只在有最大时限的 drain 窗口接收 server-initiated 汇总，并锁定首个 requestId，拒绝其他请求、过期事件和显式不匹配的 promptRunId。
- 最终汇总由同一 requestId 的 `session_end` 收口。关闭 assistant 流时必须同时写入 `streaming:false` 与有效 `completedAt`，不能用固定静默时间提前截断正文。
- 提交前务必把这条链路的专项测试写进门禁文档并实际执行；不能只依赖 `npm test` 的历史通过记录来推断这次工作树也通过。

## 提交前测试门禁

仓库当前没有启用 GitHub Actions；无论本机是否配置 pre-commit/pre-push hook，提交者都必须显式执行门禁并在提交或合并说明中报告结果。

常规提交以及本次聊天、Markdown、右侧面板、工作流和 Goal 变更执行：

```bash
npm run test:gate
git diff --check
```

`test:gate` 固化以下检查：

```bash
npm run lint
git diff --check
npm test
npm run test:mobile-remote
```

涉及渲染层、Electron 或工作流面板的变更，还必须执行生产目录构建：

```bash
npm run build:dir
```

涉及 prompt idle 后仍运行的 workflow、后台汇总或 ACP requestId 归属时，还要执行 `TESTING.md` 的“后台 Workflow 汇总门禁”；其中专项 Vitest 已包含在 `test:gate`，真实 packaged 会话脚本用于验证跨进程时序和最终可见正文。

发布或跨 Electron 运行时的变更执行完整桌面门禁：

```bash
npm run test:release
```

该命令包含单元测试、unpackaged Electron E2E 和 packaged-style E2E。移动端 remote 变更另行执行 `npm run test:mobile-remote`。`npm run format` 和 `npm run lint:fix` 会修改文件，不属于只读门禁。


`src/lib/acp.js` 提供 REST、SSE 和 ACP JSON-RPC 基础能力。正常 Electron 运行时不直接依赖浏览器跨域请求：

- `codebuddy:request` 由主进程代理普通 REST 和内联 SSE 响应。
- `codebuddy:openStream`、`codebuddy:streamMessage`、`codebuddy:streamError` 和 `codebuddy:closeStream` 管理长连接流。
- 每个项目运行时使用自己的端口和认证 token。
- 每个对话使用自己的 ACP session token 和事件归属。

Timeline 归并由 `src/lib/timeline.js` 负责。流式消息、思考、工具调用、权限请求、问题、状态和使用量必须写回产生它们的 thread，不能依赖当前可见对话来判断归属。

## 自定义模型与白名单

自定义模型配置存储在 `~/.codebuddy/models.json`（可用 `CODEBUDDY_CONFIG_DIR` 覆盖），由 `electron/model-config.cjs` 管理，IPC 入口 `modelConfig:list/save/delete/open`。会话下拉的模型列表由 CLI 运行时通过 `model_update` / `config_option_update` 推送，GUI 只归一化展示，不持有内置模型目录。

**核心约定（违反会导致内置模型消失，必须遵守）：**

- 自定义模型只写 `models.json` 的 `models[]` 数组。CLI 启动/热重载时会自动把 `models[]` 合并进可选列表（运行时 id 形如 `custom-local:<id>`），**不需要也不应该写 `availableModels` 字段**。
- `availableModels` 一旦存在且只含自定义 id（custom-only），CLI 会把它当成**硬产品白名单**，丢弃所有账号/内置模型。症状：会话下拉只剩 `custom-local:*`，日志出现 `AgentModelResolver model ids: custom-local:<id>`。
- `src/lib/ops.js` 的 `saveCustomModel` 默认 `visible:false`，与官方 WebUI 一致。`visible:true` 会触发 CLI product-sync 把模型加入会话 `availableModels`，历史上曾导致 CLI 把 custom-only 白名单写回 `models.json` 并覆盖 GUI 的清理——**任何调用方不得默认传 `visible:true`**，除非有明确理由并在此处记录。当前两个保存入口（`CustomModelsModal.jsx`、`ReplicaModelsView.jsx`）都不传 `visible`。
- 保存流程顺序：`saveModelConfig`（磁盘）先于 `saveCustomModel`（runtime sync）。runtime sync **不应**触发 CLI 回写 `availableModels`；若发现 CLI 回写白名单，优先检查是否有调用方传了 `visible:true`。

**深度防御（不能替代上面的根因防线）：**

`electron/model-config.cjs` 的 `isCustomOnlyWhitelist` 判定 custom-only 白名单，`readInternalModelConfig` 在读取时自愈（静默清掉并原子写回），`saveModelConfig` / `deleteModelConfig` 同样清理。这保证 GUI 启动（`listModelConfig`）即触发自愈，CLI 下次启动读到干净文件。但这是兜底——根因防线是 `visible:false`，不能依赖自愈代替不写白名单。

## 终端

`src/lib/pty.js` 和 `ReplicaTerminalView.jsx` 提供项目级多面板终端：

- Electron 环境优先通过主进程 SSE 代理接收 PTY 输出。
- 输入通过 `POST /api/v1/pty/{id}/input/send` 发送。
- 尺寸通过 `POST /api/v1/pty/{id}/resize` 更新。
- 非 Electron 环境保留 WebSocket 连接和重连回退。
- 切换项目、页面或对话时，终端输出必须保持项目隔离。

## 文件与编辑器

`src/lib/fs.js` 封装文件列表、搜索、创建目录、移动、删除、写入、读取、上传、下载和 watcher 操作。`ReplicaWorkspaceView.jsx` 使用本地打包的 Monaco Editor，不依赖外部 CDN。

文件操作必须遵守以下约束：

- 文件请求只能更新发起请求时所属的活动项目；迟到的旧项目响应必须被忽略。
- 打开其他文件、切换目录、切换项目或删除活动项目前必须保护未保存修改。
- 页面路由切换不能清空当前编辑器内容。
- 刷新文件树不能隐式关闭当前文件。
- Git 和文件路径必须使用当前项目工作目录，不能退回进程启动目录。

## Git

`src/lib/git.js` 通过 preload 的 `runGit` 调用主进程 `git:run`。所有命令都必须显式使用当前项目 `workspacePath`。

非 Git 文件夹应显示正常的非仓库状态，而不是全局错误。丢弃变更等破坏性操作必须先取得用户确认。

## 路由与视图

Hash 路由定义在 `src/lib/routes.js`，侧边栏分组定义在 `src/lib/codebuddy-schema.js`。

当前真实路由：

- Primary：`chat`、`instances`、`remote-control`
- 工作区：`tasks`、`terminal`、`editor`、`changes`、`plugins`、`mcp`
- 可观测：`stats`、`traces`、`monitor`、`metrics`、`logs`、`workers`
- 配置：`settings`

Docs 路由是真实功能（通过 ACP `/docs/*` 接口渲染 CLI 文档侧栏与正文）。Canvas 无真实后端能力，已从产品中移除；不要重新添加没有真实后端能力或完整交互的路由。Keybindings 保留为真实配置页面，同时管理 GUI 本地快捷键和当前 CodeBuddy CLI 运行时提供的绑定。

## IPC

`electron/preload.cjs` 通过 `contextBridge` 暴露有限 API：

- 窗口控制：最小化、最大化、关闭、重载和 DevTools。
- 工作区和附件原生选择器。
- 产品状态读取和保存。
- 项目运行时 ensure/list/stop/restart 和状态事件。
- CodeBuddy 请求与流代理。
- 项目作用域 Git 命令。
- CodeBuddy CLI 版本、限时诊断、更新和用户确认后的指定版本安装/回滚命令。
- CodeBuddy 插件更新、依赖 dry-run 与确认清理命令。
- CodeBuddy 后台会话列表、日志、终止、Endpoint 和 Windows 交互终端 attach。

新增 Electron 能力时，应扩展明确命名的 preload 方法和主进程 handler，不能在渲染层启用 Node integration。

## 组件约定

- 页面组件位于 `src/components/Replica*View.jsx`。
- 新路由必须同时更新 `App.jsx`、`src/lib/routes.js` 和 `src/lib/codebuddy-schema.js`。
- 共享产品状态放在 Zustand store；只属于视图生命周期的临时 UI 状态保留在组件内。
- 样式优先使用 `src/index.css` 中的 CSS 变量和现有组件类。
- 页面必须提供真实 loading、empty、error 和 unavailable 状态。
- 不保留无操作、假成功、`window.alert` 占位或“功能开发中”按钮。

## 当前产品边界

- MCP 页面读取 CodeBuddy 实际使用的 user、project 和 local JSONC 配置；添加、删除、状态和工具列表继续通过当前项目运行时的真实 `internal/mcp` 接口执行。
- Scheduled Tasks 当前后端契约支持列表、创建和删除，不支持更新。
- 插件、marketplace、monitor、workers 等页面必须继续按 CodeBuddy 运行时实际返回的数据结构归一化。
- CodeBuddy CLI 端口由每个项目运行时动态分配，`src/lib/acp.js` 中的默认端口只用于 Electron IPC 不可达时的兜底。
- Windows 安装包配置位于 `package.json`，产物目录为 `dist/`。
