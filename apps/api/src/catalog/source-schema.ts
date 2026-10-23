import { z } from "zod";

const sourceParameterValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const sourceAggregateConstraintSchema = z
  .object({
    fields: z.array(z.string().min(1)).min(1),
    max_total_items: z.number().int().nonnegative(),
  })
  .passthrough();

const sourceCamelAggregateConstraintSchema = z
  .object({
    fields: z.array(z.string().min(1)).min(1),
    maxTotalItems: z.number().int().nonnegative(),
  })
  .passthrough();

const sourceParameterSchema = z
  .object({
    name: z.string().min(1),
    path: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    type: z.enum(["string", "integer", "number", "boolean", "array", "object"]),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
    fixed: z.unknown().optional(),
    options: z.array(sourceParameterValueSchema).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().positive().optional(),
    min_length: z.number().int().nonnegative().optional(),
    max_length: z.number().int().positive().optional(),
    min_items: z.number().int().nonnegative().optional(),
    max_items: z.number().int().nonnegative().optional(),
    format: z.string().optional(),
    items: z
      .object({
        type: z.enum(["string", "integer", "number", "boolean", "array", "object"]),
        format: z.string().optional(),
      })
      .passthrough()
      .optional(),
    aggregate_constraint: sourceAggregateConstraintSchema.optional(),
    aggregateConstraint: sourceCamelAggregateConstraintSchema.optional(),
    mutually_exclusive_with: z.array(z.string()).optional(),
  })
  .passthrough();

const sourceCountSchema = z
  .object({
    fixed: z.number().int().positive().optional(),
    min: z.number().int().positive().optional(),
    max: z.number().int().positive().optional(),
  })
  .passthrough();

const sourceInputKindSchema = z
  .object({
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().nonnegative().optional(),
    multiple: z.boolean().optional(),
  })
  .passthrough();

const sourceReferenceImageKindSchema = sourceInputKindSchema
  .extend({
    role: z.string().min(1).optional(),
  })
  .passthrough();

const sourceReferenceMediaSchema = z
  .object({
    images: sourceReferenceImageKindSchema.optional(),
    style_images: sourceInputKindSchema.optional(),
    element_images: sourceInputKindSchema.optional(),
    videos: sourceInputKindSchema.optional(),
    audios: sourceInputKindSchema.optional(),
    max_total_items: z.number().int().nonnegative().optional(),
  })
  .passthrough();

/**
 * Source catalogs historically represented pricing tiers as a condition plus
 * a fixed request price.  Token catalogs now use named tiers containing
 * per-million input/output prices instead.  Keep both shapes at the source
 * boundary; normalization converts them to the smaller public contract.
 */
const sourcePricingTierSchema = z.union([
  z
    .object({
      when: z.record(z.string(), sourceParameterValueSchema),
      yuan: z.number().nonnegative(),
      credits: z.number().nonnegative(),
    })
    .passthrough(),
  z
    .object({
      name: z.string().min(1),
      input_credits_per_million: z.number().nonnegative().optional(),
      output_credits_per_million: z.number().nonnegative().optional(),
      cache_credits_per_million: z.number().nonnegative().optional(),
      input_yuan_per_million: z.number().nonnegative().optional(),
      output_yuan_per_million: z.number().nonnegative().optional(),
      cache_yuan_per_million: z.number().nonnegative().optional(),
    })
    .passthrough(),
]);

// A catalog may carry several billing groups. The selected top-level group
// can be an internal zero-price entitlement, while hosted accounts still use
// one of the explicit paid groups for the same model. Keep the group fields at
// the source boundary so normalization can choose a billable public price.
const sourcePricingGroupSchema = z
  .object({
    id: z.string().min(1),
    yuan: z.number().nonnegative().optional(),
    credits: z.number().nonnegative().optional(),
    tiers: z.array(sourcePricingTierSchema).optional(),
    input_credits_per_million: z.number().nonnegative().optional(),
    output_credits_per_million: z.number().nonnegative().optional(),
    input_yuan_per_million: z.number().nonnegative().optional(),
    output_yuan_per_million: z.number().nonnegative().optional(),
  })
  .passthrough();

