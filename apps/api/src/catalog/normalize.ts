import { createHash } from "node:crypto";

import {
  modelParameterSchema,
  modelPricingSchema,
  publicModelCatalogSchema,
  publicModelSchema,
  type ModelInputCount,
  type ModelParameter,
  type ModelReferenceImageInput,
  type ModelReferenceMedia,
  type PublicModel,
  type PublicModelCatalog,
} from "@kachang/contracts";

import { sourceCatalogModelSchema, sourceCatalogSchema, type SourceCatalogModel } from "./source-schema.js";
import { applyRawIdLabels, applySeedanceSplitOverlay } from "./seedance-overlay.js";
import type { StoredCatalogSnapshot } from "./store.js";

// Bump when compatibility aliases, labels, pricing, or the reviewed public
// projection change so a persisted snapshot is refreshed instead of serving
// stale metadata or stale prices.
// 21: pricing 带上站点的元/秒参考价与说明（token 计价的视频模型靠它报价）。
// 22: MiniMax H3 的计价单位按站点口径纠正为按秒（目录发布的是按次，见
//     PER_SECOND_VIDEO_MODEL_IDS 上的说明）。必须 bump：不 bump 的话已持久化
//     的快照会继续按旧口径（按次）报价，等于修复不生效。
export const CATALOG_NORMALIZATION_VERSION = 23;

const MEDIA_REFERENCE_PARAMETER_NAME = /^(?:reference|ref)(image|video|audio)s?(?:url)?s?$/;
const BARE_MEDIA_PARAMETER_NAME = /^(image|video|audio)(?:s|urls?)?$/;
const POSITIONED_IMAGE_PARAMETER_NAME = /^(first|start|last|end)(?:(?:frame)(?:image)?|image)(?:url)?$/;
const SPECIALIZED_IMAGE_PARAMETER_NAME = /^(style|element)(?:references?|images?)(?:url)?s?$/;
const INPUT_MEDIA_PARAMETER_NAME = /^(?:input|source)(image|video|audio)(?:url)?s?$/;
const BLOCKED_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const ENDPOINT_BY_MODALITY = {
  text: new Set(["/v1/chat/completions"]),
  image: new Set(["/v1/images/generations", "/v1/midjourney/generations"]),
  video: new Set(["/v1/videos"]),
} as const;
const IMAGE2_FAST_4K_PUBLIC_ID = "image2-4k-fast";
const IMAGE2_FAST_4K_SOURCE_IDS = new Set([
  IMAGE2_FAST_4K_PUBLIC_ID,
  "gpt-image-2-4k-fast",
  "gpt-image-2-4k-adobe",
]);
// Keep the operator-facing alias stable even when the upstream catalog changes
// its marketing label. The 4K fast route belongs to the same 全能模型2 family
// as the upstream 1K and high-quality 2K/4K entries.
const IMAGE2_FAST_4K_LABEL = "全能模型2 · 4K";
const VIDEO_V1_LABEL = "SD 2.0 Fast";
const CANVAS_FACE_MODEL_ID = "sd2.0 pro 满血九图卡脸版";
const CANVAS_FACE_MODEL_LABEL = "SD2.0 Pro 720P（九图卡脸版）";
const CANVAS_FACE_MODEL_DESCRIPTION = "固定 720P，单次 4-30 秒文生视频或最多 9 张参考图。支持 720p、横竖版尺寸与 16:9/9:16 常见写法，网关会自动补齐匹配的画面尺寸和比例；未指定方向时默认横版。参考图必须是可公开访问的 HTTP/HTTPS 地址。";

const CANVAS_FACE_COMPATIBILITY_MODEL: Record<string, unknown> = {
  id: CANVAS_FACE_MODEL_ID,
  modality: "video",
  operation: "generate",
  protocol: {
    version: "video.v1",
    endpoint: { method: "POST", path: "/v1/videos" },
    media_roles: ["reference"],
  },
  order: 55,
  input: {
    text: { required: true },
    images: { min: 0, max: 9, multiple: true },
    videos: { min: 0, max: 0, multiple: false },
    audios: { min: 0, max: 0, multiple: false },
  },
  output: { type: "video", count: { fixed: 1 } },
  parameters: [
    { name: "model", path: "model", type: "string", fixed: CANVAS_FACE_MODEL_ID },
    { name: "prompt", path: "prompt", type: "string", required: true, min_length: 1, label: "提示词" },
    { name: "seconds", path: "seconds", type: "integer", min: 4, max: 30, label: "时长（秒）" },
    { name: "duration", path: "duration", type: "integer", min: 4, max: 30, label: "时长兼容字段（秒）" },
    { name: "size", path: "size", type: "string", options: ["720p", "1280x720", "720x1280", "16:9", "9:16"], label: "画面尺寸" },
    { name: "resolution", path: "resolution", type: "string", default: "720p", options: ["720p", "1280x720", "720x1280", "16:9", "9:16"], label: "画面尺寸兼容字段" },
    { name: "aspect_ratio", path: "aspect_ratio", type: "string", default: "16:9", options: ["16:9", "9:16"], label: "画面比例" },
    { name: "ratio", path: "ratio", type: "string", options: ["16:9", "9:16"], label: "画面比例兼容字段" },
    { name: "images", path: "images", type: "array", max_items: 9, format: "public-http-url", label: "参考图" },
    { name: "n", path: "n", type: "integer", fixed: 1, label: "生成数量" },
    { name: "async", path: "async", type: "boolean", fixed: true, label: "异步任务" },
  ],
  public: { id: CANVAS_FACE_MODEL_ID, label: CANVAS_FACE_MODEL_LABEL, description: CANVAS_FACE_MODEL_DESCRIPTION },
  selectable: true,
  pricing: {
    mode: "fixed",
    unit: "request",
    currency: "CNY",
    credits_per_yuan: 100,
    credits: 250,
    yuan: 2.5,
  },
  endpoint: { method: "POST", path: "/v1/videos", content_type: "application/json" },
};

export class CatalogValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogValidationError";
  }
}

