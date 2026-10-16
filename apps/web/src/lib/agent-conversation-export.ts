import type { AgentConversationDetail } from "@weftcanvas/contracts";

/**
 * 会话导出：把当前对话（会话元数据 + 消息 + 最近一次运行）落成一个 JSON 文件。
 *
 * 导出是"带出浏览器"的动作，所以写盘前必须脱敏：任何字符串值里的 Bearer 令牌、
 * `sk-` 开头的模型 key、查询串里的 `token=`/`api_key=`、`data:` 内联媒体，以及
 * URL 里的 userinfo 与查询串都在这里被清掉。脱敏是结构无关的深度遍历——运行记录
 * 里的 actions/receipt 是任意嵌套的对象，只按顶层字段清洗一定会漏。
 */
export const AGENT_CONVERSATION_EXPORT_FORMAT = "weftcanvas-agent-conversation";
export const AGENT_CONVERSATION_EXPORT_VERSION = 1;

const REDACTED = "[redacted]";

export type AgentConversationExport = {
  format: typeof AGENT_CONVERSATION_EXPORT_FORMAT;
  version: typeof AGENT_CONVERSATION_EXPORT_VERSION;
  exportedAt: string;
  conversation: AgentConversationDetail["conversation"];
  messages: AgentConversationDetail["messages"];
  run: AgentConversationDetail["latestRun"];
};

/** 顺序有讲究：先清令牌形态，再清查询串/内联媒体，最后才处理 URL 整体。 */
const STRING_REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // Authorization: Bearer <token>
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`],
  // OpenAI / Anthropic 风格的模型 key
  [/\bsk-[A-Za-z0-9_-]{6,}/gi, `sk-${REDACTED}`],
  // 查询串或表单里的凭据参数（保留参数名，值一律清掉）
  [
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret)=([^&\s"'<>]+)/gi,
    `$1=${REDACTED}`,
  ],
  // data: 内联媒体（base64 或纯文本）
  [/\bdata:[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+[^\s"']*/gi, `data:${REDACTED}`],
  // URL userinfo（https://user:pass@host）
  [/\b([a-z][a-z0-9+.-]*):\/\/[^\s/?#"'<>@]+@/gi, `$1://${REDACTED}@`],
  // 任意 URL 的查询串整体清掉
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]*)\?[^\s"'<>]+/gi, `$1?${REDACTED}`],
];

export function redactSensitiveString(value: string): string {
  let next = value;
  for (const [pattern, replacement] of STRING_REDACTIONS) {
    next = next.replace(pattern, replacement);
  }
  return next;
}

/** 深度遍历数组/对象，只改写字符串值；结构本身原样保留。 */
export function redactSensitiveStrings<T>(value: T): T {
  if (typeof value === "string") return redactSensitiveString(value) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveStrings(item)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = redactSensitiveStrings(item);
    }
    return output as unknown as T;
  }
  return value;
}

export function buildAgentConversationExport(
  detail: AgentConversationDetail,
  exportedAt: string = new Date().toISOString(),
): AgentConversationExport {
  return redactSensitiveStrings({
    format: AGENT_CONVERSATION_EXPORT_FORMAT,
    version: AGENT_CONVERSATION_EXPORT_VERSION,
    exportedAt,
    conversation: detail.conversation,
    messages: detail.messages,
    run: detail.latestRun,
  });
}

export function agentConversationExportFilename(conversationId: string, exportedAt: string) {
  return `agent-conversation-${conversationId}-${exportStamp(exportedAt)}.json`;
}

/** 文件名里不能出现冒号（Windows 直接拒绝），日期照 ISO 其余部分原样保留。 */
function exportStamp(exportedAt: string) {
  return exportedAt.replace(/:/g, "-");
}

export function downloadAgentConversationExport(detail: AgentConversationDetail) {
  const exportedAt = new Date().toISOString();
  const payload = buildAgentConversationExport(detail, exportedAt);
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
    type: "application/json",
  });
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = agentConversationExportFilename(detail.conversation.id, exportedAt);
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Keep the object URL alive through the browser's click dispatch.
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  }
}
