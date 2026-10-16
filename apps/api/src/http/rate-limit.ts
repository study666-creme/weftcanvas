import type { Context } from "hono";

import { errorResponse } from "./errors.js";

/** 匿名 Agent 的限额配置（结构类型：与 app.ts 的 ApiDependencies 字段同形，避免反向依赖）。 */
export type AnonymousAgentLimits = {
  conversationsPerMinute: number;
  submissionsPerMinute: number;
  submissionsPerDay: number;
  readsPerMinute?: number;
  globalConversationsPerMinute?: number;
  globalSubmissionsPerMinute?: number;
  globalSubmissionsPerDay?: number;
  globalReadsPerMinute?: number;
  now?: () => number;
};

/**
 * 限流守卫（从 app.ts 抽出，纯搬运）：两套固定窗口计数器与它们的 429 响应。
 *
 * 单实例进程内计数：systemd 单机部署有效；多实例部署下每个实例各自计数，
 * 需要跨实例一致时换成 PostgresFixedWindowRateLimiter（见审计文档残余风险 §4.1）。
 */
export function anonymousAgentRateLimited(context: Context, retryAfterSeconds: number) {
  context.header("Retry-After", String(retryAfterSeconds));
  return errorResponse(context, 429, "AGENT_RATE_LIMITED", "Agent 请求过于频繁，请稍后再试");
}

export class AnonymousAgentGuard {
  private readonly now: () => number;
  private readonly conversationsPerMinute: number;
  private readonly submissionsPerMinute: number;
  private readonly submissionsPerDay: number;
  private readonly readsPerMinute: number;
  private readonly globalConversationsPerMinute: number;
  private readonly globalSubmissionsPerMinute: number;
  private readonly globalSubmissionsPerDay: number;
  private readonly globalReadsPerMinute: number;
  private readonly buckets = new Map<
    string,
    { startedAt: number; count: number; durationMs: number }
  >();

  constructor(
    options: AnonymousAgentLimits = {
      conversationsPerMinute: 8,
      submissionsPerMinute: 6,
      submissionsPerDay: 60,
    },
  ) {
    this.now = options?.now ?? Date.now;
    this.conversationsPerMinute = positiveLimit(options?.conversationsPerMinute, 8);
    this.submissionsPerMinute = positiveLimit(options?.submissionsPerMinute, 6);
    this.submissionsPerDay = positiveLimit(options?.submissionsPerDay, 60);
    this.readsPerMinute = positiveLimit(options?.readsPerMinute, 120);
    this.globalConversationsPerMinute = positiveLimit(options?.globalConversationsPerMinute, 120);
    this.globalSubmissionsPerMinute = positiveLimit(options?.globalSubmissionsPerMinute, 60);
    this.globalSubmissionsPerDay = positiveLimit(options?.globalSubmissionsPerDay, 2_000);
    this.globalReadsPerMinute = positiveLimit(options?.globalReadsPerMinute, 10_000);
  }

  consumeConversation(ownerId: string) {
    return (
      this.consume("global:conversation-minute", this.globalConversationsPerMinute, 60_000) ??
      this.consume(`${ownerId}:conversation`, this.conversationsPerMinute, 60_000)
    );
  }

  consumeSubmission(ownerId: string) {
    return (
      this.consume("global:submit-minute", this.globalSubmissionsPerMinute, 60_000) ??
      this.consume("global:submit-day", this.globalSubmissionsPerDay, 24 * 60 * 60_000) ??
      this.consume(`${ownerId}:submit-minute`, this.submissionsPerMinute, 60_000) ??
      this.consume(`${ownerId}:submit-day`, this.submissionsPerDay, 24 * 60 * 60_000)
    );
  }

  consumeRead(ownerId: string) {
    return (
      this.consume("global:read-minute", this.globalReadsPerMinute, 60_000) ??
      this.consume(`${ownerId}:read-minute`, this.readsPerMinute, 60_000)
    );
  }

  private consume(key: string, limit: number, durationMs: number) {
    const now = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.durationMs !== durationMs || now - bucket.startedAt >= durationMs) {
      this.buckets.set(key, { startedAt: now, count: 1, durationMs });
      this.prune(now);
      return null;
    }
    if (bucket.count >= limit)
      return Math.max(1, Math.ceil((durationMs - (now - bucket.startedAt)) / 1_000));
    bucket.count += 1;
    return null;
  }

  private prune(now: number) {
    if (this.buckets.size < 2_000) return;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.startedAt >= bucket.durationMs) this.buckets.delete(key);
    }
    while (this.buckets.size > 4_000) {
      const oldestKey = this.buckets.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.buckets.delete(oldestKey);
    }
  }
}

function positiveLimit(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * 敏感接口的固定窗口限速（登录 / 注册 / 兑换 / 会员任务）。
 * 单实例进程内计数：systemd 单机部署有效；多实例部署下每个实例各自计数，
 * 需要跨实例一致时应换成 PostgresFixedWindowRateLimiter。
 */
export class SensitiveActionGuard {
  private readonly buckets = new Map<
    string,
    { startedAt: number; count: number; durationMs: number }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  /** 返回 null 表示放行，返回数字表示还需等待的秒数。 */
  consume(key: string, limit: number, durationMs: number): number | null {
    const now = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.durationMs !== durationMs || now - bucket.startedAt >= durationMs) {
      this.buckets.set(key, { startedAt: now, count: 1, durationMs });
      this.prune(now);
      return null;
    }
    if (bucket.count >= limit) {
      return Math.max(1, Math.ceil((durationMs - (now - bucket.startedAt)) / 1_000));
    }
    bucket.count += 1;
    return null;
  }

  private prune(now: number) {
    if (this.buckets.size < 2_000) return;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.startedAt >= bucket.durationMs) this.buckets.delete(key);
    }
    while (this.buckets.size > 4_000) {
      const oldestKey = this.buckets.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.buckets.delete(oldestKey);
    }
  }
}

export function rateLimitedResponse(context: Context, retryAfterSeconds: number) {
  context.header("Retry-After", String(retryAfterSeconds));
  return errorResponse(context, 429, "RATE_LIMITED", "操作太频繁了，请稍后再试");
}
