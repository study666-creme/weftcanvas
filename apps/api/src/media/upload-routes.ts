import type { Hono } from "hono";

import {
  MEDIA_MULTIPART_THRESHOLD,
  mediaMultipartAbortRequestSchema,
  mediaMultipartAbortResponseSchema,
  mediaMultipartCompleteRequestSchema,
  mediaMultipartCompleteResponseSchema,
  mediaMultipartPartSignRequestSchema,
  mediaMultipartPartInstructionsResponseSchema,
  mediaMultipartUploadStateResponseSchema,
  mediaProjectIdSchema,
  mediaResponseSchema,
  mediaUploadIntentSchema,
  mediaUploadIntentResponseSchema,
  mediaUploadRequestSchema,
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
  mediaProjectUrl,
  resolveProjectMediaAccess,
  scopeMediaUploadIntent,
  type MediaAccessDependencies,
} from "./access.js";
import { mediaUnavailable, readContentLength } from "./http.js";
import type { MediaService } from "./service.js";
import type { MediaMultipartService } from "./multipart-service.js";

export type MediaUploadRouteDependencies = MediaAccessDependencies & {
  media?: MediaService;
  multipartMedia?: Pick<
    MediaMultipartService,
    "createUpload" | "signParts" | "getState" | "complete" | "abort"
  >;
  /** 托管生成提供方的参考素材通道（未接本地素材服务时使用）。 */
  generation?: {
    createReferenceUpload?(ownerId: string, value: unknown, token?: string): Promise<unknown>;
    uploadReference?(
      ownerId: string,
      mediaId: string,
      source: AsyncIterable<Uint8Array>,
      token?: string,
      contentType?: string,
      contentLength?: number | null,
      projectId?: string,
    ): Promise<unknown>;
  };
  allowedOrigins?: readonly string[];
  identity?: IdentityProvider;
  identityCookie: IdentityCookie;
};

/**
 * 素材写入面（从 app.ts 抽出，纯搬移）：创建上传意图、直传内容、确认完成，
 * 以及分片上传的签发/状态/完成/中止。项目作用域通过 `projectId` 查询参数
 * 进入访问解析，上传意图里的项目参数由 `scopeMediaUploadIntent` 补齐。
 */