export function normalizeSourceCatalog(
  value: unknown,
  options: { validatedAt: number; maxQuoteAgeMs: number; etag?: string; includeKnownModels?: boolean },
): StoredCatalogSnapshot {
  const parsed = applyRawIdLabels(applySeedanceSplitOverlay(sourceCatalogSchema.parse(sanitizeSourceCatalog(value))));
  const source = options.includeKnownModels
    ? addKnownMidjourneyModels(addKnownLegacyTextModels(parsed))
    : parsed;
  const sourceModels: Record<string, string> = {};
  const routes: StoredCatalogSnapshot["routes"] = {};
  const publicModels: PublicModel[] = [];
  const usedIds = new Set<string>();

  for (const sourceModel of source.models) {
    const model = applyMidjourneyCompatibility(
      options.includeKnownModels ? applyCatalogCompatibility(sourceModel) : sourceModel,
    );
    if (model.selectable === false || !model.public) continue;
    let route: StoredCatalogSnapshot["routes"][string];
    try {
      route = normalizePrivateRoute(model);
    } catch (error) {
      if (error instanceof CatalogValidationError) continue;
      throw error;
    }
    const publicId = model.public.id.trim();
    if (usedIds.has(publicId)) throw new CatalogValidationError(`Duplicate public model id: ${publicId}`);
    usedIds.add(publicId);
    sourceModels[publicId] = model.id;
    routes[publicId] = route;
    publicModels.push(normalizeModel(model, source.credits_per_yuan));
  }

  if (!publicModels.length) throw new CatalogValidationError("Catalog contains no selectable public models");
  publicModels.sort((left, right) => left.order - right.order || left.label.localeCompare(right.label, "zh-CN"));

  const pricingVersion = source.pricing_version.trim()
    ? source.pricing_version
    : derivePricingVersion(publicModels, source.credits_per_yuan);

  const catalog = publicModelCatalogSchema.parse({
    version: source.version,
    capabilityVersion: source.capability_version,
    pricingVersion,
    fetchedAt: source.fetched_at,
    expiresAt: new Date(options.validatedAt + options.maxQuoteAgeMs).toISOString(),
    quoteAvailable: true,
    models: publicModels,
  });

  return {
    catalog,
    sourceModels,
    routes,
    etag: options.etag,
    validatedAt: options.validatedAt,
    normalizationVersion: CATALOG_NORMALIZATION_VERSION,
  };
}

/**
 * The upstream pricing and route APIs still expose these text models, but the
 * capability catalog has not published definitions for them yet. Keep the
 * compatibility entries local and deliberately narrow: they are only added
 * when the upstream catalog omits the exact source id, and every price below
 * is the public base price from /api/pricing (CNY per million tokens or per
 * request). Once NewAPI publishes a definition, its live metadata wins.
 */
const LEGACY_TEXT_MODEL_PRICES = {
  "claude-3-5-sonnet-20240620": { input: 0.09, output: 0.45 },
  "claude-haiku-4-5-20251001": { input: 0.03, output: 0.15 },
  "claude-opus-4-20250514": { input: 0.45, output: 2.25 },
  "claude-3-5-haiku-20241022": { input: 0.03, output: 0.15 },
  "claude-3-7-sonnet-20250219": { input: 0.09, output: 0.45 },
  "claude-opus-4-1-20250805": { input: 0.45, output: 2.25 },
  "claude-sonnet-4-20250514": { input: 0.09, output: 0.45 },
  "claude-sonnet-4-5-20250929": { input: 0.09, output: 0.45 },
  "claude-3-5-sonnet-20241022": { input: 0.09, output: 0.45 },
} as const;

const LEGACY_TEXT_MODEL_LABELS = {
  "claude-3-5-sonnet-20240620": "Claude 3.5 Sonnet (2024-06-20)",
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  "claude-haiku-4-5-20251001": "Claude Haiku 4.5 (2025-10-01)",
  "claude-opus-4-20250514": "Claude Opus 4 (2025-05-14)",
  "claude-3-5-haiku-20241022": "Claude 3.5 Haiku (2024-10-22)",
  "claude-3-7-sonnet-20250219": "Claude 3.7 Sonnet (2025-02-19)",
  "claude-opus-4-1-20250805": "Claude Opus 4.1 (2025-08-05)",
  "claude-sonnet-4-20250514": "Claude Sonnet 4 (2025-05-14)",
  "claude-sonnet-4-5-20250929": "Claude Sonnet 4.5 (2025-09-29)",
  "claude-3-5-sonnet-20241022": "Claude 3.5 Sonnet (2024-10-22)",
} as const;

type LegacyTextModelId = keyof typeof LEGACY_TEXT_MODEL_LABELS;

function addKnownLegacyTextModels(source: ReturnType<typeof sourceCatalogSchema.parse>) {
  const existing = new Set(source.models.flatMap((model) => [model.id, model.public?.id ?? ""]));
  const additions = (Object.keys(LEGACY_TEXT_MODEL_LABELS) as LegacyTextModelId[])
    .filter((id) => !existing.has(id))
    .map((id) => createLegacyTextModel(id));
  return additions.length ? { ...source, models: [...source.models, ...additions] } : source;
}

function createLegacyTextModel(id: LegacyTextModelId): SourceCatalogModel {
  const label = LEGACY_TEXT_MODEL_LABELS[id];
  const parameters: SourceCatalogModel["parameters"] = [
    { name: "model", path: "model", label: "Model", type: "string", required: true, fixed: id },
    { name: "messages", path: "messages", label: "Messages", type: "array", required: true, min_items: 1, items: { type: "object" } },
    { name: "stream", path: "stream", label: "Stream", type: "boolean", required: false, default: false },
    { name: "max_tokens", path: "max_tokens", label: "Max output tokens", type: "integer", required: false, min: 1, max: 131072 },
  ];
  if (id === "deepseek-v4-flash") {
    return {
      id,
      modality: "text",
      operation: "chat",
      order: 12,
      input: { text: { required: true }, images: { min: 0, max: 0, multiple: false } },
      output: { type: "text" },
      parameters,
      endpoint: { method: "POST", path: "/v1/chat/completions", content_type: "application/json" },
      public: { id, label, description: "" },
      selectable: true,
      // 兼容项：老项目仍可报价/执行，但不属于模型广场的上架模型。
      listed: false,
      tags: "chat,text,deepseek",
      pricing: { mode: "fixed", unit: "request", currency: "CNY", credits_per_yuan: 100, yuan: 0.002, credits: 0.2 },
    };
  }
  const price = LEGACY_TEXT_MODEL_PRICES[id];
  return {
    id,
    modality: "text",
    operation: "chat",
    order: 15,
    input: { text: { required: true }, images: { min: 0, max: 0, multiple: false } },
    output: { type: "text" },
    parameters,
    endpoint: { method: "POST", path: "/v1/chat/completions", content_type: "application/json" },
    public: { id, label, description: "" },
    selectable: true,
    // 兼容项：老项目仍可报价/执行，但不属于模型广场的上架模型。
    listed: false,
    tags: "chat,text,claude",
    pricing: {
      mode: "token",
      unit: "token",
      currency: "CNY",
      credits_per_yuan: 100,
      input_yuan_per_million: price.input,
      output_yuan_per_million: price.output,
      input_credits_per_million: price.input * 100,
      output_credits_per_million: price.output * 100,
    },
  };
}

