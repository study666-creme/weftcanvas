import type { Hono } from "hono";
import { z } from "zod";

import {
  agentConnectorIdSchema,
  agentConnectorIds,
  connectorClientListResponseSchema,
  connectorPairingResponseSchema,
  externalPollRequestSchema,
  externalPollResponseSchema,
  externalTaskResultRequestSchema,
  externalTaskResultResponseSchema,
  externalTaskRunRequestSchema,
  externalTaskRunResponseSchema,
} from "@weftcanvas/contracts";

import { errorResponse } from "../http/errors.js";
import { isTrustedBrowserRequest } from "../http/browser-request.js";
import { readJsonBody } from "../http/json-body.js";
import { requireIdentitySession, type IdentityCookie } from "../identity/http-session.js";
import type { IdentityProvider } from "../identity/provider.js";
import {
  connectorUnavailable,
  constantTimeEquals,
  readBearerToken,
} from "../agent/connector-http.js";
import { handleCodexMcpMessage } from "./codex-mcp.js";
import type { CanvasCommandBroker } from "./canvas-command-broker.js";
import type { ExternalConnectorService } from "./external-connector-service.js";

const connectorPairingRequestSchema = z
  .object({
    connectorId: agentConnectorIdSchema,
  })
  .strict();

/** 运行时 → API：把一段 Python 派发到用户自己机器上的 Blender。 */
const blenderDispatchRequestSchema = z
  .object({
    ownerId: z.string().trim().min(1).max(128),
    code: z.string().trim().min(1).max(20_000),
  })
  .strict();

export type ConnectorRouteDependencies = {
  externalConnectors?: ExternalConnectorService;
  canvasCommands?: CanvasCommandBroker;
  internalRuntimeToken?: string;
  allowedOrigins?: readonly string[];
  identity?: IdentityProvider;
  identityCookie: IdentityCookie;
};

/**
 * 用户侧反向连接的 HTTP 面（从 app.ts 抽出，纯搬移）。两个方向刻意放在一起：
 *
 * - 会话侧（浏览器，登录 Cookie 鉴权）：连接状态、配对、测试任务。
 * - 令牌侧（用户机器上的客户端，Bearer 配对令牌鉴权）：轮询、回执、MCP，
 *   以及运行时到本 API 的 Blender 派发（共享运行时令牌 + 定长比较）。
 *
 * 会话侧与令牌侧的鉴权方式完全不同，改动时必须看清落在哪一半。
 */
