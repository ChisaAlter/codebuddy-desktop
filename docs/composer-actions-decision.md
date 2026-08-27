# Composer 动作区决策记录（附件双档 / 不做加号网格与右侧历史抽屉）

> 状态：已定稿（1.1.x 起生效）。本文件是 `CODEBUDDY.md` Composer 章节引用的决策依据；
> 2026-08 parity 审计（`docs/cli-webui-parity-audit.md` §6-1）发现该文件缺失，本次补回。

## 背景

CodeBuddy WebUI 的 composer 左下角是一个「加号网格」（grid 弹层：附件、截图、历史、
斜杠命令入口等混排），并配有右侧「历史抽屉」（最近会话浮层）。Desktop 在 1.1.x 对齐
迭代中评估过整体移植，最终采用不同形态。

## 决策

1. **附件仅两档（图片 / 文件）**：回形针菜单固定两项，主进程 `attachment:choose` 按
   `kind`（`image` / `file`）过滤原生选择器。不引入 WebUI 的加号网格弹层。
2. **不做右侧历史抽屉**：会话切换由左侧项目 × 线程树承担（Desktop 的多项目模型），
   归档会话有独立 Archived 视图；1.1.4 起另有 G9 会话历史浏览器（模态）覆盖
   「浏览 CLI 全量历史并恢复」场景，仍不采用右侧抽屉形态。

## 理由

- **原生能力更优**：Electron 有真原生文件选择器，图片/文件两档 + 剪贴板贴图 + 拖放
  已覆盖 WebUI 加号网格中的全部附件入口；网格内其余项（历史、命令）在 Desktop 各有
  更强的宿主形态（侧栏树、命令面板、斜杠建议）。
- **右侧空间已被占用**：Desktop 右侧 dock 承载文件 / 浏览器 / 工作流面板（运行时 UI
  状态），再叠历史抽屉会产生互斥与状态管理复杂度。
- **多项目模型差异**：WebUI 是单 runtime 单项目形态，历史抽屉是其主要会话切换入口；
  Desktop 的项目 × 线程树本身就是常驻会话导航，抽屉是冗余入口。

## 影响面

- `src/components/ReplicaChatView.jsx`：回形针菜单两档。
- `electron/main.cjs` `attachment:choose`：`kind` 过滤。
- G9（1.1.4）：会话历史浏览器采用**模态**而非右侧抽屉，与本决策一致。

## 复审条件

若上游 WebUI 把加号网格升级为不可替代的功能入口（例如仅能从网格触达的新能力），
在 cli-compat bump 审计（见 `docs/release-checklist.md`）中重新评估。