function applyCatalogCompatibility(model: SourceCatalogModel): SourceCatalogModel {
  if (!model.public) return model;
  const sourceId = model.id.trim().toLowerCase();
  const publicId = model.public.id.trim().toLowerCase();
  if (IMAGE2_FAST_4K_SOURCE_IDS.has(sourceId) || publicId === IMAGE2_FAST_4K_PUBLIC_ID) {
    let parameters = upsertSourceParameter(model.parameters, "quality", (parameter) => ({
      ...parameter,
      name: "quality",
      path: "quality",
      label: "质量",
      type: "string",
      required: false,
      default: undefined,
      fixed: "standard",
      options: undefined,
    }));
    parameters = upsertSourceParameter(parameters, "resolution", (parameter) => ({
      ...parameter,
      name: "resolution",
      path: "resolution",
      label: "分辨率",
      type: "string",
      required: false,
      default: undefined,
      fixed: "4k",
      options: undefined,
    }));
    parameters = upsertSourceParameter(parameters, "n", (parameter) => ({
      ...parameter,
      name: "n",
      path: "n",
      label: "生成张数",
      type: "integer",
      required: false,
      default: undefined,
      fixed: 1,
      options: undefined,
      min: undefined,
      max: undefined,
    }));
    parameters = upsertSourceParameter(parameters, "image", (parameter) => ({
      ...parameter,
      name: "image",
      path: "image",
      label: "参考图",
      type: "string",
      required: false,
      default: undefined,
      fixed: undefined,
      options: undefined,
      min_items: undefined,
      max_items: undefined,
      format: "uri-or-data-image",
      items: undefined,
    }));
    parameters = upsertSourceParameter(parameters, "images", (parameter) => ({
      ...parameter,
      name: "images",
      path: "images",
      label: "多张参考图",
      type: "array",
      required: false,
      default: undefined,
      fixed: undefined,
      options: undefined,
      min_items: 1,
      max_items: 14,
      format: undefined,
      items: { type: "string", format: "uri-or-data-image" },
    }));
    return {
      ...model,
      input: {
        ...model.input,
        images: { min: 0, max: 14, multiple: true },
      },
      output: {
        ...model.output,
        count: { fixed: 1 },
      },
      parameters,
      public: {
        ...model.public,
        id: IMAGE2_FAST_4K_PUBLIC_ID,
        label: IMAGE2_FAST_4K_LABEL,
      },
    };
  }
  if (sourceId === "video-v1" || publicId === "video-v1") {
    return { ...model, public: { ...model.public, label: VIDEO_V1_LABEL } };
  }
  return model;
}

type MidjourneyFallbackPricing = {
  credits_per_yuan: number;
  credits: number;
  yuan: number;
};

// Midjourney 8.1, Midjourney 7, and Niji 7 share the authoritative Canvas
// product decision (confirmed 2026-08-10): one provider call costs 40 credits /
// CNY 0.4 with a 100 credit-per-yuan conversion and returns four
// single-image artifacts; the 40/0.4 sales price itself is the
// product pricing decision. When the upstream publishes a definition, its live
// pricing wins over the fallback.
const MIDJOURNEY_FALLBACK_PRICING: MidjourneyFallbackPricing = {
  credits_per_yuan: 100,
  credits: 40,
  yuan: 0.4,
};

const MIDJOURNEY_MODELS: readonly SourceCatalogModel[] = [
  createMidjourneyModel("mj-v81", "Midjourney 8.1", "8.1", 80, "2", false, MIDJOURNEY_FALLBACK_PRICING),
  createMidjourneyModel("mj-v7", "Midjourney 7", "7", 81, "1", false, MIDJOURNEY_FALLBACK_PRICING),
  createMidjourneyModel("mj-niji7", "Midjourney Niji 7", "7", 82, "1", true, MIDJOURNEY_FALLBACK_PRICING),
];

function addKnownMidjourneyModels(source: ReturnType<typeof sourceCatalogSchema.parse>) {
  const existing = new Set(source.models.flatMap((model) => [model.id, model.public?.id ?? ""]));
  const additions = MIDJOURNEY_MODELS.filter((model) => !existing.has(model.id) && !existing.has(model.public?.id ?? ""));
  return additions.length ? { ...source, models: [...source.models, ...additions] } : source;
}

// A live Midjourney entry keeps its upstream price and parameters authoritative,
// but the public output contract and the provider submission-count parameter are
// normalized so the browser can never read the fixed artifact count as a batch
// of multiple calls. `n` (and a present `count` alias) is the provider submission
// count and stays fixed at 1; the public output contract reports four
// delivered artifacts. Private execution routes and pricing are not changed.
const MIDJOURNEY_PUBLIC_IDS = new Set(["mj-v81", "mj-v7", "mj-niji7"]);

// The station publishes newer stable-series Midjourney ids dotted
// (`mj-v8.2`, `mj-v8.1`, `mj-v6.1`) with a 4-5 output contract and a cover
// grid. Without the same normalization (fixed `n=1`, fixed four-image output
// contract) validateOutputCount computes one output and rejects every quote.
const DOTTED_MIDJOURNEY_ID = /^mj-v\d/;

function applyMidjourneyCompatibility(model: SourceCatalogModel): SourceCatalogModel {
  const sourceId = model.id.trim().toLowerCase();
  const publicId = model.public?.id.trim().toLowerCase() ?? "";
  if (
    !MIDJOURNEY_PUBLIC_IDS.has(sourceId)
    && !MIDJOURNEY_PUBLIC_IDS.has(publicId)
    && !DOTTED_MIDJOURNEY_ID.test(sourceId)
    && !DOTTED_MIDJOURNEY_ID.test(publicId)
  ) return model;
  let parameters = upsertSourceParameter(model.parameters, "n", (parameter) => ({
    ...parameter,
    name: "n",
    path: "n",
    label: "调用次数",
    type: "integer",
    required: false,
    fixed: 1,
    default: undefined,
    options: undefined,
    min: undefined,
    max: undefined,
  }));
  if (parameters.some((parameter) => parameter.name.trim().toLowerCase() === "count")) {
    parameters = upsertSourceParameter(parameters, "count", (parameter) => ({
      ...parameter,
      name: "count",
      path: "count",
      label: "调用次数兼容字段",
      type: "integer",
      required: false,
      fixed: 1,
      default: undefined,
      options: undefined,
      min: undefined,
      max: undefined,
    }));
  }
  return {
    ...model,
    output: { ...model.output, type: "image", count: { fixed: 4 } },
    parameters,
  };
}

