import type { ModelParameter, PublicModel } from "@weftcanvas/contracts";
import { describe, expect, it } from "vitest";

import {
  autoPickGenerationSettings,
  canRecoverUnavailableModelSelection,
  canonicalPlatformModelId,
  composeModelParameters,
  defaultModelParameters,
  estimateInputTokens,
  generationRequestQuantity,
  isModelMediaReferenceParameter,
  isRequestPricedFixedMultiOutputImageModel,
  isUserFacingParameter,
  quoteTokenFields,
  reconcileModelParameters,
  requestPricedFixedOutputCount,
  setExclusiveParameter,
  supportsClientBatchGeneration,
} from "./generation-config";

describe("generation config", () => {
  it.each(["gpt-image-2-4k-Adobe", "gpt-image-2-4k-fast"])(
    "migrates legacy Adobe model id %s to the stable catalog id",
    (modelId) => {
      expect(canonicalPlatformModelId(modelId)).toBe("image2-4k-fast");
    },
  );

  it("keeps resolution hidden on simplified surfaces but selectable in the studio", () => {
    const parameter = (
      name: string,
      label: string,
      extra: Partial<ModelParameter> = {},
    ): ModelParameter => ({
      name,
      label,
      type: "string",
      required: false,
      mutuallyExclusiveWith: [],
      ...extra,
    });
    const resolution = parameter("resolution", "分辨率", { options: ["1k", "2k", "4k"] });
    const width = parameter("width", "宽度", { type: "integer" });
    const responseFormat = parameter("response_format", "响应格式");

    // 节点画布与首屏是简化入口，只保留创作控件。
    expect(isUserFacingParameter(resolution)).toBe(false);
    expect(isUserFacingParameter(width)).toBe(false);

    // 工作台要能精确控制出图规格。
    expect(isUserFacingParameter(resolution, { exposeDimensions: true })).toBe(true);
    expect(isUserFacingParameter(width, { exposeDimensions: true })).toBe(true);

    // 传输格式任何界面都不能暴露：结果解析依赖固定格式。
    expect(isUserFacingParameter(responseFormat)).toBe(false);
    expect(isUserFacingParameter(responseFormat, { exposeDimensions: true })).toBe(false);

    // 参考视频时长是配套声明（客户端按素材实测提交），不是创作参数：让用户手填
    // 等于把上游按秒计费的口径交给用户，两个入口都必须隐藏。
    const referenceVideoDurations = parameter("referenceVideoDurations", "参考视频时长（秒）", {
      type: "array",
    });
    expect(isUserFacingParameter(referenceVideoDurations)).toBe(false);
    expect(isUserFacingParameter(referenceVideoDurations, { exposeDimensions: true })).toBe(false);
  });

  it("recovers a removed built-in model only after a successful live catalog load", () => {
    const ready = {
      modelId: "retired-model",
      modelAvailable: false,
      customModelKey: false,
      catalogLoadSettled: true,
      catalogReady: true,
      catalogRefreshing: false,
      catalogError: null,
      platformModelCount: 2,
      customCatalogLoading: false,
    };
    expect(canRecoverUnavailableModelSelection(ready)).toBe(true);
    expect(canRecoverUnavailableModelSelection({ ...ready, modelAvailable: true })).toBe(false);
    expect(canRecoverUnavailableModelSelection({ ...ready, customModelKey: true })).toBe(false);
    expect(canRecoverUnavailableModelSelection({ ...ready, catalogLoadSettled: false })).toBe(
      false,
    );
    expect(canRecoverUnavailableModelSelection({ ...ready, catalogRefreshing: true })).toBe(false);
    expect(
      canRecoverUnavailableModelSelection({ ...ready, catalogError: "模型列表暂时无法读取" }),
    ).toBe(false);
    expect(canRecoverUnavailableModelSelection({ ...ready, customCatalogLoading: true })).toBe(
      false,
    );
  });

  it("binds node content while keeping capability defaults", () => {
    const model = imageModel();
    expect(defaultModelParameters(model)).toEqual({ quality: "2k", enhance: false });
    expect(composeModelParameters(model, "雨夜街道", { quality: "4k" })).toEqual({
      prompt: "雨夜街道",
      quality: "4k",
      enhance: false,
    });
  });

  it("builds chat messages and conservative token quote fields", () => {
    const model: PublicModel = {
      ...imageModel(),
      id: "text-1",
      modality: "text",
      output: { type: "text", minCount: 1, maxCount: 1 },
      parameters: [
        {
          name: "messages",
          label: "消息",
          type: "array",
          required: true,
          mutuallyExclusiveWith: [],
        },
      ],
      pricing: { mode: "token", unit: "token", currency: "CNY", creditsPerYuan: 100, tiers: [] },
    };
    const body = "把这个场景改得更紧张";
    expect(composeModelParameters(model, body, {})).toEqual({
      messages: [{ role: "user", content: body }],
    });
    expect(quoteTokenFields(model, body, {}, 2048)).toEqual({
      inputTokens: estimateInputTokens(body),
      maxOutputTokens: 2048,
    });
  });

  it("binds audio prompts to messages (chat) and contents (Gemini native) shapes", () => {
    const suno: PublicModel = {
      ...imageModel(),
      id: "music-suno",
      modality: "audio",
      output: { type: "audio", minCount: 2, maxCount: 2 },
      parameters: [
        {
          name: "messages",
          label: "消息",
          type: "array",
          required: true,
          mutuallyExclusiveWith: [],
        },
      ],
      pricing: { mode: "fixed", unit: "request", currency: "CNY", creditsPerYuan: 100, tiers: [] },
    };
    expect(composeModelParameters(suno, "轻快的钢琴背景音乐", {})).toEqual({
      messages: [{ role: "user", content: "轻快的钢琴背景音乐" }],
    });

    const tts: PublicModel = {
      ...suno,
      id: "voice-tts",
      output: { type: "audio", minCount: 1, maxCount: 1 },
      parameters: [
        {
          name: "contents",
          label: "对话内容",
          type: "array",
          required: true,
          mutuallyExclusiveWith: [],
        },
        {
          name: "speechConfig",
          label: "语音配置",
          type: "object",
          required: true,
          options: ["Kore", "Puck"],
          mutuallyExclusiveWith: [],
        },
      ],
    };
    expect(composeModelParameters(tts, "你好，欢迎收听", {})).toEqual({
      contents: [{ role: "user", parts: [{ text: "你好，欢迎收听" }] }],
      // 带选项的 object 参数按选项值提交（必填兜底第一项），执行侧再包对象形态。
      speechConfig: "Kore",
    });
    expect(composeModelParameters(tts, "你好", { speechConfig: "Puck" })).toMatchObject({
      speechConfig: "Puck",
    });
  });

  it("binds the only required text capability even when its public name differs", () => {
    const model = imageModel();
    model.parameters = [
      {
        name: "instruction",
        label: "描述",
        type: "string",
        required: true,
        mutuallyExclusiveWith: [],
      },
    ];
    expect(defaultModelParameters(model)).toEqual({});
    expect(composeModelParameters(model, "晨雾中的车站", {})).toEqual({
      instruction: "晨雾中的车站",
    });
  });

  it("clears mutually exclusive values when a parameter becomes active", () => {
    const model = imageModel();
    model.parameters.push({
      name: "mask",
      label: "遮罩",
      type: "string",
      required: false,
      mutuallyExclusiveWith: ["enhance"],
    });
    expect(setExclusiveParameter(model, { enhance: true }, "mask", "face")).toEqual({
      mask: "face",
    });
  });

  it("reconciles saved values when a live capability changes", () => {
    const model = imageModel();
    expect(
      reconcileModelParameters(model, { quality: "8k", enhance: true, retired: "value" }),
    ).toEqual({ quality: "2k", enhance: true });
    expect(reconcileModelParameters(model, { quality: "4k", enhance: true })).toEqual({
      quality: "4k",
      enhance: true,
    });
  });

  it("migrates image2-A compatibility aliases into one canonical request", () => {
    const model = imageModel();
    model.parameters = [
      parameter("prompt", "string", { required: true }),
      parameter("resolution", "string", { default: "1k", options: ["1k", "2k", "4k"] }),
      parameter("size", "string", { label: "像素尺寸或兼容比例", options: ["1k", "2k", "4k"] }),
      parameter("aspect_ratio", "string", { default: "auto", options: ["auto", "16:9"] }),
      parameter("aspectRatio", "string", {
        label: "画面比例（兼容别名）",
        options: ["auto", "16:9"],
      }),
      parameter("ratio", "string", { label: "画面比例（兼容别名）", options: ["auto", "16:9"] }),
      parameter("quality", "string", { default: "standard", options: ["low", "standard", "high"] }),
    ];

    expect(defaultModelParameters(model)).toEqual({
      resolution: "1k",
      aspect_ratio: "auto",
      quality: "standard",
    });
    expect(reconcileModelParameters(model, { size: "2k", ratio: "16:9", quality: "high" })).toEqual(
      {
        resolution: "2k",
        aspect_ratio: "16:9",
        quality: "high",
      },
    );
    expect(
      composeModelParameters(model, "电影感产品图", {
        size: "2k",
        aspectRatio: "16:9",
        quality: "high",
      }),
    ).toEqual({
      prompt: "电影感产品图",
      resolution: "2k",
      aspect_ratio: "16:9",
      quality: "high",
    });
  });

  it("accepts legacy lowercase symbolic resolution values and emits catalog casing", () => {
    const model = imageModel();
    model.id = "mj-v81";
    model.parameters = [
      parameter("prompt", "string", { required: true }),
      parameter("resolution", "string", { default: "1K", options: ["1K", "2K"] }),
    ];

    expect(reconcileModelParameters(model, { resolution: "2k" })).toEqual({ resolution: "2K" });
    expect(composeModelParameters(model, "城市夜景", { resolution: "2k" })).toEqual({
      prompt: "城市夜景",
      resolution: "2K",
    });
  });

  it.each([
    "referenceImage",
    "referenceImages",
    "reference_image",
    "reference_images",
    "referenceVideo",
    "reference_videos",
    "referenceAudio",
    "reference_audios",
    "referenceImageUrl",
    "reference_image_urls",
    "refImageUrl",
    "refImageUrls",
    "ref_image_url",
    "ref_image_urls",
    "refVideoUrls",
    "ref_audio_urls",
  ])("recognizes uploaded-media parameter %s without matching unrelated settings", (name) => {
    const model = imageModel();
    const candidate = parameter(name, "array");
    expect(isModelMediaReferenceParameter(model, candidate)).toBe(true);
    expect(isModelMediaReferenceParameter(model, parameter("image_quality"))).toBe(false);
  });

  it.each([
    ["image", "images"],
    ["images", "images"],
    ["image_url", "images"],
    ["imageUrls", "images"],
    ["first_image", "images"],
    ["last_image", "images"],
    ["start_frame_url", "images"],
    ["endFrameImageUrl", "images"],
    ["video", "videos"],
    ["videos", "videos"],
    ["video_url", "videos"],
    ["audio", "audios"],
    ["audios", "audios"],
    ["audioUrls", "audios"],
  ] as const)(
    "recognizes bare media parameter %s only with its matching uploaded input",
    (name, inputName) => {
      const model = imageModel();
      const candidate = parameter(name);
      expect(isModelMediaReferenceParameter(model, candidate)).toBe(false);

      model.input[inputName] = { min: 0, max: 2, multiple: true };
      expect(isModelMediaReferenceParameter(model, candidate)).toBe(true);

      model.input[inputName] = { min: 0, max: 0, multiple: false };
      expect(isModelMediaReferenceParameter(model, candidate)).toBe(false);
    },
  );

  it("removes media references from defaults, saved values, and composed requests", () => {
    const model = imageModel();
    model.input.images = { min: 0, max: 4, multiple: true };
    model.parameters.push(
      parameter("referenceImages", "array", { default: ["https://old.example/image.png"] }),
      parameter("reference_video", "string", { default: "https://old.example/video.mp4" }),
      parameter("ref_image_urls", "array", { fixed: ["https://old.example/fixed.png"] }),
      parameter("messages", "array", {
        default: [{ role: "user", content: "legacy media payload" }],
      }),
    );
    const saved = {
      quality: "4k",
      enhance: true,
      referenceImages: ["https://saved.example/image.png"],
      reference_video: "https://saved.example/video.mp4",
      ref_image_urls: ["https://saved.example/fixed.png"],
      messages: [{ role: "user", content: "saved media payload" }],
    };

    expect(defaultModelParameters(model)).toEqual({ quality: "2k", enhance: false });
    expect(reconcileModelParameters(model, saved)).toEqual({ quality: "4k", enhance: true });
    expect(composeModelParameters(model, "Uploaded inputs only", saved)).toEqual({
      prompt: "Uploaded inputs only",
      quality: "4k",
      enhance: true,
    });
  });

  it("keeps messages as the prompt when no separate prompt parameter exists", () => {
    const model = imageModel();
    model.input.images = { min: 0, max: 1, multiple: false };
    model.parameters = [parameter("messages", "array", { required: true })];

    expect(isModelMediaReferenceParameter(model, model.parameters[0]!)).toBe(false);
    expect(composeModelParameters(model, "Describe the upload", {})).toEqual({
      messages: [{ role: "user", content: "Describe the upload" }],
    });
  });

  it("does not treat messages as media when catalog inputs explicitly allow no uploads", () => {
    const model = imageModel();
    model.input.images = { min: 0, max: 0, multiple: false };
    model.parameters.push(parameter("messages", "array"));

    expect(isModelMediaReferenceParameter(model, model.parameters.at(-1)!)).toBe(false);
  });

  it.each(["video", "audio"] as const)(
    "normalizes %s duration defaults and saved values to the catalog range",
    (modality) => {
      const numericModel = timedMediaModel(
        modality,
        parameter("duration", "integer", { default: 1, min: 1, max: 20 }),
      );
      // 全局时长下限为 4 秒：低于下限的默认值与保存值都被夹到 4。
      expect(defaultModelParameters(numericModel)).toEqual({ duration: 4 });
      expect(reconcileModelParameters(numericModel, { duration: 1 })).toEqual({ duration: 4 });
      expect(reconcileModelParameters(numericModel, { duration: 15 })).toEqual({ duration: 15 });
      expect(reconcileModelParameters(numericModel, { duration: 20 })).toEqual({ duration: 20 });

      const stringModel = timedMediaModel(
        modality,
        parameter("seconds", "string", { default: "1", min: 1, max: 20 }),
      );
      expect(defaultModelParameters(stringModel)).toEqual({ seconds: "4" });
      expect(reconcileModelParameters(stringModel, { seconds: "1" })).toEqual({ seconds: "4" });
    },
  );

  it("migrates legacy nine-image duration and pixel orientation into the canonical controls", () => {
    const model = timedMediaModel(
      "video",
      parameter("duration_seconds", "integer", {
        default: 4,
        min: 4,
        max: 15,
        options: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      }),
    );
    model.parameters.push(
      parameter("aspect_ratio", "string", {
        default: "16:9",
        options: ["16:9", "9:16"],
      }),
    );

    expect(reconcileModelParameters(model, { seconds: 15, resolution: "720x1280" })).toEqual({
      duration_seconds: 15,
      aspect_ratio: "9:16",
    });
    expect(
      composeModelParameters(model, "竖屏人物镜头", { duration: 8, size: "720x1280" }),
    ).toEqual({
      duration_seconds: 8,
      aspect_ratio: "9:16",
    });
  });

  it("recognizes only request-priced fixed multi-output image models as one-call billing", () => {
    const mj = requestPricedMultiOutputImageModel();
    expect(isRequestPricedFixedMultiOutputImageModel(mj)).toBe(true);
    expect(requestPricedFixedOutputCount(mj)).toBe(5);

    const perImage = imageModel();
    expect(isRequestPricedFixedMultiOutputImageModel(perImage)).toBe(false);
    expect(requestPricedFixedOutputCount(perImage)).toBeNull();

    const requestSingle = {
      ...imageModel(),
      pricing: { ...imageModel().pricing, unit: "request" as const },
    };
    expect(isRequestPricedFixedMultiOutputImageModel(requestSingle)).toBe(false);

    const requestVariable = {
      ...imageModel(),
      pricing: { ...imageModel().pricing, unit: "request" as const },
      output: { type: "image" as const, minCount: 1, maxCount: 4 },
    };
    expect(isRequestPricedFixedMultiOutputImageModel(requestVariable)).toBe(false);

    expect(isRequestPricedFixedMultiOutputImageModel(null)).toBe(false);
    expect(requestPricedFixedOutputCount(null)).toBeNull();
  });

  it("batches image and video models that return a single output without a usable n range", () => {
    const single = imageModel();
    // 单图模型：没有 n 参数 → 可以连点凑数量。
    expect(supportsClientBatchGeneration(single, null)).toBe(true);
    // n 被固定成 1（GPT-Image / nano-banana 的目录形态）→ 同样可以连点。
    expect(supportsClientBatchGeneration(single, parameter("n", "integer", { fixed: 1 }))).toBe(
      true,
    );
    // 目录发布了可选的 n 范围 → 直接传 n，交给上游一次出多条。
    expect(
      supportsClientBatchGeneration(single, parameter("n", "integer", { min: 1, max: 4 })),
    ).toBe(false);
    // Midjourney：一次固定回多张，不再叠加连点。
    expect(
      supportsClientBatchGeneration(
        requestPricedMultiOutputImageModel(),
        parameter("n", "integer", { fixed: 1 }),
      ),
    ).toBe(false);
    // 输出契约本身允许多张（MJ 特惠这类 1-4 张）→ 不叠加连点，避免超发。
    const variable = { ...single, output: { type: "image" as const, minCount: 1, maxCount: 4 } };
    expect(supportsClientBatchGeneration(variable, parameter("n", "integer", { fixed: 1 }))).toBe(
      false,
    );
    // 视频一次只出一条，同样支持浏览器侧连点凑多条。
    expect(
      supportsClientBatchGeneration(
        timedMediaModel("video", parameter("duration", "integer")),
        null,
      ),
    ).toBe(true);
    const variableVideo = {
      ...timedMediaModel("video", parameter("duration", "integer")),
      output: { type: "video" as const, minCount: 1, maxCount: 4 },
    };
    expect(supportsClientBatchGeneration(variableVideo, null)).toBe(false);
    expect(supportsClientBatchGeneration(null, null)).toBe(false);
    expect(
      supportsClientBatchGeneration(
        timedMediaModel("audio", parameter("duration", "integer")),
        null,
      ),
    ).toBe(false);
  });

  it("always sends quantity 1 for request-priced fixed multi-output image models", () => {
    const mj = requestPricedMultiOutputImageModel();
    expect(generationRequestQuantity(mj, false, 5)).toBe(1);
    expect(generationRequestQuantity(mj, true, 5)).toBe(1);

    const perImage = imageModel();
    expect(generationRequestQuantity(perImage, false, 4)).toBe(4);
    expect(generationRequestQuantity(perImage, true, 4)).toBe(1);
    expect(generationRequestQuantity(null, false, 2)).toBe(2);
  });

  it("auto-picked settings overlay remembered parameters and let the default aspect win", () => {
    const model = imageModel();
    model.parameters.push(
      parameter("size", "string", { default: "9:16", options: ["16:9", "9:16", "1:1"] }),
    );

    // 未记住任何设置：模型默认 + 默认画幅播种。
    expect(
      autoPickGenerationSettings({ model, remembered: null, defaultAspectRatio: "16:9" }),
    ).toMatchObject({ quality: "2k", size: "16:9" });

    // 记住了上一次参数：覆盖到新模型上，但画幅仍由默认画幅决定。
    expect(
      autoPickGenerationSettings({
        model,
        remembered: { parameters: { quality: "4k", size: "1:1", enhance: true } },
        defaultAspectRatio: "9:16",
      }),
    ).toMatchObject({ quality: "4k", size: "9:16", enhance: true });

    // 模型不支持默认画幅取值时保留模型默认。
    expect(
      autoPickGenerationSettings({ model, remembered: null, defaultAspectRatio: "3:4" }),
    ).toMatchObject({ size: "9:16" });
  });
});

