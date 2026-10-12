import { randomUUID } from "node:crypto";

import {
  MEDIA_MULTIPART_MAX_PARTS,
  MEDIA_MULTIPART_PART_SIZE,
  MEDIA_MULTIPART_THRESHOLD,
  mediaMultipartPartInstructionsResponseSchema,
  mediaMultipartUploadStateSchema,
  type MediaMultipartUploadInstruction,
  type MediaMultipartUploadState,
  type MediaMultipartUploadedPart,
} from "@weftcanvas/contracts";

import {
  type MediaMultipartScope,
  type MediaMultipartSession,
  type MediaMultipartUploadStore,
} from "./postgres-multipart-store.js";
import { MediaService, MediaServiceError, toPublicMedia } from "./service.js";
import type {
  MediaMetadataStore,
  MediaMultipartObjectPart,
  MediaRecord,
  MultipartMediaObjectStore,
} from "./types.js";

const DEFAULT_PART_INSTRUCTION_TTL_MS = 15 * 60_000;
const DEFAULT_COMPLETION_STALE_MS = 2 * 60_000;

type MediaMultipartServiceOptions = {
  now?: () => number;
  createId?: () => string;
  partInstructionTtlMs?: number;
  completionStaleMs?: number;
};

export class MediaMultipartService {
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly partInstructionTtlMs: number;
  private readonly completionStaleMs: number;

  constructor(
    private readonly sessions: MediaMultipartUploadStore,
    private readonly metadata: MediaMetadataStore,
    private readonly objects: MultipartMediaObjectStore,
    private readonly media: Pick<MediaService, "failUploadSafely" | "cancelUploadSafely">,
    options: MediaMultipartServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.partInstructionTtlMs = positiveInteger(
      options.partInstructionTtlMs ?? DEFAULT_PART_INSTRUCTION_TTL_MS,
      "partInstructionTtlMs",
    );
    this.completionStaleMs = positiveInteger(
      options.completionStaleMs ?? DEFAULT_COMPLETION_STALE_MS,
      "completionStaleMs",
    );
  }

