import type { Hono } from "hono";
import { z } from "zod";

import {
  agentConnectorIdSchema,
  agentConnectorListResponseSchema,
  agentConnectorResponseSchema,
  agentConnectorUpdateRequestSchema,
  canvasControlPendingRequestSchema,
  canvasControlPendingResponseSchema,
  canvasControlReceiptRequestSchema,
  canvasControlReceiptResponseSchema,
} from "@weftcanvas/contracts";

import { errorResponse } from "../http/errors.js";
import { isTrustedBrowserRequest } from "../http/browser-request.js";
import { readJsonBody } from "../http/json-body.js";
import { requireIdentitySession, type IdentityCookie } from "../identity/http-session.js";
import type { IdentityProvider } from "../identity/provider.js";
import type { AgentConnectorGateway } from "./connector-gateway.js";
import type { CanvasCommandBroker } from "../connectors/canvas-command-broker.js";
import { connectorFailure, connectorUnavailable } from "./connector-http.js";

const connectorConnectRequestSchema = z
  .object({
    /** Blender 接入时是否顺手把 Blender 启动起来。 */
    launch: z.boolean().optional(),
  })
  .strict();

export type AgentConnectorRouteDependencies = {
  connectors?: AgentConnectorGateway;
  canvasCommands?: CanvasCommandBroker;
  allowedOrigins?: readonly string[];
  identity?: IdentityProvider;
  identityCookie: IdentityCookie;
};

/**
 * 浏览器侧的本机连接入口（从 app.ts 抽出，纯搬移）：连接器列表/设置/接入，
 * 以及画布页面轮询与回执。全部走登录会话鉴权 + 跨站请求门。
 */
export function registerAgentConnectorRoutes(app: Hono, deps: AgentConnectorRouteDependencies) {
  const { connectors, canvasCommands, allowedOrigins, identity, identityCookie } = deps;

  app.get("/api/v1/agent/connectors", async (context) => {
    const gateway = connectors;
    if (!gateway) return connectorUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点读取本机连接",
      );
    }
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    try {
      const list = await gateway.list(context.req.raw.signal);
      context.header("Cache-Control", "private, no-store");
      return context.json(agentConnectorListResponseSchema.parse({ ok: true, data: list }));
    } catch (error) {
      return connectorFailure(context, error);
    }
  });

  app.put("/api/v1/agent/connectors/:connectorId", async (context) => {
    const gateway = connectors;
    if (!gateway) return connectorUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点修改本机连接",
      );
    }
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const connectorId = agentConnectorIdSchema.safeParse(context.req.param("connectorId"));
    if (!connectorId.success)
      return errorResponse(context, 404, "CONNECTOR_NOT_FOUND", "没有这个连接");
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const patch = agentConnectorUpdateRequestSchema.safeParse(body);
    if (!patch.success) return errorResponse(context, 400, "INVALID_REQUEST", "连接设置无效");
    try {
      const connector = await gateway.update(connectorId.data, patch.data, context.req.raw.signal);
      context.header("Cache-Control", "private, no-store");
      return context.json(agentConnectorResponseSchema.parse({ ok: true, data: connector }));
    } catch (error) {
      return connectorFailure(context, error);
    }
  });

  app.post("/api/v1/agent/connectors/:connectorId/connect", async (context) => {
    const gateway = connectors;
    if (!gateway) return connectorUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点接入本机连接",
      );
    }
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const connectorId = agentConnectorIdSchema.safeParse(context.req.param("connectorId"));
    if (!connectorId.success)
      return errorResponse(context, 404, "CONNECTOR_NOT_FOUND", "没有这个连接");
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const input = connectorConnectRequestSchema.safeParse(body);
    if (!input.success) return errorResponse(context, 400, "INVALID_REQUEST", "接入参数无效");
    try {
      const connector = await gateway.connect(connectorId.data, input.data, context.req.raw.signal);
      context.header("Cache-Control", "private, no-store");
      return context.json(agentConnectorResponseSchema.parse({ ok: true, data: connector }));
    } catch (error) {
      return connectorFailure(context, error);
    }
  });

  /**
   * 画布页面轮询：上报当前画布摘要并取回外部连接下发的指令。
   * 指令由浏览器用与 Agent 相同的 applyAgentActions 执行，再回执。
   */
  app.post("/api/v1/agent/canvas-control/pending", async (context) => {
    const gateway = connectors;
    const broker = canvasCommands;
    if (!gateway && !broker) return connectorUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点读取画布指令",
      );
    }
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const input = canvasControlPendingRequestSchema.safeParse(body);
    if (!input.success) return errorResponse(context, 400, "INVALID_REQUEST", "缺少画布项目");

    const ownerId = session.user.id;
    // 浏览器上报的画布摘要：托管站点上 Codex 的 canvas_read 靠它读到真实节点 id。
    broker?.rememberContext(ownerId, input.data.projectId, input.data.context);

    const commands = (broker?.pendingFor(ownerId) ?? []).filter(
      (command) => command.projectId === input.data.projectId,
    );
    if (gateway) {
      try {
        commands.push(
          ...(await gateway.pending(
            input.data.projectId,
            input.data.context,
            context.req.raw.signal,
          )),
        );
      } catch {
        // 本机运行时不可达不该影响托管站点的外部连接通道。
      }
    }
    context.header("Cache-Control", "private, no-store");
    return context.json(canvasControlPendingResponseSchema.parse({ ok: true, data: { commands } }));
  });

  app.post("/api/v1/agent/canvas-control/receipts", async (context) => {
    const gateway = connectors;
    const broker = canvasCommands;
    if (!gateway && !broker) return connectorUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点提交画布回执",
      );
    }
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const receipt = canvasControlReceiptRequestSchema.safeParse(body);
    if (!receipt.success) return errorResponse(context, 400, "INVALID_REQUEST", "回执无效");
    // 先结算托管队列；不是它的指令再转给本机运行时。
    const accepted = broker?.submitReceipt(session.user.id, receipt.data) ?? false;
    if (!accepted && gateway) {
      try {
        const forwarded = await gateway.recordReceipt(receipt.data, context.req.raw.signal);
        context.header("Cache-Control", "no-store");
        return context.json(
          canvasControlReceiptResponseSchema.parse({ ok: true, data: { accepted: forwarded } }),
        );
      } catch (error) {
        return connectorFailure(context, error);
      }
    }
    context.header("Cache-Control", "no-store");
    return context.json(canvasControlReceiptResponseSchema.parse({ ok: true, data: { accepted } }));
  });
}
