import {
  mediaProjectIdSchema,
  publicMediaErrorSchema,
  type MediaKind,
  type PublicMedia,
} from "@weftcanvas/contracts";
import type { Readable } from "node:stream";
import { z } from "zod";

export const mediaRecordSchema = z.object({
  id: z.string().uuid(),
  ownerId: z.string().min(1),
  projectId: mediaProjectIdSchema.nullable(),
  source: z.enum(["upload", "generation"]),
  idempotencyKey: z.string().min(1).nullable(),
  objectKey: z.string().min(1),
  kind: z.enum(["image", "video", "audio"]),
  name: z.string().min(1).max(255),
  declaredMimeType: z.string().min(1),
  detectedMimeType: z.string().min(1).nullable(),
  expectedSize: z.number().int().positive(),
  size: z.number().int().nonnegative().nullable(),
  expectedSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  durationMs: z.number().int().positive().nullable(),
  status: z.enum(["pending", "uploading", "ready", "failed"]),
  error: publicMediaErrorSchema.nullable(),
  revision: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  uploadExpiresAt: z.string().datetime({ offset: true }),
  readyAt: z.string().datetime({ offset: true }).nullable(),
});
export type MediaRecord = z.infer<typeof mediaRecordSchema>;

export type MediaEvictionItem = {
  id: string;
  objectKey: string;
};

export type CreateMediaResult =
  | { kind: "created"; media: MediaRecord; evicted?: MediaEvictionItem[] }
  | { kind: "existing"; media: MediaRecord }
  | { kind: "storage_limit"; usedBytes: number; limitBytes: number }
  | { kind: "intent_limit"; currentRecords: number; limit: number };

export type DeleteOwnedMediaResult =
  { kind: "deleted"; media: MediaRecord } | { kind: "bound" } | { kind: "missing" };

export const mediaStorageQuotaSchema = z
  .object({
    maxStorageBytes: z.number().int().nonnegative(),
    evaluatedAt: z.string().datetime({ offset: true }),
    staleUploadingBefore: z.string().datetime({ offset: true }),
  })
  .refine((value) => Date.parse(value.staleUploadingBefore) <= Date.parse(value.evaluatedAt), {
    message: "staleUploadingBefore must not be later than evaluatedAt",
  });
export type MediaStorageQuota = z.infer<typeof mediaStorageQuotaSchema>;

export interface MediaMetadataStore {
  findByIdempotency(ownerId: string, idempotencyKey: string): Promise<MediaRecord | null>;
  getById(id: string): Promise<MediaRecord | null>;
  getByAccessScope(
    id: string,
    ownerId: string,
    projectId: string | null,
  ): Promise<MediaRecord | null>;
  create(media: MediaRecord, quota?: MediaStorageQuota): Promise<CreateMediaResult>;
  deleteOwned(id: string, ownerId: string): Promise<DeleteOwnedMediaResult>;
  claimUpload(
    id: string,
    ownerId: string,
    expectedRevision: number,
    updatedAt: string,
  ): Promise<MediaRecord | null>;
  resetUpload(
    id: string,
    ownerId: string,
    expectedRevision: number,
    updatedAt: string,
  ): Promise<MediaRecord | null>;
  markReady(media: MediaRecord, expectedRevision: number): Promise<MediaRecord | null>;
  markFailed(media: MediaRecord, expectedRevision: number): Promise<MediaRecord | null>;
}

export type MediaObjectWriteResult = {
  size: number;
  sha256: string;
};

export type MediaObjectRead = {
  stream: Readable;
  totalSize: number;
  start: number;
  end: number;
};

export interface MediaObjectStore {
  write(
    key: string,
    source: AsyncIterable<Uint8Array>,
    options: { expectedSize: number; maxBytes: number; contentType?: string },
  ): Promise<MediaObjectWriteResult>;
  withLocalFile<T>(key: string, action: (path: string) => Promise<T>): Promise<T>;
  open(
    key: string,
    range?: { start: number; end: number },
    signal?: AbortSignal,
  ): Promise<MediaObjectRead>;
  remove(key: string): Promise<void>;
}

export interface MaintainableMediaObjectStore extends MediaObjectStore {
  cleanupTemporaryFiles(olderThanMs: number): Promise<number>;
}

export type MediaPrivateDownloadInstruction = {
  url: string;
  expiresAt: string;
};

export type MediaObjectUploadInstruction = {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
};

