import { describe, expect, it } from "vitest";

import type { PrivateModelRoute } from "./execution-route.js";
import { KachangCatalogAdapter } from "./adapter.js";
import { NON_MJ_NOW_ISO, NON_MJ_IMAGE_MODEL_IDS, NON_MJ_VIDEO_MODEL_IDS, TASK_REQUIRED_NON_MJ_MODEL_IDS, buildNonMjSourceCatalog } from "./nonmj-catalog-fixture.js";
import { GenerationQuoteService } from "./quote.js";
import { MemoryCatalogSnapshotStore } from "./store.js";

const NOW = Date.parse(NON_MJ_NOW_ISO);

function createAdapter(payload: unknown) {
  return new KachangCatalogAdapter({
    sourceUrl: "https://catalog.test/models",
    store: new MemoryCatalogSnapshotStore(),
    now: () => NOW,
    includeKnownModels: true,
    fetch: async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json", ETag: '"nonmj-1"' },
    }),
  });
}

describe("non-MJ selectable image/video model matrix construction", () => {
  const adapter = createAdapter(buildNonMjSourceCatalog());

  it("exposes every repo-evidenced non-MJ image/video model as selectable", async () => {
    const catalog = await adapter.getCatalog({ forceRefresh: true, awaitRefresh: true });
    const publicIds = new Set(catalog.models.map((model) => model.id));
    for (const modelId of [...NON_MJ_IMAGE_MODEL_IDS, ...NON_MJ_VIDEO_MODEL_IDS]) {
      expect(publicIds.has(modelId), `missing selectable model ${modelId}`).toBe(true);
    }
    for (const modelId of TASK_REQUIRED_NON_MJ_MODEL_IDS) {
      expect(publicIds.has(modelId), `task-required model ${modelId} is missing`).toBe(true);
    }
  });

  it("normalizes every non-MJ model with a private route and derived non-unknown pricing version", async () => {
    const snapshot = await adapter.getModel("nano-banana-pro");
    expect(snapshot).not.toBeNull();
    expect(snapshot!.model.pricing.pricingVersion).toBeUndefined();
    expect(snapshot!.catalog.pricingVersion).toMatch(/^content:/);
    const record = snapshot!;
    expect(record.sourceModelId).toBe("nano-banana-pro");
    expect(record.route.modality).toBe("image");
    expect(record.route.endpoint).toEqual({
      method: "POST",
      path: "/v1/images/generations",
      contentType: "application/json",
    });
    const modelParam = record.route.parameters.find((parameter) => parameter.name === "model");
    expect(modelParam).toMatchObject({ path: "model", type: "string", fixed: "nano-banana-pro" });
    const resolution = record.route.parameters.find((parameter) => parameter.name === "resolution");
    expect(resolution).toMatchObject({ path: "resolution", type: "string" });
  });

  it("routes image2-A as a standard image route whose async redirect is provider-runtime", async () => {
    const record = await adapter.getModel("image2-A");
    expect(record).not.toBeNull();
    expect(record!.route.sourceModelId).toBe("image2-A");
    expect(record!.route.endpoint.path).toBe("/v1/images/generations");
    expect(record!.route.parameters.some((parameter) => parameter.name === "n" && parameter.fixed === 1)).toBe(true);
    // The KachangGenerationProvider redirects the image2-A source id to the
    // /v1/videos async task API at submit time; the catalog route stays a
    // standard reviewed image route so normalization never rejects it.
  });

  it("derives the fixed resolution for gpt-image-2-1k into the public card only", async () => {
    const record = await adapter.getModel("gpt-image-2-1k");
    expect(record).not.toBeNull();
    const publicModel = record!.model;
    const publicResolution = publicModel.parameters.find((parameter) => parameter.name === "resolution");
    expect(publicResolution).toMatchObject({ fixed: "1k" });
    // The source catalog is authoritative for the upstream body; the derived
    // display resolution stays a public-only presentation field.
    expect(record!.route.parameters.some((parameter) => parameter.name === "resolution")).toBe(false);
  });

  it("remaps the fast 4K source alias to the stable public image2-4k-fast card", async () => {
    const record = await adapter.getModel("image2-4k-fast");
    expect(record).not.toBeNull();
    expect(record!.model.label).toBe("全能模型2 · 4K");
    expect(record!.route.parameters.find((parameter) => parameter.name === "resolution")).toMatchObject({ fixed: "4k" });
    expect(record!.route.parameters.find((parameter) => parameter.name === "quality")).toMatchObject({ fixed: "standard" });
    expect(record!.route.parameters.find((parameter) => parameter.name === "n")).toMatchObject({ fixed: 1 });
  });

  it("keeps the sd2.0 reference role and injects the reviewed face-route card", async () => {
    const record = await adapter.getModel("sd2.0-480p");
    expect(record).not.toBeNull();
    const face = await adapter.getModel("sd2.0 pro 满血九图卡脸版");
    expect(face).not.toBeNull();
    expect(face!.model.input.referenceMedia?.images?.max).toBe(9);
  });

  it("quotes each required non-MJ model with legal parameters and a fixed-price contract", async () => {
    const quotes = new GenerationQuoteService(adapter, { now: () => NOW });
    const cases: Array<{ modelId: string; modality: "image" | "video"; parameters: Record<string, unknown>; unit: string }> = [
      { modelId: "gpt-image-2-1k", modality: "image", parameters: { prompt: "城市夜景" }, unit: "image" },
      { modelId: "gpt-image-2-ext", modality: "image", parameters: { prompt: "城市夜景", resolution: "4k", quality: "high" }, unit: "image" },
      { modelId: "image2-A", modality: "image", parameters: { prompt: "城市夜景", resolution: "4k", quality: "high" }, unit: "request" },
      { modelId: "grok-imagine-image", modality: "image", parameters: { prompt: "城市夜景", size: "1024x1024", quality: "high" }, unit: "request" },
      { modelId: "nano-banana", modality: "image", parameters: { prompt: "城市夜景", resolution: "1k" }, unit: "image" },
      { modelId: "nano-banana-pro", modality: "image", parameters: { prompt: "城市夜景", resolution: "4k" }, unit: "image" },
      { modelId: "nano-banana-2", modality: "image", parameters: { prompt: "城市夜景", resolution: "4k" }, unit: "image" },
      { modelId: "kling-o3-pro-v2v-reference", modality: "video", parameters: { prompt: "人物转身", seconds: 5 }, unit: "request" },
      { modelId: "sd2.0-480p", modality: "video", parameters: { prompt: "人物转身", seconds: 5 }, unit: "second" },
    ];
    for (const testCase of cases) {
      const quote = await quotes.createQuote({
        modelId: testCase.modelId,
        modality: testCase.modality,
        parameters: testCase.parameters,
        inputs: { images: 0, styleImages: 0, elementImages: 0, videos: 0, audios: 0 },
        quantity: 1,
      });
      expect(quote.modelId).toBe(testCase.modelId);
      expect(quote.modality).toBe(testCase.modality);
      expect(quote.quantity).toBe(1);
      expect(quote.outputCount).toBeGreaterThanOrEqual(1);
      expect(quote.pricingUnit).toBe(testCase.unit);
      expect(quote.pricingVersion).toMatch(/^content:/);
      expect(quote.expiresAt > NON_MJ_NOW_ISO).toBe(true);
    }
  });

  it("keeps request-priced per-call image models at one output and rejects batch quantity", async () => {
    const quotes = new GenerationQuoteService(adapter, { now: () => NOW });
    const image2AQuote = await quotes.createQuote({
      modelId: "image2-A",
      modality: "image",
      parameters: { prompt: "城市夜景", quality: "high" },
      inputs: { images: 0, styleImages: 0, elementImages: 0, videos: 0, audios: 0 },
      quantity: 1,
    });
    expect(image2AQuote.outputCount).toBe(1);
    await expect(quotes.createQuote({
      modelId: "grok-imagine-image",
      modality: "image",
      parameters: { prompt: "城市夜景" },
      inputs: { images: 0, styleImages: 0, elementImages: 0, videos: 0, audios: 0 },
      quantity: 2,
    })).rejects.toMatchObject({ code: "OUTPUT_COUNT_UNSUPPORTED" });
  });
});

