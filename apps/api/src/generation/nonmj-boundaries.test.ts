import { describe, expect, it } from "vitest";

import type { MediaKind, PublicMedia } from "@kachang/contracts";

import { KachangCatalogAdapter } from "../catalog/adapter.js";
import { NON_MJ_NOW_ISO, buildNonMjSourceCatalog } from "../catalog/nonmj-catalog-fixture.js";
import { GenerationQuoteService } from "../catalog/quote.js";
import { MemoryCatalogSnapshotStore } from "../catalog/store.js";
import {
  MemoryPromptHubGenerationStore,
  MemoryPromptHubReferenceStore,
  PromptHubGenerationService,
} from "./prompt-hub-service.js";

const NOW = Date.parse(NON_MJ_NOW_ISO);
const NOW_ISO = NON_MJ_NOW_ISO;

function createAdapter(payload: unknown = buildNonMjSourceCatalog()) {
  return new KachangCatalogAdapter({
    sourceUrl: "https://catalog.test/models",
    store: new MemoryCatalogSnapshotStore(),
    now: () => NOW,
    includeKnownModels: true,
    fetch: async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json", ETag: '"boundary-1"' },
    }),
  });
}

type UpstreamCall = { method: string; path: string; body: Record<string, unknown> | null };

function createHostedHarness(options: {
  fetch: (url: URL, init: RequestInit | undefined) => Promise<Response>;
  store?: MemoryPromptHubGenerationStore;
  now?: () => number;
}) {
  const adapter = createAdapter();
  const quotes = new GenerationQuoteService(adapter, { now: () => NOW });
  const store = options.store ?? new MemoryPromptHubGenerationStore();
  const references = new MemoryPromptHubReferenceStore();
  let sequence = 0;
  const calls: UpstreamCall[] = [];
  const service = new PromptHubGenerationService(
    quotes,
    { resolveUpstreamAccess: async () => ({ data: { accessToken: "access-token" } }) },
    store,
    {
      apiBaseUrl: "https://prompt-hub.test",
      now: options.now ?? (() => NOW),
      createId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
        calls.push({ method: init?.method ?? "GET", path: url.pathname, body });
        return options.fetch(url, init);
      },
      references,
    },
  );
  return { service, store, calls, quotes, adapter };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function readyMedia(kind: MediaKind): PublicMedia {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    kind,
    name: "reference",
    mimeType: kind === "image" ? "image/png" : kind === "video" ? "video/mp4" : "audio/mpeg",
    size: 8,
    sha256: "a".repeat(64),
    width: kind === "image" ? 1 : 16,
    height: kind === "image" ? 1 : 9,
    durationMs: kind === "image" ? null : 1_000,
    status: "ready",
    error: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  };
}

async function quoteFor(quotes: GenerationQuoteService, modelId: string, modality: "image" | "video", parameters: Record<string, unknown>, refs = 0) {
  return quotes.createQuote({
    modelId,
    modality,
    parameters,
    inputs: { images: refs, styleImages: 0, elementImages: 0, videos: 0, audios: 0 },
    quantity: 1,
  });
}

function submissionFor(quote: { id: string; modelId: string; creditMicros: number; pricingVersion: string; expiresAt: string }, modelId: string, modality: "image" | "video", parameters: Record<string, unknown>, key: string, refs = 0) {
  return {
    projectId: "project-1",
    nodeId: "node-1",
    modelId,
    modality,
    parameters,
    inputs: { images: Array.from({ length: refs }, (_, index) => `ref-${index + 1}`), styleImages: [], elementImages: [], videos: [], audios: [] },
    quantity: 1,
    expectedQuote: {
      id: quote.id,
      modelId: quote.modelId,
      creditMicros: quote.creditMicros,
      pricingVersion: quote.pricingVersion,
      expiresAt: quote.expiresAt,
    },
    idempotencyKey: key,
  };
}