function createMidjourneyModel(
  id: string,
  label: string,
  version: string,
  order: number,
  quality: string,
  niji: boolean,
  pricing: MidjourneyFallbackPricing,
): SourceCatalogModel {
  return {
    id,
    modality: "image",
    operation: "generate",
    order,
    input: {
      text: { required: true },
      images: { min: 0, max: 14, multiple: true },
    },
    output: { type: "image", count: { fixed: 4 } },
    parameters: [
      { name: "model", path: "model", type: "string", required: true, fixed: id, label: "模型" },
      { name: "prompt", path: "prompt", type: "string", required: true, min_length: 1, label: "提示词" },
      {
        name: "size",
        path: "size",
        type: "string",
        default: "auto",
        options: ["auto", "1:1", "16:9", "9:16", "3:4", "4:3", "3:2", "2:3", "5:4", "4:5", "21:9"],
        label: "画面比例",
      },
      { name: "quality", path: "quality", type: "string", default: quality, options: ["1", "2"], label: "清晰度" },
      { name: "stylize", path: "stylize", type: "integer", default: 0, min: 0, max: 1000, step: 1, label: "风格化" },
      { name: "chaos", path: "chaos", type: "integer", default: 0, min: 0, max: 100, step: 1, label: "混乱" },
      { name: "weird", path: "weird", type: "integer", default: 0, min: 0, max: 3000, step: 1, label: "怪异" },
      { name: "version", path: "version", type: "string", fixed: version, label: "版本" },
      { name: "speed", path: "speed", type: "string", fixed: "relax", label: "速度" },
      ...(niji ? [{ name: "niji", path: "niji", type: "boolean" as const, fixed: true, label: "Niji" }] : []),
      // API-station MJ returns four standalone images from one provider submission. `n`
      // identifies submission/call count and must remain one; the public
      // output contract above carries the four delivered artifacts.
      { name: "n", path: "n", type: "integer", fixed: 1, label: "调用次数" },
      {
        name: "image_urls",
        path: "image_urls",
        type: "array",
        max_items: 14,
        items: { type: "string", format: "public-http-url" },
        label: "参考图",
      },
    ],
    public: {
      id,
      label,
      description: "Midjourney Imagine 常规版本，单次返回四张图片。",
    },
    selectable: true,
    pricing: {
      mode: "fixed",
      unit: "request",
      currency: "CNY",
      credits_per_yuan: pricing.credits_per_yuan,
      credits: pricing.credits,
      yuan: pricing.yuan,
    },
    endpoint: { method: "POST", path: "/v1/midjourney/generations", content_type: "application/json" },
  };
}

type SourceParameter = SourceCatalogModel["parameters"][number];

const PUBLIC_PARAMETER_ALIAS_FAMILIES: readonly (readonly string[])[] = [
  ["duration_seconds", "seconds", "duration"],
  ["aspect_ratio", "aspectRatio", "ratio"],
  ["size", "resolution"],
];

const COMPATIBILITY_LABEL_PATTERN = /兼容(?:字段|别名|比例)/u;

const CANONICAL_PUBLIC_PARAMETER_LABELS: Readonly<Record<string, string>> = {
  duration_seconds: "时长（秒）",
  seconds: "时长（秒）",
  duration: "时长（秒）",
  aspect_ratio: "画面比例",
  aspectRatio: "画面比例",
  ratio: "画面比例",
  size: "画面尺寸",
  resolution: "分辨率",
};

function upsertSourceParameter(
  parameters: SourceParameter[],
  normalizedName: string,
  normalize: (parameter: SourceParameter | undefined) => SourceParameter,
) {
  let found = false;
  const next = parameters.flatMap((parameter) => {
    if (parameter.name.trim().toLowerCase() !== normalizedName) return [parameter];
    if (found) return [];
    found = true;
    return [normalize(parameter)];
  });
  if (!found) next.push(normalize(undefined));
  return next;
}

/** 上游把「同时发布了按次零售价」标记在 tags 里；缺 tags 时视为没有按次价。 */
function hasPerRequestTag(tags: string | undefined) {
  return (tags ?? "").split(",").some((tag) => tag.trim().toLowerCase() === "per-request");
}

function normalizeModel(model: SourceCatalogModel, catalogCreditsPerYuan: number) {
  const sourceParameters = projectPublicParameters(model);
  const parameters = sourceParameters
    .filter((parameter) => parameter.name !== "model" && !isMediaParameter(
      parameter.name,
      parameter.format ?? parameter.items?.format,
      parameter.path,
    ))
    .map(normalizeParameter);
  const inferredResolution = fixedResolutionFromModelId(model);
  if (inferredResolution && !hasDeclaredResolution(parameters)) {
    parameters.push(modelParameterSchema.parse({
      name: "resolution",
      label: "分辨率",
      type: "string",
      required: false,
      fixed: inferredResolution,
      mutuallyExclusiveWith: [],
    }));
  }
  const outputCount = model.output.count;
  const fixedCount = outputCount?.fixed;
  const protocol = model.protocol ?? imageProtocolForModel(model);
  return publicModelSchema.parse({
    id: model.public!.id,
    label: model.public!.label,
    description: model.public!.description ?? "",
    modality: model.modality,
    operation: model.operation,
    order: model.order ?? 0,
    ...(model.listed === false ? { listed: false } : {}),
    ...(hasPerRequestTag(model.tags) ? { perRequest: true } : {}),
    ...(protocol ? {
      protocol: {
        version: protocol.version,
        endpoint: protocol.endpoint,
        mediaRoles: protocol.media_roles,
      },
    } : {}),
    input: {
      textRequired: model.input?.text?.required === true,
      images: normalizeInputCount(model, "images"),
      videos: normalizeInputCount(model, "videos"),
      audios: normalizeInputCount(model, "audios"),
      referenceMedia: normalizeReferenceMedia(model),
    },
    output: {
      type: model.output.type,
      minCount: fixedCount ?? outputCount?.min ?? 1,
      maxCount: fixedCount ?? outputCount?.max ?? 1,
    },
    parameters,
    pricing: normalizePricing(model, catalogCreditsPerYuan, publicParameterAliases(model)),
  });
}

function imageProtocolForModel(model: SourceCatalogModel) {
  if (model.modality !== "image") return undefined;
  const path = model.endpoint?.path;
  if (path !== "/v1/images/generations" && path !== "/v1/chat/completions" && path !== "/v1/midjourney/generations") {
    return undefined;
  }
  const roles = new Set<"reference" | "style_reference" | "element_reference" | "mask">();
  for (const parameter of model.parameters) {
    const name = `${parameter.name} ${parameter.path ?? ""}`.replaceAll("_", "").toLowerCase();
    if (/(?:mask|inpaint)/.test(name)) roles.add("mask");
    else if (/style(?:reference|image)/.test(name)) roles.add("style_reference");
    else if (/element(?:reference|image)/.test(name)) roles.add("element_reference");
    else if (isMediaParameter(parameter.name, parameter.format ?? parameter.items?.format, parameter.path)) roles.add("reference");
  }
  if (!roles.size) roles.add("reference");
  return {
    version: "image.v1" as const,
    endpoint: { method: "POST" as const, path },
    media_roles: [...roles],
  };
}

/**
 * The browser contract has one field per documented concept. Provider route
 * metadata remains untouched in the private snapshot, so aliases can still
 * be translated by an execution adapter without becoming user-selectable
 * Canvas parameters.
 */
function projectPublicParameters(model: SourceCatalogModel) {
  const publicModel = canonicalizePublicImageParameters(model);
  const aliases = publicParameterAliases(publicModel);
  const canonicalNames = new Set(aliases.values());
  return publicModel.parameters
    .filter((parameter) => !aliases.has(parameter.name.trim()))
    .map((parameter) => {
      const name = parameter.name.trim();
      if (!canonicalNames.has(name) || !isCompatibilityParameter(parameter)) return parameter;
      return { ...parameter, label: CANONICAL_PUBLIC_PARAMETER_LABELS[name] ?? parameter.label };
    });
}

