import type { Hono } from "hono";
import { getCookie } from "hono/cookie";

import {
  agentConversationDetailResponseSchema,
  agentConversationListResponseSchema,
  agentConversationResponseSchema,
  agentModelCatalogResponseSchema,
} from "@weftcanvas/contracts";

import { errorResponse, optionalQueryInteger } from "../http/errors.js";
import { isTrustedBrowserRequest } from "../http/browser-request.js";
import { readJsonBody } from "../http/json-body.js";
import { anonymousAgentRateLimited, type AnonymousAgentGuard } from "../http/rate-limit.js";
import type { IdentityCookie } from "../identity/http-session.js";
import { agentUnavailable, resolveAgentAccess, type AgentAccessDependencies } from "./api.js";

export type AgentConversationRouteDependencies = AgentAccessDependencies & {
  allowedOrigins?: readonly string[];
  identityCookie: IdentityCookie;
  anonymousAgentGuard: Pick<
    AnonymousAgentGuard,
    "consumeRead" | "consumeConversation" | "consumeSubmission"
  >;
};

/**
 * Agent 会话面（从 app.ts 抽出，纯搬移）：模型目录、会话列表/创建/详情、
 * 提交任务、取消、提案确认/驳回、执行回执。鉴权与限流顺序保持原样。
 */
