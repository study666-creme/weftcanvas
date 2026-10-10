import type { ModelModality, PublicModel } from "@kachang/contracts";
import { describe, expect, it } from "vitest";

import { modelGroupLabel, modelPickerLabel, modelPriceLabel, orderModelsForPicker, pickDefaultModel, pricingUnitText } from "./generation-model-select";

describe("generation model select", () => {
  it("shows the public billing unit in model prices", () => {
    expect(modelPriceLabel(model("image", "image-price", "Image", 0))).toBe("1 积分/张");
    expect(modelPriceLabel(model("video", "video-price", "Video", 0))).toBe("1 积分/秒");
    expect(modelPriceLabel({ ...model("text", "text-price", "Text", 0), pricing: { ...model("text", "text-price", "Text", 0).pricing, unit: "request", mode: "fixed" } })).toBe("1 积分/条");
    expect(pricingUnitText("image")).toBe("按张计费");
    expect(pricingUnitText("second")).toBe("按秒计费");
    expect(pricingUnitText("request")).toBe("按条计费");
    expect(pricingUnitText("token")).toBe("按 Token 计费");
  });
  it("groups video models by route line instead of model family", () => {
    expect(modelGroupLabel(model("video", "sd2.0-720p-pro", "SD 2.0 Pro", 0, 2))).toBe("线路二");
    expect(modelGroupLabel(model("video", "grok-imagine-video-1.5", "Grok 1.5", 0, 2))).toBe("线路二");
    expect(modelGroupLabel(model("video", "veo-3", "Veo 3", 0, 1))).toBe("线路一");
  });

  it("formats route line labels through 99", () => {
    expect([1, 2, 10, 11, 20, 99].map((routeLine) => (
      modelGroupLabel(model("video", `line-${routeLine}`, "Video", 0, routeLine))
    ))).toEqual(["线路一", "线路二", "线路十", "线路十一", "线路二十", "线路九十九"]);
  });

  it("orders video models by route line, model order, then label", () => {
    const sorted = orderModelsForPicker([
      model("video", "kling-line-two", "Kling", 0, 2),
      model("video", "sd-line-one-later", "SD", 2, 1),
      model("video", "veo-line-one-b", "B", 1, 1),
      model("video", "grok-line-one-a", "A", 1, 1),
      model("video", "other-line-ten", "Other", 0, 10),
    ]);

    expect(sorted.map((item) => item.id)).toEqual([
      "grok-line-one-a",
      "veo-line-one-b",
      "sd-line-one-later",
      "kling-line-two",
      "other-line-ten",
    ]);
  });

  it("keeps video models without a trusted route line in an explicit sync group", () => {
    const missingGrok = model("video", "grok-missing-line", "Grok", 2);
    const missingVeo = model("video", "veo-missing-line", "Veo", 1);
    const explicitLineOne = model("video", "sd-explicit-line-one", "SD", 3, 1);
    const lineTwo = model("video", "kling-line-two", "Kling", 0, 2);

    expect([missingGrok, missingVeo].map(modelGroupLabel)).toEqual(["线路待同步", "线路待同步"]);
    expect(orderModelsForPicker([lineTwo, explicitLineOne, missingGrok, missingVeo]).map((item) => item.id)).toEqual([
      "sd-explicit-line-one",
      "kling-line-two",
      "veo-missing-line",
      "grok-missing-line",
    ]);
  });

  it("groups and orders image models as universal, banana, then other", () => {
    const sorted = orderModelsForPicker([
      model("image", "other-image", "其他图片", 1),
      model("image", "nano-banana-pro", "香蕉 · 专业 1K/2K/4K", 43),
      model("image", "gpt-image-2-free", "全能模型2 · 免费 1K", 22),
      model("image", "nano-banana", "香蕉 · 标准 1K", 40),
      model("image", "gpt-image-2-1k", "全能模型2 · 特价 1K", 20),
    ]);

    expect(sorted.map((item) => item.id)).toEqual([
      "gpt-image-2-1k",
      "gpt-image-2-free",
      "nano-banana",
      "nano-banana-pro",
      "other-image",
    ]);
    expect(sorted.map(modelGroupLabel)).toEqual([
      "全能模型2",
      "全能模型2",
      "香蕉",
      "香蕉",
      "其他图片模型",
    ]);
  });

  it("groups every current image catalog model into its requested family", () => {
    for (const id of ["gpt-image-2-1k", "gpt-image-2", "gpt-image-2-ext", "gpt-image-2-free", "gpt-image-2-4k-Adobe"]) {
      expect(modelGroupLabel(model("image", id, id))).toBe("全能模型2");
    }
    for (const id of ["nano-banana", "nano-banana-fast", "nano-banana-2-lite", "nano-banana-pro", "nano-banana-2"]) {
      expect(modelGroupLabel(model("image", id, id))).toBe("香蕉");
    }
  });

  it("uses the original English variant names for banana models", () => {
    expect(modelPickerLabel(model("image", "nano-banana", "香蕉 · 标准 1K"))).toBe("香蕉 · Standard 1K");
    expect(modelPickerLabel(model("image", "nano-banana-fast", "香蕉 · 极速 1K"))).toBe("香蕉 · Fast 1K");
    expect(modelPickerLabel(model("image", "nano-banana-2-lite", "香蕉 · Lite 1K"))).toBe("香蕉 · Lite 1K");
    expect(modelPickerLabel(model("image", "nano-banana-pro", "香蕉 · 专业 1K/2K/4K"))).toBe("香蕉 · Pro 1K/2K/4K");
    expect(modelPickerLabel(model("image", "nano-banana-2", "香蕉 · 2代 1K/2K/4K"))).toBe("香蕉 · 2 1K/2K/4K");
  });

  it("keeps non-image and non-video lists in their existing order", () => {
    const first = model("text", "b", "B");
    const second = model("text", "a", "A");

    expect(orderModelsForPicker([first, second])).toEqual([first, second]);
  });

  it("groups every custom image model into one dedicated bottom group regardless of family labels", () => {
    const customBanana = model("image", customKey("image", "nano-banana-custom"), "香蕉 · 专业 1K");
    const customUniversal = model("image", customKey("image", "gpt-image-2-custom"), "全能模型2 · 特价");
    const customGeneric = model("image", customKey("image", "ordinary-model"), "创作图片");

    expect([customBanana, customUniversal, customGeneric].map(modelGroupLabel)).toEqual(["自有 API", "自有 API", "自有 API"]);
    expect(modelPickerLabel(customBanana)).toBe("香蕉 · 专业 1K");
  });

  it("orders custom image models after every built-in image family", () => {
    const sorted = orderModelsForPicker([
      model("image", "custom-other", "其他图片", 1),
      model("image", "nano-banana", "香蕉", 40),
      model("image", "gpt-image-2", "全能模型2", 20),
      customImageModel("custom:profile:image:banana-like", "香蕉 · 专业 1K", 5),
      customImageModel("custom:profile:image:universal-like", "全能模型2 · 特价", 2),
      customImageModel("custom:profile:image:plain", "创作图片", 1),
    ]);

    expect(sorted.map((item) => item.id)).toEqual([
      "gpt-image-2",
      "nano-banana",
      "custom-other",
      "custom:profile:image:plain",
      "custom:profile:image:universal-like",
      "custom:profile:image:banana-like",
    ]);
    expect(sorted.map(modelGroupLabel)).toEqual([
      "全能模型2",
      "香蕉",
      "其他图片模型",
      "自有 API",
      "自有 API",
      "自有 API",
    ]);
  });

  it("groups custom video models into the dedicated group instead of a route line", () => {
    const customVideo = model("video", customKey("video", "grok-imagine-video-1.5"), "Grok 1.5", 0, 2);
    const customRouteLike = model("video", customKey("video", "sd2.0-720p-pro"), "SD 2.0 Pro", 0, 2);

    expect([customVideo, customRouteLike].map(modelGroupLabel)).toEqual(["自有 API", "自有 API"]);
  });

  it("orders custom video models after every built-in route line and the pending-sync group", () => {
    const sorted = orderModelsForPicker([
      model("video", "custom-route-two", "Kling", 0, 2),
      model("video", "custom-missing-line", "Veo", 1),
      customVideoModel("custom:profile:video:grok-imagine-video-1.5", "Grok 1.5", 2),
      customVideoModel("custom:profile:video:sd2.0-720p-pro", "SD 2.0 Pro", 1),
    ]);

    expect(sorted.map((item) => item.id)).toEqual([
      "custom-route-two",
      "custom-missing-line",
      "custom:profile:video:sd2.0-720p-pro",
      "custom:profile:video:grok-imagine-video-1.5",
    ]);
    expect(sorted.map(modelGroupLabel)).toEqual(["线路二", "线路待同步", "自有 API", "自有 API"]);
  });

  it("groups custom text and audio models into the dedicated group", () => {
    expect(modelGroupLabel(model("text", customKey("text", "glm"), "GLM"))).toBe("自有 API");
    expect(modelGroupLabel(model("audio", customKey("audio", "tts"), "TTS"))).toBe("自有 API");
  });

  it("defaults to a stable-zone model and keeps promo models last in the picker", () => {
    const stableLineOne = model("video", "sd2.0-720p-pro", "SD 2.0 Pro", 0, 1);
    const promoLineOne = { ...model("video", "promo-veo", "特惠 Veo", 0, 1), zone: "promo" as const };
    const lineTwo = model("video", "kling-line-two", "Kling", 0, 2);

    expect(pickDefaultModel([promoLineOne, stableLineOne])).toBe(stableLineOne);
    expect(pickDefaultModel([promoLineOne])).toBe(promoLineOne);
    expect(pickDefaultModel([])).toBeNull();
    expect(modelGroupLabel(promoLineOne)).toBe("特惠模型");

    expect(orderModelsForPicker([promoLineOne, lineTwo, stableLineOne]).map((item) => item.id)).toEqual([
      "sd2.0-720p-pro",
      "kling-line-two",
      "promo-veo",
    ]);
  });
});

function model(modality: ModelModality, id: string, label: string, order = 0, routeLine?: number): PublicModel {
  return {
    id,
    label,
    description: "",
    modality,
    operation: "generate",
    order,
    ...(routeLine === undefined ? {} : { routeLine }),
    input: { textRequired: true },
    output: { type: modality, minCount: 1, maxCount: 1 },
    parameters: [],
    pricing: {
      mode: "fixed",
      unit: modality === "video" || modality === "audio" ? "second" : modality === "text" ? "token" : "image",
      currency: "CNY",
      creditsPerYuan: 100,
      baseCreditMicros: 1_000_000,
      tiers: [],
    },
  };
}

function customKey(modality: ModelModality, modelId: string) {
  return `custom:${encodeURIComponent("图片 API")}:${modality}:${encodeURIComponent(modelId)}`;
}

function customImageModel(id: string, label: string, order: number): PublicModel {
  return model("image", id, label, order);
}

function customVideoModel(id: string, label: string, order: number): PublicModel {
  return model("video", id, label, order);
}
