import type { Hono } from "hono";
import { z } from "zod";

import { musicLinkResolveResponseSchema } from "@weftcanvas/contracts";

import { errorResponse } from "../http/errors.js";
import type { IdentityProvider } from "../identity/provider.js";
import { requireIdentitySession, type IdentityCookie } from "../identity/http-session.js";
import { isBlockedTargetUrl } from "../identity/safe-host.js";
import {
  MUSIC_AUDIO_URL_PATTERN,
  MUSIC_COVER_MAX_BYTES,
  MUSIC_COVER_TIMEOUT_MS,
  MUSIC_RESOLVE_TIMEOUT_MS,
  MUSIC_STREAM_MAX_BYTES,
  MusicProxyError,
  concatBytes,
  detectMusicSource,
  musicGuardedFetch,
  normalizeMusicInputUrl,
  resolveMusicLink,
  sniffAudioBytes,
} from "./music-proxy.js";

export type MusicRouteDependencies = {
  identity: IdentityProvider | undefined;
  identityCookie: IdentityCookie;
};

/**
 * 音乐链接助手路由（从 app.ts 抽出，纯搬移）：解析、流式代拉与封面代理。
 * 三条路由都要求登录；逐跳 SSRF 守卫与 Range 透传的语义在 music-proxy.ts。
 */
