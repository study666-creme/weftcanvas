import { z } from "zod";

import { agentActionSchema, agentCanvasContextSchema } from "./agent.js";

export const AGENT_CONNECTOR_SCHEMA_VERSION = 1 as const;

/**
 * Agent 的外部连接。两个连接都在本机生效：
 * - codex：把画布暴露给本机 Codex，让它通过 MCP 直接操作画布；
 * - blender：让 Agent 把 Python 交给本机 Blender 执行。
 * 浏览器只负责显示状态与开关，真正的进程/端口探测发生在 Agent 运行时。
 */
export const agentConnectorIds = ["codex", "blender"] as const;
export const agentConnectorIdSchema = z.enum(agentConnectorIds);
export type AgentConnectorId = z.infer<typeof agentConnectorIdSchema>;

/**
 * 连接目标会直达 Agent 运行时的 spawn / net.connect：
 * Codex 的 endpoint 是可执行命令，Blender 的是 host:port。
 * 两类输入都在 schema 层先过一遍形状检查，把 shell 元字符和控制字符
 * （`calc.exe & whoami` 之类）挡在所有消费者之前。
 */
const ENDPOINT_FORBIDDEN_CHARS = /[&|;<>$`"'\u0000-\u001f\u007f]/;

export function connectorEndpointRejectionReason(endpoint: string): string | null {
  if (ENDPOINT_FORBIDDEN_CHARS.test(endpoint)) {
    return "连接目标包含不允许的字符（不能有 & | ; < > $ ` 引号等）";
  }
  return connectorHostRejectionReason(endpoint);
}

/**
 * Blender 目标里的主机名一律按 host:port 形状解析，拒绝链路本地 / 多播 /
 * 未指定地址与云元数据主机——这些是从服务器发起 SSRF 的跳板。
 * 回环与 RFC1918 私网保持放行：自托管场景下 Blender 就在本机或同局域网。
 */
export function connectorHostRejectionReason(endpoint: string): string | null {
  const match = /^\[?([^\]]+?)]?:(\d{1,5})$/.exec(endpoint.trim());
  const host = (match ? (match[1] ?? "") : endpoint.trim()).toLowerCase();
  if (!host) return "连接目标缺少主机名";
  if (host === "metadata.google.internal" || host === "metadata" || host === "instance-data") {
    return "禁止访问云元数据主机";
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const parts = ipv4.slice(1).map(Number);
    if (parts.some((part) => part > 255)) return "连接目标的 IP 地址不合法";
    const first = parts[0] ?? -1;
    const second = parts[1] ?? -1;
    // 169.254/16 链路本地（含 169.254.169.254 云元数据）、多播、保留、未指定。
    if (first === 169 && second === 254) return "禁止访问链路本地地址";
    if (first >= 224) return "禁止访问多播或保留地址";
    if (first === 0) return "禁止访问未指定地址";
    return null;
  }
  const ipv6 = host.replace(/^\[|\]$/g, "");
  if (ipv6.includes(":")) {
    if (
      ipv6 === "::" ||
      ipv6.startsWith("fe8") ||
      ipv6.startsWith("fe9") ||
      ipv6.startsWith("fea") ||
      ipv6.startsWith("feb")
    ) {
      return "禁止访问链路本地 IPv6 地址";
    }
    if (ipv6.startsWith("ff")) return "禁止访问多播 IPv6 地址";
    if (ipv6.startsWith("::ffff:")) {
      return connectorHostRejectionReason(ipv6.slice(7));
    }
  }
  return null;
}

export const agentConnectorStates = ["disabled", "unavailable", "ready", "error"] as const;
export const agentConnectorStateSchema = z.enum(agentConnectorStates);
export type AgentConnectorState = z.infer<typeof agentConnectorStateSchema>;

