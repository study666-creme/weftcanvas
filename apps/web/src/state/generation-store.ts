import {
  publicModelCatalogSchema,
  type ModelModality,
  type PublicGenerationJob,
  type PublicModel,
  type PublicModelCatalog,
} from "@weftcanvas/contracts";
import { create } from "zustand";

import {
  CanvasApiError,
  fetchGenerationJob,
  fetchModelCatalog,
  listGenerationJobs,
  reconcileGenerationJob,
  subscribeGenerationJob,
} from "../lib/api-client";
import {
  browserSubmissionIdentity,
  isBrowserSubmissionInFlight,
  releaseBrowserSubmissionIdentity,
  resolvePendingSubmissionIdentity,
} from "../lib/browser-generation-runtime";
import { persistCompletedGenerationArtifacts } from "../lib/generated-artifact-persistence";
import type { WeftcanvasNode } from "../types";
import { useCanvasStore } from "./canvas-store";
import { useIdentityStore } from "./identity-store";
import { enqueueCompletedGenerationOutputs } from "./local-output-store";
import { useToastStore } from "./toast-store";
import { useWalletStore } from "./wallet-store";

type CatalogStatus = "idle" | "loading" | "ready" | "error";
type CatalogState = {
  status: CatalogStatus;
  data: PublicModelCatalog | null;
  error: string | null;
  loadedAt: number;
  refreshing: boolean;
};

type GenerationState = {
  catalogs: Record<ModelModality, CatalogState>;
  jobsById: Record<string, PublicGenerationJob>;
  jobsByNode: Record<string, PublicGenerationJob>;
  exhaustedObservations: Record<string, true>;
  loadCatalog: (modality: ModelModality, force?: boolean) => Promise<PublicModelCatalog | null>;
  refreshLoadedCatalogs: () => Promise<void>;
  recordJob: (job: PublicGenerationJob) => void;
  watchJob: (job: PublicGenerationJob) => void;
  markObservationExhausted: (jobId: string) => void;
  recoverProject: (projectId: string) => Promise<void>;
  beginHostedSubmission: (
    nodeId: string,
    createKey: () => string,
  ) => { key: string; reused: boolean };
  clearRuntime: () => void;
};

const CATALOG_STORAGE_KEY = "weftcanvas:model-catalogs:v1";
const CATALOG_REFRESH_INTERVAL_MS = 60_000;
const CATALOG_MAX_STALE_MS = 7 * 24 * 60 * 60_000;
/**
 * The one finite confirmation window at the generation recovery boundary. A
 * durable pending identity younger than this may still resolve to an accepted
 * job, so its node stays protected and keeps the ordinary generating
 * presentation. An identity already older than the window is released
 * immediately on recovery and its node converges to an explicit actionable
 * failure instead of an indefinite spinner.
 */
const PENDING_SUBMISSION_CONFIRMATION_WINDOW_MS = 2 * 60 * 60 * 1_000;
const UNRESOLVABLE_SUBMISSION_MESSAGE = "任务无法恢复，请重新生成";

let catalogRequest: Promise<PublicModelCatalog | null> | null = null;
const watchers = new Map<string, { projectId: string; stop: () => void }>();
const recoveryRequests = new Map<string, Promise<void>>();
let activeRecoveryKey: string | null = null;
let recoveryRetryTimer: number | null = null;
let recoveryRetryDelay = 2_000;
let walletRefreshRevision = 0;
let walletRefreshRunning = false;