/**
 * Canvas exposes provider-neutral image intent. Image providers historically
 * put ratios in `size`, while resolution is a separate quality tier. Promote
 * ratio-valued size fields to the canonical `aspect_ratio` dropdown and hide
 * pixel-size/alias fields from the browser. The private execution route keeps
 * the original names, so this is a presentation/protocol projection only.
 */
function canonicalizePublicImageParameters(model: SourceCatalogModel): SourceCatalogModel {
  if (model.modality !== "image") return model;

  let parameters = [...model.parameters];
  const aspect = parameters.find((parameter) => parameter.name.trim() === "aspect_ratio");
  const ratioAlias = parameters.find((parameter) => parameter.name.trim() === "ratio");
  const size = parameters.find((parameter) => parameter.name.trim() === "size");
  const hasRatioOptions = Boolean(size?.options?.length)
    && size!.options!.every((option) => typeof option === "string" && /^(?:auto|\d+:\d+)$/u.test(option));

  if (!aspect && !ratioAlias && size && hasRatioOptions) {
    parameters = parameters.map((parameter) => parameter === size
      ? {
        ...parameter,
        name: "aspect_ratio",
        path: "aspect_ratio",
        label: "画面比例",
      }
      : parameter);
  } else if (!aspect && ratioAlias) {
    parameters = parameters.map((parameter) => parameter === ratioAlias
      ? {
        ...parameter,
        name: "aspect_ratio",
        path: "aspect_ratio",
        label: "画面比例",
      }
      : parameter);
  }

  const hasCanonicalAspect = parameters.some((parameter) => parameter.name.trim() === "aspect_ratio");
  if (hasCanonicalAspect) {
    parameters = parameters.filter((parameter) => !["size", "aspectRatio", "ratio"].includes(parameter.name.trim()));
  }
  return parameters === model.parameters ? model : { ...model, parameters };
}

function publicParameterAliases(model: SourceCatalogModel) {
  const aliases = new Map<string, string>();
  const requestExample = isRecord(model.documentation) && isRecord(model.documentation.request_example)
    ? model.documentation.request_example
    : undefined;
  for (const family of PUBLIC_PARAMETER_ALIAS_FAMILIES) {
    const parameters = model.parameters.filter((parameter) => family.includes(parameter.name));
    if (parameters.length < 2) continue;
    const documented = requestExample
      ? parameters.filter((parameter) => Object.hasOwn(requestExample, parameter.name))
      : [];
    let canonical: SourceParameter | undefined;
    if (family.includes("resolution") && parameters.some((parameter) => parameter.name === "resolution")) {
      canonical = parameters.find((parameter) => parameter.name === "resolution");
    } else if (documented.length === 1) {
      canonical = documented[0];
    } else {
      const nonCompatibility = parameters.filter((parameter) => !isCompatibilityParameter(parameter));
      if (nonCompatibility.length === 1) canonical = nonCompatibility[0];
      else if (family.includes("seconds")) canonical = parameters.find((parameter) => parameter.name === "seconds") ?? parameters[0];
      else if (family.includes("aspect_ratio")) canonical = parameters.find((parameter) => parameter.name === "aspect_ratio") ?? parameters[0];
      else canonical = parameters.find((parameter) => parameter.name === "resolution") ?? parameters[0];
    }
    if (!canonical) continue;
    for (const parameter of parameters) {
      if (parameter !== canonical) aliases.set(parameter.name.trim(), canonical.name.trim());
    }
  }
  return aliases;
}

function isCompatibilityParameter(parameter: SourceParameter) {
  return COMPATIBILITY_LABEL_PATTERN.test(parameter.label ?? "")
    || /(?:compat|alias)/iu.test(parameter.label ?? "");
}

type MediaKind = "image" | "video" | "audio";
type MediaPosition = "reference" | "first" | "last" | "style" | "element";
type MediaBinding = { kind: MediaKind; position: MediaPosition };
type ReferenceCountSource = { min?: number; max?: number; multiple?: boolean; role?: string };
type BindableMediaParameter = {
  parameter: SourceParameter;
  path: string;
  binding: MediaBinding;
};

function normalizeReferenceMedia(model: SourceCatalogModel): ModelReferenceMedia | undefined {
  const mediaParameters = bindableMediaParameters(model);
  const source = model.input?.reference_media;
  if (!mediaParameters.length && !source) return undefined;
  const images = normalizeReferenceInputCount(
    mediaParameters.filter(({ binding }) => binding.kind === "image" && ["reference", "first", "last"].includes(binding.position)),
    source?.images,
    "image",
    model.modality === "image" ? 0 : undefined,
  );
  const styleImages = normalizeReferenceInputCount(
    mediaParameters.filter(({ binding }) => binding.kind === "image" && binding.position === "style"),
    source?.style_images,
  );
  const elementImages = normalizeReferenceInputCount(
    mediaParameters.filter(({ binding }) => binding.kind === "image" && binding.position === "element"),
    source?.element_images,
  );
  const videos = normalizeReferenceInputCount(
    mediaParameters.filter(({ binding }) => binding.kind === "video"),
    source?.videos,
  );
  const audios = normalizeReferenceInputCount(
    mediaParameters.filter(({ binding }) => binding.kind === "audio"),
    source?.audios,
  );
  const parameterTotal = aggregateReferenceLimit(mediaParameters);
  const maxTotalItems = minimumDefined(parameterTotal, source?.max_total_items);

  return {
    ...(images ? { images } : {}),
    ...(styleImages ? { styleImages } : {}),
    ...(elementImages ? { elementImages } : {}),
    ...(videos ? { videos } : {}),
    ...(audios ? { audios } : {}),
    ...(maxTotalItems !== undefined ? { maxTotalItems } : {}),
  };
}

