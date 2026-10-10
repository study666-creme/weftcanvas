import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

import type { GenerationQuote, MediaKind, PublicMedia } from "@kachang/contracts";

import { KachangCatalogAdapter } from "../catalog/adapter.js";
import { GenerationQuoteService } from "../catalog/quote.js";
import { MemoryCatalogSnapshotStore } from "../catalog/store.js";
import { MediaServiceError } from "../media/service.js";
import { MediaObjectWriteError } from "../media/types.js";
import {
  isRetryExhaustedSubmissionFailure,
  MemoryPromptHubGenerationStore,
  MemoryPromptHubReferenceStore,
  PromptHubGenerationService,
  promptHubRecoveryLookupPath,
  type PromptHubReferenceStore,
} from "./prompt-hub-service.js";

const NOW = Date.parse("2026-08-07T10:00:00.000Z");
const OWNER_ID = "owner-1";
const quote = {
  id: "quote-video-1",
  modelId: "kling-o3-pro-v2v-reference",
  modelLabel: "Kling O3 Pro",
  modality: "video" as const,
  quantity: 1,
  normalizedParameters: { prompt: "animate", duration: 4, resolution: "720p" },
  creditMicros: 8_500_000,
  credits: "8.5",
  yuanMicros: 85_000,
  yuan: "0.085",
  estimated: false,
  pricingUnit: "request" as const,
  catalogVersion: "catalog-1",
  capabilityVersion: "capability-1",
  pricingVersion: "pricing-1",
  expiresAt: "2026-08-07T10:05:00.000Z",
};

describe("Prompt Hub submission recovery", () => {
  it("uses the modality-specific read-only lookup route", () => {
    const key = "canvas:request/with spaces";
    expect(promptHubRecoveryLookupPath("image", key)).toBe(
      "/api/v1/generate/requests/canvas%3Arequest%2Fwith%20spaces",
    );
    expect(promptHubRecoveryLookupPath("video", key)).toBe(
      "/api/v1/video/requests/canvas%3Arequest%2Fwith%20spaces",
    );
  });

  it("re-opens only the legacy false retry-exhaustion failure", () => {
    expect(isRetryExhaustedSubmissionFailure({
      status: "failed",
      error: {
        code: "GENERATION_SUBMISSION_RETRY_EXHAUSTED",
        message: "legacy false conclusion",
        retryable: true,
      },
    })).toBe(true);
    expect(isRetryExhaustedSubmissionFailure({
      status: "failed",
      error: { code: "GENERATION_FAILED", message: "real failure", retryable: false },
    })).toBe(false);
  });

  it("does not consume a paid submission attempt while a reference is temporarily unreadable", async () => {
    const store = new MemoryPromptHubGenerationStore();
    await seedRecord(store, { status: "submission_unknown" });
    const service = serviceWith(store, {
      fetch: async () => json({ ok: false, error: { code: "NOT_FOUND", message: "missing" } }, 404),
      readReference: async () => {
        throw new MediaServiceError("MEDIA_PROCESSING_UNAVAILABLE", "reference unavailable", 503);
      },
    });

    const result = await service.get(OWNER_ID, "canvas-video-job-1");
    const stored = await store.get(OWNER_ID, "canvas-video-job-1");

    expect(result.data.status).toBe("submission_unknown");
    expect(stored?.recovery).toBeUndefined();
    expect(stored?.job.error?.code).toBe("GENERATION_SUBMISSION_UNCONFIRMED");
  });

  it("re-opens a legacy exhausted node and binds the real refunded video task", async () => {
    const store = new MemoryPromptHubGenerationStore();
    await seedRecord(store, {
      status: "failed",
      recovery: { attempts: 8, lastAttemptAt: "2026-08-07T09:59:00.000Z" },
      error: {
        code: "GENERATION_SUBMISSION_RETRY_EXHAUSTED",
        message: "legacy false conclusion",
        retryable: true,
      },
    });
    const requested: string[] = [];
    const service = serviceWith(store, {
      fetch: async (input) => {
        requested.push(String(input));
        return json({
          ok: true,
          data: {
            jobId: "prompt-hub-video-job-1",
            status: "failed",
            progress: 0,
            errorMessage: "视频生成未完成，积分已自动退回",
            refunded: true,
          },
        });
      },
      readReference: async () => {
        throw new Error("reference preparation must not run after lookup recovery");
      },
    });

    const result = await service.get(OWNER_ID, "canvas-video-job-1");
    expect(result.data.status).toBe("submission_unknown");
    await service.settleObservation();
    const stored = await store.get(OWNER_ID, "canvas-video-job-1");

    expect(stored?.job).toMatchObject({
      status: "failed",
      error: { message: "视频生成未完成，积分已自动退回" },
    });
    expect(stored?.upstreamJobId).toBe("prompt-hub-video-job-1");
    expect(requested[0]).toContain("/api/v1/video/requests/");
    expect(requested[1]).toContain("/api/v1/video/jobs/prompt-hub-video-job-1");
  });
});

describe("hosted billing receipt", () => {
  const unreadableReference = async () => {
    throw new Error("reference preparation must not run after lookup recovery");
  };

  it("surfaces the upstream charge and refund instead of the estimate", async () => {
    const store = new MemoryPromptHubGenerationStore();
    await seedRecord(store, { status: "submission_unknown" });
    const service = serviceWith(store, {
      fetch: async () => json({
        ok: true,
        data: {
          jobId: "prompt-hub-video-job-1",
          status: "failed",
          progress: 0,
          errorMessage: "上游失败",
          refunded: true,
          creditsCharged: 8.5,
        },
      }),
      readReference: unreadableReference,
    });

    await service.get(OWNER_ID, "canvas-video-job-1");
    await service.settleObservation();

    const stored = await store.get(OWNER_ID, "canvas-video-job-1");
    expect(stored?.job.billing).toEqual({ chargedCreditMicros: 8_500_000, refunded: true });
  });

  it("never fabricates a charge the upstream did not report", async () => {
    const store = new MemoryPromptHubGenerationStore();
    await seedRecord(store, { status: "submission_unknown" });
    const service = serviceWith(store, {
      fetch: async () => json({
        ok: true,
        data: { jobId: "prompt-hub-video-job-1", status: "failed", progress: 0, errorMessage: "上游失败" },
      }),
      readReference: unreadableReference,
    });

    await service.get(OWNER_ID, "canvas-video-job-1");
    await service.settleObservation();

    const stored = await store.get(OWNER_ID, "canvas-video-job-1");
    // 报价是预估，缺回执就不写 billing——画布不给用户造一个「实扣」出来。
    expect(stored?.job.billing).toBeUndefined();
    expect(stored?.job.quote.credits).toBe("8.5");
  });
});

describe("hosted video result durability", () => {
  it("archives the first complete response and serves later reads without the upstream", async () => {
    const store = new MemoryPromptHubGenerationStore();
    const mediaId = "phm_canvas-video-job-archive_0";
    const timestamp = "2026-08-07T09:58:00.000Z";
    expect(await store.create({
      ownerId: OWNER_ID,
      idempotencyKey: "canvas:video-archive-request-001",
      upstreamJobId: "prompt-hub-video-archive-1",
      provider: "prompt-hub",
      resultUrls: [],
      job: {
        schemaVersion: 1,
        version: 2,
        id: "canvas-video-job-archive",
        projectId: "project-1",
        nodeId: "node-archive",
        modelId: quote.modelId,
        modelLabel: quote.modelLabel,
        modality: "video",
        status: "completed",
        progress: 100,
        quote,
        artifacts: [{
          id: "artifact-video-archive-0",
          kind: "video",
          mediaId,
          name: "H3.mp4",
          mimeType: "video/mp4",
          size: 0,
          createdAt: timestamp,
        }],
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: timestamp,
        completedAt: timestamp,
      },
    }, 100)).toBe("created");

    let upstreamReads = 0;
    let persistedBytes = Buffer.alloc(0);
    let durableReads = 0;
    const durable = Buffer.from("durable-video");
    const service = new PromptHubGenerationService(
      { createQuote: async () => quote },
      { resolveUpstreamAccess: async () => ({ data: { accessToken: "access-token" } }) },
      store,
      {
        apiBaseUrl: "https://prompt-hub.test",
        now: () => NOW,
        fetch: async (input) => {
          expect(new URL(String(input)).pathname).toBe("/api/v1/video/jobs/prompt-hub-video-archive-1/content");
          upstreamReads += 1;
          return new Response("upstream-video", {
            status: 200,
            headers: { "Content-Type": "video/mp4", "Content-Length": "14" },
          });
        },
        media: {
          readReference: async () => { throw new Error("unused"); },
          persistGenerated: async (_ownerId, input) => {
            const chunks: Buffer[] = [];
            for await (const chunk of input.source) chunks.push(Buffer.from(chunk));
            persistedBytes = Buffer.concat(chunks);
            return { ...readyMedia("video", "video/mp4"), size: persistedBytes.length };
          },
          get: async () => ({ ...readyMedia("video", "video/mp4"), size: durable.length }),
          open: async (_ownerId, _mediaId, range) => {
            durableReads += 1;
            const start = range?.start ?? 0;
            const end = range?.end ?? durable.length - 1;
            return {
              media: { ...readyMedia("video", "video/mp4"), size: durable.length },
              object: { stream: Readable.from(durable.subarray(start, end + 1)), totalSize: durable.length, start, end },
            };
          },
        },
      },
    );

    const first = await service.openMedia(OWNER_ID, mediaId);
    expect(await first.data.text()).toBe("durable-video");
    expect(persistedBytes.toString()).toBe("upstream-video");
    expect(upstreamReads).toBe(1);

    const second = await service.openMedia(OWNER_ID, mediaId, undefined, "bytes=2-5");
    expect(second.data.status).toBe(206);
    expect(second.data.headers.get("Content-Range")).toBe("bytes 2-5/13");
    expect(await second.data.text()).toBe("rabl");
    expect(upstreamReads).toBe(1);
    expect(durableReads).toBe(2);
    expect((await store.get(OWNER_ID, "canvas-video-job-archive"))?.archivedMediaIds).toEqual([
      "11111111-1111-4111-8111-111111111111",
    ]);
  });

  it("archives a completed video at completion instead of waiting for the first read", async () => {
    // 回归：托管成片地址是短时效签名链接。懒归档（等首次读取）会把一次链接过期
    // 变成永久打不开的结果，所以任务一到 completed 就必须把字节抓回画布存储。
    const store = new MemoryPromptHubGenerationStore();
    const mediaId = "phm_canvas-video-job-eager_0";
    const timestamp = "2026-08-07T09:58:00.000Z";
    expect(await store.create({
      ownerId: OWNER_ID,
      idempotencyKey: "canvas:video-eager-request-001",
      upstreamJobId: "prompt-hub-video-eager-1",
      provider: "prompt-hub",
      resultUrls: [],
      job: {
        schemaVersion: 1,
        version: 1,
        id: "canvas-video-job-eager",
        projectId: "project-1",
        nodeId: "node-eager",
        modelId: quote.modelId,
        modelLabel: quote.modelLabel,
        modality: "video",
        status: "running",
        progress: 48,
        quote,
        artifacts: [{
          id: "artifact-video-eager-0",
          kind: "video",
          mediaId,
          name: "wan.mp4",
          mimeType: "video/mp4",
          size: 0,
          createdAt: timestamp,
        }],
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: timestamp,
        completedAt: null,
      },
    }, 100)).toBe("created");

    let contentReads = 0;
    let persistedBytes = Buffer.alloc(0);
    const service = new PromptHubGenerationService(
      { createQuote: async () => quote },
      { resolveUpstreamAccess: async () => ({ data: { accessToken: "access-token" } }) },
      store,
      {
        apiBaseUrl: "https://prompt-hub.test",
        now: () => NOW,
        fetch: async (input) => {
          const path = new URL(String(input)).pathname;
          if (path === "/api/v1/video/jobs/prompt-hub-video-eager-1") {
            return json({
              ok: true,
              data: { jobId: "prompt-hub-video-eager-1", status: "completed", progress: 100, videoUrl: "https://upstream.test/wan.mp4" },
            });
          }
          if (path === "/api/v1/video/jobs/prompt-hub-video-eager-1/content") {
            contentReads += 1;
            return new Response("eager-video", {
              status: 200,
              headers: { "Content-Type": "video/mp4", "Content-Length": "11" },
            });
          }
          throw new Error(`unexpected request ${path}`);
        },
        media: {
          readReference: async () => { throw new Error("unused"); },
          persistGenerated: async (_ownerId, input) => {
            const chunks: Buffer[] = [];
            for await (const chunk of input.source) chunks.push(Buffer.from(chunk));
            persistedBytes = Buffer.concat(chunks);
            return { ...readyMedia("video", "video/mp4"), size: persistedBytes.length };
          },
        },
      },
    );

    // 只观察一次任务状态，不读取任何媒体。
    await service.get(OWNER_ID, "canvas-video-job-eager");
    await service.settleObservation();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const record = await store.get(OWNER_ID, "canvas-video-job-eager");
      if (record?.archivedMediaIds?.[0]) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const stored = await store.get(OWNER_ID, "canvas-video-job-eager");
    expect(stored?.job.status).toBe("completed");
    expect(stored?.archivedMediaIds?.[0]).toBe("11111111-1111-4111-8111-111111111111");
    expect(persistedBytes.toString()).toBe("eager-video");
    expect(contentReads).toBe(1);
  });
});

