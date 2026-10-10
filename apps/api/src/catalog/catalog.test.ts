import { describe, expect, it, vi } from "vitest";

import { createApiApp } from "../app.js";
import { KachangCatalogAdapter } from "./adapter.js";
import { GenerationQuoteService } from "./quote.js";
import { MemoryCatalogSnapshotStore } from "./store.js";

const NOW = Date.parse("2026-07-15T09:00:00.000Z");

describe("Kachang catalog adapter", () => {
  it("keeps valid models when the source includes draft catalog rows", async () => {
    const payload = sourceCatalog() as unknown as { pricing_version: string; models: Array<Record<string, any>> };
    payload.pricing_version = "";
    payload.models[0]!.order = 20.5;
    (payload.models[0]!.public as Record<string, unknown>).description = null;
    payload.models.push({
      id: "draft-pricing-row",
      modality: "video",
      operation: "generate",
      output: { type: "video" },
      parameters: [],
      public: { id: "draft-pricing-row", label: "Draft" },
      selectable: true,
      pricing: { mode: "tiered_token", unit: "request", currency: "CNY", tiers: [{ nope: true }] },
    });

    const catalog = await createAdapter(payload).getCatalog();
    // An empty upstream pricing_version must never publish an "unknown" version
    // that a selectable paid quote could carry. Normalization derives a stable
    // content-based version instead.
    expect(catalog.pricingVersion).toMatch(/^content:[0-9a-f]{16}$/);
    expect(catalog.pricingVersion).not.toBe("unknown");
    expect((await createAdapter(payload).getCatalog()).pricingVersion).toBe(catalog.pricingVersion);
    expect(catalog.models.find((model) => model.id === "image2-pro")).toMatchObject({ order: 21 });
    expect(catalog.models.some((model) => model.id === "draft-pricing-row")).toBe(false);
  });

  it("publishes curated aliases without source ids, endpoints, or pricing groups", async () => {
    const adapter = createAdapter(sourceCatalog());
    const catalog = await adapter.getCatalog();
    const image = catalog.models.find((model) => model.id === "image2-pro");

    expect(image).toMatchObject({
      id: "image2-pro",
      label: "全能模型2 · 高质量",
      modality: "image",
      input: { images: { min: 0, max: 14, multiple: true } },
      pricing: { mode: "tiered", unit: "image", baseCreditMicros: 6_950_000 },
    });
    expect(image?.parameters.map((parameter) => parameter.name)).toEqual(["prompt", "quality", "n"]);
    expect(image?.parameters[0]).not.toHaveProperty("path");
    expect(image).not.toHaveProperty("sourceModelId");
    expect(image).not.toHaveProperty("endpoint");
    expect(image?.pricing).not.toHaveProperty("groups");
    expect(catalog.models.some((model) => model.id === "hidden-model")).toBe(false);
    expect((await adapter.getModel("image2-pro"))?.route).toMatchObject({
      sourceModelId: "private-image-route",
      endpoint: { path: "/v1/images/generations" },
    });
    expect(await adapter.getExecutionRoute("image2-pro")).toMatchObject({
      pricing: { mode: "tiered", creditsPerYuan: 100 },
    });
  });

  it("normalizes public video protocol media_roles without exposing a private route", async () => {
    const payload = sourceCatalog() as unknown as { models: Array<Record<string, any>> };
    payload.models[1]!.protocol = {
      version: "video.v1",
      endpoint: { method: "POST", path: "/v1/videos" },
      media_roles: ["reference", "source_video"],
    };

    const catalog = await createAdapter(payload).getCatalog();
    const video = catalog.models.find((model) => model.id === "motion-video");
    expect(video?.protocol).toEqual({
      version: "video.v1",
      endpoint: { method: "POST", path: "/v1/videos" },
      mediaRoles: ["reference", "source_video"],
    });
    expect(video).not.toHaveProperty("sourceModelId");
  });

  it("publishes the fixed-resolution nine-image route with the three common video.v1 controls", async () => {
    const payload = sourceCatalog() as unknown as { models: Array<Record<string, any>> };
    payload.models.push({
      id: "S-2.0-9图版",
      modality: "video",
      operation: "generate",
      protocol: {
        version: "video.v1",
        endpoint: { method: "POST", path: "/v1/videos" },
        media_roles: ["reference"],
      },
      input: {
        text: { required: true },
        images: { min: 0, max: 9, multiple: true },
        videos: { min: 0, max: 0, multiple: false },
        audios: { min: 0, max: 0, multiple: false },
      },
      output: { type: "video", count: { fixed: 1 } },
      parameters: [
        { name: "model", path: "model", type: "string", fixed: "S-2.0-9图版" },
        { name: "prompt", path: "prompt", label: "提示词", type: "string", required: true },
        { name: "duration_seconds", path: "duration_seconds", label: "时长（秒）", type: "integer", required: true, default: 4, min: 4, max: 15, options: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
        { name: "aspect_ratio", path: "aspect_ratio", label: "画面比例", type: "string", required: true, default: "16:9", options: ["16:9", "9:16"] },
        { name: "resolution", path: "resolution", label: "分辨率", type: "string", fixed: "720p", options: ["720p"] },
        { name: "images", path: "images", label: "参考图片", type: "array", max_items: 9, items: { type: "string", format: "public-http-url" } },
        { name: "n", path: "n", label: "生成数量", type: "integer", fixed: 1 },
      ],
      public: { id: "S-2.0-9图版", label: "S-2.0-9图版", description: "固定 720P，画面方向只选择比例。" },
      selectable: true,
      pricing: { mode: "fixed", unit: "request", currency: "CNY", credits: 250, yuan: 2.5 },
      endpoint: { method: "POST", path: "/v1/videos", content_type: "application/json" },
    });

    const adapter = createAdapter(payload);
    const model = (await adapter.getCatalog()).models.find((item) => item.id === "S-2.0-9图版");
    expect(model?.parameters.map((parameter) => parameter.name)).toEqual([
      "prompt", "duration_seconds", "aspect_ratio", "resolution", "n",
    ]);
    expect(model?.parameters.find((parameter) => parameter.name === "duration_seconds")?.options).toEqual([
      4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
    expect(model?.parameters.find((parameter) => parameter.name === "aspect_ratio")).toMatchObject({
      required: true,
      default: "16:9",
      options: ["16:9", "9:16"],
    });
    expect(model?.parameters.find((parameter) => parameter.name === "resolution")).toMatchObject({
      fixed: "720p",
      options: ["720p"],
    });
    expect((await adapter.getExecutionRoute("S-2.0-9图版"))?.route.parameters.map((parameter) => parameter.name)).toContain("resolution");

    const quoteService = new GenerationQuoteService(adapter, { now: () => NOW });
    await expect(quoteService.createQuote({
      modelId: "S-2.0-9图版",
      modality: "video",
      parameters: {
        prompt: "人物自然转身",
        duration_seconds: 15,
        aspect_ratio: "9:16",
        resolution: "720p",
        n: 1,
      },
      inputs: { images: 1 },
    })).resolves.toMatchObject({ modelId: "S-2.0-9图版", credits: "250", yuan: "2.5" });
  });

  it("uses duration_seconds when calculating a per-second video quote", async () => {
    const payload = sourceCatalog() as unknown as { models: Array<Record<string, any>> };
    payload.models.push({
      id: "private-minimax-h3-canonical",
      modality: "video",
      operation: "generate",
      protocol: {
        version: "video.v1",
        endpoint: { method: "POST", path: "/v1/videos" },
        media_roles: ["reference"],
      },
      input: { text: { required: true } },
      output: { type: "video", count: { fixed: 1 } },
      parameters: [
        { name: "model", path: "model", type: "string", fixed: "private-minimax-h3-canonical" },
        { name: "prompt", path: "prompt", type: "string", required: true },
        { name: "duration_seconds", path: "duration_seconds", type: "integer", default: 4, min: 4, max: 15 },
      ],
      public: { id: "minimax-h3-canonical", label: "Minimax H3 canonical", description: "" },
      selectable: true,
      pricing: { mode: "fixed", unit: "second", currency: "CNY", credits_per_yuan: 100, credits: 2, yuan: 0.02 },
      endpoint: { method: "POST", path: "/v1/videos", content_type: "application/json" },
    });

    const adapter = createAdapter(payload);
    const quotes = new GenerationQuoteService(adapter, { now: () => NOW });
    await expect(quotes.createQuote({
      modelId: "minimax-h3-canonical",
      modality: "video",
      parameters: { prompt: "test", duration_seconds: 15 },
    })).resolves.toMatchObject({ credits: "30", yuan: "0.3", normalizedParameters: { duration_seconds: 15 } });
  });

  it("counts reference video seconds and image overage in a per-second video quote", async () => {
    // H3 系列的两条参考素材计费口径来自站点目录描述：参考视频按模型每秒价另
    // 行计费，参考图前 5 张免费、第 6 张起每张 0.1 元（2026-09-23 运营确认）。
    // 预扣少算任何一项，实扣都会超出预扣；不带参考素材时行为必须不变。
    const payload = sourceCatalog() as unknown as { models: Array<Record<string, any>> };
    payload.models.push({
      id: "private-minimax-h3-reference",
      modality: "video",
      operation: "generate",
      protocol: {
        version: "video.v1",
        endpoint: { method: "POST", path: "/v1/videos" },
        media_roles: ["reference"],
      },
      input: { text: { required: true }, images: { min: 0, max: 9, multiple: true }, videos: { min: 0, max: 3, multiple: true } },
      output: { type: "video", count: { fixed: 1 } },
      parameters: [
        { name: "model", path: "model", type: "string", fixed: "private-minimax-h3-reference" },
        { name: "prompt", path: "prompt", type: "string", required: true },
        { name: "duration_seconds", path: "duration_seconds", type: "integer", default: 4, min: 4, max: 15 },
        { name: "referenceVideoDurations", path: "referenceVideoDurations", type: "array", max_items: 3, label: "参考视频时长（秒）" },
      ],
      public: { id: "minimax-h3-reference", label: "Minimax H3 reference", description: "" },
      selectable: true,
      pricing: { mode: "fixed", unit: "second", currency: "CNY", credits_per_yuan: 100, credits: 2, yuan: 0.02 },
      endpoint: { method: "POST", path: "/v1/videos", content_type: "application/json" },
    });
    payload.models.push({
      id: "private-minimax-h3-plain",
      modality: "video",
      operation: "generate",
      protocol: {
        version: "video.v1",
        endpoint: { method: "POST", path: "/v1/videos" },
        media_roles: ["reference"],
      },
      input: { text: { required: true }, images: { min: 0, max: 9, multiple: true } },
      output: { type: "video", count: { fixed: 1 } },
      parameters: [
        { name: "model", path: "model", type: "string", fixed: "private-minimax-h3-plain" },
        { name: "prompt", path: "prompt", type: "string", required: true },
        { name: "duration_seconds", path: "duration_seconds", type: "integer", default: 4, min: 4, max: 15 },
      ],
      public: { id: "minimax-h3-plain", label: "Minimax H3 plain", description: "" },
      selectable: true,
      pricing: { mode: "fixed", unit: "second", currency: "CNY", credits_per_yuan: 100, credits: 2, yuan: 0.02 },
      endpoint: { method: "POST", path: "/v1/videos", content_type: "application/json" },
    });

    const quotes = new GenerationQuoteService(createAdapter(payload), { now: () => NOW });
    // 4 秒成片 + 2 段共 5 秒参考视频，按同一档每秒价计：2 × (4 + 5)。
    await expect(quotes.createQuote({
      modelId: "minimax-h3-reference",
      modality: "video",
      parameters: { prompt: "test", duration_seconds: 4, referenceVideoDurations: [2, 3] },
      inputs: { videos: 2 },
    })).resolves.toMatchObject({ credits: "18", yuan: "0.18" });
    // 没有参考视频时报价与从前完全一致。
    await expect(quotes.createQuote({
      modelId: "minimax-h3-reference",
      modality: "video",
      parameters: { prompt: "test", duration_seconds: 4 },
      inputs: { videos: 0 },
    })).resolves.toMatchObject({ credits: "8", yuan: "0.08" });
    // 参考图前 5 张免费、第 6 张起每张 0.1 元：7 张 = 基础 8 + 2 × 10 积分。
    await expect(quotes.createQuote({
      modelId: "minimax-h3-reference",
      modality: "video",
      parameters: { prompt: "test", duration_seconds: 4 },
      inputs: { videos: 0, images: 7 },
    })).resolves.toMatchObject({ credits: "28", yuan: "0.28" });
    // 5 张以内不收超量费；没发布参考时长参数的模型也永远不收。
    await expect(quotes.createQuote({
      modelId: "minimax-h3-reference",
      modality: "video",
      parameters: { prompt: "test", duration_seconds: 4 },
      inputs: { videos: 0, images: 5 },
    })).resolves.toMatchObject({ credits: "8", yuan: "0.08" });
    await expect(quotes.createQuote({
      modelId: "minimax-h3-plain",
      modality: "video",
      parameters: { prompt: "test", duration_seconds: 4 },
      inputs: { videos: 0, images: 7 },
    })).resolves.toMatchObject({ credits: "8", yuan: "0.08" });
    // 总时长超过目录的 15 秒上限、或音长与参考视频数量不符，报价阶段就明确拒绝。
    await expect(quotes.createQuote({
      modelId: "minimax-h3-reference",
      modality: "video",
      parameters: { prompt: "test", duration_seconds: 4, referenceVideoDurations: [10, 6] },
      inputs: { videos: 2 },
    })).rejects.toMatchObject({ code: "REFERENCE_VIDEO_DURATION_LIMIT" });
    await expect(quotes.createQuote({
      modelId: "minimax-h3-reference",
      modality: "video",
      parameters: { prompt: "test", duration_seconds: 4, referenceVideoDurations: [2, 3] },
      inputs: { videos: 1 },
    })).rejects.toMatchObject({ code: "REFERENCE_VIDEO_DURATION_MISMATCH" });
  });

  it("treats generic image inputs as optional references", async () => {
    const payload = sourceCatalog() as unknown as { models: Array<Record<string, any>> };
    payload.models[0]!.input.images = { min: 1, max: 14, multiple: true };

    const adapter = createAdapter(payload);
    const model = (await adapter.getCatalog()).models.find((item) => item.id === "image2-pro");
    expect(model?.input.images).toMatchObject({ min: 0, max: 14, multiple: true });

    const quotes = new GenerationQuoteService(adapter, { now: () => NOW });
    await expect(quotes.createQuote({
      modelId: "image2-pro",
      modality: "image",
      parameters: { prompt: "test" },
    })).resolves.toMatchObject({ modelId: "image2-pro" });
  });

  it("keeps image reference slots optional even when the source marks them required", async () => {
    const payload = sourceCatalog() as unknown as { models: Array<Record<string, any>> };
    payload.models[0]!.input.reference_media = {
      images: { min: 1, max: 1, multiple: false },
    };

    const adapter = createAdapter(payload);
    const model = (await adapter.getCatalog()).models.find((item) => item.id === "image2-pro");
    expect(model?.input.referenceMedia?.images).toMatchObject({ min: 0, max: 1, multiple: false });

    const quotes = new GenerationQuoteService(adapter, { now: () => NOW });
    await expect(quotes.createQuote({
      modelId: "image2-pro",
      modality: "image",
      parameters: { prompt: "test" },
    })).resolves.toMatchObject({ modelId: "image2-pro" });
  });

  it("keeps the general image-array capacity when optional first/last fields coexist", async () => {
    const payload = sourceCatalog() as unknown as { models: Array<Record<string, unknown>> };
    payload.models.push({
      id: "private-video-with-array-and-frames",
      modality: "video",
      operation: "generate",
      input: {
        text: { required: true },
        images: { min: 0, max: 30, multiple: true },
      },
      output: { type: "video" },
      parameters: [
        { name: "model", path: "model", type: "string", fixed: "private-video-with-array-and-frames" },
        { name: "prompt", path: "prompt", type: "string", required: true },
        { name: "referenceImages", path: "referenceImages", type: "array", max_items: 30, items: { type: "string", format: "public-http-url" } },
        { name: "first_image", path: "first_image", type: "string", format: "public-http-url" },
        { name: "last_image", path: "last_image", type: "string", format: "public-http-url" },
      ],
      public: { id: "video-with-array-and-frames", label: "Video with array and frames" },
      selectable: true,
      pricing: { mode: "fixed", unit: "request", currency: "CNY", credits: 1, yuan: 0.01 },
      endpoint: { method: "POST", path: "/v1/videos", content_type: "application/json" },
    });

    const adapter = createAdapter(payload);
    const model = (await adapter.getCatalog()).models.find((item) => item.id === "video-with-array-and-frames");
    expect(model?.input.images).toEqual({ min: 0, max: 30, multiple: true });
    expect(model?.input.referenceMedia?.images).toEqual({ min: 0, max: 30, multiple: true });

    const quotes = new GenerationQuoteService(adapter, { now: () => NOW });
    await expect(quotes.createQuote({
      modelId: "video-with-array-and-frames",
      modality: "video",
      parameters: { prompt: "test" },
      inputs: { images: 30 },
    })).resolves.toMatchObject({ modelId: "video-with-array-and-frames" });
    await expect(quotes.createQuote({
      modelId: "video-with-array-and-frames",
      modality: "video",
      parameters: { prompt: "test" },
      inputs: { images: 31 },
    })).rejects.toMatchObject({ code: "TOO_MANY_REFERENCES" });
  });

  it("restores the reviewed SD2 nine-image face route when the upstream row is missing", async () => {
    const payload = sourceCatalog() as unknown as { models: Array<Record<string, unknown>> };
    payload.models.push({
      id: "sd2.0-720p-pro",
      modality: "video",
      operation: "generate",
      input: { text: { required: true }, images: { min: 0, max: 9, multiple: true } },
      output: { type: "video", count: { fixed: 1 } },
      parameters: [
        { name: "model", type: "string", fixed: "sd2.0-720p-pro" },
        { name: "prompt", type: "string", required: true },
      ],
      public: { id: "sd2.0-720p-pro", label: "SD2.0 Pro 720P" },
      selectable: true,
      pricing: { mode: "fixed", unit: "request", currency: "CNY", credits: 1, yuan: 0.01 },
      endpoint: { method: "POST", path: "/v1/videos", content_type: "application/json" },
    });

    const adapter = createAdapter(payload);
    const model = (await adapter.getCatalog()).models.find((item) => item.label === "SD2.0 Pro 720P（九图卡脸版）");
    expect(model).toMatchObject({
      id: "sd2.0 pro 满血九图卡脸版",
      modality: "video",
      protocol: {
        version: "video.v1",
        endpoint: { method: "POST", path: "/v1/videos" },
        mediaRoles: ["reference"],
      },
      input: {
        images: { min: 0, max: 9, multiple: true },
        videos: { min: 0, max: 0, multiple: false },
        audios: { min: 0, max: 0, multiple: false },
      },
      pricing: { unit: "request", baseCreditMicros: 250_000_000, baseYuanMicros: 2_500_000 },
    });
    expect(model?.parameters.map((parameter) => parameter.name)).toEqual([
      "prompt", "seconds", "resolution", "aspect_ratio", "n", "async",
    ]);
    // 该模型真实支持到 30 秒；目录上限曾停在 15，导致画布只能选到 15 秒。
    expect(model?.parameters.find((parameter) => parameter.name === "seconds")).toMatchObject({ min: 4, max: 30 });
    expect((await adapter.getModel("sd2.0 pro 满血九图卡脸版"))?.route).toMatchObject({
      sourceModelId: "sd2.0 pro 满血九图卡脸版",
      endpoint: { path: "/v1/videos" },
    });

    const quote = await new GenerationQuoteService(adapter, { now: () => NOW }).createQuote({
      modelId: "sd2.0 pro 满血九图卡脸版",
      modality: "video",
      parameters: { prompt: "人物转身", seconds: 4, resolution: "720p", aspect_ratio: "16:9" },
    });
    expect(quote).toMatchObject({ modelId: "sd2.0 pro 满血九图卡脸版", credits: "250", yuan: "2.5" });
  });

  it("migrates an older SD2 snapshot before attempting a refresh", async () => {
    const payload = sourceCatalog() as unknown as { models: Array<Record<string, unknown>> };
    payload.models.push({
      id: "sd2.0-720p-pro",
      modality: "video",
      operation: "generate",
      input: { text: { required: true }, images: { min: 0, max: 9, multiple: true } },
      output: { type: "video", count: { fixed: 1 } },
      parameters: [{ name: "model", type: "string", fixed: "sd2.0-720p-pro" }, { name: "prompt", type: "string", required: true }],
      public: { id: "sd2.0-720p-pro", label: "SD2.0 Pro 720P" },
      selectable: true,
      pricing: { mode: "fixed", unit: "request", currency: "CNY", credits: 1, yuan: 0.01 },
      endpoint: { method: "POST", path: "/v1/videos", content_type: "application/json" },
    });
    const store = new MemoryCatalogSnapshotStore();
    await createAdapter(payload, store).getCatalog();
    const previous = store.snapshot!;
    store.snapshot = {
      ...previous,
      catalog: { ...previous.catalog, models: previous.catalog.models.filter((model) => model.id !== "sd2.0 pro 满血九图卡脸版") },
      sourceModels: Object.fromEntries(Object.entries(previous.sourceModels).filter(([id]) => id !== "sd2.0 pro 满血九图卡脸版")),
      routes: Object.fromEntries(Object.entries(previous.routes).filter(([id]) => id !== "sd2.0 pro 满血九图卡脸版")),
    };

    const offline = new KachangCatalogAdapter({
      sourceUrl: "https://catalog.test/models",
      store,
      now: () => NOW + 30_000,
      refreshIntervalMs: 0,
      fetch: async () => { throw new Error("offline"); },
    });
    expect((await offline.getCatalog()).models.some((model) => model.id === "sd2.0 pro 满血九图卡脸版")).toBe(true);
    expect(store.snapshot?.routes["sd2.0 pro 满血九图卡脸版"]?.sourceModelId).toBe("sd2.0 pro 满血九图卡脸版");
  });

  it("preserves required reference slots for non-image modalities", async () => {
    const payload = sourceCatalog() as unknown as { models: Array<Record<string, any>> };
    payload.models[1]!.input.reference_media = {
      images: { min: 1, max: 1, multiple: false },
    };

    const adapter = createAdapter(payload);
    const model = (await adapter.getCatalog()).models.find((item) => item.id === "motion-video");
    expect(model?.input.referenceMedia?.images).toMatchObject({ min: 1, max: 1, multiple: false });
  });

  it("deduplicates refreshes and retains the last valid snapshot on bad data", async () => {
    let calls = 0;
    let payload: unknown = sourceCatalog();
    const store = new MemoryCatalogSnapshotStore();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const adapter = new KachangCatalogAdapter({
      sourceUrl: "https://catalog.test/models",
      store,
      now: () => NOW,
      refreshIntervalMs: 0,
      fetch: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return jsonResponse(payload);
      },
    });

    await Promise.all([adapter.getCatalog(), adapter.getCatalog(), adapter.getCatalog()]);
    expect(calls).toBe(1);
    payload = { success: true, models: [] };
    const retained = await adapter.getCatalog({ forceRefresh: true });
    expect(retained.version).toBe("catalog-1");
    expect(store.snapshot?.catalog.models).toHaveLength(3);
    error.mockRestore();
  });

  it("loads a stored snapshot when the network is unavailable", async () => {
    const store = new MemoryCatalogSnapshotStore();
    await createAdapter(sourceCatalog(), store).getCatalog();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const offline = new KachangCatalogAdapter({
      sourceUrl: "https://catalog.test/models",
      store,
      now: () => NOW + 30_000,
      fetch: async () => { throw new Error("offline"); },
      refreshIntervalMs: 0,
    });
    expect((await offline.getCatalog()).models).toHaveLength(3);
    error.mockRestore();
  });

  it("keeps the last valid video models and snapshot when the source 502s and the inventory is empty", async () => {
    const store = new MemoryCatalogSnapshotStore();
    const now = () => NOW;
    const adapter = new KachangCatalogAdapter({
      sourceUrl: "https://catalog.test/models",
      videoInventoryUrl: "https://catalog.test/video-inventory",
      store,
      now,
      refreshIntervalMs: 60_000,
      fetch: async () => jsonResponse(sourceCatalog(), { ETag: '"catalog-1"' }),
      inventoryFetch: async () => jsonResponse({ success: true, models: [
        { id: "motion-video", modality: "video", selectable: true },
      ] }),
    });
    expect((await adapter.getCatalog()).models.some((model) => model.id === "motion-video")).toBe(true);
    const snapshotBefore = structuredClone(store.snapshot);
    // 允许清单含别名：执行器的 motion-video 对应画布侧 grok-imagine-video，
    // 两个 id 都算可执行（见 video-executability.ts）。
    expect(snapshotBefore?.videoAvailability?.publicModelIds).toEqual([
      "grok-imagine-video",
      "motion-video",
    ]);

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const offline = new KachangCatalogAdapter({
      sourceUrl: "https://catalog.test/models",
      videoInventoryUrl: "https://catalog.test/video-inventory",
      store,
      now: () => NOW + 30_000,
      refreshIntervalMs: 60_000,
      fetch: async () => new Response(null, { status: 502 }),
      inventoryFetch: async () => jsonResponse({ success: true, models: [] }),
    });
    const retained = await offline.getCatalog({ forceRefresh: true });

    expect(retained.version).toBe("catalog-1");
    expect(retained.models.some((model) => model.id === "motion-video")).toBe(true);
    expect(store.snapshot).toEqual(snapshotBefore);
    error.mockRestore();
  });

  it("updates the snapshot after a subsequent complete successful refresh", async () => {
    const store = new MemoryCatalogSnapshotStore();
    const adapter = new KachangCatalogAdapter({
      sourceUrl: "https://catalog.test/models",
      videoInventoryUrl: "https://catalog.test/video-inventory",
      store,
      now: () => NOW,
      refreshIntervalMs: 60_000,
      fetch: async () => jsonResponse(sourceCatalog(), { ETag: '"catalog-1"' }),
      inventoryFetch: async () => jsonResponse({ success: true, models: [
        { id: "motion-video", modality: "video", selectable: true },
      ] }),
    });
    await adapter.getCatalog();
    const before = structuredClone(store.snapshot);

    let fail = true;
    const recovering = new KachangCatalogAdapter({
      sourceUrl: "https://catalog.test/models",
      videoInventoryUrl: "https://catalog.test/video-inventory",
      store,
      now: () => NOW + 30_000,
      refreshIntervalMs: 60_000,
      fetch: async () => fail ? new Response(null, { status: 502 }) : jsonResponse(sourceCatalog(), { ETag: '"catalog-1"' }),
      inventoryFetch: async () => jsonResponse({ success: true, models: [
        { id: "motion-video", modality: "video", selectable: true },
        { id: "kling-o3-pro-v2v-reference", modality: "video", selectable: true },
      ] }),
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await recovering.getCatalog({ forceRefresh: true });
    expect(store.snapshot).toEqual(before);

    fail = false;
    await recovering.getCatalog({ forceRefresh: true, awaitRefresh: true });
    expect(store.snapshot?.videoAvailability?.publicModelIds).toEqual([
      "grok-imagine-video",
      "kling-o3-pro-v2v-reference",
      "motion-video",
    ]);
    expect(store.snapshot?.validatedAt).toBe(NOW + 30_000);
    error.mockRestore();
  });

  it("omits one unreviewed execution route without invalidating the reviewed catalog", async () => {
    const payload = sourceCatalog();
    const video = payload.models[1] as { endpoint: { path: string } };
    video.endpoint.path = "/internal/unreviewed";
    const catalog = await createAdapter(payload).getCatalog();

    expect(catalog.models.map((model) => model.id)).toEqual(["creative-text", "image2-pro"]);
    expect(catalog.quoteAvailable).toBe(true);
  });

  it("omits audio-output models because no reviewed execution route is allowlisted", async () => {
    const payload = sourceCatalog() as unknown as { models: Array<Record<string, unknown>> };
    payload.models.push({
      id: "private-audio-route",
      modality: "audio",
      operation: "generate",
      input: { text: { required: true } },
      output: { type: "audio" },
      parameters: [
        { name: "model", type: "string", fixed: "private-audio-route" },
        { name: "prompt", type: "string", required: true },
      ],
      public: { id: "voice-model", label: "音频生成" },
      selectable: true,
      pricing: { mode: "fixed", unit: "request", currency: "CNY", credits: 1, yuan: 0.01 },
      endpoint: { method: "POST", path: "/v1/audio/generations", content_type: "application/json" },
    });

    const adapter = createAdapter(payload);
    const catalog = await adapter.getCatalog();
    expect(catalog.models.some((model) => model.id === "voice-model")).toBe(false);
    expect(catalog.models.map((model) => model.modality)).not.toContain("audio");
    expect(await adapter.getModel("voice-model")).toBeNull();

    const quotes = new GenerationQuoteService(adapter, { now: () => NOW });
    await expect(quotes.createQuote({
      modelId: "voice-model",
      modality: "audio",
      parameters: { prompt: "生成一段音乐" },
    })).rejects.toMatchObject({ code: "MODEL_NOT_AVAILABLE" });
  });

  it("preserves the Midjourney endpoint, four-image output, and Chinese parameters", async () => {
    const payload = sourceCatalog();
    (payload.models as unknown as Array<Record<string, unknown>>).push({
      id: "mj-v8.1",
      modality: "image",
      family: "midjourney",
      operation: "generate",
      order: 50,
      input: { text: { required: true }, images: { min: 0, max: 5, multiple: true } },
      output: { type: "image", count: { fixed: 4 } },
      parameters: [
        { name: "model", path: "model", type: "string", required: true, fixed: "mj-v8.1", label: "模型" },
        { name: "prompt", path: "prompt", type: "string", required: true, label: "提示词" },
        { name: "size", path: "size", type: "string", default: "auto", options: ["auto", "1:1", "16:9"], label: "画面比例" },
        { name: "quality", path: "quality", type: "string", default: "1k", options: ["1k", "2k"], label: "清晰度" },
        { name: "image_urls", path: "image_urls", type: "array", max_items: 5, items: { type: "string", format: "public-http-url" }, label: "参考图" },
        { name: "stylize", path: "stylize", type: "integer", default: 0, min: 0, max: 1000, label: "风格化" },
        { name: "speed", path: "speed", type: "string", fixed: "relax", label: "速度" },
        { name: "n", path: "n", type: "integer", fixed: 1, label: "提交次数" },
      ],
      public: { id: "mj-v81", label: "Midjourney 8.1" },
      selectable: true,
      pricing: { mode: "fixed", unit: "request", currency: "CNY", credits: 40, yuan: 0.4 },
      endpoint: { method: "POST", path: "/v1/midjourney/generations", content_type: "application/json" },
    });

    const adapter = createAdapter(payload);
    const model = (await adapter.getCatalog()).models.find((item) => item.id === "mj-v81");
    const resolved = await adapter.getModel("mj-v81");

    expect(model).toMatchObject({
      output: { type: "image", minCount: 4, maxCount: 4 },
      input: { images: { min: 0, max: 5, multiple: true } },
      pricing: { unit: "request", baseCreditMicros: 40_000_000, baseYuanMicros: 400_000 },
    });
    expect(model?.parameters).toContainEqual(expect.objectContaining({ name: "quality", label: "清晰度", options: ["1k", "2k"] }));
    expect(model?.parameters.some((parameter) => parameter.name === "image_urls")).toBe(false);
    expect(resolved?.route.endpoint.path).toBe("/v1/midjourney/generations");
    expect(resolved?.route.parameters).toContainEqual(expect.objectContaining({ name: "image_urls", path: "image_urls" }));

    const quote = await new GenerationQuoteService(adapter, { now: () => NOW }).createQuote({
      modelId: "mj-v81",
      modality: "image",
      quantity: 1,
      parameters: { prompt: "cinematic city", n: 1 },
    });
    expect(quote).toMatchObject({ quantity: 1, outputCount: 4, pricingUnit: "request", credits: "40", yuan: "0.4" });
  });

  it("injects the reviewed Midjourney 8.1 fallback with the authoritative price contract", async () => {
    const payload = sourceCatalog() as unknown as { pricing_version: string; models: Array<Record<string, any>> };
    payload.pricing_version = "";
    const adapter = createAdapter(payload, new MemoryCatalogSnapshotStore(), true);
    const catalog = await adapter.getCatalog();
    const matches = catalog.models.filter((item) => item.id === "mj-v81");

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      label: "Midjourney 8.1",
      modality: "image",
      output: { type: "image", minCount: 4, maxCount: 4 },
      pricing: { mode: "fixed", unit: "request", creditsPerYuan: 100, baseCreditMicros: 40_000_000, baseYuanMicros: 400_000 },
    });
    expect(matches[0]?.parameters.map((parameter) => parameter.name)).toEqual([
      "prompt", "aspect_ratio", "quality", "stylize", "chaos", "weird", "version", "speed", "n",
    ]);
    expect((await adapter.getModel("mj-v81"))?.route.endpoint.path).toBe("/v1/midjourney/generations");

    const quote = await new GenerationQuoteService(adapter, { now: () => NOW }).createQuote({
      modelId: "mj-v81",
      modality: "image",
      parameters: { prompt: "cinematic city" },
    });
    expect(quote).toMatchObject({
      modelId: "mj-v81",
      outputCount: 4,
      pricingUnit: "request",
      credits: "40",
      yuan: "0.4",
      creditMicros: 40_000_000,
      yuanMicros: 400_000,
    });
    expect(quote.pricingVersion).toMatch(/^content:[0-9a-f]{16}$/);
    expect(quote.pricingVersion).not.toBe("unknown");
  });

  it("uses the authoritative per-call fallback pricing for Midjourney 7 and Niji 7", async () => {
    const payload = sourceCatalog() as unknown as { pricing_version: string; models: Array<Record<string, any>> };
    payload.pricing_version = "";
    const adapter = createAdapter(payload, new MemoryCatalogSnapshotStore(), true);
    const catalog = await adapter.getCatalog();
    const quotes = new GenerationQuoteService(adapter, { now: () => NOW });

    const v7 = catalog.models.filter((item) => item.id === "mj-v7");
    expect(v7).toHaveLength(1);
    expect(v7[0]).toMatchObject({
      label: "Midjourney 7",
      output: { type: "image", minCount: 4, maxCount: 4 },
      pricing: { mode: "fixed", unit: "request", creditsPerYuan: 100, baseCreditMicros: 40_000_000, baseYuanMicros: 400_000 },
    });
    expect(v7[0]?.parameters.some((parameter) => parameter.name === "niji")).toBe(false);
    expect(await quotes.createQuote({
      modelId: "mj-v7",
      modality: "image",
      parameters: { prompt: "cinematic city" },
    })).toMatchObject({ quantity: 1, outputCount: 4, credits: "40", yuan: "0.4", creditMicros: 40_000_000, yuanMicros: 400_000, pricingUnit: "request" });

    const niji7 = catalog.models.filter((item) => item.id === "mj-niji7");
    expect(niji7).toHaveLength(1);
    expect(niji7[0]).toMatchObject({
      label: "Midjourney Niji 7",
      output: { type: "image", minCount: 4, maxCount: 4 },
      pricing: { mode: "fixed", unit: "request", creditsPerYuan: 100, baseCreditMicros: 40_000_000, baseYuanMicros: 400_000 },
    });
    expect(niji7[0]?.parameters.find((parameter) => parameter.name === "niji")).toMatchObject({ fixed: true });
    expect(await quotes.createQuote({
      modelId: "mj-niji7",
      modality: "image",
      parameters: { prompt: "cinematic city" },
    })).toMatchObject({ quantity: 1, outputCount: 4, credits: "40", yuan: "0.4", creditMicros: 40_000_000, yuanMicros: 400_000, pricingUnit: "request" });
  });

  it("rejects a repeated-call quantity for the three Midjourney fallbacks before any reservation", async () => {
    const payload = sourceCatalog() as unknown as { pricing_version: string; models: Array<Record<string, any>> };
    payload.pricing_version = "";
    const adapter = createAdapter(payload, new MemoryCatalogSnapshotStore(), true);
    const quotes = new GenerationQuoteService(adapter, { now: () => NOW });

    for (const modelId of ["mj-v81", "mj-v7", "mj-niji7"]) {
      await expect(quotes.createQuote({
        modelId,
        modality: "image",
        quantity: 5,
        parameters: { prompt: "cinematic city" },
      })).rejects.toMatchObject({ code: "OUTPUT_COUNT_UNSUPPORTED" });
    }
  });

  it("keeps an upstream-provided Midjourney 8.1 entry authoritative without duplication or overwrite", async () => {
    const payload = sourceCatalog() as unknown as { pricing_version: string; models: Array<Record<string, any>> };
    payload.pricing_version = "pricing-41";
    payload.models.push({
      id: "mj-v8.1",
      modality: "image",
      operation: "generate",
      order: 50,
      input: { text: { required: true }, images: { min: 0, max: 5, multiple: true } },
      output: { type: "image", count: { fixed: 4 } },
      parameters: [
        { name: "model", path: "model", type: "string", required: true, fixed: "mj-v8.1", label: "模型" },
        { name: "prompt", path: "prompt", type: "string", required: true, label: "提示词" },
      ],
      public: { id: "mj-v81", label: "Midjourney 8.1" },
      selectable: true,
      pricing: { mode: "fixed", unit: "request", currency: "CNY", credits: 41, yuan: 0.41 },
      endpoint: { method: "POST", path: "/v1/midjourney/generations", content_type: "application/json" },
    });

    const adapter = createAdapter(payload, new MemoryCatalogSnapshotStore(), true);
    const catalog = await adapter.getCatalog();
    const matches = catalog.models.filter((item) => item.id === "mj-v81");

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      output: { type: "image", minCount: 4, maxCount: 4 },
      input: { images: { min: 0, max: 5, multiple: true } },
      // The fallback's 40/0.4 contract must never overwrite this distinct
      // internally consistent upstream price.
      pricing: { unit: "request", creditsPerYuan: 100, baseCreditMicros: 41_000_000, baseYuanMicros: 410_000 },
    });
    // The upstream entry had no submission-count parameter; normalization adds
    // a fixed n=1 so four artifacts are never read as four calls, without
    // touching the upstream price or parameters.
    expect(matches[0]?.parameters.map((parameter) => parameter.name)).toEqual(["prompt", "n"]);
    expect(matches[0]?.parameters.find((parameter) => parameter.name === "n")).toMatchObject({ fixed: 1 });
    expect(catalog.pricingVersion).toBe("pricing-41");

    const quote = await new GenerationQuoteService(adapter, { now: () => NOW }).createQuote({
      modelId: "mj-v81",
      modality: "image",
      parameters: { prompt: "cinematic city" },
    });
    expect(quote).toMatchObject({ credits: "41", yuan: "0.41", outputCount: 4, pricingVersion: "pricing-41" });
  });

  it("pads an upstream Midjourney entry missing n/count without overwriting its trusted price", async () => {
    const payload = sourceCatalog() as unknown as { pricing_version: string; models: Array<Record<string, any>> };
    payload.pricing_version = "pricing-mj7";
    payload.models.push({
      id: "mj-live-7",
      modality: "image",
      operation: "generate",
      order: 81,
      input: { text: { required: true }, images: { min: 0, max: 14, multiple: true } },
      output: { type: "image" },
      parameters: [
        { name: "model", path: "model", type: "string", required: true, fixed: "mj-live-7", label: "模型" },
        { name: "prompt", path: "prompt", type: "string", required: true, label: "提示词" },
      ],
      public: { id: "mj-v7", label: "Midjourney 7" },
      selectable: true,
      pricing: { mode: "fixed", unit: "request", currency: "CNY", credits: 40, yuan: 0.4 },
      endpoint: { method: "POST", path: "/v1/midjourney/generations", content_type: "application/json" },
    });

    const adapter = createAdapter(payload, new MemoryCatalogSnapshotStore(), true);
    const catalog = await adapter.getCatalog();
    const matches = catalog.models.filter((item) => item.id === "mj-v7");

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      output: { type: "image", minCount: 4, maxCount: 4 },
      pricing: { unit: "request", creditsPerYuan: 100, baseCreditMicros: 40_000_000, baseYuanMicros: 400_000 },
    });
    expect(matches[0]?.parameters.find((parameter) => parameter.name === "n")).toMatchObject({ fixed: 1 });
    expect(catalog.pricingVersion).toBe("pricing-mj7");

    const quote = await new GenerationQuoteService(adapter, { now: () => NOW }).createQuote({
      modelId: "mj-v7",
      modality: "image",
      parameters: { prompt: "cinematic city" },
    });
    expect(quote).toMatchObject({
      quantity: 1,
      outputCount: 4,
      credits: "40",
      yuan: "0.4",
      pricingUnit: "request",
      pricingVersion: "pricing-mj7",
    });
  });

  it("preserves a valid non-empty upstream pricing version unchanged", async () => {
    const catalog = await createAdapter(sourceCatalog()).getCatalog();
    expect(catalog.pricingVersion).toBe("pricing-1");
  });

  it("derives a content pricing version that rotates when price-relevant content changes", async () => {
    const payload = sourceCatalog() as unknown as { pricing_version: string; models: Array<Record<string, any>> };
    payload.pricing_version = "";
    const first = await createAdapter(payload).getCatalog();
    const second = await createAdapter(payload).getCatalog();

    expect(first.pricingVersion).toMatch(/^content:[0-9a-f]{16}$/);
    expect(first.pricingVersion).not.toBe("unknown");
    expect(second.pricingVersion).toBe(first.pricingVersion);

    const changed = structuredClone(payload) as typeof payload;
    changed.models[0]!.pricing.credits = 7;
    changed.models[0]!.pricing.yuan = 0.07;
    expect((await createAdapter(changed).getCatalog()).pricingVersion).not.toBe(first.pricingVersion);
  });

  it("never lets a selectable paid quote carry an unknown pricing version sentinel", async () => {
    for (const sentinel of ["unknown", "Unknown", "UNKNOWN", " unknown ", "  Unknown  "]) {
      const payload = sourceCatalog() as unknown as { pricing_version: string; models: Array<Record<string, any>> };
      payload.pricing_version = sentinel;
      const adapter = createAdapter(payload, new MemoryCatalogSnapshotStore(), true);
      const catalog = await adapter.getCatalog();
      expect(catalog.pricingVersion).toMatch(/^content:[0-9a-f]{16}$/);
      expect(catalog.pricingVersion).not.toBe("unknown");

      const quote = await new GenerationQuoteService(adapter, { now: () => NOW }).createQuote({
        modelId: "mj-v81",
        modality: "image",
        parameters: { prompt: "cinematic city" },
      });
      expect(quote.pricingVersion).toMatch(/^content:[0-9a-f]{16}$/);
      expect(quote.pricingVersion).not.toBe("unknown");
      expect(catalog.models.some((model) => model.id === "mj-v81")).toBe(true);
    }
  });

  it("renews the trusted quote window when the source confirms an unchanged ETag", async () => {
    let now = NOW;
    let calls = 0;
    const store = new MemoryCatalogSnapshotStore();
    const adapter = new KachangCatalogAdapter({
      sourceUrl: "https://catalog.test/models",
      store,
      now: () => now,
      refreshIntervalMs: 0,
      maxQuoteAgeMs: 1_000,
      fetch: async () => {
        calls += 1;
        if (calls === 1) return jsonResponse(sourceCatalog(), { ETag: '"catalog-1"' });
        return new Response(null, { status: 304, headers: { ETag: '"catalog-1"' } });
      },
    });

    expect((await adapter.getCatalog()).expiresAt).toBe(new Date(NOW + 1_000).toISOString());
    now = NOW + 900;
    const renewed = await adapter.getCatalog({ forceRefresh: true });

    expect(renewed.quoteAvailable).toBe(true);
    expect(renewed.expiresAt).toBe(new Date(now + 1_000).toISOString());
    expect(store.snapshot?.validatedAt).toBe(now);
  });

  it("forces a full refresh when a stored snapshot predates private execution routes", async () => {
    const store = new MemoryCatalogSnapshotStore();
    await createAdapter(sourceCatalog(), store).getCatalog();
    store.snapshot = { ...store.snapshot!, routes: {} };
    let conditionalHeader: string | null = "not-called";
    const adapter = new KachangCatalogAdapter({
      sourceUrl: "https://catalog.test/models",
      store,
      now: () => NOW + 30_000,
      fetch: async (_input, init) => {
        conditionalHeader = new Headers(init?.headers).get("If-None-Match");
        return jsonResponse(sourceCatalog(), { ETag: '"catalog-1"' });
      },
    });

    expect((await adapter.getCatalog()).quoteAvailable).toBe(true);
    expect(conditionalHeader).toBeNull();
    expect((await adapter.getModel("image2-pro"))?.route.endpoint.path).toBe("/v1/images/generations");
  });
});

