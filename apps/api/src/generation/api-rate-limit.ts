import type { Pool } from "pg";

type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAt: string;
  retryAfterSeconds: number;
};

export interface FixedWindowRateLimiter {
  consume(options: {
    scope: string;
    subjectId: string;
    limit: number;
    windowMs: number;
    cost?: number;
  }): Promise<RateLimitResult>;
}

export class PostgresFixedWindowRateLimiter implements FixedWindowRateLimiter {
  private readonly now: () => number;
  private lastCleanupAt = 0;
  private cleanupPromise: Promise<void> | null = null;

  constructor(private readonly pool: Pool, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  async consume(options: {
    scope: string;
    subjectId: string;
    limit: number;
    windowMs: number;
    cost?: number;
  }): Promise<RateLimitResult> {
    const scope = validScope(options.scope);
    const subjectId = validSubject(options.subjectId);
    const limit = positiveInteger(options.limit, "limit");
    const windowMs = positiveInteger(options.windowMs, "windowMs");
    const cost = positiveInteger(options.cost ?? 1, "cost");
    if (cost > limit) throw new Error("Rate-limit cost cannot exceed its limit");
    const now = this.now();
    const windowStartMs = Math.floor(now / windowMs) * windowMs;
    const resetAtMs = windowStartMs + windowMs;
    const windowStart = new Date(windowStartMs).toISOString();
    const expiresAt = new Date(resetAtMs + 24 * 60 * 60_000).toISOString();
    const result = await this.pool.query<{ request_count: number }>(
      `INSERT INTO canvas_api_rate_limits (
         scope, subject_id, window_start, request_count, expires_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (scope, subject_id, window_start) DO UPDATE
       SET request_count = canvas_api_rate_limits.request_count + EXCLUDED.request_count,
           expires_at = GREATEST(canvas_api_rate_limits.expires_at, EXCLUDED.expires_at),
           updated_at = NOW()
       WHERE canvas_api_rate_limits.request_count + EXCLUDED.request_count <= $6
       RETURNING request_count`,
      [scope, subjectId, windowStart, cost, expiresAt, limit],
    );
    await this.scheduleCleanup(now);
    const count = result.rows[0]?.request_count;
    return {
      allowed: count !== undefined,
      remaining: count === undefined ? 0 : Math.max(0, limit - count),
      resetAt: new Date(resetAtMs).toISOString(),
      retryAfterSeconds: Math.max(1, Math.ceil((resetAtMs - now) / 1_000)),
    };
  }

  private scheduleCleanup(now: number) {
    if (this.cleanupPromise) return this.cleanupPromise;
    if (now - this.lastCleanupAt < 60 * 60_000) return Promise.resolve();
    this.lastCleanupAt = now;
    this.cleanupPromise = this.pool.query(
      `DELETE FROM canvas_api_rate_limits
       WHERE ctid IN (
         SELECT ctid FROM canvas_api_rate_limits
         WHERE expires_at < $1
         ORDER BY expires_at
         LIMIT 1000
       )`,
      [new Date(now).toISOString()],
    ).then(() => undefined).catch((error) => {
      console.error("Rate-limit cleanup failed", error);
    }).finally(() => {
      this.cleanupPromise = null;
    });
    return this.cleanupPromise;
  }
}

export class GenerationApiLimitError extends Error {
  constructor(
    readonly code: "GENERATION_RATE_LIMITED" | "GENERATION_STREAM_LIMITED",
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message);
    this.name = "GenerationApiLimitError";
  }
}

type GenerationApiGuardOptions = {
  submissionsPerMinute?: number;
  submissionsPerDay?: number;
  readsPerMinute?: number;
  streamStartsPerMinute?: number;
  streamsPerOwner?: number;
  streamsGlobal?: number;
};

export class GenerationApiGuard {
  private readonly limits: Required<GenerationApiGuardOptions>;
  private readonly ownerStreams = new Map<string, number>();
  private streamCount = 0;

