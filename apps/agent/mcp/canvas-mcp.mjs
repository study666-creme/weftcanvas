#!/usr/bin/env node
/**
 * 纬线画布 MCP 桥接（stdio）。
 *
 * Codex 用 MCP 启动这个进程，它把 MCP 工具调用转成 Canvas Agent 运行时的
 * 画布指令，等浏览器执行完再返回回执。这里不做任何画布写入，也不持有画布状态。
 *
 * 环境变量：
 *   WEFTCANVAS_AGENT_URL         Agent 运行时地址，默认 http://127.0.0.1:8790
 *   WEFTCANVAS_AGENT_TOKEN       与 AGENT_RUNTIME_TOKEN 相同的令牌（必填）
 *   WEFTCANVAS_CANVAS_PROJECT_ID 可选：固定操作的画布项目；省略时用浏览器当前打开的画布
 */

const AGENT_URL = (process.env.WEFTCANVAS_AGENT_URL?.trim() || "http://127.0.0.1:8790").replace(
  /\/+$/,
  "",
);
const AGENT_TOKEN = process.env.WEFTCANVAS_AGENT_TOKEN?.trim() || "";
const FIXED_PROJECT_ID = process.env.WEFTCANVAS_CANVAS_PROJECT_ID?.trim() || "";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "weftcanvas", version: "1.0.0" };

const projectIdProperty = {
  type: "string",
  description: "画布项目 id；省略时作用于浏览器当前打开的画布",
};

const TOOLS = [
  {
    name: "canvas_read",
    description:
      "读取浏览器当前打开画布的有界摘要（项目、节点 id、正文、连线）。改动画布前先调用它拿到真实节点 id。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    build: () => null,
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
    build: (args, context) => [
      {
        type: "canvas_add_node",
        clientId: context.nextClientId(),
        kind: args.kind,
        ...(typeof args.body === "string" ? { body: args.body } : {}),
        ...(position(args) ? { position: position(args) } : {}),
      },
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
        nodeId: args.nodeId,
        ...(typeof args.body === "string" ? { body: args.body } : {}),
        ...(position(args) ? { position: position(args) } : {}),
      },
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
        sourceNodeId: args.sourceNodeId,
        targetNodeId: args.targetNodeId,
      },
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
    build: (args) => [{ type: "canvas_select_nodes", nodeIds: args.nodeIds }],
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
        nodeIds: args.nodeIds,
        ...(typeof args.name === "string" ? { name: args.name } : {}),
      },
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
      { type: "canvas_set_viewport", viewport: { x: args.x, y: args.y, zoom: args.zoom } },
    ],
  },
];

function position(args) {
  if (typeof args.x !== "number" || typeof args.y !== "number") return null;
  return { x: args.x, y: args.y };
}

let clientSequence = 0;
const context = {
  nextClientId() {
    clientSequence += 1;
    return `codex_${Date.now().toString(36)}_${clientSequence}`;
  },
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function failure(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function toolText(text, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

async function agentRequest(path, init = {}) {
  if (!AGENT_TOKEN) throw new Error("WEFTCANVAS_AGENT_TOKEN 未配置");
  const response = await fetch(`${AGENT_URL}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${AGENT_TOKEN}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || !payload?.ok) {
    const message = payload?.error?.message || `Agent 运行时返回 ${response.status}`;
    throw new Error(message);
  }
  return payload.data;
}

async function readCanvas() {
  const data = await agentRequest("/internal/v1/canvas-context");
  if (!data?.context) {
    return "当前没有可读的画布：请先在浏览器里打开画布页面（画布摘要只在页面打开时上报）。";
  }
  const context = data.context;
  const lines = [
    `项目：${context.projectName} (${context.projectId})`,
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
  if (context.groups.length) {
    lines.push("组合：");
    for (const group of context.groups) lines.push(`- ${group.name}: ${group.nodeIds.join(", ")}`);
  }
  return lines.join("\n");
}

async function callTool(name, args) {
  if (name === "canvas_read") return toolText(await readCanvas());
  const tool = TOOLS.find((item) => item.name === name);
  if (!tool) return toolText(`未知工具 ${name}`, true);
  const actions = tool.build(args ?? {}, context);
  if (!actions || !actions.length) return toolText("没有生成任何画布操作", true);
  const projectId =
    typeof args?.projectId === "string" && args.projectId.trim()
      ? args.projectId.trim()
      : FIXED_PROJECT_ID || undefined;
  try {
    const receipt = await agentRequest("/internal/v1/canvas-commands", {
      method: "POST",
      body: JSON.stringify({
        ...(projectId ? { projectId } : {}),
        summary: `${name}`,
        actions,
      }),
    });
    const label =
      receipt.status === "applied"
        ? `已应用 ${receipt.appliedActions} 项`
        : receipt.status === "partial"
          ? `部分应用：成功 ${receipt.appliedActions} 项，跳过 ${receipt.skippedActions.length} 项`
          : "画布没有接受这组操作";
    const skipped = (receipt.skippedActions ?? [])
      .map((item) => `  - 第 ${item.index} 项：${item.reason}`)
      .join("\n");
    return toolText(
      `${label}${receipt.reason ? `（${receipt.reason}）` : ""}${skipped ? `\n${skipped}` : ""}`,
    );
  } catch (error) {
    return toolText(error instanceof Error ? error.message : "画布指令失败", true);
  }
}

async function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    result(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions:
        "用 canvas_read 先读当前画布；改动画布前确认节点 id。所有写入都由浏览器执行，返回的回执才是真实结果。",
    });
    return;
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "ping") {
    result(id, {});
    return;
  }
  if (method === "tools/list") {
    result(id, {
      tools: TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (typeof name !== "string") {
      result(id, toolText("缺少工具名", true));
      return;
    }
    try {
      result(id, await callTool(name, args));
    } catch (error) {
      result(id, toolText(error instanceof Error ? error.message : "工具调用失败", true));
    }
    return;
  }
  if (id !== undefined && id !== null) failure(id, -32601, `不支持的方法 ${method}`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      try {
        const message = JSON.parse(line);
        void handle(message).catch((error) => {
          if (message?.id !== undefined)
            failure(message.id, -32603, error instanceof Error ? error.message : "内部错误");
        });
      } catch {
        // 忽略无法解析的行：MCP 客户端偶尔会写入日志。
      }
    }
    index = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));
