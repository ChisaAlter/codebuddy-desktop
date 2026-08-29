# 发版检查清单（维护者操作手册）

> 适用于 1.1.x 及以后。CI 发布管线：`.github/workflows/release.yml`（windows-latest，产出 **draft** Release，人工审核后发布）。
> 合并/PR 门禁：`.github/workflows/ci.yml`（R12 起）在每次 push 到 `master` 与每个指向 `master` 的 PR 上自动跑 `npm ci` + `npm run test:gate`（ubuntu-latest + windows-latest 矩阵；action 已钉死 commit SHA，升级时需同步换 SHA 与版本注释）。合并 PR 前确认两个平台的 `ci` 均绿。

## 当前状态提示（2026-08-27，R13）

- **进行中**：1.1.3（R12 加固 + R13 发版准备）已在 release 分支就绪；合并后按下方标准流程打 tag `v1.1.3`。
- **已发版**：[v1.1.2](https://github.com/ChisaAlter/codebuddy-desktop/releases/tag/v1.1.2) 已通过本管线发布（含 R1–R10，未签名预览安装包），是当前 latest Release。
- tag `v1.1.1` **已存在**于 origin，指向 master 上 `4e5443c`（1.1.1 版本号提交，**不含**本轮 R1–R10 修复）。
- 此前最新已发布 Release 是 `v1.0.5`；`v1.1.0` / `v1.1.1` 有 tag 无 Release（保持现状，不删不动）。
- 因此二选一：
  - **路线 A（推荐）**：合并 PR #1 后，在 master 上把 `package.json` 提升到 `1.1.2`（连带 README/lockfile/RELEASE_NOTES，`tests/unit/version-consistency.test.js` 会强制一致），打 tag `v1.1.2` 推送 → Actions 自动出 draft，内容包含全部修复。
  - **路线 B（补历史账）**：workflow 合入 master 后，用 `workflow_dispatch` 输入 `v1.1.1`，从旧 tag 构建并给 `v1.1.1` 补一个 draft Release（内容是当时的 1.1.1，不含本轮修复）。注意旧提交未含 R4 跨平台测试修复，`test:gate` 在 CI 是否全绿未经验证。
  - **不要**删除/移动已存在的远程 tag。

## 标准流程（merge → tag → draft → publish）

1. **合并 PR**：确认 PR（如 [#1](https://github.com/ChisaAlter/codebuddy-desktop/pull/1)）绿灯后合并到 `master`。
2. **确认版本四件套一致**（`npx vitest run tests/unit/version-consistency.test.js`）：
   - `package.json` `version`
   - `package-lock.json`（两处 version 字段）
   - `README.md`「当前版本：[x.y.z](…/releases/tag/vx.y.z)」
   - `RELEASE_NOTES.md` 含该版本条目
3. **在 master 打 tag 并推送**（tag 必须与 package.json 版本一致，workflow 会校验）：

   ```bash
   git checkout master && git pull origin master
   git tag -a v1.1.2 -m "CodeBuddy Desktop 1.1.2"
   git push origin v1.1.2
   ```

4. **Actions 自动构建**：tag push 触发 `release` workflow（windows-latest）：
   `npm ci` → `npm run test:gate` → `prepare-release.ps1`（内部 `npm run build`）→ 创建 **draft** Release 并附上：
   - `dist/CodeBuddy-GUI-Setup-<version>.exe`
   - `…exe.blockmap`
   - `dist/latest.yml`
   - `dist/SHA256SUMS.txt`
   - Release body = `dist/release-notes-v<version>.md`（含 SHA256 与签名状态说明）
5. **签名**（详细操作见下方「代码签名操作指引」）：
   - 未配置 `CSC_LINK`/`CSC_KEY_PASSWORD` secrets 时，CI 用 `-AllowUnsigned` 出**未签名预览**安装包（Release body 会自带 SmartScreen 警告说明）。
   - 已配置 secrets 时，`prepare-release.ps1` 检测到证书后走签名路径并校验签名非自签。
   - 本地 Windows 备用路径：`node scripts/run-release.cjs`（同一 PowerShell 管线），产物在 `dist/`，再手动 `gh release create v<version> --draft dist/CodeBuddy-GUI-Setup-*.exe dist/*.blockmap dist/latest.yml dist/SHA256SUMS.txt --notes-file dist/release-notes-v<version>.md`。
6. **审核 draft**：核对资产齐全（exe / blockmap / latest.yml / SHA256SUMS.txt）、`SHA256SUMS.txt` 与本地 `Get-FileHash` 一致、body 签名状态描述属实。
7. **发布 Release**：GitHub 页面把 draft 改为 published（勿标 pre-release，除非是预览版）。
8. **验证应用内更新链路**：
   - `latest.yml` 可从 `https://github.com/ChisaAlter/codebuddy-desktop/releases/latest/download/latest.yml` 拉到且 version 正确；
   - 旧版本客户端「检查更新」能发现新版本，下载地址通过 `electron/update-urls.cjs` 白名单（`codebuddy-desktop` 与 `codebuddy-gui` 均放行，见 `tests/unit/update-urls.test.js`）；
   - 安装包安装后关于页版本号正确。

## CLI 推荐版本 bump 检查清单（parity 审计后新增）

> 每次提升 `electron/cli-compat.cjs` 的推荐（或最低）CLI 版本时逐项执行。
> 背景：1.1.3 之前 schema 钉在 WebUI 2.124 而推荐 CLI 已提到 2.138，漂移由 parity 审计（G1）才发现。

1. **解包新版 WebUI bundle**：`npm pack @tencent-ai/codebuddy-code@<版本>` → 解包检查 `dist/web-ui/`（必要时 `js-beautify` 美化）。
2. **设置 schema diff**：对照 bundle 内 SettingsView chunk 的分组数组与 `src/lib/codebuddy-schema.js`（`SETTINGS_GROUPS`），逐组逐键 diff；新增/删除/改类型的键同步进 schema + `ReplicaSettingsView` 渲染 + `webui-settings-schema.test.js`。
3. **API 面 diff**：提取 bundle 中 `/api/v1/*` 字面量，与 `src/lib/*.js` 调用面对比，新端点记入 parity 审计文档（缺口分级，不强制立即实现）。
4. **视图/路由 diff**：bundle 视图集合（`Kx` 类 Set）与 `src/lib/routes.js` 对比，新视图记录缺口。
5. **CHANGELOG 双源核对**：npm 包根 `CHANGELOG.md` 与 `dist/web-ui/docs` release-notes 索引口径可能不同（后者滞后），以包根 CHANGELOG 为准列出行为变更。
6. **四处同步**：`electron/cli-compat.cjs` + README + CODEBUDDY.md + 设置页/引导对话框回退值（`cli-compat.test.js` 有文档同步守卫）。
7. **真机验证后才 bump**：`test:gate` + packaged E2E + 手动会话/工作流/PTY 冒烟。

## 代码签名操作指引（R13 补全）

> 目标：让 release workflow 产出正式 Authenticode 签名的安装包，消除 SmartScreen「未知发布者」提示。以下操作需要仓库 admin 权限（写 Actions secrets），无法由代码/PR 配置。

### A. 准备证书（一次性）

1. 向 CA（DigiCert / Sectigo / SSL.com 等）申购 **Authenticode 代码签名证书**：
   - **OV 证书**：可导出为 `.pfx` 文件，适配当前 CI 的 `CSC_LINK` 流程（推荐起步选择）。
   - **EV 证书**：私钥固化在硬件 token / HSM，**无法导出 pfx**，不适配当前 `CSC_LINK` 流程；如需 EV/云签名（Azure Trusted Signing 等），要改造 `release.yml` 接入对应签名服务，单独开迭代。
2. OV 证书导出 `.pfx`（Windows，证书已装入个人存储时）：

   ```powershell
   # 找到证书指纹
   Get-ChildItem Cert:\CurrentUser\My | Format-List Subject, Thumbprint, NotAfter
   # 导出为 pfx（换成实际指纹与强密码）
   $pwd = Read-Host -AsSecureString "pfx password"
   Export-PfxCertificate -Cert Cert:\CurrentUser\My\<THUMBPRINT> -FilePath codebuddy-sign.pfx -Password $pwd
   ```

   或从 CA 下发的 `.cer` + 私钥合成：`certutil -mergepfx`。

### B. 转 base64 并写入 GitHub secrets

1. pfx → base64（勿用可下载 URL 承载 pfx，避免证书泄露面扩大）：

   ```powershell
   # Windows PowerShell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("codebuddy-sign.pfx")) | Set-Content codebuddy-sign.pfx.b64
   ```

   ```bash
   # Linux / macOS
   base64 -w0 codebuddy-sign.pfx > codebuddy-sign.pfx.b64
   ```

2. GitHub 仓库 → Settings → Secrets and variables → Actions → **New repository secret**：
   - `CSC_LINK` = `codebuddy-sign.pfx.b64` 的**全部内容**（单行 base64）。
   - `CSC_KEY_PASSWORD` = pfx 密码。
3. 安全纪律：本地立即删除 `.pfx.b64` 明文中转文件；`.pfx` 离线保管；密码不进聊天/工单；证书或密码疑似泄露时立刻在 GitHub 轮换 secrets 并向 CA 申请吊销重签。

### C. 触发签名构建并验证

1. 重跑最近一次 `release` workflow（Actions → release → Re-run all jobs），或重推 tag 触发新构建。
2. CI 侧确认：`prepare-release.ps1` 日志走签名分支（不再出现 `-AllowUnsigned`/未签名提示），且自签校验通过。
3. 下载 draft Release 里的安装包本地验签：

   ```powershell
   # 期望 Status 为 Valid，SignerCertificate 是你的证书主体
   Get-AuthenticodeSignature .\CodeBuddy-GUI-Setup-<version>.exe | Format-List Status, StatusMessage, SignerCertificate
   # 或用 signtool（Windows SDK）
   signtool verify /pa /v CodeBuddy-GUI-Setup-<version>.exe
   ```

4. Release body 的签名状态描述与实际一致后再 publish。
5. 到期管理：证书 NotAfter 前 30 天内完成续期换发，并按 B 步骤轮换 secrets（旧安装包已打的时间戳签名不受证书到期影响）。
