import { describe, expect, it, vi } from "vitest";

import type { OpsOverview } from "./service.js";
import { OpsAlertWatchdog, type OpsAlert } from "./alert.js";

const NOW = Date.parse("2026-10-13T12:00:00.000Z");

function overview(overrides: Partial<OpsOverview> = {}): OpsOverview {
  return {
    generatedAt: new Date(NOW).toISOString(),
    windowHours: 24,
    users: 10,
    projects: 5,
    media: { count: 20, bytes: 100 },
    jobs: {
      completed: 90,
      failed: 5,
      inFlight: 0,
      staleInFlight: 0,
      oldestInFlightUpdatedAt: null,
    },
    catalog: {
      version: "cat-1",
      quoteAvailable: true,
      expiresAt: new Date(NOW + 10 * 60_000_000).toISOString(),
    },
    modelHealth: [],
    ...overrides,
  };
}

function watchdog(overviews: OpsOverview[], options: { cooldownMs?: number } = {}) {
  const sent: OpsAlert[] = [];
  let index = 0;
  let now = NOW;
  const service = {
    overview: async () => {
      const current = overviews[Math.min(index, overviews.length - 1)];
      index += 1;
      return current;
    },
  };
  const wd = new OpsAlertWatchdog({
    ops: service,
    sink: async (alert) => void sent.push(alert),
    cooldownMs: options.cooldownMs ?? 30 * 60_000,
    now: () => now,
  });
  return { sent, wd, advance: (ms: number) => (now += ms) };
}

describe("OpsAlertWatchdog", () => {
  it("flags catalog failure as critical and ignores healthy state", async () => {
    const { wd } = watchdog([
      overview({ catalog: { version: null, quoteAvailable: false, expiresAt: null } }),
      overview(),
    ]);
    expect(wd.evaluate(overview()).map((a) => a.key)).toEqual([]);
    const alerts = wd.evaluate(
      overview({ catalog: { version: null, quoteAvailable: false, expiresAt: null } }),
    );
    expect(alerts).toEqual([
      expect.objectContaining({ key: "catalog-unavailable", level: "critical" }),
    ]);
  });

  it("needs a minimum sample before judging failure rate", () => {
    const { wd } = watchdog([overview()]);
    // 8/12 = 67% 但样本 <20：不结论。
    const small = overview({
      jobs: {
        completed: 4,
        failed: 8,
        inFlight: 0,
        staleInFlight: 0,
        oldestInFlightUpdatedAt: null,
      },
    });
    expect(wd.evaluate(small).map((a) => a.key)).not.toContain("failure-rate");
    const big = overview({
      jobs: {
        completed: 60,
        failed: 40,
        inFlight: 0,
        staleInFlight: 0,
        oldestInFlightUpdatedAt: null,
      },
    });
    expect(wd.evaluate(big).map((a) => a.key)).toContain("failure-rate");
  });

  it("warns on stale in-flight jobs", () => {
    const { wd } = watchdog([overview()]);
    const alerts = wd.evaluate(
      overview({
        jobs: {
          completed: 10,
          failed: 0,
          inFlight: 6,
          staleInFlight: 2,
          oldestInFlightUpdatedAt: null,
        },
      }),
    );
    expect(alerts).toEqual([expect.objectContaining({ key: "queue-backlog" })]);
  });

  it("suppresses repeats within cooldown and re-arms after recovery", async () => {
    const bad = overview({
      jobs: {
        completed: 10,
        failed: 0,
        inFlight: 6,
        staleInFlight: 2,
        oldestInFlightUpdatedAt: null,
      },
    });
    const { sent, wd, advance } = watchdog([bad, bad, bad, overview(), bad]);
    await wd.checkOnce(); // 报 1 次
    await wd.checkOnce(); // 冷却内静默
    expect(sent).toHaveLength(1);
    advance(31 * 60_000);
    await wd.checkOnce(); // 冷却过后重报
    expect(sent).toHaveLength(2);
    await wd.checkOnce(); // 恢复：解除冷却（不发送）
    await wd.checkOnce(); // 再次发生：立刻重报（不等冷却）
    expect(sent).toHaveLength(3);
    expect(sent[2]).toEqual(expect.objectContaining({ key: "queue-backlog" }));
  });

  it("sink failures are reported but never stop the loop", async () => {
    const onError = vi.fn();
    let calls = 0;
    const wd = new OpsAlertWatchdog({
      ops: {
        overview: async () =>
          overview({
            catalog: { version: null, quoteAvailable: false, expiresAt: null },
          }),
      },
      sink: async () => {
        calls += 1;
        throw new Error("webhook down");
      },
      now: () => NOW,
      onError,
    });
    await wd.checkOnce();
    await wd.checkOnce();
    expect(calls).toBe(1); // 第二次进入冷却
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
