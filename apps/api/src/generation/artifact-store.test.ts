import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import type { ModelPricing, PublicMedia } from "@weftcanvas/contracts";

import type { PrivateModelRoute } from "../catalog/execution-route.js";
import { GenerationArtifactError, type GenerationJobRecord } from "./types.js";
import {
  calculateActualTokenCreditMicros,
  ValidatedGenerationArtifactStore,
} from "./artifact-store.js";
import {
  GenerationMediaMaterializationError,
  type MaterializedGenerationMedia,
} from "./result-materializer.js";
import type {
  GenerationResultStagingStore,
  StagedGenerationRecord,
  StagedGenerationResult,
} from "./result-staging.js";

const NOW = "2026-07-15T19:00:00.000Z";
const IMAGE_BYTES = Buffer.from("generated-image");
const tokenPricing: ModelPricing = {
  mode: "token",
  unit: "token",
  currency: "CNY",
  creditsPerYuan: 100,
  tiers: [],
  inputCreditMicrosPerMillion: 15_000_000,
  outputCreditMicrosPerMillion: 90_000_000,
};

describe("validated generation artifact store", () => {
  it("creates a text artifact and settles actual token usage against frozen rates", async () => {
    const job = generationJob("text", tokenPricing, 195_000);
    const store = new ValidatedGenerationArtifactStore(
      staging({ kind: "text", text: "最终文本", usage: { inputTokens: 120, outputTokens: 45 } }),
      unusedMaterializer(),
      unusedMedia(),
    );

    await expect(store.persist(job, "generation-result:result_1")).resolves.toEqual({
      artifacts: [{ id: "artifact:job-1:0", kind: "text", text: "最终文本", createdAt: NOW }],
      captureCreditMicros: 5_850,
    });
  });

  it("never captures more than the confirmed token reservation", () => {
    expect(
      calculateActualTokenCreditMicros(
        tokenPricing,
        {
          inputTokens: 100_000,
          outputTokens: 100_000,
        },
        1,
        10_000,
      ),
    ).toBe(10_000);
    expect(() => calculateActualTokenCreditMicros(tokenPricing, undefined, 1, 10_000)).toThrow(
      GenerationArtifactError,
    );
  });

  it("persists validated image bytes and returns only public artifact metadata", async () => {
    let removed = 0;
    let persistedInput: Record<string, unknown> | null = null;
    const materialized = generatedImage(() => {
      removed += 1;
    });
    const materializer = { materialize: async () => materialized };
    const media = {
      persistGenerated: async (_ownerId: string, input: Record<string, unknown>) => {
        persistedInput = input;
        const chunks: Buffer[] = [];
        for await (const chunk of input.source as AsyncIterable<Uint8Array>)
          chunks.push(Buffer.from(chunk));
        expect(Buffer.concat(chunks)).toEqual(IMAGE_BYTES);
        return readyImage();
      },
    };
    const store = new ValidatedGenerationArtifactStore(
      staging({
        kind: "image",
        items: [{ source: "url", url: "https://media.example/result.png" }],
      }),
      materializer,
      media,
    );

    const result = await store.persist(
      generationJob("image", fixedImagePricing(), 5_500_000),
      "generation-result:result_1",
    );
    expect(result).toMatchObject({
      captureCreditMicros: 5_500_000,
      artifacts: [
        { kind: "image", mediaId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", width: 64, height: 36 },
      ],
    });
    expect(persistedInput).toMatchObject({
      jobId: "job-1",
      index: 0,
      kind: "image",
      mimeType: "image/png",
    });
    expect(JSON.stringify(result)).not.toContain("objectKey");
    expect(removed).toBe(1);
  });

  it("captures the single per-call reservation even when one call returns five artifacts", async () => {
    const materializer = { materialize: async () => generatedImage(() => undefined) };
    let persistedCount = 0;
    const media = {
      persistGenerated: async () => {
        persistedCount += 1;
        return readyImage();
      },
    };
    const job = generationJob("image", requestPricing(), 40_000_000);
    job.quote.outputCount = 5;
    job.quote.pricingUnit = "request";
    const store = new ValidatedGenerationArtifactStore(
      staging({
        kind: "image",
        items: Array.from({ length: 5 }, () => ({
          source: "url" as const,
          url: "https://media.example/result.png",
        })),
      }),
      materializer,
      media,
    );

    const result = await store.persist(job, "generation-result:result_1");
    expect(result.artifacts).toHaveLength(5);
    expect(result.artifacts.every((artifact) => artifact.kind === "image")).toBe(true);
    // Five artifacts settle the one confirmed 40-credit call, never 5x40.
    expect(result.captureCreditMicros).toBe(40_000_000);
    expect(persistedCount).toBe(5);
  });

  it("turns definitive media failures into refundable artifact errors but leaves temporary failures retryable", async () => {
    const job = generationJob("image", fixedImagePricing(), 5_500_000);
    const definite = new ValidatedGenerationArtifactStore(
      staging({
        kind: "image",
        items: [{ source: "url", url: "https://media.example/result.png" }],
      }),
      {
        materialize: async () => {
          throw new GenerationMediaMaterializationError("MEDIA_INVALID", "无法解码", false);
        },
      },
      unusedMedia(),
    );
    await expect(definite.persist(job, "generation-result:result_1")).rejects.toMatchObject({
      name: "GenerationArtifactError",
      code: "MEDIA_INVALID",
    });

    const temporary = new ValidatedGenerationArtifactStore(
      staging({
        kind: "image",
        items: [{ source: "url", url: "https://media.example/result.png" }],
      }),
      {
        materialize: async () => {
          throw new GenerationMediaMaterializationError("DOWNLOAD_TEMPORARY", "稍后重试", true);
        },
      },
      unusedMedia(),
    );
    await expect(temporary.persist(job, "generation-result:result_1")).rejects.toMatchObject({
      name: "GenerationMediaMaterializationError",
      retryable: true,
    });
  });

  it("rejects staged records belonging to another job", async () => {
    const foreign = staging({ kind: "text", text: "result" }, "other-job");
    const store = new ValidatedGenerationArtifactStore(
      foreign,
      unusedMaterializer(),
      unusedMedia(),
    );
    await expect(
      store.persist(generationJob("text", tokenPricing, 100_000), "generation-result:result_1"),
    ).rejects.toMatchObject({ code: "RESULT_JOB_MISMATCH" });
  });
});

function staging(result: StagedGenerationResult, jobId = "job-1"): GenerationResultStagingStore {
  const record: StagedGenerationRecord = {
    version: 1,
    id: "result_1",
    jobId,
    result,
    createdAt: NOW,
  };
  return {
    write: async () => "generation-result:unused",
    read: async () => structuredClone(record),
    remove: async () => undefined,
  };
}

function generatedImage(onRemove: () => void): MaterializedGenerationMedia {
  return {
    path: "memory://generated-image",
    size: IMAGE_BYTES.length,
    sha256: createHash("sha256").update(IMAGE_BYTES).digest("hex"),
    inspected: {
      kind: "image",
      mimeType: "image/png",
      size: IMAGE_BYTES.length,
      width: 64,
      height: 36,
      durationMs: null,
    },
    open: () => Readable.from(IMAGE_BYTES),
    remove: async () => {
      onRemove();
    },
  };
}

function generationJob(
  modality: "text" | "image",
  pricing: ModelPricing,
  creditMicros: number,
): GenerationJobRecord {
  const fixedRoute: PrivateModelRoute = {
    sourceModelId: `private-${modality}`,
    modality,
    endpoint: {
      method: "POST",
      path: modality === "text" ? "/v1/chat/completions" : "/v1/images/generations",
      contentType: "application/json",
    },
    parameters: [{ name: "model", path: "model", type: "string", fixed: `private-${modality}` }],
  };
  return {
    schemaVersion: 1,
    id: "job-1",
    ownerId: "user-1",
    idempotencyKey: "request-0001",
    projectId: "project-1",
    nodeId: "node-1",
    modelId: `public-${modality}`,
    modelLabel: "测试模型",
    modality,
    parameters: {},
    inputs: { images: [], videos: [], audios: [] },
    quantity: 1,
    inputTokens: modality === "text" ? 1_000 : null,
    maxOutputTokens: modality === "text" ? 2_000 : null,
    status: "validating",
    progress: 95,
    quote: {
      id: "quote-1",
      modelId: `public-${modality}`,
      modelLabel: "测试模型",
      modality,
      quantity: 1,
      normalizedParameters: {},
      creditMicros,
      credits: String(creditMicros / 1_000_000),
      yuanMicros: 1,
      yuan: "0.000001",
      estimated: modality === "text",
      pricingUnit: modality === "text" ? "token" : "image",
      catalogVersion: "catalog-1",
      capabilityVersion: "capability-1",
      pricingVersion: "pricing-1",
      expiresAt: "2026-07-15T19:02:00.000Z",
    },
    pricing,
    executionRoute: fixedRoute,
    reservationId: "reservation:job-1",
    providerTaskId: null,
    providerResultRef: "generation-result:result_1",
    artifacts: [],
    error: null,
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: NOW,
    completedAt: null,
  };
}

function fixedImagePricing(): ModelPricing {
  return {
    mode: "fixed",
    unit: "image",
    currency: "CNY",
    creditsPerYuan: 100,
    baseCreditMicros: 5_500_000,
    baseYuanMicros: 55_000,
    tiers: [],
  };
}

function requestPricing(): ModelPricing {
  return {
    mode: "fixed",
    unit: "request",
    currency: "CNY",
    creditsPerYuan: 100,
    baseCreditMicros: 40_000_000,
    baseYuanMicros: 400_000,
    tiers: [],
  };
}

function readyImage(): PublicMedia {
  return {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    kind: "image",
    name: "生成图片 1.png",
    mimeType: "image/png",
    size: IMAGE_BYTES.length,
    sha256: createHash("sha256").update(IMAGE_BYTES).digest("hex"),
    width: 64,
    height: 36,
    durationMs: null,
    status: "ready",
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function unusedMaterializer() {
  return {
    materialize: async (): Promise<MaterializedGenerationMedia> => {
      throw new Error("materializer should not run");
    },
  };
}

function unusedMedia() {
  return {
    persistGenerated: async (): Promise<PublicMedia> => {
      throw new Error("media should not run");
    },
  };
}
