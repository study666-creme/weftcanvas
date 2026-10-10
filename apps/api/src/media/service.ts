import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import {
  mediaUploadRequestSchema,
  publicMediaSchema,
  type MediaKind,
  type MediaUploadRequest,
  type PublicMedia,
} from "@kachang/contracts";

import {
  MediaInspectionError,
  MediaObjectWriteError,
  mediaRecordSchema,
  supportsDirectMediaAccess,
  type InspectedMedia,
  type MediaEvictionItem,
  type MediaInspector,
  type MediaMetadataStore,
  type MediaObjectStore,
  type MediaObjectWriteResult,
  type MediaRecord,
  type MediaStorageQuota,
  type PublicMediaContent,
} from "./types.js";

const DEFAULT_UPLOAD_TTL_MS = 23 * 60 * 60_000;
const DEFAULT_LIMITS: Record<MediaKind, number> = {
  image: 25 * 1024 * 1024,
  video: 512 * 1024 * 1024,
  audio: 100 * 1024 * 1024,
};
// 画布节点内只显示 340~4096px 的展示框；512px 长边的缩略变体足够节点与小地图使用，
// 全屏预览与下载仍走原图。生成失败不缓存失败态，下次请求重试。
const THUMB_LONG_EDGE = 512;
const THUMB_MAX_BYTES = 8 * 1024 * 1024;

export function thumbObjectKey(objectKey: string) {
  return `${objectKey}-thumb`;
}
const ACCEPTED_MIME_TYPES: Record<MediaKind, ReadonlySet<string>> = {
  image: new Set(["image/avif", "image/gif", "image/heif", "image/jpeg", "image/png", "image/tiff", "image/webp"]),
  video: new Set(["video/mp4", "video/webm", "video/quicktime", "video/x-matroska", "video/x-msvideo", "video/mpeg", "video/mp2t", "video/ogg"]),
  audio: new Set(["audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/flac", "audio/aac", "audio/ogg", "audio/webm"]),
};

type MediaServiceOptions = {
  now?: () => number;
  createId?: () => string;
  uploadTtlMs?: number;
  uploadProcessingTimeoutMs?: number;
  generatedUploadProcessingTimeoutMs?: number;
  limits?: Partial<Record<MediaKind, number>>;
  /**
   * 图片素材 ready 后在后台预生成展示缩略图（默认开启）。画布节点首屏走
   * `variant=thumb`，惰性生成意味着第一个看图的人要等一次完整的对象存储
   * 往返 + 缩放；慢存储下这会超过前端有界加载的重试预算，被误判成
   * 「结果加载失败」。测试里可关掉以获得确定性的调用断言。
   */
  warmThumbnails?: boolean;
};

type MediaServiceStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 503;

export class MediaServiceError extends Error {
  constructor(readonly code: string, message: string, readonly status: MediaServiceStatus) {
    super(message);
    this.name = "MediaServiceError";
  }
}

export class MediaService {
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly uploadTtlMs: number;
  private readonly uploadProcessingTimeoutMs: number;
  private readonly generatedUploadProcessingTimeoutMs: number;
  private readonly limits: Record<MediaKind, number>;
  private readonly warmThumbnails: boolean;

  constructor(
    private readonly metadata: MediaMetadataStore,
    private readonly objects: MediaObjectStore,
    private readonly inspector: MediaInspector,
    options: MediaServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.uploadTtlMs = positiveInteger(options.uploadTtlMs ?? DEFAULT_UPLOAD_TTL_MS, "uploadTtlMs");
    this.uploadProcessingTimeoutMs = positiveInteger(
      options.uploadProcessingTimeoutMs ?? 15 * 60_000,
      "uploadProcessingTimeoutMs",
    );
    this.generatedUploadProcessingTimeoutMs = positiveInteger(
      options.generatedUploadProcessingTimeoutMs ?? 2 * 60_000,
      "generatedUploadProcessingTimeoutMs",
    );
    this.limits = {
      image: positiveInteger(options.limits?.image ?? DEFAULT_LIMITS.image, "image limit"),
      video: positiveInteger(options.limits?.video ?? DEFAULT_LIMITS.video, "video limit"),
      audio: positiveInteger(options.limits?.audio ?? DEFAULT_LIMITS.audio, "audio limit"),
    };
    this.warmThumbnails = options.warmThumbnails ?? true;
  }

