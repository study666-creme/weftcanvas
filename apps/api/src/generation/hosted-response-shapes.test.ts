import { describe, expect, it } from "vitest";

import { KachangCatalogAdapter } from "../catalog/adapter.js";
import { NON_MJ_NOW_ISO, buildNonMjSourceCatalog } from "../catalog/nonmj-catalog-fixture.js";
import { GenerationQuoteService } from "../catalog/quote.js";
import { MemoryCatalogSnapshotStore } from "../catalog/store.js";
import {
  apimartMalformedCompletedTask,
  apimartMjStyleSuccessTask,
  apimartUnifiedFailedTask,
  apimartUnifiedRunningTask,
  apimartUnifiedSuccessTask,
  promptHubNestedEnvelopeTask,
} from "./hosted-response-fixtures.js";
import {
  MemoryPromptHubGenerationStore,
  MemoryPromptHubReferenceStore,
  PromptHubGenerationService,
} from "./prompt-hub-service.js";

const NOW = Date.parse(NON_MJ_NOW_ISO);
const OWNER = "owner-shapes-1";
const TIMESTAMP = NON_MJ_NOW_ISO;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createService(options: {
  provider: "apimart" | "prompt-hub";
  fetch: (url: URL, init: RequestInit | undefined) => Promise<Response>;
  observationSettleWaitMs?: number;
}) {
  const adapter = new KachangCatalogAdapter({
    sourceUrl: "https://catalog.test/models",
    store: new MemoryCatalogSnapshotStore(),
    now: () => NOW,
    includeKnownModels: true,
    fetch: async () => json(buildNonMjSourceCatalog(), 200),
  });
  const quotes = new GenerationQuoteService(adapter, { now: () => NOW });
  const store = new MemoryPromptHubGenerationStore();
  const references = new MemoryPromptHubReferenceStore();
  const service = new PromptHubGenerationService(
    quotes,
    { resolveUpstreamAccess: async () => ({ data: { accessToken: "access-token" } }) },
    store,
    {
      apiBaseUrl: "https://prompt-hub.test",
      ...(options.provider === "apimart"
        ? { apimart: { apiBaseUrl: "https://api.apimart.test", apiKey: "shapes-test-key" } }
        : {}),
      now: () => NOW,
      requestTimeoutMs: 2_000,
      observationSettleWaitMs: options.observationSettleWaitMs ?? 200,
      fetch: options.fetch,
      references,
    },
  );
  return { service, store };
}

async function seedImageJob(
  store: MemoryPromptHubGenerationStore,
  id: string,
  upstreamJobId: string,
  provider: "apimart" | "prompt-hub",
  modelId = provider === "apimart" ? "mj-v81" : "image2",
) {
  const record = {
    ownerId: OWNER,
    idempotencyKey: `canvas:shapes-request-${id}`,
    upstreamJobId,
    provider,
    resultUrls: [],
    submission: {
      projectId: "project-shapes-1",
      nodeId: "node-shapes-1",
      modelId,
      modality: "image" as const,
      parameters: { prompt: "test", n: 1 },
      inputs: { images: [], styleImages: [], elementImages: [], videos: [], audios: [] },
      quantity: 1,
      expectedQuote: {
        id: "quote-shapes-1",
        modelId,
        creditMicros: 40_000_000,
        pricingVersion: "pricing-shapes-1",
        expiresAt: new Date(NOW + 120_000).toISOString(),
      },
      idempotencyKey: `canvas:shapes-request-${id}`,
    },
    job: {
      schemaVersion: 1 as const,
      version: 0,
      id,
      projectId: "project-shapes-1",
      nodeId: "node-shapes-1",
      modelId,
      modelLabel: "Shapes model",
      modality: "image" as const,
      status: "running" as const,
      progress: 48,
      quote: {
        id: "quote-shapes-1",
        modelId,
        modelLabel: "Shapes model",
        modality: "image" as const,
        quantity: 1,
        normalizedParameters: { prompt: "test", n: 1 },
        creditMicros: 40_000_000,
        credits: "40",
        yuanMicros: 400_000,
        yuan: "0.4",
        estimated: false,
        pricingUnit: "request" as const,
        outputCount: 5,
        catalogVersion: "catalog-shapes-1",
        capabilityVersion: "capability-shapes-1",
        pricingVersion: "pricing-shapes-1",
        expiresAt: new Date(NOW + 120_000).toISOString(),
      },
      artifacts: [],
      error: null,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      startedAt: TIMESTAMP,
      completedAt: null,
    },
  };
  expect(await store.create(record, 100)).toBe("created");
}

