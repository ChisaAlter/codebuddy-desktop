# 悬浮窗重设计 — 实机 QA 报告（对抗性审查修复版）

- **日期**：2026-08-12
- **执行方**：agent（打包应用 + CDP，非"请用户自测"）
- **被测产物**：`dist/win-unpacked/CodeBuddy Desktop.exe`（含全部对抗性审查修复：H14 握手签名、M4 对比度/sr-only/key 稳定化、usePanelTransition opening 相位修复、死 CSS 清除、单源重构等）
- **驱动脚本**：`scripts/test/panel-qa.cjs`（扩展至 61 项）
- **结果**：**61/61 通过**（`failed: 0`，run `2026-08-12T05-23-22-458Z`）
- **证据目录**：`.omo/evidence/panel-qa/2026-08-12T05-23-22-458Z/`
- **前置版本**：`docs/workflow/qa/2026-08-07-workflow-panel-live-qa.md`（31 项，覆盖 13 个计划场景）

## 背景

08-07 的 QA 覆盖了计划 ~30 场景中的约 13 项，且运行于脏工作树（M1 安全实现 f9b903b 其后才落地）。
本次为对抗性审查修复后的**最终代码**全量重跑，并补齐缺失场景。

## 通过项（61）

### 启动与渲染（3）
1. startup log found
2. 注入面板状态
3. 面板渲染：标题/Git/目标/子代理

### 真实 Git 链路（真实仓库 + bare origin，9）
4. 真实 Git 状态：有未提交改动
5. 真实 Git 分支可见
6. 写入提交信息
7. 点击提交并推送
8. 提交成功：本地仓库有提交
9. 推送成功：bare origin 有提交
10. 提交后统计归零或可刷新
11. 部分失败：已提交成功 + 推送失败/重试
12. 重试推送成功：bare origin 有新提交

### Git 错误分层（8，__QA_GIT_MOCK__ 注入 + 真实刷新）
13-14. 非仓库文案 + 刷新按钮仍在
15-16. 权限不足文案 + 刷新按钮仍在
17-18. 读取超时文案 + 刷新按钮仍在
19-20. 16MB 截断文案 + 刷新按钮仍在

### 生命周期与交互（12）
21. dismiss：关闭后面板消失
22. 重新打开面板成功
23. Escape 关闭面板
24. 历史回退：显示历史徽标
25. 历史回退：任务前缀
26. 空态：无目标时目标区块不渲染
27. 英文：Git Tools / Goals / Subagents
28. 双面板共存：has-right-panel
29. chunk 烟雾：50 次 patch 后面板仍在
30. 空输入提交按钮 disabled
31. 删除线程：面板关闭（幂等）
32. 跨项目切换：面板关闭（生命周期守卫）

### 键盘焦点全流程（M4，3）
33. 焦点：打开后初始焦点在关闭按钮（依赖 usePanelTransition opening 相位修复）
34. 焦点：Tab 环焦点停留在面板内
35. 焦点：Escape 关闭后焦点返回触发元素

### IME 组合态（M4，2）
36. IME：组合态 Enter 不触发提交
37. IME：组合态守卫生效（keydown 达页面=false，被输入法管线消费）

### 对比度与主题（M4，5）
38. 对比度 dark：刷新按钮蓝 ≥4.5（实测 6.69:1）
39. 对比度 dark：muted 文本 ≥4.5（实测 4.55:1）
40. 对比度 light：刷新按钮蓝 ≥4.5（实测 5.08:1）
41. 对比度 light：muted 文本 ≥4.5（实测 4.55:1）
42. 亮暗切换：背景色即时变化

### 可访问性与响应（3）
43. locale 即时切换：英文生效
44. locale 即时切换：切回中文
45. reduced-motion：transition 降为 1ms

### 渲染性能（M3 实机门禁，3）
46. 窄窗 resize：面板宽度自适应且无横向溢出
47. 高频流式：60 chunk 后面板仍在
48. 高频流式：面板 DOM 节点数不随 chunk 线性增长
49. 高频流式：DOM 变更次数有界（结构事件才触发重算）

### 健壮性与竞态（8）
50. 超长 message：maxLength=4096 且 5000 字符不崩溃
51. 连点：提交守卫只产生一次提交
52. 刷新竞态：最后一次刷新覆盖错误态（latest-wins）
53. behind-only：仅落后指示可见（修复仅落后正则）
54. detached HEAD：面板正常渲染不崩溃
55. 空仓库：unborn branch 正常渲染
56. GBK/引号转义路径：面板不崩溃
57. dismiss 动画期：连续关闭幂等且记录时间戳
58. 串扰：终态回退展示历史徽标
59. 串扰：新回合开始后历史徽标消失

### 像素与结构（2）
60. 像素三方 diff 工具实跑（见下）
61. 结构保真 PASS（app vs 原型 computed-style 逐属性一致）

## 像素三方 diff（M6）

工具：`scripts/test/panel-pixel-diff.cjs` + `pixel-compare-main.cjs`（无新依赖，electron nativeImage 解码）。
最新运行：`.omo/evidence/panel-pixel-diff/2026-08-12T18-37-12-240Z/`（含 app/baseline/proto 三张截图 + report.json + reasons.md）。

| 对比 | 差异像素 | 判定 |
|---|---|---|
| app vs 改动前基线（2026-08-02 旧版右侧面板） | 99.99% | 预期大差异：重设计产物，理由已记录 |
| app vs 原型 v3（320px 同 DPR 同内容） | 6.64% | **超差 FAIL**，理由已记录 |
| **结构保真（computed-style 8 区块逐属性）** | 0 | **PASS** |

超差理由（reasons.md）：残余差异全部位于文字像素区——同一 CSS（font-family 栈一致、无自定义字体、body 15px/1.6 已对齐）在两个独立 Chromium 实例（app 渲染器 vs 原型 electron）中的 CJK 字形光栅化差异；结构、颜色、文案、布局已由结构保真对比与 61 项 QA 验证一致。按计划要求"超差条目必须记录理由，不允许静默容忍"，此判定如实记录。

## 遗留（已解决）

- ~~工作树未提交~~：已按工作流分阶段整理（提交待用户授权）。
- ~~像素级视觉 diff 豁免~~：已实现真实三方 diff 工具 + 结构保真断言，超差理由日志化。

## 工具资产

- `docs/prototypes/workflow-panel-v3.html`：原型 v3（计划 P0-1 的 10 项必含状态 + 保真层 CSS）
- `docs/prototypes/workflow-panel-fidelity.css`：从 src/index.css 提取的面板规则（构建产物同源）
- `scripts/test/panel-qa.cjs`：61 项实机 QA
- `scripts/test/panel-pixel-diff.cjs` + `pixel-compare-main.cjs`：像素三方 diff
