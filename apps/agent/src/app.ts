import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  agentActionSchema,
  agentConnectorIdSchema,
  agentConnectorListResponseSchema,
  agentConnectorResponseSchema,
  agentConnectorUpdateRequestSchema,
  canvasControlPendingResponseSchema,
  canvasControlPendingRequestSchema,
  canvasControlReceiptRequestSchema,
  canvasControlReceiptResponseSchema,
  agentModelCatalogResponseSchema,
  type AgentAction,
  type AgentCanvasContext,
  type AgentConnector,
  type AgentConnectorId,
  type AgentConnectorUpdateRequest,
  type AgentModelCatalog,
  type CanvasControlCommand,
  type CanvasControlReceiptRequest,
} from "@weftcanvas/contracts";

import { createBearerAuth } from "./auth.js";
import type { CanvasControlEnqueueResult } from "./canvas-control.js";
import type { AgentRunHandler } from "./run-handler.js";

export type AgentConnectorApi = {
  list(signal?: AbortSignal): Promise<AgentConnector[]>;
  update(id: AgentConnectorId, patch: AgentConnectorUpdateRequest): Promise<AgentConnector>;
  /** 一键接入：按需写 Codex 配置 / 安装 Blender 插件。 */
  connect(
    id: AgentConnectorId,
    options: { launch?: boolean },
    signal?: AbortSignal,
  ): Promise<AgentConnector>;
};

export type AgentCanvasControlApi = {
  enqueue(
    input: { projectId: string; actions: AgentAction[]; summary: string; source: AgentConnectorId },
    signal?: AbortSignal,
  ): Promise<CanvasControlEnqueueResult>;
  pendingFor(projectId: string, context?: AgentCanvasContext): CanvasControlCommand[];
  settle(receipt: CanvasControlReceiptRequest): boolean;
  activeProjectId(): string | null;
  activeContext(): AgentCanvasContext | null;
};

export type AgentAppDependencies = {
  token: string;
  models: { getCatalog(): AgentModelCatalog };
  runs: Pick<AgentRunHandler, "handle">;
  connectors?: AgentConnectorApi;
  canvasControl?: AgentCanvasControlApi;
};

const canvasCommandRequestSchema = z
  .object({
    /** 省略时使用当前打开的画布。 */
    projectId: z.string().trim().min(1).max(128).optional(),
    summary: z.string().trim().min(1).max(200).optional(),
    actions: z.array(agentActionSchema).min(1).max(32),
  })
  .strict();

const connectorConnectRequestSchema = z
  .object({
    /** Blender 接入时是否顺手把 Blender 启动起来。 */
    launch: z.boolean().optional(),
  })
  .strict();