export const agentConnectorSchema = z
  .object({
    id: agentConnectorIdSchema,
    label: z.string().trim().min(1).max(64),
    /** 一句话说明这个连接用来做什么。 */
    summary: z.string().trim().min(1).max(240),
    enabled: z.boolean(),
    state: agentConnectorStateSchema,
    /** 状态原因的补充说明；不可用时给出可执行的下一步。 */
    detail: z.string().trim().min(1).max(500).nullable().default(null),
    /** 连接目标（Blender 为 host:port；Codex 为空表示走本机 PATH）。 */
    endpoint: z.string().trim().max(240).nullable().default(null),
    /** 连接可用时 Agent 获得的能力，中文短句，逐条展示。 */
    capabilities: z.array(z.string().trim().min(1).max(120)).max(12).default([]),
    /** 供用户在本机完成接入的配置提示（不含任何密钥）。 */
    setup: z.string().trim().max(800).nullable().default(null),
    checkedAt: z.string().datetime({ offset: true }).nullable().default(null),
  })
  .strict();
export type AgentConnector = z.infer<typeof agentConnectorSchema>;

export const agentConnectorListResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z.array(agentConnectorSchema).max(8),
  })
  .strict();

export const agentConnectorUpdateRequestSchema = z
  .object({
    enabled: z.boolean().optional(),
    endpoint: z.string().trim().max(240).nullable().optional(),
  })
  .strict()
  .refine(
    (value) => value.enabled !== undefined || value.endpoint !== undefined,
    "至少需要一项变更",
  )
  .superRefine((value, ctx) => {
    if (value.endpoint === undefined || value.endpoint === null) return;
    const reason = connectorEndpointRejectionReason(value.endpoint);
    if (reason) {
      ctx.addIssue({ code: "custom", message: reason, path: ["endpoint"] });
    }
  });
export type AgentConnectorUpdateRequest = z.infer<typeof agentConnectorUpdateRequestSchema>;

export const agentConnectorResponseSchema = z
  .object({
    ok: z.literal(true),
    data: agentConnectorSchema,
  })
  .strict();

/**
 * 外部连接（目前是 Codex MCP）下发的一条画布指令。浏览器拉取后复用
 * `applyAgentActions` 执行，再把回执发回来，因此外部连接和 Agent 走同一套
 * 画布写入与去重逻辑。
 */
export const canvasControlCommandSchema = z.object({
  schemaVersion: z.literal(AGENT_CONNECTOR_SCHEMA_VERSION),
  id: z.string().uuid(),
  projectId: z.string().trim().min(1).max(128),
  source: agentConnectorIdSchema,
  summary: z.string().trim().min(1).max(200),
  actions: z.array(agentActionSchema).min(1).max(32),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
});
export type CanvasControlCommand = z.infer<typeof canvasControlCommandSchema>;

export const canvasControlPendingResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        commands: z.array(canvasControlCommandSchema).max(16),
      })
      .strict(),
  })
  .strict();

/**
 * 浏览器拉取指令时顺便上报当前画布摘要，外部连接（Codex）因此能看到真实的
 * 节点 id 和连线，而不是瞎猜。摘要只存在本机运行时的内存里。
 */
export const canvasControlPendingRequestSchema = z
  .object({
    projectId: z.string().trim().min(1).max(128),
    context: agentCanvasContextSchema.optional(),
  })
  .strict();
export type CanvasControlPendingRequest = z.infer<typeof canvasControlPendingRequestSchema>;

export const canvasControlSkippedActionSchema = z
  .object({
    index: z.number().int().nonnegative().max(31),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export const canvasControlReceiptRequestSchema = z
  .object({
    commandId: z.string().uuid(),
    status: z.enum(["applied", "partial", "rejected"]),
    appliedActions: z.number().int().nonnegative().max(32),
    skippedActions: z.array(canvasControlSkippedActionSchema).max(32).default([]),
    reason: z.string().trim().min(1).max(500).nullable().default(null),
  })
  .strict();
export type CanvasControlReceiptRequest = z.infer<typeof canvasControlReceiptRequestSchema>;

export const canvasControlReceiptResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z.object({ accepted: z.boolean() }).strict(),
  })
  .strict();

/* ------------------------------------------------ 用户侧反向连接（远程配对） */