function normalizeReferenceInputCount(
  parameters: BindableMediaParameter[],
  source: ReferenceCountSource | undefined,
  kind?: "image",
  minimumOverride?: number,
): ModelReferenceImageInput | ModelInputCount | undefined {
  if (!parameters.length) {
    if (!source) return undefined;
    const max = source.max;
    return {
      min: max === 0 ? 0 : minimumOverride ?? source.min ?? 0,
      ...(max !== undefined ? { max } : {}),
      multiple: source.multiple ?? (max !== undefined && max > 1),
      ...(kind === "image" && source.role ? { role: source.role } : {}),
    };
  }

  const uniqueParameters = [...new Map(parameters.map((item) => [`${item.path}:${item.parameter.type}`, item])).values()];
  const positioned = uniqueParameters.filter(({ binding }) => binding.position === "first" || binding.position === "last");
  const arrayParameter = uniqueParameters.find(({ parameter }) => parameter.type === "array")?.parameter;
  const singleParameters = uniqueParameters.filter(({ parameter }) => parameter.type === "string");
  // When a route exposes both an all-purpose image array and optional
  // first/last fields, the provider binds ordinary Canvas references to the
  // array. Publish that real execution capacity instead of collapsing the
  // model to the two optional frame slots.
  const usesFrames = kind === "image" && !arrayParameter && positioned.length > 0;
  const inferredMin = usesFrames
    ? positioned.filter(({ parameter }) => parameter.required === true).length
    : arrayParameter
      ? Math.max(arrayParameter.min_items ?? 0, arrayParameter.required === true ? 1 : 0)
      : singleParameters.some(({ parameter }) => parameter.required === true) ? 1 : 0;
  const inferredMax = usesFrames
    ? positioned.length
    : arrayParameter
      ? arrayParameter.max_items
      : 1;
  const max = minimumDefined(inferredMax, source?.max);
  const multiple = Boolean(
    (usesFrames ? positioned.length > 1 : arrayParameter && (inferredMax === undefined || inferredMax > 1))
    && source?.multiple !== false
    && (max === undefined || max > 1),
  );
  const role = usesFrames ? "frame" : kind === "image" ? source?.role : undefined;

  return {
    min: max === 0 ? 0 : minimumOverride ?? Math.max(inferredMin, source?.min ?? 0),
    ...(max !== undefined ? { max } : {}),
    multiple,
    ...(role ? { role } : {}),
  };
}

function bindableMediaParameters(model: SourceCatalogModel): BindableMediaParameter[] {
  return model.parameters.flatMap((parameter) => {
    if ((parameter.type !== "string" && parameter.type !== "array") || parameter.fixed !== undefined) return [];
    const binding = mediaParameterBinding(parameter.name, parameter.format ?? parameter.items?.format, parameter.path);
    if (!binding) return [];
    return [{ parameter, path: parameter.path ?? parameter.name, binding }];
  });
}

function aggregateReferenceLimit(parameters: BindableMediaParameter[]) {
  const declaredPaths = new Set(parameters.map(({ path }) => path.trim()));
  const limits: number[] = [];
  for (const { parameter } of parameters) {
    const constraints = [
      parameter.aggregate_constraint
        ? { fields: parameter.aggregate_constraint.fields, max: parameter.aggregate_constraint.max_total_items }
        : undefined,
      parameter.aggregateConstraint
        ? { fields: parameter.aggregateConstraint.fields, max: parameter.aggregateConstraint.maxTotalItems }
        : undefined,
    ];
    for (const constraint of constraints) {
      if (!constraint) continue;
      const fields = new Set(constraint.fields.map((field) => field.trim()));
      if ([...declaredPaths].every((path) => fields.has(path) || fields.has(path.split(".").at(-1)!))) {
        limits.push(constraint.max);
      }
    }
  }
  return limits.length ? Math.min(...limits) : undefined;
}

function minimumDefined(left: number | undefined, right: number | undefined) {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function fixedResolutionFromModelId(model: SourceCatalogModel) {
  if (model.modality !== "image") return null;
  const candidates = [model.public?.id ?? "", model.id];
  for (const candidate of candidates) {
    const resolution = candidate.toLowerCase().match(/(?:^|[-_])(1k|2k|4k)(?:[-_]|$)/)?.[1];
    if (resolution === "1k" || resolution === "2k" || resolution === "4k") return resolution;
  }
  return null;
}

function hasDeclaredResolution(parameters: ModelParameter[]) {
  return parameters.some((parameter) => {
    if (["resolution", "size"].includes(parameter.name.trim().toLowerCase())) return true;
    if (parameter.name.trim().toLowerCase() !== "quality") return false;
    const values = [parameter.fixed, parameter.default, ...(parameter.options ?? [])]
      .map((value) => typeof value === "string" ? value.toLowerCase() : "");
    return values.some((value) => value === "1k" || value === "2k" || value === "4k");
  });
}

function normalizeParameter(parameter: SourceCatalogModel["parameters"][number]): ModelParameter {
  return modelParameterSchema.parse({
    name: parameter.name,
    label: parameter.label ?? parameter.name,
    type: parameter.type,
    required: parameter.required ?? false,
    default: parameter.default,
    fixed: parameter.fixed,
    options: parameter.options,
    min: parameter.min,
    max: parameter.max,
    step: parameter.step,
    minLength: parameter.min_length,
    maxLength: parameter.max_length,
    minItems: parameter.min_items,
    maxItems: parameter.max_items,
    format: parameter.format,
    items: parameter.items,
    mutuallyExclusiveWith: parameter.mutually_exclusive_with ?? [],
  });
}

function normalizePrivateRoute(model: SourceCatalogModel): StoredCatalogSnapshot["routes"][string] {
  const expectedPath = ENDPOINT_BY_MODALITY[model.modality as keyof typeof ENDPOINT_BY_MODALITY];
  if (!expectedPath || !model.endpoint || !expectedPath.has(model.endpoint.path)) {
    throw new CatalogValidationError(`Unsupported execution endpoint for public model ${model.public?.id ?? model.id}`);
  }
  const modelParameter = model.parameters.find((parameter) => parameter.name === "model");
  if (!modelParameter || modelParameter.fixed !== model.id) {
    throw new CatalogValidationError(`Public model ${model.public?.id ?? model.id} has no fixed private model route`);
  }
  return {
    sourceModelId: model.id,
    modality: model.modality,
    endpoint: {
      method: model.endpoint.method,
      path: model.endpoint.path,
      contentType: model.endpoint.content_type,
    },
    parameters: model.parameters.map((parameter) => ({
      name: parameter.name,
      path: safeParameterPath(parameter.path ?? parameter.name),
      type: parameter.type,
      ...(parameter.fixed !== undefined ? { fixed: parameter.fixed } : {}),
      ...(parameter.default !== undefined ? { default: parameter.default } : {}),
      ...(parameter.format ? { format: parameter.format } : {}),
      ...(parameter.items?.format ? { itemsFormat: parameter.items.format } : {}),
    })),
  };
}

function safeParameterPath(value: string) {
  const segments = value.split(".");
  if (!segments.length || segments.length > 8 || segments.some((segment) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment) || BLOCKED_PATH_SEGMENTS.has(segment))) {
    throw new CatalogValidationError(`Unsafe model parameter path: ${value}`);
  }
  return segments.join(".");
}

function normalizeInputCount(model: SourceCatalogModel, kind: "images" | "videos" | "audios"): ModelInputCount | undefined {
  const source = model.input?.[kind];
  const mediaKind = kind.slice(0, -1) as "image" | "video" | "audio";
  const mediaParameters = model.parameters.filter((parameter) => {
    const binding = mediaParameterBinding(
      parameter.name,
      parameter.format ?? parameter.items?.format,
      parameter.path,
    );
    return binding?.kind === mediaKind && binding.position !== "style" && binding.position !== "element";
  });
  const arrayParameter = mediaParameters.find((parameter) => parameter.type === "array");
  const singleParameters = mediaParameters.filter((parameter) => parameter.type !== "array");
  if (!source && !mediaParameters.length) return undefined;
  const positionedCount = singleParameters.filter((parameter) => mediaParameterBinding(
    parameter.name,
    parameter.format ?? parameter.items?.format,
    parameter.path,
  )?.position !== "reference").length;
  const inferredMax = arrayParameter ? undefined : positionedCount || (singleParameters.length ? 1 : undefined);
  const max = source?.max ?? arrayParameter?.max_items ?? inferredMax;
  const minimum = model.modality === "image" && kind === "images"
    ? 0
    : source?.min ?? arrayParameter?.min_items ?? 0;
  return {
    min: minimum,
    ...(max !== undefined ? { max } : {}),
    multiple: source?.multiple ?? Boolean(arrayParameter || positionedCount > 1),
  };
}

