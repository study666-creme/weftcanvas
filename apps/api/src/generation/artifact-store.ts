import type { GenerationArtifact, ModelPricing, PublicMedia } from "@weftcanvas/contracts";

import { MediaService, MediaServiceError } from "../media/service.js";
import type { CloudProjectEntitlementResolver } from "../project/types.js";
import {
  GenerationArtifactError,
  type GenerationArtifactStore,
  type GenerationJobRecord,
  type PersistedGenerationResult,
} from "./types.js";
import {
  GenerationMediaMaterializationError,
  GenerationResultMaterializer,
  type MaterializedGenerationMedia,
} from "./result-materializer.js";
import type { GenerationResultStagingStore, StagedGenerationResult } from "./result-staging.js";
import { OutputCountError, totalOutputCount } from "./output-count.js";

export class ValidatedGenerationArtifactStore implements GenerationArtifactStore {
  constructor(
    private readonly staging: GenerationResultStagingStore,
    private readonly materializer: Pick<GenerationResultMaterializer, "materialize">,
    private readonly media: Pick<MediaService, "persistGenerated">,
    private readonly entitlements?: Pick<CloudProjectEntitlementResolver, "resolve">,
  ) {}

  async persist(job: GenerationJobRecord, resultRef: string): Promise<PersistedGenerationResult> {
    const staged = await this.staging.read(resultRef);
    if (staged.jobId !== job.id) throw invalid("RESULT_JOB_MISMATCH", "生成结果不属于当前任务");
    if (staged.result.kind !== job.modality)
      throw invalid("RESULT_TYPE_MISMATCH", "生成结果类型与当前任务不一致");

    if (staged.result.kind === "text") {
      return {
        artifacts: [
          {
            id: `artifact:${job.id}:0`,
            kind: "text",
            text: staged.result.text,
            createdAt: staged.createdAt,
          },
        ],
        captureCreditMicros: captureAmount(job, staged.result),
      };
    }

    if (staged.result.kind === "image") {
      const expectedCount = expectedImageCount(job);
      if (staged.result.items.length !== expectedCount) {
        throw invalid(
          "RESULT_COUNT_MISMATCH",
          `The provider returned ${staged.result.items.length} images; ${expectedCount} were quoted`,
        );
      }
      const maxStorageBytes = await this.resolveMediaStorageBytes(job.ownerId);
      const artifacts: GenerationArtifact[] = [];
      for (const [index, source] of staged.result.items.entries()) {
        artifacts.push(await this.persistMedia(job, index, source, "image", maxStorageBytes));
      }
      return { artifacts, captureCreditMicros: job.quote.creditMicros };
    }

    if (staged.result.kind === "video") {
      const maxStorageBytes = await this.resolveMediaStorageBytes(job.ownerId);
      return {
        artifacts: [
          await this.persistMedia(
            job,
            0,
            { source: "url", url: staged.result.url },
            "video",
            maxStorageBytes,
          ),
        ],
        captureCreditMicros: job.quote.creditMicros,
      };
    }

    if (staged.result.kind === "audio") {
      const maxStorageBytes = await this.resolveMediaStorageBytes(job.ownerId);
      const artifacts: GenerationArtifact[] = [];
      for (const [index, source] of staged.result.items.entries()) {
        artifacts.push(await this.persistMedia(job, index, source, "audio", maxStorageBytes));
      }
      return { artifacts, captureCreditMicros: job.quote.creditMicros };
    }

    throw invalid("RESULT_TYPE_UNAVAILABLE", "当前生成结果类型暂时无法保存");
  }

  async cleanup(resultRef: string) {
    await this.staging.remove(resultRef);
  }

  private async persistMedia(
    job: GenerationJobRecord,
    index: number,
    source:
      | Extract<StagedGenerationResult, { kind: "image" }>["items"][number]
      | Extract<StagedGenerationResult, { kind: "audio" }>["items"][number]
      | { source: "url"; url: string },
    kind: "image" | "video" | "audio",
    maxStorageBytes: number,
  ) {
    let materialized: MaterializedGenerationMedia;
    try {
      materialized = await this.materializer.materialize(source, kind);
    } catch (error) {
      if (error instanceof GenerationMediaMaterializationError && !error.retryable) {
        throw invalid(error.code, error.message);
      }
      throw error;
    }
    try {
      let persisted: PublicMedia;
      try {
        persisted = await this.media.persistGenerated(
          job.ownerId,
          {
            jobId: job.id,
            index,
            kind,
            name: resultName(kind, index, materialized.inspected.mimeType),
            mimeType: materialized.inspected.mimeType,
            size: materialized.size,
            sha256: materialized.sha256,
            source: materialized.open(),
          },
          maxStorageBytes,
        );
      } catch (error) {
        if (
          error instanceof MediaServiceError &&
          error.status < 500 &&
          error.code !== "GENERATED_MEDIA_IN_PROGRESS"
        ) {
          throw invalid(error.code, error.message);
        }
        throw error;
      }
      if (persisted.status !== "ready" || persisted.kind !== kind) {
        throw invalid("RESULT_MEDIA_NOT_READY", "生成结果尚未完成保存");
      }
      return mediaArtifact(job.id, index, persisted);
    } finally {
      await materialized.remove();
    }
  }

