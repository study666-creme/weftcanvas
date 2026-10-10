import type { GenerationArtifact, GenerationQuote } from "@kachang/contracts";
import { describe, expect, it } from "vitest";

import { KachangCatalogAdapter } from "../catalog/adapter.js";
import { GenerationQuoteService } from "../catalog/quote.js";
import { MemoryCatalogSnapshotStore } from "../catalog/store.js";
import { InvalidGenerationTransitionError, transitionGenerationJob } from "./job-state.js";
import {
  GenerationJobProcessor,
  GenerationJobService,
  type GenerationInputAuthorizer,
} from "./service.js";
import {
  GenerationArtifactError,
  GenerationProviderError,
  toPublicGenerationJob,
  type CreateReservedJobResult,
  type GenerationArtifactStore,
  type GenerationJobRecord,
  type GenerationJobStore,
  type GenerationProvider,
  type PersistedGenerationResult,
  type ProviderExecutionState,
} from "./types.js";

const NOW = Date.parse("2026-07-15T10:00:00.000Z");
const STARTING_BALANCE = 100_000_000;
const quote: GenerationQuote = {
  id: "quote-1",
  modelId: "image2",
  modelLabel: "全能模型2",
  modality: "image",
  quantity: 1,
  normalizedParameters: { prompt: "雨夜街道", size: "16:9" },
  creditMicros: 5_500_000,
  credits: "5.5",
  yuanMicros: 55_000,
  yuan: "0.055",
  estimated: false,
  pricingUnit: "image",
  catalogVersion: "catalog-1",
  capabilityVersion: "capability-1",
  pricingVersion: "pricing-1",
  expiresAt: new Date(NOW + 120_000).toISOString(),
};
const executionRoute = {
  sourceModelId: "private-image-route",
  modality: "image" as const,
  endpoint: { method: "POST" as const, path: "/v1/images/generations", contentType: "application/json" as const },
  parameters: [
    { name: "model", path: "model", type: "string" as const, fixed: "private-image-route" },
    { name: "prompt", path: "prompt", type: "string" as const },
    { name: "size", path: "size", type: "string" as const },
  ],
};