export const useGenerationStore = create<GenerationState>((set, get) => ({
  catalogs: readStoredCatalogs(),
  jobsById: {},
  jobsByNode: {},
  exhaustedObservations: {},

  loadCatalog: async (modality, force = false) => {
    const current = get().catalogs[modality];
    if (!force && current.data && Date.now() - current.loadedAt < CATALOG_REFRESH_INTERVAL_MS)
      return current.data;
    if (catalogRequest) {
      await catalogRequest;
      return get().catalogs[modality].data;
    }

    const hasCatalogs = Object.values(get().catalogs).some((catalog) => catalog.data);
    set((state) => ({
      catalogs: Object.fromEntries(
        Object.entries(state.catalogs).map(([key, catalog]) => [
          key,
          catalog.data
            ? { ...catalog, status: "ready" as const, refreshing: true, error: null }
            : hasCatalogs
              ? catalog
              : { ...catalog, status: "loading" as const, refreshing: true, error: null },
        ]),
      ) as Record<ModelModality, CatalogState>,
    }));
    const request = (async () => {
      try {
        const data = force ? await fetchModelCatalog(undefined, true) : await fetchModelCatalog();
        set(() => ({
          catalogs: withDemoModels(splitCatalogByModality(data, Date.now())),
        }));
        writeStoredCatalogs(get().catalogs);
        return data;
      } catch (cause) {
        const message = cause instanceof CanvasApiError ? cause.message : "模型列表暂时无法读取";
        set((state) => {
          const errored = Object.fromEntries(
            Object.entries(state.catalogs).map(([key, catalog]) => [
              key,
              catalog.data
                ? { ...catalog, status: "ready" as const, refreshing: false, error: message }
                : { ...catalog, status: "error" as const, refreshing: false, error: message },
            ]),
          ) as Record<ModelModality, CatalogState>;
          return { catalogs: withDemoModels(errored) };
        });
        return get().catalogs[modality].data;
      } finally {
        catalogRequest = null;
      }
    })();
    catalogRequest = request;
    await request;
    return get().catalogs[modality].data;
  },

  refreshLoadedCatalogs: async () => {
    const firstLoaded = (Object.entries(get().catalogs) as [ModelModality, CatalogState][]).find(
      ([, value]) => value.data,
    )?.[0];
    if (firstLoaded) await get().loadCatalog(firstLoaded, true);
  },

  recordJob: (job) => {
    const wasWatched = watchers.has(job.id);
    if (isFinal(job)) {
      watchers.get(job.id)?.stop();
      watchers.delete(job.id);
    }
    enqueueCompletedGenerationOutputs(job);
    void persistCompletedGenerationArtifacts(job).catch(() => undefined);
    const canvas = useCanvasStore.getState();
    if (canvas.projectId !== job.projectId) return;
    const state = get();
    const known = state.jobsById[job.id];
    if (known && known.version >= job.version) return;
    // A live server job for a node must NOT release the durable pending
    // identity: the public job snapshot carries no clientRequestId, so a
    // same-node job cannot be authoritatively correlated to the pending
    // request. An unrelated older active job could otherwise unlock a newer
    // ambiguous submission and allow a second paid task. The identity is only
    // cleared by a genuinely new submission on a settled node, a definitive
    // server failure, or explicit user abandonment.
    const firstWatchedFailure = wasWatched && job.status === "failed" && known?.status !== "failed";
    const current = state.jobsByNode[job.nodeId];
    const isCurrent = !current || current.id === job.id || compareGenerationOrder(current, job) < 0;
    // The canvas reducer handles ordering itself. This is important when two
    // paid requests target the same node: an older task may finish after the
    // newer one and still needs to contribute its artifacts.
    canvas.applyGenerationJob(job);
    const exhaustedObservations = state.exhaustedObservations[job.id]
      ? Object.fromEntries(
          Object.entries(state.exhaustedObservations).filter(([id]) => id !== job.id),
        )
      : state.exhaustedObservations;
    set({
      jobsById: { ...state.jobsById, [job.id]: job },
      jobsByNode: isCurrent ? { ...state.jobsByNode, [job.nodeId]: job } : state.jobsByNode,
      ...(exhaustedObservations !== state.exhaustedObservations ? { exhaustedObservations } : {}),
    });
    if (firstWatchedFailure) {
      useToastStore.getState().show(job.error?.message || "生成任务失败，请稍后重试", "error");
    }
    if (!known || (!isSettlementBoundary(known) && isSettlementBoundary(job)))
      scheduleWalletRefresh();
  },

  watchJob: (job) => {
    get().recordJob(job);
    if (isFinal(job) || watchers.has(job.id)) return;
    const stop = subscribeGenerationJob(job.id, {
      onJob: (next) => useGenerationStore.getState().recordJob(next),
      onSessionExpired: () => useIdentityStore.getState().expire(),
      onObservationExhausted: () => {
        watchers.delete(job.id);
        useGenerationStore.getState().markObservationExhausted(job.id);
      },
    });
    watchers.set(job.id, { projectId: job.projectId, stop });
  },

  markObservationExhausted: (jobId) => {
    set((state) => ({
      exhaustedObservations: { ...state.exhaustedObservations, [jobId]: true },
    }));
  },

  recoverProject: async (projectId) => {
    const userId = useIdentityStore.getState().session?.user.id;
    if (!userId) return;
    const key = `${userId}:${projectId}`;
    if (activeRecoveryKey !== key) {
      if (recoveryRetryTimer !== null) window.clearTimeout(recoveryRetryTimer);
      recoveryRetryTimer = null;
      recoveryRetryDelay = 2_000;
    } else if (recoveryRetryTimer !== null) {
      window.clearTimeout(recoveryRetryTimer);
      recoveryRetryTimer = null;
    }
    activeRecoveryKey = key;
    for (const [jobId, watcher] of watchers) {
      if (watcher.projectId === projectId) continue;
      watcher.stop();
      watchers.delete(jobId);
    }
    set((state) => {
      const jobsById = Object.fromEntries(
        Object.entries(state.jobsById).filter(([, job]) => job.projectId === projectId),
      );
      const jobsByNode = Object.fromEntries(
        Object.entries(state.jobsByNode).filter(([, job]) => job.projectId === projectId),
      );
      const exhaustedObservations = Object.fromEntries(
        Object.entries(state.exhaustedObservations).filter(([id]) => jobsById[id] !== undefined),
      );
      return { jobsById, jobsByNode, exhaustedObservations };
    });
    const existing = recoveryRequests.get(key);
    if (existing) return existing;
    const request = (async () => {
      try {
        const jobs = await listGenerationJobs(projectId, 100);
        if (activeRecoveryKey !== key) return;
        recoveryRetryDelay = 2_000;
        const orderedJobs = [...jobs].sort((left, right) => compareGenerationOrder(left, right));
        const newestByNode = new Map<string, PublicGenerationJob>();
        for (const job of orderedJobs) {
          const current = newestByNode.get(job.nodeId);
          if (!current || compareGenerationOrder(current, job) < 0)
            newestByNode.set(job.nodeId, job);
        }
        set({
          jobsById: Object.fromEntries(jobs.map((job) => [job.id, job])),
          jobsByNode: Object.fromEntries(newestByNode),
          exhaustedObservations: Object.fromEntries(
            Object.entries(get().exhaustedObservations).filter(([id]) =>
              jobs.some((job) => job.id === id),
            ),
          ),
        });
        for (const job of orderedJobs) {
          if (job.status === "completed" || newestByNode.get(job.nodeId)?.id === job.id) {
            useCanvasStore.getState().applyGenerationJob(job);
          }
          enqueueCompletedGenerationOutputs(job, true);
          void persistCompletedGenerationArtifacts(job).catch(() => undefined);
        }
        for (const job of jobs) {
          if (!isFinal(job)) get().watchJob(job);
        }
        const recoveredIds = new Set(jobs.map((job) => job.id));
        await recoverAcceptedMissingJobs(recoveredIds, projectId);
        await reconcilePendingIdentities(projectId);
        releaseUnconfirmedSubmissions(jobs, projectId);
      } catch (cause) {
        if (cause instanceof CanvasApiError && cause.status === 401) {
          useIdentityStore.getState().expire();
        } else if (activeRecoveryKey === key && recoveryRetryTimer === null) {
          const retryAfter =
            cause instanceof CanvasApiError && cause.retryAfterSeconds !== null
              ? cause.retryAfterSeconds * 1_000
              : 0;
          const delay = Math.max(recoveryRetryDelay, retryAfter);
          recoveryRetryDelay = Math.min(30_000, Math.round(recoveryRetryDelay * 1.7));
          recoveryRetryTimer = window.setTimeout(() => {
            recoveryRetryTimer = null;
            if (activeRecoveryKey === key)
              void useGenerationStore.getState().recoverProject(projectId);
          }, delay);
        }
      } finally {
        recoveryRequests.delete(key);
      }
    })();
    recoveryRequests.set(key, request);
    return request;
  },

  /**
   * Starts a hosted submission for a node: resolves the idempotency identity
   * from the node's PRE-submit status and then flips the node into the
   * optimistic submitting window. The identity decision must happen before the
   * optimistic update, otherwise every submit would look like it starts inside
   * the ambiguous window and a stale identity on an otherwise settled node
   * would be reused for a genuinely new action.
   */
  beginHostedSubmission: (nodeId, createKey) => {
    const canvas = useCanvasStore.getState();
    const node = canvas.nodes.find((item) => item.id === nodeId);
    const identity = resolvePendingSubmissionIdentity(
      canvas.projectId,
      nodeId,
      node?.data.generation.jobStatus ?? null,
      createKey,
    );
    if (node) {
      canvas.applyGenerationUpdate(nodeId, {
        status: "running",
        progress: 0,
        generation: {
          ...node.data.generation,
          jobStatus: "submitting",
          error: null,
        },
      });
    }
    return identity;
  },

  clearRuntime: () => {
    for (const watcher of watchers.values()) watcher.stop();
    watchers.clear();
    recoveryRequests.clear();
    activeRecoveryKey = null;
    if (recoveryRetryTimer !== null) window.clearTimeout(recoveryRetryTimer);
    recoveryRetryTimer = null;
    recoveryRetryDelay = 2_000;
    set({ jobsById: {}, jobsByNode: {}, exhaustedObservations: {} });
  },
}));