  async createUpload(ownerId: string, value: unknown, maxStorageBytes?: number) {
    if (!ownerId) throw new MediaServiceError("UNAUTHENTICATED", "请先登录", 401);
    const input = mediaUploadRequestSchema.parse(value);
    assertAcceptedInput(input, this.limits[input.kind]);
    const existing = await this.metadata.findByIdempotency(ownerId, input.idempotencyKey);
    if (existing) return this.existingIntent(existing, input);

    const now = this.now();
    const id = this.createId();
    const timestamp = new Date(now).toISOString();
    const record: MediaRecord = {
      id,
      ownerId,
      projectId: input.projectId ?? null,
      source: "upload",
      idempotencyKey: input.idempotencyKey,
      objectKey: `media/${id.slice(0, 2)}/${id}`,
      kind: input.kind,
      name: safeName(input.name),
      declaredMimeType: canonicalMimeType(input.mimeType),
      detectedMimeType: null,
      expectedSize: input.size,
      size: null,
      expectedSha256: input.sha256 ?? null,
      sha256: null,
      width: null,
      height: null,
      durationMs: null,
      status: "pending",
      error: null,
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      uploadExpiresAt: new Date(now + this.uploadTtlMs).toISOString(),
      readyAt: null,
    };
    const created = await this.metadata.create(
      mediaRecordSchema.parse(record),
      this.storageQuota(maxStorageBytes, now),
    );
    if (created.kind === "storage_limit") {
      throw new MediaServiceError("MEDIA_STORAGE_LIMIT_REACHED", "账号存储空间已用完", 403);
    }
    if (created.kind === "intent_limit") {
      throw new MediaServiceError("MEDIA_UPLOAD_INTENT_LIMIT_REACHED", "上传请求过多，请稍后重试", 429);
    }
    if (created.kind === "existing") return this.existingIntent(created.media, input);
    if (created.evicted?.length) this.releaseEvictedObjects(created.evicted);
    return intent(created.media);
  }

  async createDirectUploadInstruction(ownerId: string, mediaId: string, projectId?: string) {
    if (!supportsDirectMediaAccess(this.objects)) return null;
    const media = await this.requirePendingUpload(ownerId, mediaId, projectId);
    if (media.status === "ready") return null;
    return this.objects.createUploadInstruction(media.objectKey, {
      contentType: media.declaredMimeType,
      contentLength: media.expectedSize,
      sha256: media.expectedSha256,
      expiresAt: media.uploadExpiresAt,
    });
  }

  async completeDirectUpload(
    ownerId: string,
    mediaId: string,
    projectId?: string,
    options: { allowExpired?: boolean } = {},
  ) {
    if (!supportsDirectMediaAccess(this.objects)) {
      throw new MediaServiceError("MEDIA_DIRECT_UPLOAD_UNAVAILABLE", "当前上传方式不可用", 409);
    }
    const current = await this.requirePendingUpload(ownerId, mediaId, projectId, options.allowExpired === true);
    if (current.status === "ready") return toPublicMedia(current);
    const claimed = await this.metadata.claimUpload(current.id, ownerId, current.revision, new Date(this.now()).toISOString());
    if (!claimed) return this.resolveClaimConflict(ownerId, mediaId, projectId);
    try {
      const validated = await this.objects.withPendingUploadFile(claimed.objectKey, async ({ path, versionToken }) => {
        const written = await digestLocalFile(path, this.limits[claimed.kind]);
        this.assertWrittenObject(claimed, written);
        const inspected = await this.inspector.inspect(path, claimed.kind);
        this.assertInspection(claimed, written, inspected);
        return { written, inspected, versionToken };
      });
      await this.objects.promotePendingUpload(claimed.objectKey, {
        contentType: validated.inspected.mimeType,
        size: validated.written.size,
        sha256: validated.written.sha256,
        versionToken: validated.versionToken,
      });
      const ready = await this.publishReady(claimed, validated.written, validated.inspected);
      await this.objects.removePendingUpload(claimed.objectKey).catch(() => undefined);
      return ready;
    } catch (error) {
      return this.handleDirectUploadFailure(claimed, error);
    }
  }