describe("hosted image result durability", () => {
  const imageQuote: GenerationQuote = {
    id: "quote-image-durability-1",
    modelId: "gpt-image2",
    modelLabel: "GPT-Image2",
    modality: "image",
    quantity: 1,
    normalizedParameters: { prompt: "a cat", resolution: "1k" },
    creditMicros: 60_000,
    credits: "0.06",
    yuanMicros: 600,
    yuan: "0.0006",
    estimated: false,
    pricingUnit: "request",
    catalogVersion: "catalog-1",
    capabilityVersion: "capability-1",
    pricingVersion: "pricing-1",
    expiresAt: "2026-08-07T10:05:00.000Z",
    outputCount: 1,
  };

  it("archives the first complete image read and serves later reads without the upstream", async () => {
    const store = new MemoryPromptHubGenerationStore();
    const mediaId = "phm_canvas-image-job-archive_0";
    const timestamp = "2026-08-07T09:58:00.000Z";
    expect(await store.create({
      ownerId: OWNER_ID,
      idempotencyKey: "canvas:image-archive-request-001",
      upstreamJobId: "prompt-hub-image-archive-1",
      provider: "prompt-hub",
      resultUrls: ["https://media.example/image-archive-0.png"],
      job: {
        schemaVersion: 1,
        version: 2,
        id: "canvas-image-job-archive",
        projectId: "project-1",
        nodeId: "node-image-archive",
        modelId: imageQuote.modelId,
        modelLabel: imageQuote.modelLabel,
        modality: "image",
        status: "completed",
        progress: 100,
        quote: imageQuote,
        artifacts: [{
          id: "artifact-image-archive-0",
          kind: "image",
          mediaId,
          name: "GPT-Image2-1.png",
          mimeType: "image/png",
          size: 0,
          createdAt: timestamp,
        }],
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: timestamp,
        completedAt: timestamp,
      },
    }, 100)).toBe("created");

    let upstreamReads = 0;
    let persistedBytes = Buffer.alloc(0);
    let durableReads = 0;
    const durable = Buffer.from("durable-image");
    const service = new PromptHubGenerationService(
      { createQuote: async () => imageQuote },
      { resolveUpstreamAccess: async () => ({ data: { accessToken: "access-token" } }) },
      store,
      {
        apiBaseUrl: "https://prompt-hub.test",
        now: () => NOW,
        fetch: async (input) => {
          expect(new URL(String(input)).pathname).toBe("/image-archive-0.png");
          upstreamReads += 1;
          return new Response("upstream-image", {
            status: 200,
            headers: { "Content-Type": "image/png", "Content-Length": "14" },
          });
        },
        media: {
          readReference: async () => { throw new Error("unused"); },
          persistGenerated: async (_ownerId, input) => {
            const chunks: Buffer[] = [];
            for await (const chunk of input.source) chunks.push(Buffer.from(chunk));
            persistedBytes = Buffer.concat(chunks);
            return { ...readyMedia("image", "image/png"), size: persistedBytes.length };
          },
          get: async () => ({ ...readyMedia("image", "image/png"), size: durable.length }),
          open: async (_ownerId, _mediaId, range) => {
            durableReads += 1;
            const start = range?.start ?? 0;
            const end = range?.end ?? durable.length - 1;
            return {
              media: { ...readyMedia("image", "image/png"), size: durable.length },
              object: { stream: Readable.from(durable.subarray(start, end + 1)), totalSize: durable.length, start, end },
            };
          },
        },
      },
    );

    const first = await service.openMedia(OWNER_ID, mediaId);
    expect(await first.data.text()).toBe("durable-image");
    expect(persistedBytes.toString()).toBe("upstream-image");
    expect(upstreamReads).toBe(1);

    // 归档后的第二次读取（含 Range）不再触碰中继链接。
    const second = await service.openMedia(OWNER_ID, mediaId, undefined, "bytes=0-5");
    expect(second.data.status).toBe(206);
    expect(await second.data.text()).toBe("durabl");
    expect(upstreamReads).toBe(1);
    expect(durableReads).toBe(2);
    expect((await store.get(OWNER_ID, "canvas-image-job-archive"))?.archivedMediaIds).toEqual([
      "11111111-1111-4111-8111-111111111111",
    ]);
  });

  it("archives a completed image at completion instead of waiting for the first read", async () => {
    // 回归：中继的图片链接在 30 小时后失效（`images/` 保留期收紧）。懒归档
    // （等首次读取）会把一次链接过期变成永久打不开、也无法再保存到云端的结果，
    // 所以出图一到 completed 就必须把字节抓回画布存储——与成片同一策略。
    const store = new MemoryPromptHubGenerationStore();
    const mediaId = "phm_canvas-image-job-eager_0";
    const timestamp = "2026-08-07T09:58:00.000Z";
    expect(await store.create({
      ownerId: OWNER_ID,
      idempotencyKey: "canvas:image-eager-request-001",
      upstreamJobId: "prompt-hub-image-eager-1",
      provider: "prompt-hub",
      resultUrls: [],
      job: {
        schemaVersion: 1,
        version: 1,
        id: "canvas-image-job-eager",
        projectId: "project-1",
        nodeId: "node-image-eager",
        modelId: imageQuote.modelId,
        modelLabel: imageQuote.modelLabel,
        modality: "image",
        status: "running",
        progress: 48,
        quote: imageQuote,
        artifacts: [{
          id: "artifact-image-eager-0",
          kind: "image",
          mediaId,
          name: "GPT-Image2-1.png",
          mimeType: "image/png",
          size: 0,
          createdAt: timestamp,
        }],
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: timestamp,
        completedAt: null,
      },
    }, 100)).toBe("created");

    let imageReads = 0;
    let persistedBytes = Buffer.alloc(0);
    const service = new PromptHubGenerationService(
      { createQuote: async () => imageQuote },
      { resolveUpstreamAccess: async () => ({ data: { accessToken: "access-token" } }) },
      store,
      {
        apiBaseUrl: "https://prompt-hub.test",
        now: () => NOW,
        fetch: async (input) => {
          const path = new URL(String(input)).pathname;
          if (path === "/api/v1/generate/jobs/prompt-hub-image-eager-1") {
            return json({
              ok: true,
              data: {
                jobId: "prompt-hub-image-eager-1",
                status: "completed",
                progress: 100,
                images: ["https://media.example/eager-0.png"],
              },
            });
          }
          if (path === "/eager-0.png") {
            imageReads += 1;
            return new Response("eager-image", {
              status: 200,
              headers: { "Content-Type": "image/png", "Content-Length": "11" },
            });
          }
          throw new Error(`unexpected request ${path}`);
        },
        media: {
          readReference: async () => { throw new Error("unused"); },
          persistGenerated: async (_ownerId, input) => {
            const chunks: Buffer[] = [];
            for await (const chunk of input.source) chunks.push(Buffer.from(chunk));
            persistedBytes = Buffer.concat(chunks);
            return { ...readyMedia("image", "image/png"), size: persistedBytes.length };
          },
        },
      },
    );

    // 只观察一次任务状态，不读取任何媒体。
    await service.get(OWNER_ID, "canvas-image-job-eager");
    await service.settleObservation();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const record = await store.get(OWNER_ID, "canvas-image-job-eager");
      if (record?.archivedMediaIds?.[0]) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const stored = await store.get(OWNER_ID, "canvas-image-job-eager");
    expect(stored?.job.status).toBe("completed");
    expect(stored?.archivedMediaIds?.[0]).toBe("11111111-1111-4111-8111-111111111111");
    expect(persistedBytes.toString()).toBe("eager-image");
    expect(imageReads).toBe(1);
  });

  it("stops re-attempting a failed archive until the cooldown expires", async () => {
    // 回归：一轮存储故障里，如果每次读都去试一遍补档，画廊一页几十张图
    // 就各自等满一次存储连接超时——用户看到的是"图要过一会儿才出来"。
    const store = new MemoryPromptHubGenerationStore();
    const mediaId = "phm_canvas-image-job-cooldown_0";
    const timestamp = "2026-08-07T09:58:00.000Z";
    expect(await store.create({
      ownerId: OWNER_ID,
      idempotencyKey: "canvas:image-cooldown-request-001",
      upstreamJobId: "prompt-hub-image-cooldown-1",
      provider: "prompt-hub",
      resultUrls: ["https://media.example/image-cooldown-0.png"],
      job: {
        schemaVersion: 1,
        version: 2,
        id: "canvas-image-job-cooldown",
        projectId: "project-1",
        nodeId: "node-image-cooldown",
        modelId: imageQuote.modelId,
        modelLabel: imageQuote.modelLabel,
        modality: "image",
        status: "completed",
        progress: 100,
        quote: imageQuote,
        artifacts: [{
          id: "artifact-image-cooldown-0",
          kind: "image",
          mediaId,
          name: "GPT-Image2-1.png",
          mimeType: "image/png",
          size: 0,
          createdAt: timestamp,
        }],
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: timestamp,
        completedAt: timestamp,
      },
    }, 100)).toBe("created");

    let now = NOW;
    let archiveAttempts = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const service = new PromptHubGenerationService(
      { createQuote: async () => imageQuote },
      { resolveUpstreamAccess: async () => ({ data: { accessToken: "access-token" } }) },
      store,
      {
        apiBaseUrl: "https://prompt-hub.test",
        now: () => now,
        archiveRetryCooldownMs: 60_000,
        fetch: async () => new Response("upstream-image", {
          status: 200,
          headers: { "Content-Type": "image/png", "Content-Length": "14" },
        }),
        media: {
          readReference: async () => { throw new Error("unused"); },
          persistGenerated: async () => {
            archiveAttempts += 1;
            throw new MediaObjectWriteError("MEDIA_STORAGE_UNAVAILABLE", "素材存储暂时不可达，请重试", false);
          },
        },
      },
    );

    // 首次读取：补档失败，但读取本身必须成功回上游内容。
    const first = await service.openMedia(OWNER_ID, mediaId);
    expect(await first.data.text()).toBe("upstream-image");
    expect(archiveAttempts).toBe(1);

    // 冷却期内再读：不再打存储，直接回上游内容。
    const second = await service.openMedia(OWNER_ID, mediaId);
    expect(await second.data.text()).toBe("upstream-image");
    expect(archiveAttempts).toBe(1);

    // 冷却到期后恢复补档尝试。
    now += 60_001;
    const third = await service.openMedia(OWNER_ID, mediaId);
    expect(await third.data.text()).toBe("upstream-image");
    expect(archiveAttempts).toBe(2);
    warn.mockRestore();
  });
});

