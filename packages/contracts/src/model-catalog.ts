import { z } from "zod";

import { audioModelProtocolSchema } from "./audio-protocol.js";
import { IMAGE_PROTOCOL_VERSION, imageMediaRoleSchema } from "./image-protocol.js";
import { VIDEO_PROTOCOL_VERSION, videoMediaRoleSchema } from "./video-protocol.js";

export const modelModalitySchema = z.enum(["text", "image", "video", "audio"]);
export type ModelModality = z.infer<typeof modelModalitySchema>;

export const modelParameterTypeSchema = z.enum([
  "string",
  "integer",
  "number",
  "boolean",
  "array",
  "object",
]);
export type ModelParameterType = z.infer<typeof modelParameterTypeSchema>;

const parameterValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const modelParameterItemSchema = z.object({
  type: modelParameterTypeSchema,
  format: z.string().min(1).optional(),
});

export const modelParameterSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  /** 目录对参数的人话解释；可选，客户端用它生成字段说明。 */
  description: z.string().min(1).optional(),
  type: modelParameterTypeSchema,
  required: z.boolean().default(false),
  default: z.unknown().optional(),
  fixed: z.unknown().optional(),
  options: z.array(parameterValueSchema).min(1).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().positive().optional(),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().positive().optional(),
  minItems: z.number().int().nonnegative().optional(),
  maxItems: z.number().int().positive().optional(),
  format: z.string().min(1).optional(),
  items: modelParameterItemSchema.optional(),
  mutuallyExclusiveWith: z.array(z.string().min(1)).default([]),
});
export type ModelParameter = z.infer<typeof modelParameterSchema>;

export const modelInputCountSchema = z.object({
  min: z.number().int().nonnegative().default(0),
  max: z.number().int().nonnegative().optional(),
  multiple: z.boolean().default(false),
});
export type ModelInputCount = z.infer<typeof modelInputCountSchema>;

export const modelReferenceImageInputSchema = modelInputCountSchema.extend({
  role: z.string().min(1).optional(),
});
export type ModelReferenceImageInput = z.infer<typeof modelReferenceImageInputSchema>;

export const modelReferenceMediaSchema = z.object({
  images: modelReferenceImageInputSchema.optional(),
  styleImages: modelInputCountSchema.optional(),
  elementImages: modelInputCountSchema.optional(),
  videos: modelInputCountSchema.optional(),
  audios: modelInputCountSchema.optional(),
  maxTotalItems: z.number().int().nonnegative().optional(),
});
export type ModelReferenceMedia = z.infer<typeof modelReferenceMediaSchema>;

export const modelInputSchema = z.object({
  textRequired: z.boolean().default(false),
  images: modelInputCountSchema.optional(),
  videos: modelInputCountSchema.optional(),
  audios: modelInputCountSchema.optional(),
  referenceMedia: modelReferenceMediaSchema.optional(),
});
export type ModelInput = z.infer<typeof modelInputSchema>;

export const modelOutputSchema = z.object({
  type: modelModalitySchema,
  minCount: z.number().int().positive().default(1),
  maxCount: z.number().int().positive().default(1),
});
export type ModelOutput = z.infer<typeof modelOutputSchema>;

export const modelPricingTierSchema = z.object({
  when: z.record(z.string(), parameterValueSchema),
  creditMicros: z.number().int().nonnegative(),
  yuanMicros: z.number().int().nonnegative(),
});
export type ModelPricingTier = z.infer<typeof modelPricingTierSchema>;

export const modelPricingSchema = z.object({
  mode: z.enum(["fixed", "tiered", "token"]),
  unit: z.enum(["request", "image", "second", "token"]),
  currency: z.literal("CNY"),
  creditsPerYuan: z.number().int().positive(),
  baseCreditMicros: z.number().int().nonnegative().optional(),
  baseYuanMicros: z.number().int().nonnegative().optional(),
  tiers: z.array(modelPricingTierSchema).default([]),
  inputCreditMicrosPerMillion: z.number().int().nonnegative().optional(),
  outputCreditMicrosPerMillion: z.number().int().nonnegative().optional(),
  inputYuanMicrosPerMillion: z.number().int().nonnegative().optional(),
  outputYuanMicrosPerMillion: z.number().int().nonnegative().optional(),
  /**
   * 站点为「按 token 计价」的视频模型发布的平均参考价（元/秒）。视频的实际
   * token 用量由上游按帧数与分辨率决定，浏览器无从估算，这类模型只能按参考
   * 单价报价；站点原文即写明「仅供参考，以实际用量为准」。
   */
  estimatedYuanMicrosPerSecond: z.number().int().nonnegative().optional(),
  estimateNote: z.string().min(1).optional(),
});
export type ModelPricing = z.infer<typeof modelPricingSchema>;

export const videoModelProtocolSchema = z.object({
  version: z.literal(VIDEO_PROTOCOL_VERSION),
  endpoint: z.object({
    method: z.literal("POST"),
    path: z.literal("/v1/videos"),
  }),
  mediaRoles: z.array(videoMediaRoleSchema),
});
export const imageModelProtocolSchema = z.object({
  version: z.literal(IMAGE_PROTOCOL_VERSION),
  endpoint: z.object({
    method: z.literal("POST"),
    path: z.enum(["/v1/images/generations", "/v1/chat/completions", "/v1/midjourney/generations"]),
  }),
  mediaRoles: z.array(imageMediaRoleSchema),
});
export const modelProtocolSchema = z.union([
  videoModelProtocolSchema,
  imageModelProtocolSchema,
  audioModelProtocolSchema,
]);
export type ModelProtocol = z.infer<typeof modelProtocolSchema>;