  async persistGenerated(
    ownerId: string,
    input: {
      jobId: string;
      index: number;
      kind: MediaKind;
      name: string;
      mimeType: string;
      size: number;
      sha256: string;
      source: AsyncIterable<Uint8Array>;
    },
    maxStorageBytes: number,
  ) {
    const idempotencyKey = `generation:${createHash("sha256").update(`${input.jobId}:${input.index}`).digest("hex")}`;
    const immutable = {
      kind: input.kind,
      name: safeName(input.name),
      mimeType: canonicalMimeType(input.mimeType),
      size: positiveInteger(input.size, "generated media size"),
      sha256: input.sha256.toLowerCase(),
      idempotencyKey,
    };
    if (!/^[a-f0-9]{64}$/.test(immutable.sha256)) throw new Error("Generated media SHA-256 is invalid");
    assertAcceptedInput(immutable, this.limits[input.kind]);

    let media = await this.metadata.findByIdempotency(ownerId, idempotencyKey);
    if (media) {
      this.assertGeneratedIdentity(media, immutable);
    } else {
      const now = this.now();
      const id = this.createId();
      const timestamp = new Date(now).toISOString();
      const created = await this.metadata.create(
        mediaRecordSchema.parse({
          id,
          ownerId,
          // Generation can run before a project is cloud enabled. Its durable
          // result stays personal; cloud save uploads a project-bound copy.
          projectId: null,
          source: "generation",
          idempotencyKey,
          objectKey: `media/${id.slice(0, 2)}/${id}`,
          kind: immutable.kind,
          name: immutable.name,
          declaredMimeType: immutable.mimeType,
          detectedMimeType: null,
          expectedSize: immutable.size,
          size: null,
          expectedSha256: immutable.sha256,
          sha256: null,
          width: null,
          height: null,
          durationMs: null,
          status: "pending",
          error: null,
          revision: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
          uploadExpiresAt: new Date(now + this.uploadTtlMs).toISOString(),
          readyAt: null,
        }),
        this.storageQuota(maxStorageBytes, now),
      );
      if (created.kind === "storage_limit") {
        throw new MediaServiceError("MEDIA_STORAGE_LIMIT_REACHED", "账号存储空间已用完", 403);
      }
      if (created.kind === "intent_limit") {
        throw new MediaServiceError("MEDIA_UPLOAD_INTENT_LIMIT_REACHED", "上传请求过多，请稍后重试", 429);
      }
      if (created.kind === "created") {
        if (created.evicted?.length) this.releaseEvictedObjects(created.evicted);
        media = created.media;
        this.assertGeneratedIdentity(media, immutable);
      } else {
        media = created.media;
      }
    }

    media = await this.recoverGeneratedUpload(ownerId, media);
    if (media.status === "ready") return toPublicMedia(media);

    return this.upload(ownerId, media.id, input.source, {
      contentType: immutable.mimeType,
      contentLength: immutable.size,
    });
  }

  async upload(
    ownerId: string,
    mediaId: string,
    source: AsyncIterable<Uint8Array>,
    request: { contentType: string | undefined; contentLength: number | null },
    projectId?: string,
  ) {
    const current = await this.requirePendingUpload(ownerId, mediaId, projectId);
    if (current.status === "ready") return toPublicMedia(current);
    const contentType = canonicalMimeType(request.contentType ?? "");
    if (contentType !== current.declaredMimeType) {
      throw new MediaServiceError("MEDIA_CONTENT_TYPE_MISMATCH", "上传类型与文件信息不一致", 415);
    }
    if (request.contentLength !== null && request.contentLength !== current.expectedSize) {
      throw new MediaServiceError("MEDIA_SIZE_MISMATCH", "上传内容大小与文件信息不一致", 400);
    }

    const claimed = await this.metadata.claimUpload(current.id, ownerId, current.revision, new Date(this.now()).toISOString());
    if (!claimed) return this.resolveClaimConflict(ownerId, mediaId, projectId);

    try {
      const written = await this.objects.write(claimed.objectKey, source, {
        expectedSize: claimed.expectedSize,
        maxBytes: this.limits[claimed.kind],
        contentType: claimed.declaredMimeType,
      });
      this.assertWrittenObject(claimed, written);
      const inspected = await this.objects.withLocalFile(
        claimed.objectKey,
        (path) => this.inspector.inspect(path, claimed.kind),
      );
      this.assertInspection(claimed, written, inspected);
      return await this.publishReady(claimed, written, inspected);
    } catch (error) {
      return this.handleUploadFailure(claimed, error);
    }
  }

  async get(ownerId: string, mediaId: string, projectId?: string) {
    return toPublicMedia(await this.requireOwned(ownerId, mediaId, projectId));
  }

  /**
   * 删除未被云项目引用的素材：数据库记录与对象一并移除，配额随之释放。
   * 被云项目绑定的素材拒绝删除，避免破坏已上云的工程引用。
   */
  async delete(ownerId: string, mediaId: string) {
    const result = await this.metadata.deleteOwned(mediaId, ownerId);
    if (result.kind === "missing") {
      throw new MediaServiceError("MEDIA_NOT_FOUND", "素材不存在", 404);
    }
    if (result.kind === "bound") {
      throw new MediaServiceError("MEDIA_REFERENCED_BY_PROJECT", "素材已被云项目引用，无法删除", 409);
    }
    await this.removeMediaObjects(result.media);
    return toPublicMedia(result.media);
  }