export function createAgentApp(dependencies: AgentAppDependencies) {
  const authorize = createBearerAuth(dependencies.token);
  const app = new Hono();

  app.get("/healthz", (context) => context.json({ ok: true, service: "canvas-agent" }));

  app.get("/internal/v1/models", (context) => {
    if (!authorize(context.req.header("authorization"))) {
      return context.json(
        { ok: false, error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
        401,
      );
    }
    context.header("Cache-Control", "no-store");
    return context.json(
      agentModelCatalogResponseSchema.parse({ ok: true, data: dependencies.models.getCatalog() }),
    );
  });

  app.post("/internal/v1/runs", async (context) => {
    if (!authorize(context.req.header("authorization"))) {
      return unauthorized(context);
    }

    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json(
        { ok: false, error: { code: "INVALID_JSON", message: "请求体必须是 JSON" } },
        400,
      );
    }

    const result = await dependencies.runs.handle(body, context.req.raw.signal);
    return context.json(result.body, result.status);
  });

  app.get("/internal/v1/connectors", async (context) => {
    if (!authorize(context.req.header("authorization"))) return unauthorized(context);
    if (!dependencies.connectors) {
      return context.json(
        { ok: false, error: { code: "CONNECTORS_UNAVAILABLE", message: "连接器未启用" } },
        503,
      );
    }
    context.header("Cache-Control", "no-store");
    const connectors = await dependencies.connectors.list(context.req.raw.signal);
    return context.json(agentConnectorListResponseSchema.parse({ ok: true, data: connectors }));
  });

  app.put("/internal/v1/connectors/:connectorId", async (context) => {
    if (!authorize(context.req.header("authorization"))) return unauthorized(context);
    if (!dependencies.connectors) {
      return context.json(
        { ok: false, error: { code: "CONNECTORS_UNAVAILABLE", message: "连接器未启用" } },
        503,
      );
    }
    const id = agentConnectorIdSchema.safeParse(context.req.param("connectorId"));
    if (!id.success) {
      return context.json(
        { ok: false, error: { code: "CONNECTOR_NOT_FOUND", message: "没有这个连接" } },
        404,
      );
    }
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json(
        { ok: false, error: { code: "INVALID_JSON", message: "请求体必须是 JSON" } },
        400,
      );
    }
    const patch = agentConnectorUpdateRequestSchema.safeParse(body);
    if (!patch.success) {
      return context.json(
        { ok: false, error: { code: "INVALID_REQUEST", message: "连接设置无效" } },
        400,
      );
    }
    context.header("Cache-Control", "no-store");
    const connector = await dependencies.connectors.update(id.data, patch.data);
    return context.json(agentConnectorResponseSchema.parse({ ok: true, data: connector }));
  });

  /**
   * 一键接入。普通用户只需要点一下：运行时自己写 Codex 配置、自己把 Blender 插件装好
   * 并按需启动 Blender，返回的 detail 里带上"还需做什么"。
   */
  app.post("/internal/v1/connectors/:connectorId/connect", async (context) => {
    if (!authorize(context.req.header("authorization"))) return unauthorized(context);
    if (!dependencies.connectors) {
      return context.json(
        { ok: false, error: { code: "CONNECTORS_UNAVAILABLE", message: "连接器未启用" } },
        503,
      );
    }
    const id = agentConnectorIdSchema.safeParse(context.req.param("connectorId"));
    if (!id.success) {
      return context.json(
        { ok: false, error: { code: "CONNECTOR_NOT_FOUND", message: "没有这个连接" } },
        404,
      );
    }
    let body: unknown = {};
    const raw = await context.req.text().catch(() => "");
    if (raw.trim()) {
      try {
        body = JSON.parse(raw);
      } catch {
        return context.json(
          { ok: false, error: { code: "INVALID_JSON", message: "请求体必须是 JSON" } },
          400,
        );
      }
    }
    const input = connectorConnectRequestSchema.safeParse(body);
    if (!input.success) {
      return context.json(
        { ok: false, error: { code: "INVALID_REQUEST", message: "接入参数无效" } },
        400,
      );
    }
    context.header("Cache-Control", "no-store");
    const connector = await dependencies.connectors.connect(
      id.data,
      input.data,
      context.req.raw.signal,
    );
    return context.json(agentConnectorResponseSchema.parse({ ok: true, data: connector }));
  });

  app.post("/internal/v1/canvas-control/pending", async (context) => {
    if (!authorize(context.req.header("authorization"))) return unauthorized(context);
    if (!dependencies.canvasControl) {
      return context.json(
        { ok: false, error: { code: "CANVAS_CONTROL_UNAVAILABLE", message: "画布通道未启用" } },
        503,
      );
    }
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json(
        { ok: false, error: { code: "INVALID_JSON", message: "请求体必须是 JSON" } },
        400,
      );
    }
    const input = canvasControlPendingRequestSchema.safeParse(body);
    if (!input.success) {
      return context.json(
        { ok: false, error: { code: "INVALID_REQUEST", message: "缺少画布项目" } },
        400,
      );
    }
    context.header("Cache-Control", "no-store");
    const commands = dependencies.canvasControl.pendingFor(
      input.data.projectId,
      input.data.context,
    );
    return context.json(canvasControlPendingResponseSchema.parse({ ok: true, data: { commands } }));
  });

  /** 外部连接读取当前画布摘要（由浏览器在拉取指令时上报）。 */
  app.get("/internal/v1/canvas-context", (context) => {
    if (!authorize(context.req.header("authorization"))) return unauthorized(context);
    if (!dependencies.canvasControl) {
      return context.json(
        { ok: false, error: { code: "CANVAS_CONTROL_UNAVAILABLE", message: "画布通道未启用" } },
        503,
      );
    }
    context.header("Cache-Control", "no-store");
    return context.json({
      ok: true,
      data: {
        projectId: dependencies.canvasControl.activeProjectId(),
        context: dependencies.canvasControl.activeContext(),
      },
    });
  });

  app.post("/internal/v1/canvas-control/receipts", async (context) => {
    if (!authorize(context.req.header("authorization"))) return unauthorized(context);
    if (!dependencies.canvasControl) {
      return context.json(
        { ok: false, error: { code: "CANVAS_CONTROL_UNAVAILABLE", message: "画布通道未启用" } },
        503,
      );
    }
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json(
        { ok: false, error: { code: "INVALID_JSON", message: "请求体必须是 JSON" } },
        400,
      );
    }
    const receipt = canvasControlReceiptRequestSchema.safeParse(body);
    if (!receipt.success) {
      return context.json(
        { ok: false, error: { code: "INVALID_REQUEST", message: "回执无效" } },
        400,
      );
    }
    context.header("Cache-Control", "no-store");
    return context.json(
      canvasControlReceiptResponseSchema.parse({
        ok: true,
        data: { accepted: dependencies.canvasControl.settle(receipt.data) },
      }),
    );
  });

  /**
   * Codex MCP 桥接调用：入队一条画布指令并等待浏览器回执。
   * 画布页面没有打开时这里会超时，返回明确的失败而不是伪造成功。
   */
  app.post("/internal/v1/canvas-commands", async (context) => {
    if (!authorize(context.req.header("authorization"))) return unauthorized(context);
    if (!dependencies.canvasControl) {
      return context.json(
        { ok: false, error: { code: "CANVAS_CONTROL_UNAVAILABLE", message: "画布通道未启用" } },
        503,
      );
    }
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json(
        { ok: false, error: { code: "INVALID_JSON", message: "请求体必须是 JSON" } },
        400,
      );
    }
    const input = canvasCommandRequestSchema.safeParse(body);
    if (!input.success) {
      return context.json(
        { ok: false, error: { code: "INVALID_REQUEST", message: "画布指令不符合契约" } },
        400,
      );
    }
    const projectId = input.data.projectId ?? dependencies.canvasControl.activeProjectId();
    if (!projectId) {
      return context.json(
        {
          ok: false,
          error: {
            code: "CANVAS_NOT_OPEN",
            message: "没有检测到已打开的画布页面，请先在浏览器里打开画布",
          },
        },
        409,
      );
    }
    const result = await dependencies.canvasControl.enqueue(
      {
        projectId,
        actions: input.data.actions,
        summary: input.data.summary ?? "Codex 请求的画布操作",
        source: "codex",
      },
      context.req.raw.signal,
    );
    if (!result.ok) {
      return context.json(
        { ok: false, error: { code: "CANVAS_COMMAND_FAILED", message: result.error } },
        409,
      );
    }
    return context.json({ ok: true, data: result.receipt });
  });

  return app;
}

function unauthorized(context: Context) {
  return context.json({ ok: false, error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, 401);
}