describe("generation job submission", () => {
  it("reserves once when the same idempotency key races", async () => {
    const store = new MemoryGenerationStore(STARTING_BALANCE);
    const service = createService(store);
    const request = submission();

    const [first, second] = await Promise.all([
      service.submit("user-1", request),
      service.submit("user-1", request),
    ]);

    expect(first.id).toBe(second.id);
    expect(first.status).toBe("reserved");
    expect(first.version).toBe(0);
    expect(first).not.toHaveProperty("ownerId");
    expect(first).not.toHaveProperty("executionRoute");
    expect(store.availableCreditMicros).toBe(STARTING_BALANCE - quote.creditMicros);
    expect(store.holds.size).toBe(1);
    expect(store.jobs.size).toBe(1);
  });

  it("returns the current quote without reserving when price confirmation changed", async () => {
    const store = new MemoryGenerationStore(STARTING_BALANCE);
    const service = createService(store);

    await expect(service.submit("user-1", submission({
      expectedQuote: { ...quote, creditMicros: 1_000_000 },
    }))).rejects.toMatchObject({ code: "QUOTE_CHANGED", currentQuote: quote });
    expect(store.availableCreditMicros).toBe(STARTING_BALANCE);
    expect(store.jobs.size).toBe(0);
  });

  it("does not create a job when the wallet cannot reserve the quote", async () => {
    const store = new MemoryGenerationStore(1_000_000);
    const service = createService(store);

    await expect(service.submit("user-1", submission())).rejects.toMatchObject({ code: "INSUFFICIENT_CREDITS" });
    expect(store.jobs.size).toBe(0);
    expect(store.holds.size).toBe(0);
  });

  it("reserves the full batch price and rejects a changed private route before reservation", async () => {
    const store = new MemoryGenerationStore(STARTING_BALANCE);
    const batchQuote = {
      ...quote,
      quantity: 2,
      creditMicros: quote.creditMicros * 2,
      credits: "11",
      yuanMicros: quote.yuanMicros * 2,
      yuan: "0.11",
    };
    await expect(createService(store, {}, undefined, undefined, batchQuote).submit("user-1", submission({
      quantity: 2,
      expectedQuote: batchQuote,
    }))).resolves.toMatchObject({ quote: batchQuote });
    expect(store.availableCreditMicros).toBe(STARTING_BALANCE - batchQuote.creditMicros);

    const staleRouteStore = new MemoryGenerationStore(STARTING_BALANCE);
    const staleRouteService = createService(staleRouteStore, { pricingVersion: "pricing-2" });
    await expect(staleRouteService.submit("user-1", submission())).rejects.toMatchObject({ code: "QUOTE_CHANGED" });
    expect(staleRouteStore.jobs.size).toBe(0);
    expect(staleRouteStore.availableCreditMicros).toBe(STARTING_BALANCE);
  });

  it("re-quotes the three injected Midjourney fallbacks through the same versioned contract as the browser quote", async () => {
    const catalog = injectedMidjourneyCatalog();
    const quotes = new GenerationQuoteService(catalog, { now: () => NOW });
    const store = new MemoryGenerationStore(500_000_000);
    let jobSequence = 0;
    const service = new GenerationJobService(quotes, catalog, store, {
      now: () => NOW,
      createId: () => `mj-job-${++jobSequence}`,
    });

    for (const [index, modelId] of ["mj-v81", "mj-v7", "mj-niji7"].entries()) {
      const browserQuote = await quotes.createQuote({
        modelId,
        modality: "image",
        parameters: { prompt: "cinematic city" },
      });
      expect(browserQuote).toMatchObject({ quantity: 1, credits: "40", yuan: "0.4", outputCount: 4 });
      expect(browserQuote.pricingVersion).toMatch(/^content:[0-9a-f]{16}$/);
      expect(browserQuote.pricingVersion).not.toBe("unknown");

      const job = await service.submit("user-1", {
        projectId: "project-mj",
        nodeId: `node-mj-${index}`,
        modelId,
        modality: "image",
        parameters: { prompt: "cinematic city" },
        inputs: { images: [], videos: [], audios: [] },
        expectedQuote: browserQuote,
        idempotencyKey: `mj-request-000${index}`,
      });
      expect(job).toMatchObject({ status: "reserved", modelId });
      expect(job.quote.creditMicros).toBe(40_000_000);
    }
    expect(store.jobs.size).toBe(3);
    expect(store.availableCreditMicros).toBe(500_000_000 - 3 * 40_000_000);
  });

  it("rejects a repeated-call Midjourney quantity before any reservation", async () => {
    const catalog = injectedMidjourneyCatalog();
    const quotes = new GenerationQuoteService(catalog, { now: () => NOW });
    const store = new MemoryGenerationStore(STARTING_BALANCE);
    const service = new GenerationJobService(quotes, catalog, store, {
      now: () => NOW,
      createId: () => "mj-job-reject",
    });

    const browserQuote = await quotes.createQuote({
      modelId: "mj-v81",
      modality: "image",
      parameters: { prompt: "cinematic city" },
    });
    await expect(service.submit("user-1", {
      projectId: "project-mj",
      nodeId: "node-mj",
      modelId: "mj-v81",
      modality: "image",
      parameters: { prompt: "cinematic city" },
      inputs: { images: [], videos: [], audios: [] },
      expectedQuote: browserQuote,
      idempotencyKey: "mj-request-reject",
      quantity: 5,
    })).rejects.toMatchObject({ code: "OUTPUT_COUNT_UNSUPPORTED" });
    expect(store.jobs.size).toBe(0);
    expect(store.holds.size).toBe(0);
    expect(store.availableCreditMicros).toBe(STARTING_BALANCE);
  });

  it("authorizes referenced media before quoting or reserving", async () => {
    const unavailable = new MemoryGenerationStore(STARTING_BALANCE);
    await expect(createService(unavailable).submit("user-1", submission({
      inputs: { images: ["media-1"], videos: [], audios: [] },
    }))).rejects.toMatchObject({ code: "REFERENCE_VALIDATION_UNAVAILABLE" });
    expect(unavailable.jobs.size).toBe(0);

    const denied = new MemoryGenerationStore(STARTING_BALANCE);
    const deniedService = createService(denied, {}, {
      authorize: async () => ({ ok: false, code: "REFERENCE_NOT_FOUND", message: "没有找到可用的参考素材" }),
    });
    await expect(deniedService.submit("user-1", submission({
      inputs: { images: ["media-1"], videos: [], audios: [] },
    }))).rejects.toMatchObject({ code: "REFERENCE_NOT_FOUND" });
    expect(denied.jobs.size).toBe(0);

    let authorizedOwner = "";
    const allowed = new MemoryGenerationStore(STARTING_BALANCE);
    const allowedService = createService(allowed, {}, {
      authorize: async (ownerId) => {
        authorizedOwner = ownerId;
        return { ok: true };
      },
    });
    await allowedService.submit("user-1", submission({
      inputs: { images: ["media-1"], videos: [], audios: [] },
    }));
    expect(authorizedOwner).toBe("user-1");
    expect(allowed.jobs.size).toBe(1);
  });

  it("limits active jobs atomically and lists only owner-scoped work", async () => {
    const store = new MemoryGenerationStore(STARTING_BALANCE);
    const service = createService(store, {}, undefined, 1);
    await service.submit("user-1", submission());
    await expect(service.submit("user-1", submission({ idempotencyKey: "request-0002" })))
      .rejects.toMatchObject({ code: "ACTIVE_JOB_LIMIT" });

    await expect(service.list("user-1", { projectId: "project-1", limit: 10 }))
      .resolves.toMatchObject([{ id: "job-1", version: 0 }]);
    await expect(service.list("user-2", { limit: 10 })).resolves.toEqual([]);
  });

  it("surfaces the specific provider failure in the public snapshot and releases once", async () => {
    const store = new MemoryGenerationStore(STARTING_BALANCE);
    const submitted = await createService(store).submit("user-1", submission());
    const provider = new ScriptedProvider(
      { kind: "failed", code: "VIDEO_GENERATION_BALANCE_EXHAUSTED", message: "账户余额不足，请充值后重试", retryable: false },
      [],
    );
    const processor = new GenerationJobProcessor(store, provider, new ScriptedArtifactStore({ artifacts: [] }), { now: () => NOW + 1_000 });

    const failed = await processor.process(submitted.id);
    const snapshot = toPublicGenerationJob(failed);

    expect(snapshot).toMatchObject({
      status: "failed",
      error: { code: "VIDEO_GENERATION_BALANCE_EXHAUSTED", message: "账户余额不足，请充值后重试", retryable: false },
    });
    expect(store.availableCreditMicros).toBe(STARTING_BALANCE);
    expect(store.holds.size).toBe(0);
    expect(store.failReleaseCalls).toBe(1);
  });

  it("resolves one job by its idempotency identity without mutation or resubmission", async () => {
    const store = new MemoryGenerationStore(STARTING_BALANCE);
    const service = createService(store);
    const submitted = await service.submit("user-1", submission());
    const provider = new ScriptedProvider({ kind: "queued", taskId: "task-1", progress: 8 }, []);
    const processor = new GenerationJobProcessor(store, provider, new ScriptedArtifactStore({ artifacts: [] }), { now: () => NOW + 1_000 });
    await processor.process(submitted.id);

    const resolved = await service.resolveByIdempotency("user-1", "request-0001");

    expect(resolved).toMatchObject({ id: "job-1", status: "queued", version: 2 });
    expect(resolved).not.toHaveProperty("ownerId");
    expect(resolved).not.toHaveProperty("executionRoute");
    // The read-only lookup changed nothing: the same snapshot, the same hold,
    // and no provider/submit activity beyond the original single process().
    expect(store.jobs.size).toBe(1);
    expect(store.holds.size).toBe(1);
    expect(provider.submitCalls).toBe(1);
    expect(provider.pollCalls).toBe(0);
  });

  it("resolves settled snapshots exactly and exposes nothing cross-owner", async () => {
    const store = new MemoryGenerationStore(STARTING_BALANCE);
    const service = createService(store);
    const submitted = await service.submit("user-1", submission());
    const completed = await new GenerationJobProcessor(
      store,
      new ScriptedProvider({ kind: "output", resultRef: "result-1" }, []),
      new ScriptedArtifactStore({ artifacts: [imageArtifact()] }),
      { now: () => NOW + 1_000 },
    ).process(submitted.id);
    expect(completed).toMatchObject({ status: "completed" });

    const resolved = await service.resolveByIdempotency("user-1", "request-0001");
    expect(resolved).toMatchObject({ id: "job-1", status: "completed", progress: 100 });
    expect(resolved!.artifacts).toHaveLength(1);

    const failedStore = new MemoryGenerationStore(STARTING_BALANCE);
    const failedService = createService(failedStore);
    const failedSubmitted = await failedService.submit("user-1", submission({ idempotencyKey: "request-0002" }));
    await new GenerationJobProcessor(
      failedStore,
      new ScriptedProvider(new GenerationProviderError("REQUEST_REJECTED", "当前参数无法提交", "rejected"), []),
      new ScriptedArtifactStore({ artifacts: [] }),
      { now: () => NOW + 1_000 },
    ).process(failedSubmitted.id);
    await expect(failedService.resolveByIdempotency("user-1", "request-0002"))
      .resolves.toMatchObject({ status: "failed", error: { code: "REQUEST_REJECTED" } });

    // The same key under another owner is an unambiguous miss.
    await expect(service.resolveByIdempotency("user-2", "request-0001")).resolves.toBeNull();
    await expect(failedService.resolveByIdempotency("user-1", "request-9999")).resolves.toBeNull();
  });

  it("rejects unauthenticated, malformed, and oversized reconciliation keys", async () => {
    const store = new MemoryGenerationStore(STARTING_BALANCE);
    const service = createService(store);
    await service.submit("user-1", submission());

    await expect(service.resolveByIdempotency("", "request-0001")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(service.resolveByIdempotency("user-1", "")).rejects.toThrow();
    await expect(service.resolveByIdempotency("user-1", "short")).rejects.toThrow();
    await expect(service.resolveByIdempotency("user-1", "bad key")).rejects.toThrow();
    await expect(service.resolveByIdempotency("user-1", "x".repeat(129))).rejects.toThrow();
    expect(store.jobs.size).toBe(1);
    expect(store.holds.size).toBe(1);
  });
});

describe("generation job processing", () => {
  it("persists a validated asynchronous result and captures the reservation", async () => {
    const store = new MemoryGenerationStore(STARTING_BALANCE);
    const service = createService(store);
    const submitted = await service.submit("user-1", submission());
    const provider = new ScriptedProvider(
      { kind: "queued", taskId: "task-1", progress: 8 },
      [{ kind: "running", taskId: "task-1", progress: 52 }, { kind: "output", taskId: "task-1", resultRef: "result-1" }],
    );
    const artifact = imageArtifact();
    const artifacts = new ScriptedArtifactStore({ artifacts: [artifact] });
    const processor = new GenerationJobProcessor(store, provider, artifacts, { now: () => NOW + 1_000 });

    expect((await processor.process(submitted.id)).status).toBe("queued");
    expect((await processor.process(submitted.id))).toMatchObject({ status: "running", progress: 52 });
    const completed = await processor.process(submitted.id);

    expect(completed).toMatchObject({ status: "completed", progress: 100, artifacts: [artifact] });
    expect(store.capturedCreditMicros).toBe(quote.creditMicros);
    expect(store.holds.size).toBe(0);
    expect(store.availableCreditMicros).toBe(STARTING_BALANCE - quote.creditMicros);
    expect(artifacts.calls).toBe(1);
    expect(artifacts.cleanupCalls).toEqual(["result-1"]);
  });

  it("keeps the reservation and never resubmits an ambiguous request", async () => {
    const store = new MemoryGenerationStore(STARTING_BALANCE);
    const submitted = await createService(store).submit("user-1", submission());
    const provider = new ScriptedProvider(new Error("connection closed"), []);
    const processor = new GenerationJobProcessor(store, provider, new ScriptedArtifactStore({ artifacts: [] }), { now: () => NOW + 1_000 });

    const unknown = await processor.process(submitted.id);
    expect(unknown).toMatchObject({
      status: "submission_unknown",
      error: { code: "SUBMISSION_STATUS_UNKNOWN", retryable: false },
    });
    expect((await processor.process(submitted.id)).status).toBe("submission_unknown");
    expect(provider.submitCalls).toBe(1);
    expect(store.holds.size).toBe(1);
    expect(store.capturedCreditMicros).toBe(0);
  });

  it("releases the reservation after a definitive rejection", async () => {
    const store = new MemoryGenerationStore(STARTING_BALANCE);
    const submitted = await createService(store).submit("user-1", submission());
    const provider = new ScriptedProvider(
      new GenerationProviderError("REQUEST_REJECTED", "当前参数无法提交", "rejected"),
      [],
    );
    const processor = new GenerationJobProcessor(store, provider, new ScriptedArtifactStore({ artifacts: [] }), { now: () => NOW + 1_000 });

    expect(await processor.process(submitted.id)).toMatchObject({ status: "failed", error: { code: "REQUEST_REJECTED" } });
    expect(store.availableCreditMicros).toBe(STARTING_BALANCE);
    expect(store.holds.size).toBe(0);
  });

  it("releases the reservation when returned media fails validation", async () => {
    const store = new MemoryGenerationStore(STARTING_BALANCE);
    const submitted = await createService(store).submit("user-1", submission());
    const provider = new ScriptedProvider({ kind: "output", resultRef: "bad-result" }, []);
    const artifacts = new ScriptedArtifactStore(new GenerationArtifactError("MEDIA_INVALID", "生成结果无法读取"));
    const processor = new GenerationJobProcessor(store, provider, artifacts, { now: () => NOW + 1_000 });

    expect(await processor.process(submitted.id)).toMatchObject({ status: "failed", error: { code: "MEDIA_INVALID" } });
    expect(store.availableCreditMicros).toBe(STARTING_BALANCE);
    expect(store.holds.size).toBe(0);
    expect(artifacts.cleanupCalls).toEqual(["bad-result"]);
  });

  it("keeps a validating job reserved when media persistence is temporarily unavailable", async () => {
    const store = new MemoryGenerationStore(STARTING_BALANCE);
    const submitted = await createService(store).submit("user-1", submission());
    const provider = new ScriptedProvider({ kind: "output", resultRef: "result-1" }, []);
    const artifacts = new ScriptedArtifactStore(new Error("storage unavailable"));
    const processor = new GenerationJobProcessor(
      store,
      provider,
      artifacts,
      { now: () => NOW + 1_000 },
    );

    await expect(processor.process(submitted.id)).rejects.toThrow("storage unavailable");
    expect((await store.getById(submitted.id))?.status).toBe("validating");
    expect(store.holds.size).toBe(1);
    expect(store.availableCreditMicros).toBe(STARTING_BALANCE - quote.creditMicros);
    expect(artifacts.cleanupCalls).toEqual([]);
  });

  it("does not roll back a settled task when staged-result cleanup fails", async () => {
    const store = new MemoryGenerationStore(STARTING_BALANCE);
    const submitted = await createService(store).submit("user-1", submission());
    const provider = new ScriptedProvider({ kind: "output", resultRef: "result-1" }, []);
    const artifacts = new ScriptedArtifactStore({ artifacts: [imageArtifact()] });
    artifacts.cleanupError = new Error("cleanup unavailable");
    const cleanupErrors: unknown[] = [];
    const processor = new GenerationJobProcessor(store, provider, artifacts, {
      now: () => NOW + 1_000,
      onCleanupError: (error) => cleanupErrors.push(error),
    });

    await expect(processor.process(submitted.id)).resolves.toMatchObject({ status: "completed" });
    expect(cleanupErrors).toEqual([artifacts.cleanupError]);
    expect(store.capturedCreditMicros).toBe(quote.creditMicros);
  });

  it("refuses to settle empty or mismatched artifacts", async () => {
    const emptyStore = new MemoryGenerationStore(STARTING_BALANCE);
    const emptyJob = await createService(emptyStore).submit("user-1", submission());
    const emptyProcessor = new GenerationJobProcessor(
      emptyStore,
      new ScriptedProvider({ kind: "output", resultRef: "empty-result" }, []),
      new ScriptedArtifactStore({ artifacts: [] }),
      { now: () => NOW + 1_000 },
    );
    expect(await emptyProcessor.process(emptyJob.id)).toMatchObject({ status: "failed", error: { code: "RESULT_EMPTY" } });

    const mismatchStore = new MemoryGenerationStore(STARTING_BALANCE);
    const mismatchJob = await createService(mismatchStore).submit("user-1", submission());
    const mismatchProcessor = new GenerationJobProcessor(
      mismatchStore,
      new ScriptedProvider({ kind: "output", resultRef: "text-result" }, []),
      new ScriptedArtifactStore({ artifacts: [{ id: "text-1", kind: "text", text: "result", createdAt: new Date(NOW).toISOString() }] }),
      { now: () => NOW + 1_000 },
    );
    expect(await mismatchProcessor.process(mismatchJob.id)).toMatchObject({ status: "failed", error: { code: "RESULT_TYPE_MISMATCH" } });
    expect(emptyStore.availableCreditMicros).toBe(STARTING_BALANCE);
    expect(mismatchStore.availableCreditMicros).toBe(STARTING_BALANCE);
  });

  it("leaves a queued task untouched when polling has a temporary failure", async () => {
    const store = new MemoryGenerationStore(STARTING_BALANCE);
    const submitted = await createService(store).submit("user-1", submission());
    const provider = new ScriptedProvider(
      { kind: "queued", taskId: "task-1" },
      [new GenerationProviderError("TEMPORARY", "暂时无法获取进度", "transient")],
    );
    const processor = new GenerationJobProcessor(store, provider, new ScriptedArtifactStore({ artifacts: [] }), { now: () => NOW + 1_000 });

    await processor.process(submitted.id);
    await expect(processor.process(submitted.id)).rejects.toMatchObject({ code: "TEMPORARY", outcome: "transient" });
    expect((await store.getById(submitted.id))?.status).toBe("queued");
    expect(store.holds.size).toBe(1);
  });

  it("rejects transitions out of terminal states", async () => {
    const store = new MemoryGenerationStore(STARTING_BALANCE);
    const submitted = await createService(store).submit("user-1", submission());
    const record = (await store.getById(submitted.id))!;
    const failed = transitionGenerationJob(record, {
      type: "failed",
      error: { code: "TEST", message: "test", retryable: false },
    }, NOW + 1_000);

    expect(() => transitionGenerationJob(failed, { type: "submission_started" }, NOW + 2_000)).toThrow(InvalidGenerationTransitionError);
  });
});

function createService(
  store: GenerationJobStore,
  routeVersions: { catalogVersion?: string; capabilityVersion?: string; pricingVersion?: string } = {},
  inputAuthorizer?: GenerationInputAuthorizer,
  maxActiveJobs?: number,
  currentQuote: GenerationQuote = quote,
) {
  return new GenerationJobService(
    { createQuote: async () => structuredClone(currentQuote) },
    { getExecutionRoute: async () => ({
      route: structuredClone(executionRoute),
      pricing: {
        mode: "fixed" as const,
        unit: "image" as const,
        currency: "CNY" as const,
        creditsPerYuan: 100,
        baseCreditMicros: quote.creditMicros,
        baseYuanMicros: quote.yuanMicros,
        tiers: [],
      },
      catalogVersion: routeVersions.catalogVersion ?? quote.catalogVersion,
      capabilityVersion: routeVersions.capabilityVersion ?? quote.capabilityVersion,
      pricingVersion: routeVersions.pricingVersion ?? quote.pricingVersion,
    }) },
    store,
    {
      now: () => NOW,
      createId: () => "job-1",
      ...(inputAuthorizer ? { inputAuthorizer } : {}),
      ...(maxActiveJobs ? { maxActiveJobs } : {}),
    },
  );
}

function injectedMidjourneyCatalog() {
  return new KachangCatalogAdapter({
    sourceUrl: "https://catalog.test/models",
    store: new MemoryCatalogSnapshotStore(),
    now: () => NOW,
    includeKnownModels: true,
    fetch: async () => new Response(JSON.stringify({
      success: true,
      version: "catalog-mj",
      capability_version: "capability-mj",
      pricing_version: "",
      fetched_at: new Date(NOW).toISOString(),
      credits_per_yuan: 100,
      models: [],
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
  });
}

function submission(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "project-1",
    nodeId: "node-1",
    modelId: "image2",
    modality: "image",
    parameters: { prompt: "雨夜街道", size: "16:9" },
    inputs: { images: [], videos: [], audios: [] },
    expectedQuote: quote,
    idempotencyKey: "request-0001",
    ...overrides,
  };
}

function imageArtifact(): GenerationArtifact {
  return {
    id: "artifact-1",
    kind: "image",
    mediaId: "media-1",
    name: "result.png",
    mimeType: "image/png",
    size: 1024,
    width: 1024,
    height: 1024,
    createdAt: new Date(NOW + 1_000).toISOString(),
  };
}

class ScriptedProvider implements GenerationProvider {
  submitCalls = 0;
  pollCalls = 0;

  constructor(
    private readonly submitState: ProviderExecutionState | Error,
    private readonly pollStates: Array<ProviderExecutionState | Error>,
  ) {}

  async submit() {
    this.submitCalls += 1;
    if (this.submitState instanceof Error) throw this.submitState;
    return structuredClone(this.submitState);
  }

  async poll() {
    this.pollCalls += 1;
    const state = this.pollStates.shift();
    if (!state) throw new Error("No scripted poll state");
    if (state instanceof Error) throw state;
    return structuredClone(state);
  }
}

class ScriptedArtifactStore implements GenerationArtifactStore {
  calls = 0;
  cleanupCalls: string[] = [];
  cleanupError: Error | null = null;

  constructor(private readonly result: PersistedGenerationResult | Error) {}

  async persist() {
    this.calls += 1;
    if (this.result instanceof Error) throw this.result;
    return structuredClone(this.result);
  }

  async cleanup(resultRef: string) {
    this.cleanupCalls.push(resultRef);
    if (this.cleanupError) throw this.cleanupError;
  }
}

class MemoryGenerationStore implements GenerationJobStore {
  readonly jobs = new Map<string, GenerationJobRecord>();
  readonly holds = new Map<string, number>();
  availableCreditMicros: number;
  capturedCreditMicros = 0;
  failReleaseCalls = 0;

  constructor(balance: number) {
    this.availableCreditMicros = balance;
  }

  async findByIdempotency(ownerId: string, idempotencyKey: string) {
    const job = [...this.jobs.values()].find((item) => item.ownerId === ownerId && item.idempotencyKey === idempotencyKey);
    return clone(job ?? null);
  }

  async getById(jobId: string) {
    return clone(this.jobs.get(jobId) ?? null);
  }

  async listByOwner(ownerId: string, options: { projectId?: string; limit: number }) {
    return [...this.jobs.values()]
      .filter((job) => job.ownerId === ownerId && (!options.projectId || job.projectId === options.projectId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))
      .slice(0, options.limit)
      .map(clone);
  }

  async createWithReservation(
    job: GenerationJobRecord,
    creditMicros: number,
    options: { maxActiveJobs: number },
  ): Promise<CreateReservedJobResult> {
    const existing = [...this.jobs.values()].find((item) => item.ownerId === job.ownerId && item.idempotencyKey === job.idempotencyKey);
    if (existing) return { kind: "existing", job: clone(existing) };
    const active = [...this.jobs.values()].filter((item) => item.ownerId === job.ownerId
      && !["completed", "failed"].includes(item.status)).length;
    if (active >= options.maxActiveJobs) return { kind: "active_limit" };
    if (this.availableCreditMicros < creditMicros) return { kind: "insufficient_credits" };
    this.availableCreditMicros -= creditMicros;
    this.holds.set(job.reservationId, creditMicros);
    this.jobs.set(job.id, clone(job));
    return { kind: "created", job: clone(job) };
  }

  async save(job: GenerationJobRecord, expectedRevision: number) {
    const current = this.jobs.get(job.id);
    if (!current || current.revision !== expectedRevision || job.revision !== expectedRevision + 1) return null;
    this.jobs.set(job.id, clone(job));
    return clone(job);
  }

  async completeWithCapture(job: GenerationJobRecord, expectedRevision: number, creditMicros: number) {
    const current = this.jobs.get(job.id);
    const hold = this.holds.get(job.reservationId);
    if (!current || current.revision !== expectedRevision || job.revision !== expectedRevision + 1 || hold === undefined || creditMicros > hold) return null;
    this.holds.delete(job.reservationId);
    this.availableCreditMicros += hold - creditMicros;
    this.capturedCreditMicros += creditMicros;
    this.jobs.set(job.id, clone(job));
    return clone(job);
  }

  async failWithRelease(job: GenerationJobRecord, expectedRevision: number) {
    this.failReleaseCalls += 1;
    const current = this.jobs.get(job.id);
    const hold = this.holds.get(job.reservationId);
    if (!current || current.revision !== expectedRevision || job.revision !== expectedRevision + 1 || hold === undefined) return null;
    this.holds.delete(job.reservationId);
    this.availableCreditMicros += hold;
    this.jobs.set(job.id, clone(job));
    return clone(job);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("native image lifetime", () => {
  async function queueImageJob(store: MemoryGenerationStore) {
    const submitted = await createService(store).submit("user-1", submission());
    await new GenerationJobProcessor(
      store,
      new ScriptedProvider({ kind: "queued", taskId: "task-1", progress: 8 }, []),
      new ScriptedArtifactStore({ artifacts: [] }),
      { now: () => NOW },
    ).process(submitted.id);
    return submitted.id;
  }

  it("converges an over-budget image task to a retryable timeout without polling", async () => {
    const store = new MemoryGenerationStore(STARTING_BALANCE);
    const jobId = await queueImageJob(store);
    const provider = new ScriptedProvider({ kind: "queued", taskId: "task-1", progress: 8 }, []);

    const failed = await new GenerationJobProcessor(
      store,
      provider,
      new ScriptedArtifactStore({ artifacts: [] }),
      { now: () => NOW + 11 * 60_000 },
    ).process(jobId);

    expect(toPublicGenerationJob(failed)).toMatchObject({
      status: "failed",
      error: { code: "GENERATION_TIMEOUT", retryable: true },
    });
    expect(provider.pollCalls).toBe(0);
    expect(store.availableCreditMicros).toBe(STARTING_BALANCE);
    expect(store.holds.size).toBe(0);
  });

  it("honors a custom image lifetime", async () => {
    const store = new MemoryGenerationStore(STARTING_BALANCE);
    const jobId = await queueImageJob(store);

    const failed = await new GenerationJobProcessor(
      store,
      new ScriptedProvider({ kind: "queued", taskId: "task-1", progress: 8 }, []),
      new ScriptedArtifactStore({ artifacts: [] }),
      { now: () => NOW + 61_000, imageLifetimeMs: 60_000 },
    ).process(jobId);

    expect(toPublicGenerationJob(failed).status).toBe("failed");
  });

  it("keeps an over-budget video task polling", async () => {
    const store = new MemoryGenerationStore(STARTING_BALANCE);
    const jobId = await queueImageJob(store);
    // The lifetime bound is image-only; flip the stored modality so the same
    // elapsed budget must leave a video task untouched.
    const stored = store.jobs.get(jobId)!;
    store.jobs.set(jobId, { ...stored, modality: "video" });
    const provider = new ScriptedProvider(
      { kind: "queued", taskId: "task-1", progress: 8 },
      [{ kind: "running", taskId: "task-1", progress: 30 }],
    );

    const next = await new GenerationJobProcessor(
      store,
      provider,
      new ScriptedArtifactStore({ artifacts: [] }),
      { now: () => NOW + 11 * 60_000 },
    ).process(jobId);

    expect(toPublicGenerationJob(next).status).toBe("running");
    expect(provider.pollCalls).toBe(1);
  });
});