function emptyCatalog(): CatalogState {
  return { status: "idle", data: null, error: null, loadedAt: 0, refreshing: false };
}

function readStoredCatalogs(): Record<ModelModality, CatalogState> {
  const catalogs: Record<ModelModality, CatalogState> = {
    text: emptyCatalog(),
    image: emptyCatalog(),
    video: emptyCatalog(),
    audio: emptyCatalog(),
  };
  if (typeof localStorage === "undefined") return catalogs;
  try {
    const stored = JSON.parse(localStorage.getItem(CATALOG_STORAGE_KEY) || "null") as Record<
      string,
      unknown
    > | null;
    if (!stored || typeof stored !== "object") return catalogs;
    for (const modality of Object.keys(catalogs) as ModelModality[]) {
      const entry = stored[modality] as { savedAt?: unknown; data?: unknown } | undefined;
      if (
        !entry ||
        typeof entry.savedAt !== "number" ||
        Date.now() - entry.savedAt > CATALOG_MAX_STALE_MS
      )
        continue;
      const parsed = publicModelCatalogSchema.safeParse(entry.data);
      if (!parsed.success || parsed.data.models.some((model) => model.modality !== modality))
        continue;
      catalogs[modality] = {
        status: "ready",
        data: parsed.data,
        error: null,
        loadedAt: entry.savedAt,
        refreshing: false,
      };
    }
  } catch {
    // A cache miss must never prevent the workspace from opening.
  }
  return catalogs;
}