describe("upstream VALIDATION_ERROR boundary (fail-closed, single POST, no fake success)", () => {
  it.each(["image2-A", "grok-imagine-image"])("%s VALIDATION_ERROR surfaces the product error and never re-POSTs", async (modelId) => {
    const { service, calls, quotes } = createHostedHarness({
      fetch: async (url) => {
        if (url.pathname === "/api/v1/generate") {
          // The rejection arrives after the response budget so the accepted
          // submission is persisted as a definitive failed job (never removed
          // and never silently converted into a success).
          await delay(600);
          return json({ ok: false, error: { code: "VALIDATION_ERROR", message: "参数不合法" } }, 400);
        }
        throw new Error(`unexpected ${url.pathname}`);
      },
    });
    const parameters = modelId === "grok-imagine-image"
      ? { prompt: "城市夜景", quality: "high", size: "1024x1024" }
      : { prompt: "城市夜景", resolution: "4k", quality: "high" };
    const quote = await quoteFor(quotes, modelId, "image", parameters);
    const submitted = await service.submit("owner-1", submissionFor(quote, modelId, "image", parameters, `validation-${modelId}-001`));
    // The optimistic snapshot returns immediately; the definitive rejection is
    // persisted in the background once the response budget has passed.
    const job = await waitForJob(service, "owner-1", submitted.data.id, (status) => status !== "submitting");

    expect(job.status).toBe("failed");
    expect(job.error?.code).toBe("VALIDATION_ERROR");
    expect(job.error?.message).toContain("参数不合法");
    expect(calls.filter((call) => call.path === "/api/v1/generate")).toHaveLength(1);

    // Sanitized diagnostic: the exact body the Canvas contract produced.
    const body = calls.find((call) => call.path === "/api/v1/generate")?.body;
    expect(body).toMatchObject({
      model: modelId,
      prompt: "城市夜景",
      clientRequestId: `validation-${modelId}-001`,
      product: "canvas",
      projectId: "project-1",
      nodeId: "node-1",
    });
    expect(body).not.toHaveProperty("n");
    expect(body).not.toHaveProperty("count");

    // A later get() never creates a second POST or a fake completion.
    const later = await service.get("owner-1", job.id);
    expect(later.data.status).toBe("failed");
    expect(calls.filter((call) => call.path === "/api/v1/generate")).toHaveLength(1);
  });
});

describe("nano-banana maintenance and unavailability", () => {
  it("hides a maintenance-listed model from quotes with MODEL_NOT_AVAILABLE", async () => {
    const payload = buildNonMjSourceCatalog() as { models: Array<Record<string, unknown>> };
    const maintenance = {
      ...payload,
      models: payload.models.map((model) => model.id === "nano-banana"
        ? { ...model, selectable: false }
        : model),
    };
    const adapter = createAdapter(maintenance);
    const quotes = new GenerationQuoteService(adapter, { now: () => NOW });
    const catalog = await adapter.getCatalog({ forceRefresh: true, awaitRefresh: true });
    expect(catalog.models.some((model) => model.id === "nano-banana")).toBe(false);
    await expect(quotes.createQuote({
      modelId: "nano-banana",
      modality: "image",
      parameters: { prompt: "城市夜景" },
      inputs: { images: 0, styleImages: 0, elementImages: 0, videos: 0, audios: 0 },
      quantity: 1,
    })).rejects.toMatchObject({ code: "MODEL_NOT_AVAILABLE" });
  });

  it("surfaces an upstream maintenance rejection without fabricating success", async () => {
    const { service, calls, quotes } = createHostedHarness({
      fetch: async (url) => {
        if (url.pathname === "/api/v1/generate") {
          await delay(600);
          return json({ ok: false, error: { code: "MODEL_MAINTENANCE", message: "该模型正在维护中，请稍后再试" } }, 400);
        }
        throw new Error(`unexpected ${url.pathname}`);
      },
    });
    const quote = await quoteFor(quotes, "nano-banana", "image", { prompt: "城市夜景", resolution: "1k" });
    const submitted = await service.submit("owner-1", submissionFor(quote, "nano-banana", "image", { prompt: "城市夜景", resolution: "1k" }, "nano-banana-maint-001"));
    const job = await waitForJob(service, "owner-1", submitted.data.id, (status) => status !== "submitting");
    expect(job.status).toBe("failed");
    expect(job.error?.code).toBe("MODEL_MAINTENANCE");
    expect(job.error?.message).toContain("维护中");
    expect(calls.filter((call) => call.path === "/api/v1/generate")).toHaveLength(1);
  });
});