  constructor(private readonly limiter: FixedWindowRateLimiter, options: GenerationApiGuardOptions = {}) {
    this.limits = {
      // 提交上限支持 0 = 不设上限（见 checkSubmission）。读取/流连接仍必须为正数。
      submissionsPerMinute: nonNegativeInteger(options.submissionsPerMinute ?? 10, "submissionsPerMinute"),
      submissionsPerDay: nonNegativeInteger(options.submissionsPerDay ?? 100, "submissionsPerDay"),
      readsPerMinute: positiveInteger(options.readsPerMinute ?? 180, "readsPerMinute"),
      streamStartsPerMinute: positiveInteger(options.streamStartsPerMinute ?? 30, "streamStartsPerMinute"),
      streamsPerOwner: positiveInteger(options.streamsPerOwner ?? 3, "streamsPerOwner"),
      streamsGlobal: positiveInteger(options.streamsGlobal ?? 200, "streamsGlobal"),
    };
  }

  /**
   * 提交限流：任一项配置为 0 即视为不设上限，连计数都不写。
   * 「提交不设上限」是产品明确要求——用量本身由积分与上游额度约束，
   * 并发由 GENERATION_MAX_ACTIVE_JOBS 约束；给提交设日上限会直接打断
   * 批量出图这类正常用法。
   */
  async checkSubmission(ownerId: string) {
    if (this.limits.submissionsPerMinute > 0) {
      await this.requireAllowed(await this.limiter.consume({
        scope: "generation:submit:minute",
        subjectId: ownerId,
        limit: this.limits.submissionsPerMinute,
        windowMs: 60_000,
      }), "提交过于频繁，请稍后再试");
    }
    if (this.limits.submissionsPerDay > 0) {
      await this.requireAllowed(await this.limiter.consume({
        scope: "generation:submit:day",
        subjectId: ownerId,
        limit: this.limits.submissionsPerDay,
        windowMs: 24 * 60 * 60_000,
      }), "今日提交次数已达到当前限制");
    }
  }

  async checkRead(ownerId: string) {
    await this.requireAllowed(await this.limiter.consume({
      scope: "generation:read:minute",
      subjectId: ownerId,
      limit: this.limits.readsPerMinute,
      windowMs: 60_000,
    }), "状态刷新过于频繁，请稍后再试");
  }

  async acquireStream(ownerId: string) {
    await this.requireAllowed(await this.limiter.consume({
      scope: "generation:stream:minute",
      subjectId: ownerId,
      limit: this.limits.streamStartsPerMinute,
      windowMs: 60_000,
    }), "状态连接过于频繁，请稍后再试");
    const ownerCount = this.ownerStreams.get(ownerId) ?? 0;
    if (ownerCount >= this.limits.streamsPerOwner || this.streamCount >= this.limits.streamsGlobal) {
      throw new GenerationApiLimitError("GENERATION_STREAM_LIMITED", "当前状态连接过多，请稍后再试", 5);
    }
    this.ownerStreams.set(ownerId, ownerCount + 1);
    this.streamCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.ownerStreams.get(ownerId) ?? 1;
      if (current <= 1) this.ownerStreams.delete(ownerId);
      else this.ownerStreams.set(ownerId, current - 1);
      this.streamCount = Math.max(0, this.streamCount - 1);
    };
  }

  private async requireAllowed(result: RateLimitResult, message: string) {
    if (!result.allowed) {
      throw new GenerationApiLimitError("GENERATION_RATE_LIMITED", message, result.retryAfterSeconds);
    }
  }
}

function validScope(value: string) {
  const normalized = value.trim();
  if (!/^[a-z0-9:_-]{1,64}$/.test(normalized)) throw new Error("Rate-limit scope is invalid");
  return normalized;
}

function validSubject(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\r\n\u0000]/.test(normalized)) {
    throw new Error("Rate-limit subject is invalid");
  }
  return normalized;
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
}