describe("hosted image gallery settling", () => {
  const imageQuote: GenerationQuote = {
    id: "quote-image-mj-1",
    modelId: "mj-v82",
    modelLabel: "Midjourney 8.2",
    modality: "image",
    quantity: 1,
    normalizedParameters: { prompt: "four panels", aspect_ratio: "1:1" },
    creditMicros: 10_000,
    credits: "0.01",
    yuanMicros: 1,
    yuan: "0.000001",
    estimated: false,
    pricingUnit: "request",
    catalogVersion: "catalog-1",
    capabilityVersion: "capability-1",
    pricingVersion: "pricing-1",
    expiresAt: "2026-08-07T10:05:00.000Z",
    outputCount: 4,
  };

  function imageGalleryService(store: MemoryPromptHubGenerationStore, fetchImpl: typeof fetch) {
    return new PromptHubGenerationService(
      { createQuote: async () => imageQuote },
      { resolveUpstreamAccess: async () => ({ data: { accessToken: "access-token" } }) },
      store,
      {
        apiBaseUrl: "https://prompt-hub.test",
        now: () => NOW,
        fetch: fetchImpl,
        media: { readReference: async () => { throw new Error("unused"); } },
        resultUrlRetryDelaysMs: [1, 1, 1],
        mediaRetryDelaysMs: [1, 1, 1, 1],
      },
    );
  }

  async function seedCompletedImageGallery(store: MemoryPromptHubGenerationStore) {
    const timestamp = "2026-08-07T09:58:00.000Z";
    const jobId = "canvas-image-job-gallery";
    const mediaIds = Array.from({ length: 4 }, (_, index) => `phm_${jobId.slice(4)}_${index}`);
    expect(await store.create({
      ownerId: OWNER_ID,
      idempotencyKey: "canvas:image-gallery-request-001",
      upstreamJobId: "prompt-hub-gallery-job-1",
      provider: "prompt-hub",
      resultUrls: mediaIds.map((_id, index) => `https://media.example/gallery-${index}.png`),
      job: {
        schemaVersion: 1,
        version: 2,
        id: jobId,
        projectId: "project-1",
        nodeId: "node-gallery",
        modelId: imageQuote.modelId,
        modelLabel: imageQuote.modelLabel,
        modality: "image",
        status: "completed",
        progress: 100,
        quote: imageQuote,
        artifacts: mediaIds.map((mediaId, index) => ({
          id: `artifact-${jobId}-${index}`,
          kind: "image" as const,
          mediaId,
          name: `Midjourney 8.2-${index + 1}.png`,
          mimeType: "image/png",
          size: 0,
          createdAt: timestamp,
        })),
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: timestamp,
        completedAt: timestamp,
      },
    }, 100)).toBe("created");
    return mediaIds;
  }

  it("retries a briefly-404ing gallery URL until the image settles", async () => {
    const store = new MemoryPromptHubGenerationStore();
    const mediaIds = await seedCompletedImageGallery(store);
    const callsByUrl = new Map<string, number>();
    const service = imageGalleryService(store, async (input) => {
      const url = String(input);
      callsByUrl.set(url, (callsByUrl.get(url) ?? 0) + 1);
      if (url === "https://media.example/gallery-1.png" && callsByUrl.get(url)! < 3) {
        return new Response("missing", { status: 404 });
      }
      return new Response("gallery-image", { status: 200, headers: { "Content-Type": "image/png" } });
    });

    const result = await service.openMedia(OWNER_ID, mediaIds[1]!);

    expect(result.data.status).toBe(200);
    expect(await result.data.text()).toBe("gallery-image");
    expect(callsByUrl.get("https://media.example/gallery-1.png")).toBe(3);
  });

  it("falls back to the indexed route and retries a missing gallery index", async () => {
    const store = new MemoryPromptHubGenerationStore();
    const mediaIds = await seedCompletedImageGallery(store);
    const callsByUrl = new Map<string, number>();
    const service = imageGalleryService(store, async (input) => {
      const url = String(input);
      callsByUrl.set(url, (callsByUrl.get(url) ?? 0) + 1);
      if (url === "https://media.example/gallery-2.png") return new Response("missing", { status: 404 });
      if (url.startsWith("https://prompt-hub.test/api/v1/generate/jobs/prompt-hub-gallery-job-1/image?index=2")) {
        return callsByUrl.get(url)! < 2
          ? new Response("not archived yet", { status: 404 })
          : new Response("gallery-image-2", { status: 200, headers: { "Content-Type": "image/png" } });
      }
      throw new Error(`unexpected request ${url}`);
    });

    const result = await service.openMedia(OWNER_ID, mediaIds[2]!);

    expect(result.data.status).toBe(200);
    expect(await result.data.text()).toBe("gallery-image-2");
    const fallbackCalls = callsByUrl.get("https://prompt-hub.test/api/v1/generate/jobs/prompt-hub-gallery-job-1/image?index=2");
    expect(fallbackCalls).toBe(2);
  });
});