export function registerConnectorRoutes(app: Hono, deps: ConnectorRouteDependencies) {
  const {
    externalConnectors,
    canvasCommands,
    internalRuntimeToken,
    allowedOrigins,
    identity,
    identityCookie,
  } = deps;

  /* ---------------- 用户侧反向连接：会话侧（浏览器） ---------------- */

  app.get("/api/v1/agent/connectors/clients", async (context) => {
    const service = externalConnectors;
    if (!service) return connectorUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点读取连接状态",
      );
    }
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    context.header("Cache-Control", "private, no-store");
    return context.json(
      connectorClientListResponseSchema.parse({
        ok: true,
        data: service.listStatus(session.user.id, agentConnectorIds),
      }),
    );
  });

  app.post("/api/v1/agent/connectors/pairing", async (context) => {
    const service = externalConnectors;
    if (!service) return connectorUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(context, 403, "CROSS_SITE_REQUEST_REJECTED", "无法从其他站点创建配对");
    }
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const input = connectorPairingRequestSchema.safeParse(body);
    if (!input.success) return errorResponse(context, 400, "INVALID_REQUEST", "配对参数无效");
    context.header("Cache-Control", "no-store");
    return context.json(
      connectorPairingResponseSchema.parse({
        ok: true,
        data: service.createPairing(session.user.id, input.data.connectorId),
      }),
    );
  });

  app.delete("/api/v1/agent/connectors/pairing/:connectorId", async (context) => {
    const service = externalConnectors;
    if (!service) return connectorUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(context, 403, "CROSS_SITE_REQUEST_REJECTED", "无法从其他站点撤销配对");
    }
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const connectorId = agentConnectorIdSchema.safeParse(context.req.param("connectorId"));
    if (!connectorId.success)
      return errorResponse(context, 404, "CONNECTOR_NOT_FOUND", "没有这个连接");
    const revoked = service.revokePairing(session.user.id, connectorId.data);
    context.header("Cache-Control", "no-store");
    return context.json({ ok: true, data: { revoked } });
  });

  /** 在用户自己的机器上跑一条任务并等结果（面板「测试连接」用）。 */
  app.post("/api/v1/agent/connectors/tasks", async (context) => {
    const service = externalConnectors;
    if (!service) return connectorUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(context, 403, "CROSS_SITE_REQUEST_REJECTED", "无法从其他站点派发任务");
    }
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const input = externalTaskRunRequestSchema.safeParse(body);
    if (!input.success) return errorResponse(context, 400, "INVALID_REQUEST", "任务参数无效");
    const outcome = await service.runTask(session.user.id, input.data);
    context.header("Cache-Control", "no-store");
    return context.json(externalTaskRunResponseSchema.parse({ ok: true, data: outcome }));
  });

  /* ------------- 用户侧反向连接：令牌侧（用户机器上的客户端） ------------- */

  app.post("/api/external/v1/connectors/poll", async (context) => {
    const service = externalConnectors;
    if (!service) return connectorUnavailable(context);
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const input = externalPollRequestSchema.safeParse(body);
    if (!input.success) return errorResponse(context, 400, "INVALID_REQUEST", "轮询参数无效");
    const token = readBearerToken(context.req.header("authorization"));
    const polled = token ? service.poll({ token, connectorId: input.data.connectorId }) : null;
    if (!polled) {
      return errorResponse(context, 401, "UNAUTHORIZED", "配对令牌无效、已撤销，或与连接不匹配");
    }
    context.header("Cache-Control", "no-store");
    return context.json(
      externalPollResponseSchema.parse({
        ok: true,
        data: { tasks: polled.tasks, pollAfterMs: service.pollAfterMs() },
      }),
    );
  });

  app.post("/api/external/v1/connectors/results", async (context) => {
    const service = externalConnectors;
    if (!service) return connectorUnavailable(context);
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const input = externalTaskResultRequestSchema.safeParse(body);
    if (!input.success) return errorResponse(context, 400, "INVALID_REQUEST", "回执参数无效");
    const token = readBearerToken(context.req.header("authorization"));
    const accepted = token ? service.submitResult(token, input.data) : false;
    if (!accepted) {
      return errorResponse(
        context,
        401,
        "UNAUTHORIZED",
        "配对令牌无效、已撤销，或任务不属于这个连接",
      );
    }
    context.header("Cache-Control", "no-store");
    return context.json(
      externalTaskResultResponseSchema.parse({ ok: true, data: { accepted: true } }),
    );
  });

  /**
   * 运行时 → API：把一段 Python 派发到**用户自己机器**上的 Blender（配对通道）。
   * 用与 Agent 运行时共享的令牌鉴权；服务器上没有也不该有 Blender。
   */
  app.post("/internal/v1/connectors/blender/run", async (context) => {
    const service = externalConnectors;
    const expected = internalRuntimeToken;
    if (!service || !expected) return connectorUnavailable(context);
    const token = readBearerToken(context.req.header("authorization"));
    if (!token || !constantTimeEquals(token, expected)) {
      return errorResponse(context, 401, "UNAUTHORIZED", "Unauthorized");
    }
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const input = blenderDispatchRequestSchema.safeParse(body);
    if (!input.success) return errorResponse(context, 400, "INVALID_REQUEST", "派发参数无效");
    const outcome = await service.runTask(input.data.ownerId, {
      connectorId: "blender",
      method: "run_python",
      params: { code: input.data.code },
      waitMs: 45_000,
    });
    context.header("Cache-Control", "no-store");
    return context.json({ ok: true, data: outcome });
  });

  /**
   * Codex 的远程 MCP 入口。Codex 带自己的配对令牌连到这里，工具调用经队列交给
   * **用户浏览器**执行；服务端不持有画布状态，令牌也只能影响该用户自己的画布。
   */
  app.post("/api/external/v1/mcp", async (context) => {
    const broker = canvasCommands;
    const connectors = externalConnectors;
    if (!broker || !connectors) return connectorUnavailable(context);
    const token = readBearerToken(context.req.header("authorization"));
    const owner = token ? connectors.authenticate(token) : null;
    if (!owner || owner.connectorId !== "codex") {
      return errorResponse(context, 401, "UNAUTHORIZED", "配对令牌无效、已撤销，或不是 Codex 连接");
    }
    // 与全站其它路由一致：强制 JSON Content-Type、1MB 上限、拒绝压缩编码，
    // 避免持令牌客户端用超大 / 非 JSON 请求体消耗服务端资源。
    const message = await readJsonBody(context);
    if (message instanceof Response) return message;
    const response = await handleCodexMcpMessage(message as Record<string, unknown>, {
      ownerId: owner.ownerId,
      broker,
      signal: context.req.raw.signal,
    });
    context.header("Cache-Control", "no-store");
    // 通知没有响应体（MCP 约定 202 + 空体）。
    if (response === null) return context.body(null, 202);
    return context.json(response);
  });
}
