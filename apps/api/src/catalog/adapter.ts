import type { PublicModel } from "@weftcanvas/contracts";
import { z } from "zod";

import {
  catalogNormalizationVersion,
  normalizeSourceCatalog,
  withQuoteAvailability,
  type CatalogCompatibilityOverlay,
} from "./normalize.js";
import { applyModelOverrides, type ModelOverrideStore } from "./overrides.js";
import type { CatalogSnapshotStore, StoredCatalogSnapshot } from "./store.js";
import { executorAvailability } from "./video-executability.js";

const hostedModelInventorySchema = z.object({
  success: z.literal(true),
  models: z.array(
    z.object({
      id: z.string().trim().min(1),
      modality: z.enum(["text", "image", "video", "audio"]),
      selectable: z.boolean().optional(),
    }),
  ),
});

export class CatalogUnavailableError extends Error {
  readonly code = "MODEL_CATALOG_UNAVAILABLE";

  constructor(cause?: unknown) {
    super("模型目录暂时不可用，请稍后重试", { cause });
    this.name = "CatalogUnavailableError";
  }
}

type CatalogAdapterOptions = {
  /**
   * 上游目录端点。缺省 = 纯快照模式（snapshot-only，dev-test 自托管场景
   * 没有默认端点，也不该偷偷猜一个）：永不出网刷新，只用已存快照。
   */
  sourceUrl?: string;
  videoInventoryUrl?: string;
  store: CatalogSnapshotStore;
  /** Operator visibility/price overrides applied to the published catalog. */
  overrides?: ModelOverrideStore;
  fetch?: typeof globalThis.fetch;
  inventoryFetch?: typeof globalThis.fetch;
  includeKnownModels?: boolean;
  /** 站点策展兼容层（私有 overlay）；公开/自托管缺省不注入。 */
  overlay?: CatalogCompatibilityOverlay;
  refreshIntervalMs?: number;
  requestTimeoutMs?: number;
  maxQuoteAgeMs?: number;
  now?: () => number;
};

export class WeftcanvasCatalogAdapter {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly inventoryFetcher: typeof globalThis.fetch;
  private readonly refreshIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxQuoteAgeMs: number;
  private readonly now: () => number;
  private snapshot: StoredCatalogSnapshot | null = null;
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private lastCheckedAt = 0;
  private refreshPromise: Promise<void> | null = null;
  private refreshFailureCount = 0;
  private refreshRetryAt = 0;

  constructor(private readonly options: CatalogAdapterOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.inventoryFetcher = options.inventoryFetch ?? this.fetcher;
    this.refreshIntervalMs = options.refreshIntervalMs ?? 60_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 12_000;
    this.maxQuoteAgeMs = options.maxQuoteAgeMs ?? 6 * 60 * 60_000;
    this.now = options.now ?? Date.now;
  }

  async getCatalog(
    options: {
      forceRefresh?: boolean;
      awaitRefresh?: boolean;
      awaitVideoAvailability?: boolean;
      /** Admin reads the raw upstream view so hidden models can be un-hidden. */
      includeOverrides?: boolean;
    } = {},
  ) {
    await this.loadStoredSnapshot();
    const now = this.now();
    const snapshotExpired = this.snapshot
      ? now >= Date.parse(this.snapshot.catalog.expiresAt)
      : false;
    const snapshotIncomplete = this.snapshot ? !hasCompleteExecutionRoutes(this.snapshot) : false;
    const videoAvailabilityMissing =
      this.options.videoInventoryUrl && this.snapshot
        ? !hasFreshVideoAvailability(this.snapshot, now, this.refreshIntervalMs)
        : false;
    const snapshotNeedsNormalization = this.snapshot
      ? !hasCurrentNormalization(this.snapshot, this.options.overlay)
      : false;
    const mustAwaitRefresh =
      options.forceRefresh === true ||
      !this.snapshot ||
      snapshotNeedsNormalization ||
      snapshotIncomplete ||
      (options.awaitRefresh === true && (snapshotExpired || snapshotIncomplete)) ||
      (options.awaitVideoAvailability === true && videoAvailabilityMissing);
    const shouldRefresh =
      Boolean(this.options.sourceUrl) &&
      (mustAwaitRefresh ||
        now - this.lastCheckedAt >= this.refreshIntervalMs ||
        snapshotExpired ||
        snapshotIncomplete ||
        videoAvailabilityMissing ||
        snapshotNeedsNormalization);
    const refreshAllowed = options.forceRefresh === true || now >= this.refreshRetryAt;
    if (shouldRefresh && refreshAllowed) {
      if (mustAwaitRefresh) await this.refreshSafely();
      else void this.refreshSafely();
    }
    if (!this.snapshot) throw new CatalogUnavailableError();
    const currentCatalog = withQuoteAvailability(this.snapshot.catalog, this.now());
    const sourceCatalog = this.options.videoInventoryUrl
      ? filterVideoModels(currentCatalog, this.snapshot.videoAvailability)
      : currentCatalog;
    const catalog =
      this.options.overrides && options.includeOverrides !== false
        ? applyModelOverrides(sourceCatalog, await this.options.overrides.load())
        : sourceCatalog;
    return hasCompleteExecutionRoutes(this.snapshot) &&
      hasCurrentNormalization(this.snapshot, this.options.overlay)
      ? catalog
      : { ...catalog, quoteAvailable: false };
  }