  async createUpload(
    ownerId: string,
    mediaId: string,
    projectId?: string,
  ): Promise<MediaMultipartUploadInstruction | null> {
    const media = await this.requireMedia(ownerId, mediaId, projectId);
    if (media.status !== "pending" || media.expectedSize < MEDIA_MULTIPART_THRESHOLD) return null;
    const partCount = Math.ceil(media.expectedSize / MEDIA_MULTIPART_PART_SIZE);
    if (partCount > MEDIA_MULTIPART_MAX_PARTS) {
      throw new MediaServiceError("MEDIA_TOO_LARGE", "素材大小超过分片上传限制", 413);
    }

    const existing = await this.sessions.getByMedia(media.id);
    if (existing) {
      this.assertSessionScope(existing, ownerId, media.id, projectId);
      return instruction(existing);
    }

    const uploadExpiresAt = Date.parse(media.uploadExpiresAt);
    const startedAt = this.now();
    if (uploadExpiresAt <= startedAt) await this.failExpiredUpload(media);

    const sessionId = newSessionId(this.createId());
    const started = await this.objects.createMultipartUpload(media.objectKey, {
      contentType: media.declaredMimeType,
      sessionId,
    });
    const createdAt = this.now();
    if (uploadExpiresAt <= createdAt) {
      await this.objects
        .abortMultipartUpload(media.objectKey, started.providerUploadId)
        .catch(() => undefined);
      await this.failExpiredUpload(media);
    }
    const timestamp = new Date(createdAt).toISOString();
    const candidate: MediaMultipartSession = {
      mediaId: media.id,
      ownerId,
      projectId: projectId ?? null,
      sessionId,
      storageUploadId: started.providerUploadId,
      partSize: MEDIA_MULTIPART_PART_SIZE,
      partCount,
      status: "active",
      revision: 0,
      expiresAt: media.uploadExpiresAt,
      assembledAt: null,
      terminalAt: null,
      nextAttemptAt: null,
      attemptCount: 0,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    let saved: Awaited<ReturnType<MediaMultipartUploadStore["create"]>>;
    try {
      saved = await this.sessions.create(candidate);
    } catch (error) {
      const recovered = await this.sessions.getByMedia(media.id).catch(() => null);
      if (
        recovered &&
        recovered.sessionId === candidate.sessionId &&
        recovered.storageUploadId === candidate.storageUploadId &&
        recovered.ownerId === candidate.ownerId &&
        recovered.projectId === candidate.projectId
      ) {
        return instruction(recovered);
      }
      await this.objects
        .abortMultipartUpload(media.objectKey, started.providerUploadId)
        .catch(() => undefined);
      throw error;
    }
    if (saved.kind === "existing") {
      await this.objects
        .abortMultipartUpload(media.objectKey, started.providerUploadId)
        .catch(() => undefined);
      this.assertSessionScope(saved.session, ownerId, media.id, projectId);
    }
    return instruction(saved.session);
  }

  async signParts(
    ownerId: string,
    mediaId: string,
    sessionId: string,
    partNumbers: readonly number[],
    projectId?: string,
  ) {
    const { session, media } = await this.requireSessionAndMedia(
      ownerId,
      mediaId,
      sessionId,
      projectId,
    );
    const current = await this.expireActiveSession(session, media);
    if (current.status !== "active") {
      throw new MediaServiceError(
        "MEDIA_MULTIPART_NOT_ACTIVE",
        "分片上传会话已不再接受新分片",
        409,
      );
    }
    const sorted = [...partNumbers].sort((left, right) => left - right);
    if (!sorted.length || new Set(sorted).size !== sorted.length) {
      throw new MediaServiceError(
        "MEDIA_MULTIPART_PARTS_INVALID",
        "分片编号必须唯一且不能为空",
        400,
      );
    }
    if (
      sorted.some(
        (partNumber) =>
          !Number.isInteger(partNumber) || partNumber < 1 || partNumber > current.partCount,
      )
    ) {
      throw new MediaServiceError("MEDIA_MULTIPART_PART_INVALID", "分片编号超出当前文件范围", 400);
    }
    const expiresAt = new Date(
      Math.min(Date.parse(current.expiresAt), this.now() + this.partInstructionTtlMs),
    ).toISOString();
    const parts = await Promise.all(
      sorted.map(async (partNumber) => {
        const signed = await this.objects.createMultipartPartUploadInstruction(
          media.objectKey,
          current.storageUploadId,
          {
            partNumber,
            contentLength: expectedPartSize(media.expectedSize, current, partNumber),
            expiresAt,
          },
        );
        return { partNumber, ...signed };
      }),
    );
    return mediaMultipartPartInstructionsResponseSchema.parse({
      ok: true,
      data: { sessionId: current.sessionId, parts },
    });
  }

  async getState(
    ownerId: string,
    mediaId: string,
    sessionId: string,
    projectId?: string,
  ): Promise<MediaMultipartUploadState> {
    const loaded = await this.requireSessionAndMedia(ownerId, mediaId, sessionId, projectId);
    let session = await this.expireActiveSession(loaded.session, loaded.media);
    if (session.status === "completing") {
      try {
        session = await this.recoverCompleting(session, loaded.media);
      } catch (error) {
        if (!(error instanceof MediaServiceError) || error.code !== "MEDIA_MULTIPART_IN_PROGRESS")
          throw error;
      }
    }
    const media = await this.requireMedia(ownerId, mediaId, projectId);
    return this.state(session, media, await this.uploadedParts(session, media));
  }

  async complete(
    ownerId: string,
    mediaId: string,
    sessionId: string,
    projectId?: string,
  ): Promise<MediaMultipartUploadState> {
    const loaded = await this.requireSessionAndMedia(ownerId, mediaId, sessionId, projectId);
    let session = await this.expireActiveSession(loaded.session, loaded.media);
    if (["queued", "processing", "completed", "failed", "aborted"].includes(session.status)) {
      const media = await this.requireMedia(ownerId, mediaId, projectId);
      return this.state(session, media, await this.uploadedParts(session, media));
    }
    if (session.status === "completing") {
      session = await this.recoverCompleting(session, loaded.media);
      return this.state(
        session,
        await this.requireMedia(ownerId, mediaId, projectId),
        await this.uploadedParts(session, loaded.media),
      );
    }

    const alreadyAssembled = await this.recoverActiveAssembled(session, loaded.media);
    if (alreadyAssembled) {
      return this.state(
        alreadyAssembled,
        await this.requireMedia(ownerId, mediaId, projectId),
        await this.uploadedParts(alreadyAssembled, loaded.media),
      );
    }

    const parts = await this.objects.listMultipartUploadParts(
      loaded.media.objectKey,
      session.storageUploadId,
    );
    const validatedParts = this.requireCompleteParts(session, loaded.media, parts);
    const scope = sessionScope(session);
    const claimed = await this.sessions.claimCompleting(
      scope,
      session.revision,
      new Date(this.now()).toISOString(),
    );
    if (!claimed) {
      const latest = await this.requireSession(scope);
      if (latest.status === "active") {
        throw new MediaServiceError(
          "MEDIA_MULTIPART_CONFLICT",
          "分片上传状态已更新，请重新确认",
          409,
        );
      }
      if (latest.status === "completing")
        session = await this.recoverCompleting(latest, loaded.media);
      else session = latest;
      return this.state(
        session,
        await this.requireMedia(ownerId, mediaId, projectId),
        await this.uploadedParts(session, loaded.media),
      );
    }

    try {
      const assembled = await this.objects.completeMultipartUpload(
        loaded.media.objectKey,
        claimed.storageUploadId,
        validatedParts,
      );
      this.assertAssembled(claimed, loaded.media, assembled);
      session = await this.queueAssembled(claimed);
    } catch {
      session = await this.recoverAfterCompleteError(claimed, loaded.media);
    }
    const media = await this.requireMedia(ownerId, mediaId, projectId);
    return this.state(session, media, await this.uploadedParts(session, media));
  }

  async abort(
    ownerId: string,
    mediaId: string,
    sessionId: string,
    projectId?: string,
  ): Promise<MediaMultipartUploadState> {
    const loaded = await this.requireSessionAndMedia(ownerId, mediaId, sessionId, projectId);
    if (["completed", "failed", "aborted"].includes(loaded.session.status)) {
      const media = await this.requireMedia(ownerId, mediaId, projectId);
      return this.state(loaded.session, media, await this.uploadedParts(loaded.session, media));
    }
    if (loaded.session.status !== "active") {
      throw new MediaServiceError(
        "MEDIA_MULTIPART_IN_PROGRESS",
        "分片已经合并并进入校验，当前不能取消",
        409,
      );
    }
    const timestamp = new Date(this.now()).toISOString();
    const aborted = await this.sessions.markAborted(
      sessionScope(loaded.session),
      loaded.session.revision,
      timestamp,
    );
    if (!aborted) {
      const latest = await this.requireSession(sessionScope(loaded.session));
      if (latest.status !== "aborted") {
        throw new MediaServiceError(
          "MEDIA_MULTIPART_CONFLICT",
          "分片上传状态已更新，请刷新后重试",
          409,
        );
      }
      return this.state(latest, await this.requireMedia(ownerId, mediaId, projectId), []);
    }
    await this.objects
      .abortMultipartUpload(loaded.media.objectKey, aborted.storageUploadId)
      .catch(() => undefined);
    await this.media.cancelUploadSafely(ownerId, mediaId, projectId);
    return this.state(aborted, await this.requireMedia(ownerId, mediaId, projectId), []);
  }

  private async recoverCompleting(session: MediaMultipartSession, media: MediaRecord) {
    try {
      const assembled = await this.objects.headPendingMultipartUpload(media.objectKey);
      this.assertAssembled(session, media, assembled);
    } catch (error) {
      if (!isMissingObjectError(error)) {
        if (error instanceof MediaServiceError) return this.failAssembled(session, media, error);
        throw new MediaServiceError(
          "MEDIA_MULTIPART_FINALIZATION_UNCONFIRMED",
          "分片已经提交，正在确认合并结果",
          503,
        );
      }
      if (this.now() - Date.parse(session.updatedAt) >= this.completionStaleMs) {
        const reset = await this.sessions.resetActive(
          sessionScope(session),
          session.revision,
          new Date(this.now()).toISOString(),
        );
        if (!reset) return this.requireSession(sessionScope(session));
        throw new MediaServiceError(
          "MEDIA_MULTIPART_RETRY_REQUIRED",
          "分片合并未开始，请重试",
          503,
        );
      }
      throw new MediaServiceError("MEDIA_MULTIPART_IN_PROGRESS", "分片正在合并，请稍后重试", 503);
    }
    return this.queueAssembled(session);
  }

  private async recoverActiveAssembled(session: MediaMultipartSession, media: MediaRecord) {
    try {
      const assembled = await this.objects.headPendingMultipartUpload(media.objectKey);
      this.assertAssembled(session, media, assembled);
    } catch (error) {
      if (isMissingObjectError(error)) return null;
      if (error instanceof MediaServiceError) return this.failAssembled(session, media, error);
      throw new MediaServiceError(
        "MEDIA_MULTIPART_FINALIZATION_UNCONFIRMED",
        "正在确认先前的分片合并结果",
        503,
      );
    }
    const claimed = await this.sessions.claimCompleting(
      sessionScope(session),
      session.revision,
      new Date(this.now()).toISOString(),
    );
    if (!claimed) return this.requireSession(sessionScope(session));
    return this.queueAssembled(claimed);
  }

  private async recoverAfterCompleteError(session: MediaMultipartSession, media: MediaRecord) {
    try {
      const assembled = await this.objects.headPendingMultipartUpload(media.objectKey);
      this.assertAssembled(session, media, assembled);
    } catch (headError) {
      if (headError instanceof MediaServiceError)
        return this.failAssembled(session, media, headError);
      if (isMissingObjectError(headError)) {
        const reset = await this.sessions.resetActive(
          sessionScope(session),
          session.revision,
          new Date(this.now()).toISOString(),
        );
        if (!reset) return this.requireSession(sessionScope(session));
      }
      throw new MediaServiceError(
        "MEDIA_MULTIPART_FINALIZATION_UNCONFIRMED",
        "分片合并结果暂时无法确认，请重试",
        503,
      );
    }
    return this.queueAssembled(session);
  }

  private async queueAssembled(session: MediaMultipartSession) {
    const timestamp = new Date(this.now()).toISOString();
    const queued = await this.sessions.markQueued(
      sessionScope(session),
      session.revision,
      timestamp,
      timestamp,
    );
    if (queued) return queued;
    const latest = await this.requireSession(sessionScope(session));
    if (["queued", "processing", "completed"].includes(latest.status)) return latest;
    throw new MediaServiceError(
      "MEDIA_MULTIPART_CONFLICT",
      "分片合并状态无法确认，请刷新后重试",
      409,
    );
  }

  private async failAssembled(
    session: MediaMultipartSession,
    media: MediaRecord,
    error: MediaServiceError,
  ) {
    await this.objects.removePendingUpload(media.objectKey).catch(() => undefined);
    const timestamp = new Date(this.now()).toISOString();
    const failed =
      (await this.sessions.markFailed(
        sessionScope(session),
        session.revision,
        timestamp,
        error.code,
        error.message,
      )) ?? (await this.requireSession(sessionScope(session)));
    await this.media.failUploadSafely(
      session.ownerId,
      session.mediaId,
      error.code,
      error.message,
      session.projectId ?? undefined,
    );
    return failed;
  }

  private assertAssembled(
    session: MediaMultipartSession,
    media: MediaRecord,
    assembled: { size: number; sessionId: string },
  ) {
    if (assembled.sessionId !== session.sessionId) {
      throw new MediaServiceError(
        "MEDIA_MULTIPART_SESSION_MISMATCH",
        "合并对象与上传会话不一致",
        422,
      );
    }
    if (assembled.size !== media.expectedSize) {
      throw new MediaServiceError("MEDIA_SIZE_MISMATCH", "合并对象大小与素材信息不一致", 422);
    }
  }

  private requireCompleteParts(
    session: MediaMultipartSession,
    media: MediaRecord,
    parts: readonly MediaMultipartObjectPart[],
  ) {
    if (parts.length !== session.partCount) {
      throw new MediaServiceError("MEDIA_MULTIPART_INCOMPLETE", "仍有分片尚未上传", 409);
    }
    for (let index = 0; index < session.partCount; index += 1) {
      const partNumber = index + 1;
      const part = parts[index];
      if (
        !part ||
        part.partNumber !== partNumber ||
        part.size !== expectedPartSize(media.expectedSize, session, partNumber)
      ) {
        throw new MediaServiceError(
          "MEDIA_MULTIPART_INCOMPLETE",
          "分片列表不完整或大小不匹配",
          409,
        );
      }
    }
    return parts;
  }

  private async uploadedParts(session: MediaMultipartSession, media: MediaRecord) {
    if (
      ["completing", "queued", "processing", "completed"].includes(session.status) ||
      media.status === "ready"
    ) {
      return allUploadedParts(session, media.expectedSize);
    }
    if (session.status !== "active" && session.status !== "completing") return [];
    const parts = await this.objects.listMultipartUploadParts(
      media.objectKey,
      session.storageUploadId,
    );
    return parts.flatMap((part) =>
      part.partNumber <= session.partCount &&
      part.size === expectedPartSize(media.expectedSize, session, part.partNumber)
        ? [{ partNumber: part.partNumber, size: part.size }]
        : [],
    );
  }

  private state(
    session: MediaMultipartSession,
    media: MediaRecord,
    uploadedParts: MediaMultipartUploadedPart[],
  ) {
    return mediaMultipartUploadStateSchema.parse({
      sessionId: session.sessionId,
      phase: phase(session, media),
      partSize: session.partSize,
      partCount: session.partCount,
      uploadedParts,
      expiresAt: session.expiresAt,
      media: toPublicMedia(media),
    });
  }

  private async expireActiveSession(session: MediaMultipartSession, media: MediaRecord) {
    if (session.status !== "active" || Date.parse(session.expiresAt) > this.now()) return session;
    const timestamp = new Date(this.now()).toISOString();
    const aborted = await this.sessions.markAborted(
      sessionScope(session),
      session.revision,
      timestamp,
    );
    if (!aborted) return this.requireSession(sessionScope(session));
    await this.objects
      .abortMultipartUpload(media.objectKey, session.storageUploadId)
      .catch(() => undefined);
    await this.media.failUploadSafely(
      session.ownerId,
      session.mediaId,
      "MEDIA_UPLOAD_EXPIRED",
      "上传已过期，请重新选择素材",
      session.projectId ?? undefined,
    );
    return aborted;
  }

  private async failExpiredUpload(media: MediaRecord): Promise<never> {
    await this.media.failUploadSafely(
      media.ownerId,
      media.id,
      "MEDIA_UPLOAD_EXPIRED",
      "上传已过期，请重新选择素材",
      media.projectId ?? undefined,
    );
    throw new MediaServiceError("MEDIA_UPLOAD_EXPIRED", "上传已过期，请重新选择素材", 409);
  }

  private async requireSessionAndMedia(
    ownerId: string,
    mediaId: string,
    sessionId: string,
    projectId?: string,
  ) {
    const scope = {
      ownerId,
      mediaId,
      sessionId: requestedSessionId(sessionId),
      projectId: projectId ?? null,
    };
    const [session, media] = await Promise.all([
      this.sessions.getByScope(scope),
      this.metadata.getByAccessScope(mediaId, ownerId, projectId ?? null),
    ]);
    if (!session || !media) throw notFound();
    return { session, media };
  }

  private async requireSession(scope: MediaMultipartScope) {
    const session = await this.sessions.getByScope(scope);
    if (!session) throw notFound();
    return session;
  }

  private async requireMedia(ownerId: string, mediaId: string, projectId?: string) {
    const media = await this.metadata.getByAccessScope(mediaId, ownerId, projectId ?? null);
    if (!media) throw notFound();
    return media;
  }

  private assertSessionScope(
    session: MediaMultipartSession,
    ownerId: string,
    mediaId: string,
    projectId?: string,
  ) {
    if (
      session.ownerId !== ownerId ||
      session.mediaId !== mediaId ||
      session.projectId !== (projectId ?? null)
    ) {
      throw notFound();
    }
  }
}

function instruction(session: MediaMultipartSession): MediaMultipartUploadInstruction {
  const base = `/api/v1/media/${encodeURIComponent(session.mediaId)}/multipart/${encodeURIComponent(session.sessionId)}`;
  return {
    strategy: "multipart",
    sessionId: session.sessionId,
    partSize: MEDIA_MULTIPART_PART_SIZE,
    partCount: session.partCount,
    expiresAt: session.expiresAt,
    signPartsUrl: `${base}/parts`,
    reconcileUrl: base,
    completeUrl: `${base}/complete`,
    abortUrl: base,
  };
}

function sessionScope(session: MediaMultipartSession): MediaMultipartScope {
  return {
    mediaId: session.mediaId,
    ownerId: session.ownerId,
    projectId: session.projectId,
    sessionId: session.sessionId,
  };
}

function expectedPartSize(
  expectedSize: number,
  session: Pick<MediaMultipartSession, "partCount" | "partSize">,
  partNumber: number,
) {
  if (partNumber < session.partCount) return session.partSize;
  return expectedSize - session.partSize * (session.partCount - 1);
}

function allUploadedParts(session: MediaMultipartSession, expectedSize: number) {
  return Array.from({ length: session.partCount }, (_, index) => ({
    partNumber: index + 1,
    size: expectedPartSize(expectedSize, session, index + 1),
  }));
}

function phase(
  session: MediaMultipartSession,
  media: MediaRecord,
): MediaMultipartUploadState["phase"] {
  if (media.status === "ready") return "ready";
  if (media.status === "failed" && session.status !== "aborted") return "failed";
  if (session.status === "active") return "uploading";
  if (session.status === "completing") return "assembling";
  if (session.status === "queued" || session.status === "processing") return "inspecting";
  if (session.status === "completed") return "ready";
  return session.status;
}

function isMissingObjectError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    name?: unknown;
    code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    value.$metadata?.httpStatusCode === 404 ||
    value.name === "NotFound" ||
    value.name === "NoSuchKey" ||
    value.code === "NotFound" ||
    value.code === "NoSuchKey"
  );
}

function notFound() {
  return new MediaServiceError("MEDIA_MULTIPART_NOT_FOUND", "没有找到这个分片上传会话", 404);
}

function requestedSessionId(value: string) {
  if (!isSessionId(value)) throw notFound();
  return value.toLowerCase();
}

function newSessionId(value: string) {
  if (!isSessionId(value))
    throw new Error("Multipart session id generator returned an invalid UUID");
  return value.toLowerCase();
}

function isSessionId(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive safe integer`);
  return value;
}
