import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";

import {
  generationJobEventSchema,
  generationJobListResponseSchema,
  generationJobReconcileQuerySchema,
  generationJobResponseSchema,
  generationQuoteResponseSchema,
  type GenerationJobStatus,
} from "@weftcanvas/contracts";

import { errorResponse, optionalQueryInteger } from "../http/errors.js";
import { readJsonBody } from "../http/json-body.js";
import { isTrustedBrowserRequest } from "../http/browser-request.js";
import {
  refreshIdentityCookie,
  requireIdentitySession,
  type IdentityCookie,
} from "../identity/http-session.js";
import type { IdentityProvider } from "../identity/provider.js";
import type { GenerationApi } from "./api.js";
import type { GenerationApiGuard } from "./api-rate-limit.js";
import type { HostedGenerationResult } from "./hosted-result.js";

export type GenerationRouteDependencies = {
  quotes: Pick<import("../catalog/quote.js").GenerationQuoteService, "createQuote">;
  generation?: GenerationApi;
  generationUnavailableMessage?: string;
  generationGuard?: Pick<GenerationApiGuard, "checkSubmission" | "checkRead" | "acquireStream">;
  generationStream?: {
    pollIntervalMs: number;
    heartbeatMs: number;
    maxDurationMs: number;
    now?: () => number;
  };
  allowedOrigins?: readonly string[];
  identity?: IdentityProvider;
  identityCookie: IdentityCookie;
  storageSweep?: { sweep(): Promise<unknown> };
  storageSweepSecret?: string;
};

export function generationUnavailable(context: Context, message?: string) {
  return errorResponse(context, 503, "GENERATION_UNAVAILABLE", message || "生成服务暂未配置");
}

export function unwrapGenerationResult<T>(result: T | HostedGenerationResult<T>): T {
  return result && typeof result === "object" && !Array.isArray(result) && "data" in result
    ? (result as HostedGenerationResult<T>).data
    : (result as T);
}

export function generationRefresh(result: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return {};
  const value = result as { refreshedToken?: unknown; expiresAt?: unknown };
  return {
    ...(typeof value.refreshedToken === "string" ? { refreshedToken: value.refreshedToken } : {}),
    ...(typeof value.expiresAt === "string" ? { expiresAt: value.expiresAt } : {}),
  };
}

export function generationEventId(jobId: string, version: number) {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(jobId) || !Number.isSafeInteger(version) || version < 0) {
    throw new Error("Generation event identity is invalid");
  }
  return `generation:${jobId}:${version}`;
}

export function lastEventVersion(value: string | undefined, jobId: string, currentVersion: number) {
  if (!value) return -1;
  const prefix = `generation:${jobId}:`;
  if (!value.startsWith(prefix)) return -1;
  const version = Number(value.slice(prefix.length));
  return Number.isSafeInteger(version) && version >= 0 && version <= currentVersion ? version : -1;
}

export function isGenerationObservationTerminal(status: GenerationJobStatus) {
  return status === "completed" || status === "failed" || status === "submission_unknown";
}

/**
 * 生成域路由（从 app.ts 抽出，纯搬移）：报价、提交、列表、对账、单任务、
 * SSE 观测流与本机存储清扫。逐条保留原来的鉴权、限流、缓存头与事件版本语义。
 */
