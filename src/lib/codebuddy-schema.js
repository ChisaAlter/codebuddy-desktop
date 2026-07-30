export const NAV_GROUPS = [
  {
    id: 'primary',
    title: 'Primary',
    items: [
      { id: 'instances', label: '实例列表' },
      { id: 'remote-control', label: '远程控制' },
    ],
  },
  {
    id: 'workspace',
    title: '工作区',
    items: [
      { id: 'tasks', label: '任务' },
      { id: 'archived', label: '已归档' },
      { id: 'terminal', label: '终端' },
      { id: 'editor', label: '代码编辑器' },
      { id: 'changes', label: '变更' },
      { id: 'canvas', label: '无限画布' },
      { id: 'plugins', label: '插件' },
      { id: 'skills', label: '技能' },
      { id: 'agents', label: 'Agents' },
      { id: 'mcp', label: 'MCP' },
      { id: 'sandboxes', label: 'Sandboxes' },
    ],
  },
  {
    id: 'observability',
    title: '可观测',
    items: [
      { id: 'stats', label: '统计' },
      { id: 'traces', label: '链路追踪' },
      { id: 'monitor', label: '监控' },
      { id: 'metrics', label: '系统监控' },
      { id: 'logs', label: '日志查看器' },
      { id: 'workers', label: 'Agent 实例管理' },
    ],
  },
  {
    id: 'preferences',
    title: '配置',
    items: [
      { id: 'docs', label: '文档中心' },
      // 自定义模型入口已并入设置页「模型选择」；不再在侧栏底部放独立「模型」页
      { id: 'settings', label: '设置' },
      { id: 'keybindings', label: '快捷键' },
    ],
  },
];

/**
 * Mirrors CodeBuddy WebUI 2.124 settings schema `Mk` exactly (6 groups / 18 keys).
 * Desktop GUI-only prefs live under appearance with scope:'gui' and are not part of Mk.
 * ReplicaSettingsView renders Mk groups directly; this export is the shared key catalog.
 */
export const SETTINGS_GROUPS = [
  {
    id: 'appearance',
    title: '外观',
    items: [
      { key: 'theme', label: '界面主题', type: 'text', scope: 'gui' },
      { key: 'enablePasteImageFromClipboard', label: '允许剪贴板贴图', type: 'boolean', scope: 'gui' },
      { key: 'showTokensCounter', label: '显示 Token 计数', type: 'boolean', scope: 'gui' },
      { key: 'desktopNotificationsEnabled', label: '桌面通知', type: 'boolean', scope: 'gui' },
      { key: 'doNotDisturb', label: '免打扰', type: 'boolean', scope: 'gui' },
      { key: 'sessionAutoAllowFileEdits', label: '本会话自动通过文件编辑权限', type: 'boolean', scope: 'gui' },
      { key: 'requestPermissionOnFirstToolUse', label: '每次首次使用工具时都请求权限', type: 'boolean', scope: 'gui' },
    ],
  },
  {
    id: 'modelAndReasoning',
    title: '模型与推理',
    items: [
      { key: 'model', label: '默认模型', type: 'select' },
      {
        key: 'reasoningEffort',
        label: '推理努力级别',
        type: 'select',
        options: [
          ['minimal', '最小'],
          ['low', '低'],
          ['medium', '中'],
          ['high', '高'],
          ['xhigh', '极高'],
          ['max', '最大'],
        ],
      },
      { key: 'alwaysThinkingEnabled', label: '始终启用深度思考', type: 'boolean' },
    ],
  },
  {
    id: 'behavior',
    title: '行为',
    items: [
      { key: 'autoCompactEnabled', label: '自动压缩上下文', type: 'boolean' },
      { key: 'includeCoAuthoredBy', label: '提交包含 Co-authored-by', type: 'boolean' },
      { key: 'fileCheckpointingEnabled', label: '文件检查点', type: 'boolean' },
      { key: 'promptSuggestionEnabled', label: '提示建议', type: 'boolean' },
      { key: 'ignoreGitIgnore', label: '忽略 .gitignore', type: 'boolean' },
      { key: 'deferToolLoading', label: '延迟加载工具', type: 'boolean' },
      { key: 'hookOutputCollapsed', label: '折叠 Hook 输出', type: 'boolean' },
    ],
  },
  {
    id: 'memory',
    title: '记忆',
    items: [
      { key: 'memory.enabled', label: '启用记忆功能', type: 'boolean' },
      { key: 'memory.autoMemoryEnabled', label: '自动记忆', type: 'boolean' },
    ],
  },
  {
    id: 'language',
    title: '语言',
    items: [{ key: 'language', label: '响应语言', type: 'text' }],
  },
  {
    id: 'advanced',
    title: '高级',
    items: [
      { key: 'cleanupPeriodDays', label: '聊天记录保留天数', type: 'number' },
      { key: 'imageHistoryRetainRounds', label: '图片保留轮数', type: 'number' },
      { key: 'env', label: '环境变量', type: 'json' },
    ],
  },
  {
    id: 'sandbox',
    title: '安全沙箱',
    items: [
      { key: 'sandbox.enabled', label: '启用安全沙箱', type: 'boolean' },
      { key: 'sandbox.autoAllowBashIfSandboxed', label: '沙箱内自动批准命令', type: 'boolean' },
    ],
  },
];

/** Exact WebUI Mk key list (order preserved). */
export const WEBUI_MK_SETTING_KEYS = [
  'model',
  'reasoningEffort',
  'alwaysThinkingEnabled',
  'autoCompactEnabled',
  'includeCoAuthoredBy',
  'fileCheckpointingEnabled',
  'promptSuggestionEnabled',
  'ignoreGitIgnore',
  'deferToolLoading',
  'hookOutputCollapsed',
  'memory.enabled',
  'memory.autoMemoryEnabled',
  'language',
  'cleanupPeriodDays',
  'imageHistoryRetainRounds',
  'env',
  'sandbox.enabled',
  'sandbox.autoAllowBashIfSandboxed',
];

export function getByPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

export function formatValue(value) {
  if (typeof value === 'boolean') return value ? '已开启' : '已关闭';
  if (value == null) return '未设置';
  if (Array.isArray(value)) return `${value.length} 项`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