function imageModel(): PublicModel {
  return {
    id: "image-1",
    label: "全能模型2",
    description: "",
    modality: "image",
    operation: "generate",
    order: 0,
    input: { textRequired: true },
    output: { type: "image", minCount: 1, maxCount: 1 },
    parameters: [
      {
        name: "prompt",
        label: "提示词",
        type: "string",
        required: true,
        mutuallyExclusiveWith: [],
      },
      {
        name: "quality",
        label: "分辨率",
        type: "string",
        default: "2k",
        options: ["1k", "2k", "4k"],
        required: false,
        mutuallyExclusiveWith: [],
      },
      {
        name: "enhance",
        label: "增强",
        type: "boolean",
        default: false,
        required: false,
        mutuallyExclusiveWith: [],
      },
    ],
    pricing: {
      mode: "fixed",
      unit: "image",
      currency: "CNY",
      creditsPerYuan: 100,
      baseCreditMicros: 1_000_000,
      tiers: [],
    },
  };
}

function parameter(
  name: string,
  type: PublicModel["parameters"][number]["type"] = "string",
  overrides: Partial<PublicModel["parameters"][number]> = {},
): PublicModel["parameters"][number] {
  return {
    name,
    label: name,
    type,
    required: false,
    mutuallyExclusiveWith: [],
    ...overrides,
  };
}

function timedMediaModel(
  modality: "video" | "audio",
  duration: PublicModel["parameters"][number],
): PublicModel {
  return {
    ...imageModel(),
    id: `${modality}-1`,
    modality,
    output: { type: modality, minCount: 1, maxCount: 1 },
    parameters: [duration],
    pricing: {
      mode: "fixed",
      unit: "second",
      currency: "CNY",
      creditsPerYuan: 100,
      baseCreditMicros: 1_000_000,
      tiers: [],
    },
  };
}

function requestPricedMultiOutputImageModel(): PublicModel {
  return {
    ...imageModel(),
    id: "mj-v81",
    output: { type: "image", minCount: 5, maxCount: 5 },
    pricing: {
      mode: "fixed",
      unit: "request",
      currency: "CNY",
      creditsPerYuan: 100,
      baseCreditMicros: 40_000_000,
      baseYuanMicros: 400_000,
      tiers: [],
    },
  };
}
