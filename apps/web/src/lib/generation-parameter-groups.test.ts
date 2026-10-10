import type { ModelModality, ModelParameter, PublicModel } from "@kachang/contracts";
import { describe, expect, it } from "vitest";

import {
  composeModelParameters,
  defaultModelParameters,
  reconcileModelParameters,
  setExclusiveParameter,
} from "./generation-config";
import { partitionGenerationParameters } from "./generation-parameter-groups";

describe("generation parameter groups", () => {
  it("keeps up to four common image parameters directly available", () => {
    const model = createModel("image", [
      parameter("prompt", "string", { required: true }),
      parameter("model", "string", { fixed: "private-image-model" }),
      parameter("quality"),
      parameter("seed", "integer"),
      parameter("resolution", "string", { fixed: "4k" }),
      parameter("aspect_ratio"),
      parameter("mask", "array"),
    ]);

    const groups = partitionGenerationParameters(model);

    expect(names(groups.quickParameters)).toEqual(["aspect_ratio", "resolution", "quality"]);
    expect(names(groups.moreParameters)).toEqual(["seed", "mask"]);
    expect(names(model.parameters)).toEqual(["prompt", "model", "quality", "seed", "resolution", "aspect_ratio", "mask"]);
  });

  it.each([
    {
      modality: "video" as const,
      parameters: ["resolution", "duration_seconds", "seconds", "duration", "aspect_ratio"],
      quick: ["duration_seconds", "aspect_ratio", "resolution"],
      more: [],
    },
    {
      modality: "text" as const,
      parameters: ["max_output_tokens", "max_tokens", "temperature"],
      quick: ["temperature", "max_tokens", "max_output_tokens"],
      more: [],
    },
    {
      modality: "audio" as const,
      parameters: ["format", "duration", "voice"],
      quick: ["voice", "duration", "format"],
      more: [],
    },
  ])("applies $modality parameter priority", ({ modality, parameters, quick, more }) => {
    const model = createModel(modality, parameters.map((name) => parameter(name)));

    const groups = partitionGenerationParameters(model);

    expect(names(groups.quickParameters)).toEqual(quick);
    expect(names(groups.moreParameters)).toEqual(more);
  });

  it("surfaces the Midjourney HD resolution switch in the compact bar", () => {
    const model = createModel("image", [
      parameter("prompt", "string", { required: true }),
      parameter("aspect_ratio", "string", { options: ["1:1", "16:9"] }),
      parameter("quality", "string", { options: ["0.25", "1", "2"] }),
      parameter("raw", "boolean"),
      parameter("hd", "boolean"),
      parameter("n", "integer", { fixed: 1 }),
    ]);

    const groups = partitionGenerationParameters(model);

    expect(names(groups.quickParameters)).toEqual(["aspect_ratio", "quality", "hd"]);
    expect(names(groups.moreParameters)).toEqual(["raw"]);
  });

  it("always keeps unrecognized parameters in more settings", () => {
    const model = createModel("image", [parameter("seed", "integer"), parameter("enhance", "boolean")]);

    expect(partitionGenerationParameters(model)).toEqual({
      quickParameters: [],
      moreParameters: model.parameters,
    });
  });

  it("renders only the documented image2-A fields from a stale alias-rich catalog", () => {
    const model = createModel("image", [
      parameter("resolution", "string", { default: "1k", options: ["1k", "2k", "4k"] }),
      parameter("size", "string", { label: "像素尺寸或兼容比例", options: ["1k", "2k", "4k"] }),
      parameter("aspect_ratio", "string", { default: "auto", options: ["auto", "16:9"] }),
      parameter("aspectRatio", "string", { label: "画面比例（兼容别名）", options: ["auto", "16:9"] }),
      parameter("ratio", "string", { label: "画面比例（兼容别名）", options: ["auto", "16:9"] }),
      parameter("quality", "string", { default: "standard", options: ["low", "standard", "high"] }),
    ]);

    const groups = partitionGenerationParameters(model);

    expect(names(groups.quickParameters)).toEqual(["aspect_ratio", "resolution", "quality"]);
    expect(groups.moreParameters).toEqual([]);
  });

  it("collapses aspect ratio synonyms to one quick control", () => {
    const model = createModel("video", [
      parameter("duration", "integer"),
      parameter("seconds", "integer"),
      parameter("resolution", "string"),
      parameter("size", "string"),
      parameter("ratio", "string"),
      parameter("aspect_ratio", "string"),
    ]);

    const groups = partitionGenerationParameters(model);

    expect(names(groups.quickParameters)).toEqual(["seconds", "aspect_ratio", "resolution"]);
    expect(names(groups.moreParameters)).toEqual([]);
  });

  it("keeps a size-only aspect control in quick parameters", () => {
    const model = createModel("video", [
      parameter("duration", "integer"),
      parameter("seconds", "integer"),
      parameter("resolution", "string"),
      parameter("size", "string"),
      parameter("seed", "integer"),
    ]);

    const groups = partitionGenerationParameters(model);

    expect(names(groups.quickParameters)).toEqual(["seconds", "resolution"]);
    expect(names(groups.moreParameters)).toEqual(["seed"]);
  });

  it("always keeps structured parameters in more settings even when their names are prioritized", () => {
    const model = createModel("audio", [
      parameter("voice", "array"),
      parameter("duration", "object"),
      parameter("format"),
    ]);

    const groups = partitionGenerationParameters(model);

    expect(names(groups.quickParameters)).toEqual(["format"]);
    expect(names(groups.moreParameters)).toEqual(["voice", "duration"]);
  });

  it("excludes model-bound prompts and internal route parameters", () => {
    const model = createModel("image", [
      parameter("instruction", "string", { required: true }),
      parameter("aspect_ratio"),
      parameter("provider", "string", { fixed: "internal" }),
    ]);

    const groups = partitionGenerationParameters(model);

    expect(names(groups.quickParameters)).toEqual(["aspect_ratio"]);
    expect(groups.moreParameters).toEqual([]);
  });

  it("excludes media reference payloads that are supplied through uploaded inputs", () => {
    const model = createModel("image", [
      parameter("prompt", "string", { required: true }),
      parameter("referenceImages", "array"),
      parameter("reference_video"),
      parameter("ref_image_urls", "array"),
      parameter("images", "array"),
      parameter("first_image"),
      parameter("messages", "array"),
      parameter("aspect_ratio"),
      parameter("image_quality"),
      parameter("audio"),
    ]);
    model.input.images = { min: 0, max: 4, multiple: true };

    const groups = partitionGenerationParameters(model);

    expect(names(groups.quickParameters)).toEqual(["aspect_ratio"]);
    expect(names(groups.moreParameters)).toEqual(["image_quality", "audio"]);
  });

  it("shows one duration and aspect control while preserving SD 2.0 compatibility fields", () => {
    const model = compatibilityVideoModel();
    const groups = partitionGenerationParameters(model);

    expect(names(groups.quickParameters)).toEqual(["seconds", "aspect_ratio", "resolution"]);
    expect(groups.moreParameters).toEqual([]);

    let configured = defaultModelParameters(model);
    expect(configured).toEqual({ seconds: 4, aspect_ratio: "16:9", resolution: "720p" });

    configured = setExclusiveParameter(model, configured, "seconds", 15);
    configured = setExclusiveParameter(model, configured, "aspect_ratio", "9:16");
    expect(configured).toEqual({ seconds: 15, aspect_ratio: "9:16", resolution: "720p" });

    expect(composeModelParameters(model, "让人物自然转身", configured)).toEqual({
      model: model.id,
      prompt: "让人物自然转身",
      seconds: 15,
      resolution: "720p",
      aspect_ratio: "9:16",
      n: 1,
      async: true,
    });

    expect(reconcileModelParameters(model, { duration: 15, ratio: "9:16" })).toEqual({
      seconds: 15,
      aspect_ratio: "9:16",
      resolution: "720p",
    });
  });

  it("keeps the nine-image video.v1 controls outside more settings", () => {
    const model = createModel("video", [
      parameter("model", "string", { fixed: "S-2.0-9图版" }),
      parameter("prompt", "string", { required: true }),
      parameter("duration_seconds", "integer", {
        required: true,
        default: 4,
        min: 4,
        max: 15,
        options: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      }),
      parameter("aspect_ratio", "string", {
        required: true,
        default: "16:9",
        options: ["16:9", "9:16"],
      }),
      parameter("resolution", "string", { fixed: "720p", options: ["720p"] }),
      parameter("images", "array"),
      parameter("n", "integer", { fixed: 1 }),
    ]);
    model.id = "S-2.0-9图版";
    model.input.images = { min: 0, max: 9, multiple: true };

    const groups = partitionGenerationParameters(model);
    expect(names(groups.quickParameters)).toEqual(["duration_seconds", "aspect_ratio", "resolution"]);
    expect(groups.moreParameters).toEqual([]);
    expect(defaultModelParameters(model)).toEqual({ duration_seconds: 4, aspect_ratio: "16:9" });
    expect(composeModelParameters(model, "人物自然转身", {
      duration_seconds: 15,
      aspect_ratio: "9:16",
    })).toEqual({
      model: "S-2.0-9图版",
      prompt: "人物自然转身",
      duration_seconds: 15,
      aspect_ratio: "9:16",
      resolution: "720p",
      n: 1,
    });
  });
});

