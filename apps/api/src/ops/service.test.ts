import { describe, expect, it } from "vitest";

import type { ModelHealth } from "@weftcanvas/contracts";

import { CanvasOpsService, OPS_STALE_INFLIGHT_MS, OPS_WINDOW_HOURS } from "./service.js";
import type { OpsJobRow, OpsStore } from "./store.js";

const NOW = Date.parse("2026-10-13T12:00:00.000Z");

function fakeStore(overrides: Partial<OpsStore> = {}): OpsStore & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async countUsers() {
      calls.push("users");
      return 42;
    },
    async countProjects() {
      calls.push("projects");
      return 7;
    },
    async mediaTotals() {
      return { count: 120, bytes: 5_000_000_000 };
    },
    async jobCounts() {
      return {
        completed: 80,
        failed: 20,
        inFlight: 3,
        staleInFlight: 1,
        oldestInFlightUpdatedAt: new Date(NOW - 60 * 60_000).toISOString(),
      };
    },
    async recentJobs(): Promise<OpsJobRow[]> {
      return [];
    },
    ...overrides,
  };
}

function setup(options: {
  store?: Partial<OpsStore>;
  health?: Map<string, ModelHealth>;
  catalogFails?: boolean;
}) {
  const service = new CanvasOpsService({
    store: fakeStore(options.store),
    ...(options.health ? { modelHealth: { get: async () => options.health! } } : {}),
    readCatalogStatus: options.catalogFails
      ? async () => {
          throw new Error("catalog down");
        }
      : async () => ({
          version: "cat-1",
          quoteAvailable: true,
          expiresAt: new Date(NOW + 600_000).toISOString(),
        }),
    now: () => NOW,
  });
  return { service };
}

describe("CanvasOpsService", () => {
  it("assembles the overview from store, health and catalog status", async () => {
    const { service } = setup({
      health: new Map([
        ["m-big", { successRate: 0.95, sampleCount: 200, windowHours: 168 }],
        ["m-small", { successRate: 0.5, sampleCount: 6, windowHours: 168 }],
      ]),
    });
    const overview = await service.overview();

    expect(overview.users).toBe(42);
    expect(overview.projects).toBe(7);
    expect(overview.media).toEqual({ count: 120, bytes: 5_000_000_000 });
    expect(overview.jobs).toMatchObject({
      completed: 80,
      failed: 20,
      inFlight: 3,
      staleInFlight: 1,
    });
    expect(overview.windowHours).toBe(OPS_WINDOW_HOURS);
    // 模型健康按样本量降序，无 provider 时为空。
    expect(overview.modelHealth.map((m) => m.modelId)).toEqual(["m-big", "m-small"]);
    expect(overview.catalog.quoteAvailable).toBe(true);
  });

  it("degrades to an empty/unavailable view when catalog status throws", async () => {
    const { service } = setup({ catalogFails: true });
    const overview = await service.overview();
    expect(overview.catalog).toEqual({ version: null, quoteAvailable: false, expiresAt: null });
    expect(overview.modelHealth).toEqual([]);
  });

  it("bounds the recent-jobs limit into 1..200", async () => {
    let seen = -1;
    const { service } = setup({
      store: {
        async recentJobs(_status, limit) {
          seen = limit;
          return [];
        },
      },
    });
    await service.recentJobs("failed", 9_999);
    expect(seen).toBe(200);
    // 0/未指定回落到默认 50，负数夹到 1。
    await service.recentJobs("all", 0);
    expect(seen).toBe(50);
    await service.recentJobs("all", -5);
    expect(seen).toBe(1);
  });

  it("stale window is shared with the alert watchdog (30 minutes)", () => {
    expect(OPS_STALE_INFLIGHT_MS).toBe(30 * 60_000);
  });
});