describe("hosted submission truth", () => {
  it("only accepts a validated durable task id as queued/running", async () => {
    const store = new MemoryPromptHubGenerationStore();
    const service = serviceWith(store, {
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/api/v1/video")) {
          return json({ ok: true, data: { jobId: "upstream-video-job-1", status: "running", progress: 40 } });
        }
        throw new Error(`unexpected request ${url}`);
      },
      readReference: async () => {
        throw new Error("no references expected");
      },
    });

    const result = await service.submit(OWNER_ID, videoSubmission());

    expect(result.data.status).toBe("running");
    expect(result.data.progress).toBe(40);
    const stored = await store.get(OWNER_ID, result.data.id);
    expect(stored?.upstreamJobId).toBe("upstream-video-job-1");
  });

  it("maps Kling O3 Pro frame, style, element, and source-video references to canonical fields", async () => {
    const store = new MemoryPromptHubGenerationStore();
    const bodies: Array<Record<string, unknown>> = [];
    let uploadedReference = 0;
    const service = serviceWith(store, {
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v1/media/upload") {
          uploadedReference += 1;
          return json({ ok: true, data: { ref: `https://media.example/reference-${uploadedReference}` } });
        }
        if (url.pathname === "/api/v1/video") {
          bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return json({ ok: true, data: { jobId: "upstream-o3-reference-job-1", status: "running", progress: 12 } });
        }
        throw new Error(`unexpected request ${String(input)}`);
      },
      readReference: async (_ownerId, _mediaId, kind) => ({
        media: readyMedia(kind, kind === "video" ? "video/mp4" : "image/png"),
        bytes: Buffer.from(`${kind}-reference`),
      }),
    });
    const submission = {
      ...videoSubmission(),
      inputs: {
        images: ["frame-reference"],
        styleImages: ["style-reference"],
        elementImages: ["element-reference"],
        videos: ["source-video-reference"],
        audios: [],
      },
      idempotencyKey: "canvas:o3-reference-request-001",
    };

    const result = await service.submit(OWNER_ID, submission);
    const replay = await service.submit(OWNER_ID, submission);

    expect(result.data.status).toBe("running");
    expect(replay.data.id).toBe(result.data.id);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      images: ["https://media.example/reference-1"],
      style_references: ["https://media.example/reference-2"],
      element_references: ["https://media.example/reference-3"],
      input_video: "https://media.example/reference-4",
    });
    expect(bodies[0]).not.toHaveProperty("styleImages");
    expect(bodies[0]).not.toHaveProperty("elementImages");
    expect(bodies[0]).not.toHaveProperty("referenceImages");
    expect(bodies[0]).not.toHaveProperty("referenceVideos");
    expect(bodies[0]).not.toHaveProperty("referenceAudios");
    expect(String(bodies[0]?.prompt)).not.toContain("https://media.example/reference-4");
  });

  it("projects canonical video controls for the legacy Prompt Hub envelope", async () => {
    const canonicalQuote: GenerationQuote = {
      ...quote,
      id: "quote-veo-lite-1",
      modelId: "veo-3.1-lite",
      modelLabel: "Veo 3.1 Lite",
      normalizedParameters: {
        prompt: "让主体自然移动",
        duration_seconds: 8,
        aspect_ratio: "16:9",
        resolution: "720p",
      },
    };
    const store = new MemoryPromptHubGenerationStore();
    const bodies: Array<Record<string, unknown>> = [];
    const service = serviceWith(store, {
      quote: canonicalQuote,
      fetch: async (input, init) => {
        if (new URL(String(input)).pathname === "/api/v1/video") {
          bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return json({ ok: true, data: { jobId: "upstream-veo-lite-job-1", status: "running", progress: 4 } });
        }
        throw new Error(`unexpected request ${String(input)}`);
      },
      readReference: async () => { throw new Error("no references expected"); },
    });

    const result = await service.submit(OWNER_ID, {
      ...videoSubmission(),
      modelId: canonicalQuote.modelId,
      parameters: canonicalQuote.normalizedParameters,
      expectedQuote: {
        id: canonicalQuote.id,
        modelId: canonicalQuote.modelId,
        creditMicros: canonicalQuote.creditMicros,
        pricingVersion: canonicalQuote.pricingVersion,
        expiresAt: canonicalQuote.expiresAt,
      },
      idempotencyKey: "canvas:veo-lite-request-001",
    });

    expect(result.data.status).toBe("running");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      duration: 8,
      ratio: "16:9",
      resolution: "720p",
    });
    expect(bodies[0]).not.toHaveProperty("duration_seconds");
    expect(bodies[0]).not.toHaveProperty("aspect_ratio");
  });

  it.each(["2K", "4K"] as const)("routes H3 %s through the reference workflow", async (resolution) => {
    const h3 = h3VideoQuote(resolution);
    const store = new MemoryPromptHubGenerationStore();
    const bodies: Array<Record<string, unknown>> = [];
    const service = serviceWith(store, {
      quote: h3,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v1/media/upload") {
          return json({ ok: true, data: { ref: "https://media.example/h3-reference.png" } });
        }
        if (url.pathname === "/api/v1/video") {
          bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return json({ ok: true, data: { jobId: `upstream-h3-${resolution}`, status: "running", progress: 7 } });
        }
        throw new Error(`unexpected request ${String(input)}`);
      },
      readReference: async (_ownerId, _mediaId, kind) => ({
        media: readyMedia(kind, "image/png"),
        bytes: Buffer.from("h3-reference"),
      }),
    });

    const result = await service.submit(OWNER_ID, {
      ...videoSubmission(),
      modelId: h3.modelId,
      parameters: h3.normalizedParameters,
      inputs: { images: ["h3-reference-media"], styleImages: [], elementImages: [], videos: [], audios: [] },
      expectedQuote: {
        id: h3.id,
        modelId: h3.modelId,
        creditMicros: h3.creditMicros,
        pricingVersion: h3.pricingVersion,
        expiresAt: h3.expiresAt,
      },
      idempotencyKey: `canvas:h3-${resolution.toLowerCase()}-request-001`,
    });

    expect(result.data.status).toBe("running");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      workflow_id: "cf-multi-reference",
      size: resolution,
      duration: 4,
      ratio: "16:9",
      referenceImages: ["https://media.example/h3-reference.png"],
    });
    expect(bodies[0]).not.toHaveProperty("resolution");
    expect(bodies[0]).not.toHaveProperty("duration_seconds");
    expect(bodies[0]).not.toHaveProperty("aspect_ratio");
  });

  it("rejects H3 2K/4K without an image before the provider POST", async () => {
    const h3 = h3VideoQuote("4K");
    const store = new MemoryPromptHubGenerationStore();
    let providerPosts = 0;
    const service = serviceWith(store, {
      quote: h3,
      fetch: async (input) => {
        if (new URL(String(input)).pathname === "/api/v1/video") providerPosts += 1;
        throw new Error(`unexpected request ${String(input)}`);
      },
      readReference: async () => { throw new Error("no reference should be prepared"); },
    });

    await expect(service.submit(OWNER_ID, {
      ...videoSubmission(),
      modelId: h3.modelId,
      parameters: h3.normalizedParameters,
      expectedQuote: {
        id: h3.id,
        modelId: h3.modelId,
        creditMicros: h3.creditMicros,
        pricingVersion: h3.pricingVersion,
        expiresAt: h3.expiresAt,
      },
      idempotencyKey: "canvas:h3-4k-no-image-request-001",
    })).rejects.toMatchObject({ code: "H3_REFERENCE_REQUIRED" });
    expect(providerPosts).toBe(0);
  });

  it("keeps ordinary H3 1080p on the normal video workflow", async () => {
    const h3 = h3VideoQuote("1080p");
    const store = new MemoryPromptHubGenerationStore();
    const bodies: Array<Record<string, unknown>> = [];
    const service = serviceWith(store, {
      quote: h3,
      fetch: async (input, init) => {
        if (new URL(String(input)).pathname !== "/api/v1/video") throw new Error(`unexpected request ${String(input)}`);
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({ ok: true, data: { jobId: "upstream-h3-1080p", status: "running", progress: 6 } });
      },
      readReference: async () => { throw new Error("no references expected"); },
    });

    await expect(service.submit(OWNER_ID, {
      ...videoSubmission(),
      modelId: h3.modelId,
      parameters: h3.normalizedParameters,
      expectedQuote: {
        id: h3.id,
        modelId: h3.modelId,
        creditMicros: h3.creditMicros,
        pricingVersion: h3.pricingVersion,
        expiresAt: h3.expiresAt,
      },
      idempotencyKey: "canvas:h3-1080p-request-001",
    })).resolves.toMatchObject({ data: { status: "running" } });
    expect(bodies[0]).toMatchObject({ resolution: "1080p", duration: 4, ratio: "16:9" });
    expect(bodies[0]).not.toHaveProperty("workflow_id");
    expect(bodies[0]).not.toHaveProperty("size");
  });

  it("sends H3 reference video durations aligned with the reference videos", async () => {
    // 线上事故签名：视频节点连上参考视频后 H3 整单 400「请求参数无效」——上游
    // 要求 referenceVideos 与 referenceVideoDurations 成对出现，画布侧必须把
    // 客户端量好的时长原样发出。
    const h3 = h3VideoQuote("1080p", { referenceVideoDurations: [6.5] });
    const store = new MemoryPromptHubGenerationStore();
    const bodies: Array<Record<string, unknown>> = [];
    const service = serviceWith(store, {
      quote: h3,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v1/media/upload") {
          return json({ ok: true, data: { ref: "https://media.example/h3-reference.mp4" } });
        }
        if (url.pathname === "/api/v1/video") {
          bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return json({ ok: true, data: { jobId: "upstream-h3-video-reference", status: "running", progress: 7 } });
        }
        throw new Error(`unexpected request ${String(input)}`);
      },
      readReference: async (_ownerId, _mediaId, kind) => ({
        media: readyMedia(kind, "video/mp4"),
        bytes: Buffer.from("h3-video-reference"),
      }),
    });

    const result = await service.submit(OWNER_ID, {
      ...videoReferenceSubmission(),
      modelId: h3.modelId,
      parameters: h3.normalizedParameters,
      expectedQuote: {
        id: h3.id,
        modelId: h3.modelId,
        creditMicros: h3.creditMicros,
        pricingVersion: h3.pricingVersion,
        expiresAt: h3.expiresAt,
      },
      idempotencyKey: "canvas:h3-video-reference-request-001",
    });

    expect(result.data.status).toBe("running");
    expect(bodies[0]).toMatchObject({
      referenceVideos: ["https://media.example/h3-reference.mp4"],
      referenceVideoDurations: [6.5],
    });
  });

  it("derives H3 reference video durations from media metadata when the client omits them", async () => {
    // 不会在本地量时长的客户端（快速生成页、老版本画布）靠服务端从素材元数据
    // 兜底：工程作用域查不到的个人素材再按个人作用域读一次，与参考素材准备的
    // 兜底顺序一致。
    const h3 = h3VideoQuote("1080p");
    const store = new MemoryPromptHubGenerationStore();
    const bodies: Array<Record<string, unknown>> = [];
    const scopedLookups: Array<string | undefined> = [];
    const service = serviceWith(store, {
      quote: h3,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v1/media/upload") {
          return json({ ok: true, data: { ref: "https://media.example/h3-reference.mp4" } });
        }
        if (url.pathname === "/api/v1/video") {
          bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return json({ ok: true, data: { jobId: "upstream-h3-video-durations", status: "running", progress: 7 } });
        }
        throw new Error(`unexpected request ${String(input)}`);
      },
      readReference: async (_ownerId, _mediaId, kind) => ({
        media: readyMedia(kind, "video/mp4"),
        bytes: Buffer.from("h3-video-reference"),
      }),
      mediaGet: async (_ownerId, mediaId, projectId) => {
        scopedLookups.push(projectId);
        if (projectId) {
          throw new MediaServiceError("MEDIA_NOT_FOUND", "没有找到这个素材", 404);
        }
        return readyMedia("video", "video/mp4");
      },
    });

    const result = await service.submit(OWNER_ID, {
      ...videoReferenceSubmission(),
      modelId: h3.modelId,
      parameters: h3.normalizedParameters,
      expectedQuote: {
        id: h3.id,
        modelId: h3.modelId,
        creditMicros: h3.creditMicros,
        pricingVersion: h3.pricingVersion,
        expiresAt: h3.expiresAt,
      },
      idempotencyKey: "canvas:h3-video-durations-request-001",
    });

    expect(result.data.status).toBe("running");
    expect(scopedLookups).toEqual(["project-1", undefined]);
    expect(bodies[0]).toMatchObject({
      referenceVideos: ["https://media.example/h3-reference.mp4"],
      referenceVideoDurations: [1],
    });
  });

  it("derives H3 reference video durations from the hosted job artifact", async () => {
    // 画布主路径：参考视频是刚生成的视频节点。工件完成时不带时长，服务端在
    // 内容被播放/下载（归档路径）时探测回写到工件上——推导必须能读到它，
    // 否则用户连一条自己刚生成的视频都会被「请求参数无效」挡死。
    const h3 = h3VideoQuote("1080p");
    const store = new MemoryPromptHubGenerationStore();
    await store.create({
      ownerId: OWNER_ID,
      idempotencyKey: "canvas:generated-video-001",
      upstreamJobId: "upstream-generated-video",
      provider: "prompt-hub" as const,
      resultUrls: [],
      archivedMediaIds: [],
      submission: {
        projectId: "project-1",
        nodeId: "generator-node",
        modelId: h3.modelId,
        modality: "video" as const,
        parameters: h3.normalizedParameters,
        inputs: { images: [], styleImages: [], elementImages: [], videos: [], audios: [] },
        quantity: 1,
        expectedQuote: {
          id: h3.id,
          modelId: h3.modelId,
          creditMicros: h3.creditMicros,
          pricingVersion: h3.pricingVersion,
          expiresAt: h3.expiresAt,
        },
        idempotencyKey: "canvas:generated-video-001",
      },
      job: {
        schemaVersion: 1 as const,
        version: 1,
        id: "phj_generated_video",
        projectId: "project-1",
        nodeId: "generator-node",
        modelId: h3.modelId,
        modelLabel: h3.modelLabel,
        modality: "video" as const,
        status: "completed",
        progress: 100,
        quote: h3,
        artifacts: [{
          id: "artifact_phj_generated_video_0",
          kind: "video" as const,
          mediaId: "video-reference-media-1",
          name: "生成视频.mp4",
          mimeType: "video/mp4",
          size: 1024,
          duration: 6.5,
          createdAt: "2026-08-07T09:58:00.000Z",
        }],
        error: null,
        createdAt: "2026-08-07T09:58:00.000Z",
        updatedAt: "2026-08-07T09:59:00.000Z",
        startedAt: "2026-08-07T09:58:00.000Z",
        completedAt: "2026-08-07T09:59:00.000Z",
      },
    }, 100);
    const bodies: Array<Record<string, unknown>> = [];
    const service = serviceWith(store, {
      quote: h3,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v1/video/jobs/upstream-generated-video/content") {
          return new Response(Buffer.from("h3-generated-video-bytes"), {
            status: 200,
            headers: { "Content-Type": "video/mp4" },
          });
        }
        if (url.pathname === "/api/v1/media/upload") {
          return json({ ok: true, data: { ref: "https://media.example/h3-generated.mp4" } });
        }
        if (url.pathname === "/api/v1/video") {
          bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return json({ ok: true, data: { jobId: "upstream-h3-generated-ref", status: "running", progress: 7 } });
        }
        throw new Error(`unexpected request ${String(input)}`);
      },
      // 素材库里没有这条视频的记录：时长只能来自任务工件。
      readReference: async (_ownerId, _mediaId, kind) => ({
        media: readyMedia(kind, "video/mp4"),
        bytes: Buffer.from("h3-generated-video-bytes"),
      }),
    });

    const result = await service.submit(OWNER_ID, {
      ...videoReferenceSubmission(),
      modelId: h3.modelId,
      parameters: h3.normalizedParameters,
      expectedQuote: {
        id: h3.id,
        modelId: h3.modelId,
        creditMicros: h3.creditMicros,
        pricingVersion: h3.pricingVersion,
        expiresAt: h3.expiresAt,
      },
      idempotencyKey: "canvas:h3-generated-ref-request-001",
    });

    expect(result.data.status).toBe("running");
    expect(bodies[0]).toMatchObject({
      referenceVideos: ["https://media.example/h3-generated.mp4"],
      referenceVideoDurations: [6.5],
    });
  });

  it("fails definitively when H3 reference video durations cannot be determined", async () => {
    const h3 = h3VideoQuote("1080p");
    const store = new MemoryPromptHubGenerationStore();
    let providerPosts = 0;
    const service = serviceWith(store, {
      quote: h3,
      fetch: async (input) => {
        if (new URL(String(input)).pathname === "/api/v1/media/upload") {
          return json({ ok: true, data: { ref: "https://media.example/h3-reference.mp4" } });
        }
        if (new URL(String(input)).pathname === "/api/v1/video") providerPosts += 1;
        throw new Error(`unexpected request ${String(input)}`);
      },
      readReference: async (_ownerId, _mediaId, kind) => ({
        media: readyMedia(kind, "video/mp4"),
        bytes: Buffer.from("h3-video-reference"),
      }),
      // 素材没有探测出时长（老素材）：明确失败，不再拿一个缺字段的请求去上游
      // 换一句「请求参数无效」。
      mediaGet: async () => ({ ...readyMedia("video", "video/mp4"), durationMs: null }),
    });

    await expect(service.submit(OWNER_ID, {
      ...videoReferenceSubmission(),
      modelId: h3.modelId,
      parameters: h3.normalizedParameters,
      expectedQuote: {
        id: h3.id,
        modelId: h3.modelId,
        creditMicros: h3.creditMicros,
        pricingVersion: h3.pricingVersion,
        expiresAt: h3.expiresAt,
      },
      idempotencyKey: "canvas:h3-video-durations-missing-001",
    })).rejects.toMatchObject({ code: "REFERENCE_VIDEO_DURATION_REQUIRED" });
    expect(providerPosts).toBe(0);
  });

  it("rejects H3 reference videos whose total duration exceeds the catalog cap", async () => {
    const h3 = h3VideoQuote("1080p", { referenceVideoDurations: [10, 6] });
    const store = new MemoryPromptHubGenerationStore();
    let providerPosts = 0;
    const service = serviceWith(store, {
      quote: h3,
      fetch: async (input) => {
        if (new URL(String(input)).pathname === "/api/v1/media/upload") {
          return json({ ok: true, data: { ref: "https://media.example/h3-reference.mp4" } });
        }
        if (new URL(String(input)).pathname === "/api/v1/video") providerPosts += 1;
        throw new Error(`unexpected request ${String(input)}`);
      },
      readReference: async (_ownerId, _mediaId, kind) => ({
        media: readyMedia(kind, "video/mp4"),
        bytes: Buffer.from("h3-video-reference"),
      }),
    });

    await expect(service.submit(OWNER_ID, {
      ...videoReferenceSubmission(),
      modelId: h3.modelId,
      parameters: h3.normalizedParameters,
      inputs: {
        images: [],
        styleImages: [],
        elementImages: [],
        videos: ["video-reference-media-1", "video-reference-media-2"],
        audios: [],
      },
      expectedQuote: {
        id: h3.id,
        modelId: h3.modelId,
        creditMicros: h3.creditMicros,
        pricingVersion: h3.pricingVersion,
        expiresAt: h3.expiresAt,
      },
      idempotencyKey: "canvas:h3-video-durations-over-001",
    })).rejects.toMatchObject({ code: "REFERENCE_VIDEO_DURATION_LIMIT" });
    expect(providerPosts).toBe(0);
  });

  it("submits hosted image generation through image.v1 with semantic references and Canvas metadata", async () => {
    const imageQuote: GenerationQuote = {
      id: "quote-image-1",
      modelId: "image-model-1",
      modelLabel: "Image Model",
      modality: "image",
      quantity: 1,
      outputCount: 2,
      normalizedParameters: {
        prompt: "a paper lantern over a quiet lake",
        resolution: "2k",
        aspect_ratio: "16:9",
        quality: "high",
      },
      creditMicros: 2_000_000,
      credits: "2",
      yuanMicros: 20_000,
      yuan: "0.02",
      estimated: false,
      pricingUnit: "request",
      catalogVersion: "catalog-image-1",
      capabilityVersion: "capability-image-1",
      pricingVersion: "pricing-image-1",
      expiresAt: "2026-08-07T10:05:00.000Z",
    };
    const store = new MemoryPromptHubGenerationStore();
    const bodies: Array<Record<string, unknown>> = [];
    let uploadedReference = 0;
    const service = serviceWith(store, {
      quote: imageQuote,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v1/media/upload") {
          uploadedReference += 1;
          return json({ ok: true, data: { ref: `https://media.example/image-reference-${uploadedReference}` } });
        }
        if (url.pathname === "/api/v1/generate") {
          bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return json({ ok: true, data: { jobId: "upstream-image-job-1", status: "running", progress: 18 } });
        }
        throw new Error(`unexpected request ${String(input)}`);
      },
      readReference: async (_ownerId, _mediaId, kind) => ({
        media: readyMedia(kind, "image/png"),
        bytes: Buffer.from(`${kind}-reference`),
      }),
    });
    const submission = {
      projectId: "project-image-1",
      nodeId: "node-image-1",
      modelId: imageQuote.modelId,
      modality: "image" as const,
      parameters: imageQuote.normalizedParameters,
      inputs: {
        images: ["reference-image"],
        styleImages: ["style-image"],
        elementImages: ["element-image"],
        videos: [],
        audios: [],
      },
      quantity: 1,
      expectedQuote: {
        id: imageQuote.id,
        modelId: imageQuote.modelId,
        creditMicros: imageQuote.creditMicros,
        pricingVersion: imageQuote.pricingVersion,
        expiresAt: imageQuote.expiresAt,
      },
      idempotencyKey: "canvas:image-protocol-request-001",
    };

    const result = await service.submit(OWNER_ID, submission);

    expect(result.data.status).toBe("running");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      version: "image.v1",
      model: "image-model-1",
      operation: "image_to_image",
      prompt: "a paper lantern over a quiet lake\n参考素材按上传顺序：图片1、图片2、图片3",
      resolution: "2k",
      aspect_ratio: "16:9",
      quality: "high",
      count: 2,
      clientRequestId: "canvas:image-protocol-request-001",
      product: "canvas",
      projectId: "project-image-1",
      nodeId: "node-image-1",
    });
    expect(bodies[0]?.media_inputs).toEqual([
      { kind: "image", role: "reference", url: "https://media.example/image-reference-1" },
      { kind: "image", role: "style_reference", url: "https://media.example/image-reference-2" },
      { kind: "image", role: "element_reference", url: "https://media.example/image-reference-3" },
    ]);
  });

  it("turns an absent upstream task id into submission_unknown without a second POST", async () => {
    const store = new MemoryPromptHubGenerationStore();
    const requested: Array<{ method: string; url: string }> = [];
    const service = serviceWith(store, {
      fetch: async (input, init) => {
        const url = String(input);
        requested.push({ method: init?.method ?? "GET", url });
        if (url.endsWith("/api/v1/video")) return json({ ok: true, data: { status: "queued" } });
        if (url.includes("/api/v1/video/requests/")) return json({ ok: false, error: { code: "NOT_FOUND", message: "missing" } }, 404);
        throw new Error(`unexpected request ${url}`);
      },
      readReference: async () => {
        throw new Error("no references expected");
      },
    });

    const result = await service.submit(OWNER_ID, videoSubmission());

    expect(result.data.status).toBe("submission_unknown");
    expect(result.data.error?.code).toBe("GENERATION_SUBMISSION_UNCONFIRMED");
    expect(requested.filter((item) => item.method === "POST")).toHaveLength(1);
  });

  it("keeps a dropped submission visible as submission_unknown instead of running", async () => {
    const store = new MemoryPromptHubGenerationStore();
    const service = serviceWith(store, {
      fetch: async () => {
        throw new TypeError("network disconnected");
      },
      readReference: async () => {
        throw new Error("no references expected");
      },
    });

    const result = await service.submit(OWNER_ID, videoSubmission());

    expect(result.data.status).toBe("submission_unknown");
    expect(result.data.error?.code).toBe("GENERATION_SUBMISSION_UNCONFIRMED");
  });

  it("never maps an unsupported submit status to queued and retains the durable id", async () => {
    const store = new MemoryPromptHubGenerationStore();
    const service = serviceWith(store, {
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/api/v1/video")) {
          return json({ ok: true, data: { jobId: "upstream-video-job-1", status: "weird-new-state" } });
        }
        throw new Error(`unexpected request ${url}`);
      },
      readReference: async () => {
        throw new Error("no references expected");
      },
    });

    const result = await service.submit(OWNER_ID, videoSubmission());

    expect(result.data.status).toBe("submission_unknown");
    const stored = await store.get(OWNER_ID, result.data.id);
    expect(stored?.upstreamJobId).toBe("upstream-video-job-1");
  });

  it("maps an upstream timeout status to failed rather than queued", async () => {
    const store = new MemoryPromptHubGenerationStore();
    const service = serviceWith(store, {
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/api/v1/video")) {
          return json({ ok: true, data: { jobId: "upstream-video-job-1", status: "timeout" } });
        }
        throw new Error(`unexpected request ${url}`);
      },
      readReference: async () => {
        throw new Error("no references expected");
      },
    });

    const result = await service.submit(OWNER_ID, videoSubmission());

    expect(result.data.status).toBe("failed");
    expect(result.data.error?.code).toBe("GENERATION_FAILED");
  });

  it("recovers a persisted submitting snapshot through a read-only lookup without a POST", async () => {
    const store = new MemoryPromptHubGenerationStore();
    await seedRecord(store, { status: "submitting" });
    const requested: string[] = [];
    const service = serviceWith(store, {
      fetch: async (input) => {
        const url = String(input);
        requested.push(url);
        if (url.includes("/api/v1/video/requests/")) return json({ ok: true, data: { jobId: "prompt-hub-video-job-1" } });
        if (url.includes("/api/v1/video/jobs/prompt-hub-video-job-1")) return json({ ok: true, data: { status: "running", progress: 35 } });
        throw new Error(`unexpected request ${url}`);
      },
      readReference: async () => {
        throw new Error("reference preparation must not run during read-only recovery");
      },
    });

    const result = await service.get(OWNER_ID, "canvas-video-job-1");

    expect(result.data.status).toBe("submitting");
    await service.settleObservation();
    expect(requested.filter((url) => url.endsWith("/api/v1/video"))).toHaveLength(0);
    const stored = await store.get(OWNER_ID, "canvas-video-job-1");
    expect(stored?.job.status).toBe("running");
    expect(stored?.job.progress).toBe(35);
    expect(stored?.upstreamJobId).toBe("prompt-hub-video-job-1");
  });

  it("does not re-POST or double-capture when a persisted submitting snapshot confirms a miss", async () => {
    const store = new MemoryPromptHubGenerationStore();
    await seedRecord(store, { status: "submitting" });
    const requested: string[] = [];
    const service = serviceWith(store, {
      fetch: async (input) => {
        const url = String(input);
        requested.push(url);
        return json({ ok: false, error: { code: "NOT_FOUND", message: "missing" } }, 404);
      },
      readReference: async () => {
        throw new Error("reference preparation must not run");
      },
    });

    const result = await service.get(OWNER_ID, "canvas-video-job-1");

    expect(result.data.status).toBe("submitting");
    await service.settleObservation();
    expect(requested.filter((url) => url.endsWith("/api/v1/video"))).toHaveLength(0);
    const stored = await store.get(OWNER_ID, "canvas-video-job-1");
    expect(stored?.job.status).toBe("submission_unknown");
  });

  it("returns the durable local submitting snapshot when the upstream POST is slower than the response budget", async () => {
    const store = new MemoryPromptHubGenerationStore();
    let releasePost!: (value: Response) => void;
    const postGate = new Promise<Response>((resolve) => { releasePost = resolve; });
    const service = serviceWith(store, {
      submissionResponseBudgetMs: 20,
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/api/v1/video")) return postGate;
        throw new Error(`unexpected request ${url}`);
      },
      readReference: async () => {
        throw new Error("no references expected");
      },
    });

    const pending = service.submit(OWNER_ID, videoSubmission());
    // The 20 ms budget expires while the upstream POST is still in flight: the
    // observable snapshot is the durable local `submitting` job, never a
    // fabricated queued/running appearance.
    const result = await pending;
    expect(result.data.status).toBe("submitting");
    expect(result.data.id).toMatch(/^phj_/);

    // Once the slow upstream answers with a durable task id, the job resumes
    // through the real response mapping.
    releasePost(json({ ok: true, data: { jobId: "slow-video-job-1", status: "running", progress: 40 } }));
    let stored = null;
    for (let attempt = 0; attempt < 50 && !stored?.upstreamJobId; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      stored = await store.get(OWNER_ID, result.data.id);
    }
    expect(stored?.upstreamJobId).toBe("slow-video-job-1");
    expect(stored?.job.status).toBe("running");
    expect(stored?.job.progress).toBe(40);
  });
});

