import type { CloudProjectUsage } from "@kachang/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { quotaLevel, useStorageTipStore } from "./storage-tip-store";

const OWNER = "99999999-9999-4999-8999-999999999999";

function usage(mediaBytes: number, quotaBytes = 1000): CloudProjectUsage {
  return {
    projectCount: 1,
    projectStorageBytes: 0,
    mediaStorageBytes: mediaBytes,
    entitlements: {
      tier: "free",
      cloudProjectLimit: 3,
      projectStorageBytes: 10_000_000,
      mediaStorageBytes: quotaBytes,
      revisionRetentionCount: 3,
      multiDeviceSync: true,
    },
  };
}

describe("storage tip store", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      localStorage: new MemoryStorage(),
    });
    useStorageTipStore.getState().reset();
  });

  it("reports quota levels at the 80/95/100 thresholds", () => {
    expect(quotaLevel(usage(500)).level).toBeNull();
    expect(quotaLevel(usage(799)).level).toBeNull();
    expect(quotaLevel(usage(800)).level).toBe("nearing");
    expect(quotaLevel(usage(950)).level).toBe("critical");
    expect(quotaLevel(usage(1001)).level).toBe("over");
    expect(quotaLevel(null).level).toBeNull();
    expect(quotaLevel(usage(500, 0)).level).toBeNull();
  });

  it("shows the tip when nearing and clears the dismissal when usage recovers", () => {
    const store = useStorageTipStore.getState();
    store.reevaluate(usage(850));
    expect(useStorageTipStore.getState().visible).toBe(true);
    expect(useStorageTipStore.getState().level).toBe("nearing");

    useStorageTipStore.getState().dismiss();
    expect(useStorageTipStore.getState().visible).toBe(false);

    useStorageTipStore.getState().reevaluate(usage(400));
    useStorageTipStore.getState().reevaluate(usage(860));
    // 用量恢复后再次逼近：dismissed 记录已被清除，贴士重新出现。
    expect(useStorageTipStore.getState().visible).toBe(true);
  });

  it("reappears when the same level degrades by 5+ percent", () => {
    const store = useStorageTipStore.getState();
    store.reevaluate(usage(800));
    useStorageTipStore.getState().dismiss();
    expect(useStorageTipStore.getState().visible).toBe(false);

    // 同档位 +3%：保持关闭
    useStorageTipStore.getState().reevaluate(usage(830));
    expect(useStorageTipStore.getState().visible).toBe(false);

    // 同档位 +6%：重新出现
    useStorageTipStore.getState().reevaluate(usage(860));
    expect(useStorageTipStore.getState().visible).toBe(true);
  });

  it("reappears when the quota escalates to a more severe level", () => {
    const store = useStorageTipStore.getState();
    store.reevaluate(usage(850));
    useStorageTipStore.getState().dismiss();
    useStorageTipStore.getState().reevaluate(usage(1001));
    expect(useStorageTipStore.getState().level).toBe("over");
    expect(useStorageTipStore.getState().visible).toBe(true);
  });

  it("prefers the grace banner while a downgrade grace deadline is active", () => {
    const deadline = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    useStorageTipStore.getState().reevaluate(usage(400), { fromTier: "basic", quotaBytes: 300, usageBytes: 400, deadline });
    expect(useStorageTipStore.getState().level).toBe("grace");
    expect(useStorageTipStore.getState().visible).toBe(true);

    // 宽限期过期后回落到按百分比计算（仍超出配额 → over）。
    const expired = new Date(Date.now() - 1000).toISOString();
    useStorageTipStore.getState().reevaluate(usage(1001), { fromTier: "basic", quotaBytes: 300, usageBytes: 1001, deadline: expired });
    expect(useStorageTipStore.getState().level).toBe("over");
  });

  it("keeps a grace dismissal suppressed for the active grace window", () => {
    const deadline = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    useStorageTipStore.getState().reevaluate(usage(400), { fromTier: "basic", quotaBytes: 300, usageBytes: 400, deadline });
    useStorageTipStore.getState().dismiss();
    useStorageTipStore.getState().reevaluate(usage(400), { fromTier: "basic", quotaBytes: 300, usageBytes: 400, deadline });
    expect(useStorageTipStore.getState().visible).toBe(false);
    expect(OWNER).toBeTruthy();
  });
});

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(key: string) { return this.map.get(key) ?? null; }
  key(index: number) { return [...this.map.keys()][index] ?? null; }
  removeItem(key: string) { this.map.delete(key); }
  setItem(key: string, value: string) { this.map.set(key, value); }
}
