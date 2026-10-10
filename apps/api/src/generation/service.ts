import { randomUUID } from "node:crypto";

import {
  GENERATION_JOB_SCHEMA_VERSION,
  generationJobIdempotencyKeySchema,
  generationJobInputSchema,
  generationJobSubmissionSchema,
  type GenerationJobSubmission,
  type GenerationQuote,
  type PublicGenerationJob,
} from "@kachang/contracts";

import { transitionGenerationJob } from "./job-state.js";
import type { ResolvedGenerationRoute } from "../catalog/execution-route.js";
import {
  GenerationArtifactError,
  GenerationProviderError,
  toPublicGenerationJob,
  type GenerationArtifactStore,
  type GenerationJobRecord,
  type GenerationJobStore,
  type GenerationProvider,
  type ProviderExecutionState,
  type ProviderGenerationRequest,
} from "./types.js";

type QuoteProvider = {
  createQuote(value: unknown): Promise<GenerationQuote>;
};

/**
 * A native image task must finish inside a finite budget. A provider that
 * accepts the submission and then keeps answering queued/running forever would
 * otherwise be polled indefinitely, leaving the canvas node in a permanent
 * generating state. Video is deliberately exempt: long renders are normal.
 */
const IMAGE_GENERATION_MAX_LIFETIME_MS = 10 * 60_000;

type ExecutionRouteProvider = {
  getExecutionRoute(modelId: string): Promise<ResolvedGenerationRoute | null>;
};

export type GenerationInputAuthorizationResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export interface GenerationInputAuthorizer {
  authorize(
    ownerId: string,
    projectId: string,
    inputs: GenerationJobSubmission["inputs"],
  ): Promise<GenerationInputAuthorizationResult>;
}

export class GenerationJobServiceError extends Error {
  constructor(readonly code: string, message: string, readonly currentQuote?: GenerationQuote) {
    super(message);
    this.name = "GenerationJobServiceError";
  }
}

export class GenerationJobService {
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly maxActiveJobs: number;

