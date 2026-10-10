import { describe, expect, it } from "vitest";

import {
  GenerationApiGuard,
  type FixedWindowRateLimiter,
} from "./api-rate-limit.js";

describe("generation API guard", () => {
  it("applies independent submission and read windows", async () => {
    const limiter = new MemoryLimiter();
    const guard = new GenerationApiGuard(limiter, {
      submissionsPerMinute: 2,
      submissionsPerDay: 3,
      readsPerMinute: 1,
    });

    await guard.checkSubmission("user-1");
    await guard.checkSubmission("user-1");
    await expect(guard.checkSubmission("user-1")).rejects.toMatchObject({
      code: "GENERATION_RATE_LIMITED",
      retryAfterSeconds: 60,
    });
    await guard.checkRead("user-1");
    await expect(guard.checkRead("user-1")).rejects.toMatchObject({ code: "GENERATION_RATE_LIMITED" });
    expect(limiter.calls.map((call) => call.scope)).toEqual([
      "generation:submit:minute",
      "generation:submit:day",
      "generation:submit:minute",
      "generation:submit:day",
      "generation:submit:minute",
      "generation:read:minute",
      "generation:read:minute",
    ]);
  });

  it("disables a submission window configured as zero instead of failing closed", async () => {
    const limiter = new MemoryLimiter();
    const guard = new GenerationApiGuard(limiter, { submissionsPerMinute: 0, submissionsPerDay: 0 });
    for (let index = 0; index < 5; index += 1) await guard.checkSubmission("user-1");
    // 上限为 0 表示不设上限：连计数都不产生。
    expect(limiter.calls).toEqual([]);
  });

  it("removes only the disabled submission window", async () => {
    const limiter = new MemoryLimiter();
    const guard = new GenerationApiGuard(limiter, { submissionsPerMinute: 0, submissionsPerDay: 2 });
    await guard.checkSubmission("user-1");
    await guard.checkSubmission("user-1");
    await expect(guard.checkSubmission("user-1")).rejects.toMatchObject({ code: "GENERATION_RATE_LIMITED" });
    expect(limiter.calls.map((call) => call.scope)).toEqual([
      "generation:submit:day",
      "generation:submit:day",
      "generation:submit:day",
    ]);
  });

  it("caps live streams and releases slots idempotently", async () => {    const guard = new GenerationApiGuard(new MemoryLimiter(), {
      streamsPerOwner: 1,
      streamsGlobal: 2,
      streamStartsPerMinute: 10,
    });
    const release = await guard.acquireStream("user-1");
    await expect(guard.acquireStream("user-1")).rejects.toMatchObject({ code: "GENERATION_STREAM_LIMITED" });
    release();
    release();
    const next = await guard.acquireStream("user-1");
    next();
  });
});

class MemoryLimiter implements FixedWindowRateLimiter {
  readonly calls: Array<{ scope: string; subjectId: string }> = [];
  private readonly counts = new Map<string, number>();

  async consume(options: { scope: string; subjectId: string; limit: number }) {
    this.calls.push({ scope: options.scope, subjectId: options.subjectId });
    const key = `${options.scope}:${options.subjectId}`;
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return {
      allowed: count <= options.limit,
      remaining: Math.max(0, options.limit - count),
      resetAt: "2026-07-15T21:01:00.000Z",
      retryAfterSeconds: 60,
    };
  }
}