  async failUploadSafely(
    ownerId: string,
    mediaId: string,
    code: string,
    message: string,
    projectId?: string,
  ) {
    const current = await this.requireOwned(ownerId, mediaId, projectId);
    if (current.status === "ready" || current.status === "failed") return toPublicMedia(current);
    const saved = await this.fail(current, safeFailureCode(code), safeFailureMessage(message));
    if (saved) return toPublicMedia(saved);
    const latest = await this.requireOwned(ownerId, mediaId, projectId);
    if (latest.status === "ready" || latest.status === "failed") return toPublicMedia(latest);
    throw new MediaServiceError("MEDIA_UPLOAD_CONFLICT", "素材状态已经更新，请刷新后重试", 409);
  }

  async cancelUploadSafely(ownerId: string, mediaId: string, projectId?: string) {
    return this.failUploadSafely(
      ownerId,
      mediaId,
      "MEDIA_UPLOAD_ABORTED",
      "上传已取消",
      projectId,
    );
  }

  async open(ownerId: string, mediaId: string, range?: { start: number; end: number }, projectId?: string, signal?: AbortSignal): Promise<PublicMediaContent> {
    const media = await this.requireOwned(ownerId, mediaId, projectId);
    if (media.status !== "ready") throw new MediaServiceError("MEDIA_NOT_READY", "素材尚未处理完成", 409);
    return { media: toPublicMedia(media), object: await this.objects.open(media.objectKey, range, signal) };
  }

  /**
   * 画布节点展示用的缩略图读取：命中已生成的派生对象直接返回；未命中则从
   * 原图惰性生成一次并写回对象存储（key 规则 ${objectKey}-thumb，随主对象
   * 一起删除）。仅图片可用；失败按 503 上抛，不落任何失败缓存。
   */
  async openThumb(ownerId: string, mediaId: string, projectId?: string): Promise<PublicMediaContent> {
    const media = await this.requireOwned(ownerId, mediaId, projectId);
    if (media.status !== "ready") throw new MediaServiceError("MEDIA_NOT_READY", "素材尚未处理完成", 409);
    if (media.kind !== "image") throw new MediaServiceError("MEDIA_THUMB_UNAVAILABLE", "这个素材没有缩略图", 404);
    const mimeType = media.detectedMimeType ?? media.declaredMimeType;
    if (!mimeType.startsWith("image/")) throw new MediaServiceError("MEDIA_THUMB_UNAVAILABLE", "这个素材没有缩略图", 404);
    const thumbKey = thumbObjectKey(media.objectKey);
    const thumb = await this.readThumbIfPresent(thumbKey);
    if (thumb) return { media: toPublicMedia(media), object: thumb };
    const generated = await this.generateThumb(media.objectKey);
    await this.objects.write(thumbKey, bufferToAsyncIterable(generated), {
      expectedSize: generated.byteLength,
      maxBytes: THUMB_MAX_BYTES,
      contentType: "image/png",
    });
    return {
      media: { ...toPublicMedia(media), mimeType: "image/png" },
      object: await this.objects.open(thumbKey),
    };
  }

  private async readThumbIfPresent(thumbKey: string) {
    try {
      return await this.objects.open(thumbKey);
    } catch {
      return null;
    }
  }

  private async generateThumb(objectKey: string): Promise<Buffer> {
    const sharp = await import("sharp");
    try {
      return await this.objects.withLocalFile(objectKey, async (path) => {
        const image = sharp.default(path, { failOn: "error" });
        return image
          .clone()
          .rotate()
          .resize({ width: THUMB_LONG_EDGE, height: THUMB_LONG_EDGE, fit: "inside", withoutEnlargement: true })
          .png({ compressionLevel: 6 })
          .toBuffer();
      });
    } catch {
      throw new MediaServiceError("MEDIA_THUMB_GENERATION_FAILED", "缩略图生成失败，请稍后重试", 503);
    }
  }

  async createPrivateDownload(ownerId: string, mediaId: string, projectId?: string) {
    if (!supportsDirectMediaAccess(this.objects)) return null;
    const media = await this.requireOwned(ownerId, mediaId, projectId);
    if (media.status !== "ready") throw new MediaServiceError("MEDIA_NOT_READY", "素材尚未处理完成", 409);
    return this.objects.createDownloadInstruction(media.objectKey, {
      contentType: media.detectedMimeType ?? media.declaredMimeType,
      name: media.name,
    });
  }

