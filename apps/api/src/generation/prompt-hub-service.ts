import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  GENERATION_JOB_SCHEMA_VERSION,
  buildImageProtocolRequest,
  generationJobIdempotencyKeySchema,
  generationJobSubmissionSchema,
  mediaProjectIdSchema,
  mediaUploadRequestSchema,
  publicMediaSchema,
  publicGenerationJobSchema,
  type GenerationJobBilling,
  type GenerationJobInput,
  type GenerationJobSubmission,
  type GenerationQuote,
  type MediaKind,
  type PublicMedia,
  type PublicGenerationJob,
} from "@kachang/contracts";
import { z } from "zod";

import type { GenerationQuoteService } from "../catalog/quote.js";
import { MediaServiceError, type MediaService } from "../media/service.js";
import type { SignedMediaAccess } from "../media/signed-access.js";
import { totalOutputCount } from "./output-count.js";
import { referenceAwarePrompt } from "./reference-prompt.js";
import { GenerationJobServiceError } from "./service.js";
import { h3Resolution, h3SuperResolutionRequiresImage, isMinimaxH3Model } from "./minimax-h3.js";
import {
  durationSeconds,
  MAX_REFERENCE_VIDEO_TOTAL_SECONDS,
  REFERENCE_VIDEO_DURATIONS_PARAMETER,
  sanitizeReferenceVideoDurations,
  sumReferenceVideoDurations,
} from "./reference-video-durations.js";

const ACTIVE_STATUSES = new Set(["submitting", "queued", "running", "validating", "submission_unknown"]);
const MAX_REFERENCE_BYTES: Record<MediaKind, number> = {
  image: 20 * 1024 * 1024,
  video: 96 * 1024 * 1024,
  audio: 48 * 1024 * 1024,
};
const MAX_HOSTED_VIDEO_BYTES = 512 * 1024 * 1024;
// Generated images up to the relay's own serve ceiling; the media service still
// enforces its per-kind limit, so a larger image fails the archive the same way
// a local "保存到云端" of that image would.
const MAX_HOSTED_IMAGE_BYTES = 64 * 1024 * 1024;

/**
 * How one hosted artifact is archived into canvas storage. The fetch route
 * depends on the kind: images prefer their captured result URL (each artifact
 * is delivered independently) and fall back to the indexed task route, while
 * videos only have the content route.
 */
type HostedArchiveProfile = {
  kind: "image" | "video";
  maxBytes: number;
  mimePrefix: string;
  fallbackMimeType: string;
  fallbackName: string;
};

const HOSTED_ARCHIVE_PROFILES: Record<"image" | "video", HostedArchiveProfile> = {
  image: {
    kind: "image",
    maxBytes: MAX_HOSTED_IMAGE_BYTES,
    mimePrefix: "image/",
    fallbackMimeType: "image/png",
    fallbackName: "生成图片.png",
  },
  video: {
    kind: "video",
    maxBytes: MAX_HOSTED_VIDEO_BYTES,
    mimePrefix: "video/",
    fallbackMimeType: "video/mp4",
    fallbackName: "生成视频.mp4",
  },
};

function imageParameter(parameters: Record<string, unknown>, aliases: string[]) {
  for (const alias of aliases) {
    const value = parameters[alias];
    if (value !== undefined && value !== null && value !== "") return String(value);
  }
  return undefined;
}

/**
 * Prompt Hub 的 image.v1 契约只接受小写 1k/2k/4k，而画布目录里的
 * resolution 选项是给 API 站 wire 协议的大写 1K/2K。转发前统一归一。
 */
function normalizeImageProtocolResolution(value: string | undefined) {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "1k" || normalized === "2k" || normalized === "4k" ? normalized : undefined;
}

const hostedPreparedReferencesSchema = z.object({
  images: z.array(z.string()).default([]),
  styleImages: z.array(z.string()).default([]),
  elementImages: z.array(z.string()).default([]),
  videos: z.array(z.string()).default([]),
  audios: z.array(z.string()).default([]),
});
type HostedPreparedReferences = z.infer<typeof hostedPreparedReferencesSchema>;
type ParsedGenerationJobSubmission = z.infer<typeof generationJobSubmissionSchema>;

export function promptHubRecoveryLookupPath(modality: PublicGenerationJob["modality"], idempotencyKey: string) {
  const scope = modality === "video" ? "video" : "generate";
  return `/api/v1/${scope}/requests/${encodeURIComponent(idempotencyKey)}`;
}

export function isRetryExhaustedSubmissionFailure(job: Pick<PublicGenerationJob, "status" | "error">) {
  return job.status === "failed" && job.error?.code === "GENERATION_SUBMISSION_RETRY_EXHAUSTED";
}

const hostedJobRecordSchema = z.object({
  ownerId: z.string().min(1),
  idempotencyKey: z.string().min(8),
  upstreamJobId: z.string().min(1).nullable(),
  provider: z.enum(["prompt-hub", "apimart"]).default("prompt-hub"),
  resultUrls: z.array(z.string().url()).max(8).default([]),
  // Hosted video content is archived lazily on the first full media read. The
  // synthetic artifact id remains stable while this durable id is populated.
  archivedMediaIds: z.array(z.string().min(1)).max(8).default([]),
  job: publicGenerationJobSchema,
  // Keep the immutable request envelope private so an ambiguous submission can
  // be retried with the exact same upstream idempotency key after a restart.
  submission: generationJobSubmissionSchema.optional(),
  references: hostedPreparedReferencesSchema.optional(),
  recovery: z.object({
    attempts: z.number().int().nonnegative().max(8),
    lastAttemptAt: z.string().datetime({ offset: true }),
  }).optional(),
});
type HostedJobRecord = z.infer<typeof hostedJobRecordSchema>;

const hostedJobFileSchema = z.object({
  version: z.literal(1),
  jobs: z.array(hostedJobRecordSchema),
});

const hostedReferenceSchema = z.object({
  id: z.string().uuid(),
  ownerId: z.string().min(1),
  projectId: mediaProjectIdSchema.nullable().default(null),
  idempotencyKey: z.string().min(8),
  kind: z.enum(["image", "video", "audio"]),
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  ref: z.string().min(1).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
type HostedReference = z.infer<typeof hostedReferenceSchema>;

const hostedReferenceFileSchema = z.object({
  version: z.literal(1),
  references: z.array(hostedReferenceSchema),
});

const SUBMISSION_RESPONSE_BUDGET_MS = 500;
// Prompt Hub may need several seconds to copy a completed upstream image into
// durable storage. Keep the Canvas request alive across that 425 window.
const MEDIA_RETRY_DELAYS_MS = [500, 1_500, 3_500, 7_000] as const;
// A completed MJ task can briefly refuse direct result URLs while the upstream
// gallery is still settling (the four-image gallery is archived after the task
// reports completed). Retry the captured URL with a short bounded backoff so a
// one-off 404/403 does not surface as a broken result tile.
const RESULT_URL_SETTLING_RETRY_DELAYS_MS = [400, 1_200, 3_000] as const;
// 归档失败后的冷却：一轮存储故障里，画廊每张图的读取都各自等满一次存储
// 超时才会回落，用户看到的是"图要过一会儿才出来"。失败后短时间内不再
// 尝试补档，这次读直接回上游内容；冷却到期后（或任务重新完成时）自然恢复。
const ARCHIVE_RETRY_COOLDOWN_MS = 2 * 60_000;
// A hosted image task must finish inside a finite budget. Upstream can accept
// the paid POST and then keep answering queued/running forever, or stop
// answering with a readable status at all; observation never invents a
// terminal state on its own, so without this bound the canvas node would spin
// indefinitely. Once an image task crosses the budget it converges to an
// explicit retryable failure. Video is deliberately exempt: long renders are
// normal for that modality, so the same budget would kill legitimate work.
const IMAGE_GENERATION_MAX_LIFETIME_MS = 10 * 60_000;
const IMAGE_LIFETIME_STATUSES: ReadonlySet<PublicGenerationJob["status"]> = new Set(["queued", "running"]);
// Observation never blocks on the upstream: the owner-scoped GET/SSE return the
// durable local snapshot and run the read-only reconciliation in the background.
// A failed reconciliation (hang, 429, 5xx, offline) backs off exponentially and
// cools down per job so a failing upstream cannot be hammered or hold the event
// loop forever.
const RECONCILIATION_BASE_COOLDOWN_MS = 2_000;
const RECONCILIATION_MAX_COOLDOWN_MS = 60_000;
// After a read starts the background reconciliation, a strict bounded moment is
// given for an in-flight read-only reconcile to persist its durable result so
// the same read (or the next one) can deliver a terminal snapshot that would
// otherwise only surface on a later observation. The wait is never the full
// upstream timeout and never blocks on access resolution itself.
const RECONCILIATION_OBSERVATION_SETTLE_WAIT_MS = 400;

const upstreamEnvelopeSchema = z.object({
  ok: z.boolean().optional(),
  data: z.unknown().optional(),
  error: z.unknown().optional(),
  code: z.union([z.string(), z.number()]).optional(),
  message: z.string().optional(),
}).passthrough();

export type PromptHubAccess = {
  data: { accessToken: string };
  refreshedToken?: string;
  expiresAt?: string;
};

export type PromptHubAccessResolver = {
  resolveUpstreamAccess(token: string | undefined, options?: { force?: boolean }): Promise<PromptHubAccess>;
};

export type HostedGenerationResult<T> = {
  data: T;
  refreshedToken?: string;
  expiresAt?: string;
};

export type HostedMediaResponse = HostedGenerationResult<Response>;

export interface PromptHubGenerationStore {
  findByIdempotency(ownerId: string, idempotencyKey: string): Promise<HostedJobRecord | null>;
  get(ownerId: string, jobId: string): Promise<HostedJobRecord | null>;
  findByMedia(ownerId: string, mediaId: string): Promise<HostedJobRecord | null>;
  list(ownerId: string, options: { projectId?: string; limit: number }): Promise<HostedJobRecord[]>;
  create(record: HostedJobRecord, maxActiveJobs: number): Promise<"created" | "existing" | "active_limit">;
  save(record: HostedJobRecord, expectedVersion: number): Promise<HostedJobRecord | null>;
  remove(ownerId: string, jobId: string, expectedVersion: number): Promise<boolean>;
}

export interface PromptHubReferenceStore {
  findByIdempotency(ownerId: string, idempotencyKey: string): Promise<HostedReference | null>;
  get(ownerId: string, id: string): Promise<HostedReference | null>;
  create(reference: HostedReference): Promise<HostedReference | null>;
  save(reference: HostedReference, expectedUpdatedAt: string): Promise<HostedReference | null>;
}

export class MemoryPromptHubReferenceStore implements PromptHubReferenceStore {
  protected readonly references = new Map<string, HostedReference>();

  async findByIdempotency(ownerId: string, idempotencyKey: string) {
    return cloneReference([...this.references.values()].find((item) => item.ownerId === ownerId && item.idempotencyKey === idempotencyKey) ?? null);
  }

  async get(ownerId: string, id: string) {
    const value = this.references.get(id);
    return cloneReference(value?.ownerId === ownerId ? value : null);
  }

  async create(reference: HostedReference) {
    const existing = await this.findByIdempotency(reference.ownerId, reference.idempotencyKey);
    if (existing) return existing;
    this.references.set(reference.id, cloneReference(reference)!);
    await this.afterMutation();
    return null;
  }

  async save(reference: HostedReference, expectedUpdatedAt: string) {
    const current = this.references.get(reference.id);
    if (!current || current.ownerId !== reference.ownerId || current.updatedAt !== expectedUpdatedAt) return null;
    this.references.set(reference.id, cloneReference(reference)!);
    await this.afterMutation();
    return cloneReference(reference);
  }

  protected async afterMutation() {}
}

export class JsonPromptHubReferenceStore extends MemoryPromptHubReferenceStore {
  private loaded = false;
  private loadRequest: Promise<void> | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {
    super();
  }

  override async findByIdempotency(ownerId: string, idempotencyKey: string) {
    await this.load();
    return super.findByIdempotency(ownerId, idempotencyKey);
  }

  override async get(ownerId: string, id: string) {
    await this.load();
    return super.get(ownerId, id);
  }

  override async create(reference: HostedReference) {
    await this.load();
    return super.create(reference);
  }

  override async save(reference: HostedReference, expectedUpdatedAt: string) {
    await this.load();
    return super.save(reference, expectedUpdatedAt);
  }

  protected override async afterMutation() {
    const snapshot = hostedReferenceFileSchema.parse({ version: 1, references: [...this.references.values()] });
    const write = this.mutationQueue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(snapshot), "utf8");
      await rename(temporary, this.path);
    });
    this.mutationQueue = write.catch(() => undefined);
    return write;
  }

  private async load() {
    if (this.loaded) return;
    if (!this.loadRequest) {
      this.loadRequest = (async () => {
        try {
          const parsed = hostedReferenceFileSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
          for (const reference of parsed.references) this.references.set(reference.id, reference);
          this.loaded = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            this.loaded = true;
            return;
          }
          console.error("Hosted generation references could not be loaded", error);
          throw error;
        }
      })().finally(() => {
        this.loadRequest = null;
      });
    }
    await this.loadRequest;
  }
}

export class MemoryPromptHubGenerationStore implements PromptHubGenerationStore {
  protected readonly records = new Map<string, HostedJobRecord>();

  async findByIdempotency(ownerId: string, idempotencyKey: string) {
    return cloneRecord([...this.records.values()].find((item) => item.ownerId === ownerId && item.idempotencyKey === idempotencyKey) ?? null);
  }

  async get(ownerId: string, jobId: string) {
    const record = this.records.get(jobId);
    return cloneRecord(record?.ownerId === ownerId ? record : null);
  }

  async findByMedia(ownerId: string, mediaId: string) {
    return cloneRecord([...this.records.values()].find((item) => item.ownerId === ownerId
      && item.job.artifacts.some((artifact) => artifact.kind !== "text" && artifact.mediaId === mediaId)) ?? null);
  }

  async list(ownerId: string, options: { projectId?: string; limit: number }) {
    return [...this.records.values()]
      .filter((item) => item.ownerId === ownerId && (!options.projectId || item.job.projectId === options.projectId))
      .sort((left, right) => Date.parse(right.job.updatedAt) - Date.parse(left.job.updatedAt))
      .slice(0, options.limit)
      .map((item) => cloneRecord(item)!);
  }

  async create(record: HostedJobRecord, maxActiveJobs: number) {
    const parsed = hostedJobRecordSchema.parse(record);
    const existing = await this.findByIdempotency(parsed.ownerId, parsed.idempotencyKey);
    if (existing) return "existing" as const;
    const active = [...this.records.values()].filter((item) => item.ownerId === parsed.ownerId && ACTIVE_STATUSES.has(item.job.status)).length;
    if (active >= maxActiveJobs) return "active_limit" as const;
    this.records.set(parsed.job.id, cloneRecord(parsed)!);
    await this.afterMutation();
    return "created" as const;
  }

  async save(record: HostedJobRecord, expectedVersion: number) {
    const parsed = hostedJobRecordSchema.parse(record);
    const current = this.records.get(parsed.job.id);
    if (!current || current.ownerId !== parsed.ownerId || current.job.version !== expectedVersion) return null;
    if (parsed.job.version !== expectedVersion + 1) throw new Error("Hosted generation version must increment once");
    this.records.set(parsed.job.id, cloneRecord(parsed)!);
    await this.afterMutation();
    return cloneRecord(parsed);
  }

