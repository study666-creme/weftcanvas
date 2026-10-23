/**
 * Agent 回复的轻量排版解析。
 *
 * 模型输出里本来就有 Markdown（列表、加粗、行内代码、小标题），但消息区一直
 * 按纯文本渲染，`**环境镜头**` 会原样带星号，编号列表也挤成一段——观感上
 * 就显得「不聪明」。这里只解析对话里真正会出现的几种块（标题 / 列表 / 引用 /
 * 代码块 / 段落），不引入完整 Markdown 依赖，也不改服务端存储的原文。
 */
export type AgentMessageBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "quote"; text: string }
  | { type: "code"; text: string };

const HEADING = /^#{1,4}\s+(.*)$/;
const BULLET = /^[-*•]\s+(.*)$/;
const ORDERED = /^\d{1,3}[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const FENCE = /^```/;

export function formatAgentMessage(content: string): AgentMessageBlock[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: AgentMessageBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: string[] | null = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const text = paragraph.join("\n").trim();
    if (text) blocks.push({ type: "paragraph", text });
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    if (list.items.length) blocks.push({ type: "list", ordered: list.ordered, items: list.items });
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (code) {
      if (FENCE.test(line.trim())) {
        blocks.push({ type: "code", text: code.join("\n") });
        code = null;
      } else {
        code.push(raw);
      }
      continue;
    }
    if (FENCE.test(line.trim())) {
      flushParagraph();
      flushList();
      code = [];
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", text: heading[1]!.trim() });
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      const nextOrdered = Boolean(ordered);
      if (list && list.ordered !== nextOrdered) flushList();
      list ??= { ordered: nextOrdered, items: [] };
      list.items.push((bullet?.[1] ?? ordered?.[1] ?? "").trim());
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      flushParagraph();
      flushList();
      blocks.push({ type: "quote", text: quote[1]!.trim() });
      continue;
    }
    flushList();
    paragraph.push(line);
  }

  if (code) blocks.push({ type: "code", text: code.join("\n") });
  flushList();
  flushParagraph();
  return blocks;
}
