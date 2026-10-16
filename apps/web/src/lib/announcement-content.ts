/**
 * 公告正文的极小标记解析（画布侧私有约定，不引入 markdown 依赖）。
 *
 * 支持：空行分段、行内 `**加粗**` 与 `[文字](链接)`、独立成行的 `![说明](图片)`。
 * 只认识 https / http 与站内相对路径（以 / 开头），其余一律按纯文本渲染，
 * 从根上排掉 javascript: 这类危险地址；解析结果是数据、不是 HTML，
 * 渲染端只按结构建节点，因此不存在注入面。
 */
export type AnnouncementInline =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "link"; label: string; href: string };

export type AnnouncementBlock =
  | { kind: "paragraph"; lines: AnnouncementInline[][] }
  | { kind: "image"; src: string; alt: string }
  | { kind: "linkRow"; label: string; href: string };

export function isSafeAnnouncementUrl(value: string): boolean {
  const url = value.trim();
  if (!url || url.startsWith("//")) return false;
  if (url.startsWith("/")) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;
const INLINE_TOKEN = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/;

export function parseAnnouncementBody(body: string): AnnouncementBlock[] {
  const blocks: AnnouncementBlock[] = [];
  let lines: string[] = [];
  const flush = () => {
    if (!lines.length) return;
    blocks.push(paragraph(lines));
    lines = [];
  };
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const image = IMAGE_LINE.exec(line);
    if (image && isSafeAnnouncementUrl(image[2]!)) {
      flush();
      blocks.push({ kind: "image", src: image[2]!, alt: image[1]!.trim() });
      continue;
    }
    lines.push(line);
  }
  flush();
  return blocks;
}

function paragraph(lines: string[]): AnnouncementBlock {
  // 整段只有一个链接时单独成一条入口（公告里常见的"点我访问"），比夹在正文里醒目。
  if (lines.length === 1) {
    const single = INLINE_TOKEN.exec(lines[0]!);
    if (
      single &&
      single.index === 0 &&
      single[0].length === lines[0]!.length &&
      single[2] !== undefined &&
      isSafeAnnouncementUrl(single[3]!)
    ) {
      return { kind: "linkRow", label: single[2], href: single[3]! };
    }
  }
  return { kind: "paragraph", lines: lines.map(parseInline) };
}

function parseInline(line: string): AnnouncementInline[] {
  const parts: AnnouncementInline[] = [];
  let rest = line;
  while (rest) {
    const match = INLINE_TOKEN.exec(rest);
    if (!match) break;
    if (match.index > 0) parts.push({ kind: "text", text: rest.slice(0, match.index) });
    if (match[1] !== undefined) {
      parts.push({ kind: "strong", text: match[1] });
    } else if (isSafeAnnouncementUrl(match[3]!)) {
      parts.push({ kind: "link", label: match[2]!, href: match[3]! });
    } else {
      // 不安全的地址不变成链接，原样显示，用户至少能看到写的是什么。
      parts.push({ kind: "text", text: match[0] });
    }
    rest = rest.slice(match.index + match[0].length);
  }
  if (rest) parts.push({ kind: "text", text: rest });
  return parts.length ? parts : [{ kind: "text", text: line }];
}

/** 「1 周前 2026-10-06 15:10」：相对时间给远近感，绝对时间给准头（图一同款）。 */
export function formatAnnouncementTime(iso: string, now: Date = new Date()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.max(0, Math.floor((now.getTime() - at) / 60_000));
  const relative =
    minutes < 1
      ? "刚刚"
      : minutes < 60
        ? `${minutes} 分钟前`
        : minutes < 60 * 24
          ? `${Math.floor(minutes / 60)} 小时前`
          : minutes < 60 * 24 * 7
            ? `${Math.floor(minutes / (60 * 24))} 天前`
            : `${Math.floor(minutes / (60 * 24 * 7))} 周前`;
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  const absolute = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${relative} ${absolute}`;
}