  async openForSignedDelivery(mediaId: string, kind: MediaKind, range?: { start: number; end: number }): Promise<PublicMediaContent> {
    const media = await this.requireSignedMedia(mediaId, kind);
    return { media: toPublicMedia(media), object: await this.objects.open(media.objectKey, range) };
  }

  async getForSignedDelivery(mediaId: string, kind: MediaKind) {
    return toPublicMedia(await this.requireSignedMedia(mediaId, kind));
  }

  async readReference(ownerId: string, mediaId: string, kind: MediaKind, maxBytes: number, projectId?: string) {
    const media = await this.requireOwned(ownerId, mediaId, projectId);
    if (media.status !== "ready" || media.kind !== kind) {
      throw new MediaServiceError("MEDIA_REFERENCE_INVALID", "参考素材尚未准备完成", 409);
    }
    if (media.size === null || media.size > maxBytes) {
      throw new MediaServiceError("MEDIA_REFERENCE_TOO_LARGE", "参考素材大小超过当前限制", 413);
    }
    const opened = await this.objects.open(media.objectKey);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of opened.stream) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) throw new MediaServiceError("MEDIA_REFERENCE_TOO_LARGE", "参考素材大小超过当前限制", 413);
      chunks.push(bytes);
    }
    if (size !== media.size || size !== opened.totalSize) {
      throw new MediaServiceError("MEDIA_REFERENCE_INVALID", "参考素材内容不完整", 409);
    }
    return { media: toPublicMedia(media), bytes: Buffer.concat(chunks, size) };
  }

  private async requireOwned(ownerId: string, mediaId: string, projectId?: string) {
    const getByAccessScope = this.metadata.getByAccessScope;
    const media = typeof getByAccessScope === "function"
      ? await getByAccessScope.call(this.metadata, mediaId, ownerId, projectId ?? null)
      : await this.metadata.getById(mediaId).then((candidate) => (
          candidate?.ownerId === ownerId && candidate.projectId === (projectId ?? null) ? candidate : null
        ));
    if (!media) throw new MediaServiceError("MEDIA_NOT_FOUND", "没有找到这个素材", 404);
    return media;
  }

  private async recoverGeneratedUpload(ownerId: string, media: MediaRecord) {
    if (media.status === "ready") return media;
    if (media.status === "failed") {
      throw new MediaServiceError("GENERATED_MEDIA_FAILED", media.error?.message ?? "生成结果无法保存", 422);
    }
    if (media.status !== "uploading") return media;
    if (this.now() - Date.parse(media.updatedAt) < this.generatedUploadProcessingTimeoutMs) {
      throw new MediaServiceError("GENERATED_MEDIA_IN_PROGRESS", "生成结果正在保存", 409);
    }

    const reset = await this.metadata.resetUpload(
      media.id,
      media.ownerId,
      media.revision,
      new Date(this.now()).toISOString(),
    );
    const current = reset ?? await this.requireOwned(ownerId, media.id);
    if (current.status === "ready") return current;
    if (current.status === "failed") {
      throw new MediaServiceError("GENERATED_MEDIA_FAILED", current.error?.message ?? "生成结果无法保存", 422);
    }
    if (current.status !== "pending") {
      throw new MediaServiceError("GENERATED_MEDIA_IN_PROGRESS", "生成结果正在保存", 409);
    }
    return current;
  }

  private async requirePendingUpload(ownerId: string, mediaId: string, projectId?: string, allowExpired = false) {
    let media = await this.requireOwned(ownerId, mediaId, projectId);
    if (media.status === "ready") return media;
    if (media.status === "failed") {
      throw new MediaServiceError("MEDIA_UPLOAD_FAILED", media.error?.message ?? "素材上传失败", 409);
    }
    if (media.status === "uploading") {
      if (this.now() - Date.parse(media.updatedAt) < this.uploadProcessingTimeoutMs) {
        throw new MediaServiceError("MEDIA_UPLOAD_IN_PROGRESS", "素材正在处理中", 409);
      }
      const reset = await this.metadata.resetUpload(
        media.id,
        media.ownerId,
        media.revision,
        new Date(this.now()).toISOString(),
      );
      media = reset ?? await this.requireOwned(ownerId, mediaId, projectId);
      if (media.status === "ready") return media;
      if (media.status === "failed") {
        throw new MediaServiceError("MEDIA_UPLOAD_FAILED", media.error?.message ?? "素材上传失败", 409);
      }
      if (media.status !== "pending") {
        throw new MediaServiceError("MEDIA_UPLOAD_IN_PROGRESS", "素材正在处理中", 409);
      }
    }
    if (!allowExpired && Date.parse(media.uploadExpiresAt) <= this.now()) {
      await this.fail(media, "MEDIA_UPLOAD_EXPIRED", "上传已过期，请重新选择素材");
      throw new MediaServiceError("MEDIA_UPLOAD_EXPIRED", "上传已过期，请重新选择素材", 409);
    }
    return media;
  }

  private async requireSignedMedia(mediaId: string, kind: MediaKind) {
    const media = await this.metadata.getById(mediaId);
    if (!media || media.status !== "ready" || media.kind !== kind) {
      throw new MediaServiceError("MEDIA_NOT_FOUND", "没有找到这个素材", 404);
    }
    return media;
  }

  private existingIntent(media: MediaRecord, input: MediaUploadRequest) {
    const matches = media.kind === input.kind
      && media.name === safeName(input.name)
      && media.declaredMimeType === canonicalMimeType(input.mimeType)
      && media.expectedSize === input.size
      && media.expectedSha256 === (input.sha256 ?? null)
      && media.projectId === (input.projectId ?? null);
    if (!matches) throw new MediaServiceError("IDEMPOTENCY_CONFLICT", "这个上传请求标识已经用于其他素材", 409);
    return intent(media);
  }

  private async resolveClaimConflict(ownerId: string, mediaId: string, projectId?: string) {
    const latest = await this.requireOwned(ownerId, mediaId, projectId);
    if (latest.status === "ready") return toPublicMedia(latest);
    throw new MediaServiceError("MEDIA_UPLOAD_IN_PROGRESS", "素材正在处理中", 409);
  }

  private async reconcileReady(ownerId: string, mediaId: string, sha256: string) {
    const current = await this.metadata.getById(mediaId).catch(() => null);
    const getByAccessScope = this.metadata.getByAccessScope;
    const latest = !current
      ? null
      : typeof getByAccessScope === "function"
        ? await getByAccessScope.call(this.metadata, mediaId, ownerId, current.projectId).catch(() => null)
        : current.ownerId === ownerId ? current : null;
    if (!latest || latest.status !== "ready" || latest.sha256 !== sha256) return null;
    return toPublicMedia(latest);
  }

  private assertWrittenObject(media: MediaRecord, written: MediaObjectWriteResult) {
    if (written.size !== media.expectedSize) {
      throw new MediaInspectionError("MEDIA_SIZE_MISMATCH", "上传内容大小与文件信息不一致");
    }
    if (media.expectedSha256 && media.expectedSha256 !== written.sha256) {
      throw new MediaInspectionError("MEDIA_CHECKSUM_MISMATCH", "素材完整性校验失败");
    }
  }

  private assertInspection(media: MediaRecord, written: MediaObjectWriteResult, inspected: InspectedMedia) {
    if (inspected.kind !== media.kind || inspected.size !== written.size) {
      throw new MediaInspectionError("MEDIA_VALIDATION_MISMATCH", "素材校验结果不一致");
    }
    if (!ACCEPTED_MIME_TYPES[media.kind].has(canonicalMimeType(inspected.mimeType))) {
      throw new MediaInspectionError("MEDIA_TYPE_UNAVAILABLE", "当前素材格式无法安全处理");
    }
  }

  private async publishReady(media: MediaRecord, written: MediaObjectWriteResult, inspected: InspectedMedia) {
    const timestamp = new Date(this.now()).toISOString();
    const ready: MediaRecord = {
      ...media,
      detectedMimeType: inspected.mimeType,
      size: written.size,
      sha256: written.sha256,
      width: inspected.width,
      height: inspected.height,
      durationMs: inspected.durationMs,
      status: "ready",
      error: null,
      revision: media.revision + 1,
      updatedAt: timestamp,
      readyAt: timestamp,
    };
    let saved: MediaRecord | null;
    try {
      saved = await this.metadata.markReady(ready, media.revision);
    } catch {
      const reconciled = await this.reconcileReady(media.ownerId, media.id, written.sha256);
      if (reconciled) return reconciled;
      throw new MediaServiceError("MEDIA_FINALIZATION_UNCONFIRMED", "素材已上传，正在确认处理结果", 503);
    }
    if (saved) {
      this.warmImageThumbnail(media, inspected.mimeType);
      return toPublicMedia(saved);
    }
    const reconciled = await this.reconcileReady(media.ownerId, media.id, written.sha256);
    if (reconciled) {
      this.warmImageThumbnail(media, inspected.mimeType);
      return reconciled;
    }
    throw new MediaServiceError("MEDIA_UPLOAD_CONFLICT", "素材状态已经更新，请刷新后重试", 409);
  }

  /**
   * 图片素材 ready 后立刻在后台把 512px 展示缩略图生成并落盘。节点首屏展示
   * 走 `variant=thumb`，若不预热，「第一个看到这张图的人」就得替所有人等一次
   * 对象存储往返 + sharp 缩放；慢存储下这段时间会超过前端有界加载的重试预算，
   * 界面就会先报「结果加载失败」，缩略图随后才出现。这里把成本提前付掉。
   *
   * 失败静默：派生对象缺失时 `openThumb` 仍会按需惰性生成，前端也有自愈重试，
   * 不能因为预热失败影响上传本身的成败。
   */
  private warmImageThumbnail(media: MediaRecord, mimeType: string) {
    if (!this.warmThumbnails || media.kind !== "image" || !mimeType.startsWith("image/")) return;
    void this.openThumb(media.ownerId, media.id, media.projectId ?? undefined)
      // 只需把派生对象写出去：读干净流，避免拿着未消费的 S3 socket。
      .then((content) => new Promise<void>((resolve) => {
        content.object.stream.on("error", () => resolve());
        content.object.stream.on("close", () => resolve());
        content.object.stream.resume();
      }))
      .catch(() => undefined);
  }

  private async handleUploadFailure(media: MediaRecord, error: unknown): Promise<never> {
    if (error instanceof MediaServiceError) throw error;
    if (error instanceof MediaInspectionError) {
      await this.objects.remove(media.objectKey).catch(() => undefined);
      await this.fail(media, error.code, error.message);
      throw new MediaServiceError(error.code, error.message, error.code === "MEDIA_TOO_LARGE" ? 413 : 422);
    }
    if (error instanceof MediaObjectWriteError) {
      if (error.definitive) {
        await this.objects.remove(media.objectKey).catch(() => undefined);
        await this.fail(media, error.code, error.message);
      } else {
        await this.reset(media);
      }
      throw new MediaServiceError(error.code, error.message, error.code === "MEDIA_TOO_LARGE" ? 413 : error.definitive ? 400 : 503);
    }
    await this.reset(media);
    throw new MediaServiceError("MEDIA_PROCESSING_UNAVAILABLE", "素材暂时无法处理，请重试", 503);
  }

  private async handleDirectUploadFailure(media: MediaRecord, error: unknown): Promise<never> {
    if (error instanceof MediaServiceError) throw error;
    if (!supportsDirectMediaAccess(this.objects)) throw error;
    if (error instanceof MediaInspectionError) {
      await this.objects.removePendingUpload(media.objectKey).catch(() => undefined);
      await this.fail(media, error.code, error.message);
      throw new MediaServiceError(error.code, error.message, error.code === "MEDIA_TOO_LARGE" ? 413 : 422);
    }
    if (error instanceof MediaObjectWriteError && error.definitive) {
      await this.objects.removePendingUpload(media.objectKey).catch(() => undefined);
      await this.fail(media, error.code, error.message);
      throw new MediaServiceError(error.code, error.message, error.code === "MEDIA_TOO_LARGE" ? 413 : 400);
    }
    await this.reset(media);
    const code = error instanceof MediaObjectWriteError ? error.code : "MEDIA_PROCESSING_UNAVAILABLE";
    const message = error instanceof MediaObjectWriteError ? error.message : "素材暂时无法处理，请重试";
    throw new MediaServiceError(code, message, 503);
  }

  private assertGeneratedIdentity(
    media: MediaRecord,
    input: { kind: MediaKind; name: string; mimeType: string; size: number; sha256: string },
  ) {
    const matches = media.source === "generation"
      && media.projectId === null
      && media.kind === input.kind
      && media.name === input.name
      && media.declaredMimeType === input.mimeType
      && media.expectedSize === input.size
      && media.expectedSha256 === input.sha256;
    if (!matches) throw new MediaServiceError("GENERATED_MEDIA_CONFLICT", "生成结果记录与当前任务不一致", 409);
  }

  private storageQuota(maxStorageBytes: number | undefined, now: number): MediaStorageQuota {
    const resolvedMaxStorageBytes = maxStorageBytes ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(resolvedMaxStorageBytes) || resolvedMaxStorageBytes < 0) {
      throw new Error("maxStorageBytes must be a non-negative safe integer");
    }
    return {
      maxStorageBytes: resolvedMaxStorageBytes,
      evaluatedAt: new Date(now).toISOString(),
      staleUploadingBefore: new Date(now - this.uploadProcessingTimeoutMs).toISOString(),
    };
  }

  private async releaseEvictedObjects(evicted: MediaEvictionItem[]) {
    // 数据库记录已在提交事务里删除；对象删除尽力而为，失败不影响配额回收。
    void Promise.all(evicted.map((item) => this.removeMediaObjects(item)));
  }

  /**
   * 清扫任务用的对象释放入口：enforceQuotaAfterGrace 返回的已删记录对应
   * 对象（含缩略图）尽力删除，失败仅记录——配额回收以数据库记录为准。
   */
  async releaseEvictedForSweep(evicted: MediaEvictionItem[]) {
    await Promise.all(evicted.map((item) => this.removeMediaObjects(item)));
  }

  /** 删除主对象时一并清理缩略图派生对象；两步都尽力而为。 */
  private async removeMediaObjects(item: { objectKey: string }) {
    await this.objects.remove(item.objectKey).catch(() => undefined);
    await this.objects.remove(thumbObjectKey(item.objectKey)).catch(() => undefined);
  }

  private async fail(media: MediaRecord, code: string, message: string) {
    const timestamp = new Date(this.now()).toISOString();
    const failed: MediaRecord = {
      ...media,
      status: "failed",
      error: { code, message },
      revision: media.revision + 1,
      updatedAt: timestamp,
      readyAt: null,
    };
    return this.metadata.markFailed(failed, media.revision);
  }

  private async reset(media: MediaRecord) {
    await this.metadata.resetUpload(media.id, media.ownerId, media.revision, new Date(this.now()).toISOString());
  }
}