describe("hosted video submission pre-POST and rejection boundaries", () => {
  let store: MemoryPromptHubGenerationStore;

  beforeEach(() => {
    store = new MemoryPromptHubGenerationStore();
  });

  async function settleToError(jobId: string) {
    let stored = null;
    for (let attempt = 0; attempt < 80 && !stored?.job?.error; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      stored = await store.get(OWNER_ID, jobId);
    }
    return stored;
  }

  it("never turns a reference-preparation failure after the response budget into submission_unknown", async () => {
    // 027 production signature: the browser received the durable `submitting`
    // snapshot, then ~13s later the job flipped to submission_unknown and never
    // recovered. When the video reference transfer to the upstream fails before
    // the generation POST is attempted, there is no paid ambiguity to resolve:
    // the node must surface an explicit retryable failure instead of locking.
    const service = serviceWith(store, {
      submissionResponseBudgetMs: 20,
      fetch: async () => {
        throw new Error("the generation POST must not be attempted when reference preparation fails");
      },
      readReference: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        throw new MediaServiceError("MEDIA_PROCESSING_UNAVAILABLE", "reference unavailable", 503);
      },
    });

    const result = await service.submit(OWNER_ID, videoReferenceSubmission());
    expect(result.data.status).toBe("submitting");

    const stored = await settleToError(result.data.id);
    expect(stored?.job.status).toBe("failed");
    expect(stored?.job.error?.code).toBe("MEDIA_PROCESSING_UNAVAILABLE");
    expect(stored?.job.error?.retryable).toBe(true);
    expect(stored?.job.version).toBe(1);
    expect(stored?.upstreamJobId).toBeNull();
  });

  it("surfaces an explicit upstream ok:false rejection on HTTP 200 as a definitive failure", async () => {
    // Some upstreams reject deterministically at the application layer with an
    // HTTP 200 `{ ok: false, error: { code, message } }` envelope. That is a
    // definite rejection (no task was created), never a transport ambiguity:
    // the job must become `failed` with the real error, not submission_unknown.
    const service = serviceWith(store, {
      submissionResponseBudgetMs: 20,
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return json({ ok: false, error: { code: "INVALID_PARAM", message: "参考视频不支持该规格" } }, 200);
      },
      readReference: async () => {
        throw new Error("no references expected");
      },
    });

    const result = await service.submit(OWNER_ID, videoSubmission());
    expect(result.data.status).toBe("submitting");

    const stored = await settleToError(result.data.id);
    expect(stored?.job.status).toBe("failed");
    expect(stored?.job.error?.code).toBe("INVALID_PARAM");
    expect(stored?.job.error?.message).toContain("参考视频不支持该规格");
    expect(stored?.job.error?.retryable).toBe(false);
  });

  it("fails a routed-model 502 immediately without recovery lookup or POST replay", async () => {
    const requested: Array<{ method: string; url: string }> = [];
    const service = serviceWith(store, {
      submissionResponseBudgetMs: 20,
      fetch: async (input, init) => {
        const url = String(input);
        requested.push({ method: init?.method ?? "GET", url });
        if (url.endsWith("/api/v1/video")) {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return json({
            ok: false,
            error: {
              code: "UPSTREAM_ERROR",
              message: "分组 生图 下模型 minimax_h3 无可用渠道（distributor）",
            },
          }, 502);
        }
        throw new Error(`routing rejection must not trigger recovery lookup: ${url}`);
      },
      readReference: async () => {
        throw new Error("no references expected");
      },
    });

    const result = await service.submit(OWNER_ID, videoSubmission());
    expect(result.data.status).toBe("submitting");

    const stored = await settleToError(result.data.id);
    expect(stored?.job.status).toBe("failed");
    expect(stored?.job.error).toMatchObject({
      code: "UPSTREAM_ERROR",
      retryable: false,
    });
    expect(stored?.job.error?.message).toContain("无可用渠道");
    expect(requested.filter((item) => item.method === "POST")).toHaveLength(1);
    expect(requested.some((item) => item.url.includes("/requests/"))).toBe(false);
  });

  it("keeps a genuinely dropped generation POST as submission_unknown with zero replay", async () => {
    // The conservative ambiguous path must stay: a POST that was sent but whose
    // response was lost stays submission_unknown and is never re-POSTed.
    const requested: string[] = [];
    const service = serviceWith(store, {
      submissionResponseBudgetMs: 20,
      fetch: async (input) => {
        const url = String(input);
        requested.push(url);
        if (url.endsWith("/api/v1/video")) throw new TypeError("network dropped the accepted POST");
        if (url.includes("/api/v1/video/requests/")) return json({ ok: false, error: { code: "NOT_FOUND", message: "missing" } }, 404);
        throw new Error(`unexpected request ${url}`);
      },
      readReference: async () => {
        throw new Error("no references expected");
      },
    });

    const result = await service.submit(OWNER_ID, videoSubmission());
    expect(["submitting", "submission_unknown"]).toContain(result.data.status);

    const stored = await store.get(OWNER_ID, result.data.id);
    expect(stored?.job.status).toBe("submission_unknown");
    const posts = requested.filter((url) => new URL(url).pathname === "/api/v1/video");
    expect(posts).toHaveLength(1);
  });
});

