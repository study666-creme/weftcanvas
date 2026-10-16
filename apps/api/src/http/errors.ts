import { apiErrorSchema } from "@weftcanvas/contracts";
import type { Context } from "hono";

/**
 * HTTP 层的共享错误形状：错误码枚举与统一错误响应体。
 * 从 app.ts 抽出（重构，无行为变化）——路由按域拆分后各域模块都要用它。
 */
export type ApiErrorStatus =
  400 | 401 | 402 | 403 | 404 | 409 | 413 | 415 | 416 | 422 | 429 | 500 | 503;

export function errorResponse(
  context: Context,
  status: ApiErrorStatus,
  code: string,
  message: string,
) {
  return context.json(apiErrorSchema.parse({ ok: false, error: { code, message } }), status);
}

/** 查询参数里的整数上限（无效时返回错误响应，调用方直接 return）。 */
export function optionalQueryInteger(
  context: Context,
  value: string | undefined,
  fallback: number,
) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value))
    return errorResponse(context, 400, "INVALID_LIMIT", "任务数量范围不正确");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    return errorResponse(context, 400, "INVALID_LIMIT", "任务数量范围不正确");
  return parsed;
}