/**
 * 模型运营分区：
 * - `stable`（默认，缺省即此）：主推的稳定可用模型，默认选中、默认排序靠前。
 * - `promo`：特惠引流区。渠道上下架频繁，随时可能下架或不可用，可用时也不
 *   保证成功率；前端会与稳定区分开呈现并附免责声明。
 */
export const modelZoneSchema = z.enum(["stable", "promo"]);
export type ModelZone = z.infer<typeof modelZoneSchema>;

/**
 * 模型健康度：由服务端从真实生成任务聚合（近 windowHours 内 completed/failed
 * 终态任务），样本不足的模型不带此字段。只反映本服务通道的实际成功率，
 * 不是上游站点的宣称值。
 */
export const modelHealthSchema = z.object({
  /** 0..1，completed / (completed + failed)。 */
  successRate: z.number().min(0).max(1),
  /** 参与聚合的终态任务数（面板展示样本量，避免把 5 次里成 4 次读成 80%）。 */
  sampleCount: z.number().int().nonnegative(),
  windowHours: z.number().int().positive(),
});
export type ModelHealth = z.infer<typeof modelHealthSchema>;

export const publicModelSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().default(""),
  modality: modelModalitySchema,
  operation: z.string().min(1),
  order: z.number().finite().min(-1_000_000).max(1_000_000).default(0),
  routeLine: z.number().int().positive().max(10_000).optional(),
  /**
   * False marks a local compatibility entry that keeps an old project quotable
   * but is NOT published on the model plaza. New-work pickers must skip it;
   * absent means listed.
   */
  listed: z.boolean().optional(),
  /**
   * 上游在目录 tags 里标注了 `per-request`：该模型除了按量费率外，站点还发布了
   * 按次零售价（「按次文本」分组）。按次入口（Agent 模型选择器）据此准入——
   * 只看 pricing.mode 会把 tiered_token 的 Gemini 整线误判成纯按量模型而整个过滤掉。
   */
  perRequest: z.boolean().optional(),
  /** 运营分区；缺省视为 stable（主推稳定区）。 */
  zone: modelZoneSchema.optional(),
  /** 服务端聚合的真实成功率；无数据（样本不足/未接数据库）时缺省。 */
  health: modelHealthSchema.optional(),
  protocol: modelProtocolSchema.optional(),
  input: modelInputSchema,
  output: modelOutputSchema,
  parameters: z.array(modelParameterSchema),
  pricing: modelPricingSchema,
});
export type PublicModel = z.infer<typeof publicModelSchema>;

export const publicModelCatalogSchema = z.object({
  version: z.string().min(1),
  capabilityVersion: z.string().min(1),
  pricingVersion: z.string().min(1),
  fetchedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  quoteAvailable: z.boolean(),
  models: z.array(publicModelSchema),
});
export type PublicModelCatalog = z.infer<typeof publicModelCatalogSchema>;

export const generationQuoteRequestSchema = z.object({
  modelId: z.string().min(1),
  modality: modelModalitySchema,
  parameters: z.record(z.string(), z.unknown()).default({}),
  inputs: z
    .object({
      images: z.number().int().nonnegative().default(0),
      styleImages: z.number().int().nonnegative().default(0),
      elementImages: z.number().int().nonnegative().default(0),
      videos: z.number().int().nonnegative().default(0),
      audios: z.number().int().nonnegative().default(0),
    })
    .default({ images: 0, styleImages: 0, elementImages: 0, videos: 0, audios: 0 }),
  quantity: z.number().int().min(1).max(8).default(1),
  inputTokens: z.number().int().nonnegative().optional(),
  maxOutputTokens: z.number().int().nonnegative().optional(),
});
type ParsedGenerationQuoteRequest = z.infer<typeof generationQuoteRequestSchema>;
type GenerationQuoteInputs = Omit<
  ParsedGenerationQuoteRequest["inputs"],
  "styleImages" | "elementImages"
> &
  Partial<Pick<ParsedGenerationQuoteRequest["inputs"], "styleImages" | "elementImages">>;
export type GenerationQuoteRequest = Omit<ParsedGenerationQuoteRequest, "inputs"> & {
  inputs: GenerationQuoteInputs;
};

export const generationQuoteSchema = z.object({
  id: z.string().min(1),
  modelId: z.string().min(1),
  modelLabel: z.string().min(1),
  modality: modelModalitySchema,
  quantity: z.number().int().positive(),
  // Total media artifacts represented by this quote. This is distinct from
  // quantity, which is the number of provider submissions/calls.
  outputCount: z.number().int().positive().optional(),
  normalizedParameters: z.record(z.string(), z.unknown()),
  creditMicros: z.number().int().nonnegative(),
  credits: z.string().regex(/^\d+(?:\.\d{1,6})?$/),
  yuanMicros: z.number().int().nonnegative(),
  yuan: z.string().regex(/^\d+(?:\.\d{1,6})?$/),
  estimated: z.boolean(),
  pricingUnit: modelPricingSchema.shape.unit,
  catalogVersion: z.string().min(1),
  capabilityVersion: z.string().min(1),
  pricingVersion: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
});
export type GenerationQuote = z.infer<typeof generationQuoteSchema>;

export const apiErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  }),
});

export const modelCatalogResponseSchema = z.object({
  ok: z.literal(true),
  data: publicModelCatalogSchema,
});

export const generationQuoteResponseSchema = z.object({
  ok: z.literal(true),
  data: generationQuoteSchema,
});
