import type { Hono } from "hono";

import {
  agentSkillDeleteResponseSchema,
  agentSkillImportRequestSchema,
  agentSkillListResponseSchema,
  agentSkillResponseSchema,
} from "@weftcanvas/contracts";

import { errorResponse } from "../http/errors.js";
import { isTrustedBrowserRequest } from "../http/browser-request.js";
import { readJsonBody } from "../http/json-body.js";
import { requireIdentitySession, type IdentityCookie } from "../identity/http-session.js";
import type { IdentityProvider } from "../identity/provider.js";
import { AgentSkillStoreError, type AgentSkillStore } from "../skills/store.js";

export type AgentSkillRouteDependencies = {
  agentSkills?: AgentSkillStore;
  allowedOrigins?: readonly string[];
  identity?: IdentityProvider;
  identityCookie: IdentityCookie;
};

/**
 * 用户自导入的 Agent 技能：只有本会话拥有者能看到、导入、删除自己的技能。
 * 技能正文会直接进模型上下文，这里不做任何跨账号读取。存储未注入时整个面 404
 * （与公告/模型覆盖同款）。
 */
export function registerAgentSkillRoutes(app: Hono, deps: AgentSkillRouteDependencies) {
  const { agentSkills, allowedOrigins, identity, identityCookie } = deps;

  app.get("/api/v1/agent/skills", async (context) => {
    if (!agentSkills) return context.notFound();
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const skills = await agentSkills.list(session.user.id);
    context.header("Cache-Control", "no-store");
    return context.json(agentSkillListResponseSchema.parse({ ok: true, data: skills }));
  });

  app.post("/api/v1/agent/skills", async (context) => {
    if (!agentSkills) return context.notFound();
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点导入 Agent 技能",
      );
    }
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const parsed = agentSkillImportRequestSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(context, 422, "INVALID_SKILL", "技能内容格式不正确");
    }
    try {
      const skill = await agentSkills.save(session.user.id, parsed.data.content);
      context.header("Cache-Control", "no-store");
      return context.json(agentSkillResponseSchema.parse({ ok: true, data: skill }), 201);
    } catch (error) {
      if (error instanceof AgentSkillStoreError) {
        const status = error.code === "SKILL_LIMIT_EXCEEDED" ? 409 : 422;
        return errorResponse(context, status, error.code, error.message);
      }
      throw error;
    }
  });

  app.delete("/api/v1/agent/skills/:skillId", async (context) => {
    if (!agentSkills) return context.notFound();
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点删除 Agent 技能",
      );
    }
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const deleted = await agentSkills.remove(session.user.id, context.req.param("skillId"));
    if (!deleted) {
      context.header("Cache-Control", "no-store");
      return errorResponse(context, 404, "SKILL_NOT_FOUND", "没有找到这个技能");
    }
    context.header("Cache-Control", "no-store");
    return context.json(
      agentSkillDeleteResponseSchema.parse({
        ok: true,
        data: { id: context.req.param("skillId"), deleted: true },
      }),
    );
  });
}