describe("gpt-image-2-ext long-running read-only progression", () => {
  it("keeps a frozen running job read-only with no second POST and no duplicate artifacts", async () => {
    const { service, calls, quotes } = createHostedHarness({
      fetch: async (url) => {
        if (url.pathname === "/api/v1/generate") {
          return json({ ok: true, data: { jobId: "ext-job-1", status: "running", progress: 48 } });
        }
        if (url.pathname === "/api/v1/generate/jobs/ext-job-1") {
          return json({ ok: true, data: { jobId: "ext-job-1", status: "running", progress: 48 } });
        }
        throw new Error(`unexpected ${url.pathname}`);
      },
    });
    const quote = await quoteFor(quotes, "gpt-image-2-ext", "image", { prompt: "城市夜景", resolution: "4k", quality: "high" });
    const submitted = await service.submit("owner-1", submissionFor(quote, "gpt-image-2-ext", "image", { prompt: "城市夜景", resolution: "4k", quality: "high" }, "gpt-ext-long-001"));
    expect(submitted.data.status).toBe("running");
    expect(submitted.data.progress).toBe(48);
    const firstVersion = submitted.data.version;

    // Repeated observations stay read-only: the public version never advances
    // while the upstream reports an identical running/48 state.
    const first = await service.get("owner-1", submitted.data.id);
    const second = await service.get("owner-1", submitted.data.id);
    expect(first.data.status).toBe("running");
    expect(first.data.progress).toBe(48);
    expect(second.data.version).toBe(first.data.version);
    expect(first.data.version).toBe(firstVersion);

    // One submission POST, zero extra generation POSTs, zero artifacts.
    expect(calls.filter((call) => call.path === "/api/v1/generate")).toHaveLength(1);
    expect(submitted.data.artifacts).toEqual([]);
  });
});