export interface DirectMediaObjectStore extends MediaObjectStore {
  createUploadInstruction(
    key: string,
    options: {
      contentType: string;
      contentLength: number;
      sha256: string | null;
      expiresAt: string;
    },
  ): Promise<MediaObjectUploadInstruction>;
  createDownloadInstruction(
    key: string,
    options: { contentType: string; name: string },
  ): Promise<MediaPrivateDownloadInstruction>;
  withPendingUploadFile<T>(
    key: string,
    action: (file: { path: string; versionToken: string }) => Promise<T>,
  ): Promise<T>;
  promotePendingUpload(
    key: string,
    options: { contentType: string; size: number; sha256: string; versionToken: string },
  ): Promise<void>;
  removePendingUpload(key: string): Promise<void>;
}

export type MediaMultipartObjectPart = {
  partNumber: number;
  size: number;
  versionToken: string;
};

export type MediaPendingMultipartObject = {
  size: number;
  versionToken: string;
  sessionId: string;
};

export interface MultipartMediaObjectStore extends DirectMediaObjectStore {
  createMultipartUpload(
    key: string,
    options: { contentType: string; sessionId: string },
  ): Promise<{ providerUploadId: string }>;
  createMultipartPartUploadInstruction(
    key: string,
    providerUploadId: string,
    options: { partNumber: number; contentLength: number; expiresAt: string },
  ): Promise<MediaObjectUploadInstruction>;
  listMultipartUploadParts(
    key: string,
    providerUploadId: string,
  ): Promise<MediaMultipartObjectPart[]>;
  completeMultipartUpload(
    key: string,
    providerUploadId: string,
    parts: readonly MediaMultipartObjectPart[],
  ): Promise<MediaPendingMultipartObject>;
  abortMultipartUpload(key: string, providerUploadId: string): Promise<void>;
  headPendingMultipartUpload(key: string): Promise<MediaPendingMultipartObject>;
}

export function supportsDirectMediaAccess(
  store: MediaObjectStore,
): store is DirectMediaObjectStore {
  const candidate = store as Partial<DirectMediaObjectStore>;
  return (
    typeof candidate.createUploadInstruction === "function" &&
    typeof candidate.createDownloadInstruction === "function" &&
    typeof candidate.withPendingUploadFile === "function" &&
    typeof candidate.promotePendingUpload === "function" &&
    typeof candidate.removePendingUpload === "function"
  );
}

export function supportsMultipartMediaAccess(
  store: MediaObjectStore,
): store is MultipartMediaObjectStore {
  if (!supportsDirectMediaAccess(store)) return false;
  const candidate = store as Partial<MultipartMediaObjectStore>;
  return (
    typeof candidate.createMultipartUpload === "function" &&
    typeof candidate.createMultipartPartUploadInstruction === "function" &&
    typeof candidate.listMultipartUploadParts === "function" &&
    typeof candidate.completeMultipartUpload === "function" &&
    typeof candidate.abortMultipartUpload === "function" &&
    typeof candidate.headPendingMultipartUpload === "function"
  );
}

export function supportsMediaStoreMaintenance(
  store: MediaObjectStore,
): store is MaintainableMediaObjectStore {
  return (
    typeof (store as Partial<MaintainableMediaObjectStore>).cleanupTemporaryFiles === "function"
  );
}

export type InspectedMedia = {
  kind: MediaKind;
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
};

export interface MediaInspector {
  inspect(path: string, expectedKind: MediaKind): Promise<InspectedMedia>;
}

export type PublicMediaContent = {
  media: PublicMedia;
  object: MediaObjectRead;
};

/**
 * 对象存储操作失败。名字保留 Write 是历史原因，实际读写都复用它：
 * `definitive` 表示"这份素材本身不行，重试也不会变"（大小/校验/类型），
 * 非 definitive 一律按可重试处理；`code` 会原样成为对外的错误码。
 */
export class MediaObjectWriteError extends Error {
  constructor(
    readonly code:
      | "MEDIA_TOO_LARGE"
      | "MEDIA_SIZE_MISMATCH"
      | "MEDIA_UPLOAD_INTERRUPTED"
      /** 存储服务本身够不到（连接超时/被拒/DNS 失败），与素材内容无关。 */
      | "MEDIA_STORAGE_UNAVAILABLE",
    message: string,
    readonly definitive: boolean,
  ) {
    super(message);
    this.name = "MediaObjectWriteError";
  }
}

export class MediaInspectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MediaInspectionError";
  }
}
