import { z } from "zod";

export const mediaKindSchema = z.enum(["image", "video", "audio"]);
export type MediaKind = z.infer<typeof mediaKindSchema>;

export const mediaStatusSchema = z.enum(["pending", "uploading", "ready", "failed"]);
export type MediaStatus = z.infer<typeof mediaStatusSchema>;

export const mediaProjectIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const mediaUploadRequestSchema = z
  .object({
    kind: mediaKindSchema,
    name: z.string().trim().min(1).max(255),
    mimeType: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/),
    size: z.number().int().positive(),
    sha256: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    idempotencyKey: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    projectId: mediaProjectIdSchema.optional(),
  })
  .strict();
export type MediaUploadRequest = z.infer<typeof mediaUploadRequestSchema>;

export const publicMediaErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

export const publicMediaSchema = z.object({
  id: z.string().uuid(),
  kind: mediaKindSchema,
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  durationMs: z.number().int().positive().nullable(),
  status: mediaStatusSchema,
  error: publicMediaErrorSchema.nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type PublicMedia = z.infer<typeof publicMediaSchema>;

export const MEDIA_MULTIPART_PART_SIZE = 8 * 1024 * 1024;
export const MEDIA_MULTIPART_THRESHOLD = 32 * 1024 * 1024;
export const MEDIA_MULTIPART_MAX_PARTS = 10_000;
export const MEDIA_MULTIPART_MAX_SIGNED_PARTS = 16;

export const mediaSingleUploadInstructionSchema = z.object({
  strategy: z.literal("single").optional(),
  method: z.literal("PUT"),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.string().datetime({ offset: true }),
  completeUrl: z.string().min(1).nullable(),
});
export type MediaSingleUploadInstruction = z.infer<typeof mediaSingleUploadInstructionSchema>;

export const mediaMultipartUploadInstructionSchema = z.object({
  strategy: z.literal("multipart"),
  sessionId: z.string().uuid(),
  partSize: z.literal(MEDIA_MULTIPART_PART_SIZE),
  partCount: z.number().int().min(1).max(MEDIA_MULTIPART_MAX_PARTS),
  expiresAt: z.string().datetime({ offset: true }),
  signPartsUrl: z.string().min(1),
  reconcileUrl: z.string().min(1),
  completeUrl: z.string().min(1),
  abortUrl: z.string().min(1),
});
export type MediaMultipartUploadInstruction = z.infer<typeof mediaMultipartUploadInstructionSchema>;

export const mediaUploadInstructionSchema = z.union([
  mediaSingleUploadInstructionSchema,
  mediaMultipartUploadInstructionSchema,
]);
export type MediaUploadInstruction = z.infer<typeof mediaUploadInstructionSchema>;

const multipartPartNumberSchema = z.number().int().min(1).max(MEDIA_MULTIPART_MAX_PARTS);

export const mediaMultipartPartSignRequestSchema = z
  .object({
    partNumbers: z
      .array(multipartPartNumberSchema)
      .min(1)
      .max(MEDIA_MULTIPART_MAX_SIGNED_PARTS)
      .refine((values) => new Set(values).size === values.length, "Part numbers must be unique"),
  })
  .strict();
export type MediaMultipartPartSignRequest = z.infer<typeof mediaMultipartPartSignRequestSchema>;

export const mediaMultipartPartInstructionSchema = z.object({
  partNumber: multipartPartNumberSchema,
  method: z.literal("PUT"),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.string().datetime({ offset: true }),
});
export type MediaMultipartPartInstruction = z.infer<typeof mediaMultipartPartInstructionSchema>;

export const mediaMultipartPartInstructionsResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    sessionId: z.string().uuid(),
    parts: z
      .array(mediaMultipartPartInstructionSchema)
      .min(1)
      .max(MEDIA_MULTIPART_MAX_SIGNED_PARTS)
      .refine(
        (parts) =>
          parts.every(
            (part, index) => index === 0 || part.partNumber > parts[index - 1]!.partNumber,
          ),
        "Signed parts must be unique and sorted",
      ),
  }),
});

export const mediaMultipartUploadPhaseSchema = z.enum([
  "uploading",
  "assembling",
  "inspecting",
  "ready",
  "failed",
  "aborted",
]);
export type MediaMultipartUploadPhase = z.infer<typeof mediaMultipartUploadPhaseSchema>;

export const mediaMultipartUploadedPartSchema = z.object({
  partNumber: multipartPartNumberSchema,
  size: z.number().int().positive().max(MEDIA_MULTIPART_PART_SIZE),
});
export type MediaMultipartUploadedPart = z.infer<typeof mediaMultipartUploadedPartSchema>;

export const mediaMultipartUploadStateSchema = z.object({
  sessionId: z.string().uuid(),
  phase: mediaMultipartUploadPhaseSchema,
  partSize: z.literal(MEDIA_MULTIPART_PART_SIZE),
  partCount: z.number().int().min(1).max(MEDIA_MULTIPART_MAX_PARTS),
  uploadedParts: z
    .array(mediaMultipartUploadedPartSchema)
    .max(MEDIA_MULTIPART_MAX_PARTS)
    .refine(
      (parts) =>
        parts.every((part, index) => index === 0 || part.partNumber > parts[index - 1]!.partNumber),
      "Uploaded parts must be unique and sorted",
    ),
  expiresAt: z.string().datetime({ offset: true }),
  media: publicMediaSchema,
});
export type MediaMultipartUploadState = z.infer<typeof mediaMultipartUploadStateSchema>;

