# 发版检查清单（维护者操作手册）

> 适用于 1.1.x 及以后。CI 发布管线：`.github/workflows/release.yml`（windows-latest，产出 **draft** Release，人工审核后发布）。
> 合并/PR 门禁：`.github/workflows/ci.yml`（R12 起）在每次 push 到 `master` 与每个指向 `master` 的 PR 上自动跑 `npm ci` + `npm run test:gate`（ubuntu-latest + windows-latest 矩阵；action 已钉死 commit SHA，升级时需同步换 SHA 与版本注释）。合并 PR 前确认两个平台的 `ci` 均绿。

## 当前状态提示（2026-08-25）

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
5. **签名**：
   - 未配置 `CSC_LINK`/`CSC_KEY_PASSWORD` secrets 时，CI 用 `-AllowUnsigned` 出**未签名预览**安装包（Release body 会自带 SmartScreen 警告说明）。
   - 要出正式签名版（需仓库 admin 在 GitHub 页面操作，无法由代码/PR 配置）：
     1. 准备 Authenticode 代码签名证书（OV/EV），导出为 `.pfx`。
     2. `CSC_LINK` = pfx 文件的 base64（`base64 -w0 cert.pfx`）或可直接下载的 URL；`CSC_KEY_PASSWORD` = pfx 密码。
     3. 在 Settings → Secrets and variables → Actions → New repository secret 分别写入以上两项。
     4. 重跑 `release` workflow（或重推 tag）；`prepare-release.ps1` 检测到证书后走签名路径并校验签名非自签。
   - 本地 Windows 备用路径：`node scripts/run-release.cjs`（同一 PowerShell 管线），产物在 `dist/`，再手动 `gh release create v<version> --draft dist/CodeBuddy-GUI-Setup-*.exe dist/*.blockmap dist/latest.yml dist/SHA256SUMS.txt --notes-file dist/release-notes-v<version>.md`。
6. **审核 draft**：核对资产齐全（exe / blockmap / latest.yml / SHA256SUMS.txt）、`SHA256SUMS.txt` 与本地 `Get-FileHash` 一致、body 签名状态描述属实。
7. **发布 Release**：GitHub 页面把 draft 改为 published（勿标 pre-release，除非是预览版）。
8. **验证应用内更新链路**：
   - `latest.yml` 可从 `https://github.com/ChisaAlter/codebuddy-desktop/releases/latest/download/latest.yml` 拉到且 version 正确；
   - 旧版本客户端「检查更新」能发现新版本，下载地址通过 `electron/update-urls.cjs` 白名单（`codebuddy-desktop` 与 `codebuddy-gui` 均放行，见 `tests/unit/update-urls.test.js`）；
   - 安装包安装后关于页版本号正确。
