import type { Hono } from "hono";
import { getCookie } from "hono/cookie";

import {
  cloudResourceCleanupRequestSchema,
  cloudResourceCleanupResponseSchema,
  cloudResourceListResponseSchema,
  mediaResponseSchema,
  providerMediaReferenceRequestSchema,
  providerMediaReferenceResponseSchema,
} from "@weftcanvas/contracts";

import { errorResponse } from "../http/errors.js";
import { isTrustedBrowserRequest } from "../http/browser-request.js";
import { readJsonBody } from "../http/json-body.js";
import {
  refreshIdentityCookie,
  requireIdentitySession,
  type IdentityCookie,
} from "../identity/http-session.js";
import type { IdentityProvider } from "../identity/provider.js";
import {
  resolveMediaQuotaBytes,
  resolveProjectMediaAccess,
  type MediaAccessDependencies,
} from "./access.js";
import { mediaUnavailable } from "./http.js";
import { MediaServiceError, type MediaService } from "./service.js";
import type { CloudResourceService } from "./cloud-resource-service.js";
import type { SignedMediaAccess } from "./signed-access.js";

export type MediaLibraryRouteDependencies = MediaAccessDependencies & {
  media?: MediaService;
  signedMedia?: Pick<SignedMediaAccess, "verify" | "createUrl">;
  cloudResources?: Pick<CloudResourceService, "list" | "cleanup">;
  /** 托管生成提供方的公网素材引用通道。 */
  generation?: {
    createProviderReference?(
      ownerId: string,
      mediaId: string,
      kind: "image" | "video" | "audio",
      token?: string,
      projectId?: string,
    ): Promise<{ data: unknown; refreshedToken?: string; expiresAt?: string }>;
  };
  allowedOrigins?: readonly string[];
  identity?: IdentityProvider;
  identityCookie: IdentityCookie;
};

/**
 * 素材库面（从 app.ts 抽出，纯搬移）：云端素材清单、清理、删除，以及给
 * 模型提供方用的公网素材引用。
 */
export function registerMediaLibraryRoutes(app: Hono, deps: MediaLibraryRouteDependencies) {
  const {
    media,
    signedMedia,
    cloudResources,
    generation,
    entitlements,
    projects,
    allowedOrigins,
    identity,
    identityCookie,
  } = deps;
  const accessDeps = { entitlements, projects };

  app.post("/api/v1/media/:mediaId/provider-reference", async (context) => {
    if (!generation?.createProviderReference && (!media || !signedMedia)) {
      return mediaUnavailable(context);
    }
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点创建素材引用",
      );
    }
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const input = providerMediaReferenceRequestSchema.parse(body);
    const mediaId = context.req.param("mediaId");
    const mediaAccess = await resolveProjectMediaAccess(
      context,
      accessDeps,
      identityCookie,
      session.user.id,
      input.projectId,
    );
    if (mediaAccess instanceof Response) return mediaAccess;

    if (generation?.createProviderReference) {
      const result = await generation.createProviderReference(
        mediaAccess.ownerId,
        mediaId,
        input.kind,
        mediaAccess.token,
        input.projectId,
      );
      refreshIdentityCookie(context, identityCookie, result);
      context.header("Cache-Control", "private, no-store");
      return context.json(
        providerMediaReferenceResponseSchema.parse({ ok: true, data: result.data }),
      );
    }

    const found = await media!.get(mediaAccess.ownerId, mediaId, input.projectId);
    if (found.status !== "ready" || found.kind !== input.kind) {
      return errorResponse(context, 409, "MEDIA_NOT_READY", "素材尚未准备完成或类型不匹配");
    }
    let url: string;
    try {
      url = signedMedia!.createUrl(found.id, input.kind);
    } catch {
      return errorResponse(
        context,
        503,
        "REFERENCE_PUBLIC_URL_UNAVAILABLE",
        "公网素材地址尚未配置",
      );
    }
    context.header("Cache-Control", "private, no-store");
    return context.json(providerMediaReferenceResponseSchema.parse({ ok: true, data: { url } }));
  });

  app.get("/api/v1/media", async (context) => {
    if (!cloudResources) return mediaUnavailable(context);
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const quotaBytes = await resolveMediaQuotaBytes(
      context,
      accessDeps,
      session.user.id,
      getCookie(context, identityCookie.name),
      identityCookie,
    );
    const result = await cloudResources.list(session.user.id, quotaBytes);
    context.header("Cache-Control", "private, no-store");
    return context.json(cloudResourceListResponseSchema.parse({ ok: true, data: result }));
  });

  app.post("/api/v1/media/cleanup", async (context) => {
    if (!cloudResources) return mediaUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(context, 403, "CROSS_SITE_REQUEST_REJECTED", "无法从其他站点清理素材");
    }
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const input = cloudResourceCleanupRequestSchema.parse(body);
    const quotaBytes = await resolveMediaQuotaBytes(
      context,
      accessDeps,
      session.user.id,
      getCookie(context, identityCookie.name),
      identityCookie,
    );
    const result = await cloudResources.cleanup(session.user.id, input.mediaIds, quotaBytes, {
      forceUnbound: input.forceUnbound === true,
    });
    return context.json(cloudResourceCleanupResponseSchema.parse({ ok: true, data: result }));
  });

  app.delete("/api/v1/media/:mediaId", async (context) => {
    if (!media) return mediaUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(context, 403, "CROSS_SITE_REQUEST_REJECTED", "无法从其他站点删除素材");
    }
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const mediaAccess = await resolveProjectMediaAccess(
      context,
      accessDeps,
      identityCookie,
      session.user.id,
    );
    if (mediaAccess instanceof Response) return mediaAccess;
    try {
      const deleted = await media.delete(mediaAccess.ownerId, context.req.param("mediaId"));
      return context.json(mediaResponseSchema.parse({ ok: true, data: deleted }));
    } catch (error) {
      if (error instanceof MediaServiceError) {
        return errorResponse(context, error.status, error.code, error.message);
      }
      throw error;
    }
  });
}
