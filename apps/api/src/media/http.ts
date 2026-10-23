import { Readable } from "node:stream";

import type { Context } from "hono";

import { errorResponse } from "../http/errors.js";
import { MediaServiceError, type MediaService } from "./service.js";

/**
 * 素材 HTTP 面的共享工具（从 app.ts 抽出，纯搬移）：字节范围、内容长度、
 * 流式响应与下载头。上传与读取两条路由都用它。
 */
export function mediaUnavailable(context: Context) {
  return errorResponse(context, 503, "MEDIA_UNAVAILABLE", "素材服务暂未配置");
}

export function hostedMediaResponse(upstream: Response) {
  const headers = new Headers({
    "Cache-Control": "private, no-store, no-transform",
    "X-Content-Type-Options": "nosniff",
  });
  for (const name of ["Accept-Ranges", "Content-Length", "Content-Range", "Content-Type"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

export function readContentLength(value: string | undefined) {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value))
    throw new MediaServiceError("MEDIA_SIZE_INVALID", "上传内容大小无效", 400);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new MediaServiceError("MEDIA_SIZE_INVALID", "上传内容大小无效", 400);
  return parsed;
}

export function parseByteRange(value: string | undefined, size: number) {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) throw new RangeError("Invalid byte range");
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new RangeError("Invalid byte range");
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    throw new RangeError("Invalid byte range");
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

/**
 * 素材字节的缓存策略。默认仍是「不进任何缓存」；`private` 只允许落在请求者
 * 自己的浏览器缓存里，于是节点缩略图与画布视频在重开项目、重挂载节点时不必
 * 再经公网回源一次（此前每一次回显都是跨太平洋的冷下载）。派生缩略图按素材
 * 对象键存放、原图按修订号不可变，窗口内不会拿到过期内容；上传修订、删除与
 * 清理流程本来就会换 URL，或先把本地副本落盘再动云端。
 */
export const MEDIA_THUMB_CACHE_CONTROL = "private, max-age=86400, no-transform";
export const MEDIA_CONTENT_CACHE_CONTROL = "private, max-age=3600, no-transform";
export const MEDIA_NO_STORE_CACHE_CONTROL = "private, no-store, no-transform";

export function mediaContentResponse(
  content: Awaited<ReturnType<MediaService["open"]>>,
  partial: boolean,
  download = false,
  cacheControl: string = MEDIA_NO_STORE_CACHE_CONTROL,
) {
  const { object } = content;
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheControl,
    "Content-Length": String(object.end - object.start + 1),
    "Content-Type": content.media.mimeType,
    "X-Content-Type-Options": "nosniff",
  });
  if (partial)
    headers.set("Content-Range", `bytes ${object.start}-${object.end}/${object.totalSize}`);
  if (download) headers.set("Content-Disposition", downloadContentDisposition(content.media.name));
  return new Response(Readable.toWeb(object.stream) as ReadableStream<Uint8Array>, {
    status: partial ? 206 : 200,
    headers,
  });
}

export function downloadContentDisposition(name: string) {
  const value = name.trim() || "download";
  const fallback = value.replace(/[^\x20-\x7e]|[\\\"]/g, "_");
  if (fallback === value) return `attachment; filename="${fallback}"`;
  return `attachment; filename="${fallback || "download"}"; filename*=UTF-8''${encodeURIComponent(value)}`;
}
