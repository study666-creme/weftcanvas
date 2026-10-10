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
  type PromptHubGenerationStore,
} from "./prompt-hub-service.js";

const NOW = Date.parse(NON_MJ_NOW_ISO);

type UpstreamCall = { method: string; path: string; body: Record<string, unknown> | null };

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

/**
 * A deterministic Prompt Hub upstream stub that drives one image or video job
 * from submission through a completed artifact set, and records every request.
 */
function createHostedService(options: {
  store?: PromptHubGenerationStore;
  onPost?: (call: UpstreamCall) => void;
  imageJob?: (path: string) => Record<string, unknown>;
  videoJob?: (path: string) => Record<string, unknown>;
}) {
  const adapter = createAdapter();
  const quotes = new GenerationQuoteService(adapter, { now: () => NOW });
  const store = options.store ?? new MemoryPromptHubGenerationStore();
  const references = new MemoryPromptHubReferenceStore();
  let sequence = 0;
  let uploadSequence = 0;
  const calls: UpstreamCall[] = [];
  const service = new PromptHubGenerationService(
    quotes,
    { resolveUpstreamAccess: async () => ({ data: { accessToken: "access-token" } }) },
    store,
    {
      apiBaseUrl: "https://prompt-hub.test",
      now: () => NOW,
      createId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
        const call: UpstreamCall = { method: init?.method ?? "GET", path: url.pathname, body };
        calls.push(call);
        options.onPost?.(call);
        if (url.pathname === "/api/v1/generate" || url.pathname === "/api/v1/video") {
          return json({ ok: true, data: { jobId: "ph-job-1", status: "queued", progress: 0 } });
        }
        if (url.pathname.startsWith("/api/v1/media/upload")) {
          uploadSequence += 1;
          return json({ ok: true, data: { ref: `/api/v1/media/c/owner/canvas/ref-${uploadSequence}.png` } });
        }
        if (url.pathname.startsWith("/api/v1/generate/jobs/")) {
          return json({ ok: true, data: options.imageJob
            ? options.imageJob(url.pathname)
            : { jobId: "ph-job-1", status: "completed", progress: 100, image_urls: ["https://media.example/1.png", "https://media.example/2.png"] } });
        }
        if (url.pathname.startsWith("/api/v1/video/jobs/")) {
          return json({ ok: true, data: options.videoJob
            ? options.videoJob(url.pathname)
            : { jobId: "ph-job-1", status: "completed", progress: 100, video_url: "https://media.example/result.mp4" } });
        }
        throw new Error(`unexpected upstream request ${String(input)}`);
      },
      media: {
        readReference: async (_ownerId: string, _mediaId: string, kind: MediaKind, _maxBytes: number) => ({
          media: readyMedia(kind),
          bytes: Buffer.from("synthetic-reference-bytes"),
        }),
      },
      references,
    },
  );
  return { service, store, calls, quotes };
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
    createdAt: NON_MJ_NOW_ISO,
    updatedAt: NON_MJ_NOW_ISO,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("non-MJ hosted full-chain matrix", () => {
  const imageCases = [
    { modelId: "gpt-image-2-1k", parameters: { prompt: "城市夜景" }, refs: 1, artifacts: 1 },
    { modelId: "gpt-image-2", parameters: { prompt: "城市夜景" }, refs: 0, artifacts: 1 },
    { modelId: "gpt-image-2-ext", parameters: { prompt: "城市夜景", resolution: "4k", quality: "high" }, refs: 0, artifacts: 1 },
    { modelId: "gpt-image-2-free", parameters: { prompt: "城市夜景" }, refs: 0, artifacts: 1 },
    { modelId: "image2", parameters: { prompt: "城市夜景" }, refs: 0, artifacts: 1 },
    { modelId: "image2-economy", parameters: { prompt: "城市夜景" }, refs: 0, artifacts: 1 },
    { modelId: "image2-4k-fast", parameters: { prompt: "城市夜景" }, refs: 0, artifacts: 1 },
    { modelId: "image2-A", parameters: { prompt: "城市夜景", resolution: "4k", quality: "high" }, refs: 0, artifacts: 1 },
    { modelId: "nano-banana", parameters: { prompt: "城市夜景", resolution: "4k" }, refs: 1, artifacts: 1 },
    { modelId: "nano-banana-fast", parameters: { prompt: "城市夜景" }, refs: 0, artifacts: 1 },
    { modelId: "nano-banana-2-lite", parameters: { prompt: "城市夜景" }, refs: 0, artifacts: 1 },
    { modelId: "nano-banana-pro", parameters: { prompt: "城市夜景", resolution: "4k" }, refs: 0, artifacts: 1 },
    { modelId: "nano-banana-2", parameters: { prompt: "城市夜景", resolution: "4k" }, refs: 0, artifacts: 1 },
    { modelId: "lingtu", parameters: { prompt: "城市夜景" }, refs: 0, artifacts: 1 },
    { modelId: "lingtu-fast", parameters: { prompt: "城市夜景" }, refs: 0, artifacts: 1 },
    { modelId: "lingtu-lite", parameters: { prompt: "城市夜景" }, refs: 0, artifacts: 1 },
    { modelId: "grok-imagine-image", parameters: { prompt: "城市夜景", quality: "high" }, refs: 0, artifacts: 1 },
  ];

  it.each(imageCases)("image $modelId submits one Prompt Hub generate call and completes", async (testCase) => {
    const { service, store, calls, quotes } = createHostedService({});
    const browserQuote = await quotes.createQuote({
      modelId: testCase.modelId,
      modality: "image",
      parameters: testCase.parameters,
      inputs: { images: testCase.refs, styleImages: 0, elementImages: 0, videos: 0, audios: 0 },
      quantity: 1,
    });
    const inputs = { images: Array.from({ length: testCase.refs }, (_, index) => `ref-image-${index + 1}`), styleImages: [], elementImages: [], videos: [], audios: [] };

    const submitted = await service.submit("owner-1", {
      projectId: "project-1",
      nodeId: "node-1",
      modelId: testCase.modelId,
      modality: "image",
      parameters: testCase.parameters,
      inputs,
      quantity: 1,
      expectedQuote: {
        id: browserQuote.id,
        modelId: browserQuote.modelId,
        creditMicros: browserQuote.creditMicros,
        pricingVersion: browserQuote.pricingVersion,
        expiresAt: browserQuote.expiresAt,
      },
      idempotencyKey: `nonmj-${testCase.modelId}-001`,
    });

    // Exactly one upstream generate POST; n/count never leak as a batch count.
    const posts = calls.filter((call) => call.path === "/api/v1/generate");
    expect(posts).toHaveLength(1);
    const body = posts[0]!.body!;
    expect(body.model).toBe(testCase.modelId);
    expect(body.clientRequestId).toBe(`nonmj-${testCase.modelId}-001`);
    expect(body.product).toBe("canvas");
    expect(body.projectId).toBe("project-1");
    expect(body.nodeId).toBe("node-1");
    expect(body).not.toHaveProperty("n");
    expect(body).not.toHaveProperty("count");
    if (testCase.refs > 0) {
      expect(body.media_inputs).toEqual(Array.from({ length: testCase.refs }, (_, index) => ({
        kind: "image",
        role: "reference",
        url: `/api/v1/media/c/owner/canvas/ref-${index + 1}.png`,
      })));
      expect(body).not.toHaveProperty("refImageUrls");
      expect(String(body.prompt)).toContain("参考素材按上传顺序");
    }

    const result = await service.get("owner-1", submitted.data.id);
    expect(result.data.status).toBe("queued");
    await service.settleObservation();
    const storedJob = (await store.get("owner-1", submitted.data.id))!.job;
    expect(storedJob.status).toBe("completed");
    expect(storedJob.modelId).toBe(testCase.modelId);
    expect(storedJob.artifacts).toHaveLength(testCase.artifacts);
    expect(storedJob.artifacts.every((artifact) => artifact.kind === "image")).toBe(true);
    expect(storedJob.progress).toBe(100);
    expect(storedJob.quote.creditMicros).toBe(browserQuote.creditMicros);

    // Idempotency: the same key returns the existing job and never re-POSTs.
    const replay = await service.submit("owner-1", {
      projectId: "project-1",
      nodeId: "node-1",
      modelId: testCase.modelId,
      modality: "image",
      parameters: testCase.parameters,
      inputs,
      quantity: 1,
      expectedQuote: {
        id: browserQuote.id,
        modelId: browserQuote.modelId,
        creditMicros: browserQuote.creditMicros,
        pricingVersion: browserQuote.pricingVersion,
        expiresAt: browserQuote.expiresAt,
      },
      idempotencyKey: `nonmj-${testCase.modelId}-001`,
    });
    expect(replay.data.id).toBe(submitted.data.id);
    expect(calls.filter((call) => call.path === "/api/v1/generate")).toHaveLength(1);
    expect((await store.list("owner-1", { limit: 10 })).length).toBe(1);
  });

  it.each([
    { modelId: "grok-imagine-video", parameters: { prompt: "镜头缓慢推进", seconds: 5 }, refs: 0 },
    { modelId: "grok-imagine-video-1.5", parameters: { prompt: "镜头缓慢推进", seconds: 5 }, refs: 0 },
    { modelId: "kling-o3-pro-v2v-reference", parameters: { prompt: "人物转身", seconds: 5 }, refs: 2 },
    { modelId: "sd2.0-480p", parameters: { prompt: "人物转身", seconds: 5 }, refs: 1 },
    { modelId: "sd2.0-720p", parameters: { prompt: "人物转身", seconds: 5 }, refs: 0 },
    { modelId: "motion-video", parameters: { prompt: "人物转身", seconds: 5 }, refs: 0 },
    { modelId: "motion-video-1-5", parameters: { prompt: "人物转身", seconds: 5 }, refs: 0 },
    { modelId: "firefly-seedance2-fast-480p", parameters: { prompt: "人物转身", seconds: 5 }, refs: 0 },
  ])("video $modelId submits one Prompt Hub video call and completes", async (testCase) => {
    const { service, store, calls, quotes } = createHostedService({});
    const browserQuote = await quotes.createQuote({
      modelId: testCase.modelId,
      modality: "video",
      parameters: testCase.parameters,
      inputs: { images: testCase.refs, styleImages: 0, elementImages: 0, videos: 0, audios: 0 },
      quantity: 1,
    });
    const inputs = { images: Array.from({ length: testCase.refs }, (_, index) => `ref-image-${index + 1}`), styleImages: [], elementImages: [], videos: [], audios: [] };

    const submitted = await service.submit("owner-1", {
      projectId: "project-1",
      nodeId: "node-1",
      modelId: testCase.modelId,
      modality: "video",
      parameters: testCase.parameters,
      inputs,
      quantity: 1,
      expectedQuote: {
        id: browserQuote.id,
        modelId: browserQuote.modelId,
        creditMicros: browserQuote.creditMicros,
        pricingVersion: browserQuote.pricingVersion,
        expiresAt: browserQuote.expiresAt,
      },
      idempotencyKey: `nonmj-${testCase.modelId}-vid-001`,
    });

    const posts = calls.filter((call) => call.path === "/api/v1/video");
    expect(posts).toHaveLength(1);
    const body = posts[0]!.body!;
    expect(body.model).toBe(testCase.modelId);
    expect(body.clientRequestId).toBe(`nonmj-${testCase.modelId}-vid-001`);
    expect(body).not.toHaveProperty("n");
    expect(body).not.toHaveProperty("count");
    if (testCase.refs > 0) {
      const referenceImages = testCase.modelId === "kling-o3-pro-v2v-reference"
        ? body.images
        : body.referenceImages;
      expect(referenceImages).toHaveLength(testCase.refs);
      expect(referenceImages!.every((value) => typeof value === "string" && value.startsWith("/api/v1/media/"))).toBe(true);
    }

    const result = await service.get("owner-1", submitted.data.id);
    expect(result.data.status).toBe("queued");
    await service.settleObservation();
    const storedJob = (await store.get("owner-1", submitted.data.id))!.job;
    expect(storedJob.status).toBe("completed");
    expect(storedJob.artifacts).toHaveLength(1);
    expect(storedJob.artifacts[0]!.kind).toBe("video");
  });

  it("multiplies per-image output count into the provider call and artifact count", async () => {
    const { service, store, calls, quotes } = createHostedService({
      imageJob: () => ({
        jobId: "ph-job-1",
        status: "completed",
        progress: 100,
        image_urls: ["https://media.example/1.png", "https://media.example/2.png"],
      }),
    });
    const browserQuote = await quotes.createQuote({
      modelId: "gpt-image-2",
      modality: "image",
      parameters: { prompt: "城市夜景", n: 2 },
      inputs: { images: 0, styleImages: 0, elementImages: 0, videos: 0, audios: 0 },
      quantity: 1,
    });
    expect(browserQuote.outputCount).toBe(2);

    const submitted = await service.submit("owner-1", {
      projectId: "project-1",
      nodeId: "node-1",
      modelId: "gpt-image-2",
      modality: "image",
      parameters: { prompt: "城市夜景", n: 2 },
      inputs: { images: [], styleImages: [], elementImages: [], videos: [], audios: [] },
      quantity: 1,
      expectedQuote: {
        id: browserQuote.id,
        modelId: browserQuote.modelId,
        creditMicros: browserQuote.creditMicros,
        pricingVersion: browserQuote.pricingVersion,
        expiresAt: browserQuote.expiresAt,
      },
      idempotencyKey: "nonmj-multicount-001",
    });

    const posts = calls.filter((call) => call.path === "/api/v1/generate");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).not.toHaveProperty("n");
    expect(posts[0]!.body!.count).toBe(2);

    const result = await service.get("owner-1", submitted.data.id);
    expect(result.data.status).toBe("queued");
    await service.settleObservation();
    const storedJob = (await store.get("owner-1", submitted.data.id))!.job;
    expect(storedJob.status).toBe("completed");
    expect(storedJob.artifacts).toHaveLength(2);
  });

  it("surfaces a per-second video quote that multiplies duration", async () => {
    const { service, store, quotes } = createHostedService({});
    const browserQuote = await quotes.createQuote({
      modelId: "sd2.0-480p",
      modality: "video",
      parameters: { prompt: "人物转身", seconds: 10 },
      inputs: { images: 0, styleImages: 0, elementImages: 0, videos: 0, audios: 0 },
      quantity: 1,
    });
    expect(browserQuote.creditMicros).toBe(3_800_000);
    expect(browserQuote.yuanMicros).toBe(38_000);
    expect(browserQuote.outputCount).toBe(1);
    const submitted = await service.submit("owner-1", {
      projectId: "project-1",
      nodeId: "node-1",
      modelId: "sd2.0-480p",
      modality: "video",
      parameters: { prompt: "人物转身", seconds: 10 },
      inputs: { images: [], styleImages: [], elementImages: [], videos: [], audios: [] },
      quantity: 1,
      expectedQuote: {
        id: browserQuote.id,
        modelId: browserQuote.modelId,
        creditMicros: browserQuote.creditMicros,
        pricingVersion: browserQuote.pricingVersion,
        expiresAt: browserQuote.expiresAt,
      },
      idempotencyKey: "nonmj-sd2-001",
    });
    expect(submitted.data.status).toBe("queued");
    const completed = await service.get("owner-1", submitted.data.id);
    expect(completed.data.status).toBe("queued");
    await service.settleObservation();
    const storedJob = (await store.get("owner-1", submitted.data.id))!.job;
    expect(storedJob.status).toBe("completed");
    expect(storedJob.artifacts).toHaveLength(1);
  });

  it("keeps the sd2.0 pro face-route model on its nine-image reference contract", async () => {
    const { service, calls, quotes } = createHostedService({});
    const browserQuote = await quotes.createQuote({
      modelId: "sd2.0 pro 满血九图卡脸版",
      modality: "video",
      parameters: { prompt: "人物转身", seconds: 5 },
      inputs: { images: 3, styleImages: 0, elementImages: 0, videos: 0, audios: 0 },
      quantity: 1,
    });
    const submitted = await service.submit("owner-1", {
      projectId: "project-1",
      nodeId: "node-1",
      modelId: "sd2.0 pro 满血九图卡脸版",
      modality: "video",
      parameters: { prompt: "人物转身", seconds: 5 },
      inputs: {
        images: ["ref-image-1", "ref-image-2", "ref-image-3"],
        styleImages: [],
        elementImages: [],
        videos: [],
        audios: [],
      },
      quantity: 1,
      expectedQuote: {
        id: browserQuote.id,
        modelId: browserQuote.modelId,
        creditMicros: browserQuote.creditMicros,
        pricingVersion: browserQuote.pricingVersion,
        expiresAt: browserQuote.expiresAt,
      },
      idempotencyKey: "nonmj-face-001",
    });
    const posts = calls.filter((call) => call.path === "/api/v1/video");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body!.referenceImages).toHaveLength(3);
    expect(posts[0]!.body!.seconds).toBe(5);
    expect(submitted.data.status).toBe("queued");
  });
});
