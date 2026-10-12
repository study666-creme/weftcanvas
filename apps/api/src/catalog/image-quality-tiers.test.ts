import { describe, expect, it } from "vitest";

import { WeftcanvasCatalogAdapter } from "./adapter.js";
import { GenerationQuoteService } from "./quote.js";
import { MemoryCatalogSnapshotStore } from "./store.js";

const NOW = Date.parse("2026-08-10T08:00:00.000Z");

/**
 * The gpt-image-2.5 family genuinely supports low/medium/high/xhigh/max, and the
 * upstream catalog publishes exactly those tiers. Normalization and quoting must
 * pass them through untouched: an earlier attempt rewrote the set to
 * low/medium/standard/high/ultra, which would have removed the real top tiers.
 */
function imageModel(id: string, label: string, order: number, quality: string[]) {
  return {
    id,
    modality: "image",
    operation: "generate",
    order,
    input: { text: { required: true }, images: { min: 0, max: 14, multiple: true } },
    output: { type: "image", count: { fixed: 1 } },
    parameters: [
      { name: "model", path: "model", type: "string", required: true, fixed: id, label: "模型" },
      {
        name: "prompt",
        path: "prompt",
        type: "string",
        required: true,
        min_length: 1,
        label: "提示词",
      },
      {
        name: "resolution",
        path: "resolution",
        type: "string",
        default: "1k",
        options: ["1k", "2k", "4k"],
        label: "分辨率",
      },
      { name: "quality", path: "quality", type: "string", label: "质量", options: quality },
      { name: "n", path: "n", type: "integer", fixed: 1, label: "生成张数" },
    ],
    endpoint: { method: "POST", path: "/v1/images/generations", content_type: "application/json" },
    public: { id, label, description: "" },
    selectable: true,
    pricing: {
      mode: "fixed",
      unit: "image",
      currency: "CNY",
      credits_per_yuan: 100,
      credits: 12,
      yuan: 0.12,
    },
  };
}

function buildPayload() {
  return {
    success: true,
    version: "catalog-quality",
    capability_version: "capability-quality",
    pricing_version: "",
    fetched_at: new Date(NOW).toISOString(),
    credits_per_yuan: 100,
    models: [
      imageModel("gpt-image-2.5-sunburst", "GPT-Image-2.5-sunburst", 30, [
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]),
      imageModel("gpt-image-2.5-1.5k", "GPT-Image-2.5-flare-1.5k", 31, ["low", "medium", "high"]),
    ],
  };
}

function createAdapter() {
  return new WeftcanvasCatalogAdapter({
    sourceUrl: "https://catalog.test/models",
    store: new MemoryCatalogSnapshotStore(),
    now: () => NOW,
    includeKnownModels: true,
    fetch: async () =>
      new Response(JSON.stringify(buildPayload()), {
        status: 200,
        headers: { "Content-Type": "application/json", ETag: '"quality-1"' },
      }),
  });
}

describe("image2.5 quality tiers", () => {
  it("publishes the upstream low/medium/high/xhigh/max tiers unchanged", async () => {
    const catalog = await createAdapter().getCatalog({ forceRefresh: true, awaitRefresh: true });

    const sunburst = catalog.models.find((model) => model.id === "gpt-image-2.5-sunburst");
    expect(sunburst?.parameters.find((parameter) => parameter.name === "quality")?.options).toEqual(
      ["low", "medium", "high", "xhigh", "max"],
    );
  });

  it("quotes the top max tier instead of rejecting it", async () => {
    const quotes = new GenerationQuoteService(createAdapter());

    await expect(
      quotes.createQuote({
        modelId: "gpt-image-2.5-sunburst",
        modality: "image",
        parameters: { prompt: "a red apple", quality: "max" },
        inputs: { images: 0 },
        quantity: 1,
      }),
    ).resolves.toMatchObject({ normalizedParameters: { quality: "max" } });
  });
});
