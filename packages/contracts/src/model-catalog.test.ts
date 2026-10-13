import { describe, expect, it } from "vitest";

import {
  generationQuoteRequestSchema,
  generationQuoteSchema,
  publicModelCatalogSchema,
  publicModelSchema,
} from "./model-catalog";

const catalog = {
  version: "catalog-1",
  capabilityVersion: "capability-1",
  pricingVersion: "pricing-1",
  fetchedAt: "2026-07-15T08:00:00.000Z",
  expiresAt: "2026-07-15T08:10:00.000Z",
  quoteAvailable: true,
  models: [
    {
      id: "image-model",
      label: "图像模型",
      modality: "image",
      operation: "generate",
      input: { textRequired: true, images: { min: 0, max: 4, multiple: true } },
      output: { type: "image" },
      parameters: [
        {
          name: "size",
          label: "画面比例",
          type: "string",
          options: ["1:1", "16:9"],
          default: "1:1",
        },
      ],
      pricing: {
        mode: "fixed",
        unit: "image",
        currency: "CNY",
        creditsPerYuan: 100,
        baseCreditMicros: 5_500_000,
        baseYuanMicros: 55_000,
      },
    },
  ],
};

describe("model catalog contracts", () => {
  it("fills stable public defaults without provider fields", () => {
    const parsed = publicModelCatalogSchema.parse(catalog);
    expect(parsed.models[0]).toMatchObject({
      id: "image-model",
      description: "",
      order: 0,
      output: { minCount: 1, maxCount: 1 },
    });
    expect(parsed.models[0]?.parameters[0]?.mutuallyExclusiveWith).toEqual([]);
    expect(parsed.models[0]).not.toHaveProperty("endpoint");
  });

  it("carries optional aggregated health and bounds its rate", () => {
    const base = catalog.models[0]!;
    expect(publicModelSchema.parse(base)).not.toHaveProperty("health");
    expect(
      publicModelSchema.parse({
        ...base,
        health: { successRate: 0.92, sampleCount: 50, windowHours: 168 },
      }).health,
    ).toEqual({ successRate: 0.92, sampleCount: 50, windowHours: 168 });
    expect(() =>
      publicModelSchema.parse({
        ...base,
        health: { successRate: 1.5, sampleCount: 50, windowHours: 168 },
      }),
    ).toThrow();
  });

  it("bounds quote quantities and preserves integer micro amounts", () => {
    expect(
      generationQuoteRequestSchema.parse({ modelId: "image-model", modality: "image" }).quantity,
    ).toBe(1);
    expect(() =>
      generationQuoteRequestSchema.parse({
        modelId: "image-model",
        modality: "image",
        quantity: 9,
      }),
    ).toThrow();
    expect(
      generationQuoteSchema.parse({
        id: "quote-1",
        modelId: "image-model",
        modelLabel: "图像模型",
        modality: "image",
        quantity: 1,
        normalizedParameters: { size: "1:1" },
        creditMicros: 100_000,
        credits: "0.1",
        yuanMicros: 1_000,
        yuan: "0.001",
        estimated: false,
        pricingUnit: "request",
        catalogVersion: "catalog-1",
        capabilityVersion: "capability-1",
        pricingVersion: "pricing-1",
        expiresAt: "2026-07-15T08:05:00.000Z",
      }).creditMicros,
    ).toBe(100_000);
  });

  it("preserves the public video protocol and semantic media roles", () => {
    const parsed = publicModelCatalogSchema.parse({
      ...catalog,
      models: [
        {
          ...catalog.models[0],
          id: "video-model",
          label: "视频模型",
          modality: "video",
          operation: "generate",
          protocol: {
            version: "video.v1",
            endpoint: { method: "POST", path: "/v1/videos" },
            mediaRoles: ["reference", "source_video", "style_reference"],
          },
          output: { type: "video" },
          pricing: { ...catalog.models[0]!.pricing, unit: "request" },
        },
      ],
    });

    expect(parsed.models[0]?.protocol).toEqual({
      version: "video.v1",
      endpoint: { method: "POST", path: "/v1/videos" },
      mediaRoles: ["reference", "source_video", "style_reference"],
    });
  });
});