describe("video availability filtering", () => {
  it("keeps validated video models when the legacy inventory lags behind publication", async () => {
    const store = new MemoryCatalogSnapshotStore();
    const adapter = new KachangCatalogAdapter({
      sourceUrl: "https://catalog.test/models",
      videoInventoryUrl: "https://inventory.test/video",
      store,
      now: () => NOW,
      refreshIntervalMs: 0,
      fetch: async () => jsonResponse(sourceCatalog(), { ETag: '"catalog-1"' }),
      inventoryFetch: async () => jsonResponse({ success: true, models: [] }),
    });

    const catalog = await adapter.getCatalog();
    expect(catalog.models.find((model) => model.id === "motion-video")).toMatchObject({ modality: "video" });
    expect(catalog.models.find((model) => model.id === "image2-pro")).toMatchObject({ modality: "image" });
  });

  it("does not hide validated video models when the hosted inventory refresh fails", async () => {
    let now = NOW;
    const store = new MemoryCatalogSnapshotStore();
    const seeding = new KachangCatalogAdapter({
      sourceUrl: "https://catalog.test/models",
      videoInventoryUrl: "https://inventory.test/video",
      store,
      now: () => now,
      refreshIntervalMs: 0,
      maxQuoteAgeMs: 100_000,
      fetch: async () => jsonResponse(sourceCatalog(), { ETag: '"catalog-1"' }),
      inventoryFetch: async () => jsonResponse({ success: true, models: [
        { id: "motion-video", modality: "video", selectable: true },
      ] }),
    });
    expect((await seeding.getCatalog()).models.some((model) => model.id === "motion-video")).toBe(true);

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const adapter = new KachangCatalogAdapter({
      sourceUrl: "https://catalog.test/models",
      videoInventoryUrl: "https://inventory.test/video",
      store,
      now: () => now,
      refreshIntervalMs: 0,
      maxQuoteAgeMs: 100_000,
      fetch: async () => jsonResponse(sourceCatalog(), { ETag: '"catalog-1"' }),
      inventoryFetch: async () => { throw new Error("inventory offline"); },
    });
    now = NOW + 30_000;
    expect((await adapter.getCatalog({ forceRefresh: true })).models.some((model) => model.id === "motion-video")).toBe(true);
    expect(store.snapshot?.catalog.models.some((model) => model.id === "motion-video")).toBe(true);
    error.mockRestore();
  });

  it("hides video models the hosted inventory explicitly disables", async () => {
    const store = new MemoryCatalogSnapshotStore();
    const adapter = new KachangCatalogAdapter({
      sourceUrl: "https://catalog.test/models",
      videoInventoryUrl: "https://inventory.test/video",
      store,
      now: () => NOW,
      refreshIntervalMs: 0,
      fetch: async () => jsonResponse(sourceCatalog(), { ETag: '"catalog-1"' }),
      inventoryFetch: async () => jsonResponse({
        success: true,
        models: [
          { id: "motion-video", modality: "video", selectable: false },
          { id: "image2-pro", modality: "image", selectable: true },
        ],
      }),
    });

    const catalog = await adapter.getCatalog();
    expect(catalog.models.some((model) => model.id === "motion-video")).toBe(false);
    expect(catalog.models.find((model) => model.id === "image2-pro")).toMatchObject({ modality: "image" });
  });

  it("refreshes video availability with ETag revalidation and keeps the last good snapshot", async () => {
    let now = NOW;
    let catalogCalls = 0;
    let inventoryCalls = 0;
    const store = new MemoryCatalogSnapshotStore();
    const adapter = new KachangCatalogAdapter({
      sourceUrl: "https://catalog.test/models",
      videoInventoryUrl: "https://inventory.test/video",
      store,
      now: () => now,
      refreshIntervalMs: 0,
      maxQuoteAgeMs: 1_000,
      fetch: async () => {
        catalogCalls += 1;
        if (catalogCalls === 1) return jsonResponse(sourceCatalog(), { ETag: '"catalog-1"' });
        return new Response(null, { status: 304, headers: { ETag: '"catalog-1"' } });
      },
      inventoryFetch: async () => {
        inventoryCalls += 1;
        return jsonResponse({
          success: true,
          models: [{ id: "motion-video", modality: "video", selectable: false }],
        });
      },
    });

    expect((await adapter.getCatalog()).models.some((model) => model.id === "motion-video")).toBe(false);
    now = NOW + 900;
    const renewed = await adapter.getCatalog({ forceRefresh: true });
    expect(renewed.quoteAvailable).toBe(true);
    expect(renewed.models.some((model) => model.id === "motion-video")).toBe(false);
    expect(store.snapshot?.videoAvailability?.disabledModelIds).toEqual(["motion-video"]);
  });
});

