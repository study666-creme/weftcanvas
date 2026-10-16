import type { Hono } from "hono";
import { z } from "zod";

import {
  canvasImportPreviewResponseSchema,
  canvasImportProviderSchema,
  canvasImportProvidersResponseSchema,
  canvasImportRequestSchema,
  type MediaKind,
} from "@weftcanvas/contracts";

import { errorResponse } from "../http/errors.js";
import { readJsonBody } from "../http/json-body.js";
import { type IdentityCookie, requireIdentitySession } from "../identity/http-session.js";
import type { IdentityProvider } from "../identity/provider.js";
import { MEDIA_PROXY_MAX_REDIRECT_HOPS, guardedFetch } from "../outbound/guarded-fetch.js";
import { MUSIC_FETCH_UA, MUSIC_RESOLVE_TIMEOUT_MS } from "../media/music-proxy.js";
import { isAllowedMediaHost } from "./reference.js";
import {
  canvasImportProviderStatus,
  loadCanvasImportPreview,
  type CanvasImportConfig,
} from "./service.js";
import { CanvasImportError } from "./adapt.js";

export type CanvasImportRouteDependencies = {
  identity: IdentityProvider | undefined;
  identityCookie: IdentityCookie;
  canvasImport?: CanvasImportConfig;
};

// 第三方画布素材代拉上限：与媒体层的同类上限一致（图片 25MB / 视频 512MB /
// 音频 100MB），浏览器本地媒体库的上限也取同一组数字，避免"服务端放行、前端
// 落库时才失败"的错位。
const MEDIA_PROXY_MAX_BYTES: Record<MediaKind, number> = {
  image: 25 * 1024 * 1024,
  video: 512 * 1024 * 1024,
  audio: 100 * 1024 * 1024,
};

/**
 * 第三方画布导入（LibTV / TapNow / UpDream）的路由（从 app.ts 抽出，纯搬移）：
 * 对方画布由服务端读取，素材由浏览器经同源代理路径拉进本地媒体库，节点里不落
 * 任何第三方媒体直链。素材代拉复用音乐那套逐跳 SSRF 守卫，另加一层按来源
 * 核验的域名白名单。
 */