// 站点计价口径（console.prompt-hubs.com/pricing）与卡藏目录的 unit 字段在一条
// 线上不一致：MiniMax H3 站点按秒计费，目录却发布 unit:"request"，其中目录写的
// 「积分/条」那个数其实是**每秒**费率（分档价同理）。若照目录按次收，一条 10 秒
// 的视频只收一"条"的钱，比应收少一个数量级——这个 bug 已经反复出现过几次
// （8e84cc05 一刀切改按秒 → 7f97b7c2 收窄 → 20260920 又被整段删掉）。
// 因此这里按站点口径把 H3 纠正回按秒，并用 source-unit-and-token-modes.test.ts
// 里的用例钉住：必须同时锁住「H3=按秒」和「S-2.0 等线路=按次」两端，
// 只放宽一端就会重新变成事故。费率数字以卡藏实时目录为准，不写死在代码里。
//
// 只按 id 精确匹配，绝不按「带时长参数」一刀切：S-2.0 满血/线路六、Veo、
// Kling、Runway、Wan 都带时长参数，但它们是真正的按次计价。
const PER_SECOND_VIDEO_MODEL_IDS = new Set(["minimax_h3"]);

function normalizePricing(model: SourceCatalogModel, catalogCreditsPerYuan: number, aliases: ReadonlyMap<string, string>) {
  const pricing = model.pricing;
  const creditsPerYuan = Math.round(pricing.credits_per_yuan ?? catalogCreditsPerYuan);
  const unit = pricing.unit === "request" && PER_SECOND_VIDEO_MODEL_IDS.has(model.id) ? "second" : pricing.unit;
  // The upstream catalog uses `tiered_token` for token models whose rates can
  // vary by context tier.  The public contract currently has one token rate
  // pair, so expose the catalog's base rates (falling back to the first named
  // tier when a source omits the base fields) and keep the public mode stable.
  const publicMode = pricing.mode === "tiered_token" ? "token" : pricing.mode;
  const tokenTier = pricing.mode === "tiered_token"
    ? pricing.tiers?.find(isNamedTokenTier)
    : undefined;
  const inputCreditsPerMillion = pricing.input_credits_per_million ?? tokenTier?.input_credits_per_million;
  const outputCreditsPerMillion = pricing.output_credits_per_million ?? tokenTier?.output_credits_per_million;
  const inputYuanPerMillion = pricing.input_yuan_per_million ?? tokenTier?.input_yuan_per_million;
  const outputYuanPerMillion = pricing.output_yuan_per_million ?? tokenTier?.output_yuan_per_million;
  const estimatedYuanPerSecond = typeof pricing.estimated_yuan_per_second === "number" && Number.isFinite(pricing.estimated_yuan_per_second) && pricing.estimated_yuan_per_second >= 0
    ? pricing.estimated_yuan_per_second
    : undefined;
  const estimateNote = typeof pricing.estimate_note === "string" && pricing.estimate_note.trim()
    ? pricing.estimate_note.trim()
    : undefined;
  return modelPricingSchema.parse({
    mode: publicMode,
    unit,
    currency: "CNY",
    creditsPerYuan,
    ...(pricing.credits !== undefined ? { baseCreditMicros: toMicros(pricing.credits) } : {}),
    ...(pricing.yuan !== undefined ? { baseYuanMicros: toMicros(pricing.yuan) } : {}),
    // Named token tiers cannot be represented by the current public pricing
    // schema; their base rates above are still sufficient for token quotes.
    tiers: pricing.mode === "tiered_token" ? [] : (pricing.tiers ?? []).filter(isConditionalTier).map((tier) => ({
      when: normalizePricingCondition(tier.when, aliases),
      creditMicros: toMicros(tier.credits),
      yuanMicros: toMicros(tier.yuan),
    })),
    ...(inputCreditsPerMillion !== undefined ? { inputCreditMicrosPerMillion: toMicros(inputCreditsPerMillion) } : {}),
    ...(outputCreditsPerMillion !== undefined ? { outputCreditMicrosPerMillion: toMicros(outputCreditsPerMillion) } : {}),
    ...(inputYuanPerMillion !== undefined ? { inputYuanMicrosPerMillion: toMicros(inputYuanPerMillion) } : {}),
    ...(outputYuanPerMillion !== undefined ? { outputYuanMicrosPerMillion: toMicros(outputYuanPerMillion) } : {}),
    // token 计价的视频模型没有可估算的浏览器侧 token 量，只能靠站点发布的
    // 元/秒参考价报价。丢掉这两个字段就等于让画布无价可报。
    ...(estimatedYuanPerSecond !== undefined ? { estimatedYuanMicrosPerSecond: toMicros(estimatedYuanPerSecond) } : {}),
    ...(estimateNote !== undefined ? { estimateNote } : {}),
  });
}

function normalizePricingCondition(condition: Record<string, string | number | boolean>, aliases: ReadonlyMap<string, string>) {
  const normalized: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(condition)) {
    const canonical = aliases.get(name) ?? name;
    // If a source tier contains both spellings, the documented canonical
    // field wins over its compatibility alias.
    if (Object.hasOwn(normalized, canonical) && canonical !== name) continue;
    normalized[canonical] = value;
  }
  return normalized;
}

type SourcePricingTier = NonNullable<SourceCatalogModel["pricing"]["tiers"]>[number];

function isNamedTokenTier(tier: SourcePricingTier): tier is Extract<SourcePricingTier, { name: string }> {
  return "name" in tier;
}

function isConditionalTier(tier: SourcePricingTier): tier is Extract<SourcePricingTier, { when: Record<string, unknown>; yuan: number; credits: number }> {
  return "when" in tier && typeof tier.yuan === "number" && typeof tier.credits === "number";
}

function isMediaParameter(name: string, format?: string, path?: string) {
  return mediaParameterBinding(name, format, path) !== null;
}

function mediaParameterBinding(name: string, format?: string, path?: string): MediaBinding | null {
  const pathBinding = mediaBindingFromName(path?.split(".").at(-1));
  if (pathBinding) return pathBinding;
  const nameBinding = mediaBindingFromName(name);
  if (nameBinding) return nameBinding;
  const formatKind = /uri/i.test(format ?? "") ? /(image|video|audio)/i.exec(format ?? "")?.[1]?.toLowerCase() : undefined;
  return formatKind ? { kind: formatKind as MediaKind, position: "reference" } : null;
}

