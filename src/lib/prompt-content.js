// R11 拆分首步：从 store/slices/sessions-chat.js 的 runThreadPrompt 中抽出的
// 纯函数——把用户输入 + 附件列表构造为 ACP session/prompt 的内容块数组。
// 行为与原内联实现完全一致（含 50 万字符截断与截断标记）。

export const ATTACHMENT_TEXT_LIMIT = 500000;

/**
 * 构造 session/prompt 的 prompt 内容块。
 * - 首块始终是用户输入的 text 块；
 * - image 附件透传 data/mimeType；
 * - text 附件包装为「文件: 名称 / 路径 / 内容」的 text 块，超长内容截断并标注；
 * - 其他 kind（如 unsupported）跳过。
 */
export function buildPromptContentBlocks(content, attachments = []) {
  const prompt = [{ type: 'text', text: content }];
  for (const attachment of attachments || []) {
    if (attachment.kind === 'image') {
      prompt.push({ type: 'image', data: attachment.data, mimeType: attachment.mimeType });
    } else if (attachment.kind === 'text') {
      const text = String(attachment.text || '');
      const clipped =
        text.length > ATTACHMENT_TEXT_LIMIT
          ? `${text.slice(0, ATTACHMENT_TEXT_LIMIT)}\n\n[文件内容已截断]`
          : text;
      prompt.push({ type: 'text', text: `文件: ${attachment.name}\n路径: ${attachment.path}\n\n${clipped}` });
    }
  }
  return prompt;
}