/**
 * 托管站点上的正确方向：用户的 Blender / Codex 跑在**用户自己的机器**上，
 * 由它们主动连到 canvas-api，用每个用户独立、可撤销的配对令牌鉴权。
 * 服务端只做"投递 + 回执"，不试图在服务器上找 Blender 或写 Codex 配置。
 */
export const EXTERNAL_CONNECTOR_PROTOCOL_VERSION = 1 as const;

export const externalTaskMethods = ["ping", "run_python"] as const;
export const externalTaskMethodSchema = z.enum(externalTaskMethods);
export type ExternalTaskMethod = z.infer<typeof externalTaskMethodSchema>;

/** 会话鉴权：创建/轮换配对令牌；明文令牌只在这一个响应里出现。 */
export const connectorPairingResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        connectorId: agentConnectorIdSchema,
        token: z.string().min(16).max(200),
        createdAt: z.string().datetime({ offset: true }),
      })
      .strict(),
  })
  .strict();

/** 会话鉴权：每个连接的配对与在线状态。 */
export const connectorClientStatusSchema = z
  .object({
    connectorId: agentConnectorIdSchema,
    paired: z.boolean(),
    connected: z.boolean(),
    pairedAt: z.string().datetime({ offset: true }).nullable(),
    lastSeenAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type ConnectorClientStatus = z.infer<typeof connectorClientStatusSchema>;

export const connectorClientListResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z.array(connectorClientStatusSchema).max(8),
  })
  .strict();

/** 会话鉴权：撤销配对。 */
export const connectorPairingRevokeResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z.object({ revoked: z.boolean() }).strict(),
  })
  .strict();

/** 令牌鉴权：外部客户端轮询待办任务。 */
export const externalPollRequestSchema = z
  .object({
    connectorId: agentConnectorIdSchema,
    /** 客户端标识（机器名/版本），仅用于面板展示，不参与鉴权。 */
    client: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export const externalTaskSchema = z
  .object({
    schemaVersion: z.literal(EXTERNAL_CONNECTOR_PROTOCOL_VERSION),
    id: z.string().uuid(),
    connectorId: agentConnectorIdSchema,
    method: externalTaskMethodSchema,
    params: z.record(z.string(), z.unknown()),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ExternalTask = z.infer<typeof externalTaskSchema>;

export const externalPollResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        tasks: z.array(externalTaskSchema).max(8),
        /** 本轮没有任务时建议的下一轮间隔。 */
        pollAfterMs: z.number().int().min(500).max(30_000),
      })
      .strict(),
  })
  .strict();

/** 令牌鉴权：外部客户端回传任务结果。 */
export const externalTaskResultRequestSchema = z
  .object({
    connectorId: agentConnectorIdSchema,
    taskId: z.string().uuid(),
    ok: z.boolean(),
    stdout: z.string().max(20_000).default(""),
    error: z.string().max(2_000).nullable().default(null),
  })
  .strict();
export type ExternalTaskResultRequest = z.infer<typeof externalTaskResultRequestSchema>;

export const externalTaskResultResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z.object({ accepted: z.boolean() }).strict(),
  })
  .strict();

/**
 * 会话鉴权：在用户自己的机器上跑一条任务并等结果。
 * 面板的「测试连接」用它；Agent 的 blender_run_python 将来复用同一条服务端通道。
 */
export const externalTaskRunRequestSchema = z
  .object({
    connectorId: agentConnectorIdSchema,
    method: externalTaskMethodSchema,
    params: z.record(z.string(), z.unknown()).default({}),
    /** 等待回执的上限；超时返回 timeout，不伪造成功。 */
    waitMs: z.number().int().min(1_000).max(60_000).optional(),
  })
  .strict();
export type ExternalTaskRunRequest = z.infer<typeof externalTaskRunRequestSchema>;

export const externalTaskRunResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        taskId: z.string().uuid(),
        status: z.enum(["completed", "failed", "timeout", "disconnected"]),
        stdout: z.string().max(20_000).default(""),
        error: z.string().max(2_000).nullable().default(null),
      })
      .strict(),
  })
  .strict();
export type ExternalTaskRunResponse = z.infer<typeof externalTaskRunResponseSchema>;