describe("kling-o3-pro-v2v-reference submission_unknown reconciliation", () => {
  function klingQuote() {
    return {
      id: "quote-kling-1",
      modelId: "kling-o3-pro-v2v-reference",
      modelLabel: "Kling O3 Pro",
      modality: "video" as const,
      quantity: 1,
      normalizedParameters: { prompt: "人物转身", seconds: 5, resolution: "720p" },
      creditMicros: 8_500_000,
      credits: "8.5",
      yuanMicros: 85_000,
      yuan: "0.085",
      estimated: false,
      pricingUnit: "request" as const,
      catalogVersion: "catalog-1",
      capabilityVersion: "capability-1",
      pricingVersion: "pricing-1",
      expiresAt: new Date(NOW + 120_000).toISOString(),
    };
  }

  async function seedUnknown(store: MemoryPromptHubGenerationStore, recovery?: { attempts: number; lastAttemptAt: string }) {
    const record = {
      ownerId: "owner-1",
      idempotencyKey: "canvas:kling-request-001",
      upstreamJobId: null,
      provider: "prompt-hub" as const,
      resultUrls: [],
      submission: {
        projectId: "project-1",
        nodeId: "node-1",
        modelId: "kling-o3-pro-v2v-reference",
        modality: "video" as const,
        parameters: { prompt: "人物转身", seconds: 5 },
        inputs: { images: [], styleImages: [], elementImages: [], videos: [], audios: [] },
        quantity: 1,
        expectedQuote: {
          id: "quote-kling-1",
          modelId: "kling-o3-pro-v2v-reference",
          creditMicros: 8_500_000,
          pricingVersion: "pricing-1",
          expiresAt: klingQuote().expiresAt,
        },
        idempotencyKey: "canvas:kling-request-001",
      },
      ...(recovery ? { recovery } : {}),
      job: {
        schemaVersion: 1 as const,
        version: 0,
        id: "phj_kling_unknown",
        projectId: "project-1",
        nodeId: "node-1",
        modelId: "kling-o3-pro-v2v-reference",
        modelLabel: "Kling O3 Pro",
        modality: "video" as const,
        status: "submission_unknown" as const,
        progress: 0,
        quote: klingQuote(),
        artifacts: [],
        error: { code: "GENERATION_SUBMISSION_UNCONFIRMED", message: "任务提交结果待确认，请勿重复生成", retryable: false },
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        startedAt: NOW_ISO,
        completedAt: null,
      },
    };
    expect(await store.create(record, 100)).toBe("created");
  }

  it("keeps submission_unknown read-only after a confirmed miss and never re-POSTs", async () => {
    const store = new MemoryPromptHubGenerationStore();
    await seedUnknown(store);
    const requested: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
    const { service } = createHostedHarness({
      store,
      fetch: async (url, init) => {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
        requested.push({ method: init?.method ?? "GET", path: url.pathname, body });
        if (url.pathname === "/api/v1/video/requests/canvas%3Akling-request-001") {
          // Definitive miss: the upstream has no record of the clientRequestId.
          return json({ ok: false, error: { code: "NOT_FOUND", message: "missing" } }, 404);
        }
        throw new Error(`unexpected ${url.pathname}`);
      },
    });

    // Observation performs the read-only video lookup and, on a confirmed miss,
    // keeps the node visibly pending instead of replaying the paid POST.
    const result = await service.get("owner-1", "phj_kling_unknown");
    expect(result.data.status).toBe("submission_unknown");
    await service.settleObservation();
    expect(requested.filter((call) => call.method === "GET"
      && call.path === "/api/v1/video/requests/canvas%3Akling-request-001")).toHaveLength(1);
    const replayPosts = requested.filter((call) => call.method === "POST" && call.path === "/api/v1/video");
    expect(replayPosts).toHaveLength(0);
    const stored = await store.get("owner-1", "phj_kling_unknown");
    expect(stored?.job.status).toBe("submission_unknown");
    expect(stored?.recovery?.attempts).toBeUndefined();
  });

  it("binds a read-only recovery lookup without a replay POST when the upstream found the job", async () => {
    const store = new MemoryPromptHubGenerationStore();
    await seedUnknown(store);
    const requested: string[] = [];
    const { service } = createHostedHarness({
      store,
      fetch: async (url, init) => {
        requested.push(`${init?.method ?? "GET"} ${url.pathname}`);
        if (url.pathname === "/api/v1/video/requests/canvas%3Akling-request-001") {
          return json({ ok: true, data: { jobId: "kling-job-recovered" } });
        }
        if (url.pathname === "/api/v1/video/jobs/kling-job-recovered") {
          return json({ ok: true, data: { jobId: "kling-job-recovered", status: "queued", progress: 0 } });
        }
        throw new Error(`unexpected ${url.pathname}`);
      },
    });

    const result = await service.get("owner-1", "phj_kling_unknown");
    expect(result.data.status).toBe("submission_unknown");
    await service.settleObservation();
    const stored = await store.get("owner-1", "phj_kling_unknown");

    expect(stored?.job.status).toBe("queued");
    expect(requested.filter((entry) => entry.startsWith("GET /api/v1/video/requests/"))).toHaveLength(1);
    expect(requested.filter((entry) => entry.startsWith("POST /api/v1/video"))).toHaveLength(0);
    expect(stored?.upstreamJobId).toBe("kling-job-recovered");
  });

  it("never mints a new idempotency key and never replays during observation", async () => {
    const store = new MemoryPromptHubGenerationStore();
    await seedUnknown(store);
    const keysSeen = new Set<string>();
    let replayPosts = 0;
    let clock = NOW;
    const { service } = createHostedHarness({
      store,
      now: () => clock,
      fetch: async (url, init) => {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
        if (body?.clientRequestId) keysSeen.add(String(body.clientRequestId));
        if (url.pathname === "/api/v1/video/requests/canvas%3Akling-request-001") {
          return json({ ok: false, error: { code: "NOT_FOUND", message: "missing" } }, 404);
        }
        if (url.pathname === "/api/v1/video") {
          replayPosts += 1;
          throw new Error("unexpected replay POST during observation");
        }
        throw new Error(`unexpected ${url.pathname}`);
      },
    });

    // Repeated observations after the confirmed miss never re-POST the paid
    // envelope: no new key is minted, no POST fires, and the node stays visibly
    // pending for an explicit user retry.
    for (let attempt = 0; attempt < 9; attempt += 1) {
      clock += 6_000;
      await service.get("owner-1", "phj_kling_unknown");
    }
    expect(keysSeen).toEqual(new Set());
    expect(replayPosts).toBe(0);
    const stored = await store.get("owner-1", "phj_kling_unknown");
    expect(stored?.recovery?.attempts).toBeUndefined();
    expect(stored?.job.status).toBe("submission_unknown");
  });
});

