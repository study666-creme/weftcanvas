import { z } from "zod";

import { AUDIO_PROTOCOL_VERSION, audioOutputFormatSchema } from "./audio-protocol.js";
import {
  IMAGE_PROTOCOL_VERSION,
  imageMediaRoleSchema,
  imageProtocolResponseSchema,
} from "./image-protocol.js";
import { VIDEO_PROTOCOL_VERSION, videoMediaRoleSchema } from "./video-protocol.js";

const customApiParameterValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const customApiFormatSchema = z.enum(["openai", "gemini"]);
export type CustomApiFormat = z.infer<typeof customApiFormatSchema>;

const customApiAggregateConstraintSchema = z
  .object({
    fields: z.array(z.string().min(1)).min(1),
    max_total_items: z.number().int().nonnegative(),
  })
  .passthrough();

const customApiCamelAggregateConstraintSchema = z
  .object({
    fields: z.array(z.string().min(1)).min(1),
    maxTotalItems: z.number().int().nonnegative(),
  })
  .passthrough();

export const customApiCatalogParameterSchema = z
  .object({
    name: z.string().min(1),
    path: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    type: z.enum(["string", "integer", "number", "boolean", "array", "object"]),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
    fixed: z.unknown().optional(),
    options: z.array(customApiParameterValueSchema).optional(),
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
    aggregate_constraint: customApiAggregateConstraintSchema.optional(),
    aggregateConstraint: customApiCamelAggregateConstraintSchema.optional(),
    mutually_exclusive_with: z.array(z.string()).optional(),
  })
  .passthrough();

const customApiInputCountSchema = z
  .object({
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().nonnegative().optional(),
    multiple: z.boolean().optional(),
  })
  .passthrough();

const customApiReferenceImageInputSchema = customApiInputCountSchema.extend({
  role: z.string().min(1).optional(),
});

const customApiReferenceMediaSchema = z
  .object({
    images: customApiReferenceImageInputSchema.optional(),
    style_images: customApiInputCountSchema.optional(),
    element_images: customApiInputCountSchema.optional(),
    videos: customApiInputCountSchema.optional(),
    audios: customApiInputCountSchema.optional(),
    max_total_items: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const customApiVideoProtocolSchema = z
  .object({
    version: z.literal(VIDEO_PROTOCOL_VERSION),
    endpoint: z
      .object({
        method: z.literal("POST"),
        // BYOK 目录可声明非标准的视频提交路径（协议档案 P0 允许用户覆盖）；
        // 服务端托管执行仍由 model-catalog 的私有路由 schema 决定，不受此处放宽影响。
        path: z.string().min(1),
      })
      .passthrough(),
    media_roles: z.array(videoMediaRoleSchema),
  })
  .passthrough();

const customApiImageProtocolSchema = z
  .object({
    version: z.literal(IMAGE_PROTOCOL_VERSION),
    endpoint: z
      .object({
        method: z.literal("POST"),
        // 同上：BYOK 侧不再把图像端点锁在三条内置路径上。
        path: z.string().min(1),
      })
      .passthrough(),
    media_roles: z.array(imageMediaRoleSchema),
  })
  .passthrough();

const customApiAudioProtocolSchema = z
  .object({
    version: z.literal(AUDIO_PROTOCOL_VERSION),
    output_format: audioOutputFormatSchema,
  })
  .passthrough();

export const customApiCatalogModelSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1).optional(),
    description: z.string().nullish(),
    modality: z.enum(["text", "image", "video", "audio"]),
    operation: z.string().min(1),
    protocol: z
      .union([
        customApiVideoProtocolSchema,
        customApiImageProtocolSchema,
        customApiAudioProtocolSchema,
      ])
      .optional(),
    order: z.number().finite().min(-1_000_000).max(1_000_000).optional(),
    endpoint: z
      .object({
        method: z.literal("POST"),
        path: z.string().min(1),
        content_type: z.literal("application/json"),
      })
      .passthrough(),
    input: z
      .object({
        text: z.object({ required: z.boolean().optional() }).passthrough().optional(),
        images: customApiInputCountSchema.optional(),
        videos: customApiInputCountSchema.optional(),
        audios: customApiInputCountSchema.optional(),
        reference_media: customApiReferenceMediaSchema.optional(),
      })
      .passthrough()
      .optional(),
    output: z
      .object({
        type: z.enum(["text", "image", "video", "audio"]),
        count: z
          .object({
            fixed: z.number().int().positive().optional(),
            min: z.number().int().positive().optional(),
            max: z.number().int().positive().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
    parameters: z.array(customApiCatalogParameterSchema).default([]),
    public: z
      .object({
        id: z.string().min(1),
        label: z.string().min(1),
        description: z.string().nullish(),
      })
      .optional(),
    selectable: z.boolean().optional(),
    pricing: z.unknown().optional(),
  })
  .passthrough();

export const customApiCatalogSchema = z
  .object({
    success: z.literal(true),
    version: z.string().min(1),
    capability_version: z.string().min(1),
    pricing_version: z.string().optional().default(""),
    api_format: customApiFormatSchema.optional(),
    fetched_at: z.string().datetime({ offset: true }),
    models: z.array(customApiCatalogModelSchema),
  })
  .passthrough();

export type CustomApiCatalogSource = z.infer<typeof customApiCatalogSchema>;
export type CustomApiCatalogModelSource = z.infer<typeof customApiCatalogModelSchema>;
export type CustomApiCatalogParameterSource = z.infer<typeof customApiCatalogParameterSchema>;

export const customApiTextResponseSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            message: z.object({ content: z.unknown() }).passthrough(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

const customApiLegacyImageResponseSchema = z
  .object({
    data: z
      .array(
        z
          .object({
            url: z.string().optional(),
            b64_json: z.string().optional(),
          })
          .passthrough(),
      )
      .min(1)
      .max(8),
  })
  .passthrough();
export const customApiImageResponseSchema = z.union([
  customApiLegacyImageResponseSchema,
  imageProtocolResponseSchema,
]);

export const customApiVideoResponseSchema = z
  .object({
    id: z.string().min(1).optional(),
    task_id: z.string().min(1).optional(),
    status: z.string().optional(),
    progress: z.number().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();
