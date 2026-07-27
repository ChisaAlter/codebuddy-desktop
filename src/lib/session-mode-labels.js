const MODE_LABELS = {
  default: '始终询问',
  acceptedits: '接受编辑',
  plan: '计划模式',
  bypasspermissions: '跳过权限确认',
  dontask: '不再询问',
  auto: '自动执行',
  delegate: '协调模式',
  fullaccess: '完全访问',
  work: '工作模式',
  ignore: '继承主会话模式',
  alwaysask: '始终询问',
  autoapprovefileedits: '接受编辑',
  planmode: '计划模式',
  bypasspermissionsmode: '跳过权限确认',
  noprompts: '不再询问',
  automode: '自动执行',
  delegatemode: '协调模式',
  fullaccessmode: '完全访问',
  workmode: '工作模式',
};

function normalizeModeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_'-]+/g, '');
}

export function getSessionModeLabel(mode, fallback = '') {
  const id = typeof mode === 'string' ? mode : mode?.id || mode?.modeId || mode?.value;
  const name = typeof mode === 'string' ? '' : mode?.name || mode?.label;
  // L18: prefer the caller's fallback over leaking the raw internal id to the UI
  // when no label matches (e.g. unknown "custom_xyz" mode). `id` is still returned
  // only if no fallback was provided, preserving call sites that pass no fallback.
  return MODE_LABELS[normalizeModeKey(id)]
    || MODE_LABELS[normalizeModeKey(name)]
    || name
    || fallback
    || id;
}

/**
 * Modes that instruct the CLI itself to skip interactive permission prompts.
 * GUI must call session/set_mode — do not silently auto-approve in the client.
 */
export function isCliPermissionBypassMode(mode) {
  const key = normalizeModeKey(
    typeof mode === 'string' ? mode : mode?.id || mode?.modeId || mode?.value || mode?.name,
  );
  return (
    key === 'fullaccess' ||
    key === 'fullaccessmode' ||
    key === 'bypasspermissions' ||
    key === 'bypasspermissionsmode'
  );
}

/** 输入栏高亮：完全访问（与 bypass 同类的高风险模式） */
export function isFullAccessMode(mode) {
  const key = normalizeModeKey(
    typeof mode === 'string' ? mode : mode?.id || mode?.modeId || mode?.value || mode?.name,
  );
  return key === 'fullaccess' || key === 'fullaccessmode';
}

/** 思考强度 Ultracode 复合档 */
export function isUltracodeEffort(level) {
  return normalizeModeKey(level) === 'ultracode';
}
