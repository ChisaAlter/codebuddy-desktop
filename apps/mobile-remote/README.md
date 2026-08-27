# CodeBuddy Mobile Remote (Android)

Expo / React Native 客户端：通过自建 meet-me 中继 + E2EE 远程操作本机 CodeBuddy Desktop。

## 状态

Phase 1–3 完成：配对 + 项目/会话/聊天流式 + 停止 + 模型/思考强度/权限模式 + 权限卡 + 后台任务 + 通知 + 设备注册/吊销 + 自动重连。

## 能力

- 粘贴 `codebuddy-remote://pair#offer=...` 配对
- 项目列表 → 会话列表 → 聊天（流式 + 停止）
- Composer：模型 / 权限模式 / 思考强度（chip 选择，远程下发到本机 ACP）
- 权限请求卡（允许 / 拒绝 → `session/respond_permission`）
- 后台任务列表（只读）
- 在连通知（任务完成时本机 Alert）
- 设备注册 + 桌面侧吊销
- 断线指数退避自动重连
- E2EE：每连接临时 Curve25519，中继只见密文

## 初始化与运行

需要本机已装 Node + Android SDK（或用 Expo Go）。

```bash
cd apps/mobile-remote
npm install      # App 独立安装（不再挂在仓库根 workspaces 下）
npx expo start   # 或: npx expo start --android
```

本 App 已移出仓库根 npm workspaces（R12）：Expo/React Native 的开发期依赖链
（`@expo/cli` 等）自带大量 npm audit 告警，与桌面端无关；移出后桌面端
`npm ci` / CI 不再安装 Expo 依赖树。本地包依赖
（`@codebuddy/mobile-remote-protocol` / `@codebuddy/mobile-remote-crypto`）改为
`file:../../packages/...` 协议，需在本目录单独 `npm install`；源码热更新仍经
`metro.config.js` 的 watchFolders 解析。

## 与 Desktop 联调（本机）

1. 启中继：仓库根 `npm run mobile-remote:relay`
2. 启 Desktop：`npm run dev:electron`
3. 设置 → 手机远程 → endpoint `127.0.0.1:8787`、TLS 关 → 启用 → 生成/刷新 QR
4. 复制链接，粘到 App 配对输入框
5. 选项目 → 选会话 → 发消息

外网时：把中继部署到 VPS（见 `docs/mobile-remote/deploy-relay.md`），endpoint 改为 `your.domain:443`，TLS 开。

## 安全

- 配对链接含 Host 公钥，等同凭证，勿公开发布
- 中继不可信：业务帧均为 E2EE 密文
- 详细模型：`docs/mobile-remote/security.md`

## 已知限制

- 扫码未接相机（粘贴链接为主路径）
- `create_thread` / `set_model` / `set_mode` / `set_reasoning` 待 Phase 2
- 后台通知待 Phase 2（在连时本地通知）