  async remove(ownerId: string, jobId: string, expectedVersion: number) {
    const current = this.records.get(jobId);
    if (!current || current.ownerId !== ownerId || current.job.version !== expectedVersion) return false;
    this.records.delete(jobId);
    await this.afterMutation();
    return true;
  }

  protected async afterMutation() {}
}

export class JsonPromptHubGenerationStore extends MemoryPromptHubGenerationStore {
  private loaded = false;
  private loadRequest: Promise<void> | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {
    super();
  }

  override async findByIdempotency(ownerId: string, idempotencyKey: string) {
    await this.load();
    return super.findByIdempotency(ownerId, idempotencyKey);
  }

  override async get(ownerId: string, jobId: string) {
    await this.load();
    return super.get(ownerId, jobId);
  }

  override async findByMedia(ownerId: string, mediaId: string) {
    await this.load();
    return super.findByMedia(ownerId, mediaId);
  }

  override async list(ownerId: string, options: { projectId?: string; limit: number }) {
    await this.load();
    return super.list(ownerId, options);
  }

  override async create(record: HostedJobRecord, maxActiveJobs: number) {
    await this.load();
    return super.create(record, maxActiveJobs);
  }

  override async save(record: HostedJobRecord, expectedVersion: number) {
    await this.load();
    return super.save(record, expectedVersion);
  }

  override async remove(ownerId: string, jobId: string, expectedVersion: number) {
    await this.load();
    return super.remove(ownerId, jobId, expectedVersion);
  }

  protected override async afterMutation() {
    const snapshot = hostedJobFileSchema.parse({ version: 1, jobs: [...this.records.values()] });
    const write = this.mutationQueue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(snapshot), "utf8");
      await rename(temporary, this.path);
    });
    this.mutationQueue = write.catch(() => undefined);
    return write;
  }

  private async load() {
    if (this.loaded) return;
    if (!this.loadRequest) {
      this.loadRequest = (async () => {
        try {
          const parsed = hostedJobFileSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
          for (const record of parsed.jobs) this.records.set(record.job.id, record);
          this.loaded = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            this.loaded = true;
            return;
          }
          console.error("Hosted generation store could not be loaded", error);
          throw error;
        }
      })().finally(() => {
        this.loadRequest = null;
      });
    }
    await this.loadRequest;
  }
}

type PromptHubGenerationServiceOptions = {
  apiBaseUrl: string;
  apimart?: {
    apiBaseUrl: string;
    apiKey: string;
  };
  maxActiveJobs?: number;
  requestTimeoutMs?: number;
  /** Upstream task creation can take longer than status reads (especially video). */
  submissionTimeoutMs?: number;
  /** How long a hosted submission may stay on the pending POST before the
   * durable local `submitting` snapshot is returned for observation. Defaults
   * to 500 ms; a slower upstream only ever surfaces `submitting`. */
  submissionResponseBudgetMs?: number;
  /** The strict bounded moment an observation read waits for an in-flight
   * background reconciliation to persist its result before re-reading the
   * durable store. Defaults to 400 ms. */
  observationSettleWaitMs?: number;
  /** Finite lifetime for a hosted image task before it converges to an
   * explicit retryable timeout. Video is exempt. Defaults to 10 minutes. */
  imageMaxLifetimeMs?: number;
  mediaRetryDelaysMs?: readonly number[];
  /** Bounded retry delays for captured image result URLs that briefly refuse
   * requests while an MJ gallery settles. Defaults to a few seconds in total. */
  resultUrlRetryDelaysMs?: readonly number[];
  /**
   * 归档失败后的冷却时间，默认 2 分钟。归档要在"读取路径按需补档"和
   * "存储故障时不要每次都白等"之间取舍：失败后短时间内不再重试，让这次
   * 读立刻回上游内容。否则画廊一页几十张图会各自等满一次存储超时——
   * 用户看到的就是"图要过一会儿才显示"。
   */
  archiveRetryCooldownMs?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  createId?: () => string;
  media?: Pick<MediaService, "readReference"> & Partial<Pick<MediaService, "get" | "open" | "persistGenerated">>;
  /**
   * Canvas-owned delivery fallback for upstream refs that are internal-only
   * (for example storage refs) and therefore cannot be sent to a provider.
   */
  signedAccess?: Pick<SignedMediaAccess, "createUrl">;
  references?: PromptHubReferenceStore;
  /** Legacy APIMart ids are opt-in; current public catalog routes use Prompt Hub. */
  apimartModelIds?: readonly string[];
};

type ReferencePreparationPolicy = {
  projectId?: string;
  allowPersonalFallback: boolean;
};

export class PromptHubGenerationService {
  private readonly origin: string;
  private readonly apimartOrigin: string | null;
  private readonly apimartApiKey: string | null;
  private readonly maxActiveJobs: number;
  private readonly requestTimeoutMs: number;
  private readonly submissionTimeoutMs: number;
  private readonly submissionResponseBudgetMs: number;
  private readonly observationSettleWaitMs: number;
  private readonly imageMaxLifetimeMs: number;
  private readonly mediaRetryDelaysMs: readonly number[];
  private readonly resultUrlRetryDelaysMs: readonly number[];
  private readonly archiveRetryCooldownMs: number;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly references: PromptHubReferenceStore;
  private readonly apimartModelIds: ReadonlySet<string>;
  private readonly submissions = new Map<string, Promise<HostedGenerationResult<PublicGenerationJob>>>();
  private readonly dispatches = new Map<string, Promise<HostedGenerationResult<PublicGenerationJob>>>();
  private readonly recoveries = new Map<string, Promise<HostedJobRecord>>();
  private readonly mediaArchives = new Map<string, Promise<void>>();
  /** 归档失败后的冷却截止时刻，键为 `${ownerId}:${jobId}:${artifactIndex}`。 */
  private readonly archiveCooldownUntil = new Map<string, number>();
  private readonly refreshedAccess = new Map<string, PromptHubAccess>();
  private readonly reconciliations = new Map<string, Promise<void>>();
  private readonly reconciliationCooldownUntil = new Map<string, number>();
  private readonly reconciliationFailures = new Map<string, number>();