function intent(media: MediaRecord) {
  return {
    media: toPublicMedia(media),
    uploadRequired: media.status === "pending",
    uploadExpiresAt: media.uploadExpiresAt,
    contentType: media.declaredMimeType,
  };
}

export function toPublicMedia(media: MediaRecord): PublicMedia {
  return publicMediaSchema.parse({
    id: media.id,
    kind: media.kind,
    name: media.name,
    mimeType: media.detectedMimeType ?? media.declaredMimeType,
    size: media.size ?? media.expectedSize,
    sha256: media.sha256,
    width: media.width,
    height: media.height,
    durationMs: media.durationMs,
    status: media.status,
    error: media.error,
    createdAt: media.createdAt,
    updatedAt: media.updatedAt,
  });
}

function assertAcceptedInput(input: MediaUploadRequest, maxBytes: number) {
  const mimeType = canonicalMimeType(input.mimeType);
  if (!ACCEPTED_MIME_TYPES[input.kind].has(mimeType)) {
    throw new MediaServiceError("MEDIA_TYPE_UNAVAILABLE", "当前素材格式无法安全处理", 415);
  }
  if (input.size > maxBytes) throw new MediaServiceError("MEDIA_TOO_LARGE", "素材大小超过当前限制", 413);
}

function safeName(value: string) {
  const sanitized = value.replace(/[\\/\u0000-\u001f\u007f]/g, "_").trim();
  return (sanitized || "未命名素材").slice(0, 255);
}

