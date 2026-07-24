# CodeBuddy Mobile Remote (Android)

Expo / React Native 客户端：通过自建 meet-me 中继 + E2EE 远程操作本机 CodeBuddy Desktop。

## 状态

Phase 0 骨架：文档与协议已在 monorepo `packages/mobile-remote-*`。  
本目录待 `npx create-expo-app` 初始化（需本机 Node/Android SDK）。

## 计划能力（见 `docs/mobile-remote/`）

1. 扫码 / 粘贴 `#offer=` 配对  
2. 项目列表 → 会话 → 发消息 / 流式回复 / 停止  
3. 模型 / 思考强度 / 权限模式  
4. 权限卡、后台任务、在连通知  

## 本地开发（初始化后）

```bash
cd apps/mobile-remote
npx expo start
```

依赖 workspace 包：

- `@codebuddy/mobile-remote-protocol`
- `@codebuddy/mobile-remote-crypto`（RN 侧需确认 tweetnacl 打包；必要时用同类实现对照测试向量）

## 与 Desktop 联调

1. 本机：`npm run mobile-remote:relay`  
2. Desktop 设置「手机远程」：endpoint `127.0.0.1:8787`，TLS 关，生成 QR  
3. 模拟器/真机扫码（真机需能访问电脑局域网 IP 或已部署 VPS 中继）