  async getModel(publicModelId: string, options: { forceRefresh?: boolean } = {}) {
    await this.loadStoredSnapshot();
    const knownVideo = this.snapshot?.catalog.models.some(
      (model) => model.id === publicModelId && model.modality === "video",
    );
    let catalog = await this.getCatalog({
      ...options,
      awaitRefresh: true,
      awaitVideoAvailability: knownVideo,
    });
    const resolve = () => {
      const model = catalog.models.find((item) => item.id === publicModelId);
      const sourceModelId = this.snapshot?.sourceModels[publicModelId];
      const route = this.snapshot?.routes[publicModelId];
      return model && sourceModelId && route && route.sourceModelId === sourceModelId
        ? { catalog, model, sourceModelId, route }
        : null;
    };
    const record = resolve();
    // A browser can quote against a valid stored snapshot that predates a
    // newly published model or route. Retry one authoritative refresh before
    // reporting MODEL_NOT_AVAILABLE so transient catalog skew does not block a
    // submit.
    const refreshedKnownVideo = this.snapshot?.catalog.models.some(
      (model) => model.id === publicModelId && model.modality === "video",
    );
    const knownUnavailableVideo =
      refreshedKnownVideo &&
      (hasFreshVideoAvailability(this.snapshot, this.now(), this.refreshIntervalMs) ||
        this.now() < this.refreshRetryAt);
    if (record || options.forceRefresh === true || knownUnavailableVideo) return record;
    catalog = await this.getCatalog({ forceRefresh: true, awaitRefresh: true });
    return resolve();
  }

  async getExecutionRoute(publicModelId: string) {
    const record = await this.getModel(publicModelId);
    if (!record) return null;
    return {
      route: record.route,
      pricing: record.model.pricing,
      catalogVersion: record.catalog.version,
      capabilityVersion: record.catalog.capabilityVersion,
      pricingVersion: record.catalog.pricingVersion,
    };
  }

