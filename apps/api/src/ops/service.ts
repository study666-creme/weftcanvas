import type { ModelHealth } from "@weftcanvas/contracts";

import type { ModelHealthProvider } from "../catalog/model-health.js";
import type { OpsJobRow, OpsStore } from "./store.js";

export const OPS_WINDOW_HOURS = 24;
/** in-flight 任务超过这个时长没更新即视为积压（与告警共用同一口径）。 */
export const OPS_STALE_INFLIGHT_MS = 30 * 60_000;

export type OpsCatalogStatus = {
  version: string | null;
  quoteAvailable: boolean;
  expiresAt: string | null;
};

export type OpsOverview = {
  generatedAt: string;
  windowHours: number;
  users: number;
  projects: number;
  media: { count: number; bytes: number };
  jobs: {
    completed: number;
    failed: number;
    inFlight: number;
    staleInFlight: number;
    oldestInFlightUpdatedAt: string | null;
  };
  catalog: OpsCatalogStatus;
  modelHealth: Array<{ modelId: string; successRate: number; sampleCount: number }>;
};

export type CanvasOpsServiceDeps = {
  store: OpsStore;
  modelHealth?: ModelHealthProvider;
  readCatalogStatus: () => Promise<OpsCatalogStatus>;
  now?: () => number;
};

/**
 * 画布运营后台的读侧服务：只读聚合（用户/项目/素材/任务/目录新鲜度/模型成功率），
 * 不做任何写操作。数据全部来自通用表，公开树自托管者同样可用。
 */
export class CanvasOpsService {
  private readonly now: () => number;

  constructor(private readonly deps: CanvasOpsServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  async overview(): Promise<OpsOverview> {
    const now = this.now();
    const sinceIso = new Date(now - OPS_WINDOW_HOURS * 3_600_000).toISOString();
    const staleBeforeIso = new Date(now - OPS_STALE_INFLIGHT_MS).toISOString();
    const [users, projects, media, jobs, health, catalog] = await Promise.all([
      this.deps.store.countUsers(),
      this.deps.store.countProjects(),
      this.deps.store.mediaTotals(),
      this.deps.store.jobCounts(sinceIso, staleBeforeIso),
      this.deps.modelHealth?.get() ?? Promise.resolve(new Map<string, ModelHealth>()),
      this.deps.readCatalogStatus().catch(() => ({
        version: null,
        quoteAvailable: false,
        expiresAt: null,
      })),
    ]);
    return {
      generatedAt: new Date(now).toISOString(),
      windowHours: OPS_WINDOW_HOURS,
      users,
      projects,
      media,
      jobs,
      catalog,
      modelHealth: [...health.entries()]
        .map(([modelId, stats]) => ({
          modelId,
          successRate: stats.successRate,
          sampleCount: stats.sampleCount,
        }))
        .sort((a, b) => b.sampleCount - a.sampleCount)
        .slice(0, 50),
    };
  }

  recentJobs(status: "failed" | "all", limit: number): Promise<OpsJobRow[]> {
    return this.deps.store.recentJobs(status, Math.min(Math.max(1, limit || 50), 200));
  }
}