describe("sd2.0-480p vendor failure auto-refund surfacing", () => {
  it("surfaces the refunded failure from the upstream job status", async () => {
    const { service, store, calls, quotes } = createHostedHarness({
      fetch: async (url) => {
        if (url.pathname === "/api/v1/video") {
          return json({ ok: true, data: { jobId: "sd2-job-1", status: "queued", progress: 0 } });
        }
        if (url.pathname === "/api/v1/video/jobs/sd2-job-1") {
          return json({ ok: true, data: { jobId: "sd2-job-1", status: "failed", progress: 0, errorMessage: "视频生成失败，积分已自动退回", refunded: true } });
        }
        throw new Error(`unexpected ${url.pathname}`);
      },
    });
    const quote = await quoteFor(quotes, "sd2.0-480p", "video", { prompt: "人物转身", seconds: 5 });
    const submitted = await service.submit("owner-1", submissionFor(quote, "sd2.0-480p", "video", { prompt: "人物转身", seconds: 5 }, "sd2-refund-001"));
    const result = await service.get("owner-1", submitted.data.id);
    expect(result.data.status).toBe("queued");
    await service.settleObservation();
    const stored = await store.get("owner-1", submitted.data.id);

    expect(stored?.job.status).toBe("failed");
    expect(stored?.job.error?.message).toContain("积分已自动退回");
    expect(stored?.job.artifacts).toEqual([]);
    expect(calls.filter((call) => call.path === "/api/v1/video")).toHaveLength(1);
  });
});

describe("hosted concurrency isolation", () => {
  it("keeps an independent node completing when another model is rejected upstream", async () => {
    const store = new MemoryPromptHubGenerationStore();
    const { service, calls, quotes } = createHostedHarness({
      store,
      fetch: async (url, init) => {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
        if (url.pathname === "/api/v1/generate") {
          if (body?.model === "grok-imagine-image") {
            await delay(600);
            return json({ ok: false, error: { code: "VALIDATION_ERROR", message: "invalid" } }, 400);
          }
          return json({ ok: true, data: { jobId: `job-${body?.model}`, status: "running", progress: 48 } });
        }
        if (url.pathname.startsWith("/api/v1/generate/jobs/job-nano-banana")) {
          return json({ ok: true, data: { jobId: "job-nano-banana", status: "completed", progress: 100, image_urls: ["https://media.example/nano.png"] } });
        }
        throw new Error(`unexpected ${url.pathname}`);
      },
    });

    const failingQuote = await quoteFor(quotes, "grok-imagine-image", "image", { prompt: "城市夜景" });
    const okQuote = await quoteFor(quotes, "nano-banana", "image", { prompt: "城市夜景", resolution: "1k" });
    const failing = await service.submit("owner-1", submissionFor(failingQuote, "grok-imagine-image", "image", { prompt: "城市夜景" }, "conc-fail-001"));
    const ok = await service.submit("owner-1", submissionFor(okQuote, "nano-banana", "image", { prompt: "城市夜景", resolution: "1k" }, "conc-ok-001"));

    const failedJob = await waitForJob(service, "owner-1", failing.data.id, (status) => status !== "submitting");
    expect(failedJob.status).toBe("failed");
    expect(failedJob.error?.code).toBe("VALIDATION_ERROR");
    const completed = await service.get("owner-1", ok.data.id);
    expect(completed.data.status).toBe("running");
    await service.settleObservation();
    const stored = await store.get("owner-1", ok.data.id);
    expect(stored?.job.status).toBe("completed");
    expect(stored?.job.artifacts).toHaveLength(1);
    expect(calls.filter((call) => call.path === "/api/v1/generate")).toHaveLength(2);
  });
});

async function waitForJob(
  service: PromptHubGenerationService,
  ownerId: string,
  jobId: string,
  predicate: (status: string) => boolean,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await service.get(ownerId, jobId);
    if (predicate(result.data.status)) return result.data;
    await delay(25);
  }
  throw new Error(`timed out waiting for job ${jobId} to reach a matching status`);
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
