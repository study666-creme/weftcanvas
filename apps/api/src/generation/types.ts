import {
  generationArtifactSchema,
  generationJobErrorSchema,
  generationJobInputSchema,
  generationJobStatusSchema,
  generationQuoteSchema,
  modelPricingSchema,
  modelModalitySchema,
  publicGenerationJobSchema,
  type GenerationArtifact,
  type GenerationJobInput,
  type ModelModality,
  type PublicGenerationJob,
} from "@weftcanvas/contracts";
import { z } from "zod";

import { privateModelRouteSchema, type PrivateModelRoute } from "../catalog/execution-route.js";

export const generationJobRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  ownerId: z.string().min(1),
  idempotencyKey: z.string().min(8).max(128),
  projectId: z.string().min(1),
  nodeId: z.string().min(1),
  modelId: z.string().min(1),
  modelLabel: z.string().min(1),
  modality: modelModalitySchema,
  parameters: z.record(z.string(), z.unknown()),
  inputs: generationJobInputSchema,
  quantity: z.number().int().min(1).max(8),
  inputTokens: z.number().int().nonnegative().nullable(),
  maxOutputTokens: z.number().int().nonnegative().nullable(),
  status: generationJobStatusSchema,
  progress: z.number().int().min(0).max(100),
  quote: generationQuoteSchema,
  pricing: modelPricingSchema,
  executionRoute: privateModelRouteSchema,
  reservationId: z.string().min(1),
  providerTaskId: z.string().min(1).nullable(),
  providerResultRef: z.string().min(1).nullable(),
  artifacts: z.array(generationArtifactSchema),
  error: generationJobErrorSchema.nullable(),
  revision: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  completedAt: z.string().datetime({ offset: true }).nullable(),
});
export type GenerationJobRecord = z.infer<typeof generationJobRecordSchema>;

export type CreateReservedJobResult =
  | { kind: "created"; job: GenerationJobRecord }
  | { kind: "existing"; job: GenerationJobRecord }
  | { kind: "active_limit" }
  | { kind: "insufficient_credits" };

export interface GenerationJobStore {
  findByIdempotency(ownerId: string, idempotencyKey: string): Promise<GenerationJobRecord | null>;
  getById(jobId: string): Promise<GenerationJobRecord | null>;
  createWithReservation(
    job: GenerationJobRecord,
    creditMicros: number,
    options: { maxActiveJobs: number },
  ): Promise<CreateReservedJobResult>;
  listByOwner(
    ownerId: string,
    options: { projectId?: string; limit: number },
  ): Promise<GenerationJobRecord[]>;
  save(job: GenerationJobRecord, expectedRevision: number): Promise<GenerationJobRecord | null>;
  completeWithCapture(
    job: GenerationJobRecord,
    expectedRevision: number,
    creditMicros: number,
  ): Promise<GenerationJobRecord | null>;
  failWithRelease(
    job: GenerationJobRecord,
    expectedRevision: number,
  ): Promise<GenerationJobRecord | null>;
}

export type ProviderExecutionState =
  | { kind: "queued"; taskId: string; progress?: number }
  | { kind: "running"; taskId: string; progress?: number }
  | { kind: "output"; resultRef: string; taskId?: string }
  | { kind: "failed"; code: string; message: string; retryable?: boolean };

export type ProviderGenerationRequest = {
  jobId: string;
  ownerId: string;
  projectId: string;
  modelId: string;
  modality: ModelModality;
  parameters: Record<string, unknown>;
  inputs: GenerationJobInput;
  quantity: number;
  executionRoute: PrivateModelRoute;
};

export interface GenerationProvider {
  submit(request: ProviderGenerationRequest): Promise<ProviderExecutionState>;
  poll(taskId: string, request: ProviderGenerationRequest): Promise<ProviderExecutionState>;
}

export type PersistedGenerationResult = {
  artifacts: GenerationArtifact[];
  captureCreditMicros?: number;
};

export interface GenerationArtifactStore {
  persist(job: GenerationJobRecord, resultRef: string): Promise<PersistedGenerationResult>;
  cleanup?(resultRef: string): Promise<void>;
}

export type ProviderErrorOutcome = "rejected" | "unknown" | "transient";

export class GenerationProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly outcome: ProviderErrorOutcome,
  ) {
    super(message);
    this.name = "GenerationProviderError";
  }
}

export class GenerationArtifactError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GenerationArtifactError";
  }
}

export function toPublicGenerationJob(job: GenerationJobRecord): PublicGenerationJob {
  return publicGenerationJobSchema.parse({ ...job, version: job.revision });
}