describe("generation quotes", () => {
  it("preserves reference-media purposes and validates every declared slot", async () => {
    const payload = sourceCatalog() as unknown as { models: Array<Record<string, unknown>> };
    payload.models.push({
      id: "private-reference-video",
      modality: "video",
      operation: "generate",
      input: {
        text: { required: true },
        reference_media: {
          images: { role: "frame", min: 0, max: 2 },
          style_images: { min: 0, max: 1 },
          element_images: { min: 0, max: 2 },
          max_total_items: 3,
        },
      },
      output: { type: "video" },
      parameters: [
        { name: "model", type: "string", fixed: "private-reference-video" },
        { name: "prompt", type: "string", required: true },
        { name: "referenceImages", path: "images", type: "array", max_items: 2, format: "uri-or-data-image" },
        { name: "referenceImages", path: "style_references", type: "array", max_items: 1, format: "uri-or-data-image" },
        { name: "referenceImages", path: "element_references", type: "array", max_items: 2, format: "uri-or-data-image" },
      ],
      public: { id: "reference-video", label: "Reference video" },
      selectable: true,
      pricing: { mode: "fixed", unit: "request", currency: "CNY", credits: 1, yuan: 0.01 },
      endpoint: { method: "POST", path: "/v1/videos", content_type: "application/json" },
    });
    payload.models.push({
      id: "private-total-limited-video",
      modality: "video",
      operation: "generate",
      input: {
        text: { required: true },
        images: { min: 0, max: 2, multiple: true },
        videos: { min: 0, max: 1, multiple: false },
        reference_media: { max_total_items: 2 },
      },
      output: { type: "video" },
      parameters: [
        { name: "model", type: "string", fixed: "private-total-limited-video" },
        { name: "prompt", type: "string", required: true },
        { name: "referenceImages", path: "images", type: "array", max_items: 2, format: "uri-or-data-image" },
        { name: "referenceVideos", path: "input_video", type: "string", format: "uri-or-data-video" },
      ],
      public: { id: "total-limited-video", label: "Total limited video" },
      selectable: true,
      pricing: { mode: "fixed", unit: "request", currency: "CNY", credits: 1, yuan: 0.01 },
      endpoint: { method: "POST", path: "/v1/videos", content_type: "application/json" },
    });
    const adapter = createAdapter(payload);
    const catalog = await adapter.getCatalog();
    expect(catalog.models.find((model) => model.id === "reference-video")?.input.referenceMedia).toEqual({
      images: { role: "frame", min: 0, max: 2, multiple: true },
      styleImages: { min: 0, max: 1, multiple: false },
      elementImages: { min: 0, max: 2, multiple: true },
      maxTotalItems: 3,
    });
    expect(catalog.models.find((model) => model.id === "total-limited-video")?.input.referenceMedia).toMatchObject({
      maxTotalItems: 2,
    });

    const quotes = new GenerationQuoteService(adapter, { now: () => NOW });
    await expect(quotes.createQuote({
      modelId: "reference-video",
      modality: "video",
      parameters: { prompt: "test" },
      inputs: { images: 1, styleImages: 1, elementImages: 1 },
    })).resolves.toMatchObject({ modelId: "reference-video" });
    await expect(quotes.createQuote({
      modelId: "reference-video",
      modality: "video",
      parameters: { prompt: "test" },
      inputs: { styleImages: 2 },
    })).rejects.toMatchObject({ code: "TOO_MANY_REFERENCES" });
    await expect(quotes.createQuote({
      modelId: "reference-video",
      modality: "video",
      parameters: { prompt: "test" },
      inputs: { images: 2, styleImages: 1, elementImages: 1 },
    })).rejects.toMatchObject({ code: "TOO_MANY_REFERENCES" });
    await expect(quotes.createQuote({
      modelId: "total-limited-video",
      modality: "video",
      parameters: { prompt: "test" },
      inputs: { images: 2 },
    })).resolves.toMatchObject({ modelId: "total-limited-video" });
    await expect(quotes.createQuote({
      modelId: "total-limited-video",
      modality: "video",
      parameters: { prompt: "test" },
      inputs: { images: 2, videos: 1 },
    })).rejects.toMatchObject({ code: "TOO_MANY_REFERENCES" });
    await expect(quotes.createQuote({
      modelId: "motion-video",
      modality: "video",
      parameters: { prompt: "test", duration: 5 },
      inputs: { styleImages: 1 },
    })).rejects.toMatchObject({ code: "UNSUPPORTED_REFERENCE" });
  });

  it("quotes tiered images, per-second video, and token estimates with fixed precision", async () => {
    const adapter = createAdapter(sourceCatalog());
    const quotes = new GenerationQuoteService(adapter, { now: () => NOW, quoteTtlMs: 60_000 });

    const image = await quotes.createQuote({
      modelId: "image2-pro",
      modality: "image",
      quantity: 2,
      parameters: { prompt: "雨夜街道", quality: "4k", n: 2 },
      inputs: { images: 3 },
    });
    expect(image).toMatchObject({ credits: "80", yuan: "0.8", creditMicros: 80_000_000, estimated: false });

    const video = await quotes.createQuote({
      modelId: "motion-video",
      modality: "video",
      parameters: { prompt: "人物转身", duration: 10 },
      inputs: { images: 1 },
    });
    expect(video).toMatchObject({ credits: "19", yuan: "0.19", pricingUnit: "second" });

    const text = await quotes.createQuote({
      modelId: "creative-text",
      modality: "text",
      parameters: { messages: [{ role: "user", content: "改写" }] },
      inputTokens: 1_000,
      maxOutputTokens: 2_000,
    });
    expect(text).toMatchObject({ credits: "0.195", yuan: "0.00195", estimated: true });
  });

  it("quotes a token-priced video model by duration and the station reference rate", async () => {
    const quotes = new GenerationQuoteService(createAdapter(tokenVideoPayload()), { now: () => NOW, quoteTtlMs: 60_000 });

    const fiveSeconds = await quotes.createQuote({
      modelId: "seedance-token",
      modality: "video",
      parameters: { prompt: "test", duration_seconds: 5 },
    });
    expect(fiveSeconds).toMatchObject({
      credits: "322.92",
      yuan: "3.2292",
      pricingUnit: "token",
      estimated: true,
    });

    // 时长翻三倍，报价必须跟着走。旧的文本 token 估算对任何时长都给同一个数，
    // 而且比真实价格低两个数量级。
    const fifteenSeconds = await quotes.createQuote({
      modelId: "seedance-token",
      modality: "video",
      parameters: { prompt: "test", duration_seconds: 15 },
    });
    expect(fifteenSeconds).toMatchObject({ credits: "968.76", yuan: "9.6876", estimated: true });
  });

  it("publishes the reference rate and note a token video quote is built from", async () => {
    const catalog = await createAdapter(tokenVideoPayload()).getCatalog();
    const model = catalog.models.find((candidate) => candidate.id === "seedance-token");
    expect(model?.pricing.estimatedYuanMicrosPerSecond).toBe(645_840);
    expect(model?.pricing.estimateNote).toBe("平均参考价，仅供参考，以实际用量为准");
  });

  it("refuses to quote a token video model with no published reference rate", async () => {
    const quotes = new GenerationQuoteService(createAdapter(tokenVideoPayload(false)), { now: () => NOW, quoteTtlMs: 60_000 });

    // 没有参考价时明确报「价格无法确认」，绝不用文本 token 公式凑一个数出来。
    await expect(quotes.createQuote({
      modelId: "seedance-token",
      modality: "video",
      parameters: { prompt: "test", duration_seconds: 5 },
      inputTokens: 13,
      maxOutputTokens: 1_024,
    })).rejects.toThrow("当前模型价格暂时无法确认");
  });

  it("rejects unsupported options, modalities, and reference counts", async () => {
    const quotes = new GenerationQuoteService(createAdapter(sourceCatalog()), { now: () => NOW });
    await expect(quotes.createQuote({
      modelId: "image2-pro",
      modality: "video",
      parameters: { prompt: "test", quality: "4k" },
    })).rejects.toThrow("不支持当前节点类型");
    await expect(quotes.createQuote({
      modelId: "image2-pro",
      modality: "image",
      parameters: { prompt: "test", quality: "8k" },
    })).rejects.toThrow("不支持这个选项");
    await expect(quotes.createQuote({
      modelId: "motion-video",
      modality: "video",
      parameters: { prompt: "test", duration: 4 },
      inputs: { images: 2 },
    })).rejects.toThrow("参考图片最多支持 1 个");
  });

  it("never lets a quote outlive the validated catalog snapshot", async () => {
    const adapter = new KachangCatalogAdapter({
      sourceUrl: "https://catalog.test/models",
      store: new MemoryCatalogSnapshotStore(),
      now: () => NOW,
      maxQuoteAgeMs: 30_000,
      fetch: async () => jsonResponse(sourceCatalog()),
    });
    const quotes = new GenerationQuoteService(adapter, { now: () => NOW, quoteTtlMs: 60_000 });
    const quote = await quotes.createQuote({
      modelId: "image2-pro",
      modality: "image",
      parameters: { prompt: "test" },
    });

    expect(quote.expiresAt).toBe(new Date(NOW + 30_000).toISOString());
  });

  it("publishes one documented parameter per compatibility family and remaps pricing tiers", async () => {
    const payload = sourceCatalog() as { models: Array<Record<string, unknown>> };
    payload.models.push({
      id: "private-minimax-h3",
      modality: "video",
      operation: "generate",
      input: {
        text: { required: true },
        images: { min: 0, max: 9, multiple: true },
      },
      output: { type: "video", count: { fixed: 1 } },
      parameters: [
        { name: "model", type: "string", fixed: "private-minimax-h3" },
        { name: "prompt", type: "string", required: true },
        { name: "seconds", type: "integer", default: 4, min: 1, max: 10, label: "时长兼容字段（秒）" },
        { name: "duration", type: "integer", default: 4, min: 1, max: 10, label: "时长（秒）" },
        { name: "size", type: "string", default: "1080p", options: ["768", "1080p", "2K", "4K"] },
        { name: "resolution", type: "string", default: "1080p", options: ["768", "1080p", "2K", "4K"], label: "分辨率兼容别名" },
      ],
      documentation: { request_example: { model: "minimax_h3", prompt: "test", seconds: 4, size: "1080p" } },
      public: { id: "minimax_h3", label: "Minimax H3", description: "支持 768、1080p、2K、4K；2K/4K 需要至少一张参考图片。" },
      selectable: true,
      pricing: {
        mode: "tiered",
        unit: "request",
        currency: "CNY",
        credits_per_yuan: 100,
        credits: 1,
        yuan: 0.01,
        tiers: [
          { when: { resolution: "768" }, credits: 2, yuan: 0.02 },
          { when: { resolution: "2K" }, credits: 3, yuan: 0.03 },
          { when: { resolution: "4K" }, credits: 4, yuan: 0.04 },
        ],
      },
      endpoint: { method: "POST", path: "/v1/videos", content_type: "application/json" },
    });
    payload.models.push({
      id: "private-image2-a",
      modality: "image",
      operation: "generate",
      input: { text: { required: true } },
      output: { type: "image" },
      parameters: [
        { name: "model", type: "string", fixed: "private-image2-a" },
        { name: "prompt", type: "string", required: true },
        { name: "resolution", type: "string", default: "1k", options: ["1k", "2k", "4k"] },
        { name: "size", type: "string", options: ["1k", "2k", "4k"], label: "像素尺寸或兼容比例" },
        { name: "aspect_ratio", type: "string", default: "auto", options: ["auto", "16:9"] },
        { name: "aspectRatio", type: "string", options: ["auto", "16:9"], label: "画面比例（兼容别名）" },
        { name: "ratio", type: "string", options: ["auto", "16:9"], label: "画面比例（兼容别名）" },
        { name: "quality", type: "string", default: "standard", options: ["low", "standard", "high"] },
      ],
      documentation: { request_example: { model: "image2-A", prompt: "test", resolution: "1k", aspect_ratio: "auto", quality: "standard", n: 1 } },
      public: { id: "image2-A", label: "全能模型2-A" },
      selectable: true,
      pricing: { mode: "fixed", unit: "image", currency: "CNY", credits_per_yuan: 100, credits: 3, yuan: 0.03 },
      endpoint: { method: "POST", path: "/v1/images/generations", content_type: "application/json" },
    });

    const adapter = createAdapter(payload);
    const catalog = await adapter.getCatalog();
    const h3 = catalog.models.find((model) => model.id === "minimax_h3")!;
    const image2A = catalog.models.find((model) => model.id === "image2-A")!;
    expect(h3.parameters.map((parameter) => parameter.name)).toEqual(["prompt", "seconds", "resolution"]);
    expect(h3.parameters.find((parameter) => parameter.name === "seconds")?.label).toBe("时长（秒）");
    expect(h3.parameters.find((parameter) => parameter.name === "resolution")?.label).toBe("分辨率");
    expect(image2A.parameters.map((parameter) => parameter.name)).toEqual(["prompt", "resolution", "aspect_ratio", "quality"]);
    expect((await adapter.getModel("minimax_h3"))?.route.parameters.map((parameter) => parameter.name)).toEqual([
      "model", "prompt", "seconds", "duration", "size", "resolution",
    ]);

    const quotes = new GenerationQuoteService(adapter, { now: () => NOW });
    await expect(quotes.createQuote({
      modelId: "minimax_h3",
      modality: "video",
      parameters: { prompt: "test", seconds: 4, resolution: "768" },
    })).resolves.toMatchObject({ credits: "2", normalizedParameters: { seconds: 4, resolution: "768" } });
    await expect(quotes.createQuote({
      modelId: "minimax_h3",
      modality: "video",
      parameters: { prompt: "test", seconds: 4, resolution: "2K" },
    })).rejects.toMatchObject({ code: "H3_REFERENCE_REQUIRED" });
    await expect(quotes.createQuote({
      modelId: "minimax_h3",
      modality: "video",
      parameters: { prompt: "test", seconds: 4, resolution: "4K" },
      inputs: { images: 1 },
    })).resolves.toMatchObject({ credits: "4", normalizedParameters: { resolution: "4K" } });
    await expect(quotes.createQuote({
      modelId: "image2-A",
      modality: "image",
      parameters: { prompt: "test", resolution: "1k", aspect_ratio: "auto", quality: "standard", size: "1k" },
    })).rejects.toMatchObject({ code: "UNKNOWN_PARAMETER" });
  });

  it("canonicalizes case-insensitive MJ resolution options before pricing", async () => {
    const payload = sourceCatalog() as { models: Array<Record<string, unknown>> };
    payload.models.push({
      id: "mj-case",
      modality: "image",
      operation: "generate",
      input: { text: { required: true } },
      output: { type: "image", count: { fixed: 4 } },
      parameters: [
        { name: "model", type: "string", fixed: "mj-case" },
        { name: "prompt", type: "string", required: true },
        { name: "resolution", type: "string", default: "1K", options: ["1K", "2K"] },
      ],
      public: { id: "mj-case", label: "MJ case" },
      selectable: true,
      pricing: {
        mode: "tiered", unit: "request", currency: "CNY", credits_per_yuan: 100, credits: 1, yuan: 0.01,
        tiers: [{ when: { resolution: "2K" }, credits: 2, yuan: 0.02 }],
      },
      endpoint: { method: "POST", path: "/v1/midjourney/generations", content_type: "application/json" },
    });
    const adapter = createAdapter(payload);
    const quote = await new GenerationQuoteService(adapter, { now: () => NOW }).createQuote({
      modelId: "mj-case",
      modality: "image",
      parameters: { prompt: "test", resolution: "2k" },
    });
    expect(quote.normalizedParameters).toMatchObject({ resolution: "2K" });
    expect(quote.credits).toBe("2");
  });
});

