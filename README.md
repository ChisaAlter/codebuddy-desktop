# CodeBuddy Desktop

CodeBuddy Desktop 是 CodeBuddy CLI 的本地 Electron 桌面客户端，面向多项目、多对话并行编码工作流。界面和产品状态由本地应用管理，每个项目使用独立的 CodeBuddy 运行时和工作目录。

**当前版本：[1.1.0](https://github.com/ChisaAlter/codebuddy-desktop/releases/tag/v1.1.0)** · [变更说明](./RELEASE_NOTES.md) · [全部发行版](https://github.com/ChisaAlter/codebuddy-desktop/releases)

仓库：[`ChisaAlter/codebuddy-desktop`](https://github.com/ChisaAlter/codebuddy-desktop)（产品名 **CodeBuddy Desktop**；安装包文件名仍为 `CodeBuddy-GUI-Setup-<version>.exe`）。

## 主要功能

- 持久化管理多个本地项目，重启后恢复活动项目、对话、草稿和界面状态；连续输入草稿时会合并冗余写盘，切换和退出仍保存最终快照。
- 同一项目内创建多个对话，并让不同项目和对话并行工作。
- 聊天输入栏可切换会话 **模式 / 模型 / 思考强度**（含 Full Access、Delegate、effort `max`）：乐观更新、文案翻转与菜单进出动画；窄窗口下模型与思考强度贴近成组。
- 发送 / 停止按钮对齐 CodeBuddy WebUI；附件入口支持 **图片 / 文件**、剪贴板粘贴与拖放；composer 可附加 **额外工作目录**（`workspace-dirs`），与 CLI 同步并按项目偏好持久化。
- 流式会话更稳妥：迟到的 GET SSE `agent_message_chunk` 会关联最近一次 prompt；多工具回合若已有可用助手正文，不再误报「最终正文未送达」。
- 工作流与 `/goal` 目标进度可在右侧面板持续查看：包括当前阶段、整体进度、子代理/团队成员状态、成员历史、耗时、tokens 与工具调用统计；工作流完成、失败或取消后仍保留最终快照，聊天区不再要求滚动到顶部查看。
- 内置文件树和 Monaco 编辑器，支持创建、重命名、删除、编辑和保存；**Changes** 面板可预览 diff 并按路径 / 检查点回退（CLI 2.125 `/internal/file-changes`）。
- 内置项目级终端，多面板输出和布局随项目持久化；标题栏快捷键帮助支持鼠标、键盘和外部点击关闭。
- 提供 Git 状态、diff、暂存、提交、拉取、推送和分支操作。
- 提供真实的任务、**插件**、**Skills**、**Agents**、MCP、Sandbox、实例、Workers、统计、链路、指标、日志和运行监控页面；插件支持市场 `autoUpdate`、HTTP 更新（失败回落 CLI）、无限滚动与类型筛选；Skills / Agents 为只读列表（无公开 API 时安全空态）。
- 实例页同时管理项目运行时与 CodeBuddy 后台会话；Workers 页可启停 Daemon 与 Windows 登录自启动；MCP 支持 user / project / local 作用域；Sandbox 可查看 E2B 状态与清理实例。
- AskUserQuestion 取消 / 跳过不会整轮 `session/cancel`，与 CLI 2.125 中断语义一致。
- 对不受当前 CodeBuddy 版本支持的操作显示明确的不可用或错误状态，不模拟成功。
- 提供原生窗口拖动、最小化、最大化和关闭到系统托盘；支持最低 900×640 的窄窗口与分屏场景，再次启动应用会唤回已有窗口。
- 窗口隐藏或未聚焦时，可通过桌面通知获知后台任务完成或失败；完全退出前会保存最终项目状态。
- 应用品牌图标为青色像素机器人头（窗口、托盘、通知、登录页、侧栏与安装包共用）。
- 设置页可检查 GitHub Releases 中的新版本并下载 Windows 安装包；可查看 / 安装 / 回滚 CodeBuddy CLI（最低与推荐 **2.125.0**）。

## 开发运行

先确保本机可以直接运行 `codebuddy`，且版本 **不低于 GUI 最低支持版本（当前 `2.125.0`）**。设置页的「CodeBuddy CLI 维护」会显示兼容状态；版本过低或缺失时，GUI **拒绝启动项目运行时**，并可一键安装推荐版本。

然后在两个终端中启动前端和 Electron：

```bash
npm install
npm run dev
```

```bash
npm run dev:electron
```

开发页面默认位于 `http://localhost:5173`。Electron 会启动或复用项目对应的 `codebuddy --serve` 进程，并从 CLI 输出中获取实际端口。

## 构建

```bash
npm run build
```

构建会生成：

- 前端产物：`out/dist/`
- Windows 安装包：`dist/CodeBuddy-GUI-Setup-<version>.exe`（例如 `CodeBuddy-GUI-Setup-1.0.4.exe`）

Windows 打包若最终因 `rcedit`、`EBUSY` 或 `EPERM` 瞬时资源写入错误退出，会等待 2 秒并自动重试一次；其他构建错误不会被重试或隐藏。

安装器支持选择安装目录，并会创建桌面和开始菜单快捷方式。安装新版本时可直接覆盖原有版本；项目、对话和界面状态保存在用户数据目录中，卸载应用默认不会删除这些数据。

仅生成未打包目录可使用：

```bash
npm run build:dir
```

## 测试与门禁

提交前执行统一门禁：

```bash
npm run test:gate
```

涉及 Electron、渲染层或工作流面板的变更，还应执行：

```bash
npm run build:dir
```

发布级验证（包含 unpackaged 与 packaged Electron 检查）见 [`TESTING.md`](./TESTING.md)。

## 安装最新版

从 GitHub Releases 下载 Windows 安装包：

- 最新发行版：https://github.com/ChisaAlter/codebuddy-desktop/releases/latest
- 1.1.0：https://github.com/ChisaAlter/codebuddy-desktop/releases/tag/v1.1.0
- 1.0.5：https://github.com/ChisaAlter/codebuddy-desktop/releases/tag/v1.0.5
- 1.0.4：https://github.com/ChisaAlter/codebuddy-desktop/releases/tag/v1.0.4  
- 1.0.3：https://github.com/ChisaAlter/codebuddy-desktop/releases/tag/v1.0.3  
- 1.0.2：https://github.com/ChisaAlter/codebuddy-desktop/releases/tag/v1.0.2  
- 1.0.1：https://github.com/ChisaAlter/codebuddy-desktop/releases/tag/v1.0.1  

校验安装包时可对照 Release 中的 `SHA256SUMS.txt`。未签名安装包在 Windows 上可能触发 SmartScreen 提示，属预期行为（本机发布可选用 `-AllowUnsigned`）。

## 本地发布准备

不依赖 CI 的 Windows 发布材料可在本机统一生成：

```powershell
npm run release:prepare
```

该命令会运行生产构建，检查 Windows 代码签名，并在 `dist/` 中生成连字符资产名（`CodeBuddy-GUI-Setup-<version>.exe`）、`latest.yml`、`SHA256SUMS.txt` 和 Release 说明。正式发布默认要求受信任的非自签名证书；可通过 `CODEBUDDY_SIGNER_SUBJECT` 进一步约束发布者名称。没有可用签名证书时，可显式允许未签名安装包：

```powershell
npm run release:prepare -- -AllowUnsigned
```

随后可用 `gh release create v<version> ...` 将上述资产上传到 GitHub Releases（见已发布的 [v1.0.4](https://github.com/ChisaAlter/codebuddy-desktop/releases/tag/v1.0.4)）。

## 数据与运行时

- 项目、对话、终端输出和恢复信息保存在 Electron `userData` 下的产品状态文件中；Windows 默认目录为 `%APPDATA%\\codebuddy-gui`。实际路径可在应用的“设置 → 系统信息 → 用户数据目录”中查看和复制。
- 每个项目拥有独立的 CodeBuddy 进程、端口、认证信息和工作目录。
- 渲染进程通过受限 preload API 与 Electron 主进程通信；CodeBuddy REST/SSE 请求由主进程代理。
- Electron 内的终端输出使用 SSE，输入和尺寸调整使用 HTTP；非 Electron 环境保留 WebSocket 回退。
- 启动日志和崩溃日志分别写入 `electron-startup.log` 与 `crash.log`。应用保留最近一次有效的 `product-state.json.bak`；主状态文件损坏时会隔离为带时间戳的 `product-state.invalid-*.json` 并自动恢复备份，主文件和备份都不可用时才以空状态启动。
- 设置页可导出已脱敏的 JSON 诊断报告；主进程异常、React 错误、全局脚本错误、资源加载失败、未处理 Promise 拒绝和渲染进程异常退出都会进入轮转后的 `crash.log`，报告不包含对话、草稿、项目文件或完整项目路径。

开发架构和维护说明见 [`CODEBUDDY.md`](./CODEBUDDY.md)。

当前版本的用户可见变更见 [`RELEASE_NOTES.md`](./RELEASE_NOTES.md)。
