export type CanvasBootIdentityStatus =
  "idle" | "loading" | "authenticated" | "anonymous" | "unavailable";

export type CanvasBootCatalogStatus = "idle" | "loading" | "ready" | "error";

export type CanvasBootStage = "workspace" | "identity" | "catalog" | "finalizing";

export type CanvasBootSignals = {
  workspaceReady: boolean;
  identityStatus: CanvasBootIdentityStatus;
  catalogStatuses: readonly CanvasBootCatalogStatus[];
  elapsedMs: number;
};

export type CanvasBootSnapshot = {
  identityReady: boolean;
  settledCatalogCount: number;
  catalogsReady: boolean;
  timedOut: boolean;
  canFinish: boolean;
  targetProgress: number;
  stage: CanvasBootStage;
};

export const CANVAS_BOOT_MIN_VISIBLE_MS = 520;
export const CANVAS_BOOT_BACKGROUND_TIMEOUT_MS = 2_400;
export const CANVAS_BOOT_HARD_TIMEOUT_MS = 3_200;

const settledIdentityStatuses = new Set<CanvasBootIdentityStatus>([
  "authenticated",
  "anonymous",
  "unavailable",
]);

const settledCatalogStatuses = new Set<CanvasBootCatalogStatus>(["ready", "error"]);

/**
 * Turns boot signals into a deliberately monotonic target. The first three
 * weights represent real work; the final few points are reserved for the
 * visual hand-off after the canvas is usable.
 */
export function getCanvasBootSnapshot(signals: CanvasBootSignals): CanvasBootSnapshot {
  const identityReady = settledIdentityStatuses.has(signals.identityStatus);
  const settledCatalogCount = signals.catalogStatuses.filter((status) =>
    settledCatalogStatuses.has(status),
  ).length;
  const catalogsReady =
    signals.catalogStatuses.length > 0 && settledCatalogCount === signals.catalogStatuses.length;
  const timedOut = signals.elapsedMs >= CANVAS_BOOT_BACKGROUND_TIMEOUT_MS;
  const hardTimedOut = signals.elapsedMs >= CANVAS_BOOT_HARD_TIMEOUT_MS;
  const coreReady = signals.workspaceReady;
  const canFinish = hardTimedOut || (coreReady && ((identityReady && catalogsReady) || timedOut));

  const targetProgress = Math.min(
    96,
    Math.round(
      14 +
        (signals.workspaceReady ? 34 : 0) +
        (identityReady ? 18 : 0) +
        settledCatalogCount * 7 +
        (catalogsReady ? 2 : 0),
    ),
  );

  let stage: CanvasBootStage = "workspace";
  if (signals.workspaceReady && !identityReady) stage = "identity";
  else if (timedOut || hardTimedOut || (signals.workspaceReady && identityReady && catalogsReady))
    stage = "finalizing";
  else if (signals.workspaceReady && identityReady && !catalogsReady) stage = "catalog";

  return {
    identityReady,
    settledCatalogCount,
    catalogsReady,
    timedOut,
    canFinish,
    targetProgress,
    stage,
  };
}