  private async resolveMediaStorageBytes(ownerId: string) {
    if (!this.entitlements) return Number.MAX_SAFE_INTEGER;
    return (await this.entitlements.resolve(ownerId, undefined, { allowStale: false })).data
      .mediaStorageBytes;
  }
}

function expectedImageCount(job: GenerationJobRecord) {
  if (job.quote.outputCount !== undefined) return job.quote.outputCount;
  try {
    return totalOutputCount("image", job.quantity, job.parameters);
  } catch (error) {
    if (error instanceof OutputCountError) {
      throw invalid(error.code, error.message);
    }
    throw error;
  }
}

export function calculateActualTokenCreditMicros(
  pricing: ModelPricing,
  usage: { inputTokens?: number; outputTokens?: number } | undefined,
  quantity: number,
  reservedCreditMicros: number,
) {
  if (pricing.mode !== "token") return reservedCreditMicros;
  if (usage?.inputTokens === undefined || usage.outputTokens === undefined) {
    throw invalid("TOKEN_USAGE_MISSING", "文本生成缺少实际用量，暂时无法结算");
  }
  const inputRate = tokenCreditRate(
    pricing.inputCreditMicrosPerMillion,
    pricing.inputYuanMicrosPerMillion,
    pricing.creditsPerYuan,
  );
  const outputRate = tokenCreditRate(
    pricing.outputCreditMicrosPerMillion,
    pricing.outputYuanMicrosPerMillion,
    pricing.creditsPerYuan,
  );
  if (inputRate === null || outputRate === null)
    throw invalid("TOKEN_PRICE_MISSING", "文本生成缺少结算价格");
  const numerator = inputRate * BigInt(usage.inputTokens) + outputRate * BigInt(usage.outputTokens);
  const perRequest = (numerator + 999_999n) / 1_000_000n;
  const actual = perRequest * BigInt(quantity);
  const reserved = BigInt(reservedCreditMicros);
  return Number(actual > reserved ? reserved : actual);
}

function captureAmount(
  job: GenerationJobRecord,
  result: Extract<StagedGenerationResult, { kind: "text" }>,
) {
  return calculateActualTokenCreditMicros(
    job.pricing,
    result.usage,
    job.quantity,
    job.quote.creditMicros,
  );
}

function tokenCreditRate(
  creditMicros: number | undefined,
  yuanMicros: number | undefined,
  creditsPerYuan: number,
) {
  if (creditMicros !== undefined) return BigInt(creditMicros);
  if (yuanMicros !== undefined) return BigInt(yuanMicros) * BigInt(creditsPerYuan);
  return null;
}

function mediaArtifact(jobId: string, index: number, media: PublicMedia): GenerationArtifact {
  if (media.kind === "image") {
    return {
      id: `artifact:${jobId}:${index}`,
      kind: "image",
      mediaId: media.id,
      name: media.name,
      mimeType: media.mimeType,
      size: media.size,
      ...(media.width ? { width: media.width } : {}),
      ...(media.height ? { height: media.height } : {}),
      createdAt: media.updatedAt,
    };
  }
  return {
    id: `artifact:${jobId}:${index}`,
    kind: media.kind,
    mediaId: media.id,
    name: media.name,
    mimeType: media.mimeType,
    size: media.size,
    ...(media.width ? { width: media.width } : {}),
    ...(media.height ? { height: media.height } : {}),
    ...(media.durationMs ? { duration: media.durationMs / 1_000 } : {}),
    createdAt: media.updatedAt,
  };
}

function resultName(kind: "image" | "video" | "audio", index: number, mimeType: string) {
  const extension = extensionForMime(mimeType);
  const label = kind === "image" ? "生成图片" : kind === "video" ? "生成视频" : "生成音频";
  // 音频一次请求可能返回多首（suno 固定 2 首），编号一律带上。
  return `${label}${kind === "image" || kind === "audio" ? ` ${index + 1}` : ""}.${extension}`;
}

function extensionForMime(mimeType: string) {
  const extensions: Record<string, string> = {
    "image/avif": "avif",
    "image/gif": "gif",
    "image/heif": "heif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/tiff": "tiff",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "video/x-matroska": "mkv",
    "video/x-msvideo": "avi",
    "video/mpeg": "mpeg",
    "video/mp2t": "ts",
    "video/ogg": "ogv",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/flac": "flac",
    "audio/aac": "aac",
    "audio/ogg": "ogg",
    "audio/webm": "weba",
  };
  return extensions[mimeType] ?? "bin";
}

function invalid(code: string, message: string) {
  return new GenerationArtifactError(code, message);
}