describe("hosted terminal response normalization shapes", () => {
  it("delivers a unified APIMart success (id/status/progress/result.images[].url) as completed", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const { service, store } = createService({
      provider: "apimart",
      fetch: async (url, init) => {
        calls.push({ method: init?.method ?? "GET", path: url.pathname });
        if (url.pathname === "/v1/tasks/apimart-task-unified-success") return json(apimartUnifiedSuccessTask);
        throw new Error(`unexpected upstream request ${url.href}`);
      },
    });
    await seedImageJob(store, "phj_shapes_unified", "apimart-task-unified-success", "apimart");

    await service.get(OWNER, "phj_shapes_unified");
    await service.settleObservation();
    const stored = await store.get(OWNER, "phj_shapes_unified");

    expect(stored?.job.status).toBe("completed");
    expect(stored?.job.progress).toBe(100);
    expect(stored?.job.artifacts).toHaveLength(2);
    expect(stored?.resultUrls).toEqual([
      "https://cdn.example/results/unified-1.png",
      "https://cdn.example/results/unified-2.png",
    ]);
    expect(calls).toEqual([{ method: "GET", path: "/v1/tasks/apimart-task-unified-success" }]);
  });

  it("normalizes an MJ-style SUCCESS response (grid_image_url/image_urls) into a completed job", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const { service, store } = createService({
      provider: "apimart",
      fetch: async (url, init) => {
        calls.push({ method: init?.method ?? "GET", path: url.pathname });
        if (url.pathname === "/v1/tasks/apimart-task-mj-success") return json(apimartMjStyleSuccessTask);
        throw new Error(`unexpected upstream request ${url.href}`);
      },
    });
    await seedImageJob(store, "phj_shapes_mj", "apimart-task-mj-success", "apimart");

    await service.get(OWNER, "phj_shapes_mj");
    await service.settleObservation();
    const stored = await store.get(OWNER, "phj_shapes_mj");

    expect(stored?.job.status).toBe("completed");
    expect(stored?.resultUrls).toEqual([
      "https://cdn.example/results/mj-grid.png",
      "https://cdn.example/results/mj-1.png",
      "https://cdn.example/results/mj-2.png",
      "https://cdn.example/results/mj-3.png",
      "https://cdn.example/results/mj-4.png",
    ]);
    expect(stored?.job.artifacts).toHaveLength(5);
    expect(calls.every((call) => call.method === "GET" && call.path === "/v1/tasks/apimart-task-mj-success")).toBe(true);
  });

  it("surfaces a unified APIMart failed response as an explicit failed job with the upstream reason", async () => {
    const { service, store } = createService({
      provider: "apimart",
      fetch: async (url) => {
        if (url.pathname === "/v1/tasks/apimart-task-unified-failed") return json(apimartUnifiedFailedTask);
        throw new Error(`unexpected upstream request ${url.href}`);
      },
    });
    await seedImageJob(store, "phj_shapes_failed", "apimart-task-unified-failed", "apimart");

    await service.get(OWNER, "phj_shapes_failed");
    await service.settleObservation();
    const stored = await store.get(OWNER, "phj_shapes_failed");

    expect(stored?.job.status).toBe("failed");
    expect(stored?.job.error?.code).toBe("GENERATION_FAILED");
    expect(stored?.job.error?.message).toContain("内容策略拒绝该请求");
  });

  it("turns a malformed completed image payload without artifact URLs into an explicit truthful failure, never a fabricated completed node", async () => {
    const { service, store } = createService({
      provider: "apimart",
      fetch: async (url) => {
        if (url.pathname === "/v1/tasks/apimart-task-malformed-completed") return json(apimartMalformedCompletedTask);
        throw new Error(`unexpected upstream request ${url.href}`);
      },
    });
    await seedImageJob(store, "phj_shapes_malformed", "apimart-task-malformed-completed", "apimart");

    await service.get(OWNER, "phj_shapes_malformed");
    await service.settleObservation();
    const stored = await store.get(OWNER, "phj_shapes_malformed");

    expect(stored?.job.status).toBe("failed");
    expect(stored?.job.error?.code).toBe("GENERATION_RESULT_UNAVAILABLE");
    expect(stored?.job.artifacts).toEqual([]);
    expect(stored?.resultUrls).toEqual([]);
  });

  it("normalizes the nested Prompt Hub envelope actually accepted by the contract", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const { service, store } = createService({
      provider: "prompt-hub",
      fetch: async (url, init) => {
        calls.push({ method: init?.method ?? "GET", path: url.pathname });
        if (url.pathname === "/api/v1/generate/jobs/ph-job-envelope-1") return json(promptHubNestedEnvelopeTask);
        throw new Error(`unexpected upstream request ${url.href}`);
      },
    });
    await seedImageJob(store, "phj_shapes_envelope", "ph-job-envelope-1", "prompt-hub");

    await service.get(OWNER, "phj_shapes_envelope");
    await service.settleObservation();
    const stored = await store.get(OWNER, "phj_shapes_envelope");

    expect(stored?.job.status).toBe("completed");
    expect(stored?.job.artifacts).toHaveLength(1);
    expect(calls).toEqual([{ method: "GET", path: "/api/v1/generate/jobs/ph-job-envelope-1" }]);
  });

  it("keeps observing a nonterminal upstream snapshot without completing or failing it", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const { service, store } = createService({
      provider: "apimart",
      fetch: async (url, init) => {
        calls.push({ method: init?.method ?? "GET", path: url.pathname });
        if (url.pathname === "/v1/tasks/apimart-task-unified-running") return json(apimartUnifiedRunningTask);
        throw new Error(`unexpected upstream request ${url.href}`);
      },
    });
    await seedImageJob(store, "phj_shapes_running", "apimart-task-unified-running", "apimart");

    await service.get(OWNER, "phj_shapes_running");
    await service.settleObservation();
    const stored = await store.get(OWNER, "phj_shapes_running");

    expect(stored?.job.status).toBe("running");
    expect(stored?.job.artifacts).toEqual([]);
  });

  it("never issues a generation POST while reconciling any of the terminal shapes", async () => {
    const posts: Array<{ method: string; path: string }> = [];
    const { service, store } = createService({
      provider: "apimart",
      fetch: async (url, init) => {
        const call = { method: init?.method ?? "GET", path: url.pathname };
        if (call.method === "POST") posts.push(call);
        if (url.pathname === "/v1/tasks/apimart-task-unified-success") return json(apimartUnifiedSuccessTask);
        throw new Error(`unexpected upstream request ${url.href}`);
      },
    });
    await seedImageJob(store, "phj_shapes_nopost", "apimart-task-unified-success", "apimart");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await service.get(OWNER, "phj_shapes_nopost");
    }
    await service.settleObservation();

    expect(posts).toEqual([]);
  });
});