function writeStoredCatalogs(catalogs: Record<ModelModality, CatalogState>) {
  if (typeof localStorage === "undefined") return;
  try {
    const stored = Object.fromEntries(
      (Object.entries(catalogs) as [ModelModality, CatalogState][]).flatMap(
        ([modality, catalog]) =>
          catalog.data ? [[modality, { savedAt: catalog.loadedAt, data: catalog.data }]] : [],
      ),
    );
    localStorage.setItem(CATALOG_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Local storage can be unavailable in private browsing; in-memory data still works.
  }
}

function splitCatalogByModality(
  catalog: PublicModelCatalog,
  loadedAt: number,
): Record<ModelModality, CatalogState> {
  return {
    text: catalogForModality(catalog, "text", loadedAt),
    image: catalogForModality(catalog, "image", loadedAt),
    video: catalogForModality(catalog, "video", loadedAt),
    audio: catalogForModality(catalog, "audio", loadedAt),
  };
}

/**
 * 演示目录：无 API（自托管未配置 / 本地服务不可用）时让模型选择器与工作台保持
 * 完整形态。条目使用业界官方模型名与真实参数面，仅作展示——`quoteAvailable`
 * 为 false，提交会被诚实拦截；配置自有 API 或登录托管后以真实清单为准。
 */
function demoParam(name: string, label: string, def: string, options: string[]) {
  return {
    name,
    label,
    type: "string" as const,
    required: false,
    default: def,
    options,
    mutuallyExclusiveWith: [],
  };
}

function demoNumberParam(
  name: string,
  label: string,
  def: number,
  min: number,
  max: number,
  step = 1,
) {
  return {
    name,
    label,
    type: "number" as const,
    required: false,
    default: def,
    min,
    max,
    step,
    mutuallyExclusiveWith: [],
  };
}

function demoPricing(unit: "image" | "second", credits: number): PublicModel["pricing"] {
  return {
    mode: "fixed",
    unit,
    currency: "CNY",
    creditsPerYuan: 100,
    baseCreditMicros: Math.round(credits * 1_000_000),
    baseYuanMicros: Math.round(credits * 10_000),
    tiers: [],
  };
}

const DEMO_IMAGE_SIZES = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"];

const DEMO_NOTE = "演示条目 · 接入自有 API 或登录托管后以真实清单为准";

function demoModels(modality: "image" | "video"): PublicModel[] {
  if (modality === "image") {
    return [
      {
        id: "demo-gpt-image-2.5",
        label: "GPT Image 2.5",
        description: `OpenAI 图像模型，支持文字渲染与多图编辑。${DEMO_NOTE}`,
        modality: "image",
        operation: "generate",
        order: 1,
        input: { textRequired: true, images: { min: 0, max: 4, multiple: true } },
        output: { type: "image", minCount: 1, maxCount: 4 },
        parameters: [
          {
            name: "prompt",
            label: "提示词",
            type: "string",
            required: true,
            mutuallyExclusiveWith: [],
          },
          demoParam("size", "比例", "1:1", DEMO_IMAGE_SIZES),
          demoParam("quality", "质量", "auto", ["auto", "low", "medium", "high"]),
          demoNumberParam("count", "数量", 1, 1, 4),
        ],
        pricing: demoPricing("image", 2.2),
      },
      {
        id: "demo-gemini-3-pro-image",
        label: "Gemini 3 Pro Image",
        description: `Google 图像模型，长上下文一致性与 1k/2k/4k 分辨率。${DEMO_NOTE}`,
        modality: "image",
        operation: "generate",
        order: 2,
        input: { textRequired: true, images: { min: 0, max: 4, multiple: true } },
        output: { type: "image", minCount: 1, maxCount: 2 },
        parameters: [
          {
            name: "prompt",
            label: "提示词",
            type: "string",
            required: true,
            mutuallyExclusiveWith: [],
          },
          demoParam("aspect_ratio", "比例", "1:1", DEMO_IMAGE_SIZES),
          demoParam("resolution", "分辨率", "2k", ["1k", "2k", "4k"]),
        ],
        pricing: demoPricing("image", 3),
      },
      {
        id: "demo-seedream-4",
        label: "Seedream 4.0",
        description: `字节跳动图像模型，中文语义与海报排版见长。${DEMO_NOTE}`,
        modality: "image",
        operation: "generate",
        order: 3,
        input: { textRequired: true, images: { min: 0, max: 4, multiple: true } },
        output: { type: "image", minCount: 1, maxCount: 4 },
        parameters: [
          {
            name: "prompt",
            label: "提示词",
            type: "string",
            required: true,
            mutuallyExclusiveWith: [],
          },
          demoParam("size", "比例", "1:1", DEMO_IMAGE_SIZES),
          demoNumberParam("count", "数量", 1, 1, 4),
        ],
        pricing: demoPricing("image", 1.8),
      },
      {
        id: "demo-midjourney-v7",
        label: "Midjourney V7",
        description: `美学与风格化标杆，支持草图与角色一致性。${DEMO_NOTE}`,
        modality: "image",
        operation: "generate",
        order: 4,
        input: { textRequired: true, images: { min: 0, max: 2, multiple: true } },
        output: { type: "image", minCount: 1, maxCount: 4 },
        parameters: [
          {
            name: "prompt",
            label: "提示词",
            type: "string",
            required: true,
            mutuallyExclusiveWith: [],
          },
          demoParam("ar", "比例", "1:1", DEMO_IMAGE_SIZES),
          demoParam("stylize", "风格化", "medium", ["low", "medium", "high"]),
        ],
        pricing: demoPricing("image", 4),
      },
      {
        id: "demo-flux-2-pro",
        label: "FLUX.2 [pro]",
        description: `Black Forest Labs 开源系模型，写实质感与快速迭代。${DEMO_NOTE}`,
        modality: "image",
        operation: "generate",
        order: 5,
        input: { textRequired: true, images: { min: 0, max: 4, multiple: true } },
        output: { type: "image", minCount: 1, maxCount: 4 },
        parameters: [
          {
            name: "prompt",
            label: "提示词",
            type: "string",
            required: true,
            mutuallyExclusiveWith: [],
          },
          demoParam("aspect_ratio", "比例", "1:1", DEMO_IMAGE_SIZES),
          demoNumberParam("count", "数量", 1, 1, 4),
        ],
        pricing: demoPricing("image", 2.5),
      },
    ];
  }
  return [
    {
      id: "demo-veo-3.1",
      label: "Veo 3.1",
      description: `Google 视频模型，原生音画同步与电影感运镜。${DEMO_NOTE}`,
      modality: "video",
      operation: "generate",
      order: 1,
      input: {
        textRequired: true,
        images: { min: 0, max: 2, multiple: true },
        videos: { min: 0, max: 1, multiple: false },
      },
      output: { type: "video", minCount: 1, maxCount: 1 },
      parameters: [
        {
          name: "prompt",
          label: "提示词",
          type: "string",
          required: true,
          mutuallyExclusiveWith: [],
        },
        demoParam("aspect_ratio", "比例", "16:9", ["16:9", "9:16", "1:1"]),
        demoParam("resolution", "分辨率", "1080p", ["720p", "1080p"]),
        demoNumberParam("duration", "时长（秒）", 8, 4, 12, 2),
      ],
      pricing: demoPricing("second", 20),
    },
    {
      id: "demo-kling-2.5",
      label: "可灵 Kling 2.5",
      description: `快手视频模型，人物运动与口型稳定。${DEMO_NOTE}`,
      modality: "video",
      operation: "generate",
      order: 2,
      input: {
        textRequired: true,
        images: { min: 0, max: 2, multiple: true },
        videos: { min: 0, max: 1, multiple: false },
      },
      output: { type: "video", minCount: 1, maxCount: 1 },
      parameters: [
        {
          name: "prompt",
          label: "提示词",
          type: "string",
          required: true,
          mutuallyExclusiveWith: [],
        },
        demoParam("aspect_ratio", "比例", "16:9", ["16:9", "9:16", "1:1"]),
        demoParam("mode", "模式", "pro", ["std", "pro"]),
        demoNumberParam("duration", "时长（秒）", 5, 5, 10, 5),
      ],
      pricing: demoPricing("second", 12),
    },
    {
      id: "demo-seedance-1.1",
      label: "Seedance 1.1",
      description: `字节跳动视频模型，多镜头叙事与指令遵循。${DEMO_NOTE}`,
      modality: "video",
      operation: "generate",
      order: 3,
      input: {
        textRequired: true,
        images: { min: 0, max: 4, multiple: true },
        videos: { min: 0, max: 2, multiple: true },
      },
      output: { type: "video", minCount: 1, maxCount: 1 },
      parameters: [
        {
          name: "prompt",
          label: "提示词",
          type: "string",
          required: true,
          mutuallyExclusiveWith: [],
        },
        demoParam("aspect_ratio", "比例", "16:9", ["16:9", "9:16", "1:1", "4:3", "3:4"]),
        demoParam("resolution", "分辨率", "1080p", ["720p", "1080p"]),
        demoNumberParam("duration", "时长（秒）", 5, 5, 10, 5),
      ],
      pricing: demoPricing("second", 10),
    },
    {
      id: "demo-wan-2.5",
      label: "Wan 2.5",
      description: `阿里通义万相视频模型，中文生态与图生视频。${DEMO_NOTE}`,
      modality: "video",
      operation: "generate",
      order: 4,
      input: {
        textRequired: true,
        images: { min: 0, max: 2, multiple: true },
        videos: { min: 0, max: 1, multiple: false },
      },
      output: { type: "video", minCount: 1, maxCount: 1 },
      parameters: [
        {
          name: "prompt",
          label: "提示词",
          type: "string",
          required: true,
          mutuallyExclusiveWith: [],
        },
        demoParam("aspect_ratio", "比例", "16:9", ["16:9", "9:16", "1:1"]),
        demoNumberParam("duration", "时长（秒）", 5, 5, 10, 5),
      ],
      pricing: demoPricing("second", 8),
    },
    {
      id: "demo-sora-2",
      label: "Sora 2",
      description: `OpenAI 视频模型，物理一致性与长镜头。${DEMO_NOTE}`,
      modality: "video",
      operation: "generate",
      order: 5,
      input: {
        textRequired: true,
        images: { min: 0, max: 1, multiple: false },
        videos: { min: 0, max: 1, multiple: false },
      },
      output: { type: "video", minCount: 1, maxCount: 1 },
      parameters: [
        {
          name: "prompt",
          label: "提示词",
          type: "string",
          required: true,
          mutuallyExclusiveWith: [],
        },
        demoParam("aspect_ratio", "比例", "16:9", ["16:9", "9:16", "1:1"]),
        demoNumberParam("duration", "时长（秒）", 8, 4, 20, 4),
      ],
      pricing: demoPricing("second", 18),
    },
  ];
}

function withDemoModels(
  catalogs: Record<ModelModality, CatalogState>,
): Record<ModelModality, CatalogState> {
  const patch = (modality: "image" | "video"): CatalogState => {
    const catalog = catalogs[modality];
    // 只有"根本没读到目录"才拿演示条目垫场。读到了但一条模型都没有（站点选择不上架
    // 任何模型）是站点自己的口径，硬塞演示模型等于把它撤销掉。
    if (catalog.data) return catalog;
    return {
      status: "ready",
      data: {
        version: "demo-catalog",
        capabilityVersion: "demo-capability",
        pricingVersion: "demo-pricing",
        fetchedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        quoteAvailable: false,
        models: demoModels(modality),
      },
      error: catalog.error,
      loadedAt: catalog.loadedAt || Date.now(),
      refreshing: false,
    };
  };
  return { ...catalogs, image: patch("image"), video: patch("video") };
}

function catalogForModality(
  catalog: PublicModelCatalog,
  modality: ModelModality,
  loadedAt: number,
): CatalogState {
  return {
    status: "ready",
    data: {
      ...catalog,
      models: catalog.models.filter((model) => model.modality === modality),
    },
    error: null,
    loadedAt,
    refreshing: false,
  };
}

/**
 * 恢复时不能只看当前画布：被删除、撤销或重做隐藏的节点仍会留在历史快照中。
 * 保留同一节点的不同任务记录，后续用 nodeId 与 jobId 精确终态化。
 */
function listRecoveryGenerationNodes(
  canvas: Pick<ReturnType<typeof useCanvasStore.getState>, "nodes" | "past" | "future">,
) {
  return [
    ...canvas.nodes,
    ...[...canvas.past].reverse().flatMap((snapshot) => snapshot.nodes),
    ...canvas.future.flatMap((snapshot) => snapshot.nodes),
  ];
}

/**
 * 只有服务端已经接收的 hosted 任务才可以因恢复列表缺失被判定失败。
 * browser:* 由当前浏览器生命周期管理，submitting 仍处于客户端准备阶段。
 */
function isMissingAcceptedHostedJob(node: WeftcanvasNode, recoveredIds: ReadonlySet<string>) {
  const { jobId, jobStatus } = node.data.generation;
  return (
    node.data.status === "running" &&
    typeof jobId === "string" &&
    jobId.length > 0 &&
    !jobId.startsWith("browser:") &&
    jobStatus !== "submitting" &&
    !recoveredIds.has(jobId)
  );
}

/**
 * 将缺失 hosted 任务写回当前节点与全部历史快照，但绝不复活用户已删除的节点。
 * 直接按 jobId 匹配，避免历史中的旧任务覆盖当前节点上更新的运行态。
 */
function terminalizeMissingHostedJob(nodeId: string, jobId: string) {
  const updatedAt = Date.now();
  useCanvasStore.setState((state) => {
    let changed = false;
    const terminalizeNode = (node: WeftcanvasNode): WeftcanvasNode => {
      if (
        node.id !== nodeId ||
        node.data.generation.jobId !== jobId ||
        !isAcceptedHostedJob(node, jobId)
      )
        return node;
      changed = true;
      return {
        ...node,
        data: {
          ...node.data,
          status: "error" as const,
          progress: null,
          generation: {
            ...node.data.generation,
            jobStatus: "failed" as const,
            error: "没有找到这个账号下的生成任务",
          },
          updatedAt,
        },
      };
    };
    const terminalizeSnapshot = <TSnapshot extends { nodes: WeftcanvasNode[] }>(
      snapshot: TSnapshot,
    ) => {
      const nodes = snapshot.nodes.map(terminalizeNode);
      return nodes.some((node, index) => node !== snapshot.nodes[index])
        ? { ...snapshot, nodes }
        : snapshot;
    };
    const nodes = state.nodes.map(terminalizeNode);
    const past = state.past.map(terminalizeSnapshot);
    const future = state.future.map(terminalizeSnapshot);
    const transactionBase = state.transactionBase
      ? terminalizeSnapshot(state.transactionBase)
      : null;
    if (!changed) return state;
    return { ...state, nodes, past, future, transactionBase, saveState: "saving" as const };
  });
}

/** 在历史快照投影时再次校验 hosted 任务边界，避免误写浏览器本地任务。 */
function isAcceptedHostedJob(node: WeftcanvasNode, jobId: string) {
  return (
    node.data.status === "running" &&
    node.data.generation.jobId === jobId &&
    !jobId.startsWith("browser:") &&
    node.data.generation.jobStatus !== "submitting"
  );
}

/**
 * 刷新或项目重开后，一个停留在“提交中”的节点若没有任何已被服务端接收的
 * 对应任务，说明上一次乐观提交从未到达服务端、被明确拒绝，或请求仍在途。
 *
 * 恢复按三层权威路径收敛，绝不重新 POST 或静默铸造新的请求身份：
 *
 * 1. 带持久化待确认请求身份（browserSubmissionIdentity）的节点使用精确的
 *    幂等身份核对接口（reconcileGenerationJob）按 key 解析：找到任务就以其
 *    真实快照替换陈旧浏览器状态并释放身份；找不到但身份仍在有限确认窗口内
 *    的，节点保留普通生成中展示并受到保护；窗口已过的不可恢复请求立即释放
 *    身份并收敛为显式可重试失败。
 * 2. 已被服务端接收但被 newest-100 列表漏掉的 accepted 任务按 jobId 直接
 *    获取；仍找不到（404）的才判定为缺失并终态化。
 * 3. 没有持久身份的旧快照/导入节点回到原有可操作行为，避免刷新后永久卡死。
 */
function releaseUnconfirmedSubmissions(
  recoveredJobs: ReadonlyArray<PublicGenerationJob>,
  projectId: string,
) {
  const hasLiveJobForNode = new Map<string, boolean>();
  for (const job of recoveredJobs) {
    if (isFinal(job)) continue;
    if (!hasLiveJobForNode.get(job.nodeId)) hasLiveJobForNode.set(job.nodeId, true);
  }
  const releaseNodeIds = new Set<string>();
  for (const node of listRecoveryGenerationNodes(useCanvasStore.getState())) {
    if (node.data.status !== "running" || node.data.generation.jobStatus !== "submitting") continue;
    if (isBrowserSubmissionInFlight(node.id) || hasLiveJobForNode.get(node.id)) continue;
    // 带持久身份的节点统一走 reconcilePendingIdentities 的精确核对；只有没有
    // 任何持久身份的旧乐观快照才在这里释放为可操作状态。
    if (browserSubmissionIdentity(projectId, node.id)) continue;
    releaseNodeIds.add(node.id);
  }
  if (releaseNodeIds.size) releaseUnconfirmedNodes(releaseNodeIds);
}

function releaseUnconfirmedNodes(nodeIds: ReadonlySet<string>) {
  const updatedAt = Date.now();
  useCanvasStore.setState((state) => {
    let changed = false;
    const releaseNode = (node: WeftcanvasNode): WeftcanvasNode => {
      if (
        !nodeIds.has(node.id) ||
        node.data.status !== "running" ||
        node.data.generation.jobStatus !== "submitting"
      )
        return node;
      changed = true;
      return {
        ...node,
        data: {
          ...node.data,
          status: node.data.media ? ("success" as const) : ("error" as const),
          progress: null,
          generation: {
            ...node.data.generation,
            jobId: null,
            jobVersion: null,
            jobCreatedAt: null,
            jobStatus: null,
            artifactId: undefined,
            error: UNRESOLVABLE_SUBMISSION_MESSAGE,
          },
          updatedAt,
        },
      };
    };
    const releaseSnapshot = <TSnapshot extends { nodes: WeftcanvasNode[] }>(
      snapshot: TSnapshot,
    ) => {
      const nodes = snapshot.nodes.map(releaseNode);
      return nodes.some((node, index) => node !== snapshot.nodes[index])
        ? { ...snapshot, nodes }
        : snapshot;
    };
    const nodes = state.nodes.map(releaseNode);
    const past = state.past.map(releaseSnapshot);
    const future = state.future.map(releaseSnapshot);
    const transactionBase = state.transactionBase ? releaseSnapshot(state.transactionBase) : null;
    if (!changed) return state;
    return { ...state, nodes, past, future, transactionBase, saveState: "saving" as const };
  });
}

/**
 * 已被服务端接收但被 newest-100 列表漏掉的 accepted 任务：按 jobId 精确获取。
 * 找到的任务用现有 recordJob 路径应用并（若非终态）继续观察；404 才是权威
 * 缺失并终态化；其余网络错误不擦除仍属近期的合法请求。
 */
async function recoverAcceptedMissingJobs(recoveredIds: Set<string>, _projectId: string) {
  const missingByJob = new Map<string, string[]>();
  for (const node of listRecoveryGenerationNodes(useCanvasStore.getState())) {
    const jobId = node.data.generation.jobId;
    if (!jobId || !isMissingAcceptedHostedJob(node, recoveredIds)) continue;
    const nodeIds = missingByJob.get(jobId) ?? [];
    nodeIds.push(node.id);
    missingByJob.set(jobId, nodeIds);
  }
  if (!missingByJob.size) return;
  for (const [jobId, nodeIds] of missingByJob) {
    let job: PublicGenerationJob;
    try {
      job = await fetchGenerationJob(jobId);
    } catch (cause) {
      if (cause instanceof CanvasApiError && cause.status === 404) {
        for (const nodeId of nodeIds) terminalizeMissingHostedJob(nodeId, jobId);
      }
      continue;
    }
    recoveredIds.add(job.id);
    useGenerationStore.getState().recordJob(job);
    if (!isFinal(job)) useGenerationStore.getState().watchJob(job);
  }
}

/**
 * 使用精确的幂等身份核对接口为每一个仍持有持久请求身份的节点收敛状态。
 * 找到任务（任何状态）即以其真实快照替换陈旧浏览器状态、继续观察并释放身份
 * ——身份按 key 精确解析，属于权威结果。找不到（权威 miss）或核对失败时，
 * 仅当身份已超过有限确认窗口才释放身份并把仍在“提交中”的节点收敛为显式
 * 可重试失败；近期请求保持保护与普通展示，绝不清空。
 */
async function reconcilePendingIdentities(projectId: string) {
  const identities = new Map<string, { key: string; createdAt: number }>();
  for (const node of listRecoveryGenerationNodes(useCanvasStore.getState())) {
    if (identities.has(node.id)) continue;
    const identity = browserSubmissionIdentity(projectId, node.id);
    if (identity) identities.set(node.id, { key: identity.key, createdAt: identity.createdAt });
  }
  if (!identities.size) return;
  const now = Date.now();
  for (const [nodeId, identity] of identities) {
    const expired = now - identity.createdAt > PENDING_SUBMISSION_CONFIRMATION_WINDOW_MS;
    let found = false;
    try {
      const job = await reconcileGenerationJob(identity.key);
      if (job) {
        found = true;
        releaseBrowserSubmissionIdentity(projectId, nodeId);
        useGenerationStore.getState().recordJob(job);
        if (!isFinal(job)) useGenerationStore.getState().watchJob(job);
      }
    } catch {
      // 核对失败绝不能擦除一个仍属近期的合法请求；只有权威结果或窗口到期收敛。
    }
    if (!found && expired) {
      releaseBrowserSubmissionIdentity(projectId, nodeId);
      failExpiredIdentityNode(nodeId);
    }
  }
}

/**
 * 把仍然停留在“提交中”的过期不可恢复请求写回当前节点与全部历史快照，成为
 * 显式可重试失败；绝不复活用户已删除的节点。其他状态（已成功/已就绪）的节点
 * 只释放身份，不做失败改写。
 */
function failExpiredIdentityNode(nodeId: string) {
  const updatedAt = Date.now();
  useCanvasStore.setState((state) => {
    let changed = false;
    const failNode = (node: WeftcanvasNode): WeftcanvasNode => {
      if (
        node.id !== nodeId ||
        node.data.status !== "running" ||
        node.data.generation.jobStatus !== "submitting"
      )
        return node;
      changed = true;
      return {
        ...node,
        data: {
          ...node.data,
          status: node.data.media ? ("success" as const) : ("error" as const),
          progress: null,
          generation: {
            ...node.data.generation,
            jobId: null,
            jobVersion: null,
            jobCreatedAt: null,
            jobStatus: null,
            artifactId: undefined,
            error: UNRESOLVABLE_SUBMISSION_MESSAGE,
          },
          updatedAt,
        },
      };
    };
    const failSnapshot = <TSnapshot extends { nodes: WeftcanvasNode[] }>(snapshot: TSnapshot) => {
      const nodes = snapshot.nodes.map(failNode);
      return nodes.some((node, index) => node !== snapshot.nodes[index])
        ? { ...snapshot, nodes }
        : snapshot;
    };
    const nodes = state.nodes.map(failNode);
    const past = state.past.map(failSnapshot);
    const future = state.future.map(failSnapshot);
    const transactionBase = state.transactionBase ? failSnapshot(state.transactionBase) : null;
    if (!changed) return state;
    return { ...state, nodes, past, future, transactionBase, saveState: "saving" as const };
  });
}

function isFinal(job: PublicGenerationJob) {
  return job.status === "completed" || job.status === "failed";
}

function isSettlementBoundary(job: PublicGenerationJob) {
  return isFinal(job) || job.status === "submission_unknown";
}

function compareGenerationOrder(left: PublicGenerationJob, right: PublicGenerationJob) {
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  if (leftTime !== rightTime) return leftTime - rightTime;
  return left.id.localeCompare(right.id);
}

function scheduleWalletRefresh() {
  if (useIdentityStore.getState().status !== "authenticated") return;
  walletRefreshRevision += 1;
  if (walletRefreshRunning) return;
  walletRefreshRunning = true;
  void (async () => {
    let processedRevision = 0;
    while (processedRevision < walletRefreshRevision) {
      processedRevision = walletRefreshRevision;
      await useWalletStore.getState().loadSummary(true);
    }
  })().finally(() => {
    walletRefreshRunning = false;
    if (walletRefreshRevision > 0) walletRefreshRevision = 0;
  });
}