export function registerCanvasImportRoutes(app: Hono, deps: CanvasImportRouteDependencies) {
  const { identity, identityCookie, canvasImport } = deps;

  // —— 第三方画布导入（LibTV / TapNow / UpDream）—————————————————————————
  // 与音乐链接同一套约定：对方画布由服务端读取，素材由浏览器经同源代理路径拉
  // 进本地媒体库，节点里不落任何第三方媒体直链。素材代拉复用音乐那套逐跳
  // SSRF 守卫，另加一层按来源核验的域名白名单。
  app.get("/api/v1/canvas-import/providers", async (context) => {
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    context.header("Cache-Control", "no-store");
    return context.json(
      canvasImportProvidersResponseSchema.parse({
        ok: true,
        data: { providers: canvasImportProviderStatus(canvasImport ?? {}) },
      }),
    );
  });

  app.post("/api/v1/canvas-import/preview", async (context) => {
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const parsed = canvasImportRequestSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(context, 422, "INVALID_CANVAS_IMPORT", "请填写要导入的第三方画布链接");
    }
    try {
      const data = await loadCanvasImportPreview(parsed.data, canvasImport ?? {});
      context.header("Cache-Control", "no-store");
      return context.json(canvasImportPreviewResponseSchema.parse({ ok: true, data }));
    } catch (error) {
      if (error instanceof CanvasImportError)
        return errorResponse(context, error.status, error.code, error.message);
      return errorResponse(context, 503, "IMPORT_SOURCE_UNAVAILABLE", "暂时读不到这个第三方画布");
    }
  });

  // 素材代拉：白名单域名 + 逐跳 SSRF 守卫 + 声明类型门槛 + 按类型的大小上限，
  // 响应只回必要头。Range 透传，视频拖动进度条依赖 206。
  app.get("/api/v1/canvas-import/asset", async (context) => {
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const input = z
      .object({ p: canvasImportProviderSchema, u: z.string().url().max(4_096) })
      .parse(context.req.query());
    let target: URL;
    try {
      target = new URL(input.u);
    } catch {
      return errorResponse(context, 400, "IMPORT_ASSET_INVALID", "素材地址不合法");
    }
    if (target.protocol !== "https:" || target.username || target.password) {
      return errorResponse(context, 400, "IMPORT_ASSET_BLOCKED", "素材地址不受支持");
    }
    if (!isAllowedMediaHost(input.p, target.hostname)) {
      return errorResponse(context, 400, "IMPORT_ASSET_BLOCKED", "这个素材不在允许代拉的域名里");
    }
    const range = context.req.header("range");
    const controller = new AbortController();
    const connectTimer = setTimeout(() => controller.abort(), MUSIC_RESOLVE_TIMEOUT_MS);
    let upstream: Response;
    try {
      upstream = await guardedFetch(input.u, {
        accept: "image/avif,image/webp,image/png,image/jpeg,image/*,video/*,audio/*,*/*;q=0.5",
        signal: controller.signal,
        range,
        userAgent: MUSIC_FETCH_UA,
        maxRedirects: MEDIA_PROXY_MAX_REDIRECT_HOPS,
        // 白名单按跳校验：对方 CDN 302 到别家主机同样要拦下来。
        allowHost: (hostname) => isAllowedMediaHost(input.p, hostname),
        fetch: canvasImport?.fetch,
        fail: (failure) =>
          failure === "blocked" || failure === "host-not-allowed"
            ? new CanvasImportError(400, "IMPORT_ASSET_BLOCKED", "该素材地址不可用")
            : new CanvasImportError(503, "IMPORT_ASSET_FAILED", "这个素材暂时拉不到"),
      });
    } catch (error) {
      if (error instanceof CanvasImportError)
        return errorResponse(context, error.status, error.code, error.message);
      if (error instanceof Error && error.name === "AbortError") {
        return errorResponse(context, 503, "IMPORT_ASSET_TIMEOUT", "素材源连接超时");
      }
      return errorResponse(context, 503, "IMPORT_ASSET_FAILED", "这个素材暂时拉不到");
    } finally {
      clearTimeout(connectTimer);
    }
    if (!upstream.ok && upstream.status !== 206) {
      await upstream.body?.cancel().catch(() => undefined);
      return errorResponse(context, 503, "IMPORT_ASSET_UNAVAILABLE", "素材源没有返回内容");
    }
    const contentType =
      (upstream.headers.get("content-type") || "").split(";")[0]?.trim().toLowerCase() ?? "";
    const mediaKind = contentType.startsWith("image/")
      ? "image"
      : contentType.startsWith("video/")
        ? "video"
        : contentType.startsWith("audio/")
          ? "audio"
          : "";
    if (!mediaKind) {
      await upstream.body?.cancel().catch(() => undefined);
      return errorResponse(
        context,
        415,
        "IMPORT_ASSET_UNSUPPORTED",
        "这个素材不是图片、视频或音频",
      );
    }
    const maxBytes = MEDIA_PROXY_MAX_BYTES[mediaKind];
    const contentLength = Number(upstream.headers.get("content-length") || 0);
    if (contentLength > maxBytes) {
      await upstream.body?.cancel().catch(() => undefined);
      return errorResponse(
        context,
        413,
        "IMPORT_ASSET_TOO_LARGE",
        "这个素材超出了可导入的大小上限",
      );
    }
    if (!upstream.body) {
      return errorResponse(context, 503, "IMPORT_ASSET_FAILED", "这个素材暂时拉不到");
    }
    const headers = new Headers();
    headers.set("Content-Type", contentType);
    headers.set("Cache-Control", "private, max-age=300");
    headers.set("X-Content-Type-Options", "nosniff");
    if (contentLength) headers.set("Content-Length", String(contentLength));
    const contentRange = upstream.headers.get("content-range");
    if (contentRange) headers.set("Content-Range", contentRange);
    headers.set("Accept-Ranges", upstream.headers.get("accept-ranges") || "bytes");

    // 边下边限流：即使上游没给 Content-Length 也不会拉爆内存。
    const reader = upstream.body.getReader();
    let totalBytes = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(streamController) {
        const { done, value } = await reader.read();
        if (done) {
          streamController.close();
          return;
        }
        totalBytes += value.length;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => undefined);
          streamController.error(new Error("IMPORT_ASSET_TOO_LARGE"));
          return;
        }
        streamController.enqueue(value);
      },
      async cancel() {
        await reader.cancel().catch(() => undefined);
      },
    });
    return new Response(body, { status: upstream.status === 206 ? 206 : 200, headers });
  });
}