describe("catalog API", () => {
  it("filters by modality, returns ETags, and creates quotes", async () => {
    const adapter = createAdapter(sourceCatalog());
    const app = createApiApp({ catalog: adapter, quotes: new GenerationQuoteService(adapter, { now: () => NOW }) });
    const response = await app.request("/api/v1/model-catalog?modality=image");
    expect(response.status).toBe(200);
    const payload = await response.json() as { data: { models: Array<{ modality: string }> } };
    expect(payload.data.models.every((model) => model.modality === "image")).toBe(true);
    const etag = response.headers.get("etag");
    expect(etag).toBeTruthy();
    expect((await app.request("/api/v1/model-catalog?modality=image", { headers: { "If-None-Match": etag! } })).status).toBe(304);

    const quote = await app.request("/api/v1/generation-quotes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "motion-video", modality: "video", parameters: { prompt: "test", duration: 5 } }),
    });
    expect(quote.status).toBe(200);
    expect(await quote.json()).toMatchObject({ ok: true, data: { credits: "9.5" } });
  });
});

function createAdapter(payload: unknown, store = new MemoryCatalogSnapshotStore(), includeKnownModels = false) {
  return new KachangCatalogAdapter({
    sourceUrl: "https://catalog.test/models",
    store,
    now: () => NOW,
    includeKnownModels,
    fetch: async () => jsonResponse(payload, { ETag: '"catalog-1"' }),
  });
}