describe("createProviderReference", () => {
  const MEDIA_ID = "11111111-1111-4111-8111-111111111111";

  it("resolves a relative upstream ref against the configured origin", async () => {
    const references = new MemoryPromptHubReferenceStore();
    await references.create(hostedReference("canvas:reference-001", "/api/v1/media/c/owner/canvas/ref.png"));
    const service = serviceWith(new MemoryPromptHubGenerationStore(), {
      fetch: async () => {
        throw new Error("upload must not run");
      },
      readReference: async () => {
        throw new Error("read must not run");
      },
      references,
    });

    const result = await service.createProviderReference(OWNER_ID, MEDIA_ID, "image");

    expect(result.data.url).toBe("https://prompt-hub.test/api/v1/media/c/owner/canvas/ref.png");
  });

  it("keeps an absolute same-origin HTTPS upstream ref unchanged", async () => {
    const references = new MemoryPromptHubReferenceStore();
    await references.create(hostedReference("canvas:reference-002", "https://prompt-hub.test/api/v1/media/c/owner/canvas/ref.png"));
    const service = serviceWith(new MemoryPromptHubGenerationStore(), {
      fetch: async () => {
        throw new Error("upload must not run");
      },
      readReference: async () => {
        throw new Error("read must not run");
      },
      references,
    });

    const result = await service.createProviderReference(OWNER_ID, MEDIA_ID, "image");

    expect(result.data.url).toBe("https://prompt-hub.test/api/v1/media/c/owner/canvas/ref.png");
  });

  it("keeps an upstream-vouched absolute HTTPS ref that points at the media host", async () => {
    const references = new MemoryPromptHubReferenceStore();
    await references.create(hostedReference("canvas:reference-003", "https://media.example/ref.png"));
    const service = serviceWith(new MemoryPromptHubGenerationStore(), {
      fetch: async () => {
        throw new Error("upload must not run");
      },
      readReference: async () => {
        throw new Error("read must not run");
      },
      references,
    });

    const result = await service.createProviderReference(OWNER_ID, MEDIA_ID, "image");

    expect(result.data.url).toBe("https://media.example/ref.png");
  });

  it("falls back to Canvas signed delivery for an upstream-internal ref", async () => {
    const references = new MemoryPromptHubReferenceStore();
    await references.create(hostedReference("canvas:reference-internal", "storage://canvas/reference.png"));
    const service = serviceWith(new MemoryPromptHubGenerationStore(), {
      fetch: async () => {
        throw new Error("upload must not run");
      },
      readReference: async () => {
        throw new Error("read must not run");
      },
      references,
      signedAccess: {
        createUrl: (mediaId, kind) => `https://canvas-api.test/provider-media/${mediaId}?kind=${kind}&signature=short-lived`,
      },
    });

    const result = await service.createProviderReference(OWNER_ID, MEDIA_ID, "image");

    expect(result.data.url).toBe(
      `https://canvas-api.test/provider-media/${MEDIA_ID}?kind=image&signature=short-lived`,
    );
  });

  it("rejects absolute upstream refs that are not HTTPS", async () => {
    const references = new MemoryPromptHubReferenceStore();
    await references.create(hostedReference("canvas:reference-004", "http://media.example/ref.png"));
    const service = serviceWith(new MemoryPromptHubGenerationStore(), {
      fetch: async () => {
        throw new Error("upload must not run");
      },
      readReference: async () => {
        throw new Error("read must not run");
      },
      references,
    });

    await expect(
      service.createProviderReference(OWNER_ID, MEDIA_ID, "image"),
    ).rejects.toMatchObject({ code: "REFERENCE_PUBLIC_URL_UNAVAILABLE" });
  });

  it("resolves a protocol-relative ref only when it stays on the trusted origin", async () => {
    const references = new MemoryPromptHubReferenceStore();
    await references.create(hostedReference("canvas:reference-005", "//prompt-hub.test/api/v1/media/c/owner/canvas/ref.png"));
    const service = serviceWith(new MemoryPromptHubGenerationStore(), {
      fetch: async () => {
        throw new Error("upload must not run");
      },
      readReference: async () => {
        throw new Error("read must not run");
      },
      references,
    });

    const result = await service.createProviderReference(OWNER_ID, MEDIA_ID, "image");

    expect(result.data.url).toBe("https://prompt-hub.test/api/v1/media/c/owner/canvas/ref.png");
  });

  it("rejects a protocol-relative ref that resolves off the trusted origin", async () => {
    const references = new MemoryPromptHubReferenceStore();
    await references.create(hostedReference("canvas:reference-006", "//evil.example/ref.png"));
    const service = serviceWith(new MemoryPromptHubGenerationStore(), {
      fetch: async () => {
        throw new Error("upload must not run");
      },
      readReference: async () => {
        throw new Error("read must not run");
      },
      references,
    });

    await expect(
      service.createProviderReference(OWNER_ID, MEDIA_ID, "image"),
    ).rejects.toMatchObject({ code: "REFERENCE_PUBLIC_URL_UNAVAILABLE" });
  });

  it("rejects refs that smuggle credentials into the authority", async () => {
    const references = new MemoryPromptHubReferenceStore();
    await references.create(hostedReference("canvas:reference-007", "https://attacker@prompt-hub.test/ref.png"));
    const service = serviceWith(new MemoryPromptHubGenerationStore(), {
      fetch: async () => {
        throw new Error("upload must not run");
      },
      readReference: async () => {
        throw new Error("read must not run");
      },
      references,
    });

    await expect(
      service.createProviderReference(OWNER_ID, MEDIA_ID, "image"),
    ).rejects.toMatchObject({ code: "REFERENCE_PUBLIC_URL_UNAVAILABLE" });
  });

  it("rejects malformed refs", async () => {
    for (const ref of ["https://", "https://[::1"]) {
      const references = new MemoryPromptHubReferenceStore();
      await references.create(hostedReference(`canvas:reference-${ref.length}`, ref));
      const service = serviceWith(new MemoryPromptHubGenerationStore(), {
        fetch: async () => {
          throw new Error("upload must not run");
        },
        readReference: async () => {
          throw new Error("read must not run");
        },
        references,
      });

      await expect(
        service.createProviderReference(OWNER_ID, MEDIA_ID, "image"),
      ).rejects.toMatchObject({ code: "REFERENCE_PUBLIC_URL_UNAVAILABLE" });
    }
  });

  it("keeps encoded-traversal refs on the trusted origin", async () => {
    const references = new MemoryPromptHubReferenceStore();
    await references.create(hostedReference("canvas:reference-008", "https://prompt-hub.test/media/../../secret/ref.png"));
    const service = serviceWith(new MemoryPromptHubGenerationStore(), {
      fetch: async () => {
        throw new Error("upload must not run");
      },
      readReference: async () => {
        throw new Error("read must not run");
      },
      references,
    });

    const result = await service.createProviderReference(OWNER_ID, MEDIA_ID, "image");

    expect(result.data.url).toBe("https://prompt-hub.test/secret/ref.png");
  });

  it("rejects backslash host refs that escape the trusted origin", async () => {
    const references = new MemoryPromptHubReferenceStore();
    await references.create(hostedReference("canvas:reference-009", "\\\\evil.example\\ref.png"));
    const service = serviceWith(new MemoryPromptHubGenerationStore(), {
      fetch: async () => {
        throw new Error("upload must not run");
      },
      readReference: async () => {
        throw new Error("read must not run");
      },
      references,
    });

    await expect(
      service.createProviderReference(OWNER_ID, MEDIA_ID, "image"),
    ).rejects.toMatchObject({ code: "REFERENCE_PUBLIC_URL_UNAVAILABLE" });
  });

  it("rejects a stored reference whose kind does not match the requested kind", async () => {
    const references = new MemoryPromptHubReferenceStore();
    await references.create(hostedReference("canvas:reference-010", "/api/v1/media/c/owner/canvas/ref.mp4", "video"));
    const service = serviceWith(new MemoryPromptHubGenerationStore(), {
      fetch: async () => {
        throw new Error("upload must not run");
      },
      readReference: async () => {
        throw new Error("read must not run");
      },
      references,
    });

    await expect(
      service.createProviderReference(OWNER_ID, MEDIA_ID, "image"),
    ).rejects.toMatchObject({ code: "MEDIA_REFERENCE_INVALID" });
  });

  it("prepares a pending reference into a trusted HTTPS URL when the media is readable", async () => {
    const references = new MemoryPromptHubReferenceStore();
    await references.create(hostedReference("canvas:reference-011", null));
    const service = serviceWith(new MemoryPromptHubGenerationStore(), {
      fetch: async () => json({ ok: true, data: { ref: "/api/v1/media/c/owner/canvas/ref.png" } }),
      readReference: async () => ({
        media: readyMedia("image", "image/png"),
        bytes: Buffer.from("synthetic-image-bytes"),
      }),
      references,
    });

    const result = await service.createProviderReference(OWNER_ID, MEDIA_ID, "image");

    expect(result.data.url).toBe("https://prompt-hub.test/api/v1/media/c/owner/canvas/ref.png");
  });

  it("fails explicitly when a pending reference cannot be uploaded", async () => {
    const references = new MemoryPromptHubReferenceStore();
    await references.create(hostedReference("canvas:reference-012", null));
    const service = serviceWith(new MemoryPromptHubGenerationStore(), {
      fetch: async () => json({ ok: false, error: { code: "PROCESSING", message: "busy" } }, 503),
      readReference: async () => ({
        media: readyMedia("image", "image/png"),
        bytes: Buffer.from("synthetic-image-bytes"),
      }),
      references,
    });

    await expect(
      service.createProviderReference(OWNER_ID, MEDIA_ID, "image"),
    ).rejects.toMatchObject({ code: "REFERENCE_UPLOAD_UNAVAILABLE" });
  });

  it("fails explicitly for missing media", async () => {
    const service = serviceWith(new MemoryPromptHubGenerationStore(), {
      fetch: async () => {
        throw new Error("upload must not run");
      },
      readReference: async () => {
        throw new MediaServiceError("MEDIA_NOT_FOUND", "没有找到这个素材", 404);
      },
    });

    await expect(
      service.createProviderReference(OWNER_ID, MEDIA_ID, "image"),
    ).rejects.toMatchObject({ code: "MEDIA_NOT_FOUND" });
  });
});