function mediaBindingFromName(value: string | undefined): MediaBinding | null {
  if (!value) return null;
  const normalizedName = value.replaceAll("_", "").toLowerCase();
  const specializedImage = SPECIALIZED_IMAGE_PARAMETER_NAME.exec(normalizedName)?.[1] as "style" | "element" | undefined;
  if (specializedImage) return { kind: "image", position: specializedImage };
  const positionedImage = POSITIONED_IMAGE_PARAMETER_NAME.exec(normalizedName)?.[1];
  if (positionedImage) {
    return { kind: "image", position: positionedImage === "first" || positionedImage === "start" ? "first" : "last" };
  }
  const inputKind = INPUT_MEDIA_PARAMETER_NAME.exec(normalizedName)?.[1] as MediaKind | undefined;
  if (inputKind) return { kind: inputKind, position: "reference" };
  const bareKind = BARE_MEDIA_PARAMETER_NAME.exec(normalizedName)?.[1] as MediaKind | undefined;
  if (bareKind) return { kind: bareKind, position: "reference" };
  const referenceKind = MEDIA_REFERENCE_PARAMETER_NAME.exec(normalizedName)?.[1] as MediaKind | undefined;
  if (referenceKind) return { kind: referenceKind, position: "reference" };
  return null;
}

// One malformed draft model must not invalidate an otherwise usable refresh.
// The top-level envelope remains strict; only independently invalid model rows
// are omitted before the complete catalog is parsed and normalized.
function sanitizeSourceCatalog(value: unknown) {
  if (!isRecord(value)) return value;
  const sanitizedModels = Array.isArray(value.models)
    ? value.models.map(sanitizeSourceModel).filter((model): model is Record<string, unknown> => model !== null)
    : value.models;
  const models = Array.isArray(sanitizedModels)
    ? ensureCanvasFaceCompatibilityModel(sanitizedModels)
    : sanitizedModels;
  return {
    ...value,
    // Keep a valid non-empty upstream version untouched. An empty, missing, or
    // "unknown" sentinel version (any casing, with surrounding whitespace) stays
    // empty so normalization derives a content-based pricing version instead of
    // publishing a literal "unknown" that a selectable paid quote could carry.
    pricing_version: normalizeSourcePricingVersion(value.pricing_version),
    models,
  };
}

function normalizeSourcePricingVersion(value: unknown) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.toLowerCase() === "unknown" ? "" : trimmed;
}

function ensureCanvasFaceCompatibilityModel(models: Array<Record<string, unknown>>) {
  const hasSeedance2 = models.some((model) => typeof model.id === "string" && /^sd2(?:\.0)?(?:[-\s]|$)/iu.test(model.id));
  if (!hasSeedance2) return models;
  const targetIndex = models.findIndex((model) => model.id === CANVAS_FACE_MODEL_ID);
  if (targetIndex >= 0) {
    const next = models.slice();
    next[targetIndex] = { ...CANVAS_FACE_COMPATIBILITY_MODEL };
    return next;
  }
  if (models.some((model) => isRecord(model.public) && model.public.id === CANVAS_FACE_MODEL_ID)) return models;
  return [...models, { ...CANVAS_FACE_COMPATIBILITY_MODEL }];
}

export function ensureCanvasFaceCompatibilitySnapshot(snapshot: StoredCatalogSnapshot): StoredCatalogSnapshot {
  if (!snapshot.catalog.models.some((model) => /^sd2(?:\.0)?(?:[-\s]|$)/iu.test(model.id))) return snapshot;
  if (snapshot.catalog.models.some((model) => model.id === CANVAS_FACE_MODEL_ID)) return snapshot;
  const sourceModel = sourceCatalogModelSchema.parse(CANVAS_FACE_COMPATIBILITY_MODEL);
  const model = normalizeModel(sourceModel, sourceModel.pricing.credits_per_yuan ?? 100);
  const route = normalizePrivateRoute(sourceModel);
  const models = [...snapshot.catalog.models, model]
    .sort((left, right) => left.order - right.order || left.label.localeCompare(right.label, "zh-CN"));
  return {
    ...snapshot,
    catalog: publicModelCatalogSchema.parse({ ...snapshot.catalog, models }),
    sourceModels: { ...snapshot.sourceModels, [CANVAS_FACE_MODEL_ID]: CANVAS_FACE_MODEL_ID },
    routes: { ...snapshot.routes, [CANVAS_FACE_MODEL_ID]: route },
  };
}

function sanitizeSourceModel(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || !isRecord(value.pricing)) return null;
  // `tiered_token` is the source shape for token models whose per-million rates
  // vary by context tier; normalizePricing folds it into the public `token`
  // mode. Dropping it here silently removed every such model from the picker
  // (2026-09-20: all four Gemini lines plus GPT-5.6 Sol), so it must survive.
  if (!(["fixed", "tiered", "token", "tiered_token"] as unknown[]).includes(value.pricing.mode)) return null;
  if (!(["request", "image", "second", "token"] as unknown[]).includes(value.pricing.unit)) return null;
  const pricing = { ...value.pricing };
  if (Array.isArray(pricing.tiers)) {
    pricing.tiers = pricing.tiers.filter((tier) => isRecord(tier)
      && isRecord(tier.when)
      && typeof tier.yuan === "number"
      && Number.isFinite(tier.yuan)
      && typeof tier.credits === "number"
      && Number.isFinite(tier.credits));
  }
  const publicValue = isRecord(value.public)
    ? { ...value.public, description: typeof value.public.description === "string" ? value.public.description : "" }
    : value.public;
  const order = typeof value.order === "number" && Number.isFinite(value.order) ? Math.round(value.order) : value.order;
  const candidate = { ...value, pricing, public: publicValue, order };
  return sourceCatalogModelSchema.safeParse(candidate).success ? candidate : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toMicros(value: number) {
  return Math.round(value * 1_000_000);
}

export function withQuoteAvailability(catalog: PublicModelCatalog, now: number) {
  return publicModelCatalogSchema.parse({
    ...catalog,
    quoteAvailable: now < Date.parse(catalog.expiresAt),
  });
}

// When the upstream omits pricing_version, derive a deterministic version from
// the price-relevant content of the normalized public catalog so a quote can
// never carry an unknown version. The hash covers each selectable model's id,
// output count contract, and normalized pricing plus the catalog credit ratio;
// any price-relevant change therefore rotates the derived version, while
// timestamps and display fields stay out of the digest.
function derivePricingVersion(models: PublicModel[], creditsPerYuan: number) {
  const priceContent = {
    creditsPerYuan,
    models: models.map((model) => ({
      id: model.id,
      output: model.output,
      pricing: model.pricing,
    })),
  };
  const digest = createHash("sha256").update(JSON.stringify(priceContent)).digest("hex").slice(0, 16);
  return `content:${digest}`;
}
