# 测试与门禁

本文档是 CodeBuddy Desktop 当前提交、Electron 变更和本地发布验证的门禁说明。

## 环境前提

- 在仓库根目录执行命令。
- Node.js、npm、Electron 依赖和可用的 CodeBuddy CLI 必须已安装。
- 当前仓库没有启用 GitHub Actions，也没有 active pre-commit / pre-push hook；门禁需要显式执行并在提交说明中报告。
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

- ESLint 无 error、无 warning。
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

#### 实机验收（可选，推荐 Electron / 传输层改动后执行）

```bash
# 终端 1
npm run dev:vite

# 终端 2
node scripts/test/manual-transport-reconnect-gui.cjs
```

该脚本启动真实 Electron 窗口，通过 CDP 在渲染进程执行 8 项验收（有限重连、restore、401、分类、kill switch、无重发、delayed rebind、设置默认值）。截图与 JSON 报告写入 `gui-test-screenshots/transport-reconnect-*`。

## 发布门禁

发布或跨 Electron 运行时变更执行：

```bash
npm run test:release
```

当前 `test:release` 等价于：

```bash
npm run test:gate
npm run test:e2e
npm run test:packaged
```

其中：

- `test:e2e` 先构建 renderer，再执行 unpackaged Electron launch / renderer 场景。
- `test:packaged` 先执行 `build:dir`，再执行 packaged-style Electron 场景。
- packaged-style 测试通过后，仍需按发布需求执行 `npm run release:prepare`，检查安装包、签名、`latest.yml` 和 `SHA256SUMS.txt`。

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