  constructor(
    private readonly quotes: QuoteProvider,
    private readonly routes: ExecutionRouteProvider,
    private readonly store: GenerationJobStore,
    private readonly options: {
      now?: () => number;
      createId?: () => string;
      inputAuthorizer?: GenerationInputAuthorizer;
      maxActiveJobs?: number;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    // Keep a generous in-flight ceiling; the API rate limiter still controls
    // submission volume, so independent image jobs can run concurrently.
    this.maxActiveJobs = positiveInteger(options.maxActiveJobs ?? 100, "maxActiveJobs");
  }

  async submit(ownerId: string, value: unknown): Promise<PublicGenerationJob> {
    if (!ownerId) throw new GenerationJobServiceError("UNAUTHENTICATED", "请先登录");
    const submission = generationJobSubmissionSchema.parse(value);
    const existing = await this.store.findByIdempotency(ownerId, submission.idempotencyKey);
    if (existing) return toPublicGenerationJob(existing);

    const referenceCount = submission.inputs.images.length
      + submission.inputs.styleImages.length
      + submission.inputs.elementImages.length
      + submission.inputs.videos.length
      + submission.inputs.audios.length;
    if (referenceCount > 0) {
      if (!this.options.inputAuthorizer) {
        throw new GenerationJobServiceError("REFERENCE_VALIDATION_UNAVAILABLE", "参考素材暂时无法校验");
      }
      const authorization = await this.options.inputAuthorizer.authorize(ownerId, submission.projectId, submission.inputs);
      if (!authorization.ok) throw new GenerationJobServiceError(authorization.code, authorization.message);
    }

    const quote = await this.quotes.createQuote(toQuoteRequest(submission));
    if (quote.normalizedParameters.stream === true) {
      throw new GenerationJobServiceError("STREAMING_UNAVAILABLE", "当前任务暂不支持流式生成");
    }
    assertExpectedQuote(submission, quote, this.now());
    const resolvedRoute = await this.routes.getExecutionRoute(quote.modelId);
    assertExecutionRoute(quote, resolvedRoute);
    const job = createReservedJob(ownerId, submission, quote, resolvedRoute!, this.createId(), this.now());
    const created = await this.store.createWithReservation(job, quote.creditMicros, {
      maxActiveJobs: this.maxActiveJobs,
    });
    if (created.kind === "active_limit") {
      throw new GenerationJobServiceError("ACTIVE_JOB_LIMIT", "请等待当前生成任务完成后再继续");
    }
    if (created.kind === "insufficient_credits") {
      throw new GenerationJobServiceError("INSUFFICIENT_CREDITS", "积分不足，请充值后重试");
    }
    return toPublicGenerationJob(created.job);
  }

  async get(ownerId: string, jobId: string) {
    const job = await this.store.getById(jobId);
    if (!job || job.ownerId !== ownerId) throw new GenerationJobServiceError("JOB_NOT_FOUND", "没有找到这个生成任务");
    return toPublicGenerationJob(job);
  }

  /**
   * Resolve one durable request by its existing idempotency identity. This is
   * the authoritative read-only reconciliation for a persisted optimistic
   * submission: it reuses the store's owner/idempotency lookup instead of
   * scanning a capped list, never mutates the job, and never submits, retries,
   * replays, or contacts a provider. A null result is an unambiguous miss.
   */
  async resolveByIdempotency(ownerId: string, key: string): Promise<PublicGenerationJob | null> {
    if (!ownerId) throw new GenerationJobServiceError("UNAUTHENTICATED", "请先登录");
    const parsed = generationJobIdempotencyKeySchema.parse(key);
    const job = await this.store.findByIdempotency(ownerId, parsed);
    return job ? toPublicGenerationJob(job) : null;
  }

  async list(ownerId: string, value: { projectId?: string; limit?: number } = {}) {
    if (!ownerId) throw new GenerationJobServiceError("UNAUTHENTICATED", "请先登录");
    const projectId = value.projectId?.trim();
    if (projectId !== undefined && (!projectId || projectId.length > 128)) {
      throw new GenerationJobServiceError("INVALID_PROJECT_ID", "项目标识格式不正确");
    }
    const limit = value.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new GenerationJobServiceError("INVALID_LIMIT", "任务数量范围不正确");
    }
    return (await this.store.listByOwner(ownerId, {
      ...(projectId ? { projectId } : {}),
      limit,
    })).map(toPublicGenerationJob);
  }
}

export class GenerationJobProcessor {
  private readonly now: () => number;
  private readonly submissionTimeoutMs: number;
  private readonly imageLifetimeMs: number;
  private readonly onCleanupError: (error: unknown) => void;