export function registerMusicRoutes(app: Hono, deps: MusicRouteDependencies) {
  const { identity, identityCookie } = deps;

  app.get("/api/v1/music/resolve", async (context) => {
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const input = z.object({ url: z.string().trim().min(1).max(2_048) }).parse(context.req.query());
    let target: URL;
    try {
      target = normalizeMusicInputUrl(input.url);
    } catch {
      return errorResponse(
        context,
        400,
        "INVALID_MUSIC_URL",
        "链接格式不对，请粘贴完整的网页或音频地址",
      );
    }
    const blocked = await isBlockedTargetUrl(target.toString());
    if (blocked) return errorResponse(context, 400, "MUSIC_URL_BLOCKED", "该链接不可用");
    const source = detectMusicSource(target);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MUSIC_RESOLVE_TIMEOUT_MS);
    try {
      const data = await resolveMusicLink({ target, source, signal: controller.signal });
      return context.json(musicLinkResolveResponseSchema.parse({ ok: true, data }));
    } catch (error) {
      if (error instanceof MusicProxyError)
        return errorResponse(context, error.status, error.code, error.message);
      if (error instanceof Error && error.name === "AbortError") {
        return errorResponse(context, 503, "MUSIC_RESOLVE_TIMEOUT", "链接解析超时，请稍后再试");
      }
      return errorResponse(context, 503, "MUSIC_RESOLVE_FAILED", "暂时无法读取这个链接");
    } finally {
      clearTimeout(timer);
    }
  });

  // 音频流代理：逐跳 SSRF 守卫 + 内容类型门槛 + 非分片请求做音频魔数嗅探；
  // Range 透传（<audio> 的拖动进度条依赖 206），响应头只保留必要字段。
  app.get("/api/v1/music/stream", async (context) => {
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const input = z.object({ u: z.string().url().max(2_048) }).parse(context.req.query());
    const range = context.req.header("range");
    // 连接/取头限时；头回来即解除（流式播放不能整段限时），客户端断开由
    // 流包装的 cancel() 传播给上游，不悬挂连接。
    const controller = new AbortController();
    const connectTimer = setTimeout(() => controller.abort(), MUSIC_RESOLVE_TIMEOUT_MS);
    let upstream: Response;
    try {
      upstream = await musicGuardedFetch(input.u, {
        accept: "audio/*,*/*;q=0.5",
        signal: controller.signal,
        range,
      });
    } catch (error) {
      if (error instanceof MusicProxyError)
        return errorResponse(context, error.status, error.code, error.message);
      if (error instanceof Error && error.name === "AbortError") {
        return errorResponse(context, 503, "MUSIC_STREAM_TIMEOUT", "音频源连接超时");
      }
      return errorResponse(context, 503, "MUSIC_STREAM_FAILED", "音频暂时无法读取");
    } finally {
      clearTimeout(connectTimer);
    }
    if (!upstream.ok && upstream.status !== 206) {
      await upstream.body?.cancel().catch(() => undefined);
      return errorResponse(context, 503, "MUSIC_STREAM_UNAVAILABLE", "音频源没有返回内容");
    }
    const declaredType =
      (upstream.headers.get("content-type") || "").split(";")[0]?.trim().toLowerCase() ?? "";
    let audioExtension = false;
    try {
      audioExtension = MUSIC_AUDIO_URL_PATTERN.test(new URL(input.u).pathname);
    } catch {
      audioExtension = false;
    }
    const declaredAudio =
      declaredType.startsWith("audio/") ||
      declaredType === "application/ogg" ||
      (declaredType === "application/octet-stream" && audioExtension);
    if (!declaredAudio) {
      await upstream.body?.cancel().catch(() => undefined);
      return errorResponse(context, 415, "MUSIC_NOT_AUDIO", "这个地址不是音频内容");
    }
    const contentLength = Number(upstream.headers.get("content-length") || 0);
    if (contentLength > MUSIC_STREAM_MAX_BYTES) {
      await upstream.body?.cancel().catch(() => undefined);
      return errorResponse(context, 413, "MUSIC_TOO_LARGE", "音频文件过大");
    }
    if (!upstream.body)
      return errorResponse(context, 503, "MUSIC_STREAM_FAILED", "音频暂时无法读取");

    const headers = new Headers();
    headers.set("Content-Type", declaredType || "audio/mpeg");
    headers.set("Cache-Control", "private, max-age=300");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Accept-Ranges", upstream.headers.get("accept-ranges") || "none");
    for (const header of ["content-length", "content-range"]) {
      const value = upstream.headers.get(header);
      if (value) headers.set(header, value);
    }

    if (upstream.status === 200 && !range) {
      // 全量响应：先嗅探前 768 字节确认真的是音频，再把已读字节拼回流前面。
      const reader = upstream.body.getReader();
      const head: Uint8Array[] = [];
      let headBytes = 0;
      while (headBytes < 768) {
        const { done, value } = await reader.read();
        if (done) break;
        head.push(value);
        headBytes += value.length;
      }
      if (!sniffAudioBytes(concatBytes(head))) {
        await reader.cancel().catch(() => undefined);
        return errorResponse(context, 415, "MUSIC_NOT_AUDIO", "这个地址不是可播放的音频");
      }
      let totalBytes = headBytes;
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          for (const chunk of head) streamController.enqueue(chunk);
        },
        async pull(streamController) {
          const { done, value } = await reader.read();
          if (done) {
            streamController.close();
            return;
          }
          totalBytes += value.length;
          if (totalBytes > MUSIC_STREAM_MAX_BYTES) {
            await reader.cancel().catch(() => undefined);
            streamController.error(new Error("MUSIC_TOO_LARGE"));
            return;
          }
          streamController.enqueue(value);
        },
        async cancel() {
          await reader.cancel().catch(() => undefined);
        },
      });
      return new Response(body, { status: 200, headers });
    }

    // Range 请求（或上游分片响应）：透传字节，counting 包装防止无上限拉取。
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
        if (totalBytes > MUSIC_STREAM_MAX_BYTES) {
          await reader.cancel().catch(() => undefined);
          streamController.error(new Error("MUSIC_TOO_LARGE"));
          return;
        }
        streamController.enqueue(value);
      },
      async cancel() {
        await reader.cancel().catch(() => undefined);
      },
    });
    return new Response(body, { status: upstream.status, headers });
  });

  // 封面代理：与音频同一套守卫，仅允许图片内容类型，供外链卡片展示。
  app.get("/api/v1/music/cover", async (context) => {
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const input = z.object({ u: z.string().url().max(2_048) }).parse(context.req.query());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MUSIC_COVER_TIMEOUT_MS);
    try {
      const upstream = await musicGuardedFetch(input.u, {
        accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        signal: controller.signal,
      });
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => undefined);
        return errorResponse(context, 503, "MUSIC_COVER_UNAVAILABLE", "封面暂时无法读取");
      }
      const contentType =
        (upstream.headers.get("content-type") || "").split(";")[0]?.trim().toLowerCase() ?? "";
      if (!contentType.startsWith("image/") && contentType !== "application/octet-stream") {
        await upstream.body?.cancel().catch(() => undefined);
        return errorResponse(context, 415, "MUSIC_NOT_IMAGE", "封面地址不是图片内容");
      }
      const contentLength = Number(upstream.headers.get("content-length") || 0);
      if (contentLength > MUSIC_COVER_MAX_BYTES) {
        await upstream.body?.cancel().catch(() => undefined);
        return errorResponse(context, 413, "MUSIC_COVER_TOO_LARGE", "封面图片过大");
      }
      const headers = new Headers();
      headers.set("Content-Type", contentType || "image/jpeg");
      headers.set("Cache-Control", "private, max-age=3600");
      headers.set("X-Content-Type-Options", "nosniff");
      if (contentLength) headers.set("Content-Length", String(contentLength));
      return new Response(upstream.body, { status: 200, headers });
    } catch (error) {
      if (error instanceof MusicProxyError)
        return errorResponse(context, error.status, error.code, error.message);
      if (error instanceof Error && error.name === "AbortError") {
        return errorResponse(context, 503, "MUSIC_COVER_TIMEOUT", "封面下载超时");
      }
      return errorResponse(context, 503, "MUSIC_COVER_FAILED", "封面暂时无法读取");
    } finally {
      clearTimeout(timer);
    }
  });
}