/**
 * 站点按 token 计价、但给不出浏览器侧 token 估算的视频模型（官转 Seedance）。
 * 这份模型只挂在需要它的用例上：塞进 sourceCatalog() 会改变所有断言模型清单
 * 的用例，那是别的测试在做的事。
 */
function tokenVideoPayload(withReferenceRate = true) {
  const payload = sourceCatalog() as { models: Array<Record<string, unknown>> };
  const pricing: Record<string, unknown> = {
    mode: "token",
    unit: "token",
    currency: "CNY",
    credits_per_yuan: 100,
    input_credits_per_million: 2990,
    output_credits_per_million: 2990,
    input_yuan_per_million: 29.9,
    output_yuan_per_million: 29.9,
  };
  if (withReferenceRate) {
    pricing.estimated_yuan_per_second = 0.64584;
    pricing.estimate_note = "平均参考价，仅供参考，以实际用量为准";
  }
  payload.models.push({
    id: "private-seedance-token-route",
    modality: "video",
    operation: "generate",
    input: { text: { required: true }, images: { min: 0, max: 9, multiple: true } },
    output: { type: "video", count: { fixed: 1 } },
    parameters: [
      { name: "model", type: "string", fixed: "private-seedance-token-route" },
      { name: "prompt", type: "string", required: true, label: "提示词" },
      { name: "duration_seconds", type: "integer", default: 5, min: 4, max: 15, label: "时长（秒）" },
      { name: "resolution", type: "string", fixed: "720P", label: "分辨率" },
    ],
    public: { id: "seedance-token", label: "Seedance 官转" },
    selectable: true,
    endpoint: { method: "POST", path: "/v1/videos", content_type: "application/json" },
    pricing,
  });
  return payload;
}