describe("non-MJ route normalization safety", () => {
  it("rejects a model without a fixed private route", async () => {
    const payload = buildNonMjSourceCatalog() as { models: Array<Record<string, unknown>> };
    const broken = {
      ...payload,
      models: payload.models.map((model) => model.id === "nano-banana"
        ? { ...model, parameters: (model.parameters as Array<Record<string, unknown>>).filter((parameter) => parameter.name !== "model") }
        : model),
    };
    const adapter = createAdapter(broken);
    const catalog = await adapter.getCatalog({ forceRefresh: true, awaitRefresh: true });
    expect(catalog.models.some((model) => model.id === "nano-banana")).toBe(false);
  });
});

describe("non-MJ quote pricing math", () => {
  it("multiplies per-image models by output count and per-second videos by duration", async () => {
    const adapter = createAdapter(buildNonMjSourceCatalog());
    const quotes = new GenerationQuoteService(adapter, { now: () => NOW });
    const image = await quotes.createQuote({
      modelId: "gpt-image-2",
      modality: "image",
      parameters: { prompt: "test", n: 2 },
      inputs: { images: 0, styleImages: 0, elementImages: 0, videos: 0, audios: 0 },
      quantity: 1,
    });
    expect(image.outputCount).toBe(2);
    expect(image.creditMicros).toBe(4_000_000);
    expect(image.yuanMicros).toBe(40_000);

    const video = await quotes.createQuote({
      modelId: "sd2.0-480p",
      modality: "video",
      parameters: { prompt: "test", seconds: 10 },
      inputs: { images: 0, styleImages: 0, elementImages: 0, videos: 0, audios: 0 },
      quantity: 1,
    });
    expect(video.outputCount).toBe(1);
    expect(video.creditMicros).toBe(3_800_000);
    expect(video.yuanMicros).toBe(38_000);
  });
});

export function resolvePrivateRoute(route: PrivateModelRoute) {
  return route;
}
