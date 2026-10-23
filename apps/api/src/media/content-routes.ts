import type { Hono } from "hono";

import { mediaKindSchema, mediaProjectIdSchema, mediaResponseSchema } from "@weftcanvas/contracts";

import { errorResponse } from "../http/errors.js";
import {
  refreshIdentityCookie,
  requireIdentitySession,
  type IdentityCookie,
} from "../identity/http-session.js";
import type { IdentityProvider } from "../identity/provider.js";
import { resolveProjectMediaAccess, type MediaAccessDependencies } from "./access.js";
import {
  hostedMediaResponse,
  MEDIA_CONTENT_CACHE_CONTROL,
  MEDIA_NO_STORE_CACHE_CONTROL,
  MEDIA_THUMB_CACHE_CONTROL,
  mediaContentResponse,
  mediaUnavailable,
  parseByteRange,
} from "./http.js";
import type { MediaService } from "./service.js";
import type { SignedMediaAccess } from "./signed-access.js";

export type MediaContentRouteDependencies = MediaAccessDependencies & {
  media?: MediaService;
  signedMedia?: Pick<SignedMediaAccess, "verify" | "createUrl">;
  /** 托管生成提供方的素材读取通道（`phm_` 前缀 id）。 */
  generation?: {
    openMedia?(
      ownerId: string,
      mediaId: string,
      token?: string,
      range?: string,
      projectId?: string,
      signal?: AbortSignal,
    ): Promise<{ data: Response; refreshedToken?: string; expiresAt?: string }>;
  };
  allowedOrigins?: readonly string[];
  identity?: IdentityProvider;
  identityCookie: IdentityCookie;
};

/**
 * 素材读取面（从 app.ts 抽出，纯搬移）：元数据、内容字节（缩略/范围/下载/
 * 307 直链）、以及公网签名投递。上传写入面在 `upload-routes.ts`。
 */
export function registerMediaContentRoutes(app: Hono, deps: MediaContentRouteDependencies) {
  const { media, signedMedia, generation, entitlements, projects, identity, identityCookie } = deps;
  const accessDeps = { entitlements, projects };

  app.get("/api/v1/media/:mediaId", async (context) => {
    if (!media) return mediaUnavailable(context);
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
    const found = await media.get(mediaAccess.ownerId, context.req.param("mediaId"), projectId);
    context.header("Cache-Control", "private, no-store");
    return context.json(mediaResponseSchema.parse({ ok: true, data: found }));
  });

  app.get("/api/v1/media/:mediaId/content", async (context) => {
    const mediaId = context.req.param("mediaId");
    if (!media && !(mediaId.startsWith("phm_") && generation?.openMedia)) {
      return mediaUnavailable(context);
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
    const download = context.req.query("download") === "1";
    // 画布节点内的展示图请求缩略变体；全屏预览、下载、离线落盘都不带此参数，仍取原图。
    const wantsThumb = context.req.query("variant") === "thumb";
    if (mediaId.startsWith("phm_") && generation?.openMedia) {
      const result = await generation.openMedia(
        mediaAccess.ownerId,
        mediaId,
        mediaAccess.token,
        context.req.header("Range"),
        projectId,
        context.req.raw.signal,
      );
      refreshIdentityCookie(context, identityCookie, result);
      return hostedMediaResponse(result.data);
    }
    if (!media) return mediaUnavailable(context);
    const found = await media.get(mediaAccess.ownerId, mediaId, projectId);
    if (found.status !== "ready")
      return errorResponse(context, 409, "MEDIA_NOT_READY", "素材尚未处理完成");
    if (wantsThumb && !download && found.kind === "image") {
      const thumb = await media.openThumb(mediaAccess.ownerId, found.id, projectId);
      // 缩略响应附原始宽高：前端节点尺寸记录必须用原图宽高（缩略图是等比
      // 缩小，比例相同但绝对值不同，直接写入会让全屏缩放/元数据失真）。
      if (found.width && found.height) {
        context.header("X-Media-Original-Width", String(found.width));
        context.header("X-Media-Original-Height", String(found.height));
      }
      return mediaContentResponse(thumb, false, false, MEDIA_THUMB_CACHE_CONTROL);
    }
    let range: { start: number; end: number } | undefined;
    try {
      range = parseByteRange(context.req.header("Range"), found.size);
    } catch {
      context.header("Content-Range", `bytes */${found.size}`);
      return errorResponse(context, 416, "MEDIA_RANGE_INVALID", "请求的素材范围无效");
    }
    const direct = await media.createPrivateDownload(mediaAccess.ownerId, found.id, projectId);
    if (direct && !download) {
      context.header("Cache-Control", "private, no-store");
      return context.redirect(direct.url, 307);
    }
    const content = await media.open(
      mediaAccess.ownerId,
      found.id,
      range,
      projectId,
      context.req.raw.signal,
    );
    // 显式下载仍然强制回源（用户点「下载」要的是当下这一份）；画布内展示的
    // 原图/视频字节允许落在浏览器私有缓存里，见 MEDIA_CONTENT_CACHE_CONTROL。
    return mediaContentResponse(
      content,
      range !== undefined,
      download,
      download ? MEDIA_NO_STORE_CACHE_CONTROL : MEDIA_CONTENT_CACHE_CONTROL,
    );
  });

  app.get("/api/v1/provider-media/:mediaId/content", async (context) => {
    if (!media || !signedMedia) return errorResponse(context, 404, "NOT_FOUND", "没有找到这个接口");
    const parsedKind = mediaKindSchema.safeParse(context.req.query("kind"));
    if (
      !parsedKind.success ||
      !signedMedia.verify(
        context.req.param("mediaId"),
        parsedKind.data,
        context.req.query("expires"),
        context.req.query("signature"),
      )
    )
      return errorResponse(context, 404, "MEDIA_NOT_FOUND", "没有找到这个素材");
    const found = await media.getForSignedDelivery(context.req.param("mediaId"), parsedKind.data);
    let range: { start: number; end: number } | undefined;
    try {
      range = parseByteRange(context.req.header("Range"), found.size);
    } catch {
      context.header("Content-Range", `bytes */${found.size}`);
      return errorResponse(context, 416, "MEDIA_RANGE_INVALID", "请求的素材范围无效");
    }
    const content = await media.openForSignedDelivery(found.id, parsedKind.data, range);
    return mediaContentResponse(content, range !== undefined);
  });
}