  private async loadStoredSnapshot() {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = this.options.store
        .load()
        .then((snapshot) => {
          const compatible = snapshot
            ? (this.options.overlay?.ensureSnapshotCompatibility?.(snapshot) ?? snapshot)
            : null;
          this.snapshot = compatible;
          if (compatible && compatible !== snapshot) void this.options.store.save(compatible);
          this.loaded = true;
        })
        .finally(() => {
          this.loadPromise = null;
        });
    }
    await this.loadPromise;
  }

  private async refreshSafely() {
    if (!this.refreshPromise) {
      const request = this.refresh()
        .then(() => {
          this.refreshFailureCount = 0;
          this.refreshRetryAt = 0;
        })
        .catch((cause) => {
          this.refreshFailureCount += 1;
          const retryDelay = Math.min(
            5 * 60_000,
            2_000 * 2 ** Math.min(7, this.refreshFailureCount - 1),
          );
          this.refreshRetryAt = this.now() + retryDelay;
          if (!this.snapshot) throw new CatalogUnavailableError(cause);
          console.error("Catalog refresh failed", cause);
        })
        .finally(() => {
          if (this.refreshPromise === request) this.refreshPromise = null;
        });
      this.refreshPromise = request;
    }
    return this.refreshPromise;
  }

  private async refresh() {
    const checkedAt = this.now();
    this.lastCheckedAt = checkedAt;
    const headers = new Headers({ Accept: "application/json" });
    const canRevalidateSnapshot =
      this.snapshot &&
      hasCompleteExecutionRoutes(this.snapshot) &&
      hasCurrentNormalization(this.snapshot, this.options.overlay);
    if (this.snapshot?.etag && canRevalidateSnapshot)
      headers.set("If-None-Match", this.snapshot.etag);
    const [sourceResult, inventoryResult] = await Promise.allSettled([
      this.fetcher(this.options.sourceUrl!, {
        headers,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      }),
      this.options.videoInventoryUrl
        ? this.fetchVideoAvailability(checkedAt)
        : Promise.resolve(undefined),
    ]);
    const videoAvailability =
      inventoryResult.status === "fulfilled" ? inventoryResult.value : undefined;
    const failures: unknown[] =
      inventoryResult.status === "rejected" ? [inventoryResult.reason] : [];
    let refreshed: StoredCatalogSnapshot | null = null;

    if (sourceResult.status === "rejected") {
      failures.push(sourceResult.reason);
    } else {
      const response = sourceResult.value;
      try {
        if (response.status === 304) {
          if (
            !this.snapshot ||
            !canRevalidateSnapshot ||
            (this.options.videoInventoryUrl && !videoAvailability)
          ) {
            throw new Error("Catalog returned 304 without a validated execution inventory");
          }
          refreshed = {
            ...this.snapshot,
            catalog: {
              ...this.snapshot.catalog,
              expiresAt: new Date(checkedAt + this.maxQuoteAgeMs).toISOString(),
              quoteAvailable: true,
            },
            etag: response.headers.get("etag") ?? this.snapshot.etag,
            validatedAt: checkedAt,
          };
        } else {
          if (!response.ok) throw new Error(`Catalog request failed with ${response.status}`);
          const etag = response.headers.get("etag") ?? undefined;
          refreshed = normalizeSourceCatalog(await response.json(), {
            validatedAt: checkedAt,
            maxQuoteAgeMs: this.maxQuoteAgeMs,
            includeKnownModels: this.options.includeKnownModels,
            ...(this.options.overlay ? { overlay: this.options.overlay } : {}),
            ...(etag ? { etag } : {}),
          });
        }
      } catch (cause) {
        failures.push(cause);
      }
    }

    // Only replace the snapshot when every required source resolved. A partial
    // failure (source 5xx/429/timeout, or an empty/invalid video inventory)
    // must leave the last valid models, video availability, versions, and the
    // persisted snapshot entirely intact so a transient upstream outage can
    // never wipe a healthy catalog.
    if (failures.length) {
      throw new AggregateError(failures, "Catalog refresh did not validate every required source");
    }
    if (!refreshed) throw new Error("Catalog refresh produced no snapshot");

    refreshed = videoAvailability
      ? { ...refreshed, videoAvailability }
      : withoutVideoAvailability(refreshed);
    this.snapshot = refreshed;
    await this.options.store.save(refreshed);
  }

  private async fetchVideoAvailability(validatedAt: number) {
    const response = await this.inventoryFetcher(this.options.videoInventoryUrl!, {
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      cache: "no-store",
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (response.status !== 200) {
      throw new Error(`Video inventory request failed with ${response.status}`);
    }
    const inventory = hostedModelInventorySchema.parse(await response.json());
    const videoModels = inventory.models.filter((model) => model.modality === "video");
    // 执行器目录已经把「没有可用渠道」的视频挡掉了，所以这里的可执行清单就是
    // 视频准入白名单（见 video-executability.ts 的说明）。
    return executorAvailability({
      executorVideoIds: videoModels
        .filter((model) => model.selectable !== false)
        .map((model) => model.id),
      disabledVideoIds: videoModels
        .filter((model) => model.selectable === false)
        .map((model) => model.id),
      validatedAt,
    });
  }
}

export type CatalogModelRecord = {
  catalog: Awaited<ReturnType<WeftcanvasCatalogAdapter["getCatalog"]>>;
  model: PublicModel;
  sourceModelId: string;
};

function hasCompleteExecutionRoutes(snapshot: StoredCatalogSnapshot) {
  return snapshot.catalog.models.every((model) => {
    const route = snapshot.routes[model.id];
    if (!route) return false;
    return (
      route.sourceModelId === snapshot.sourceModels[model.id] && route.modality === model.modality
    );
  });
}

function hasCurrentNormalization(
  snapshot: StoredCatalogSnapshot,
  overlay?: CatalogCompatibilityOverlay,
) {
  return snapshot.normalizationVersion === catalogNormalizationVersion(overlay);
}

function hasFreshVideoAvailability(
  snapshot: StoredCatalogSnapshot | null,
  now: number,
  maxAgeMs: number,
) {
  const validatedAt = snapshot?.videoAvailability?.validatedAt;
  if (validatedAt === undefined) return false;
  const age = now - validatedAt;
  return age >= 0 && age <= maxAgeMs;
}

function filterVideoModels(
  catalog: StoredCatalogSnapshot["catalog"],
  availability: StoredCatalogSnapshot["videoAvailability"],
) {
  // 视频可用性来自**执行器目录**（`videoInventoryUrl` 默认指向 Prompt Hub 的
  // /api/v1/model-catalog），它是「这个模型现在有没有可用渠道」的权威。纬线目录
  // 只说明站点上架了什么，两者实测并不一致——差集里的 token 计费 Seedance 系会
  // 报价通过、点生成才报「模型不可用」（见 video-executability.ts）。
  //
  // fail-open 是刻意的：清单拉不到、或里面一条视频都没有时只按显式下架过滤。
  // 宁可短暂暴露一条会失败的线路，也不能因为一次上游抖动清空整个视频分类。
  const allowIds = new Set(availability?.publicModelIds ?? []);
  const disabledIds = new Set(availability?.disabledModelIds ?? []);
  const canGate = allowIds.size > 0;
  return {
    ...catalog,
    models: catalog.models.filter((model) => {
      if (model.modality !== "video") return true;
      if (disabledIds.has(model.id)) return false;
      return canGate ? allowIds.has(model.id) : true;
    }),
  };
}

function withoutVideoAvailability(snapshot: StoredCatalogSnapshot): StoredCatalogSnapshot {
  const { videoAvailability: _videoAvailability, ...withoutAvailability } = snapshot;
  return withoutAvailability;
}