const sourcePricingSchema = z
  .object({
    mode: z.enum(["fixed", "tiered", "token", "tiered_token"]),
    unit: z.enum(["request", "image", "second", "token"]),
    currency: z.literal("CNY"),
    credits_per_yuan: z.number().positive().optional(),
    yuan: z.number().nonnegative().optional(),
    credits: z.number().nonnegative().optional(),
    tiers: z.array(sourcePricingTierSchema).optional(),
    input_credits_per_million: z.number().nonnegative().optional(),
    output_credits_per_million: z.number().nonnegative().optional(),
    input_yuan_per_million: z.number().nonnegative().optional(),
    output_yuan_per_million: z.number().nonnegative().optional(),
    group: z.string().min(1).optional(),
    groups: z.array(sourcePricingGroupSchema).optional(),
    estimated_yuan_per_second: z.number().nonnegative().optional(),
    estimate_note: z.string().min(1).optional(),
    /**
     * 参考素材单独计费的费率。站点此前只在描述里写这些规则，画布只能按描述猜
     * （H3 系列的「同价加收」被套到了所有发布参考视频时长的模型上）；目录发布
     * 这些字段后，报价按字段走，缺省才回落到描述口径。
     */
    reference_video_yuan_per_second: z.number().nonnegative().optional(),
    reference_video_credits_per_second: z.number().nonnegative().optional(),
    reference_image_free_count: z.number().int().nonnegative().optional(),
    reference_image_overage_yuan: z.number().nonnegative().optional(),
  })
  .passthrough();

const sourceEndpointSchema = z
  .object({
    method: z.literal("POST"),
    path: z.string().min(1),
    content_type: z.literal("application/json"),
  })
  .passthrough();

const sourceVideoProtocolSchema = z
  .object({
    version: z.literal("video.v1"),
    endpoint: z
      .object({
        method: z.literal("POST"),
        path: z.literal("/v1/videos"),
      })
      .passthrough(),
    media_roles: z.array(
      z.enum([
        "reference",
        "first_frame",
        "last_frame",
        "source_video",
        "audio_reference",
        "style_reference",
        "element_reference",
      ]),
    ),
  })
  .passthrough();

const sourceImageProtocolSchema = z
  .object({
    version: z.literal("image.v1"),
    endpoint: z
      .object({
        method: z.literal("POST"),
        path: z.enum([
          "/v1/images/generations",
          "/v1/chat/completions",
          "/v1/midjourney/generations",
        ]),
      })
      .passthrough(),
    media_roles: z.array(z.enum(["reference", "style_reference", "element_reference", "mask"])),
  })
  .passthrough();

export const sourceCatalogModelSchema = z
  .object({
    id: z.string().min(1),
    modality: z.enum(["text", "image", "video", "audio"]),
    operation: z.string().min(1),
    protocol: z.union([sourceVideoProtocolSchema, sourceImageProtocolSchema]).optional(),
    order: z.number().finite().min(-1_000_000).max(1_000_000).optional(),
    input: z
      .object({
        text: z.object({ required: z.boolean().optional() }).passthrough().optional(),
        images: sourceInputKindSchema.optional(),
        videos: sourceInputKindSchema.optional(),
        audios: sourceInputKindSchema.optional(),
        reference_media: sourceReferenceMediaSchema.optional(),
      })
      .passthrough()
      .optional(),
    output: z
      .object({
        type: z.enum(["text", "image", "video", "audio"]),
        /** 交付形态：url（有时效链接）或 inline-data（响应体内联 base64）。 */
        format: z.string().optional(),
        /** 内联 PCM 的采样规格（Gemini TTS 实测 audio/l16 24kHz 单声道）。 */
        encoding: z.string().optional(),
        sample_rate_hz: z.number().int().positive().max(192_000).optional(),
        channels: z.number().int().positive().max(8).optional(),
        count: sourceCountSchema.optional(),
      })
      .passthrough(),
    parameters: z.array(sourceParameterSchema).default([]),
    endpoint: sourceEndpointSchema.optional(),
    public: z
      .object({
        id: z.string().min(1),
        label: z.string().min(1),
        description: z.string().nullable().optional(),
      })
      .optional(),
    selectable: z.boolean().optional(),
    /**
     * 上游目录给每个模型打的标签串（逗号分隔）。`per-request` 表示站点除了按量
     * 费率外还发布了按次零售价——按次入口据此准入，因为 `mode` 无法区分
     * 「只能按量」和「既可按量、也发布了按次价」（Gemini 全系是后者）。
     */
    tags: z.string().optional(),
    pricing: sourcePricingSchema,
  })
  .passthrough();

export const sourceCatalogSchema = z
  .object({
    success: z.literal(true),
    version: z.string().min(1),
    capability_version: z.string().min(1),
    pricing_version: z.string().optional().default(""),
    fetched_at: z.string().datetime({ offset: true }),
    credits_per_yuan: z.number().positive(),
    models: z.array(sourceCatalogModelSchema),
  })
  .passthrough();

export type SourceCatalog = z.infer<typeof sourceCatalogSchema>;
export type SourceCatalogModel = z.infer<typeof sourceCatalogModelSchema>;