  constructor(
    private readonly store: GenerationJobStore,
    private readonly provider: GenerationProvider,
    private readonly artifacts: GenerationArtifactStore,
    options: {
      now?: () => number;
      submissionTimeoutMs?: number;
      /** Finite lifetime for an image task still queued/running before it
       * converges to a retryable timeout. Video is exempt. Defaults to 10 min. */
      imageLifetimeMs?: number;
      onCleanupError?: (error: unknown) => void;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.submissionTimeoutMs = options.submissionTimeoutMs ?? 2 * 60_000;
    this.imageLifetimeMs = options.imageLifetimeMs ?? IMAGE_GENERATION_MAX_LIFETIME_MS;
    this.onCleanupError = options.onCleanupError ?? ((error) => console.error("Generation result cleanup failed", error));
  }

  async process(jobId: string): Promise<GenerationJobRecord> {
    const job = await this.requireJob(jobId);
    if (this.isImageLifetimeExceeded(job)) {
      return this.fail(job, "GENERATION_TIMEOUT", "生成超时，请重试", true);
    }
    if (job.status === "reserved") return this.submitReserved(job);
    if (job.status === "queued" || job.status === "running") return this.poll(job);
    if (job.status === "validating") return this.validate(job);
    if (job.status === "submitting" && this.isSubmissionStale(job)) {
      return this.save(job, { type: "submission_unknown" });
    }
    return job;
  }

  async reconcileSubmission(jobId: string, state: ProviderExecutionState) {
    const job = await this.requireJob(jobId);
    if (job.status !== "submission_unknown") {
      throw new GenerationJobServiceError("JOB_NOT_RECONCILABLE", "当前任务不需要提交状态确认");
    }
    return this.applyProviderState(job, state);
  }

  private async submitReserved(job: GenerationJobRecord) {
    const submitting = await this.save(job, { type: "submission_started" });
    let state: ProviderExecutionState;
    try {
      state = await this.provider.submit(providerRequest(submitting));
    } catch (error) {
      if (error instanceof GenerationProviderError && error.outcome === "rejected") {
        return this.fail(submitting, error.code, error.message, false);
      }
      return this.save(submitting, { type: "submission_unknown" });
    }
    return this.applyProviderState(submitting, state);
  }

  private async poll(job: GenerationJobRecord) {
    if (!job.providerTaskId) return this.fail(job, "PROVIDER_TASK_MISSING", "生成任务缺少恢复标识", false);
    try {
      return await this.applyProviderState(job, await this.provider.poll(job.providerTaskId, providerRequest(job)));
    } catch (error) {
      if (error instanceof GenerationProviderError && error.outcome === "rejected") {
        return this.fail(job, error.code, error.message, false);
      }
      throw error;
    }
  }

  private async applyProviderState(job: GenerationJobRecord, state: ProviderExecutionState): Promise<GenerationJobRecord> {
    if (state.kind === "queued") return this.save(job, { type: "provider_queued", taskId: state.taskId, progress: state.progress });
    if (state.kind === "running") return this.save(job, { type: "provider_running", taskId: state.taskId, progress: state.progress });
    if (state.kind === "failed") return this.fail(job, state.code, state.message, state.retryable ?? false);
    const validating = await this.save(job, { type: "provider_output", resultRef: state.resultRef, taskId: state.taskId });
    return this.validate(validating);
  }

  private async validate(job: GenerationJobRecord) {
    if (!job.providerResultRef) return this.fail(job, "RESULT_REFERENCE_MISSING", "生成结果缺少校验引用", false);
    let persisted: Awaited<ReturnType<GenerationArtifactStore["persist"]>>;
    try {
      persisted = await this.artifacts.persist(job, job.providerResultRef);
    } catch (error) {
      if (error instanceof GenerationArtifactError) return this.fail(job, error.code, error.message, false);
      throw error;
    }
    if (!persisted.artifacts.length) {
      return this.fail(job, "RESULT_EMPTY", "生成任务没有返回可用结果", false);
    }
    if (persisted.artifacts.some((artifact) => artifact.kind !== job.modality)) {
      return this.fail(job, "RESULT_TYPE_MISMATCH", "生成结果类型与当前节点不一致", false);
    }
    const captureCreditMicros = persisted.captureCreditMicros ?? (job.quote.estimated ? undefined : job.quote.creditMicros);
    if (captureCreditMicros === undefined
      || !Number.isSafeInteger(captureCreditMicros)
      || captureCreditMicros < 0
      || captureCreditMicros > job.quote.creditMicros) {
      return this.fail(job, "SETTLEMENT_AMOUNT_INVALID", "本次生成暂时无法完成结算", false);
    }
    const completed = transitionGenerationJob(job, { type: "validation_completed", artifacts: persisted.artifacts }, this.now());
    const saved = await this.store.completeWithCapture(completed, job.revision, captureCreditMicros);
    if (!saved) throw conflict();
    await this.cleanupResult(saved.providerResultRef);
    return saved;
  }

  private async fail(job: GenerationJobRecord, code: string, message: string, retryable: boolean) {
    const failed = transitionGenerationJob(job, { type: "failed", error: { code, message, retryable } }, this.now());
    const saved = await this.store.failWithRelease(failed, job.revision);
    if (!saved) throw conflict();
    await this.cleanupResult(saved.providerResultRef);
    return saved;
  }

  private async save(job: GenerationJobRecord, event: Parameters<typeof transitionGenerationJob>[1]) {
    const next = transitionGenerationJob(job, event, this.now());
    const saved = await this.store.save(next, job.revision);
    if (!saved) throw conflict();
    return saved;
  }

  private async requireJob(jobId: string) {
    const job = await this.store.getById(jobId);
    if (!job) throw new GenerationJobServiceError("JOB_NOT_FOUND", "没有找到这个生成任务");
    return job;
  }

  private isSubmissionStale(job: GenerationJobRecord) {
    return this.now() - Date.parse(job.updatedAt) >= this.submissionTimeoutMs;
  }

  /**
   * Only a genuinely accepted image task (queued/running with a durable task
   * id) can time out here. `reserved`/`submitting` keep their own submission
   * semantics and `validating` is a bounded result-materialization step.
   */
  private isImageLifetimeExceeded(job: GenerationJobRecord) {
    if (job.modality !== "image") return false;
    if (job.status !== "queued" && job.status !== "running") return false;
    if (!job.startedAt) return false;
    return this.now() - Date.parse(job.startedAt) >= this.imageLifetimeMs;
  }

  private async cleanupResult(resultRef: string | null) {
    if (!resultRef || !this.artifacts.cleanup) return;
    await this.artifacts.cleanup(resultRef).catch(this.onCleanupError);
  }
}

function createReservedJob(
  ownerId: string,
  submission: GenerationJobSubmission,
  quote: GenerationQuote,
  resolvedRoute: ResolvedGenerationRoute,
  id: string,
  now: number,
): GenerationJobRecord {
  const timestamp = new Date(now).toISOString();
  return {
    schemaVersion: GENERATION_JOB_SCHEMA_VERSION,
    id,
    ownerId,
    idempotencyKey: submission.idempotencyKey,
    projectId: submission.projectId,
    nodeId: submission.nodeId,
    modelId: quote.modelId,
    modelLabel: quote.modelLabel,
    modality: quote.modality,
    parameters: quote.normalizedParameters,
    inputs: generationJobInputSchema.parse(submission.inputs),
    quantity: quote.quantity,
    inputTokens: submission.inputTokens ?? null,
    maxOutputTokens: submission.maxOutputTokens ?? null,
    status: "reserved",
    progress: 0,
    quote,
    pricing: resolvedRoute.pricing,
    executionRoute: resolvedRoute.route,
    reservationId: `reservation:${id}`,
    providerTaskId: null,
    providerResultRef: null,
    artifacts: [],
    error: null,
    revision: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: null,
    completedAt: null,
  };
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

function providerRequest(job: GenerationJobRecord): ProviderGenerationRequest {
  return {
    jobId: job.id,
    ownerId: job.ownerId,
    projectId: job.projectId,
    modelId: job.modelId,
    modality: job.modality,
    parameters: job.parameters,
    inputs: job.inputs,
    quantity: job.quantity,
    executionRoute: job.executionRoute,
  };
}

function assertExecutionRoute(quote: GenerationQuote, resolved: ResolvedGenerationRoute | null) {
  const matches = resolved
    && resolved.route.modality === quote.modality
    && resolved.catalogVersion === quote.catalogVersion
    && resolved.capabilityVersion === quote.capabilityVersion
    && resolved.pricingVersion === quote.pricingVersion;
  if (!matches) throw new GenerationJobServiceError("QUOTE_CHANGED", "模型能力或价格已更新，请确认后再生成", quote);
}

function conflict() {
  return new GenerationJobServiceError("JOB_CONFLICT", "任务状态已更新，请刷新后重试");
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}