export function registerMediaUploadRoutes(app: Hono, deps: MediaUploadRouteDependencies) {
  const {
    media,
    multipartMedia,
    generation,
    entitlements,
    projects,
    allowedOrigins,
    identity,
    identityCookie,
  } = deps;
  const accessDeps = { entitlements, projects };

  app.post("/api/v1/media/uploads", async (context) => {
    const mediaService = media;
    if (!mediaService && !generation?.createReferenceUpload) return mediaUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(context, 403, "CROSS_SITE_REQUEST_REJECTED", "无法从其他站点上传素材");
    }
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const input = mediaUploadRequestSchema.parse(body);
    const mediaAccess = await resolveProjectMediaAccess(
      context,
      accessDeps,
      identityCookie,
      session.user.id,
      input.projectId,
    );
    if (mediaAccess instanceof Response) return mediaAccess;
    if (!mediaService && generation?.createReferenceUpload) {
      const result = (await generation.createReferenceUpload(
        mediaAccess.ownerId,
        input,
        mediaAccess.token,
      )) as { data: unknown; refreshedToken?: string; expiresAt?: string };
      refreshIdentityCookie(context, identityCookie, result);
      context.header("Cache-Control", "no-store");
      return context.json(
        mediaUploadIntentResponseSchema.parse({
          ok: true,
          data: scopeMediaUploadIntent(mediaUploadIntentSchema.parse(result.data), input.projectId),
        }),
      );
    }
    const resolvedEntitlements = input.projectId
      ? undefined
      : await entitlements?.resolve(mediaAccess.ownerId, mediaAccess.token, {
          allowStale: false,
        });
    if (resolvedEntitlements) refreshIdentityCookie(context, identityCookie, resolvedEntitlements);
    const created = await mediaService!.createUpload(
      mediaAccess.ownerId,
      input,
      mediaAccess.mediaStorageBytes ?? resolvedEntitlements?.data.mediaStorageBytes,
    );
    const multipartUpload =
      created.uploadRequired && created.media.size >= MEDIA_MULTIPART_THRESHOLD
        ? ((await multipartMedia?.createUpload(
            mediaAccess.ownerId,
            created.media.id,
            input.projectId,
          )) ?? null)
        : null;
    const directUpload =
      created.uploadRequired && !multipartUpload
        ? await mediaService!.createDirectUploadInstruction(
            mediaAccess.ownerId,
            created.media.id,
            input.projectId,
          )
        : null;
    const upload = created.uploadRequired
      ? (multipartUpload ??
        (directUpload
          ? {
              ...directUpload,
              completeUrl: mediaProjectUrl(
                `/api/v1/media/${created.media.id}/complete`,
                input.projectId,
              ),
            }
          : {
              method: "PUT" as const,
              url: mediaProjectUrl(`/api/v1/media/${created.media.id}/content`, input.projectId),
              headers: { "Content-Type": created.contentType },
              expiresAt: created.uploadExpiresAt,
              completeUrl: null,
            }))
      : null;
    context.header("Cache-Control", "no-store");
    return context.json(
      mediaUploadIntentResponseSchema.parse({
        ok: true,
        data: scopeMediaUploadIntent({ media: created.media, upload }, input.projectId),
      }),
    );
  });

  app.put("/api/v1/media/:mediaId/content", async (context) => {
    const mediaService = media;
    if (!mediaService && !generation?.uploadReference) return mediaUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(context, 403, "CROSS_SITE_REQUEST_REJECTED", "无法从其他站点上传素材");
    }
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const projectId = mediaProjectIdSchema.optional().parse(context.req.query("projectId"));
    const mediaAccess = await resolveProjectMediaAccess(
      context,
      accessDeps,
      identityCookie,
      session.user.id,
      projectId,
    );
    if (mediaAccess instanceof Response) return mediaAccess;
    const source = context.req.raw.body;
    if (!source) return errorResponse(context, 400, "MEDIA_BODY_REQUIRED", "上传内容为空");
    if (!mediaService && generation?.uploadReference) {
      const result = (await generation.uploadReference(
        mediaAccess.ownerId,
        context.req.param("mediaId"),
        source as ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>,
        mediaAccess.token,
        context.req.header("Content-Type"),
        readContentLength(context.req.header("Content-Length")),
        projectId,
      )) as { data: unknown; refreshedToken?: string; expiresAt?: string };
      refreshIdentityCookie(context, identityCookie, result);
      context.header("Cache-Control", "no-store");
      return context.json(mediaResponseSchema.parse({ ok: true, data: result.data }));
    }
    const uploaded = await mediaService!.upload(
      mediaAccess.ownerId,
      context.req.param("mediaId"),
      source as ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>,
      {
        contentType: context.req.header("Content-Type"),
        contentLength: readContentLength(context.req.header("Content-Length")),
      },
      projectId,
    );
    context.header("Cache-Control", "no-store");
    return context.json(mediaResponseSchema.parse({ ok: true, data: uploaded }));
  });

  app.post("/api/v1/media/:mediaId/complete", async (context) => {
    if (!media) return mediaUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(context, 403, "CROSS_SITE_REQUEST_REJECTED", "无法从其他站点确认素材");
    }
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const projectId = mediaProjectIdSchema.optional().parse(context.req.query("projectId"));
    const mediaAccess = await resolveProjectMediaAccess(
      context,
      accessDeps,
      identityCookie,
      session.user.id,
      projectId,
    );
    if (mediaAccess instanceof Response) return mediaAccess;
    const completed = await media.completeDirectUpload(
      mediaAccess.ownerId,
      context.req.param("mediaId"),
      projectId,
    );
    context.header("Cache-Control", "no-store");
    return context.json(mediaResponseSchema.parse({ ok: true, data: completed }));
  });

  app.post("/api/v1/media/:mediaId/multipart/:sessionId/parts", async (context) => {
    if (!multipartMedia) return mediaUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点签发上传分片",
      );
    }
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const projectId = mediaProjectIdSchema.optional().parse(context.req.query("projectId"));
    const mediaAccess = await resolveProjectMediaAccess(
      context,
      accessDeps,
      identityCookie,
      session.user.id,
      projectId,
    );
    if (mediaAccess instanceof Response) return mediaAccess;
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const input = mediaMultipartPartSignRequestSchema.parse(body);
    const result = await multipartMedia.signParts(
      mediaAccess.ownerId,
      context.req.param("mediaId"),
      context.req.param("sessionId"),
      input.partNumbers,
      projectId,
    );
    context.header("Cache-Control", "no-store");
    return context.json(mediaMultipartPartInstructionsResponseSchema.parse(result));
  });

  app.get("/api/v1/media/:mediaId/multipart/:sessionId", async (context) => {
    if (!multipartMedia) return mediaUnavailable(context);
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const projectId = mediaProjectIdSchema.optional().parse(context.req.query("projectId"));
    const mediaAccess = await resolveProjectMediaAccess(
      context,
      accessDeps,
      identityCookie,
      session.user.id,
      projectId,
    );
    if (mediaAccess instanceof Response) return mediaAccess;
    const state = await multipartMedia.getState(
      mediaAccess.ownerId,
      context.req.param("mediaId"),
      context.req.param("sessionId"),
      projectId,
    );
    context.header("Cache-Control", "private, no-store");
    return context.json(mediaMultipartUploadStateResponseSchema.parse({ ok: true, data: state }));
  });

  app.post("/api/v1/media/:mediaId/multipart/:sessionId/complete", async (context) => {
    if (!multipartMedia) return mediaUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点确认上传分片",
      );
    }
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const projectId = mediaProjectIdSchema.optional().parse(context.req.query("projectId"));
    const mediaAccess = await resolveProjectMediaAccess(
      context,
      accessDeps,
      identityCookie,
      session.user.id,
      projectId,
    );
    if (mediaAccess instanceof Response) return mediaAccess;
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    mediaMultipartCompleteRequestSchema.parse(body);
    const state = await multipartMedia.complete(
      mediaAccess.ownerId,
      context.req.param("mediaId"),
      context.req.param("sessionId"),
      projectId,
    );
    context.header("Cache-Control", "no-store");
    return context.json(mediaMultipartCompleteResponseSchema.parse({ ok: true, data: state }));
  });

  app.delete("/api/v1/media/:mediaId/multipart/:sessionId", async (context) => {
    if (!multipartMedia) return mediaUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点取消上传分片",
      );
    }
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const projectId = mediaProjectIdSchema.optional().parse(context.req.query("projectId"));
    const mediaAccess = await resolveProjectMediaAccess(
      context,
      accessDeps,
      identityCookie,
      session.user.id,
      projectId,
    );
    if (mediaAccess instanceof Response) return mediaAccess;
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    mediaMultipartAbortRequestSchema.parse(body);
    const state = await multipartMedia.abort(
      mediaAccess.ownerId,
      context.req.param("mediaId"),
      context.req.param("sessionId"),
      projectId,
    );
    context.header("Cache-Control", "no-store");
    return context.json(mediaMultipartAbortResponseSchema.parse({ ok: true, data: state }));
  });
}
