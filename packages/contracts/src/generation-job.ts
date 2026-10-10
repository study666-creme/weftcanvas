import { z } from "zod";

import { generationQuoteSchema, modelModalitySchema } from "./model-catalog.js";

export const GENERATION_JOB_SCHEMA_VERSION = 1 as const;

/**
 * The exact bounded public identity used to resolve a durable generation
 * request after a reload. It matches the submission idempotency-key grammar so
 * a persisted pending request can be looked up without scanning a capped list.
 */
export const generationJobIdempotencyKeySchema = z.string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
export type GenerationJobIdempotencyKey = z.infer<typeof generationJobIdempotencyKeySchema>;

export const generationJobStatuses = [
  "reserved",
  "submitting",
  "queued",
  "running",
  "validating",
  "submission_unknown",
  "completed",
  "failed",
] as const;
export const generationJobStatusSchema = z.enum(generationJobStatuses);
export type GenerationJobStatus = z.infer<typeof generationJobStatusSchema>;

export const generationJobInputSchema = z.object({
  images: z.array(z.string().min(1)).max(32).default([]),
  styleImages: z.array(z.string().min(1)).max(32).default([]),
  elementImages: z.array(z.string().min(1)).max(32).default([]),
  videos: z.array(z.string().min(1)).max(10).default([]),
  audios: z.array(z.string().min(1)).max(10).default([]),
});
type ParsedGenerationJobInput = z.infer<typeof generationJobInputSchema>;
export type GenerationJobInput = Omit<ParsedGenerationJobInput, "styleImages" | "elementImages">
  & Partial<Pick<ParsedGenerationJobInput, "styleImages" | "elementImages">>;

export const expectedGenerationQuoteSchema = generationQuoteSchema.pick({
  id: true,
  modelId: true,
  creditMicros: true,
  pricingVersion: true,
  expiresAt: true,
});
export type ExpectedGenerationQuote = z.infer<typeof expectedGenerationQuoteSchema>;

export const generationJobSubmissionSchema = z.object({
  projectId: z.string().min(1).max(128),
  nodeId: z.string().min(1).max(128),
  modelId: z.string().min(1).max(128),
  modality: modelModalitySchema,
  parameters: z.record(z.string(), z.unknown()).default({}),
  inputs: generationJobInputSchema.default({ images: [], styleImages: [], elementImages: [], videos: [], audios: [] }),
  quantity: z.number().int().min(1).max(8).default(1),
  inputTokens: z.number().int().nonnegative().optional(),
  maxOutputTokens: z.number().int().nonnegative().optional(),
  expectedQuote: expectedGenerationQuoteSchema,
  idempotencyKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
});
type ParsedGenerationJobSubmission = z.infer<typeof generationJobSubmissionSchema>;
export type GenerationJobSubmission = Omit<ParsedGenerationJobSubmission, "inputs">
  & { inputs: GenerationJobInput };

const generationArtifactBaseSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
});

export const generationTextArtifactSchema = generationArtifactBaseSchema.extend({
  kind: z.literal("text"),
  text: z.string().min(1),
});

export const generationMediaArtifactSchema = generationArtifactBaseSchema.extend({
  kind: z.enum(["image", "video", "audio"]),
  mediaId: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  duration: z.number().positive().optional(),
});

export const generationArtifactSchema = z.discriminatedUnion("kind", [
  generationTextArtifactSchema,
  generationMediaArtifactSchema,
]);
export type GenerationArtifact = z.infer<typeof generationArtifactSchema>;

export const generationJobErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
});
export type GenerationJobError = z.infer<typeof generationJobErrorSchema>;

/**
 * 结算回执。托管生成里积分权威方是 Prompt Hub：报价只是预估，真正扣多少由
 * 上游在任务结束后回报（视频按整单预扣，「按实际用量结算」的差额也由上游
 * 决定），所以画布只如实转述上游回报的实扣与退款状态，绝不拿报价冒充实扣。
 */
export const generationJobBillingSchema = z.object({
  chargedCreditMicros: z.number().int().nonnegative(),
  refunded: z.boolean(),
});
export type GenerationJobBilling = z.infer<typeof generationJobBillingSchema>;

export const publicGenerationJobSchema = z.object({
  schemaVersion: z.literal(GENERATION_JOB_SCHEMA_VERSION),
  version: z.number().int().nonnegative(),
  id: z.string().min(1),
  projectId: z.string().min(1),
  nodeId: z.string().min(1),
  modelId: z.string().min(1),
  modelLabel: z.string().min(1),
  modality: modelModalitySchema,
  status: generationJobStatusSchema,
  progress: z.number().int().min(0).max(100),
  quote: generationQuoteSchema,
  artifacts: z.array(generationArtifactSchema),
  error: generationJobErrorSchema.nullable(),
  billing: generationJobBillingSchema.optional(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  completedAt: z.string().datetime({ offset: true }).nullable(),
  // Diagnostics: the exact request body the canvas submitted. Surfacing this
  // lets users and us see why a job failed (e.g. a dropped reference image)
  // without digging through provider logs.
  parameters: z.record(z.string(), z.unknown()).optional(),
  inputs: generationJobInputSchema.optional(),
});
export type PublicGenerationJob = z.infer<typeof publicGenerationJobSchema>;

export const generationJobResponseSchema = z.object({
  ok: z.literal(true),
  data: publicGenerationJobSchema,
});

/**
 * Query contract for the read-only reconciliation lookup: one bounded
 * idempotency identity, no other input. The endpoint resolves the single
 * durable request for that identity and never submits, retries, replays, or
 * mutates a job or contacts a provider.
 */
export const generationJobReconcileQuerySchema = z.object({
  key: generationJobIdempotencyKeySchema,
});

export const generationJobListResponseSchema = z.object({
  ok: z.literal(true),
  data: z.array(publicGenerationJobSchema),
});

export const generationJobEventSchema = z.object({
  type: z.literal("job"),
  job: publicGenerationJobSchema,
});
export type GenerationJobEvent = z.infer<typeof generationJobEventSchema>;
