import { describe, expect, it, vi } from "vitest";

import {
  MODEL_HEALTH_MIN_SAMPLES,
  MODEL_HEALTH_WINDOW_HOURS,
  PostgresModelHealthProvider,
} from "./model-health.js";

function poolWith(rows: Array<{ model_id: string; completed: number; failed: number }>) {
  return {
    query: vi.fn(async () => ({ rows })),
  };
}

describe("PostgresModelHealthProvider", () => {
  it("aggregates success rate over terminal jobs in the rolling window", async () => {
    const pool = poolWith([
      { model_id: "m-good", completed: 95, failed: 5 },
      { model_id: "m-bad", completed: 2, failed: 8 },
      { model_id: "m-few", completed: MODEL_HEALTH_MIN_SAMPLES - 1, failed: 0 },
    ]);
    const provider = new PostgresModelHealthProvider(pool);
    const health = await provider.get();

    expect(health.get("m-good")).toEqual({
      successRate: 0.95,
      sampleCount: 100,
      windowHours: MODEL_HEALTH_WINDOW_HOURS,
    });
    expect(health.get("m-bad")?.successRate).toBeCloseTo(0.2);
    // 样本不足的模型不产出，避免小样本噪声。
    expect(health.has("m-few")).toBe(false);
    // 窗口下界随查询下发。
    const [, params] = pool.query.mock.calls[0] as [unknown, string[]];
    expect(new Date(params[0]!).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("caches results within the TTL and refreshes after it", async () => {
    let now = 1_760_000_000_000;
    const pool = poolWith([{ model_id: "m-1", completed: 10, failed: 0 }]);
    const provider = new PostgresModelHealthProvider(pool, { now: () => now, ttlMs: 1_000 });

    await provider.get();
    await provider.get();
    expect(pool.query).toHaveBeenCalledTimes(1);

    now += 1_500;
    await provider.get();
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it("serves the stale cache when a refresh query fails", async () => {
    let now = 1_760_000_000_000;
    const pool = poolWith([{ model_id: "m-1", completed: 10, failed: 0 }]);
    const provider = new PostgresModelHealthProvider(pool, { now: () => now, ttlMs: 1_000 });
    await provider.get();

    now += 5_000;
    pool.query.mockRejectedValueOnce(new Error("db down"));
    const health = await provider.get();
    expect(health.get("m-1")?.successRate).toBe(1);
  });

  it("returns an empty map (never fabricates) when the first query fails", async () => {
    const pool = {
      query: vi.fn(async () => {
        throw new Error("db down");
      }),
    };
    const provider = new PostgresModelHealthProvider(pool as never);
    expect((await provider.get()).size).toBe(0);
  });
});