function safeFailureCode(value: string) {
  const normalized = value.replace(/[^A-Z0-9_:-]+/gi, "_").slice(0, 128);
  return normalized || "MEDIA_UPLOAD_FAILED";
}

function safeFailureMessage(value: string) {
  return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 1_000) || "素材上传失败";
}

function canonicalMimeType(value: string) {
  const normalized = value.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  if (normalized === "image/jpg") return "image/jpeg";
  if (normalized === "audio/x-wav") return "audio/wav";
  return normalized;
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function bufferToAsyncIterable(buffer: Buffer): AsyncIterable<Uint8Array> {
  async function* iterate() {
    yield new Uint8Array(buffer);
  }
  return iterate();
}

async function digestLocalFile(path: string, maxBytes: number): Promise<MediaObjectWriteResult> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size <= 0) {
    throw new MediaInspectionError("MEDIA_BODY_EMPTY", "上传内容为空");
  }
  if (metadata.size > maxBytes) throw new MediaInspectionError("MEDIA_TOO_LARGE", "素材大小超过当前限制");
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw new MediaInspectionError("MEDIA_TOO_LARGE", "素材大小超过当前限制");
    hash.update(bytes);
  }
  if (size !== metadata.size) throw new MediaInspectionError("MEDIA_VALIDATION_MISMATCH", "素材校验结果不一致");
  return { size, sha256: hash.digest("hex") };
}
