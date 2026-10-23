import type { PublicModel } from "@weftcanvas/contracts";
import { describe, expect, it } from "vitest";

import { modelVendorLabel, publicModelPickerModels, textModelPriceLabel } from "./model-picker";

function model(overrides: Partial<PublicModel> & { id: string; label: string }): PublicModel {
  return {
    description: "",
    modality: "text",
    operation: "text.generate",
    order: 0,
    input: { textRequired: true },
    output: { type: "text", minCount: 1, maxCount: 1 },
    parameters: [],
    pricing: {
      mode: "fixed",
      unit: "request",
      currency: "CNY",
      creditsPerYuan: 100,
      baseCreditMicros: 1_000_000,
      tiers: [],
    },
    ...overrides,
  } as PublicModel;
}

describe("modelVendorLabel", () => {
  it("maps the same vendors as the agent catalog", () => {
    expect(modelVendorLabel("gemini-3.1-pro")).toBe("Gemini");
    expect(modelVendorLabel("glm-5.1")).toBe("GLM");
    expect(modelVendorLabel("gpt-6-astra")).toBe("OpenAI");
    expect(modelVendorLabel("deepseek-v4")).toBe("DeepSeek");
    expect(modelVendorLabel("mystery-model")).toBe("其他");
  });
});

describe("textModelPriceLabel", () => {
  it("shows the per-request credit price instead of leaving the row blank", () => {
    expect(textModelPriceLabel(model({ id: "glm-5.1", label: "Glm 5.1" }))).toBe("1 积分/次");
  });

  it("shows input/output rates per million tokens", () => {
    const priced = model({
      id: "gemini-3.1-flash",
      label: "Gemini 3.1 Flash",
      pricing: {
        mode: "token",
        unit: "token",
        currency: "CNY",
        creditsPerYuan: 100,
        inputCreditMicrosPerMillion: 2_000_000,
        outputCreditMicrosPerMillion: 8_000_000,
        tiers: [],
      },
    });
    expect(textModelPriceLabel(priced)).toBe("2/8 积分 · 每M");
  });

  it("falls back to a readable label when the catalog has no token rates", () => {
    const bare = model({
      id: "gemini-4-argon",
      label: "Gemini 4 Argon",
      pricing: {
        mode: "token",
        unit: "token",
        currency: "CNY",
        creditsPerYuan: 100,
        tiers: [],
      },
    });
    expect(textModelPriceLabel(bare)).toBe("按 Token 计费");
  });

  it("marks user-owned API models", () => {
    expect(
      textModelPriceLabel(model({ id: "custom:profile1:text:my-model", label: "自有模型" })),
    ).toBe("自有 API");
  });
});

describe("publicModelPickerModels", () => {
  it("projects vendor group and billing for the shared picker", () => {
    const picker = publicModelPickerModels([
      model({ id: "gemini-3.1-flash", label: "Gemini 3.1 Flash" }),
      model({
        id: "glm-5.1",
        label: "Glm 5.1",
        pricing: {
          mode: "token",
          unit: "token",
          currency: "CNY",
          creditsPerYuan: 100,
          inputCreditMicrosPerMillion: 1_000_000,
          outputCreditMicrosPerMillion: 4_000_000,
          tiers: [],
        },
      }),
    ]);
    expect(picker).toEqual([
      expect.objectContaining({
        id: "gemini-3.1-flash",
        group: "Gemini",
        billing: "request",
        meta: "1 积分/次",
      }),
      expect.objectContaining({
        id: "glm-5.1",
        group: "GLM",
        billing: "token",
        meta: "1/4 积分 · 每M",
      }),
    ]);
  });
});