function compatibilityVideoModel(): PublicModel {
  const id = "sd2.0 pro 满血九图卡脸版";
  return {
    id,
    label: id,
    description: "",
    modality: "video",
    operation: "generate",
    order: 55,
    input: { textRequired: true, images: { min: 0, max: 9, multiple: true } },
    output: { type: "video", minCount: 1, maxCount: 1 },
    parameters: [
      parameter("model", "string", { label: "模型", required: true, fixed: id }),
      parameter("prompt", "string", { label: "提示词", required: true }),
      parameter("seconds", "integer", { label: "时长（秒）", required: true, min: 4, max: 15 }),
      parameter("size", "string", { label: "画面尺寸", required: true, options: ["1280x720", "720x1280"] }),
      parameter("aspect_ratio", "string", { label: "画面比例", required: true, options: ["16:9", "9:16"] }),
      parameter("duration", "integer", { label: "时长兼容字段（秒）", min: 4, max: 15 }),
      parameter("resolution", "string", { label: "画面尺寸兼容字段", default: "720p", options: ["720p"] }),
      parameter("ratio", "string", { label: "画面比例兼容字段", default: "16:9", options: ["16:9", "9:16"] }),
      parameter("n", "integer", { label: "生成数量", fixed: 1 }),
      parameter("async", "boolean", { label: "异步任务", fixed: true }),
    ],
    pricing: {
      mode: "fixed",
      unit: "request",
      currency: "CNY",
      creditsPerYuan: 100,
      baseCreditMicros: 250_000_000,
      tiers: [],
    },
  };
}

function createModel(modality: ModelModality, parameters: ModelParameter[]): PublicModel {
  return {
    id: `${modality}-model`,
    label: `${modality} model`,
    description: "",
    modality,
    operation: "generate",
    order: 0,
    input: { textRequired: true },
    output: { type: modality, minCount: 1, maxCount: 1 },
    parameters,
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

function parameter(
  name: string,
  type: ModelParameter["type"] = "string",
  overrides: Partial<ModelParameter> = {},
): ModelParameter {
  return {
    name,
    label: name,
    type,
    required: false,
    mutuallyExclusiveWith: [],
    ...overrides,
  };
}

function names(parameters: ModelParameter[]) {
  return parameters.map((parameter) => parameter.name);
}