describe("Midjourney hosted APImart billing boundary", () => {
  function mjAdapter() {
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

  it("submits one Midjourney APImart call without n/count and completes with five artifacts", async () => {
    const quotes = new GenerationQuoteService(mjAdapter(), { now: () => NOW });
    const browserQuote = await quotes.createQuote({ modelId: "mj-v81", modality: "image", parameters: { prompt: "cinematic city" } });
    expect(browserQuote).toMatchObject({
      quantity: 1,
      outputCount: 4,
      credits: "40",
      yuan: "0.4",
      creditMicros: 40_000_000,
      yuanMicros: 400_000,
      pricingUnit: "request",
    });

    const store = new MemoryPromptHubGenerationStore();
    const bodies: Array<Record<string, unknown>> = [];
    const service = new PromptHubGenerationService(
      quotes,
      { resolveUpstreamAccess: async () => ({ data: { accessToken: "access-token" } }) },
      store,
      {
        apiBaseUrl: "https://prompt-hub.test",
        apimart: { apiBaseUrl: "https://apimart.test", apiKey: "apimart-key" },
        apimartModelIds: ["mj-v81"],
        now: () => NOW,
        fetch: async (input, init) => {
          const url = new URL(String(input));
          if (url.host === "apimart.test" && url.pathname === "/v1/midjourney/generations") {
            bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
            return json({ ok: true, data: { taskId: "apimart-mj-task-1", status: "running", progress: 10 } });
          }
          if (url.host === "apimart.test" && url.pathname === "/v1/tasks/apimart-mj-task-1") {
            return json({
              ok: true,
              data: {
                taskId: "apimart-mj-task-1",
                status: "completed",
                progress: 100,
                grid_image_url: "https://apimart.test/grid.png",
                image_urls: [
                  "https://apimart.test/1.png",
                  "https://apimart.test/2.png",
                  "https://apimart.test/3.png",
                  "https://apimart.test/4.png",
                ],
              },
            });
          }
          throw new Error(`unexpected request ${String(input)}`);
        },
        media: { readReference: async () => { throw new Error("no references expected"); } },
      },
    );

    const result = await service.submit(OWNER_ID, {
      projectId: "project-1",
      nodeId: "node-1",
      modelId: "mj-v81",
      modality: "image",
      parameters: { prompt: "cinematic city", n: 1 },
      inputs: { images: [], styleImages: [], elementImages: [], videos: [], audios: [] },
      quantity: 1,
      expectedQuote: {
        id: browserQuote.id,
        modelId: browserQuote.modelId,
        creditMicros: browserQuote.creditMicros,
        pricingVersion: browserQuote.pricingVersion,
        expiresAt: browserQuote.expiresAt,
      },
      idempotencyKey: "mj-apimart-request-001",
    });

    // One provider call: the Canvas `n`/`count` submission-count parameters must
    // never reach APImart as a five-image batch.
    expect(bodies).toHaveLength(1);
    const body = bodies[0]!;
    expect(body).not.toHaveProperty("n");
    expect(body).not.toHaveProperty("count");
    expect(body).not.toHaveProperty("model");
    expect(body.prompt).toBe("cinematic city");
    expect(body.metadata).toMatchObject({ modelId: "mj-v81", clientRequestId: "mj-apimart-request-001" });
    expect(result.data.status).toBe("running");
    const stored = await store.get(OWNER_ID, result.data.id);
    expect(stored?.provider).toBe("apimart");
    expect(stored?.job.quote.creditMicros).toBe(40_000_000);

    const completed = await service.get(OWNER_ID, result.data.id);
    expect(completed.data.status).toBe("running");
    await service.settleObservation();
    const storedCompleted = await store.get(OWNER_ID, result.data.id);
    expect(storedCompleted?.job.status).toBe("completed");
    expect(storedCompleted?.job.artifacts).toHaveLength(5);
    expect(storedCompleted?.job.artifacts.every((artifact) => artifact.kind === "image")).toBe(true);
  });

  it("quotes the dotted stable-series station id and keeps all five gallery artifacts on the prompt-hub route", async () => {
    // 站点目录给稳定系列的是 4-5 + includes_cover_grid（四宫格封面 + 四张单图）。
    // 回归一：这个形状此前算出 count=1 直接被报价拒绝（OUTPUT_COUNT_UNSUPPORTED）。
    // 回归二：上游按次返回 5 张时，工件曾被报价张数 4 截断，第 4 张单图永远到不了画布。
    const adapter = new KachangCatalogAdapter({
      sourceUrl: "https://catalog.test/models",
      store: new MemoryCatalogSnapshotStore(),
      now: () => NOW,
      includeKnownModels: true,
      fetch: async () => new Response(JSON.stringify({
        success: true,
        version: "catalog-mj-station",
        capability_version: "capability-mj-station",
        pricing_version: "",
        fetched_at: new Date(NOW).toISOString(),
        credits_per_yuan: 100,
        models: [{
          id: "mj-v8.2",
          modality: "image",
          operation: "generate",
          order: 80,
          selectable: true,
          tags: "image,midjourney,per-request",
          endpoint: { method: "POST", path: "/v1/midjourney/generations", content_type: "application/json" },
          input: { text: { required: true }, images: { min: 0, max: 14, multiple: true } },
          output: { type: "image", format: "url", count: { min: 4, max: 5 }, includes_cover_grid: true },
          pricing: { mode: "fixed", unit: "request", currency: "CNY", yuan: 0.5, credits: 50 },
          parameters: [
            { name: "model", path: "model", type: "string", required: true, fixed: "mj-v8.2", label: "模型" },
            { name: "prompt", path: "prompt", type: "string", required: true, min_length: 1, label: "提示词" },
            { name: "n", path: "n", type: "integer", required: false, fixed: 1, label: "调用次数" },
          ],
          public: { id: "mj-v8.2", label: "Midjourney v8.2-稳定" },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    });
    const quotes = new GenerationQuoteService(adapter, { now: () => NOW });
    const browserQuote = await quotes.createQuote({ modelId: "mj-v8.2", modality: "image", parameters: { prompt: "cinematic city" } });
    expect(browserQuote).toMatchObject({
      quantity: 1,
      outputCount: 4,
      credits: "50",
      yuan: "0.5",
      pricingUnit: "request",
    });

    const store = new MemoryPromptHubGenerationStore();
    const bodies: Array<Record<string, unknown>> = [];
    const service = new PromptHubGenerationService(
      quotes,
      { resolveUpstreamAccess: async () => ({ data: { accessToken: "access-token" } }) },
      store,
      {
        apiBaseUrl: "https://prompt-hub.test",
        now: () => NOW,
        fetch: async (input, init) => {
          const path = new URL(String(input)).pathname;
          if (path === "/api/v1/generate") {
            bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
            return json({ ok: true, data: { jobId: "prompt-hub-mj-station-1", status: "running", progress: 10 } });
          }
          if (path === "/api/v1/generate/jobs/prompt-hub-mj-station-1") {
            return json({
              ok: true,
              data: {
                jobId: "prompt-hub-mj-station-1",
                status: "completed",
                progress: 100,
                images: [
                  "https://media.example/mj-cover.png",
                  "https://media.example/mj-1.png",
                  "https://media.example/mj-2.png",
                  "https://media.example/mj-3.png",
                  "https://media.example/mj-4.png",
                ],
              },
            });
          }
          throw new Error(`unexpected request ${path}`);
        },
        media: { readReference: async () => { throw new Error("no references expected"); } },
      },
    );

    const result = await service.submit(OWNER_ID, {
      projectId: "project-1",
      nodeId: "node-1",
      modelId: "mj-v8.2",
      modality: "image",
      parameters: { prompt: "cinematic city", n: 1 },
      inputs: { images: [], styleImages: [], elementImages: [], videos: [], audios: [] },
      quantity: 1,
      expectedQuote: {
        id: browserQuote.id,
        modelId: browserQuote.modelId,
        creditMicros: browserQuote.creditMicros,
        pricingVersion: browserQuote.pricingVersion,
        expiresAt: browserQuote.expiresAt,
      },
      idempotencyKey: "mj-station-request-001",
    });
    expect(result.data.status).toBe("running");

    // MJ 是一次调用返回整组图：报价的 count 决不能转发成多调用。
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!).not.toHaveProperty("count");
    expect(bodies[0]!).not.toHaveProperty("n");

    await service.get(OWNER_ID, result.data.id);
    await service.settleObservation();
    const storedCompleted = await store.get(OWNER_ID, result.data.id);
    expect(storedCompleted?.provider).toBe("prompt-hub");
    expect(storedCompleted?.job.status).toBe("completed");
    expect(storedCompleted?.resultUrls).toHaveLength(5);
    expect(storedCompleted?.job.artifacts).toHaveLength(5);
    expect(storedCompleted?.job.artifacts.every((artifact) => artifact.kind === "image")).toBe(true);
  });

  it("routes mj-v82 through the API station image.v1 endpoint with canonical resolution", async () => {
    const quote = {
      id: "quote-mj-v82-1",
      modelId: "mj-v82",
      modelLabel: "Midjourney 8.2",
      modality: "image" as const,
      quantity: 1,
      outputCount: 4,
      normalizedParameters: {
        prompt: "cinematic city",
        size: "9:16",
        resolution: "1K",
        raw: false,
        n: 1,
      },
      creditMicros: 40_000_000,
      credits: "40",
      yuanMicros: 400_000,
      yuan: "0.4",
      estimated: false,
      pricingUnit: "request" as const,
      catalogVersion: "catalog-mj-v82",
      capabilityVersion: "capability-mj-v82",
      pricingVersion: "pricing-mj-v82",
      expiresAt: "2026-08-07T10:05:00.000Z",
    };
    const store = new MemoryPromptHubGenerationStore();
    const bodies: Array<Record<string, unknown>> = [];
    const service = new PromptHubGenerationService(
      { createQuote: async () => quote } as unknown as GenerationQuoteService,
      { resolveUpstreamAccess: async () => ({ data: { accessToken: "access-token" } }) },
      store,
      {
        apiBaseUrl: "https://prompt-hub.test",
        now: () => NOW,
        fetch: async (input, init) => {
          const url = new URL(String(input));
          if (url.host === "prompt-hub.test" && url.pathname === "/api/v1/generate") {
            bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
            return json({ ok: true, data: { jobId: "prompt-hub-mj-v82-task", status: "running", progress: 8 } });
          }
          throw new Error(`unexpected request ${String(input)}`);
        },
        media: { readReference: async () => { throw new Error("no references expected"); } },
      },
    );

    const result = await service.submit(OWNER_ID, {
      projectId: "project-1",
      nodeId: "node-mj-v82",
      modelId: "mj-v82",
      modality: "image",
      parameters: { prompt: "cinematic city", size: "9:16", resolution: "1K", raw: false, n: 1 },
      inputs: { images: [], styleImages: [], elementImages: [], videos: [], audios: [] },
      quantity: 1,
      expectedQuote: {
        id: quote.id,
        modelId: quote.modelId,
        creditMicros: quote.creditMicros,
        pricingVersion: quote.pricingVersion,
        expiresAt: quote.expiresAt,
      },
      idempotencyKey: "mj-v82-request-001",
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      version: "image.v1",
      model: "mj-v82",
      prompt: "cinematic city",
      aspect_ratio: "9:16",
      resolution: "1k",
      options: { raw: false },
    });
    expect(bodies[0]).not.toHaveProperty("n");
    expect(bodies[0]).not.toHaveProperty("count");
    expect(result.data.status).toBe("running");
    expect((await store.get(OWNER_ID, result.data.id))?.provider).toBe("prompt-hub");
  });

  it("routes the friendly live MJ label to the API station image.v1 endpoint", async () => {
    const quote = {
      id: "quote-mj-friendly-1",
      modelId: "Midjourney v8.2 高速",
      modelLabel: "Midjourney v8.2 高速",
      modality: "image" as const,
      quantity: 1,
      outputCount: 4,
      normalizedParameters: { prompt: "cinematic city", aspect_ratio: "1:1", raw: false, n: 1 },
      creditMicros: 40_000_000,
      credits: "40",
      yuanMicros: 400_000,
      yuan: "0.4",
      estimated: false,
      pricingUnit: "request" as const,
      catalogVersion: "catalog-mj-friendly",
      capabilityVersion: "capability-mj-friendly",
      pricingVersion: "pricing-mj-friendly",
      expiresAt: "2026-08-07T10:05:00.000Z",
    };
    const store = new MemoryPromptHubGenerationStore();
    const requests: Array<{ host: string; path: string; body?: Record<string, unknown> }> = [];
    const service = new PromptHubGenerationService(
      { createQuote: async () => quote } as unknown as GenerationQuoteService,
      { resolveUpstreamAccess: async () => ({ data: { accessToken: "access-token" } }) },
      store,
      {
        apiBaseUrl: "https://prompt-hub.test",
        now: () => NOW,
        fetch: async (input, init) => {
          const url = new URL(String(input));
          if (url.host === "prompt-hub.test" && url.pathname === "/api/v1/generate") {
            requests.push({ host: url.host, path: url.pathname, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
            return json({ ok: true, data: { jobId: "prompt-hub-mj-friendly-task", status: "running", progress: 8 } });
          }
          throw new Error(`unexpected request ${String(input)}`);
        },
        media: { readReference: async () => { throw new Error("no references expected"); } },
      },
    );

    const result = await service.submit(OWNER_ID, {
      projectId: "project-1",
      nodeId: "node-mj-friendly",
      modelId: "Midjourney v8.2 高速",
      modality: "image",
      parameters: { prompt: "cinematic city", aspect_ratio: "1:1", raw: false, n: 1 },
      inputs: { images: [], styleImages: [], elementImages: [], videos: [], audios: [] },
      quantity: 1,
      expectedQuote: {
        id: quote.id,
        modelId: quote.modelId,
        creditMicros: quote.creditMicros,
        pricingVersion: quote.pricingVersion,
        expiresAt: quote.expiresAt,
      },
      idempotencyKey: "mj-friendly-prompt-hub-request-001",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      host: "prompt-hub.test",
      path: "/api/v1/generate",
      body: {
        version: "image.v1",
        model: "Midjourney v8.2 高速",
        prompt: "cinematic city",
        aspect_ratio: "1:1",
        options: { raw: false },
      },
    });
    expect(requests[0]?.body).not.toHaveProperty("n");
    expect(result.data.status).toBe("running");
    expect((await store.get(OWNER_ID, result.data.id))?.provider).toBe("prompt-hub");
  });

  it("rejects a repeated-call quantity for Midjourney before any APImart call", async () => {
    const quotes = new GenerationQuoteService(mjAdapter(), { now: () => NOW });
    const browserQuote = await quotes.createQuote({ modelId: "mj-v81", modality: "image", parameters: { prompt: "cinematic city" } });
    const store = new MemoryPromptHubGenerationStore();
    let upstreamCalls = 0;
    const service = new PromptHubGenerationService(
      quotes,
      { resolveUpstreamAccess: async () => ({ data: { accessToken: "access-token" } }) },
      store,
      {
        apiBaseUrl: "https://prompt-hub.test",
        apimart: { apiBaseUrl: "https://apimart.test", apiKey: "apimart-key" },
        now: () => NOW,
        fetch: async () => {
          upstreamCalls += 1;
          throw new Error("no upstream call expected");
        },
        media: { readReference: async () => { throw new Error("no references expected"); } },
      },
    );

    await expect(service.submit(OWNER_ID, {
      projectId: "project-1",
      nodeId: "node-1",
      modelId: "mj-v81",
      modality: "image",
      parameters: { prompt: "cinematic city", n: 1 },
      inputs: { images: [], styleImages: [], elementImages: [], videos: [], audios: [] },
      quantity: 5,
      expectedQuote: {
        id: browserQuote.id,
        modelId: browserQuote.modelId,
        creditMicros: browserQuote.creditMicros,
        pricingVersion: browserQuote.pricingVersion,
        expiresAt: browserQuote.expiresAt,
      },
      idempotencyKey: "mj-apimart-reject-001",
    })).rejects.toMatchObject({ code: "OUTPUT_COUNT_UNSUPPORTED" });
    expect(upstreamCalls).toBe(0);
    expect((await store.list(OWNER_ID, { limit: 10 })).length).toBe(0);
  });
});

function hostedReference(idempotencyKey: string, ref: string | null, kind: "image" | "video" | "audio" = "image") {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    ownerId: OWNER_ID,
    projectId: null,
    idempotencyKey,
    kind,
    name: "reference.png",
    mimeType: kind === "video" ? "video/mp4" : kind === "audio" ? "audio/mpeg" : "image/png",
    size: 1,
    sha256: null,
    ref,
    createdAt: "2026-08-07T09:58:00.000Z",
    updatedAt: "2026-08-07T09:58:00.000Z",
  };
}

function videoSubmission() {
  return {
    projectId: "project-1",
    nodeId: "node-1",
    modelId: quote.modelId,
    modality: "video" as const,
    parameters: quote.normalizedParameters,
    inputs: { images: [], styleImages: [], elementImages: [], videos: [], audios: [] },
    quantity: 1,
    expectedQuote: {
      id: quote.id,
      modelId: quote.modelId,
      creditMicros: quote.creditMicros,
      pricingVersion: quote.pricingVersion,
      expiresAt: quote.expiresAt,
    },
    idempotencyKey: "canvas:video-request-001",
  };
}

function h3VideoQuote(resolution: "2K" | "4K" | "1080p", extraParameters: Record<string, unknown> = {}): GenerationQuote {
  return {
    ...quote,
    id: `quote-h3-${resolution.toLowerCase()}`,
    modelId: "minimax_h3",
    modelLabel: "Minimax H3",
    normalizedParameters: {
      prompt: "让主体自然运动",
      duration_seconds: 4,
      aspect_ratio: "16:9",
      resolution,
      ...extraParameters,
    },
  };
}

function videoReferenceSubmission() {
  return {
    ...videoSubmission(),
    inputs: { images: [], styleImages: [], elementImages: [], videos: ["video-reference-media-1"], audios: [] },
    idempotencyKey: "canvas:video-reference-request-001",
  };
}

function readyMedia(kind: MediaKind, mimeType: string): PublicMedia {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    kind,
    name: "reference",
    mimeType,
    size: 5,
    sha256: "a".repeat(64),
    width: kind === "image" ? 1 : 16,
    height: kind === "image" ? 1 : 9,
    durationMs: kind === "image" ? null : 1_000,
    status: "ready",
    error: null,
    createdAt: "2026-08-07T09:58:00.000Z",
    updatedAt: "2026-08-07T09:58:00.000Z",
  };
}

async function seedRecord(
  store: MemoryPromptHubGenerationStore,
  options: {
    status: "submission_unknown" | "failed" | "submitting";
    recovery?: { attempts: number; lastAttemptAt: string };
    error?: { code: string; message: string; retryable: boolean };
  },
) {
  const timestamp = "2026-08-07T09:58:00.000Z";
  const record = {
    ownerId: OWNER_ID,
    idempotencyKey: "canvas:video-request-001",
    upstreamJobId: null,
    provider: "prompt-hub" as const,
    resultUrls: [],
    submission: {
      projectId: "project-1",
      nodeId: "node-1",
      modelId: quote.modelId,
      modality: "video" as const,
      parameters: quote.normalizedParameters,
      inputs: { images: ["reference-image-1"], styleImages: [], elementImages: [], videos: [], audios: [] },
      quantity: 1,
      expectedQuote: {
        id: quote.id,
        modelId: quote.modelId,
        creditMicros: quote.creditMicros,
        pricingVersion: quote.pricingVersion,
        expiresAt: quote.expiresAt,
      },
      idempotencyKey: "canvas:video-request-001",
    },
    ...(options.recovery ? { recovery: options.recovery } : {}),
    job: {
      schemaVersion: 1 as const,
      version: 0,
      id: "canvas-video-job-1",
      projectId: "project-1",
      nodeId: "node-1",
      modelId: quote.modelId,
      modelLabel: quote.modelLabel,
      modality: "video" as const,
      status: options.status,
      progress: 0,
      quote,
      artifacts: [],
      error: options.status === "submitting"
        ? null
        : options.error ?? {
            code: "GENERATION_SUBMISSION_UNCONFIRMED",
            message: "任务提交结果待确认，请勿重复生成",
            retryable: false,
          },
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: timestamp,
      completedAt: options.status === "failed" ? timestamp : null,
    },
  };
  expect(await store.create(record, 100)).toBe("created");
}

function serviceWith(
  store: MemoryPromptHubGenerationStore,
  options: {
    quote?: GenerationQuote;
    fetch: typeof fetch;
    readReference: (
      ownerId: string,
      mediaId: string,
      kind: MediaKind,
      maxBytes: number,
      projectId?: string,
    ) => Promise<{ media: PublicMedia; bytes: Buffer }>;
    mediaGet?: (ownerId: string, mediaId: string, projectId?: string) => Promise<PublicMedia>;
    references?: PromptHubReferenceStore;
    signedAccess?: { createUrl(mediaId: string, kind: MediaKind): string };
    submissionResponseBudgetMs?: number;
  },
) {
  return new PromptHubGenerationService(
    { createQuote: async () => options.quote ?? quote },
    { resolveUpstreamAccess: async () => ({ data: { accessToken: "access-token" } }) },
    store,
    {
      apiBaseUrl: "https://prompt-hub.test",
      now: () => NOW,
      fetch: options.fetch,
      media: {
        readReference: options.readReference,
        ...(options.mediaGet ? { get: options.mediaGet } : {}),
      },
      ...(options.signedAccess ? { signedAccess: options.signedAccess } : {}),
      ...(options.references ? { references: options.references } : {}),
      ...(options.submissionResponseBudgetMs !== undefined
        ? { submissionResponseBudgetMs: options.submissionResponseBudgetMs }
        : {}),
    },
  );
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("hosted read-only reconciliation by idempotency identity", () => {
  it("resolves the exact durable local snapshot without contacting the upstream", async () => {
    const store = new MemoryPromptHubGenerationStore();
    await seedRecord(store, { status: "submission_unknown" });
    let fetchCalls = 0;
    const service = serviceWith(store, {
      fetch: async () => { fetchCalls += 1; throw new Error("reconcile must never fetch"); },
      readReference: async () => { throw new Error("unused"); },
    });

    const resolved = await service.resolveByIdempotency(OWNER_ID, "canvas:video-request-001");

    expect(resolved).toMatchObject({ data: { id: "canvas-video-job-1", status: "submission_unknown", version: 0 } });
    expect(resolved!.data).not.toHaveProperty("ownerId");
    expect(resolved!.data).not.toHaveProperty("idempotencyKey");
    expect(fetchCalls).toBe(0);
  });

  it("resolves settled snapshots exactly, is owner-scoped, and rejects malformed keys", async () => {
    const store = new MemoryPromptHubGenerationStore();
    await seedRecord(store, { status: "failed" });
    const service = serviceWith(store, {
      fetch: async () => { throw new Error("unused"); },
      readReference: async () => { throw new Error("unused"); },
    });

    await expect(service.resolveByIdempotency(OWNER_ID, "canvas:video-request-001"))
      .resolves.toMatchObject({ data: { status: "failed" } });
    await expect(service.resolveByIdempotency("other-owner", "canvas:video-request-001")).resolves.toBeNull();
    await expect(service.resolveByIdempotency(OWNER_ID, "canvas:missing-request")).resolves.toBeNull();
    await expect(service.resolveByIdempotency("", "canvas:video-request-001")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(service.resolveByIdempotency(OWNER_ID, "bad key")).rejects.toThrow();
    await expect(service.resolveByIdempotency(OWNER_ID, "x".repeat(129))).rejects.toThrow();
  });

  it("never submits, replays, or mutates while reconciling a capped-list-omitted job", async () => {
    const store = new MemoryPromptHubGenerationStore();
    await seedRecord(store, { status: "running" });
    let fetchCalls = 0;
    const service = serviceWith(store, {
      fetch: async () => { fetchCalls += 1; throw new Error("unused"); },
      readReference: async () => { throw new Error("unused"); },
    });

    const before = await service.list(OWNER_ID, { limit: 100 });
    const resolved = await service.resolveByIdempotency(OWNER_ID, "canvas:video-request-001");
    const after = await service.list(OWNER_ID, { limit: 100 });

    expect(resolved).toMatchObject({ data: { id: "canvas-video-job-1", status: "running" } });
    expect(after.data).toEqual(before.data);
    expect(fetchCalls).toBe(0);
  });
});

describe("hosted image lifetime and failure convergence", () => {
  const imageQuote: GenerationQuote = {
    id: "quote-image-25-1",
    modelId: "gpt-image-2.5-1.5k",
    modelLabel: "GPT-Image-2.5-flare-1.5k",
    modality: "image",
    quantity: 1,
    normalizedParameters: { prompt: "a red apple", resolution: "1k", aspect_ratio: "1:1", n: 1 },
    creditMicros: 2_000_000,
    credits: "2",
    yuanMicros: 20_000,
    yuan: "0.02",
    estimated: false,
    pricingUnit: "image",
    catalogVersion: "catalog-1",
    capabilityVersion: "capability-1",
    pricingVersion: "pricing-1",
    expiresAt: "2026-08-07T10:05:00.000Z",
    outputCount: 1,
  };

  async function seedHostedJob(
    store: MemoryPromptHubGenerationStore,
    options: {
      modality: "image" | "video";
      status: "queued" | "running";
      startedAt: string;
      upstreamJobId?: string | null;
    },
  ) {
    const jobQuote = options.modality === "image" ? imageQuote : quote;
    const jobId = options.modality === "image" ? "canvas-image-job-1" : "canvas-video-job-1";
    expect(await store.create({
      ownerId: OWNER_ID,
      idempotencyKey: options.modality === "image" ? "canvas:image-request-001" : "canvas:video-request-001",
      upstreamJobId: options.upstreamJobId === undefined ? "prompt-hub-task-1" : options.upstreamJobId,
      provider: "prompt-hub",
      resultUrls: [],
      job: {
        schemaVersion: 1,
        version: 1,
        id: jobId,
        projectId: "project-1",
        nodeId: "node-1",
        modelId: jobQuote.modelId,
        modelLabel: jobQuote.modelLabel,
        modality: options.modality,
        status: options.status,
        progress: 30,
        quote: jobQuote,
        artifacts: [],
        error: null,
        createdAt: options.startedAt,
        updatedAt: options.startedAt,
        startedAt: options.startedAt,
        completedAt: null,
      },
    }, 100)).toBe("created");
    return jobId;
  }

  function lifetimeService(
    store: MemoryPromptHubGenerationStore,
    options: { fetch: typeof fetch; imageMaxLifetimeMs?: number },
  ) {
    return new PromptHubGenerationService(
      { createQuote: async () => imageQuote },
      { resolveUpstreamAccess: async () => ({ data: { accessToken: "access-token" } }) },
      store,
      {
        apiBaseUrl: "https://prompt-hub.test",
        now: () => NOW,
        fetch: options.fetch,
        media: { readReference: async () => { throw new Error("unused"); } },
        ...(options.imageMaxLifetimeMs !== undefined
          ? { imageMaxLifetimeMs: options.imageMaxLifetimeMs }
          : {}),
      },
    );
  }

  it("converges an over-budget image task to an explicit retryable timeout", async () => {
    const store = new MemoryPromptHubGenerationStore();
    const jobId = await seedHostedJob(store, {
      modality: "image",
      status: "running",
      // 15 minutes before NOW, well past the 10 minute default budget.
      startedAt: "2026-08-07T09:45:00.000Z",
    });
    const service = lifetimeService(store, {
      fetch: async () => { throw new Error("lifetime enforcement must not need the upstream"); },
    });

    const result = await service.get(OWNER_ID, jobId);

    expect(result.data.status).toBe("failed");
    expect(result.data.error).toMatchObject({ code: "GENERATION_TIMEOUT", retryable: true });
    const stored = await store.get(OWNER_ID, jobId);
    expect(stored?.job.status).toBe("failed");
  });

  it("keeps an in-budget image task generating", async () => {
    const store = new MemoryPromptHubGenerationStore();
    const jobId = await seedHostedJob(store, {
      modality: "image",
      status: "running",
      startedAt: "2026-08-07T09:59:00.000Z",
    });
    const service = lifetimeService(store, {
      fetch: async () => json({
        ok: true,
        data: { jobId: "prompt-hub-task-1", status: "running", progress: 48, error: null },
      }),
    });

    const result = await service.get(OWNER_ID, jobId);
    await service.settleObservation();

    expect(result.data.status).toBe("running");
    const stored = await store.get(OWNER_ID, jobId);
    expect(stored?.job.status).toBe("running");
    expect(stored?.job.error).toBeNull();
  });

  it("leaves a video task over the same budget untouched", async () => {
    const store = new MemoryPromptHubGenerationStore();
    const jobId = await seedHostedJob(store, {
      modality: "video",
      status: "running",
      startedAt: "2026-08-07T09:30:00.000Z",
    });
    const service = lifetimeService(store, {
      fetch: async () => json({
        ok: true,
        data: { jobId: "prompt-hub-task-1", status: "running", progress: 30 },
      }),
    });

    const result = await service.get(OWNER_ID, jobId);
    await service.settleObservation();

    expect(result.data.status).toBe("running");
    const stored = await store.get(OWNER_ID, jobId);
    expect(stored?.job.status).toBe("running");
  });

  it("fails an image task whose upstream declares failure without a readable status", async () => {
    const store = new MemoryPromptHubGenerationStore();
    const jobId = await seedHostedJob(store, {
      modality: "image",
      status: "running",
      startedAt: "2026-08-07T09:59:30.000Z",
    });
    const service = lifetimeService(store, {
      fetch: async () => json({
        ok: true,
        data: {
          jobId: "prompt-hub-task-1",
          error: { code: "CONTENT_VIOLATION", message: "内容不合规，请修改提示词" },
        },
      }),
    });

    await service.get(OWNER_ID, jobId);
    await service.settleObservation();

    const stored = await store.get(OWNER_ID, jobId);
    expect(stored?.job.status).toBe("failed");
    expect(stored?.job.error).toMatchObject({ code: "GENERATION_UPSTREAM_FAILED" });
    expect(stored?.job.error?.message).toContain("内容不合规");
  });

  it("fails an image task when the upstream status read is definitively rejected", async () => {
    const store = new MemoryPromptHubGenerationStore();
    const jobId = await seedHostedJob(store, {
      modality: "image",
      status: "running",
      startedAt: "2026-08-07T09:59:30.000Z",
    });
    const service = lifetimeService(store, {
      fetch: async () => json({ ok: false, error: { code: "NOT_FOUND", message: "任务不存在" } }, 404),
    });

    await service.get(OWNER_ID, jobId);
    await service.settleObservation();

    const stored = await store.get(OWNER_ID, jobId);
    expect(stored?.job.status).toBe("failed");
    expect(stored?.job.error).toMatchObject({ code: "NOT_FOUND", retryable: true });
  });

  it("converges an over-budget image task during project recovery", async () => {
    const store = new MemoryPromptHubGenerationStore();
    await seedHostedJob(store, {
      modality: "image",
      status: "queued",
      startedAt: "2026-08-07T09:45:00.000Z",
    });
    const service = lifetimeService(store, {
      fetch: async () => { throw new Error("recovery convergence must not need the upstream"); },
    });

    const listed = await service.list(OWNER_ID, { projectId: "project-1", limit: 100 });

    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]).toMatchObject({ status: "failed", error: { code: "GENERATION_TIMEOUT" } });
  });
});
