const FILE_EDIT_TOOL_NAMES = new Set([
  'write',
  'edit',
  'str_replace',
  'notebook_edit',
  'apply_patch',
]);

/**
 * Normalize a tool name for allowlist matching: camelCase → snake, punctuation → `_`.
 * `NotebookEdit` and `str-replace` both become `notebook_edit` / `str_replace`.
 */
export function normalizeToolName(name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * True only for known file-edit tools. Substring matches such as `file`, `create`,
 * or `write_todos` must not auto-allow.
 */
export function isFileEditTool(name) {
  const normalized = normalizeToolName(name);
  return FILE_EDIT_TOOL_NAMES.has(normalized);
}
