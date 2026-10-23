import type { Context } from "hono";
import { timingSafeEqual } from "node:crypto";

import { AgentExecutionError } from "./service.js";
import { errorResponse, type ApiErrorStatus } from "../http/errors.js";

/**
 * 连接器 HTTP 面的共享工具（从 app.ts 抽出，纯搬移）。
 *
 * 连接器有两个信任边界，刻意分文件承载：
 * - `connector-routes.ts`：浏览器会话鉴权（人）。
 * - `connector-link-routes.ts`：配对令牌 / 运行时共享令牌鉴权（机器）。
 */
export function connectorUnavailable(context: Context) {
  return errorResponse(context, 503, "CONNECTORS_UNAVAILABLE", "本机连接服务暂未配置");
}

/** 定长比较，避免用字符串相等泄漏令牌。 */
export function constantTimeEquals(left: string, right: string) {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 外部客户端用 `Authorization: Bearer <配对令牌>` 鉴权。 */
export function readBearerToken(header: string | undefined) {
  const value = header?.trim();
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  const token = match?.[1]?.trim();
  return token ? token : null;
}

export function connectorFailure(context: Context, error: unknown) {
  if (error instanceof AgentExecutionError) {
    const status: ApiErrorStatus =
      error.code === "CONNECTOR_RUNTIME_UNAVAILABLE"
        ? 503
        : error.code === "CONNECTOR_INVALID_RESPONSE"
          ? 503
          : 422;
    return errorResponse(context, status, error.code, error.message);
  }
  return errorResponse(context, 503, "CONNECTORS_UNAVAILABLE", "本机连接服务暂时不可用");
}
