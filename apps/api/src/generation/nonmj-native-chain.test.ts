import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import type { PublicMedia } from "@kachang/contracts";

import { KachangCatalogAdapter } from "../catalog/adapter.js";
import { NON_MJ_NOW_ISO, buildNonMjSourceCatalog } from "../catalog/nonmj-catalog-fixture.js";
import { GenerationQuoteService } from "../catalog/quote.js";
import { MemoryCatalogSnapshotStore } from "../catalog/store.js";
import { ValidatedGenerationArtifactStore } from "./artifact-store.js";
import {
  KachangGenerationProvider,
  type GenerationReferenceResolver,
} from "./kachang-provider.js";
import {
  GenerationJobProcessor,
  GenerationJobService,
} from "./service.js";
import {
  stagedGenerationResultSchema,
  type GenerationResultStagingStore,
  type StagedGenerationRecord,
  type StagedGenerationResult,
} from "./result-staging.js";
import type { MaterializedGenerationMedia } from "./result-materializer.js";
import {
  type CreateReservedJobResult,
  type GenerationJobRecord,
  type GenerationJobStore,
} from "./types.js";

const NOW = Date.parse(NON_MJ_NOW_ISO);
const STARTING_BALANCE = 500_000_000;
const IMAGE_BYTES = Buffer.from("generated-image");

function createAdapter() {
  return new KachangCatalogAdapter({
    sourceUrl: "https://catalog.test/models",
    store: new MemoryCatalogSnapshotStore(),
    now: () => NOW,
    includeKnownModels: true,
    fetch: async () => new Response(JSON.stringify(buildNonMjSourceCatalog()), {
      status: 200,
      headers: { "Content-Type": "application/json", ETag: '"nonmj-1"' },
    }),
  });
}

type NetworkCall = { method: string; path: string; body: Record<string, unknown> | null };

class ScriptedNetwork {
  readonly calls: NetworkCall[] = [];
  private readonly responses: Array<{ path: RegExp | string; method: string; status: number; body: unknown; consumed: boolean }> = [];