export const mediaMultipartUploadStateResponseSchema = z.object({
  ok: z.literal(true),
  data: mediaMultipartUploadStateSchema,
});

export const mediaMultipartCompleteRequestSchema = z.object({}).strict();
export const mediaMultipartCompleteResponseSchema = mediaMultipartUploadStateResponseSchema;
export const mediaMultipartAbortRequestSchema = z.object({}).strict();
export const mediaMultipartAbortResponseSchema = mediaMultipartUploadStateResponseSchema;

export const mediaUploadIntentSchema = z.object({
  media: publicMediaSchema,
  upload: mediaUploadInstructionSchema.nullable(),
});
export type MediaUploadIntent = z.infer<typeof mediaUploadIntentSchema>;

export const mediaUploadIntentResponseSchema = z.object({
  ok: z.literal(true),
  data: mediaUploadIntentSchema,
});

export const mediaResponseSchema = z.object({
  ok: z.literal(true),
  data: publicMediaSchema,
});

export const providerMediaReferenceRequestSchema = z
  .object({
    kind: mediaKindSchema,
    projectId: mediaProjectIdSchema.optional(),
  })
  .strict();
export type ProviderMediaReferenceRequest = z.infer<typeof providerMediaReferenceRequestSchema>;

export const providerMediaReferenceResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    url: z.string().url().max(4096),
  }),
});

/**
 * 云端资源清理：列出账号下全部服务端素材及其项目绑定关系，供用户自选删除。
 * 「可清理」（orphaned：曾有云项目意图、现已无任何绑定）可直接删除；
 * 「使用中」（从未绑定过云项目，可能是本地画布的唯一副本）需用户在面板里
 * 显式确认（forceUnbound）才会删除，删除前浏览器会先把文件缓存到本地素材库；
 * 「已被引用」（仍被某个云项目绑定）不可删除，需先删项目或在画布里去掉引用。
 */
/** 服务端素材主键：DB 为 TEXT，历史上可能有非 UUID 的旧 id，这里只做长度约束。 */
export const cloudResourceIdSchema = z.string().trim().min(1).max(128);

export const cloudResourceSchema = z
  .object({
    id: cloudResourceIdSchema,
    kind: mediaKindSchema,
    name: z.string().min(1).max(255),
    mimeType: z.string().min(1),
    size: z.number().int().nonnegative(),
    status: mediaStatusSchema,
    source: z.enum(["upload", "generation"]),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    durationMs: z.number().int().positive().nullable(),
    projectIds: z.array(mediaProjectIdSchema).max(200),
    /**
     * “可清理”的遗留素材：上传时带过云项目意图（曾被绑定），但当前已无任何
     * 绑定——项目删除会级联解绑，画布保存时也会把不再被文档引用的绑定收敛掉。
     * 未被任何云项目绑定过、由本地画布/工作台直接上传的素材（projectIds 为空且
     * orphaned=false）可能是用户唯一副本，面板显示「使用中」，仅在显式确认后删。
     */
    orphaned: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type CloudResource = z.infer<typeof cloudResourceSchema>;

export const cloudResourceUsageSchema = z
  .object({
    usedBytes: z.number().int().nonnegative(),
    quotaBytes: z.number().int().nonnegative(),
    boundBytes: z.number().int().nonnegative(),
    orphanBytes: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
    orphanCount: z.number().int().nonnegative(),
  })
  .strict();
export type CloudResourceUsage = z.infer<typeof cloudResourceUsageSchema>;

export const cloudResourceListResponseSchema = z.object({
  ok: z.literal(true),
  data: z
    .object({
      items: z.array(cloudResourceSchema),
      usage: cloudResourceUsageSchema,
    })
    .strict(),
});

export const cloudResourceCleanupRequestSchema = z
  .object({
    mediaIds: z.array(cloudResourceIdSchema).min(1).max(500),
    /**
     * 显式确认删除「使用中」素材（未绑定云项目、服务器无法确认本地画布是否
     * 还在引用）。前端只有在用户二次确认并先把文件缓存到本地后才置 true；
     * 不带此标志的请求保持旧行为：只删 orphaned，active 一律 skipped。
     * 无论与否，仍被云项目绑定的素材永远不删。
     */
    forceUnbound: z.boolean().optional(),
  })
  .strict();
export type CloudResourceCleanupRequest = z.infer<typeof cloudResourceCleanupRequestSchema>;

export const cloudResourceCleanupSkippedReasonSchema = z.enum(["referenced", "active", "missing"]);

export const cloudResourceCleanupResponseSchema = z.object({
  ok: z.literal(true),
  data: z
    .object({
      deleted: z.array(cloudResourceSchema),
      skipped: z.array(
        z
          .object({
            id: z.string(),
            reason: cloudResourceCleanupSkippedReasonSchema,
          })
          .strict(),
      ),
      freedBytes: z.number().int().nonnegative(),
      usage: cloudResourceUsageSchema,
    })
    .strict(),
});
