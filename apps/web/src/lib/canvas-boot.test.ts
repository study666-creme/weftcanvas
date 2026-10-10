import { describe, expect, it } from "vitest";

import {
  CANVAS_BOOT_BACKGROUND_TIMEOUT_MS,
  CANVAS_BOOT_HARD_TIMEOUT_MS,
  getCanvasBootSnapshot,
} from "./canvas-boot";

const baseSignals = {
  identityStatus: "loading" as const,
  catalogStatuses: ["loading", "loading", "loading", "loading"] as const,
  elapsedMs: 0,
};

describe("getCanvasBootSnapshot", () => {
  it("keeps the first stage tied to the canvas runtime", () => {
    const snapshot = getCanvasBootSnapshot({ ...baseSignals, workspaceReady: false });

    expect(snapshot.stage).toBe("workspace");
    expect(snapshot.targetProgress).toBe(14);
    expect(snapshot.canFinish).toBe(false);
  });

  it("advances through account and catalog stages independently", () => {
    const identity = getCanvasBootSnapshot({
      ...baseSignals,
      workspaceReady: true,
    });
    expect(identity.stage).toBe("identity");
    expect(identity.targetProgress).toBe(48);

    const catalogs = getCanvasBootSnapshot({
      ...baseSignals,
      workspaceReady: true,
      identityStatus: "anonymous",
      catalogStatuses: ["ready", "error", "loading", "loading"],
    });
    expect(catalogs.stage).toBe("catalog");
    expect(catalogs.settledCatalogCount).toBe(2);
    expect(catalogs.targetProgress).toBe(80);
    expect(catalogs.canFinish).toBe(false);
  });

  it("treats catalog errors as settled so a degraded service cannot block entry", () => {
    const snapshot = getCanvasBootSnapshot({
      ...baseSignals,
      workspaceReady: true,
      identityStatus: "authenticated",
      catalogStatuses: ["ready", "error", "ready", "error"],
    });

    expect(snapshot.catalogsReady).toBe(true);
    expect(snapshot.stage).toBe("finalizing");
    expect(snapshot.targetProgress).toBe(96);
    expect(snapshot.canFinish).toBe(true);
  });

  it("lets a usable canvas through when background services exceed their budget", () => {
    const snapshot = getCanvasBootSnapshot({
      ...baseSignals,
      workspaceReady: true,
      identityStatus: "anonymous",
      elapsedMs: CANVAS_BOOT_BACKGROUND_TIMEOUT_MS,
    });

    expect(snapshot.timedOut).toBe(true);
    expect(snapshot.canFinish).toBe(true);
    expect(snapshot.stage).toBe("finalizing");
  });

  it("has a hard escape hatch for a broken renderer", () => {
    const snapshot = getCanvasBootSnapshot({
      ...baseSignals,
      workspaceReady: false,
      elapsedMs: CANVAS_BOOT_HARD_TIMEOUT_MS,
    });

    expect(snapshot.canFinish).toBe(true);
    expect(snapshot.stage).toBe("finalizing");
  });
});