  on(path: RegExp | string, method: string, status: number, body: unknown) {
    this.responses.push({ path, method, status, body, consumed: false });
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    this.calls.push({ method: init?.method ?? "GET", path: url.pathname, body });
    const method = init?.method ?? "GET";
    const match = this.responses.find((candidate) => {
      if (candidate.consumed || candidate.method !== method) return false;
      return candidate.path instanceof RegExp ? candidate.path.test(url.pathname) : candidate.path === url.pathname;
    });
    if (!match) throw new Error(`No scripted response for ${method} ${url.pathname}`);
    match.consumed = true;
    return new Response(JSON.stringify(match.body), {
      status: match.status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

class MemoryStagingStore implements GenerationResultStagingStore {
  private readonly records = new Map<string, StagedGenerationRecord>();
  private sequence = 0;

  async write(jobId: string, value: StagedGenerationResult) {
    const id = `result_${String(++this.sequence).padStart(4, "0")}`;
    const reference = `generation-result:${id}`;
    this.records.set(reference, {
      version: 1,
      id,
      jobId,
      result: stagedGenerationResultSchema.parse(value),
      createdAt: NON_MJ_NOW_ISO,
    });
    return reference;
  }

  async read(reference: string) {
    const record = this.records.get(reference);
    if (!record) throw new Error("missing staged result");
    return structuredClone(record);
  }

  async remove(reference: string) {
    this.records.delete(reference);
  }
}

class MapReferenceResolver implements GenerationReferenceResolver {
  constructor(private readonly values: Record<string, string>) {}

  async resolve(input: { ownerId: string; mediaId: string; kind: "image" | "video" | "audio"; format?: string }) {
    const value = this.values[input.mediaId];
    if (!value) throw new Error(`Missing media ${input.mediaId}`);
    return value;
  }
}

class MemoryGenerationStore implements GenerationJobStore {
  readonly jobs = new Map<string, GenerationJobRecord>();
  readonly holds = new Map<string, number>();
  availableCreditMicros: number;
  capturedCreditMicros = 0;

  constructor(balance: number) {
    this.availableCreditMicros = balance;
  }

  async findByIdempotency(ownerId: string, idempotencyKey: string) {
    const job = [...this.jobs.values()].find((item) => item.ownerId === ownerId && item.idempotencyKey === idempotencyKey);
    return structuredClone(job ?? null);
  }

  async getById(jobId: string) {
    return structuredClone(this.jobs.get(jobId) ?? null);
  }

  async listByOwner(ownerId: string, options: { projectId?: string; limit: number }) {
    return [...this.jobs.values()]
      .filter((job) => job.ownerId === ownerId && (!options.projectId || job.projectId === options.projectId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, options.limit)
      .map((job) => structuredClone(job));
  }

  async createWithReservation(job: GenerationJobRecord, creditMicros: number, options: { maxActiveJobs: number }): Promise<CreateReservedJobResult> {
    const existing = [...this.jobs.values()].find((item) => item.ownerId === job.ownerId && item.idempotencyKey === job.idempotencyKey);
    if (existing) return { kind: "existing", job: structuredClone(existing) };
    const active = [...this.jobs.values()].filter((item) => item.ownerId === job.ownerId && !["completed", "failed"].includes(item.status)).length;
    if (active >= options.maxActiveJobs) return { kind: "active_limit" };
    if (this.availableCreditMicros < creditMicros) return { kind: "insufficient_credits" };
    this.availableCreditMicros -= creditMicros;
    this.holds.set(job.reservationId, creditMicros);
    this.jobs.set(job.id, structuredClone(job));
    return { kind: "created", job: structuredClone(job) };
  }

  async save(job: GenerationJobRecord, expectedRevision: number) {
    const current = this.jobs.get(job.id);
    if (!current || current.revision !== expectedRevision || job.revision !== expectedRevision + 1) return null;
    this.jobs.set(job.id, structuredClone(job));
    return structuredClone(job);
  }

  async completeWithCapture(job: GenerationJobRecord, expectedRevision: number, creditMicros: number) {
    const current = this.jobs.get(job.id);
    const hold = this.holds.get(job.reservationId);
    if (!current || current.revision !== expectedRevision || job.revision !== expectedRevision + 1 || hold === undefined || creditMicros > hold) return null;
    this.holds.delete(job.reservationId);
    this.availableCreditMicros += hold - creditMicros;
    this.capturedCreditMicros += creditMicros;
    this.jobs.set(job.id, structuredClone(job));
    return structuredClone(job);
  }

  async failWithRelease(job: GenerationJobRecord, expectedRevision: number) {
    const current = this.jobs.get(job.id);
    const hold = this.holds.get(job.reservationId);
    if (!current || current.revision !== expectedRevision || job.revision !== expectedRevision + 1 || hold === undefined) return null;
    this.holds.delete(job.reservationId);
    this.availableCreditMicros += hold;
    this.jobs.set(job.id, structuredClone(job));
    return structuredClone(job);
  }
}

function createProvider(network: ScriptedNetwork, staging: GenerationResultStagingStore, references: GenerationReferenceResolver = new MapReferenceResolver({})) {
  return new KachangGenerationProvider({
    baseUrl: "https://provider.test",
    apiKey: "server-secret",
    staging,
    references,
    fetch: network.fetch,
    allowInsecureHttp: false,
  });
}

function readyMedia(kind: "image" | "video"): PublicMedia {
  return {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    kind,
    name: `鐢熸垚缁撴灉.${kind === "image" ? "png" : "mp4"}`,
    mimeType: kind === "image" ? "image/png" : "video/mp4",
    size: IMAGE_BYTES.length,
    sha256: createHash("sha256").update(IMAGE_BYTES).digest("hex"),
    width: 64,
    height: 36,
    durationMs: kind === "image" ? null : 1_000,
    status: "ready",
    error: null,
    createdAt: NON_MJ_NOW_ISO,
    updatedAt: NON_MJ_NOW_ISO,
  };
}

function createdMedia(kind: "image" | "video"): MaterializedGenerationMedia {
  return {
    path: "memory://generated",
    size: IMAGE_BYTES.length,
    sha256: createHash("sha256").update(IMAGE_BYTES).digest("hex"),
    inspected: {
      kind,
      mimeType: kind === "image" ? "image/png" : "video/mp4",
      size: IMAGE_BYTES.length,
      width: 64,
      height: 36,
      durationMs: kind === "image" ? null : 1_000,
    },
    open: () => Readable.from(IMAGE_BYTES),
    remove: async () => undefined,
  };
}

function artifactStore(staging: GenerationResultStagingStore) {
  const materializer = { materialize: async (_source: unknown, kind: "image" | "video") => createdMedia(kind) };
  const media = {
    persistGenerated: async (_ownerId: string, input: { kind: "image" | "video" }) => readyMedia(input.kind),
  };
  return new ValidatedGenerationArtifactStore(staging, materializer, media);
}

type SubmissionOptions = {
  modelId: string;
  modality: "image" | "video";
  parameters: Record<string, unknown>;
  inputs?: { images: string[]; styleImages?: string[]; elementImages?: string[]; videos: string[]; audios: string[] };
};

async function submitJob(service: GenerationJobService, quotes: GenerationQuoteService, options: SubmissionOptions, key: string) {
  const quote = await quotes.createQuote({
    modelId: options.modelId,
    modality: options.modality,
    parameters: options.parameters,
    inputs: {
      images: options.inputs?.images.length ?? 0,
      styleImages: options.inputs?.styleImages?.length ?? 0,
      elementImages: options.inputs?.elementImages?.length ?? 0,
      videos: options.inputs?.videos.length ?? 0,
      audios: options.inputs?.audios.length ?? 0,
    },
    quantity: 1,
  });
  return service.submit("user-1", {
    projectId: "project-1",
    nodeId: "node-1",
    modelId: options.modelId,
    modality: options.modality,
    parameters: options.parameters,
    inputs: options.inputs ?? { images: [], videos: [], audios: [] },
    quantity: 1,
    expectedQuote: {
      id: quote.id,
      modelId: quote.modelId,
      creditMicros: quote.creditMicros,
      pricingVersion: quote.pricingVersion,
      expiresAt: quote.expiresAt,
    },
    idempotencyKey: key,
  });
}

describe("non-MJ native full-chain: reservation, provider body, capture and refund", () => {
  it("image2-A runs its async image task and captures the single reservation", async () => {
    const adapter = createAdapter();
    const quotes = new GenerationQuoteService(adapter, { now: () => NOW });
    const store = new MemoryGenerationStore(STARTING_BALANCE);
    const service = new GenerationJobService(quotes, adapter, store, {
      now: () => NOW,
      createId: () => "native-image2a-1",
      inputAuthorizer: { authorize: async () => ({ ok: true as const }) },
    });
    const network = new ScriptedNetwork();
    network.on(/^\/v1\/videos$/, "POST", 200, { id: "image-task-1", status: "queued", progress: 3 });
    network.on(/^\/v1\/videos\/image-task-1$/, "GET", 200, { id: "image-task-1", status: "running", progress: 48 });
    network.on(/^\/v1\/videos\/image-task-1$/, "GET", 200, { id: "image-task-1", status: "completed", url: "https://media.example/image2-a.png" });
    const staging = new MemoryStagingStore();
    const provider = createProvider(network, staging);
    const artifacts = artifactStore(staging);
    const processor = new GenerationJobProcessor(store, provider, artifacts, { now: () => NOW + 1_000 });

    const job = await submitJob(service, quotes, {
      modelId: "image2-A",
      modality: "image",
      parameters: { prompt: "product photo", resolution: "4k", quality: "high", n: 1 },
    }, "native-image2a-key");
    expect(job.status).toBe("reserved");
    expect(job.quote.creditMicros).toBe(2_500_000);
    expect([...store.holds.values()]).toEqual([2_500_000]);

    expect((await processor.process(job.id)).status).toBe("queued");
    const running = await processor.process(job.id);
    expect(running).toMatchObject({ status: "running", progress: 48, providerTaskId: "image-videos:image-task-1" });
    const completed = await processor.process(job.id);
    expect(completed).toMatchObject({ status: "completed", progress: 100 });
    expect(completed.artifacts).toHaveLength(1);
    expect(completed.artifacts[0]!.kind).toBe("image");

    // One async POST, one image-videos poll per poll call, one capture.
    expect(network.calls.filter((call) => call.path === "/v1/videos" && call.method === "POST")).toHaveLength(1);
    expect(network.calls[0]?.body).toMatchObject({
      model: "image2-A",
      prompt: "product photo",
      resolution: "4k",
      quality: "high",
      n: 1,
    });
    expect(store.capturedCreditMicros).toBe(2_500_000);
    expect(store.holds.size).toBe(0);
    expect(store.availableCreditMicros).toBe(STARTING_BALANCE - 2_500_000);
  });

  it("a synchronous image model stages and captures its result without a second call", async () => {
    const adapter = createAdapter();
    const quotes = new GenerationQuoteService(adapter, { now: () => NOW });
    const store = new MemoryGenerationStore(STARTING_BALANCE);
    const service = new GenerationJobService(quotes, adapter, store, {
      now: () => NOW,
      createId: () => "native-sync-image-1",
      inputAuthorizer: { authorize: async () => ({ ok: true as const }) },
    });
    const network = new ScriptedNetwork();
    network.on(/^\/v1\/images\/generations$/, "POST", 200, { data: [{ url: "https://media.example/result.png" }] });
    const staging = new MemoryStagingStore();
    const provider = createProvider(network, staging, new MapReferenceResolver({
      "ref-image-1": "https://media.example/reference-1.png",
    }));
    const artifacts = artifactStore(staging);
    const processor = new GenerationJobProcessor(store, provider, artifacts, { now: () => NOW + 1_000 });

    const job = await submitJob(service, quotes, {
      modelId: "nano-banana",
      modality: "image",
      parameters: { prompt: "鍩庡競澶滄櫙", resolution: "4k", n: 1 },
      inputs: { images: ["ref-image-1"], videos: [], audios: [] },
    }, "native-sync-image-key");

    const completed = await processor.process(job.id);
    expect(completed).toMatchObject({ status: "completed", progress: 100 });
    expect(completed.artifacts).toHaveLength(1);
    expect(network.calls).toHaveLength(1);
    expect(network.calls[0]?.body).toMatchObject({
      model: "nano-banana",
      prompt: "鍩庡競澶滄櫙",
      resolution: "4k",
      n: 1,
      images: ["https://media.example/reference-1.png"],
    });
    expect(store.capturedCreditMicros).toBe(job.quote.creditMicros);
    expect(store.holds.size).toBe(0);
  });

  it("an async video model completes and captures exactly once", async () => {
    const adapter = createAdapter();
    const quotes = new GenerationQuoteService(adapter, { now: () => NOW });
    const store = new MemoryGenerationStore(STARTING_BALANCE);
    const service = new GenerationJobService(quotes, adapter, store, {
      now: () => NOW,
      createId: () => "native-video-1",
      inputAuthorizer: { authorize: async () => ({ ok: true as const }) },
    });
    const network = new ScriptedNetwork();
    network.on(/^\/v1\/videos$/, "POST", 200, { id: "task-1", status: "queued", progress: 2 });
    network.on(/^\/v1\/videos\/task-1$/, "GET", 200, { id: "task-1", status: "running", progress: 46 });
    network.on(/^\/v1\/videos\/task-1$/, "GET", 200, { id: "task-1", status: "completed", progress: 100, content: { video_url: "https://media.example/result.mp4" } });
    const staging = new MemoryStagingStore();
    const provider = createProvider(network, staging);
    const processor = new GenerationJobProcessor(store, provider, artifactStore(staging), { now: () => NOW + 1_000 });

    const job = await submitJob(service, quotes, {
      modelId: "kling-o3-pro-v2v-reference",
      modality: "video",
      parameters: { prompt: "浜虹墿杞韩", seconds: 5 },
    }, "native-video-key");

    expect((await processor.process(job.id)).status).toBe("queued");
    expect((await processor.process(job.id)).status).toBe("running");
    const completed = await processor.process(job.id);
    expect(completed).toMatchObject({ status: "completed", progress: 100 });
    expect(completed.artifacts).toHaveLength(1);
    expect(completed.artifacts[0]!.kind).toBe("video");
    expect(store.capturedCreditMicros).toBe(job.quote.creditMicros);
    expect(store.holds.size).toBe(0);
  });

  it("refunds the reservation when a vendor definitively rejects the submission", async () => {
    const adapter = createAdapter();
    const quotes = new GenerationQuoteService(adapter, { now: () => NOW });
    const store = new MemoryGenerationStore(STARTING_BALANCE);
    const service = new GenerationJobService(quotes, adapter, store, {
      now: () => NOW,
      createId: () => "native-refund-1",
      inputAuthorizer: { authorize: async () => ({ ok: true as const }) },
    });
    const network = new ScriptedNetwork();
    network.on(/^\/v1\/images\/generations$/, "POST", 400, { error: { code: "VALIDATION_ERROR", message: "invalid parameter" } });
    const staging = new MemoryStagingStore();
    const processor = new GenerationJobProcessor(store, createProvider(network, staging), artifactStore(staging), { now: () => NOW + 1_000 });

    const job = await submitJob(service, quotes, {
      modelId: "grok-imagine-image",
      modality: "image",
      parameters: { prompt: "鍩庡競澶滄櫙", quality: "high" },
    }, "native-refund-key");

    const failed = await processor.process(job.id);
    expect(failed).toMatchObject({ status: "failed", error: { code: "GENERATION_REQUEST_FAILED" } });
    expect(store.holds.size).toBe(0);
    expect(store.capturedCreditMicros).toBe(0);
    expect(store.availableCreditMicros).toBe(STARTING_BALANCE);
  });

  it("is idempotent: one idempotency key reserves once and never duplicates", async () => {
    const adapter = createAdapter();
    const quotes = new GenerationQuoteService(adapter, { now: () => NOW });
    const store = new MemoryGenerationStore(STARTING_BALANCE);
    const service = new GenerationJobService(quotes, adapter, store, {
      now: () => NOW,
      createId: () => "native-idem-1",
      inputAuthorizer: { authorize: async () => ({ ok: true as const }) },
    });
    const first = await submitJob(service, quotes, {
      modelId: "nano-banana",
      modality: "image",
      parameters: { prompt: "鍩庡競澶滄櫙" },
    }, "native-idem-key");
    const replay = await submitJob(service, quotes, {
      modelId: "nano-banana",
      modality: "image",
      parameters: { prompt: "鍩庡競澶滄櫙" },
    }, "native-idem-key");
    expect(replay.id).toBe(first.id);
    expect(store.jobs.size).toBe(1);
    expect(store.holds.size).toBe(1);
  });

  it("keeps independent nodes isolated when one model fails", async () => {
    const adapter = createAdapter();
    const quotes = new GenerationQuoteService(adapter, { now: () => NOW });
    const store = new MemoryGenerationStore(STARTING_BALANCE);
    let jobSequence = 0;
    const service = new GenerationJobService(quotes, adapter, store, {
      now: () => NOW,
      createId: () => `native-conc-${++jobSequence}`,
      inputAuthorizer: { authorize: async () => ({ ok: true as const }) },
    });

    const failing = await service.submit("user-1", {
      projectId: "project-1",
      nodeId: "node-fail",
      modelId: "grok-imagine-image",
      modality: "image",
      parameters: { prompt: "鍩庡競澶滄櫙" },
      inputs: { images: [], videos: [], audios: [] },
      quantity: 1,
      expectedQuote: (await quotes.createQuote({
        modelId: "grok-imagine-image",
        modality: "image",
        parameters: { prompt: "鍩庡競澶滄櫙" },
        inputs: { images: 0, styleImages: 0, elementImages: 0, videos: 0, audios: 0 },
        quantity: 1,
      })),
      idempotencyKey: "native-conc-fail",
    });
    const okJob = await service.submit("user-1", {
      projectId: "project-1",
      nodeId: "node-ok",
      modelId: "nano-banana",
      modality: "image",
      parameters: { prompt: "鍩庡競澶滄櫙" },
      inputs: { images: [], videos: [], audios: [] },
      quantity: 1,
      expectedQuote: (await quotes.createQuote({
        modelId: "nano-banana",
        modality: "image",
        parameters: { prompt: "鍩庡競澶滄櫙" },
        inputs: { images: 0, styleImages: 0, elementImages: 0, videos: 0, audios: 0 },
        quantity: 1,
      })),
      idempotencyKey: "native-conc-ok",
    });

    const network = new ScriptedNetwork();
    network.on(/^\/v1\/images\/generations$/, "POST", 200, { data: [{ url: "https://media.example/ok.png" }] });
    const failingNetwork = new ScriptedNetwork();
    failingNetwork.on(/^\/v1\/images\/generations$/, "POST", 400, { error: { code: "VALIDATION_ERROR", message: "invalid" } });

    const failingStaging = new MemoryStagingStore();
    const okStaging = new MemoryStagingStore();
    const failingProcessor = new GenerationJobProcessor(store, createProvider(failingNetwork, failingStaging), artifactStore(failingStaging), { now: () => NOW + 1_000 });
    const okProcessor = new GenerationJobProcessor(store, createProvider(network, okStaging), artifactStore(okStaging), { now: () => NOW + 1_000 });

    const failedJob = await failingProcessor.process(failing.id);
    expect(failedJob).toMatchObject({ status: "failed", error: { code: "GENERATION_REQUEST_FAILED" } });
    const completedJob = await okProcessor.process(okJob.id);
    expect(completedJob).toMatchObject({ status: "completed", progress: 100 });
    expect(completedJob.artifacts).toHaveLength(1);
    expect(store.capturedCreditMicros).toBe(okJob.quote.creditMicros);
    expect([...store.holds.values()]).toEqual([]);
  });
});