function jsonResponse(payload: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json", ...headers } });
}

function sourceCatalog() {
  return {
    success: true,
    version: "catalog-1",
    capability_version: "capability-1",
    pricing_version: "pricing-1",
    fetched_at: new Date(NOW).toISOString(),
    credits_per_yuan: 100,
    models: [
      {
        id: "private-image-route",
        modality: "image",
        operation: "generate",
        order: 20,
        input: { text: { required: true }, images: { min: 0, max: 14, multiple: true } },
        output: { type: "image", count: { min: 1, max: 4 } },
        parameters: [
          { name: "model", type: "string", required: true, fixed: "private-image-route" },
          { name: "prompt", type: "string", required: true, min_length: 1, label: "提示词" },
          { name: "quality", type: "string", default: "2k", options: ["1k", "2k", "4k"], label: "分辨率" },
          { name: "n", type: "integer", default: 1, min: 1, max: 4, label: "生成张数" },
          { name: "images", type: "array", max_items: 14, format: "uri-or-data-image", label: "参考图" },
        ],
        public: { id: "image2-pro", label: "全能模型2 · 高质量", description: "支持多档分辨率" },
        selectable: true,
        pricing: {
          mode: "tiered",
          unit: "image",
          currency: "CNY",
          credits_per_yuan: 100,
          yuan: 0.0695,
          credits: 6.95,
          group: "internal-image-group",
          tiers: [
            { when: { quality: "2k" }, yuan: 0.15, credits: 15 },
            { when: { quality: "4k" }, yuan: 0.2, credits: 20 },
          ],
        },
        endpoint: { method: "POST", path: "/v1/images/generations", content_type: "application/json" },
      },
      {
        id: "private-video-route",
        modality: "video",
        operation: "generate",
        input: { text: { required: true }, images: { min: 0, max: 1, multiple: false } },
        output: { type: "video", count: { fixed: 1 } },
        parameters: [
          { name: "model", type: "string", fixed: "private-video-route" },
          { name: "prompt", type: "string", required: true, label: "提示词" },
          { name: "duration", type: "integer", default: 4, min: 1, max: 15, label: "时长" },
        ],
        public: { id: "motion-video", label: "动态影像" },
        selectable: true,
        pricing: { mode: "fixed", unit: "second", currency: "CNY", credits_per_yuan: 100, yuan: 0.019, credits: 1.9 },
        endpoint: { method: "POST", path: "/v1/videos", content_type: "application/json" },
      },
      {
        id: "private-text-route",
        modality: "text",
        operation: "chat",
        input: { text: { required: true } },
        output: { type: "text" },
        parameters: [
          { name: "model", type: "string", fixed: "private-text-route" },
          { name: "messages", type: "array", required: true, min_items: 1, items: { type: "object" }, label: "消息" },
        ],
        public: { id: "creative-text", label: "全能文本" },
        selectable: true,
        endpoint: { method: "POST", path: "/v1/chat/completions", content_type: "application/json" },
        pricing: {
          mode: "token",
          unit: "token",
          currency: "CNY",
          credits_per_yuan: 100,
          input_credits_per_million: 15,
          output_credits_per_million: 90,
          input_yuan_per_million: 0.15,
          output_yuan_per_million: 0.9,
        },
      },
      {
        id: "hidden-private-route",
        modality: "image",
        operation: "generate",
        output: { type: "image" },
        parameters: [],
        public: { id: "hidden-model", label: "隐藏模型" },
        selectable: false,
        pricing: { mode: "fixed", unit: "image", currency: "CNY", credits: 1, yuan: 0.01 },
      },
      {
        id: "unreviewed-private-route",
        modality: "image",
        operation: "generate",
        output: { type: "image" },
        parameters: [],
        selectable: true,
        pricing: { mode: "fixed", unit: "image", currency: "CNY", credits: 1, yuan: 0.01 },
      },
    ],
  };
}