export function registerGenerationRoutes(app: Hono, deps: GenerationRouteDependencies) {
  const {
    quotes,
    generation,
    generationUnavailableMessage,
    generationGuard,
    generationStream,
    allowedOrigins,
    identity,
    identityCookie,
    storageSweep,
    storageSweepSecret,
  } = deps;

  app.post("/api/v1/generation-quotes", async (context) => {
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const quote = await quotes.createQuote(body);
    context.header("Cache-Control", "no-store");
    return context.json(generationQuoteResponseSchema.parse({ ok: true, data: quote }));
  });

  app.post("/api/v1/generation-jobs", async (context) => {
    if (!generation) return generationUnavailable(context, generationUnavailableMessage);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点提交生成任务",
      );
    }
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    await generationGuard?.checkSubmission(session.user.id);
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const result = await generation.submit(
      session.user.id,
      body,
      getCookie(context, identityCookie.name),
    );
    const job = unwrapGenerationResult(result);
    refreshIdentityCookie(context, identityCookie, generationRefresh(result));
    context.header("Cache-Control", "no-store");
    return context.json(generationJobResponseSchema.parse({ ok: true, data: job }), 202);
  });

  app.get("/api/v1/generation-jobs", async (context) => {
    if (!generation) return generationUnavailable(context, generationUnavailableMessage);
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    await generationGuard?.checkRead(session.user.id);
    const limit = optionalQueryInteger(context, context.req.query("limit"), 50);
    if (limit instanceof Response) return limit;
    const result = await generation.list(
      session.user.id,
      {
        ...(context.req.query("projectId") !== undefined
          ? { projectId: context.req.query("projectId") }
          : {}),
        limit,
      },
      getCookie(context, identityCookie.name),
    );
    const jobs = unwrapGenerationResult(result);
    refreshIdentityCookie(context, identityCookie, generationRefresh(result));
    context.header("Cache-Control", "private, no-store");
    return context.json(generationJobListResponseSchema.parse({ ok: true, data: jobs }));
  });

  // 本机专用：每日存储清扫（systemd timer 调用）。防线：强随机 secret 头 +
  // 拒绝一切带代理痕迹的请求（x-forwarded-for 存在即说明经 Tunnel/代理到达，
  // timer 直连 127.0.0.1 不会带该头；原生 Headers.get 对缺失头返回 null）。
  app.post("/api/v1/internal/storage-sweep", async (context) => {
    if (!storageSweep || !storageSweepSecret) {
      return context.notFound();
    }
    if (
      context.req.header("x-forwarded-for") !== undefined ||
      context.req.header("x-storage-sweep-secret") !== storageSweepSecret
    ) {
      return context.notFound();
    }
    const result = await storageSweep.sweep();
    context.header("Cache-Control", "no-store");
    return context.json({ ok: true, data: result });
  });

  // Read-only reconciliation by the exact durable idempotency identity. This
  // route resolves a persisted optimistic request that the newest-100 list
  // recovery cannot authoritatively cover. It is owner-scoped, rate-limited
  // through the normal generation read guard, and never submits, retries,
  // replays, mutates a job, or contacts a provider. A 404 is the unambiguous
  // authoritative miss the browser uses to settle an expired request.
  app.get("/api/v1/generation-jobs/reconcile", async (context) => {
    if (!generation) return generationUnavailable(context, generationUnavailableMessage);
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    await generationGuard?.checkRead(session.user.id);
    const parsed = generationJobReconcileQuerySchema.safeParse({
      key: context.req.query("key") ?? "",
    });
    if (!parsed.success) {
      return errorResponse(context, 422, "INVALID_IDEMPOTENCY_KEY", "任务标识格式不正确");
    }
    if (!generation.resolveByIdempotency) {
      return errorResponse(
        context,
        503,
        "GENERATION_RECONCILE_UNAVAILABLE",
        "任务核对服务暂不可用",
      );
    }
    const result = await generation.resolveByIdempotency(
      session.user.id,
      parsed.data.key,
      getCookie(context, identityCookie.name),
    );
    if (result === null || result === undefined) {
      context.header("Cache-Control", "private, no-store");
      return errorResponse(context, 404, "GENERATION_JOB_NOT_FOUND", "没有找到这个生成任务");
    }
    const job = unwrapGenerationResult(result);
    refreshIdentityCookie(context, identityCookie, generationRefresh(result));
    context.header("Cache-Control", "private, no-store");
    return context.json(generationJobResponseSchema.parse({ ok: true, data: job }));
  });

  app.get("/api/v1/generation-jobs/:jobId", async (context) => {
    if (!generation) return generationUnavailable(context, generationUnavailableMessage);
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    await generationGuard?.checkRead(session.user.id);
    const result = await generation.get(
      session.user.id,
      context.req.param("jobId"),
      getCookie(context, identityCookie.name),
    );
    const job = unwrapGenerationResult(result);
    refreshIdentityCookie(context, identityCookie, generationRefresh(result));
    context.header("Cache-Control", "private, no-store");
    return context.json(generationJobResponseSchema.parse({ ok: true, data: job }));
  });

  app.get("/api/v1/generation-jobs/:jobId/events", async (context) => {
    if (!generation) return generationUnavailable(context, generationUnavailableMessage);
    const session = await requireIdentitySession(context, identity, identityCookie);
    if (session instanceof Response) return session;
    const release = generationGuard
      ? await generationGuard.acquireStream(session.user.id)
      : () => undefined;
    const sessionToken = getCookie(context, identityCookie.name);
    let initial;
    try {
      const initialResult = await generation.get(
        session.user.id,
        context.req.param("jobId"),
        sessionToken,
      );
      // The first hosted status read happens before the SSE response starts,
      // so a rotated Prompt Hub session can still be written to the browser.
      refreshIdentityCookie(context, identityCookie, generationRefresh(initialResult));
      initial = unwrapGenerationResult(initialResult);
    } catch (error) {
      release();
      throw error;
    }
    const settings = generationStream ?? {
      pollIntervalMs: 1_000,
      heartbeatMs: 15_000,
      maxDurationMs: 10 * 60_000,
    };
    const now = settings.now ?? Date.now;
    const lastVersion = lastEventVersion(
      context.req.header("Last-Event-ID"),
      initial.id,
      initial.version,
    );
    context.header("Cache-Control", "private, no-cache, no-transform");
    context.header("X-Accel-Buffering", "no");
    return streamSSE(context, async (stream) => {
      let aborted = false;
      stream.onAbort(() => {
        aborted = true;
      });
      let current = initial;
      let emittedVersion = isGenerationObservationTerminal(current.status) ? -1 : lastVersion;
      let heartbeatAt = now() + settings.heartbeatMs;
      const deadline = now() + settings.maxDurationMs;
      try {
        while (!aborted && now() < deadline) {
          if (current.version !== emittedVersion) {
            const event = generationJobEventSchema.parse({ type: "job", job: current });
            await stream.writeSSE({
              id: generationEventId(current.id, current.version),
              event: "job",
              data: JSON.stringify(event),
              retry: 2_000,
            });
            emittedVersion = current.version;
          }
          if (isGenerationObservationTerminal(current.status)) return;
          if (now() >= heartbeatAt) {
            await stream.write(": heartbeat\n\n");
            heartbeatAt = now() + settings.heartbeatMs;
          }
          await stream.sleep(settings.pollIntervalMs);
          if (aborted) return;
          const nextResult = await generation!.get(session.user.id, current.id, sessionToken);
          current = unwrapGenerationResult(nextResult);
          if (generationRefresh(nextResult).refreshedToken) {
            // Set-Cookie cannot be changed reliably after an SSE body starts.
            // Move observation to the normal polling route, whose response can
            // persist the rotated HttpOnly session before continuing.
            await stream.writeSSE({
              event: "status-error",
              data: JSON.stringify({
                code: "SESSION_REFRESH_REQUIRED",
                message: "正在更新登录状态",
              }),
              retry: 1_000,
            });
            return;
          }
        }
      } catch {
        if (!aborted) {
          await stream
            .writeSSE({
              event: "status-error",
              data: JSON.stringify({
                code: "GENERATION_STATUS_UNAVAILABLE",
                message: "任务状态暂时无法更新",
              }),
              retry: 2_000,
            })
            .catch(() => undefined);
        }
      } finally {
        release();
      }
    });
  });
}
