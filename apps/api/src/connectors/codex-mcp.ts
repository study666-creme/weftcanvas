import type { AgentAction, AgentCanvasContext } from "@weftcanvas/contracts";

import type { CanvasCommandBroker } from "./canvas-command-broker.js";

/**
 * Codex 的远程 MCP 入口（JSON-RPC 2.0 over HTTP）。
 *
 * Codex 带着自己的配对令牌连到这里，工具调用经 CanvasCommandBroker 转成画布指令，
 * 由**用户浏览器**执行后回执——服务端不持有画布状态，也不给外部连接任何画布写权限之外的
 * 东西。工具集与本机版的 apps/agent/mcp/canvas-mcp.mjs 保持一致。
 */

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "weftcanvas", version: "1.0.0" };

const projectIdProperty = {
  type: "string",
  description: "画布项目 id；省略时作用于浏览器当前打开的画布",
} as const;

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  build?: (args: Record<string, unknown>, nextClientId: () => string) => AgentAction[] | null;
};

let clientSequence = 0;
function nextClientId() {
  clientSequence += 1;
  return `codex_${Date.now().toString(36)}_${clientSequence}`;
}

function position(args: Record<string, unknown>) {
  return typeof args.x === "number" && typeof args.y === "number" ? { x: args.x, y: args.y } : null;
}

export const CODEX_MCP_TOOLS: readonly ToolDefinition[] = [
  {
    name: "canvas_read",
    description:
      "读取浏览器当前打开画布的有界摘要（项目、节点 id、正文、连线）。改动画布前先调用它拿到真实节点 id。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "canvas_add_node",
    description: "在画布上新建节点。kind 可选 text/image/video/audio/config/edit。",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["text", "image", "video", "audio", "config", "edit"] },
        body: { type: "string", description: "节点正文（text/config 节点常用）" },
        x: { type: "number" },
        y: { type: "number" },
        projectId: projectIdProperty,
      },
      required: ["kind"],
      additionalProperties: false,
    },
    build: (args, nextId) => [
      {
        type: "canvas_add_node",
        clientId: nextId(),
        kind: args.kind as AgentAction extends { kind: infer K } ? K : never,
        ...(typeof args.body === "string" ? { body: args.body } : {}),
        ...(position(args) ? { position: position(args)! } : {}),
      } as AgentAction,
    ],
  },
  {
    name: "canvas_update_node",
    description: "修改已有节点的正文或位置。nodeId 必须是 canvas_read 返回的真实 id。",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        body: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        projectId: projectIdProperty,
      },
      required: ["nodeId"],
      additionalProperties: false,
    },
    build: (args) => [
      {
        type: "canvas_update_node",
        nodeId: String(args.nodeId),
        ...(typeof args.body === "string" ? { body: args.body } : {}),
        ...(position(args) ? { position: position(args)! } : {}),
      } as AgentAction,
    ],
  },
  {
    name: "canvas_connect_nodes",
    description: "从 sourceNodeId 连一条边到 targetNodeId。",
    inputSchema: {
      type: "object",
      properties: {
        sourceNodeId: { type: "string" },
        targetNodeId: { type: "string" },
        projectId: projectIdProperty,
      },
      required: ["sourceNodeId", "targetNodeId"],
      additionalProperties: false,
    },
    build: (args) => [
      {
        type: "canvas_connect_nodes",
        sourceNodeId: String(args.sourceNodeId),
        targetNodeId: String(args.targetNodeId),
      } as AgentAction,
    ],
  },
  {
    name: "canvas_select_nodes",
    description: "选中一组节点（最多 120 个）。",
    inputSchema: {
      type: "object",
      properties: {
        nodeIds: { type: "array", items: { type: "string" }, maxItems: 120 },
        projectId: projectIdProperty,
      },
      required: ["nodeIds"],
      additionalProperties: false,
    },
    build: (args) => [
      { type: "canvas_select_nodes", nodeIds: (args.nodeIds as string[]) ?? [] } as AgentAction,
    ],
  },
  {
    name: "canvas_group_nodes",
    description: "把两个以上节点归为一组。",
    inputSchema: {
      type: "object",
      properties: {
        nodeIds: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 120 },
        name: { type: "string", maxLength: 32 },
        projectId: projectIdProperty,
      },
      required: ["nodeIds"],
      additionalProperties: false,
    },
    build: (args) => [
      {
        type: "canvas_group_nodes",
        nodeIds: (args.nodeIds as string[]) ?? [],
        ...(typeof args.name === "string" ? { name: args.name } : {}),
      } as AgentAction,
    ],
  },
  {
    name: "canvas_set_viewport",
    description: "设置画布视口位置与缩放（zoom 0.05~8）。",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        zoom: { type: "number" },
        projectId: projectIdProperty,
      },
      required: ["x", "y", "zoom"],
      additionalProperties: false,
    },
    build: (args) => [
      {
        type: "canvas_set_viewport",
        viewport: { x: Number(args.x), y: Number(args.y), zoom: Number(args.zoom) },
      } as AgentAction,
    ],
  },
];