  constructor(
    private readonly quotes: Pick<GenerationQuoteService, "createQuote">,
    private readonly auth: PromptHubAccessResolver,
    private readonly store: PromptHubGenerationStore,
    private readonly options: PromptHubGenerationServiceOptions,
  ) {
    const base = new URL(options.apiBaseUrl);
    if (base.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(base.hostname)) {
      throw new Error("Prompt Hub generation URL must use HTTPS");
    }
    this.origin = base.origin;
    if (options.apimart) {
      const apimartBase = new URL(options.apimart.apiBaseUrl);
      if (apimartBase.username || apimartBase.password) throw new Error("APIMart generation URL cannot contain credentials");
      if (apimartBase.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(apimartBase.hostname)) {
        throw new Error("APIMart generation URL must use HTTPS");
      }
      const apimartKey = options.apimart.apiKey.trim();
      if (!apimartKey) throw new Error("APIMart generation API key is required");
      this.apimartOrigin = apimartBase.origin;
      this.apimartApiKey = apimartKey;
    } else {
      this.apimartOrigin = null;
      this.apimartApiKey = null;
    }
    // Keep enough room for independent image submissions. Submission rate
    // limits remain the protection against abuse.
    this.maxActiveJobs = positiveInteger(options.maxActiveJobs ?? 100, "maxActiveJobs");
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs ?? 45_000, "requestTimeoutMs");
    this.submissionTimeoutMs = positiveInteger(
      options.submissionTimeoutMs ?? 120_000,
      "submissionTimeoutMs",
    );
    this.submissionResponseBudgetMs = positiveInteger(
      options.submissionResponseBudgetMs ?? SUBMISSION_RESPONSE_BUDGET_MS,
      "submissionResponseBudgetMs",
    );
    this.observationSettleWaitMs = positiveInteger(
      options.observationSettleWaitMs ?? RECONCILIATION_OBSERVATION_SETTLE_WAIT_MS,
      "observationSettleWaitMs",
    );
    this.imageMaxLifetimeMs = positiveInteger(
      options.imageMaxLifetimeMs ?? IMAGE_GENERATION_MAX_LIFETIME_MS,
      "imageMaxLifetimeMs",
    );
    this.mediaRetryDelaysMs = options.mediaRetryDelaysMs ?? MEDIA_RETRY_DELAYS_MS;
    this.resultUrlRetryDelaysMs = options.resultUrlRetryDelaysMs ?? RESULT_URL_SETTLING_RETRY_DELAYS_MS;
    this.archiveRetryCooldownMs = positiveInteger(
      options.archiveRetryCooldownMs ?? ARCHIVE_RETRY_COOLDOWN_MS,
      "archiveRetryCooldownMs",
    );
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.references = options.references ?? new MemoryPromptHubReferenceStore();
    this.apimartModelIds = new Set((options.apimartModelIds ?? [])
      .map((modelId) => modelId.trim().toLowerCase())
      .filter(Boolean));
  }

  async submit(ownerId: string, value: unknown, token?: string) {
    const submission = generationJobSubmissionSchema.parse(value);
    const key = `${ownerId}:${submission.idempotencyKey}`;
    const pending = this.submissions.get(key);
    if (pending) return pending;
    const request = this.submitOnce(ownerId, submission, token).finally(() => this.submissions.delete(key));
    this.submissions.set(key, request);
    return request;
  }

  async get(ownerId: string, jobId: string, token?: string) {
    let record = await this.store.get(ownerId, jobId);
    if (!record) throw new GenerationJobServiceError("JOB_NOT_FOUND", "没有找到这个生成任务");
    if (isRetryExhaustedSubmissionFailure(record.job)) {
      // Older Canvas builds turned a bounded reconciliation counter into the
      // false claim that no upstream job or debit existed. Re-open those local
      // snapshots and let the read-only idempotency lookup recover real state.
      record = await this.markSubmissionUnknown(record);
    }
    // A hosted image task that has outlived its budget converges here, before
    // the read snapshot is returned, so every observation path (GET, SSE poll,
    // project recovery) sees the same truthful terminal state. Video is exempt.
    record = await this.enforceImageLifetime(record);
    // The owner-scoped GET/SSE returns the durable local snapshot immediately
    // and never synchronously waits on resolveAccess, recoverUnknown, or
    // requestJob. The read-only reconciliation runs in the background with
    // per-job single-flight, a bounded timeout, failure backoff/cooldown, and
    // cleanup, so a hanging/429/5xx/offline upstream can never block this
    // response or permanently occupy a connection.
    const key = `${record.ownerId}:${record.job.id}`;
    const hadInFlightObservation = this.reconciliations.has(key);
    this.reconcileInBackground(record, token);
    // A completed/failed durable snapshot that a pre-existing reconciliation
    // just wrote must not be missed because this read returned before it
    // settled: give only an already-running reconcile a strict bounded moment,
    // then re-read the store so the terminal result is delivered on this read
    // instead of only on a later SSE/poll read. A read that just started the
    // reconciliation keeps the immediate-response contract.
    if (hadInFlightObservation) {
      record = await this.settleObservationRead(record);
    }
    const cached = token ? this.refreshedAccess.get(token) : undefined;
    return cached ? withRefresh(record.job, cached) : { data: record.job };
  }

  /**
   * When this observation read races the background reconciliation, await the
   * in-flight read-only reconcile for a strict bounded moment and then re-read
   * the owner-scoped store. The wait is never the full upstream timeout and
   * never blocks on access resolution itself, so a hanging upstream can delay
   * a response by at most one small bounded budget. Terminal reads never wait.
   */
  private async settleObservationRead(record: HostedJobRecord) {
    if (record.job.status === "completed" || record.job.status === "failed") return record;
    const key = `${record.ownerId}:${record.job.id}`;
    const inFlight = this.reconciliations.get(key);
    if (inFlight) {
      // The tracked reconciliation promise never rejects (reconcileInBackground
      // handles failures with backoff/cooldown), so the race is safe.
      await Promise.race([inFlight, delay(this.observationSettleWaitMs)]);
    }
    return await this.store.get(record.ownerId, record.job.id) ?? record;
  }

  /**
   * Resolve once all in-flight background reconciliations settle. This is used
   * by tests and operators to observe the durable result of a read-only
   * reconciliation without polling the store.
   */
  async settleObservation() {
    while (this.reconciliations.size) {
      await Promise.allSettled([...this.reconciliations.values()]);
    }
  }

  async list(ownerId: string, value: { projectId?: string; limit?: number } = {}, _token?: string) {
    const projectId = value.projectId?.trim();
    if (projectId !== undefined && (!projectId || projectId.length > 128)) {
      throw new GenerationJobServiceError("INVALID_PROJECT_ID", "项目标识格式不正确");
    }
    const limit = value.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new GenerationJobServiceError("INVALID_LIMIT", "任务数量范围不正确");
    }
    const records = await this.store.list(ownerId, { ...(projectId ? { projectId } : {}), limit });
    // Recovery must not resurrect a stuck image task: an over-budget task
    // converges to a terminal failure here so a refreshed canvas shows the same
    // truthful state instead of an indefinite spinner.
    const converged = await Promise.all(records.map((record) => this.enforceImageLifetime(record)));
    return { data: converged.map((record) => record.job) };
  }

  /**
   * Resolve one durable hosted request by its existing idempotency identity.
   * The read-only reconciliation reuses the hosted store's exact
   * owner/idempotency lookup (never a capped list scan) and returns only the
   * existing public job snapshot. It must never resolve access, contact an
   * upstream, submit, retry, replay, or mutate a job; a null result is an
   * unambiguous local miss and the caller decides what the finite confirmation
   * window means for the node.
   */
  async resolveByIdempotency(ownerId: string, key: string): Promise<HostedGenerationResult<PublicGenerationJob> | null> {
    if (!ownerId) throw new GenerationJobServiceError("UNAUTHENTICATED", "请先登录");
    const parsed = generationJobIdempotencyKeySchema.parse(key);
    const record = await this.store.findByIdempotency(ownerId, parsed);
    return record ? { data: record.job } : null;
  }

  async createReferenceUpload(ownerId: string, value: unknown, token?: string) {
    const input = mediaUploadRequestSchema.parse(value);
    const existing = await this.references.findByIdempotency(ownerId, input.idempotencyKey);
    if (existing) {
      if (
        existing.kind !== input.kind
        || existing.name !== input.name
        || existing.mimeType !== input.mimeType
        || existing.size !== input.size
        || existing.projectId !== (input.projectId ?? null)
      ) {
        throw new MediaServiceError("IDEMPOTENCY_CONFLICT", "这个上传请求标识已经用于其他素材", 409);
      }
      return withRefresh(referenceIntent(existing), await this.resolveAccess(token));
    }
    const now = new Date(this.now()).toISOString();
    const reference = hostedReferenceSchema.parse({
      id: randomUUID(),
      ownerId,
      projectId: input.projectId ?? null,
      idempotencyKey: input.idempotencyKey,
      kind: input.kind,
      name: input.name,
      mimeType: input.mimeType,
      size: input.size,
      sha256: input.sha256 ?? null,
      ref: null,
      createdAt: now,
      updatedAt: now,
    });
    const duplicate = await this.references.create(reference);
    const created = duplicate ?? reference;
    return withRefresh(referenceIntent(created), await this.resolveAccess(token));
  }

  async uploadReference(ownerId: string, mediaId: string, source: AsyncIterable<Uint8Array>, token?: string, contentType?: string, contentLength?: number | null, projectId?: string) {
    const reference = await this.references.get(ownerId, mediaId);
    if (!reference || reference.projectId !== (projectId ?? null)) {
      throw new MediaServiceError("MEDIA_NOT_FOUND", "没有找到这个素材", 404);
    }
    if (reference.ref) return withRefresh(publicReference(reference), await this.resolveAccess(token));
    if (contentType && contentType.split(";", 1)[0]?.trim().toLowerCase() !== reference.mimeType) {
      throw new MediaServiceError("MEDIA_CONTENT_TYPE_MISMATCH", "上传类型与文件信息不一致", 415);
    }
    if (contentLength !== null && contentLength !== undefined && contentLength !== reference.size) {
      throw new MediaServiceError("MEDIA_SIZE_MISMATCH", "上传内容大小与文件信息不一致", 400);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const hash = createHash("sha256");
    for await (const chunk of source) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_REFERENCE_BYTES[reference.kind] || size > reference.size) {
        throw new MediaServiceError("MEDIA_TOO_LARGE", "素材大小超过当前限制", 413);
      }
      hash.update(bytes);
      chunks.push(bytes);
    }
    if (size !== reference.size) throw new MediaServiceError("MEDIA_SIZE_MISMATCH", "上传内容大小与文件信息不一致", 400);
    const sha256 = hash.digest("hex");
    if (reference.sha256 && reference.sha256 !== sha256) throw new MediaServiceError("MEDIA_HASH_MISMATCH", "素材校验失败", 422);
    const access = await this.resolveAccess(token);
    const path = `${ownerId}/canvas/${randomUUID()}.${extensionFor(reference.mimeType, reference.kind)}`;
    const uploadResult = await this.fetchWithAuthRetry(
      new URL(`/api/v1/media/upload?path=${encodeURIComponent(path)}`, this.origin),
      access.data.accessToken,
      token,
      {
        method: "POST",
        headers: { "Content-Type": reference.mimeType, Accept: "application/json" },
        body: Buffer.concat(chunks) as unknown as BodyInit,
      },
    );
    const response = uploadResult.response;
    try {
    if (!response) throw new MediaServiceError("MEDIA_PROCESSING_UNAVAILABLE", "素材上传连接中断", 503);
    if (response.status === 401) throw new MediaServiceError("UNAUTHENTICATED", "登录已过期，请重新登录", 401);
    const payload = upstreamEnvelopeSchema.safeParse(await response.json().catch(() => ({})));
    const data = payload.success && payload.data.data && typeof payload.data.data === "object"
      ? payload.data.data as Record<string, unknown>
      : null;
    const ref = data && typeof data.ref === "string" ? data.ref.trim() : "";
    if (!response.ok || !ref) {
      throw attachRefresh(
        new MediaServiceError("MEDIA_PROCESSING_UNAVAILABLE", "素材暂时无法处理", 503),
        this.latestAccess(token, access),
      );
    }
    const updated = hostedReferenceSchema.parse({ ...reference, ref, sha256, updatedAt: new Date(this.now()).toISOString() });
    const saved = await this.references.save(updated, reference.updatedAt);
      return withRefresh(publicReference(saved ?? updated), uploadResult.access);
    } catch (error) {
      throw attachRefresh(error, uploadResult.access);
    }
  }

  async getReference(ownerId: string, mediaId: string, projectId?: string) {
    const reference = await this.references.get(ownerId, mediaId);
    if (!reference || reference.projectId !== (projectId ?? null)) {
      throw new MediaServiceError("MEDIA_NOT_FOUND", "没有找到这个素材", 404);
    }
    return publicReference(reference);
  }

  async createProviderReference(ownerId: string, mediaId: string, kind: MediaKind, token?: string, projectId?: string) {
    const access = await this.resolveAccess(token);
    const inputs: GenerationJobInput = {
      images: [],
      styleImages: [],
      elementImages: [],
      videos: [],
      audios: [],
    };
    inputs[`${kind}s` as keyof GenerationJobInput] = [mediaId];
    const references = await this.prepareReferences(
      ownerId,
      inputs,
      access.data.accessToken,
      token,
      { projectId, allowPersonalFallback: false },
    );
    const value = references[`${kind}s` as keyof typeof references][0];
    const url = value ? resolveProviderReferenceUrl(value, this.origin) : null;
    if (url) return withRefresh({ url }, this.latestAccess(token, access));

    // The upstream upload endpoint can acknowledge a successful upload with
    // an internal ref that is valid to Prompt Hub but not fetchable by an
    // external generation provider. Canvas already owns the durable bytes, so
    // expose those bytes through the short-lived signed delivery endpoint
    // instead of asking the user to configure separate object storage.
    if (this.options.signedAccess) {
      try {
        const fallbackUrl = this.options.signedAccess.createUrl(mediaId, kind);
        return withRefresh({ url: fallbackUrl }, this.latestAccess(token, access));
      } catch {
        // Preserve the existing domain error when signed delivery is not
        // configured or cannot mint a URL for this deployment.
      }
    }
    throw new GenerationJobServiceError(
      "REFERENCE_PUBLIC_URL_UNAVAILABLE",
      "当前素材暂时无法转换为外部模型可访问的 HTTPS 地址",
    );
  }

  async openMedia(ownerId: string, mediaId: string, token?: string, range?: string, projectId?: string, signal?: AbortSignal): Promise<HostedMediaResponse> {
    const record = await this.store.findByMedia(ownerId, mediaId);
    if (
      !record
      || (projectId !== undefined && record.job.projectId !== projectId)
      || record.job.status !== "completed"
      || !record.upstreamJobId
    ) {
      throw new GenerationJobServiceError("REFERENCE_NOT_FOUND", "没有找到这个生成结果");
    }
    const artifactIndex = record.job.artifacts.findIndex((artifact) => artifact.kind !== "text" && artifact.mediaId === mediaId);
    if (artifactIndex < 0) throw new GenerationJobServiceError("REFERENCE_NOT_FOUND", "没有找到这个生成结果");
    const access = await this.resolveAccess(token);
    const archivedMediaId = record.archivedMediaIds?.[artifactIndex];
    if (archivedMediaId && this.options.media?.open) {
      try {
        return withRefresh(await this.openDurableMedia(ownerId, archivedMediaId, range, undefined, signal), this.latestAccess(token, access));
      } catch (error) {
        console.warn("Hosted durable media read failed; falling back to upstream", error);
      }
    }
    if (record.provider === "apimart") {
      const url = record.resultUrls[artifactIndex];
      if (!url) throw new GenerationJobServiceError("REFERENCE_NOT_FOUND", "生成结果地址已失效");
      const response = await this.fetchResultUrlWithSettlingRetries(url, range);
      return await this.settleHostedRead(record, artifactIndex, response, range, access, token);
    }
    // Prefer the per-image URL captured from the completed status payload so
    // each artifact is delivered independently. Fall back to the authenticated
    // task endpoint when a short-lived URL has expired.
    const resultUrl = record.job.modality === "image" ? record.resultUrls[artifactIndex] : undefined;
    if (resultUrl) {
      try {
        const response = await this.fetchResultUrlWithSettlingRetries(resultUrl, range);
        return await this.settleHostedRead(record, artifactIndex, response, range, access, token);
      } catch {
        // Continue with the durable Prompt Hub media route below.
      }
    }
    const path = record.job.modality === "image"
      ? `/api/v1/generate/jobs/${encodeURIComponent(record.upstreamJobId)}/image${artifactIndex ? `?index=${artifactIndex}` : ""}`
      : `/api/v1/video/jobs/${encodeURIComponent(record.upstreamJobId)}/content`;
    // The indexed image route answers 404 while an MJ gallery is still being
    // archived upstream; treat a missing image as retryable for that route.
    const response = await this.fetchMedia(
      path,
      access.data.accessToken,
      range,
      token,
      record.job.modality === "image",
    );
    return await this.settleHostedRead(record, artifactIndex, response, range, access, token);
  }

  /**
   * Hand one fetched hosted artifact back to the caller, archiving it into
   * canvas storage first when no durable copy exists yet: a whole-file read
   * returns the archived copy directly, and a byte-range request answers
   * immediately while the full copy is archived in the background. Every
   * archive failure only warns — a storage outage must not break a read the
   * upstream response can already serve.
   *
   * 补档在冷却期内直接跳过：一轮存储故障里，若每次读都去试一遍，用户要
   * 为每张图各等一次连接超时。跳过时仍回上游内容，只是这次不落自有副本。
   */
  private async settleHostedRead(
    record: HostedJobRecord,
    artifactIndex: number,
    response: Response,
    range: string | undefined,
    access: PromptHubAccess,
    token?: string,
  ): Promise<HostedMediaResponse> {
    const profile = this.hostedArchiveProfile(record, artifactIndex);
    if (profile && this.options.media?.persistGenerated && !this.archiveCoolingDown(record, artifactIndex)) {
      if (range) {
        // Browsers commonly request a byte range first. Return it immediately
        // and archive a separate full response in the background.
        void this.archiveHostedMedia(record, artifactIndex, access.data.accessToken, token, profile)
          .catch((error) => {
            console.warn(`Hosted ${profile.kind} archive failed`, error);
            this.noteArchiveFailure(record, artifactIndex);
          });
      } else {
        const archived = await this.archiveHostedMediaResponse(record, artifactIndex, response, profile)
          .catch((error) => {
            console.warn(`Hosted ${profile.kind} archive failed`, error);
            this.noteArchiveFailure(record, artifactIndex);
            return null;
          });
        if (archived) return withRefresh(archived, this.latestAccess(token, access));
      }
    }
    return withRefresh(response, this.latestAccess(token, access));
  }

  private archiveKey(record: HostedJobRecord, artifactIndex: number) {
    return `${record.ownerId}:${record.job.id}:${artifactIndex}`;
  }

  private archiveCoolingDown(record: HostedJobRecord, artifactIndex: number) {
    return (this.archiveCooldownUntil.get(this.archiveKey(record, artifactIndex)) ?? 0) > this.now();
  }

  /** 记录一次归档失败并开启冷却；表按时间裁剪，避免随历史任务无限增长。 */
  private noteArchiveFailure(record: HostedJobRecord, artifactIndex: number) {
    const now = this.now();
    this.archiveCooldownUntil.set(this.archiveKey(record, artifactIndex), now + this.archiveRetryCooldownMs);
    if (this.archiveCooldownUntil.size < 500) return;
    for (const [key, until] of this.archiveCooldownUntil) {
      if (until <= now) this.archiveCooldownUntil.delete(key);
    }
  }

  private hostedArchiveProfile(record: HostedJobRecord, artifactIndex: number): HostedArchiveProfile | null {
    const kind = record.job.artifacts[artifactIndex]?.kind;
    return kind === "image" || kind === "video" ? HOSTED_ARCHIVE_PROFILES[kind] : null;
  }

  private async archiveHostedMedia(
    record: HostedJobRecord,
    artifactIndex: number,
    accessToken: string,
    sessionToken: string | undefined,
    profile: HostedArchiveProfile,
  ) {
    if (profile.kind === "image") {
      const resultUrl = record.resultUrls[artifactIndex];
      if (resultUrl) {
        try {
          const response = await this.fetchResultUrlWithSettlingRetries(resultUrl);
          await this.archiveHostedMediaResponse(record, artifactIndex, response, profile);
          return;
        } catch (error) {
          console.warn("Hosted image archive via result URL failed; retrying via task route", error);
        }
      }
    }
    const path = profile.kind === "image"
      ? `/api/v1/generate/jobs/${encodeURIComponent(record.upstreamJobId || "")}/image${artifactIndex ? `?index=${artifactIndex}` : ""}`
      : `/api/v1/video/jobs/${encodeURIComponent(record.upstreamJobId || "")}/content`;
    const response = await this.fetchMedia(path, accessToken, undefined, sessionToken, profile.kind === "image");
    await this.archiveHostedMediaResponse(record, artifactIndex, response, profile);
  }

  private async archiveHostedMediaResponse(
    record: HostedJobRecord,
    artifactIndex: number,
    response: Response,
    profile: HostedArchiveProfile,
  ): Promise<Response | null> {
    const media = this.options.media;
    if (!media?.persistGenerated || !response.body) return null;
    const declared = Number(response.headers.get("content-length") || 0);
    if (Number.isSafeInteger(declared) && declared > profile.maxBytes) {
      return null;
    }
    const temporary = `${tmpdir()}/kachang-hosted-${profile.kind}-${randomUUID()}.tmp`;
    await mkdir(dirname(temporary), { recursive: true });
    const clone = response.clone();
    const hash = createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > profile.maxBytes) {
          callback(new Error(`hosted ${profile.kind} is too large`));
          return;
        }
        hash.update(bytes);
        callback(null, bytes);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(clone.body as unknown as import("node:stream/web").ReadableStream<any>),
        meter,
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      );
      if (!size) return null;
      const artifact = record.job.artifacts[artifactIndex];
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      const persisted = await media.persistGenerated(record.ownerId, {
        jobId: record.job.id,
        index: artifactIndex,
        kind: profile.kind,
        name: artifact && artifact.kind !== "text" ? artifact.name : profile.fallbackName,
        mimeType: contentType?.startsWith(profile.mimePrefix) ? contentType : profile.fallbackMimeType,
        size,
        sha256: hash.digest("hex"),
        source: createReadStream(temporary),
      }, Number.MAX_SAFE_INTEGER);
      const current = await this.store.get(record.ownerId, record.job.id) ?? record;
      const archivedMediaIds = [...(current.archivedMediaIds || [])];
      archivedMediaIds[artifactIndex] = persisted.id;
      const artifacts = current.job.artifacts.map((item, index) => index === artifactIndex && item.kind !== "text"
        ? { ...item, mimeType: persisted.mimeType, size: persisted.size, duration: persisted.durationMs ? persisted.durationMs / 1_000 : item.duration }
        : item);
      const archived = nextRecord({ ...current, archivedMediaIds }, { artifacts }, this.now());
      await this.store.save(archived, current.job.version);
      if (!media.open) return null;
      return await this.openDurableMedia(record.ownerId, persisted.id);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async openDurableMedia(ownerId: string, mediaId: string, range?: string, _projectId?: string, signal?: AbortSignal) {
    if (!this.options.media?.open) throw new GenerationJobServiceError("RESULT_DOWNLOAD_UNAVAILABLE", "生成结果正在保存");
    const metadata = range && this.options.media.get ? await this.options.media.get(ownerId, mediaId) : null;
    const byteRange = metadata?.size ? parseHttpByteRange(range, metadata.size) : null;
    const content = await this.options.media.open(ownerId, mediaId, byteRange || undefined, undefined, signal);
    const headers = new Headers({
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store, no-transform",
      "Content-Length": String(content.object.end - content.object.start + 1),
      "Content-Type": content.media.mimeType,
      "X-Content-Type-Options": "nosniff",
    });
    if (byteRange) headers.set("Content-Range", `bytes ${content.object.start}-${content.object.end}/${content.object.totalSize}`);
    return new Response(Readable.toWeb(content.object.stream) as ReadableStream<Uint8Array>, {
      status: byteRange ? 206 : 200,
      headers,
    });
  }

  /**
   * Schedule a bounded, read-only upstream reconciliation for one job. The
   * owner-scoped GET/SSE callers never await this: it is single-flight per job,
   * respects a failure cooldown, and is always cleaned up, so a hanging, 429,
   * 5xx, or offline upstream cannot block a response or leak an unhandled
   * rejection.
   */
  private reconcileInBackground(record: HostedJobRecord, token: string | undefined) {
    if (record.job.status === "completed" || record.job.status === "failed") return;
    // An in-process submission dispatcher is still transferring references and
    // posting upstream; observation must not race it with a read-only lookup.
    if (record.job.status === "submitting" && this.dispatches.has(`${record.ownerId}:${record.idempotencyKey}`)) return;
    const key = `${record.ownerId}:${record.job.id}`;
    const now = this.now();
    if ((this.reconciliationCooldownUntil.get(key) ?? 0) > now) return;
    if (this.reconciliations.has(key)) return;
    const request = this.reconcileOnce(record, token)
      .then(() => {
        this.reconciliationFailures.delete(key);
        this.reconciliationCooldownUntil.delete(key);
      })
      .catch((error) => {
        const failures = (this.reconciliationFailures.get(key) ?? 0) + 1;
        this.reconciliationFailures.set(key, failures);
        const backoff = Math.min(
          RECONCILIATION_MAX_COOLDOWN_MS,
          RECONCILIATION_BASE_COOLDOWN_MS * (2 ** Math.min(6, failures - 1)),
        );
        this.reconciliationCooldownUntil.set(key, now + backoff);
        console.error("Hosted generation reconciliation failed", error);
      })
      .finally(() => {
        if (this.reconciliations.get(key) === request) this.reconciliations.delete(key);
      });
    this.reconciliations.set(key, request);
  }

  /**
   * Perform one read-only reconciliation for a job. The initial state is
   * re-read so the version advances from the freshest durable snapshot.
   */
  private async reconcileOnce(record: HostedJobRecord, token: string | undefined) {
    // One bounded total budget for the whole read-only reconciliation: access
    // resolution and every upstream read share the remaining time instead of
    // each consuming its own full request timeout.
    const deadline = this.now() + this.requestTimeoutMs;
    const access = await this.resolveAccessBounded(token, deadline);
    const current = await this.store.get(record.ownerId, record.job.id) ?? record;
    if (current.job.status === "completed" || current.job.status === "failed") return;
    if (current.job.status === "submission_unknown") {
      await this.recoverUnknown(current, access.data.accessToken, token, deadline);
      return;
    }
    if (current.job.status === "submitting" && !current.upstreamJobId) {
      // A persisted submission without an in-process dispatcher means the API
      // restarted or lost its response. Reconcile through the read-only
      // clientRequestId lookup only; observation must never re-POST the paid
      // envelope or create a second wallet hold.
      const uncertain = await this.markSubmissionUnknown(current);
      if (uncertain.job.status === "submission_unknown") {
        await this.recoverUnknown(uncertain, access.data.accessToken, token, deadline);
      }
      return;
    }
    const live = await this.enforceImageLifetime(current);
    if (live.job.status === "completed" || live.job.status === "failed") return;
    let upstream: Record<string, unknown>;
    try {
      upstream = await this.requestJob(access.data.accessToken, live, token, deadline);
    } catch (error) {
      if (error instanceof GenerationJobServiceError && error.code === "UNAUTHENTICATED") throw error;
      // An upstream that definitively rejects the status read (for example the
      // task id no longer exists) will never hand back a result. Converge to a
      // retryable failure instead of cooling down and retrying an unreadable
      // task forever, which is what left nodes spinning with no terminal state.
      if (error instanceof PromptHubRequestError && error.definitive) {
        await this.failJob(live, error.code, error.message, true);
        return;
      }
      throw error;
    }
    await this.applyUpstream(live, upstream, { accessToken: access.data.accessToken, ...(token ? { sessionToken: token } : {}) });
  }

  /**
   * Resolve an ambiguous hosted submission with a bounded, read-only
   * clientRequestId lookup. Observation (GET/SSE/poll/refresh) must never
   * re-POST the paid envelope: a replay could create a second task and a second
   * wallet hold even when the request key is preserved. Legacy records without
   * the immutable envelope fail only after the same confirmation.
   */
  private async recoverUnknown(
    record: HostedJobRecord,
    accessToken: string,
    sessionToken: string | undefined,
    deadline?: number,
  ): Promise<HostedJobRecord> {
    const key = `${record.ownerId}:${record.job.id}`;
    const pending = this.recoveries.get(key);
    if (pending) return pending;
    const recovery = this.recoverUnknownOnce(record, accessToken, sessionToken, deadline);
    const tracked = recovery.finally(() => {
      if (this.recoveries.get(key) === tracked) this.recoveries.delete(key);
    });
    this.recoveries.set(key, tracked);
    return tracked;
  }

  private async recoverUnknownOnce(
    record: HostedJobRecord,
    accessToken: string,
    sessionToken: string | undefined,
    deadline?: number,
  ): Promise<HostedJobRecord> {
    let current = record;
    let remoteJobId = current.upstreamJobId;
    let lookupConfirmedMissing = false;

    // APIMart exposes task lookup but no client-request-id lookup. If the
    // initial POST timed out before returning a task id, fail closed and
    // require a new explicit request instead of guessing at the debit.
    if (current.provider === "apimart" && !remoteJobId) {
      return this.failUnknown(
        current,
        "APIMART_SUBMISSION_UNCONFIRMED",
        "APIMart 未返回可恢复的任务编号，请确认后重新生成",
        true,
      );
    }

    if (!remoteJobId) {
      try {
        const lookup = await this.requestJson(
          promptHubRecoveryLookupPath(current.job.modality, current.idempotencyKey),
          accessToken,
          { method: "GET" },
          sessionToken,
          deadline,
        );
        remoteJobId = upstreamJobId(lookup);
      } catch (error) {
        if (!isPromptHubNotFound(error)) {
          if (error instanceof GenerationJobServiceError && error.code === "UNAUTHENTICATED") throw error;
          return current;
        }
        lookupConfirmedMissing = true;
      }
    }

    const persistedSubmission = current.submission;
    // Older persisted records predate the immutable submission envelope. Once
    // Prompt Hub definitively confirms the idempotency key is absent, there is
    // no safe request to recover from, so leave the node in a clear terminal
    // state.
    if (!remoteJobId && lookupConfirmedMissing && !persistedSubmission) {
      return this.failUnknown(
        current,
        "GENERATION_SUBMISSION_NOT_FOUND",
        "上游未找到该请求，旧任务缺少可安全恢复的提交信息，请重新生成",
      );
    }
    // A confirmed miss with a persisted envelope stays visibly pending. The
    // paid POST is never replayed here; the creator can explicitly re-submit
    // with a fresh key and a normal new debit.
    if (!remoteJobId) return current;
    if (!current.upstreamJobId || current.upstreamJobId !== remoteJobId) {
      current = await this.attachUpstreamJobId(current, remoteJobId);
    }
    try {
      const upstream = await this.requestJob(accessToken, current, sessionToken, deadline);
      return this.applyUpstream(current, upstream, { accessToken, ...(sessionToken ? { sessionToken } : {}) });
    } catch (error) {
      // A lookup can race the upstream transaction. Keep the durable key and
      // let the next observation retry rather than creating another request.
      if (error instanceof GenerationJobServiceError && error.code === "UNAUTHENTICATED") throw error;
      return current;
    }
  }

  private async attachUpstreamJobId(record: HostedJobRecord, upstreamJobIdValue: string) {
    const next = nextRecord({ ...record, upstreamJobId: upstreamJobIdValue }, {}, this.now());
    return await this.store.save(next, record.job.version)
      ?? await this.store.get(record.ownerId, record.job.id)
      ?? record;
  }

  /**
   * Terminalize a hosted job as an explicit failure. Never used while a paid
   * submission's outcome is still unknown: that state stays
   * `submission_unknown` so a later read-only recovery can still bind the real
   * upstream task.
   */
  private async failJob(record: HostedJobRecord, code: string, message: string, retryable = false) {
    const next = nextRecord(record, {
      status: "failed",
      progress: 0,
      error: { code, message: message || "生成任务失败", retryable },
      completedAt: new Date(this.now()).toISOString(),
    }, this.now());
    return await this.store.save(next, record.job.version)
      ?? await this.store.get(record.ownerId, record.job.id)
      ?? record;
  }

  /**
   * A hosted image task has a finite lifetime. Upstream can accept the paid
   * POST and then leave the task queued/running indefinitely, or stop
   * reporting a readable status at all, and observation alone never fabricates
   * a terminal state. Crossing the budget converges the task to an explicit
   * retryable failure so the canvas node cannot spin forever. Video is exempt:
   * long renders are normal for that modality.
   */
  private async enforceImageLifetime(record: HostedJobRecord): Promise<HostedJobRecord> {
    if (record.job.modality !== "image") return record;
    if (!IMAGE_LIFETIME_STATUSES.has(record.job.status)) return record;
    const startedAt = record.job.startedAt;
    if (!startedAt) return record;
    if (this.now() - Date.parse(startedAt) < this.imageMaxLifetimeMs) return record;
    return await this.failJob(record, "GENERATION_TIMEOUT", "生成超时，请重试", true);
  }

  private async failUnknown(record: HostedJobRecord, code: string, message: string, retryable = false) {
    const next = nextRecord(record, {
      status: "failed",
      progress: 0,
      error: { code, message: message || "生成请求未被上游接受", retryable },
      completedAt: new Date(this.now()).toISOString(),
    }, this.now());
    return await this.store.save(next, record.job.version)
      ?? await this.store.get(record.ownerId, record.job.id)
      ?? record;
  }

  private async markSubmissionUnknown(record: HostedJobRecord) {
    if (record.job.status === "submission_unknown") return record;
    const unknown = nextRecord(record, {
      status: "submission_unknown",
      progress: 0,
      error: { code: "GENERATION_SUBMISSION_UNCONFIRMED", message: "任务提交结果待确认，请勿重复生成", retryable: false },
      completedAt: null,
    }, this.now());
    return await this.store.save(unknown, record.job.version)
      ?? await this.store.get(record.ownerId, record.job.id)
      ?? record;
  }

  private async submitOnce(ownerId: string, submission: ParsedGenerationJobSubmission, token?: string) {
    if (!ownerId) throw new GenerationJobServiceError("UNAUTHENTICATED", "请先登录");
    if (submission.modality !== "image" && submission.modality !== "video") {
      throw new GenerationJobServiceError("MODEL_MODALITY_UNAVAILABLE", "当前账号通道暂不支持这个模型类型");
    }
    const provider = this.providerForModel(submission.modelId);
    if (provider === "apimart" && !this.apimartOrigin) {
      throw new GenerationJobServiceError("GENERATION_PROVIDER_UNAVAILABLE", "Midjourney 上游暂未配置，请联系管理员");
    }
    const existing = await this.store.findByIdempotency(ownerId, submission.idempotencyKey);
    if (existing) return { data: existing.job };

    const quote = await this.quotes.createQuote(toQuoteRequest(submission));
    assertExpectedQuote(submission, quote, this.now());
    const access = await this.resolveAccess(token);
    const timestamp = new Date(this.now()).toISOString();
    const id = `phj_${this.createId()}`;
    const initial: HostedJobRecord = {
      ownerId,
      idempotencyKey: submission.idempotencyKey,
      upstreamJobId: null,
      provider,
      resultUrls: [],
      archivedMediaIds: [],
      submission,
      job: publicGenerationJobSchema.parse({
        schemaVersion: GENERATION_JOB_SCHEMA_VERSION,
        version: 0,
        id,
        projectId: submission.projectId,
        nodeId: submission.nodeId,
        modelId: quote.modelId,
        modelLabel: quote.modelLabel,
        modality: quote.modality,
        status: "submitting",
        progress: 2,
        quote,
        artifacts: [],
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: timestamp,
        completedAt: null,
        parameters: submission.parameters ?? {},
        inputs: submission.inputs,
      }),
    };
    const created = await this.store.create(initial, this.maxActiveJobs);
    if (created === "existing") {
      const replay = await this.store.findByIdempotency(ownerId, submission.idempotencyKey);
      if (!replay) throw new GenerationJobServiceError("JOB_CONFLICT", "任务状态已更新，请刷新后重试");
      return withRefresh(replay.job, access);
    }
    if (created === "active_limit") {
      throw new GenerationJobServiceError("ACTIVE_JOB_LIMIT", "请等待当前生成任务完成后再继续");
    }

    const dispatchKey = `${ownerId}:${submission.idempotencyKey}`;
    let responseState: "pending" | "accepted" | "fast_failure" = "pending";
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const retainFailure = () => {
      if (responseState === "accepted") return true;
      if (responseState === "pending") responseState = "fast_failure";
      return false;
    };
    const processing = this.finishSubmission(initial, access, token, retainFailure).catch(async (error) => {
      if (!retainFailure()) throw error;
      console.error("Hosted generation background submission failed", error);
      try {
        const failed = await this.failAcceptedSubmission(initial, error);
        return withRefresh(failed.job, this.latestAccess(token, access));
      } catch (persistenceError) {
        console.error("Hosted generation background failure could not be persisted", persistenceError);
        const current = await this.store.get(ownerId, initial.job.id).catch(() => null);
        return withRefresh((current ?? initial).job, this.latestAccess(token, access));
      }
    });
    const tracked = processing.finally(() => {
      if (this.dispatches.get(dispatchKey) === tracked) this.dispatches.delete(dispatchKey);
    });
    this.dispatches.set(dispatchKey, tracked);

    const settled = await Promise.race([
      tracked.then(
        (result) => ({ type: "settled" as const, result }),
        (error: unknown) => ({ type: "rejected" as const, error }),
      ),
      new Promise<{ type: "deferred" }>((resolve) => {
        deadline = setTimeout(() => {
          if (responseState !== "pending") return;
          responseState = "accepted";
          resolve({ type: "deferred" });
        }, this.submissionResponseBudgetMs);
      }),
    ]);
    if (settled.type !== "deferred" && deadline) clearTimeout(deadline);
    if (settled.type === "settled") return settled.result;
    if (settled.type === "rejected") throw settled.error;

    // The durable local task is enough for the browser to start observation.
    // Reference transfer and upstream video submission continue in-process;
    // persisted submitting records reconcile safely after an API restart.
    return withRefresh(initial.job, access);
  }

  private async finishSubmission(
    initial: HostedJobRecord,
    access: PromptHubAccess,
    token: string | undefined,
    retainFailure: () => boolean,
  ) {
    const { ownerId, submission } = initial;
    if (!submission) throw new Error("hosted submission envelope is missing");
    let references: HostedPreparedReferences;
    try {
      references = await this.prepareReferences(
        ownerId,
        submission.inputs,
        access.data.accessToken,
        token,
        { projectId: submission.projectId, allowPersonalFallback: true },
      );
    } catch (error) {
      // A reference transfer failure happens before the paid generation POST is
      // attempted, so it is never paid ambiguity: no upstream task was created
      // and no debit can exist. Surface an explicit failure (retryable when the
      // error is transient) instead of locking the node as submission_unknown,
      // which 027 showed leaves a video node stuck for 20+ minutes with no way
      // to recover. Only the generation POST outcome may be submission_unknown.
      const failed = await this.failAcceptedSubmission(initial, error);
      return withRefresh(failed.job, this.latestAccess(token, access));
    }

    let upstream: Record<string, unknown>;
    try {
      upstream = await this.submitConfirmedUpstream(initial.ownerId, access.data.accessToken, submission, initial.job.quote, references, token);
    } catch (error) {
      if (error instanceof GenerationJobServiceError && error.code === "UNAUTHENTICATED") {
        if (retainFailure()) {
          const failed = await this.failAcceptedSubmission({ ...initial, references }, error);
          return withRefresh(failed.job, this.latestAccess(token, access));
        }
        await this.store.remove(ownerId, initial.job.id, initial.job.version);
        throw error;
      }
      if (error instanceof PromptHubRequestError && error.definitive) {
        if (retainFailure()) {
          const failed = await this.failAcceptedSubmission({ ...initial, references }, error);
          return withRefresh(failed.job, this.latestAccess(token, access));
        }
        await this.store.remove(ownerId, initial.job.id, initial.job.version);
        throw attachRefresh(
          new GenerationJobServiceError(error.code, error.message),
          this.latestAccess(token, access),
        );
      }
      // Persist an ambiguous response, then resolve it through the read-only
      // upstream clientRequestId lookup. Observation never replays the paid
      // POST, so a confirmed miss keeps the node visibly pending instead of
      // risking a duplicate wallet hold.
      const unresolved = await this.markSubmissionUnknown({ ...initial, references });
      const recovered = await this.recoverUnknown(unresolved, access.data.accessToken, token);
      return withRefresh(recovered.job, this.latestAccess(token, access));
    }

    const remoteJobId = upstreamJobId(upstream);
    if (!remoteJobId) throw new Error("confirmed Prompt Hub submission is missing a job id");
    try {
      const submitted = await this.applyUpstream(
        { ...initial, references, upstreamJobId: remoteJobId },
        upstream,
        { accessToken: access.data.accessToken, ...(token ? { sessionToken: token } : {}) },
      );
      return withRefresh(submitted.job, this.latestAccess(token, access));
    } catch (error) {
      // Prompt Hub has accepted the idempotent request. A local snapshot write
      // failure must remain recoverable and must never turn real upstream work
      // into a terminal Canvas failure.
      console.error("Hosted generation upstream task could not be persisted", error);
      const current = await this.store.get(ownerId, initial.job.id).catch(() => null);
      return withRefresh((current ?? initial).job, this.latestAccess(token, access));
    }
  }

  private async failAcceptedSubmission(record: HostedJobRecord, error: unknown) {
    const current = await this.store.get(record.ownerId, record.job.id) ?? record;
    if (current.job.status === "completed" || current.job.status === "failed") return current;
    const code = error instanceof PromptHubRequestError
      || error instanceof GenerationJobServiceError
      || error instanceof MediaServiceError
      ? error.code
      : "GENERATION_PROVIDER_UNAVAILABLE";
    const message = error instanceof Error && error.message.trim()
      ? error.message
      : "生成服务暂时无法接收任务，请重试";
    const retryable = error instanceof PromptHubRequestError
      ? !error.definitive
      : code.endsWith("_UNAVAILABLE") || code === "GENERATION_PROVIDER_UNAVAILABLE";
    const failed = nextRecord({ ...current, references: record.references ?? current.references }, {
      status: "failed",
      progress: 0,
      error: { code, message, retryable },
      completedAt: new Date(this.now()).toISOString(),
    }, this.now());
    return await this.store.save(failed, current.job.version)
      ?? await this.store.get(current.ownerId, current.job.id)
      ?? current;
  }

  private async submitConfirmedUpstream(
    ownerId: string,
    accessToken: string,
    submission: ParsedGenerationJobSubmission,
    quote: GenerationQuote,
    references: HostedPreparedReferences,
    sessionToken?: string,
  ) {
    const upstream = await this.submitUpstream(ownerId, accessToken, submission, quote, references, sessionToken);
    if (!upstreamJobId(upstream)) {
      throw new PromptHubRequestError(
        "GENERATION_INVALID_RESPONSE",
        "生成服务没有返回可恢复的任务编号",
        false,
      );
    }
    return upstream;
  }

  private async submitUpstream(
    ownerId: string,
    accessToken: string,
    submission: ParsedGenerationJobSubmission,
    quote: GenerationQuote,
    references: HostedPreparedReferences,
    sessionToken?: string,
  ) {
    if (this.providerForModel(submission.modelId) === "apimart") {
      return this.submitApimart(submission, quote, references);
    }
    const parameters = quote.normalizedParameters;
    if (submission.modality === "video"
      && h3SuperResolutionRequiresImage(submission.modelId, parameters)
      && !hasImageReferences(references)) {
      throw new PromptHubRequestError(
        "H3_REFERENCE_REQUIRED",
        "H3 的 2K/4K 需要至少一张参考图片",
        true,
      );
    }
    const upstreamParameters = submission.modality === "video"
      ? promptHubVideoParameters(parameters, submission.modelId)
      : parameters;
    if (submission.modality === "video" && references.videos.length) {
      await this.applyReferenceVideoDurations(ownerId, submission, quote, references, upstreamParameters);
    }
    const body: Record<string, unknown> = {
      model: submission.modelId,
      ...upstreamParameters,
      clientRequestId: submission.idempotencyKey,
      product: "canvas",
      projectId: submission.projectId,
      nodeId: submission.nodeId,
    };
    if (typeof body.prompt === "string") {
      body.prompt = referenceAwarePrompt(body.prompt, submission.inputs, [
        ...references.images,
        ...references.styleImages,
        ...references.elementImages,
        ...references.videos,
        ...references.audios,
      ]);
    }
    if (submission.modality === "image") {
      const count = quote.outputCount ?? totalOutputCount("image", quote.quantity, parameters);
      // Midjourney's `n` is the number of provider submissions, not the number
      // of gallery images. The API station returns the gallery from one call;
      // leave the fixed `n: 1` route parameter authoritative instead of
      // projecting the four-image output count as four billable submissions.
      const midjourney = isMidjourneyModel(submission.modelId);
      const protocol = buildImageProtocolRequest({
        model: submission.modelId,
        prompt: String(body.prompt || ""),
        resolution: normalizeImageProtocolResolution(imageParameter(parameters, ["resolution"])),
        aspectRatio: imageParameter(parameters, ["aspect_ratio", "aspectRatio", "ratio", "size"]),
        quality: imageParameter(parameters, ["quality"]),
        ...(count > 1 && !midjourney ? { count } : {}),
        mediaInputs: [
          ...references.images.map((url) => ({ kind: "image" as const, role: "reference" as const, url })),
          ...references.styleImages.map((url) => ({ kind: "image" as const, role: "style_reference" as const, url })),
          ...references.elementImages.map((url) => ({ kind: "image" as const, role: "element_reference" as const, url })),
        ],
        // Keep model-declared extension parameters (for example MJ's `raw`)
        // in the provider-neutral envelope. Prompt Hub projects these options
        // to the API station route declared by the live catalog.
        options: imageProtocolOptions(parameters),
      });
      return this.requestJson("/api/v1/generate", accessToken, {
        method: "POST",
        body: {
          ...protocol,
          clientRequestId: submission.idempotencyKey,
          product: "canvas",
          projectId: submission.projectId,
          nodeId: submission.nodeId,
        },
      }, sessionToken);
    }
    delete body.n;
    delete body.count;
    if (submission.modelId === "kling-o3-pro-v2v-reference") {
      // O3 Pro has typed reference slots. Keep the source video in its
      // singular canonical field so the relay cannot treat it as a generic
      // reference list and silently discard it.
      if (references.images.length) body.images = references.images;
      if (references.styleImages.length) body.style_references = references.styleImages;
      if (references.elementImages.length) body.element_references = references.elementImages;
      if (references.videos.length) body.input_video = references.videos[0];
    } else {
      if (references.images.length) body.referenceImages = references.images;
      if (references.styleImages.length) body.styleImages = references.styleImages;
      if (references.elementImages.length) body.elementImages = references.elementImages;
      if (references.videos.length) body.referenceVideos = references.videos;
      if (references.audios.length) body.referenceAudios = references.audios;
    }
    return this.requestJson("/api/v1/video", accessToken, { method: "POST", body }, sessionToken);
  }

  private async submitApimart(
    submission: ParsedGenerationJobSubmission,
    quote: GenerationQuote,
    references: HostedPreparedReferences,
  ) {
    if (!this.apimartOrigin || !this.apimartApiKey) {
      throw new PromptHubRequestError("GENERATION_PROVIDER_UNAVAILABLE", "APIMart 上游暂未配置", true);
    }
    const body = buildApimartMidjourneyBody(submission.modelId, quote.normalizedParameters);
    body.metadata = {
      clientRequestId: submission.idempotencyKey,
      projectId: submission.projectId,
      nodeId: submission.nodeId,
      modelId: submission.modelId,
    };
    if (typeof body.prompt === "string") {
      body.prompt = referenceAwarePrompt(body.prompt, submission.inputs, [
        ...references.images,
        ...references.styleImages,
        ...references.elementImages,
        ...references.videos,
        ...references.audios,
      ]);
    }
    if (references.images.length) body.image_urls = references.images;
    return this.requestApimartJson("/v1/midjourney/generations", { method: "POST", body });
  }

  /**
   * 上游带参考视频的视频模型（当前是 H3 系列）要求 referenceVideos 与
   * referenceVideoDurations 成对出现，缺时长整单 400。客户端按目录参数发来的
   * 音长直接校验放行；没发的老客户端从素材元数据的 durationMs 兜底推导——
   * 上传完成的素材都带这个字段（inspector 探测写入），推导不到就明确报错，
   * 不再把「请求参数无效」这种上游通用 400 透传给用户。
   */
  private async applyReferenceVideoDurations(
    ownerId: string,
    submission: ParsedGenerationJobSubmission,
    quote: GenerationQuote,
    references: HostedPreparedReferences,
    upstreamParameters: Record<string, unknown>,
  ) {
    const declared = Object.hasOwn(quote.normalizedParameters, REFERENCE_VIDEO_DURATIONS_PARAMETER);
    if (!declared && !isMinimaxH3Model(submission.modelId)) return;
    const durations = declared
      ? sanitizeReferenceVideoDurations(quote.normalizedParameters[REFERENCE_VIDEO_DURATIONS_PARAMETER])
      : await this.deriveReferenceVideoDurations(ownerId, submission);
    if (durations === null || durations.length !== references.videos.length) {
      const message = durations === null
        ? declared
          ? "参考视频时长格式不正确，请重新选择参考视频"
          : "暂时无法读取参考视频时长，请在画布上播放一次该视频或重新上传素材后重试"
        : "参考视频时长与参考视频数量不一致，请重新提交";
      throw new PromptHubRequestError("REFERENCE_VIDEO_DURATION_REQUIRED", message, true);
    }
    if (sumReferenceVideoDurations(durations) > MAX_REFERENCE_VIDEO_TOTAL_SECONDS) {
      throw new PromptHubRequestError(
        "REFERENCE_VIDEO_DURATION_LIMIT",
        `参考视频总时长不能超过 ${MAX_REFERENCE_VIDEO_TOTAL_SECONDS} 秒`,
        true,
      );
    }
    upstreamParameters[REFERENCE_VIDEO_DURATIONS_PARAMETER] = durations;
  }

  private async deriveReferenceVideoDurations(
    ownerId: string,
    submission: ParsedGenerationJobSubmission,
  ): Promise<number[] | null> {
    const durations: number[] = [];
    for (const mediaId of submission.inputs.videos) {
      const seconds = await this.referenceVideoDurationSeconds(ownerId, submission.projectId, mediaId);
      if (seconds === null) return null;
      durations.push(seconds);
    }
    return durations;
  }

  /**
   * 单个参考视频的时长（秒）。两类来源：
   * 1. 素材库记录——上传的素材带 inspector 探测出的 durationMs；先按工程作用域
   *    查，个人素材（生成结果默认落在个人空间）再按个人作用域查一次。
   * 2. 托管生成任务的任务工件——画布上新生成的视频工件完成后不带时长，服务端
   *    在内容被播放/下载（归档路径）时探测并回写到工件上。这正是画布视频节点
   *    连参考视频时的主路径：本地节点拿不到时长，但工件上有。
   */
  private async referenceVideoDurationSeconds(
    ownerId: string,
    projectId: string,
    mediaId: string,
  ): Promise<number | null> {
    const media = this.options.media;
    if (media?.get) {
      for (const scope of projectId ? [projectId, undefined] : [undefined]) {
        try {
          const record = await media.get(ownerId, mediaId, scope);
          const seconds = durationSeconds(record?.durationMs);
          if (seconds !== null) return seconds;
        } catch {
          // 作用域查不到就试下一个；都拿不到再走任务工件。
        }
      }
    }
    try {
      const hosted = await this.store.findByMedia(ownerId, mediaId);
      if (!hosted || hosted.job.modality !== "video") return null;
      if (projectId !== undefined && hosted.job.projectId !== projectId) return null;
      const artifact = hosted.job.artifacts.find((item) => item.kind === "video" && item.mediaId === mediaId);
      if (!artifact || artifact.kind !== "video") return null;
      // 工件上的时长是秒（浮点），换算成毫秒再走统一的两位小数归一。
      return durationSeconds(artifact.duration ? Math.round(artifact.duration * 1_000) : null);
    } catch {
      return null;
    }
  }

  private async requestJob(accessToken: string, record: HostedJobRecord, sessionToken?: string, deadline?: number) {
    if (!record.upstreamJobId) throw new GenerationJobServiceError("JOB_NOT_FOUND", "生成任务缺少恢复编号");
    if (record.provider === "apimart") {
      return this.requestApimartJson(
        `/v1/tasks/${encodeURIComponent(record.upstreamJobId)}`,
        { method: "GET", ...(deadline !== undefined ? { timeoutMs: this.remainingMs(deadline) } : {}) },
      );
    }
    if (record.job.modality === "image") {
      return this.requestJson(
        `/api/v1/generate/jobs/${encodeURIComponent(record.upstreamJobId)}`,
        accessToken,
        { method: "GET" },
        sessionToken,
        deadline,
      );
    }
    return this.requestJson(
      `/api/v1/video/jobs/${encodeURIComponent(record.upstreamJobId)}`,
      accessToken,
      { method: "GET" },
      sessionToken,
      deadline,
    );
  }

  private async requestJson(
    path: string,
    accessToken: string,
    input: { method: "GET" | "POST"; body?: Record<string, unknown>; timeoutMs?: number },
    sessionToken?: string,
    deadline?: number,
    retried = false,
  ): Promise<Record<string, unknown>> {
    const url = new URL(path, this.origin);
    const startedAt = Date.now();
    const timeoutMs = deadline !== undefined
      ? this.remainingMs(deadline)
      : input.timeoutMs ?? (input.method === "POST" ? this.submissionTimeoutMs : this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: input.method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          ...(input.body ? { "Content-Type": "application/json" } : {}),
        },
        ...(input.body ? { body: JSON.stringify(input.body) } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      console.error("Prompt Hub generation request failed", {
        host: url.host,
        path: url.pathname,
        method: input.method,
        durationMs: Date.now() - startedAt,
        error: requestErrorName(error),
        code: requestErrorCode(error),
      });
      throw new PromptHubRequestError("GENERATION_PROVIDER_UNAVAILABLE", "生成服务连接中断", false);
    }
    const payload = upstreamEnvelopeSchema.safeParse(await response.json().catch(() => ({})));
    const envelope = payload.success ? payload.data : {};
    if (response.status === 401 && !retried && sessionToken) {
      // A forced access refresh during observation must stay inside the shared
      // reconciliation deadline; a hung resolver cannot extend the budget. The
      // non-observation submission path keeps its unbounded refresh.
      const refreshed = await (deadline !== undefined
        ? this.resolveAccessBounded(sessionToken, deadline, true)
        : this.resolveAccess(sessionToken, true));
      try {
        return await this.requestJson(path, refreshed.data.accessToken, input, sessionToken, deadline, true);
      } catch (error) {
        throw attachRefresh(error, refreshed);
      }
    }
    if (response.status === 401) {
      throw new GenerationJobServiceError("UNAUTHENTICATED", "登录已过期，请重新登录");
    }
    if (!response.ok || envelope.ok === false) {
      const error = upstreamError(response.status, envelope);
      console.error("Prompt Hub generation request rejected", {
        host: url.host,
        path: url.pathname,
        method: input.method,
        status: response.status,
        durationMs: Date.now() - startedAt,
        code: error.code,
        message: error.message.slice(0, 240),
      });
      // A structured rejection is definitive for normal 4xx responses and for
      // the narrow set of routing/model failures that Prompt Hub can only emit
      // before an upstream task exists. Other 5xx responses remain ambiguous:
      // the paid POST may have reached the provider before its response was
      // lost, so recovery must continue without replaying it.
      const explicitRejection = envelope.ok === false
        && (
          (response.status < 500 && response.status !== 408 && response.status !== 429)
          || isDefinitiveRoutingRejection(error.code, error.message)
        );
      const definitive = explicitRejection
        || (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429);
      throw new PromptHubRequestError(error.code, error.message, definitive);
    }
    const data = envelope.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new PromptHubRequestError("GENERATION_INVALID_RESPONSE", "生成服务返回了无法识别的数据", false);
    }
    return data as Record<string, unknown>;
  }

  private async requestApimartJson(
    path: string,
    input: { method: "GET" | "POST"; body?: Record<string, unknown>; timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    if (!this.apimartOrigin || !this.apimartApiKey) {
      throw new PromptHubRequestError("GENERATION_PROVIDER_UNAVAILABLE", "APIMart 上游暂未配置", true);
    }
    const url = new URL(path, this.apimartOrigin);
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: input.method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.apimartApiKey}`,
          ...(input.body ? { "Content-Type": "application/json" } : {}),
        },
        ...(input.body ? { body: JSON.stringify(input.body) } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(input.timeoutMs ?? (input.method === "POST" ? this.submissionTimeoutMs : this.requestTimeoutMs)),
      });
    } catch (error) {
      console.error("APIMart generation request failed", {
        host: url.host,
        path: url.pathname,
        method: input.method,
        durationMs: Date.now() - startedAt,
        error: requestErrorName(error),
        code: requestErrorCode(error),
      });
      throw new PromptHubRequestError("GENERATION_PROVIDER_UNAVAILABLE", "APIMart 连接中断", false);
    }
    const payload = await response.json().catch(() => ({}));
    const envelope = upstreamEnvelopeSchema.safeParse(payload);
    const parsedEnvelope = envelope.success ? envelope.data : {};
    if (!response.ok || parsedEnvelope.error !== undefined) {
      const error = upstreamError(response.status, parsedEnvelope);
      throw new PromptHubRequestError(
        error.code,
        error.message,
        response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429,
      );
    }
    const value = parsedEnvelope.data !== undefined
      ? Array.isArray(parsedEnvelope.data) ? parsedEnvelope.data[0] : parsedEnvelope.data
      : payload;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new PromptHubRequestError("GENERATION_INVALID_RESPONSE", "APIMart 返回了无法识别的数据", false);
    }
    return value as Record<string, unknown>;
  }

  private providerForModel(modelId: string): "prompt-hub" | "apimart" {
    return this.apimartModelIds.has(modelId.trim().toLowerCase()) ? "apimart" : "prompt-hub";
  }

  private async applyUpstream(
    record: HostedJobRecord,
    upstream: Record<string, unknown>,
    tokens?: { accessToken: string; sessionToken?: string },
  ) {
    const status = normalizeStatus(upstream.status);
    const upstreamId = upstreamJobId(upstream) ?? record.upstreamJobId;
    // An unreadable status is not automatically benign. When the payload
    // explicitly declares a failure (ok:false / a populated error) the task
    // must converge to a real failure instead of keeping a stale queued/running
    // appearance — this is the "提交上去就失败了，却轮询不到" case.
    if (status === "unknown") {
      const declared = upstreamDeclaredFailure(upstream);
      if (declared) return await this.failJob(record, "GENERATION_UPSTREAM_FAILED", declared, true);
    }
    // A locally stored job may only look like a normally queued/running task
    // once a validated durable upstream task id exists AND the upstream status
    // is interpretable. An unreadable status or a missing task id must stay
    // visible as `submission_unknown` (or the previous truthful state) instead
    // of being fabricated into a healthy running appearance.
    if (status === "unknown" || !upstreamId) {
      return this.uninterpretableStatus(record, upstreamId);
    }
    const progress = status === "completed" ? 100 : status === "failed" ? 0 : normalizedProgress(upstream.progress, status === "running" ? 48 : 12);
    const errorMessage = upstreamErrorMessage(upstream);
    const resultUrls = status === "completed" ? imageUrls(upstream) : record.resultUrls;
    // A provider that reports an image task completed without any usable
    // artifact URL cannot deliver the paid result. Surface an explicit
    // truthful failure instead of fabricating a completed node with missing
    // media or leaving an ordinary running spinner forever.
    if (status === "completed" && record.job.modality === "image" && !resultUrls.length) {
      const malformed = nextRecord(record, {
        status: "failed",
        progress: 0,
        artifacts: [],
        error: {
          code: "GENERATION_RESULT_UNAVAILABLE",
          message: "生成结果缺少可用的图片地址，请稍后重试",
          retryable: true,
        },
        completedAt: new Date(this.now()).toISOString(),
      }, this.now());
      return await this.store.save(malformed, record.job.version)
        ?? await this.store.get(record.ownerId, record.job.id)
        ?? record;
    }
    const artifacts = status === "completed" ? artifactsFor(record, upstream, this.now()) : [];
    // Prompt Hub is the credit authority: it pre-charges the full quote and
    // reports what was actually taken (and whether a failure was refunded)
    // on every observation. Surface that instead of presenting the estimate
    // as the final charge. A payload without the field writes nothing.
    const billing = upstreamBilling(upstream);
    const next = nextRecord({
      ...record,
      upstreamJobId: upstreamId,
      ...(resultUrls.length ? { resultUrls } : {}),
    }, {
      status,
      progress,
      artifacts,
      ...(billing ? { billing } : {}),
      error: status === "failed"
        ? { code: "GENERATION_FAILED", message: errorMessage || "生成失败", retryable: false }
        : null,
      completedAt: status === "completed" || status === "failed" ? new Date(this.now()).toISOString() : null,
    }, this.now());
    const unchanged = samePublicJob(record.job, next.job) && record.upstreamJobId === next.upstreamJobId;
    if (unchanged) return record;
    const saved = await this.store.save(next, record.job.version)
      ?? await this.store.get(record.ownerId, record.job.id)
      ?? record;
    if (saved.job.status === "completed" && record.job.status !== "completed") {
      this.archiveCompletedMedia(saved, tokens);
    }
    return saved;
  }

  /**
   * 完成即归档：任务一到 completed 就把结果字节抓进画布媒体存储，成片与出图
   * 同理，不再等用户首次打开。托管地址是短时效的（上游/中继下发的都是签名
   * 链接），懒归档会把一次链接过期变成永久打不开的结果——Media Host 线路已
   * 实际发生；中继侧 `images/` 保留期收紧到 30 小时后，出图的可取窗口只会更短。
   * 归档失败不影响任务收敛，读取路径仍会按需重试归档。
   */
  private archiveCompletedMedia(
    record: HostedJobRecord,
    tokens?: { accessToken: string; sessionToken?: string },
  ) {
    if (!tokens || !this.options.media?.persistGenerated) return;
    record.job.artifacts.forEach((artifact, index) => {
      const profile = artifact.kind === "image" || artifact.kind === "video" ? HOSTED_ARCHIVE_PROFILES[artifact.kind] : null;
      if (!profile || record.archivedMediaIds?.[index]) return;
      // 刚在读取路径失败过就不再补一次：同一轮存储故障里每个入口各试一遍
      // 只会把连接池占满。
      if (this.archiveCoolingDown(record, index)) return;
      const key = this.archiveKey(record, index);
      if (this.mediaArchives.has(key)) return;
      const archive = this.archiveHostedMedia(record, index, tokens.accessToken, tokens.sessionToken, profile)
        .catch((error) => {
          console.warn(`Hosted ${artifact.kind} eager archive failed`, error);
          this.noteArchiveFailure(record, index);
        })
        .finally(() => {
          if (this.mediaArchives.get(key) === archive) this.mediaArchives.delete(key);
        });
      this.mediaArchives.set(key, archive);
    });
  }

  /**
   * A submission whose upstream state cannot be read truthfully. A pending
   * `submitting` task becomes a visible `submission_unknown` (retaining the
   * durable task id when one was returned) so the browser never shows ordinary
   * queued/running work. An already-confirmed task keeps its last truthful
   * status instead of being rewritten from uninterpretable data.
   */
  private async uninterpretableStatus(record: HostedJobRecord, upstreamId: string | null) {
    if (record.job.status === "submitting") {
      const attached = upstreamId && !record.upstreamJobId ? { ...record, upstreamJobId: upstreamId } : record;
      return this.markSubmissionUnknown(attached);
    }
    if (upstreamId && !record.upstreamJobId) {
      return await this.attachUpstreamJobId(record, upstreamId);
    }
    return record;
  }

  private async prepareReferences(
    ownerId: string,
    inputs: GenerationJobInput,
    accessToken: string,
    sessionToken?: string,
    policy: ReferencePreparationPolicy = { allowPersonalFallback: false },
  ) {
    const { projectId, allowPersonalFallback } = policy;
    const prepare = async (kind: MediaKind, mediaId: string) => {
      try {
      let bytes: Buffer;
      let mimeType: string;
      const uploadedReference = await this.references.get(ownerId, mediaId);
      if (uploadedReference) {
        const expectedProjectId = projectId ?? null;
        if (
          uploadedReference.projectId !== expectedProjectId
          && !(allowPersonalFallback && uploadedReference.projectId === null)
        ) {
          throw new MediaServiceError("MEDIA_NOT_FOUND", "没有找到这个素材", 404);
        }
        if (uploadedReference.kind !== kind) {
          throw new MediaServiceError("MEDIA_REFERENCE_INVALID", "参考素材类型不匹配", 409);
        }
        if (uploadedReference.ref) return uploadedReference.ref;
      }
      const cachedGeneratedReference = await this.references.findByIdempotency(
        ownerId,
        generatedReferenceIdempotencyKey(mediaId),
      );
      if (
        cachedGeneratedReference?.ref
        && cachedGeneratedReference.kind === kind
        && (projectId === undefined || cachedGeneratedReference.projectId === projectId)
      ) return cachedGeneratedReference.ref;
      const hostedCandidate = await this.store.findByMedia(ownerId, mediaId);
      if (hostedCandidate && projectId !== undefined && hostedCandidate.job.projectId !== projectId) {
        throw new MediaServiceError("MEDIA_NOT_FOUND", "没有找到这个素材", 404);
      }
      const hosted = hostedCandidate && (projectId === undefined || hostedCandidate.job.projectId === projectId)
        ? hostedCandidate
        : null;
      if (hosted) {
        const artifact = hosted.job.artifacts.find((item) => item.kind !== "text" && item.mediaId === mediaId);
        if (!artifact || artifact.kind !== kind) {
          throw new MediaServiceError("MEDIA_REFERENCE_INVALID", "参考素材类型不匹配", 409);
        }
        const opened = await this.openMediaWithAccess(hosted, mediaId, accessToken, sessionToken);
        if (!opened) throw new GenerationJobServiceError("REFERENCE_NOT_FOUND", "没有找到参考素材");
        mimeType = opened.headers.get("Content-Type")?.split(";", 1)[0]?.trim() || defaultMime(kind);
        bytes = Buffer.from(await opened.arrayBuffer());
      } else if (this.options.media) {
        let reference;
        try {
          reference = await this.options.media.readReference(
            ownerId,
            mediaId,
            kind,
            MAX_REFERENCE_BYTES[kind],
            projectId,
          );
        } catch (error) {
          if (
            !allowPersonalFallback
            || !projectId
            || !(error instanceof MediaServiceError)
            || error.code !== "MEDIA_NOT_FOUND"
          ) throw error;
          reference = await this.options.media.readReference(
            ownerId,
            mediaId,
            kind,
            MAX_REFERENCE_BYTES[kind],
          );
        }
        mimeType = reference.media.mimeType;
        bytes = reference.bytes;
      } else {
        throw new GenerationJobServiceError("REFERENCE_VALIDATION_UNAVAILABLE", "参考素材服务尚未配置");
      }
      if (!bytes.length || bytes.length > MAX_REFERENCE_BYTES[kind]) {
        throw new GenerationJobServiceError("REFERENCE_TOO_LARGE", "参考素材大小超过当前限制");
      }
      const path = `${ownerId}/canvas/${randomUUID()}.${extensionFor(mimeType, kind)}`;
      const uploadResult = await this.fetchWithAuthRetry(
        new URL(`/api/v1/media/upload?path=${encodeURIComponent(path)}`, this.origin),
        accessToken,
        sessionToken,
        {
          method: "POST",
          headers: { "Content-Type": mimeType, Accept: "application/json" },
          body: bytes as unknown as BodyInit,
        },
      );
      const upload = uploadResult.response;
      if (!upload) throw new GenerationJobServiceError("REFERENCE_UPLOAD_UNAVAILABLE", "参考素材上传连接中断");
      if (upload.status === 401) throw new GenerationJobServiceError("UNAUTHENTICATED", "登录已过期，请重新登录");
      const payload = upstreamEnvelopeSchema.safeParse(await upload.json().catch(() => ({})));
      const data = payload.success && payload.data.data && typeof payload.data.data === "object"
        ? payload.data.data as Record<string, unknown>
        : null;
      const ref = data && typeof data.ref === "string" ? data.ref.trim() : "";
      if (!upload.ok || !ref) {
        throw attachRefresh(
          new GenerationJobServiceError("REFERENCE_UPLOAD_UNAVAILABLE", "参考素材暂时无法提交"),
          this.latestAccess(sessionToken, { data: { accessToken } }),
        );
      }
        if (hosted) {
          const artifact = hosted.job.artifacts.find((item) => item.kind !== "text" && item.mediaId === mediaId);
          await this.rememberGeneratedReference(ownerId, mediaId, kind, {
            projectId: hosted.job.projectId,
            name: artifact && artifact.kind !== "text" ? artifact.name : `generated-${mediaId}`,
            mimeType,
            bytes,
            ref,
          });
        }
        return ref;
      } catch (error) {
        throw attachRefresh(error, this.latestAccess(sessionToken, { data: { accessToken } }));
      }
    };
    const styleImages = inputs.styleImages ?? [];
    const elementImages = inputs.elementImages ?? [];
    return {
      images: await Promise.all(inputs.images.map((id) => prepare("image", id))),
      styleImages: await Promise.all(styleImages.map((id) => prepare("image", id))),
      elementImages: await Promise.all(elementImages.map((id) => prepare("image", id))),
      videos: await Promise.all(inputs.videos.map((id) => prepare("video", id))),
      audios: await Promise.all(inputs.audios.map((id) => prepare("audio", id))),
    };
  }

  private async rememberGeneratedReference(
    ownerId: string,
    mediaId: string,
    kind: MediaKind,
    value: { projectId: string; name: string; mimeType: string; bytes: Buffer; ref: string },
  ) {
    const timestamp = new Date(this.now()).toISOString();
    const reference = hostedReferenceSchema.parse({
      id: randomUUID(),
      ownerId,
      projectId: value.projectId,
      idempotencyKey: generatedReferenceIdempotencyKey(mediaId),
      kind,
      name: value.name,
      mimeType: value.mimeType,
      size: value.bytes.length,
      sha256: createHash("sha256").update(value.bytes).digest("hex"),
      ref: value.ref,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    try {
      await this.references.create(reference);
    } catch (error) {
      // The uploaded ref is already usable for this task. A cache write outage
      // must not turn a valid video submission into a user-facing failure.
      console.error("Generated reference cache could not be persisted", error);
    }
  }

  private async openMediaWithAccess(record: HostedJobRecord, mediaId: string, accessToken: string, sessionToken?: string) {
    if (!record.upstreamJobId) throw new GenerationJobServiceError("REFERENCE_NOT_FOUND", "没有找到参考素材");
    const index = record.job.artifacts.findIndex((artifact) => artifact.kind !== "text" && artifact.mediaId === mediaId);
    if (index < 0) throw new GenerationJobServiceError("REFERENCE_NOT_FOUND", "没有找到参考素材");
    // 归档副本优先：托管链接会过期，画布自己的副本不会。复用历史结果作为参考
    // 素材时不该因为中继链接到期而失败。
    const archivedMediaId = record.archivedMediaIds?.[index];
    if (archivedMediaId && this.options.media?.open) {
      try {
        return await this.openDurableMedia(record.ownerId, archivedMediaId);
      } catch (error) {
        console.warn("Hosted durable media read failed; falling back to upstream", error);
      }
    }
    if (record.provider === "apimart") {
      const url = record.resultUrls[index];
      if (!url) throw new GenerationJobServiceError("REFERENCE_NOT_FOUND", "没有找到参考素材");
      return this.fetchResultUrlWithSettlingRetries(url);
    }
    const resultUrl = record.job.modality === "image" ? record.resultUrls[index] : undefined;
    if (resultUrl) {
      try {
        return await this.fetchResultUrlWithSettlingRetries(resultUrl);
      } catch {
        // Continue with the authenticated Prompt Hub media route below.
      }
    }
    const path = record.job.modality === "image"
      ? `/api/v1/generate/jobs/${encodeURIComponent(record.upstreamJobId)}/image${index ? `?index=${index}` : ""}`
      : `/api/v1/video/jobs/${encodeURIComponent(record.upstreamJobId)}/content`;
    return this.fetchMedia(path, accessToken, undefined, sessionToken, record.job.modality === "image");
  }

  /**
   * Fetch a captured result URL with a bounded retry window for gallery
   * settling. The caller (image delivery) always has a durable fallback after
   * this fails, so retrying every failure here can only help a brief upstream
   * refusal turn into a clean delivery instead of a broken tile.
   */
  private async fetchResultUrlWithSettlingRetries(value: string, range?: string) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.fetchRemoteMedia(value, range);
      } catch (error) {
        if (attempt >= this.resultUrlRetryDelaysMs.length) throw error;
        await delay(this.resultUrlRetryDelaysMs[attempt]!);
      }
    }
  }

  private async fetchRemoteMedia(value: string, range?: string) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new GenerationJobServiceError("RESULT_DOWNLOAD_FAILED", "生成结果下载地址无效");
    }
    if (url.protocol !== "https:") throw new GenerationJobServiceError("RESULT_DOWNLOAD_FAILED", "生成结果下载地址不安全");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await this.fetcher(url, {
        headers: {
          ...(range ? { Range: range } : {}),
          "Accept-Encoding": "identity",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(5 * 60_000),
      }).catch(() => null);
      if (!response) throw new GenerationJobServiceError("RESULT_DOWNLOAD_UNAVAILABLE", "生成结果下载连接中断");
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("Location");
        await response.body?.cancel().catch(() => undefined);
        if (!location) throw new GenerationJobServiceError("RESULT_DOWNLOAD_FAILED", "生成结果下载地址无效");
        try {
          const redirected = new URL(location, url);
          if (redirected.protocol !== "https:") throw new Error("insecure redirect");
          url = redirected;
        } catch {
          throw new GenerationJobServiceError("RESULT_DOWNLOAD_FAILED", "生成结果下载地址不安全");
        }
        continue;
      }
      if (response.ok || response.status === 206) return response;
      await response.body?.cancel().catch(() => undefined);
      throw new GenerationJobServiceError(
        response.status >= 500 || response.status === 429 ? "RESULT_DOWNLOAD_UNAVAILABLE" : "RESULT_DOWNLOAD_FAILED",
        response.status >= 500 || response.status === 429 ? "生成结果暂时无法下载" : `生成结果下载失败 (${response.status})`,
      );
    }
    throw new GenerationJobServiceError("RESULT_DOWNLOAD_UNAVAILABLE", "生成结果下载重定向次数过多");
  }

  private async fetchMedia(
    path: string,
    accessToken: string,
    range?: string,
    sessionToken?: string,
    retryMissing = false,
  ) {
    const request = async (url: URL, authorized: boolean, token = accessToken) => this.fetcher(url, {
      headers: {
        ...(authorized ? { Authorization: `Bearer ${token}` } : {}),
        ...(range ? { Range: range } : {}),
        "Accept-Encoding": "identity",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(5 * 60_000),
    });
    let activeAccess: PromptHubAccess = { data: { accessToken } };
    let refreshed = false;
    try {
      for (let attempt = 0; attempt <= this.mediaRetryDelaysMs.length; attempt += 1) {
        if (attempt > 0) await delay(this.mediaRetryDelaysMs[attempt - 1] ?? 0);
        let response = await request(
          new URL(path, this.origin),
          true,
          activeAccess.data.accessToken,
        ).catch(() => null);
        if (!response) {
          if (attempt < this.mediaRetryDelaysMs.length) continue;
          throw new GenerationJobServiceError("RESULT_DOWNLOAD_UNAVAILABLE", "生成结果下载连接中断，正在自动重试");
        }
        if (response.status === 401 && sessionToken && !refreshed) {
          await response.body?.cancel().catch(() => undefined);
          activeAccess = await this.resolveAccess(sessionToken, true);
          refreshed = true;
          response = await request(
            new URL(path, this.origin),
            true,
            activeAccess.data.accessToken,
          ).catch(() => null);
        }
        if (!response) {
          if (attempt < this.mediaRetryDelaysMs.length) continue;
          throw new GenerationJobServiceError("RESULT_DOWNLOAD_UNAVAILABLE", "生成结果下载连接中断，正在自动重试");
        }
        if (response.status === 401) {
          await response.body?.cancel().catch(() => undefined);
          throw new GenerationJobServiceError("UNAUTHENTICATED", "登录已过期，请重新登录");
        }

        let followedRedirect = false;
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("Location");
          if (!location) throw new GenerationJobServiceError("RESULT_DOWNLOAD_FAILED", "生成结果下载地址无效");
          const redirected = new URL(location, this.origin);
          if (redirected.protocol !== "https:") throw new GenerationJobServiceError("RESULT_DOWNLOAD_FAILED", "生成结果下载地址不安全");
          await response.body?.cancel().catch(() => undefined);
          followedRedirect = true;
          response = await request(redirected, false).catch(() => null);
          if (!response) {
            if (attempt < this.mediaRetryDelaysMs.length) continue;
            throw new GenerationJobServiceError("RESULT_DOWNLOAD_UNAVAILABLE", "生成结果下载连接中断，正在自动重试");
          }
        }
        if (response.ok || response.status === 206) {
          const length = Number(response.headers.get("Content-Length"));
          if (Number.isFinite(length) && length > 512 * 1024 * 1024) {
            await response.body?.cancel().catch(() => undefined);
            throw new GenerationJobServiceError("RESULT_MEDIA_TOO_LARGE", "生成结果大小超过当前限制");
          }
          return response;
        }

        const retryable = isRetryableMediaStatus(response.status)
          || (followedRedirect && (response.status === 401 || response.status === 403))
          || (retryMissing && (response.status === 404 || response.status === 403));
        const status = response.status;
        await response.body?.cancel().catch(() => undefined);
        if (retryable && attempt < this.mediaRetryDelaysMs.length) continue;
        throw new GenerationJobServiceError(
          retryable ? "RESULT_DOWNLOAD_UNAVAILABLE" : "RESULT_DOWNLOAD_FAILED",
          retryable ? `生成结果暂时无法下载 (${status})，正在自动重试` : `生成结果下载失败 (${status})`,
        );
      }
      throw new GenerationJobServiceError("RESULT_DOWNLOAD_UNAVAILABLE", "生成结果下载连接中断，正在自动重试");
    } catch (error) {
      throw attachRefresh(error, this.latestAccess(sessionToken, activeAccess));
    }
  }

  private async fetchWithAuthRetry(
    url: URL,
    accessToken: string,
    sessionToken: string | undefined,
    init: RequestInit,
  ): Promise<{ response: Response | null; access: PromptHubAccess }> {
    const request = (token: string) => this.fetcher(url, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: init.signal ?? AbortSignal.timeout(this.requestTimeoutMs),
    });
    let activeAccess: PromptHubAccess = { data: { accessToken } };
    let response = await request(accessToken).catch(() => null);
    if (response?.status === 401 && sessionToken) {
      const refreshed = await this.resolveAccess(sessionToken, true);
      activeAccess = refreshed;
      response = await request(refreshed.data.accessToken).catch(() => null);
    }
    return { response, access: this.latestAccess(sessionToken, activeAccess) };
  }

  private async resolveAccess(token: string | undefined, force = false) {
    if (token && !force) {
      const cached = this.refreshedAccess.get(token);
      if (cached) return cached;
    }
    const access = await this.auth.resolveUpstreamAccess(token, force ? { force: true } : undefined);
    if (token && (force || access.refreshedToken)) this.refreshedAccess.set(token, access);
    return access;
  }

  /**
   * The background reconciliation must never wait on an access resolver that
   * does not settle: bound it to the remaining reconciliation budget so a hung
   * resolver still resolves the reconciliation (into a failure + cooldown) and
   * the per-job single-flight entry is released in `finally` for the next
   * observation.
   */
  private resolveAccessBounded(token: string | undefined, deadline: number, force = false) {
    const remaining = deadline - this.now();
    if (remaining <= 0) return Promise.reject(reconciliationTimeoutError());
    return withTimeout(this.resolveAccess(token, force), remaining, reconciliationTimeoutError);
  }

  private remainingMs(deadline: number) {
    return Math.max(0, deadline - this.now());
  }

  private latestAccess(token: string | undefined, fallback: PromptHubAccess) {
    return token ? this.refreshedAccess.get(token) ?? fallback : fallback;
  }
}

/**
 * The hosted Prompt Hub video endpoint still accepts its legacy request
 * envelope (`duration`, `ratio`, `resolution`). Canvas catalogs intentionally
 * expose the provider-neutral `duration_seconds`/`aspect_ratio` names. Project
 * only those canonical fields that the relay does not parse, while preserving
 * older catalog aliases such as `seconds` for existing routes.
 */
function promptHubVideoParameters(parameters: Record<string, unknown>, modelId?: string) {
  const next = { ...parameters };
  if (parameters.duration_seconds !== undefined
    && parameters.duration === undefined
    && parameters.seconds === undefined) {
    next.duration = parameters.duration_seconds;
    delete next.duration_seconds;
  }
  if (parameters.aspect_ratio !== undefined && parameters.ratio === undefined) {
    next.ratio = parameters.aspect_ratio;
    delete next.aspect_ratio;
  }
  if (modelId && isMinimaxH3Model(modelId)) {
    const resolution = h3Resolution(parameters);
    if (resolution) {
      // H3 super-resolution is a separate upstream workflow. `size` carries
      // the 2K/4K tier there; leaving it on the ordinary route makes ComfyUI
      // interpret the tier as an aspect-ratio size and reject the request.
      next.workflow_id = "cf-multi-reference";
      next.size = resolution;
      delete next.resolution;
    }
  }
  return next;
}

function hasImageReferences(references: HostedPreparedReferences) {
  return references.images.length + references.styleImages.length + references.elementImages.length > 0;
}

function requestErrorName(error: unknown) {
  if (error instanceof Error && error.name) return error.name;
  return "UnknownError";
}

function requestErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "string") return direct.slice(0, 80);
  const cause = (error as { cause?: unknown }).cause;
  if (!cause || typeof cause !== "object") return undefined;
  const nested = (cause as { code?: unknown }).code;
  return typeof nested === "string" ? nested.slice(0, 80) : undefined;
}

class PromptHubRequestError extends Error {
  constructor(readonly code: string, message: string, readonly definitive: boolean) {
    super(message);
    this.name = "PromptHubRequestError";
  }
}

function reconciliationTimeoutError() {
  return new PromptHubRequestError("GENERATION_PROVIDER_UNAVAILABLE", "生成服务连接超时", false);
}

function isPromptHubNotFound(error: unknown) {
  return error instanceof PromptHubRequestError
    && error.definitive
    && (error.code === "NOT_FOUND" || error.code === "404");
}

function isRetryableMediaStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function generatedReferenceIdempotencyKey(mediaId: string) {
  return `generated-reference:${mediaId}`;
}

function parseHttpByteRange(value: string | undefined, totalSize: number) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value?.trim() || "");
  if (!match || !totalSize || (!match[1] && !match[2])) return null;
  const requestedStart = match[1] ? Number(match[1]) : null;
  const requestedEnd = match[2] ? Number(match[2]) : null;
  if ((requestedStart !== null && !Number.isSafeInteger(requestedStart))
    || (requestedEnd !== null && !Number.isSafeInteger(requestedEnd))) return null;
  if (requestedStart === null) {
    const suffix = Math.min(totalSize, requestedEnd || 0);
    return suffix > 0 ? { start: totalSize - suffix, end: totalSize - 1 } : null;
  }
  const end = requestedEnd === null ? totalSize - 1 : Math.min(requestedEnd, totalSize - 1);
  return requestedStart >= 0 && requestedStart <= end && requestedStart < totalSize
    ? { start: requestedStart, end }
    : null;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Race a promise against a timeout. The inner promise keeps its own rejection
 * handled by the race, so a later rejection (for example a resolver that
 * finally settles after the timeout) never becomes an unhandled rejection, and
 * the timer is always cleared when either branch settles.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, createError: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(createError()), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function toQuoteRequest(submission: GenerationJobSubmission) {
  return {
    modelId: submission.modelId,
    modality: submission.modality,
    parameters: submission.parameters,
    inputs: {
      images: submission.inputs.images.length,
      styleImages: submission.inputs.styleImages?.length ?? 0,
      elementImages: submission.inputs.elementImages?.length ?? 0,
      videos: submission.inputs.videos.length,
      audios: submission.inputs.audios.length,
    },
    quantity: submission.quantity,
    inputTokens: submission.inputTokens,
    maxOutputTokens: submission.maxOutputTokens,
  };
}

function assertExpectedQuote(submission: GenerationJobSubmission, quote: GenerationQuote, now: number) {
  const expected = submission.expectedQuote;
  const matches = expected.modelId === quote.modelId
    && submission.modelId === quote.modelId
    && submission.modality === quote.modality
    && submission.quantity === quote.quantity
    && expected.pricingVersion === quote.pricingVersion
    && expected.creditMicros === quote.creditMicros
    && Date.parse(expected.expiresAt) > now;
  if (!matches) throw new GenerationJobServiceError("QUOTE_CHANGED", "价格或可用参数已更新，请确认后再生成", quote);
}

function nextRecord(record: HostedJobRecord, patch: Partial<PublicGenerationJob>, now: number): HostedJobRecord {
  return hostedJobRecordSchema.parse({
    ...record,
    job: {
      ...record.job,
      ...patch,
      version: record.job.version + 1,
      updatedAt: new Date(now).toISOString(),
    },
  });
}

function artifactsFor(record: HostedJobRecord, upstream: Record<string, unknown>, now: number) {
  const createdAt = new Date(now).toISOString();
  if (record.job.modality === "video") {
    return [{
      id: `artifact_${record.job.id}_0`,
      kind: "video" as const,
      mediaId: `phm_${record.job.id.slice(4)}_0`,
      name: `${record.job.modelLabel}.mp4`,
      mimeType: "video/mp4",
      size: 0,
      createdAt,
    }];
  }
  const urls = imageUrls(upstream);
  const requestedCount = record.job.quote.outputCount
    ?? totalOutputCount("image", record.job.quote.quantity, record.job.quote.normalizedParameters);
  // Never expose more artifacts than were quoted/billed. If the provider
  // returns fewer URLs, reflect the actual result count instead.
  // Request-priced Midjourney jobs are exempt: the station bills one call and
  // delivers a grid cover plus four singles (declared count 4-5 with
  // includes_cover_grid), so the quoted four-image contract undercounts the
  // real gallery and capping here silently drops the fifth image. This also
  // preserves the legacy APIMart grid-cover behavior.
  const midjourneyJob = /midjourney|^mj-/i.test(record.job.modelId);
  const deliveredCount
    = (record.provider === "apimart" || midjourneyJob) && urls.length > requestedCount
      ? urls.length
      : requestedCount;
  const count = Math.max(1, Math.min(8, urls.length ? Math.min(urls.length, deliveredCount) : deliveredCount));
  return Array.from({ length: count }, (_, index) => ({
    id: `artifact_${record.job.id}_${index}`,
    kind: "image" as const,
    mediaId: `phm_${record.job.id.slice(4)}_${index}`,
    name: `${record.job.modelLabel}-${index + 1}.png`,
    mimeType: "image/png",
    size: 0,
    createdAt,
  }));
}

type NormalizedUpstreamStatus = PublicGenerationJob["status"] | "unknown";

/**
 * Interpret an upstream task status. An unsupported or absent value must never
 * collapse into a normal `queued`/`running` appearance: a submission whose
 * outcome cannot be read is `submission_unknown`, never a healthy running job.
 */
function normalizeStatus(value: unknown): NormalizedUpstreamStatus {
  const status = typeof value === "string" ? value.trim().toLowerCase().replace(/-/g, "_") : "";
  if (["completed", "complete", "success", "succeeded", "done"].includes(status)) return "completed";
  if (["failed", "failure", "error", "timeout", "expired", "cancelled", "canceled"].includes(status)) return "failed";
  if (["running", "processing", "in_progress"].includes(status)) return "running";
  if (["queued", "pending", "waiting", "created", "submitted"].includes(status)) return "queued";
  return "unknown";
}

function upstreamJobId(value: Record<string, unknown>) {
  for (const key of ["jobId", "job_id", "id", "taskId", "task_id"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

/**
 * 上游回报的实扣与退款状态。视频按整单预扣、失败全额退回，所以任务收敛时
 * creditsCharged 就是用户真实付出的积分。缺字段或数值不可信时返回 null——
 * 宁可这条任务不显示实扣，也不拿报价伪造一个数字。
 */
function upstreamBilling(value: Record<string, unknown>): GenerationJobBilling | null {
  const charged = value.creditsCharged ?? value.credits_charged;
  if (typeof charged !== "number" || !Number.isFinite(charged) || charged < 0) return null;
  return {
    chargedCreditMicros: Math.round(charged * 1_000_000),
    refunded: value.refunded === true,
  };
}

function normalizedProgress(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value)))
    : fallback;
}

function upstreamError(status: number, envelope: z.infer<typeof upstreamEnvelopeSchema>) {
  const nested = envelope.error && typeof envelope.error === "object" && !Array.isArray(envelope.error)
    ? envelope.error as Record<string, unknown>
    : {};
  const rawCode = nested.code ?? envelope.code;
  const sourceCode = typeof rawCode === "string" ? rawCode : typeof rawCode === "number" ? String(rawCode) : "";
  const sourceMessage = [nested.message, envelope.message, typeof envelope.error === "string" ? envelope.error : null]
    .find((value) => typeof value === "string" && value.trim());
  if (status === 401) return { code: "UNAUTHENTICATED", message: "登录已过期，请重新登录" };
  if (status === 402 || /INSUFFICIENT|BALANCE|CREDIT/i.test(sourceCode)) {
    return { code: "INSUFFICIENT_CREDITS", message: "积分不足，请充值后重试" };
  }
  if (status === 429) return { code: "GENERATION_RATE_LIMITED", message: "生成请求过于频繁，请稍后重试" };
  return {
    code: sourceCode || "GENERATION_PROVIDER_REJECTED",
    message: typeof sourceMessage === "string" ? sourceMessage.slice(0, 240) : "生成请求没有完成",
  };
}

function isDefinitiveRoutingRejection(code: string, message: string) {
  const value = `${code} ${message}`;
  return /(?:^|\b)(?:MODEL_UNAVAILABLE|ROUTING_UNAVAILABLE|NO_AVAILABLE_CHANNEL)(?:\b|$)/i.test(value)
    || /无可用渠道|没有可用渠道|no available (?:channel|route)|(?:渠道|线路|路由).{0,24}(?:不可用|无法确认)|(?:模型|model).{0,24}(?:不可用|unavailable)|\bdistributor\b/i.test(value);
}

function upstreamErrorMessage(value: Record<string, unknown>) {
  for (const key of ["errorMessage", "error_message", "message", "fail_reason", "failure_reason"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 240);
  }
  const error = value.error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message.trim().slice(0, 240);
  }
  return "";
}

/**
 * An upstream payload whose status is not interpretable may still declare a
 * failure outright. Return the failure message when it does, otherwise null:
 * an absent/empty `error` (which healthy running payloads commonly carry) is
 * not a failure. Kept separate from `normalizeStatus` so a task that merely
 * has no readable status keeps its `submission_unknown` recovery path, and
 * only an explicit declaration converges to a terminal failure.
 */
function upstreamDeclaredFailure(value: Record<string, unknown>): string | null {
  if (value.ok === false || value.success === false) {
    return upstreamErrorMessage(value) || "生成任务未能提交";
  }
  const error = value.error;
  if (typeof error === "string" && error.trim()) return error.trim().slice(0, 240);
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const record = error as Record<string, unknown>;
  const code = record.code;
  const message = typeof record.message === "string" ? record.message.trim() : "";
  if (message) return message.slice(0, 240);
  if ((typeof code === "string" && code.trim()) || typeof code === "number") return "生成任务失败";
  return null;
}

function imageUrls(value: Record<string, unknown>) {
  const urls: string[] = [];
  const structuredUrls: string[] = [];
  let gridUrl: string | null = null;
  const push = (item: unknown) => {
    if (typeof item === "string" && /^https:\/\//i.test(item) && !urls.includes(item)) urls.push(item);
  };
  const pushStructured = (item: unknown) => {
    if (typeof item === "string" && /^https:\/\//i.test(item) && !structuredUrls.includes(item)) structuredUrls.push(item);
  };
  const pushItem = (item: unknown) => {
    if (typeof item === "string") {
      pushStructured(item);
      return;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const record = item as Record<string, unknown>;
    for (const key of ["url", "content_url", "download_url", "image_url", "imageUrl", "output_url", "result_url"]) {
      pushStructured(record[key]);
    }
  };
  const visit = (current: unknown, depth: number) => {
    if (depth > 8 || !current || typeof current !== "object") return;
    if (Array.isArray(current)) {
      for (const child of current) pushItem(child);
      return;
    }
    const record = current as Record<string, unknown>;
    const possibleGrid = record.grid_image_url ?? record.gridImageUrl;
    if (typeof possibleGrid === "string" && /^https:\/\//i.test(possibleGrid)) {
      gridUrl = possibleGrid;
      push(possibleGrid);
    }
    push(record.image_url);
    push(record.content_url);
    push(record.download_url);
    push(record.output_url);
    push(record.result_url);
    if (!Array.isArray(record.image_urls)
      && !Array.isArray(record.images)
      && !Array.isArray(record.outputs)
      && !Array.isArray(record.results)
      && !Array.isArray(record.data)) {
      push(record.imageUrl);
      push(record.url);
    }
    for (const key of [
      "image_urls",
      "images",
      "outputs",
      "results",
      "data",
      "extraImageUrls",
      "extra_image_urls",
      "mjGalleryUrls",
      "mj_gallery_urls",
    ]) {
      const items = record[key];
      if (Array.isArray(items)) {
        for (const item of items) pushItem(item);
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if ([
        "grid_image_url",
        "gridImageUrl",
        "image_urls",
        "images",
        "outputs",
        "results",
        "extraImageUrls",
        "extra_image_urls",
        "mjGalleryUrls",
        "mj_gallery_urls",
      ].includes(key)) continue;
      if (child && typeof child === "object") visit(child, depth + 1);
    }
  };
  visit(value, 0);
  if (structuredUrls.length) {
    return gridUrl ? [gridUrl, ...structuredUrls.filter((url) => url !== gridUrl)] : structuredUrls;
  }
  return urls;
}

function imageProtocolOptions(parameters: Record<string, unknown>) {
  const options: Record<string, unknown> = {};
  const core = new Set([
    "model",
    "prompt",
    "resolution",
    "size",
    "aspect_ratio",
    "aspectRatio",
    "ratio",
    "quality",
    "count",
    "n",
    "image_urls",
  ]);
  for (const [name, value] of Object.entries(parameters)) {
    if (!core.has(name) && value !== undefined && value !== null && value !== "") options[name] = value;
  }
  return options;
}

function isMidjourneyModel(modelId: string) {
  // Station MJ ids: legacy (mj-v7, mj-v81, mj-v82), dotted stable series
  // (mj-v8.2 …), and the published Chinese display ids (高速/特惠). All of
  // them are one-call routes whose `count` must never be forwarded.
  const normalized = modelId.trim().toLowerCase();
  return normalized.includes("midjourney")
    || /^mj-v\d/.test(normalized)
    || normalized === "mj-niji7";
}

const MIDJOURNEY_VERSION_BY_MODEL: Readonly<Record<string, string>> = {
  "midjourney v8.2 高速": "8.2",
  "mj-v82": "8.2",
  "mj-v81": "8.1",
  "mj-v7": "7",
  "mj-niji7": "7",
};

const MIDJOURNEY_BODY_FIELDS = [
  "prompt",
  "size",
  "version",
  "speed",
  "niji",
  "image_urls",
  "stylize",
  "chaos",
  "weird",
  "negative_prompt",
  "negativePrompt",
  "seed",
  "tile",
  "raw",
  "draft",
  "hd",
  "iw",
  "quality",
  "style",
  "cw",
  "sw",
  "cref",
  "sref",
  "dref",
  "dw",
  "stop",
  "extra",
] as const;

function buildApimartMidjourneyBody(modelId: string, parameters: Record<string, unknown>) {
  const normalizedModel = modelId.trim().toLowerCase();
  const body: Record<string, unknown> = {
    prompt: parameters.prompt,
    version: MIDJOURNEY_VERSION_BY_MODEL[normalizedModel],
    speed: typeof parameters.speed === "string" && parameters.speed.trim()
      ? parameters.speed.trim()
      : "relax",
    ...(normalizedModel === "mj-niji7" ? { niji: true } : {}),
  };
  const size = imageParameter(parameters, ["size", "aspect_ratio", "aspectRatio", "ratio"]);
  if (size && size !== "auto") body.size = size;
  for (const field of MIDJOURNEY_BODY_FIELDS) {
    if (field === "prompt" || field === "size" || field === "version" || field === "speed" || field === "niji") continue;
    const value = parameters[field];
    if (value !== undefined && value !== null && value !== "") body[field] = value;
  }
  if (body.negativePrompt !== undefined && body.negative_prompt === undefined) {
    body.negative_prompt = body.negativePrompt;
    delete body.negativePrompt;
  }
  return body;
}

function samePublicJob(left: PublicGenerationJob, right: PublicGenerationJob) {
  const normalize = (job: PublicGenerationJob) => ({ ...job, version: 0, updatedAt: "" });
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function withRefresh<T>(data: T, access: PromptHubAccess): HostedGenerationResult<T> {
  return {
    data,
    ...(access.refreshedToken && access.expiresAt ? {
      refreshedToken: access.refreshedToken,
      expiresAt: access.expiresAt,
    } : {}),
  };
}

function attachRefresh<T>(error: T, access: PromptHubAccess): T {
  if (error instanceof Error && access.refreshedToken && access.expiresAt) {
    Object.assign(error, { refreshedToken: access.refreshedToken, expiresAt: access.expiresAt });
  }
  return error;
}

function cloneRecord(record: HostedJobRecord | null) {
  return record ? structuredClone(record) : null;
}

function cloneReference(reference: HostedReference | null) {
  return reference ? structuredClone(reference) : null;
}

function publicReference(reference: HostedReference): PublicMedia {
  return publicMediaSchema.parse({
    id: reference.id,
    kind: reference.kind,
    name: reference.name,
    mimeType: reference.mimeType,
    size: reference.size,
    sha256: reference.sha256,
    width: null,
    height: null,
    durationMs: null,
    status: reference.ref ? "ready" : "pending",
    error: null,
    createdAt: reference.createdAt,
    updatedAt: reference.updatedAt,
  });
}

function referenceIntent(reference: HostedReference) {
  const media = publicReference(reference);
  return {
    media,
    upload: reference.ref ? null : {
      method: "PUT" as const,
      url: `/api/v1/media/${encodeURIComponent(reference.id)}/content`,
      headers: { "Content-Type": reference.mimeType },
      expiresAt: new Date(Date.parse(reference.createdAt) + 60 * 60_000).toISOString(),
      completeUrl: null,
    },
  };
}

function defaultMime(kind: MediaKind) {
  if (kind === "image") return "image/png";
  if (kind === "video") return "video/mp4";
  return "audio/mpeg";
}

function extensionFor(mimeType: string, kind: MediaKind) {
  const known: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
  };
  return known[mimeType.toLowerCase()] ?? (kind === "image" ? "png" : kind === "video" ? "mp4" : "mp3");
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

/**
 * Resolve a Prompt Hub media ref into a provider-facing absolute HTTPS URL.
 * Relative refs resolve only against the currently trusted upstream origin, so
 * a bare or protocol-relative ref can never reach an unvouched host. A ref with
 * an explicit scheme keeps that absolute authority only when the upstream
 * vouched for it and it carries no embedded credentials; anything that is not
 * absolute HTTPS, embeds credentials, or resolves to another origin without an
 * explicit upstream authority is rejected instead of becoming a fetchable URL.
 */
function resolveProviderReferenceUrl(ref: string, trustedOrigin: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(ref, trustedOrigin);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(ref)) {
    if (parsed.origin !== trustedOrigin) return null;
  }
  return parsed.toString();
}
