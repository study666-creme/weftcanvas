import { describe, expect, it } from "vitest";

import {
  generationJobIdempotencyKeySchema,
  generationJobReconcileQuerySchema,
  generationJobSubmissionSchema,
  publicGenerationJobSchema,
} from "./generation-job";

const quote = {
  id: "quote-1",
  modelId: "image2",
  modelLabel: "全能模型2",
  modality: "image",
  quantity: 1,
  normalizedParameters: { prompt: "雨夜街道" },
  creditMicros: 5_500_000,
  credits: "5.5",
  yuanMicros: 55_000,
  yuan: "0.055",
  estimated: false,
  pricingUnit: "image",
  catalogVersion: "catalog-1",
  capabilityVersion: "capability-1",
  pricingVersion: "pricing-1",
  expiresAt: "2026-07-15T10:02:00.000Z",
};

describe("generation job contracts", () => {
  it("normalizes submission inputs and requires a bounded idempotency key", () => {
    const submission = generationJobSubmissionSchema.parse({
      projectId: "project-1",
      nodeId: "node-1",
      modelId: "image2",
      modality: "image",
      expectedQuote: quote,
      idempotencyKey: "request-0001",
    });

    expect(submission).toMatchObject({
      parameters: {},
      inputs: { images: [], videos: [], audios: [] },
      quantity: 1,
    });
    expect(() =>
      generationJobSubmissionSchema.parse({ ...submission, idempotencyKey: "bad key" }),
    ).toThrow();
  });

  it("accepts the live ten-item video and audio reference limits", () => {
    const media = Array.from({ length: 10 }, (_, index) => `media-${index}`);
    const submission = {
      projectId: "project-1",
      nodeId: "node-1",
      modelId: "video-model",
      modality: "video",
      expectedQuote: quote,
      idempotencyKey: "request-0002",
      inputs: { videos: media, audios: media },
    };

    expect(generationJobSubmissionSchema.safeParse(submission).success).toBe(true);
    expect(
      generationJobSubmissionSchema.safeParse({
        ...submission,
        inputs: { videos: [...media, "media-10"], audios: media },
      }).success,
    ).toBe(false);
  });

  it("strips private execution fields from public job responses", () => {
    const job = publicGenerationJobSchema.parse({
      schemaVersion: 1,
      version: 2,
      id: "job-1",
      ownerId: "private-owner",
      providerTaskId: "private-task",
      executionRoute: { sourceModelId: "private-model" },
      pricing: { mode: "token", inputCreditMicrosPerMillion: 1 },
      rawProviderResponse: { secret: true },
      projectId: "project-1",
      nodeId: "node-1",
      modelId: "image2",
      modelLabel: "全能模型2",
      modality: "image",
      status: "queued",
      progress: 15,
      quote,
      artifacts: [],
      error: null,
      createdAt: "2026-07-15T10:00:00.000Z",
      updatedAt: "2026-07-15T10:00:05.000Z",
      startedAt: "2026-07-15T10:00:05.000Z",
      completedAt: null,
    });

    expect(job).not.toHaveProperty("ownerId");
    expect(job).not.toHaveProperty("providerTaskId");
    expect(job).not.toHaveProperty("executionRoute");
    expect(job).not.toHaveProperty("pricing");
    expect(job).not.toHaveProperty("rawProviderResponse");
    expect(job.version).toBe(2);
  });

  it("bounds the reconciliation identity to the submission idempotency grammar", () => {
    expect(generationJobIdempotencyKeySchema.parse("request-0001")).toBe("request-0001");
    expect(generationJobIdempotencyKeySchema.safeParse("req:abc_xyz.def-123").success).toBe(true);
    for (const value of ["", "short", "x".repeat(129), "bad key", "bad\u0000key", "注入;DROP"]) {
      expect(generationJobIdempotencyKeySchema.safeParse(value).success).toBe(false);
    }
  });

  it("parses a reconcile query with exactly one bounded key", () => {
    expect(generationJobReconcileQuerySchema.parse({ key: "request-0001" })).toEqual({
      key: "request-0001",
    });
    expect(generationJobReconcileQuerySchema.safeParse({}).success).toBe(false);
    expect(generationJobReconcileQuerySchema.safeParse({ key: "" }).success).toBe(false);
    expect(generationJobReconcileQuerySchema.safeParse({ key: "x".repeat(200) }).success).toBe(
      false,
    );
    expect(
      generationJobReconcileQuerySchema.safeParse({ key: "request-0001", extra: 1 }).success,
    ).toBe(true);
  });
});
