import type { Context } from "hono";

import { errorResponse } from "./errors.js";

/**
 * 请求体读取与大小闸门（从 app.ts 抽出，纯搬运）：只收未压缩的 JSON，
 * Content-Length 与实际字节数都有 1MB 上限。
 */
export async function readJsonBody(context: Context) {
  const contentType = context.req.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return errorResponse(context, 415, "JSON_REQUIRED", "请求必须使用 JSON 格式");
  }
  const contentEncoding = context.req.header("Content-Encoding")?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    return errorResponse(context, 415, "CONTENT_ENCODING_UNAVAILABLE", "请求内容不能使用压缩编码");
  }
  const declaredLength = context.req.header("Content-Length");
  if (declaredLength !== undefined) {
    if (!/^\d+$/.test(declaredLength))
      return errorResponse(context, 400, "CONTENT_LENGTH_INVALID", "请求大小信息无效");
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed))
      return errorResponse(context, 400, "CONTENT_LENGTH_INVALID", "请求大小信息无效");
    if (parsed > 1024 * 1024) return errorResponse(context, 413, "JSON_TOO_LARGE", "请求内容过大");
  }
  const body = context.req.raw.body;
  if (!body) return errorResponse(context, 400, "INVALID_JSON", "请求内容格式不正确");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) {
        await reader.cancel().catch(() => undefined);
        return errorResponse(context, 413, "JSON_TOO_LARGE", "请求内容过大");
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      size,
    );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    return errorResponse(context, 400, "INVALID_JSON", "请求内容格式不正确");
  }
}