export function registerAgentConversationRoutes(
  app: Hono,
  deps: AgentConversationRouteDependencies,
) {
  const { agent, anonymousAgent, allowedOrigins, identityCookie, anonymousAgentGuard } = deps;

  const agentConfigured = () => Boolean(agent || anonymousAgent);

  app.get("/api/v1/agent/models", async (context) => {
    if (!agentConfigured()) return agentUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点读取 Agent 模型",
      );
    }
    const access = await resolveAgentAccess(context, deps, identityCookie);
    if (access instanceof Response) return access;
    if (access.anonymous) {
      const limited = anonymousAgentGuard.consumeRead(access.ownerId);
      if (limited) return anonymousAgentRateLimited(context, limited);
    }
    const catalog = await access.agent.getModels(access.ownerId);
    context.header("Cache-Control", "private, max-age=60, stale-while-revalidate=300");
    return context.json(agentModelCatalogResponseSchema.parse({ ok: true, data: catalog }));
  });

  app.get("/api/v1/agent/conversations", async (context) => {
    if (!agentConfigured()) return agentUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点读取 Agent 对话",
      );
    }
    const access = await resolveAgentAccess(context, deps, identityCookie);
    if (access instanceof Response) return access;
    if (access.anonymous) {
      const limited = anonymousAgentGuard.consumeRead(access.ownerId);
      if (limited) return anonymousAgentRateLimited(context, limited);
    }
    const projectId = context.req.query("projectId");
    if (!projectId) return errorResponse(context, 400, "PROJECT_ID_REQUIRED", "缺少画布项目信息");
    const limit = optionalQueryInteger(context, context.req.query("limit"), 30);
    if (limit instanceof Response) return limit;
    const conversations = await access.agent.listConversations(access.ownerId, projectId, limit);
    context.header("Cache-Control", "private, no-store");
    return context.json(
      agentConversationListResponseSchema.parse({ ok: true, data: conversations }),
    );
  });

  app.post("/api/v1/agent/conversations", async (context) => {
    if (!agentConfigured()) return agentUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点创建 Agent 对话",
      );
    }
    const access = await resolveAgentAccess(context, deps, identityCookie);
    if (access instanceof Response) return access;
    if (access.anonymous) {
      const limited = anonymousAgentGuard.consumeRead(access.ownerId);
      if (limited) return anonymousAgentRateLimited(context, limited);
    }
    if (access.anonymous) {
      const limited = anonymousAgentGuard.consumeConversation(access.ownerId);
      if (limited) return anonymousAgentRateLimited(context, limited);
    }
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const conversation = await access.agent.createConversation(access.ownerId, body);
    context.header("Cache-Control", "no-store");
    return context.json(
      agentConversationResponseSchema.parse({ ok: true, data: conversation }),
      201,
    );
  });

  app.get("/api/v1/agent/conversations/:conversationId", async (context) => {
    if (!agentConfigured()) return agentUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点读取 Agent 对话",
      );
    }
    const access = await resolveAgentAccess(context, deps, identityCookie);
    if (access instanceof Response) return access;
    const detail = await access.agent.getDetail(
      access.ownerId,
      context.req.param("conversationId"),
    );
    context.header("Cache-Control", "private, no-store");
    return context.json(agentConversationDetailResponseSchema.parse({ ok: true, data: detail }));
  });

  app.post("/api/v1/agent/conversations/:conversationId/messages", async (context) => {
    if (!agentConfigured()) return agentUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点提交 Agent 任务",
      );
    }
    const access = await resolveAgentAccess(context, deps, identityCookie);
    if (access instanceof Response) return access;
    if (access.anonymous) {
      const limited = anonymousAgentGuard.consumeSubmission(access.ownerId);
      if (limited) return anonymousAgentRateLimited(context, limited);
    }
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const detail = await access.agent.submitMessage(
      access.ownerId,
      context.req.param("conversationId"),
      body,
      getCookie(context, identityCookie.name),
    );
    context.header("Cache-Control", "no-store");
    return context.json(
      agentConversationDetailResponseSchema.parse({ ok: true, data: detail }),
      202,
    );
  });

  app.post("/api/v1/agent/conversations/:conversationId/runs/:runId/cancel", async (context) => {
    if (!agentConfigured()) return agentUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点取消 Agent 任务",
      );
    }
    const access = await resolveAgentAccess(context, deps, identityCookie);
    if (access instanceof Response) return access;
    await access.agent.cancelRun(
      access.ownerId,
      context.req.param("runId"),
      getCookie(context, identityCookie.name),
    );
    const detail = await access.agent.getDetail(
      access.ownerId,
      context.req.param("conversationId"),
    );
    context.header("Cache-Control", "no-store");
    return context.json(agentConversationDetailResponseSchema.parse({ ok: true, data: detail }));
  });

  app.post(
    "/api/v1/agent/conversations/:conversationId/runs/:runId/proposal/confirm",
    async (context) => {
      if (!agentConfigured()) return agentUnavailable(context);
      if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
        return errorResponse(
          context,
          403,
          "CROSS_SITE_REQUEST_REJECTED",
          "无法从其他站点确认 Agent 提案",
        );
      }
      const access = await resolveAgentAccess(context, deps, identityCookie);
      if (access instanceof Response) return access;
      const body = await readJsonBody(context);
      if (body instanceof Response) return body;
      const detail = await access.agent.confirmProposal(
        access.ownerId,
        context.req.param("conversationId"),
        context.req.param("runId"),
        body,
      );
      context.header("Cache-Control", "no-store");
      return context.json(agentConversationDetailResponseSchema.parse({ ok: true, data: detail }));
    },
  );

  app.post(
    "/api/v1/agent/conversations/:conversationId/runs/:runId/proposal/dismiss",
    async (context) => {
      if (!agentConfigured()) return agentUnavailable(context);
      if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
        return errorResponse(
          context,
          403,
          "CROSS_SITE_REQUEST_REJECTED",
          "无法从其他站点取消 Agent 提案",
        );
      }
      const access = await resolveAgentAccess(context, deps, identityCookie);
      if (access instanceof Response) return access;
      const detail = await access.agent.dismissProposal(
        access.ownerId,
        context.req.param("conversationId"),
        context.req.param("runId"),
      );
      context.header("Cache-Control", "no-store");
      return context.json(agentConversationDetailResponseSchema.parse({ ok: true, data: detail }));
    },
  );

  app.post("/api/v1/agent/conversations/:conversationId/runs/:runId/receipt", async (context) => {
    if (!agentConfigured()) return agentUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点提交 Agent 执行回执",
      );
    }
    const access = await resolveAgentAccess(context, deps, identityCookie);
    if (access instanceof Response) return access;
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const detail = await access.agent.recordReceipt(
      access.ownerId,
      context.req.param("conversationId"),
      context.req.param("runId"),
      body,
    );
    context.header("Cache-Control", "no-store");
    return context.json(agentConversationDetailResponseSchema.parse({ ok: true, data: detail }));
  });
}
