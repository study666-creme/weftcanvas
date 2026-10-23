import type { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";

import {
  cloudProjectDeleteResponseSchema,
  cloudProjectInvitationListResponseSchema,
  cloudProjectInvitationResponseSchema,
  cloudProjectListResponseSchema,
  cloudProjectMemberListResponseSchema,
  cloudProjectMemberResponseSchema,
  cloudProjectResponseSchema,
} from "@weftcanvas/contracts";

import { errorResponse } from "../http/errors.js";
import { isTrustedBrowserRequest } from "../http/browser-request.js";
import { readJsonBody } from "../http/json-body.js";
import { refreshIdentityCookie, requireIdentitySession } from "../identity/http-session.js";
import type { IdentityCookie } from "../identity/http-session.js";
import type { IdentityProvider } from "../identity/provider.js";
import type { CloudResourceService } from "../media/cloud-resource-service.js";
import {
  collaborationUnavailable,
  cloudProjectsUnavailable,
  optionalProjectOwnerId,
  setCloudProjectEtag,
  type CollaborationApi,
  type ProjectApi,
} from "./api.js";

export type ProjectRouteDependencies = {
  projects?: ProjectApi;
  collaboration?: CollaborationApi;
  cloudResources?: Pick<CloudResourceService, "listProjectBoundMediaIds" | "releaseUnbound">;
  allowedOrigins?: readonly string[];
  identity?: IdentityProvider;
  identityCookie: IdentityCookie;
};

/**
 * 云项目与协作的 HTTP 面（从 app.ts 抽出，纯搬移）：项目 CRUD、成员与邀请。
 * 未注入服务时如实 503（不是"存在但空列表"）。
 */
export function registerProjectRoutes(app: Hono, deps: ProjectRouteDependencies) {
  const { projects, collaboration, cloudResources, allowedOrigins, identity, identityCookie } =
    deps;

  app.get("/api/v1/cloud-projects", async (context) => {
    if (!projects) return cloudProjectsUnavailable(context);
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const result = await projects.list(session.user.id, getCookie(context, identityCookie.name));
    refreshIdentityCookie(context, identityCookie, result);
    return context.json(cloudProjectListResponseSchema.parse({ ok: true, data: result.data }));
  });

  app.post("/api/v1/cloud-projects", async (context) => {
    if (!projects) return cloudProjectsUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "Cloud projects cannot be changed from another site",
      );
    }
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const result = await projects.create(
      session.user.id,
      body,
      getCookie(context, identityCookie.name),
    );
    refreshIdentityCookie(context, identityCookie, result);
    setCloudProjectEtag(context, result.data.id, result.data.revision);
    return context.json(cloudProjectResponseSchema.parse({ ok: true, data: result.data }), 201);
  });

  app.get("/api/v1/cloud-projects/:projectId", async (context) => {
    if (!projects) return cloudProjectsUnavailable(context);
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const projectOwnerId = optionalProjectOwnerId(context.req.query("ownerId"));
    const result = projects.getForActor
      ? await projects.getForActor(
          session.user.id,
          context.req.param("projectId"),
          getCookie(context, identityCookie.name),
          projectOwnerId,
        )
      : await projects.get(
          session.user.id,
          context.req.param("projectId"),
          getCookie(context, identityCookie.name),
        );
    refreshIdentityCookie(context, identityCookie, result);
    setCloudProjectEtag(context, result.data.id, result.data.revision);
    return context.json(cloudProjectResponseSchema.parse({ ok: true, data: result.data }));
  });

  app.put("/api/v1/cloud-projects/:projectId", async (context) => {
    if (!projects) return cloudProjectsUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "Cloud projects cannot be changed from another site",
      );
    }
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const projectOwnerId = optionalProjectOwnerId(context.req.query("ownerId"));
    const result = projects.saveForActor
      ? await projects.saveForActor(
          session.user.id,
          context.req.param("projectId"),
          body,
          getCookie(context, identityCookie.name),
          projectOwnerId,
        )
      : await projects.save(
          session.user.id,
          context.req.param("projectId"),
          body,
          getCookie(context, identityCookie.name),
        );
    refreshIdentityCookie(context, identityCookie, result);
    setCloudProjectEtag(context, result.data.id, result.data.revision);
    return context.json(cloudProjectResponseSchema.parse({ ok: true, data: result.data }));
  });

  app.delete("/api/v1/cloud-projects/:projectId", async (context) => {
    if (!projects) return cloudProjectsUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "Cloud projects cannot be changed from another site",
      );
    }
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const baseRevision = z.coerce
      .number()
      .int()
      .positive()
      .parse(context.req.query("baseRevision"));
    // 项目删除会级联移除绑定关系，但不会删除 canvas_media 记录本身；删除前采集
    // 被该项目绑定的素材，删除后释放其中已无任何项目引用的独占素材（含对象字节），
    // 否则账号存储配额会一直被“已删除画布”的素材占满。
    const boundMediaIds = cloudResources
      ? await cloudResources
          .listProjectBoundMediaIds(session.user.id, context.req.param("projectId"))
          .catch(() => [] as string[])
      : [];
    const result = await projects.delete(
      session.user.id,
      context.req.param("projectId"),
      { baseRevision },
      getCookie(context, identityCookie.name),
    );
    refreshIdentityCookie(context, identityCookie, result);
    if (cloudResources && boundMediaIds.length) {
      await cloudResources.releaseUnbound(session.user.id, boundMediaIds).catch((error) => {
        console.error("Failed to release deleted project media", error);
      });
    }
    return context.json(cloudProjectDeleteResponseSchema.parse(result.data));
  });

  app.get("/api/v1/cloud-projects/:projectId/members", async (context) => {
    if (!collaboration) return collaborationUnavailable(context);
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const projectOwnerId = optionalProjectOwnerId(context.req.query("ownerId"));
    const result = await collaboration.listMembers(
      session.user.id,
      context.req.param("projectId"),
      getCookie(context, identityCookie.name),
      projectOwnerId,
    );
    refreshIdentityCookie(context, identityCookie, result);
    return context.json(
      cloudProjectMemberListResponseSchema.parse({ ok: true, data: result.data }),
    );
  });

  app.post("/api/v1/cloud-projects/:projectId/members/invitations", async (context) => {
    if (!collaboration) return collaborationUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "Project invitations cannot be changed from another site",
      );
    }
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const result = await collaboration.invite(
      session.user.id,
      context.req.param("projectId"),
      body,
      getCookie(context, identityCookie.name),
    );
    refreshIdentityCookie(context, identityCookie, result);
    return context.json(
      cloudProjectInvitationResponseSchema.parse({ ok: true, data: result.data }),
      201,
    );
  });

  app.delete(
    "/api/v1/cloud-projects/:projectId/members/invitations/:invitationId",
    async (context) => {
      if (!collaboration) return collaborationUnavailable(context);
      if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
        return errorResponse(
          context,
          403,
          "CROSS_SITE_REQUEST_REJECTED",
          "Project invitations cannot be changed from another site",
        );
      }
      const session = await requireIdentitySession(context, identity, identityCookie);
      if (session instanceof Response) return session;
      const result = await collaboration.revokeInvitation(
        session.user.id,
        context.req.param("projectId"),
        context.req.param("invitationId"),
      );
      return context.json(cloudProjectDeleteResponseSchema.parse(result.data));
    },
  );

  app.delete("/api/v1/cloud-projects/:projectId/members/:memberId", async (context) => {
    if (!collaboration) return collaborationUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "Project members cannot be changed from another site",
      );
    }
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const result = await collaboration.removeMember(
      session.user.id,
      context.req.param("projectId"),
      context.req.param("memberId"),
      getCookie(context, identityCookie.name),
    );
    refreshIdentityCookie(context, identityCookie, result);
    return context.json(cloudProjectDeleteResponseSchema.parse(result.data));
  });

  app.get("/api/v1/cloud-project-invitations", async (context) => {
    if (!collaboration) return collaborationUnavailable(context);
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const result = await collaboration.listInvitations(
      session.user.id,
      getCookie(context, identityCookie.name),
    );
    refreshIdentityCookie(context, identityCookie, result);
    return context.json(
      cloudProjectInvitationListResponseSchema.parse({ ok: true, data: result.data }),
    );
  });

  app.post("/api/v1/cloud-project-invitations/:invitationId/accept", async (context) => {
    if (!collaboration) return collaborationUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "Project invitations cannot be changed from another site",
      );
    }
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const result = await collaboration.acceptInvitation(
      session.user.id,
      context.req.param("invitationId"),
      getCookie(context, identityCookie.name),
    );
    refreshIdentityCookie(context, identityCookie, result);
    return context.json(cloudProjectMemberResponseSchema.parse({ ok: true, data: result.data }));
  });

  app.delete("/api/v1/cloud-project-invitations/:invitationId", async (context) => {
    if (!collaboration) return collaborationUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "Project invitations cannot be changed from another site",
      );
    }
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const result = await collaboration.declineInvitation(
      session.user.id,
      context.req.param("invitationId"),
    );
    return context.json(cloudProjectDeleteResponseSchema.parse(result.data));
  });
}
