export const NAV_GROUPS = [
  {
    id: 'primary',
    title: 'Primary',
    items: [{ id: 'remote-control', label: '远程控制' }],
  },
  {
    id: 'workspace',
    title: '工作区',
    items: [
      { id: 'tasks', label: '任务' },
      { id: 'terminal', label: '终端' },
      { id: 'editor', label: '编辑器' },
      { id: 'changes', label: '变更' },
      { id: 'plugins', label: '插件' },
    ],
  },
  {
    id: 'observability',
    title: '可观测',
    items: [
      { id: 'stats', label: '统计' },
      { id: 'traces', label: '链路' },
      { id: 'metrics', label: '监控' },
      { id: 'logs', label: '日志' },
    ],
  },
  {
    id: 'desktop-extensions',
    title: '桌面扩展',
    items: [
      { id: 'archived', label: '已归档' },
      { id: 'instances', label: '实例列表' },
      { id: 'skills', label: '技能' },
      { id: 'agents', label: 'Agents' },
      { id: 'mcp', label: 'MCP' },
      { id: 'sandboxes', label: 'Sandboxes' },
      { id: 'workers', label: 'Agent 实例管理' },
    ],
  },
  {
    id: 'preferences',
    title: '配置',
    items: [
      { id: 'settings', label: '设置' },
      { id: 'keybindings', label: '快捷键' },
      { id: 'docs', label: '文档' },
    ],
  },
];

/**
 * Mirrors CodeBuddy WebUI 2.138 settings schema exactly (7 groups / 22 keys; 2.124 Mk 18 键
 * + 2.136 autoCompactWindow + 2.138 busySendMode + mainAgent 组两键)。
 * Desktop GUI-only prefs live under appearance with scope:'gui' and are not part of the CLI schema.
 * ReplicaSettingsView renders these groups directly; this export is the shared key catalog.
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
      { key: 'autoCompactWindow', label: '自动压缩窗口 (token)', type: 'number' },
      { key: 'includeCoAuthoredBy', label: '提交包含 Co-authored-by', type: 'boolean' },
      { key: 'fileCheckpointingEnabled', label: '文件检查点', type: 'boolean' },
      { key: 'promptSuggestionEnabled', label: '提示建议', type: 'boolean' },
      {
        key: 'codebuddy.composer.busySendMode',
        label: '忙碌时发送',
        type: 'select',
        defaultValue: 'queue',
        options: [
          ['queue', '排队发送'],
          ['immediate', '立即插入当前回合'],
        ],
      },
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
    id: 'mainAgent',
    title: 'Agent 预设',
    items: [
      { key: 'codebuddy.mainAgent.enabled', label: '启用 Agent 预设', type: 'boolean', defaultValue: true },
      { key: 'codebuddy.mainAgent.allowUnopted', label: '允许未声明的 ACP 宿主', type: 'boolean', defaultValue: false },
    ],
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

/** Exact WebUI 2.138 settings key list (order preserved). */
export const WEBUI_MK_SETTING_KEYS = [
  'model',
  'reasoningEffort',
  'alwaysThinkingEnabled',
  'autoCompactEnabled',
  'autoCompactWindow',
  'includeCoAuthoredBy',
  'fileCheckpointingEnabled',
  'promptSuggestionEnabled',
  'codebuddy.composer.busySendMode',
  'ignoreGitIgnore',
  'deferToolLoading',
  'hookOutputCollapsed',
  'memory.enabled',
  'memory.autoMemoryEnabled',
  'language',
  'codebuddy.mainAgent.enabled',
  'codebuddy.mainAgent.allowUnopted',
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