export type CodexMcpContext = {
  ownerId: string;
  broker: CanvasCommandBroker;
  signal?: AbortSignal;
};

export type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

/** 处理一条 JSON-RPC 消息。返回 null 表示这是通知，不需要响应。 */
export async function handleCodexMcpMessage(
  message: JsonRpcRequest,
  context: CodexMcpContext,
): Promise<unknown | null> {
  const id = message.id ?? null;
  const method = typeof message.method === "string" ? message.method : "";

  if (method === "initialize") {
    return result(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions:
        "先用 canvas_read 读当前画布；改动画布前确认节点 id。写入由用户浏览器执行，返回的回执才是真实结果。",
    });
  }
  if (method === "notifications/initialized" || method === "initialized") return null;
  if (method === "ping") return result(id, {});
  if (method === "tools/list") {
    return result(id, {
      tools: CODEX_MCP_TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    });
  }
  if (method === "tools/call") {
    const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
    const name = typeof params.name === "string" ? params.name : "";
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = CODEX_MCP_TOOLS.find((item) => item.name === name);
    if (!tool) return result(id, toolText(`未知工具 ${name}`, true));
    try {
      return result(id, await callTool(tool, args, context));
    } catch (error) {
      return result(id, toolText(error instanceof Error ? error.message : "工具调用失败", true));
    }
  }
  if (id === null) return null;
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `不支持的方法 ${method}` } };
}

async function callTool(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  context: CodexMcpContext,
) {
  if (tool.name === "canvas_read") {
    const snapshot = context.broker.readContext(context.ownerId);
    if (!snapshot)
      return toolText(
        "当前没有可读的画布：请先在浏览器里打开画布页面（画布摘要只在页面轮询时上报）。",
      );
    if (!snapshot.context) return toolText("画布摘要已过期：请让用户把画布页面切到前台。");
    return toolText(formatCanvasContext(snapshot.projectId, snapshot.context));
  }
  if (!tool.build) return toolText("这个工具暂时不可用", true);

  const actions = tool.build(args, nextClientId);
  if (!actions || !actions.length) return toolText("没有生成任何画布操作", true);
  const projectId =
    typeof args.projectId === "string" && args.projectId.trim() ? args.projectId.trim() : undefined;

  let outcome;
  try {
    outcome = await context.broker.enqueue(
      context.ownerId,
      { actions, summary: tool.name, ...(projectId ? { projectId } : {}) },
      context.signal,
    );
  } catch {
    outcome = null;
  }
  if (!outcome) {
    return toolText("画布没有接受这条指令（画布页面可能没有打开，或待办指令过多）", true);
  }
  const label =
    outcome.status === "applied"
      ? `已应用 ${outcome.appliedActions} 项`
      : outcome.status === "partial"
        ? `部分应用：成功 ${outcome.appliedActions} 项，跳过 ${outcome.skippedActions.length} 项`
        : "画布没有接受这组操作";
  const skipped = outcome.skippedActions
    .map((item) => `  - 第 ${item.index} 项：${item.reason}`)
    .join("\n");
  return toolText(
    `${label}${outcome.reason ? `（${outcome.reason}）` : ""}${skipped ? `\n${skipped}` : ""}`,
  );
}

function formatCanvasContext(projectId: string, context: AgentCanvasContext) {
  const lines = [
    `项目：${context.projectName} (${context.projectId || projectId})`,
    `上下文修订：${context.contextRevision}`,
    `节点 ${context.nodeCount}（摘要 ${context.nodes.length}）／连线 ${context.edgeCount}／组合 ${context.groupCount}`,
  ];
  for (const node of context.nodes) {
    const media = node.media ? ` media=${node.media.kind}/${node.media.mimeType}` : "";
    const text = node.text?.trim() ? ` text=${node.text.trim().slice(0, 240)}` : "";
    lines.push(`- ${node.id} (${node.kind})${media}${text}`);
  }
  if (context.edges.length) {
    lines.push("连线：");
    for (const edge of context.edges) lines.push(`- ${edge.source} -> ${edge.target}`);
  }
  return lines.join("\n");
}

function result(id: unknown, value: unknown) {
  return { jsonrpc: "2.0", id, result: value };
}

function toolText(text: string, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}
