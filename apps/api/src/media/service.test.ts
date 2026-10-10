import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";

import { MediaService } from "./service.js";
import {
  MediaInspectionError,
  MediaObjectWriteError,
  type CreateMediaResult,
  type InspectedMedia,
  type MediaInspector,
  type MediaMetadataStore,
  type MediaObjectRead,
  type MediaObjectStore,
  type MediaRecord,
} from "./types.js";

const NOW = Date.parse("2026-07-15T16:00:00.000Z");
const MEDIA_ID = "66666666-6666-4666-8666-666666666666";
const BYTES = Buffer.from("valid-image-bytes");

describe("media upload service", () => {
  it("creates an owner-scoped idempotent intent and publishes no object key", async () => {
    const metadata = new MemoryMetadataStore();
    const service = createService(metadata);
    const request = uploadRequest();

    const first = await service.createUpload("user-1", request);
    const second = await service.createUpload("user-1", request);

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      uploadRequired: true,
      media: { id: MEDIA_ID, status: "pending", mimeType: "image/png", size: BYTES.length },
    });
    expect(JSON.stringify(first)).not.toContain("objectKey");
    expect(metadata.records).toHaveLength(1);
  });

  it("rejects idempotency reuse with changed immutable input", async () => {
    const service = createService(new MemoryMetadataStore());
    await service.createUpload("user-1", uploadRequest());
    await expect(service.createUpload("user-1", { ...uploadRequest(), size: BYTES.length + 1 }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
  });

  it("deletes an unbound owned media and refuses bound or missing ids", async () => {
    const metadata = new MemoryMetadataStore();
    const objects = new MemoryObjectStore();
    const service = createService(metadata, objects);
    await service.createUpload("user-1", uploadRequest());
    metadata.records[0]!.status = "ready";
    metadata.records[0]!.size = BYTES.length;
    objects.seed(BYTES);

    const deleted = await service.delete("user-1", MEDIA_ID);
    expect(deleted).toMatchObject({ id: MEDIA_ID, status: "ready" });
    expect(metadata.records).toHaveLength(0);
    await expect(service.delete("user-1", MEDIA_ID))
      .rejects.toMatchObject({ code: "MEDIA_NOT_FOUND", status: 404 });

    await service.createUpload("user-1", uploadRequest());
    metadata.boundIds.add(MEDIA_ID);
    await expect(service.delete("user-1", MEDIA_ID))
      .rejects.toMatchObject({ code: "MEDIA_REFERENCED_BY_PROJECT", status: 409 });
  });

  it("streams, hashes, inspects, and publishes a ready media record", async () => {
    const metadata = new MemoryMetadataStore();
    const objects = new MemoryObjectStore();
    const service = createService(metadata, objects);
    await service.createUpload("user-1", uploadRequest());

    const ready = await service.upload("user-1", MEDIA_ID, chunks(BYTES), {
      contentType: "image/png",
      contentLength: BYTES.length,
    });

    expect(ready).toMatchObject({
      status: "ready",
      sha256: createHash("sha256").update(BYTES).digest("hex"),
      width: 64,
      height: 36,
    });
    expect(await service.get("user-1", MEDIA_ID)).toEqual(ready);
    expect((await service.open("user-1", MEDIA_ID)).media).toEqual(ready);
  });

  it("fails checksum and parse errors definitively and removes bytes", async () => {
    const metadata = new MemoryMetadataStore();
    const objects = new MemoryObjectStore();
    const service = createService(metadata, objects, new FixedInspector(new MediaInspectionError("MEDIA_INVALID", "图片内容无法解码")));
    await service.createUpload("user-1", uploadRequest());

    await expect(service.upload("user-1", MEDIA_ID, chunks(BYTES), {
      contentType: "image/png",
      contentLength: BYTES.length,
    })).rejects.toMatchObject({ code: "MEDIA_INVALID", status: 422 });
    expect(objects.bytes).toBeNull();
    expect(await service.get("user-1", MEDIA_ID)).toMatchObject({
      status: "failed",
      error: { code: "MEDIA_INVALID" },
    });
  });

  it("returns transient writes to pending so the same upload can retry", async () => {
    const metadata = new MemoryMetadataStore();
    const objects = new MemoryObjectStore();
    objects.nextError = new MediaObjectWriteError("MEDIA_UPLOAD_INTERRUPTED", "上传中断", false);
    const service = createService(metadata, objects);
    await service.createUpload("user-1", uploadRequest());

    await expect(service.upload("user-1", MEDIA_ID, chunks(BYTES), {
      contentType: "image/png",
      contentLength: BYTES.length,
    })).rejects.toMatchObject({ code: "MEDIA_UPLOAD_INTERRUPTED", status: 503 });
    expect(await service.get("user-1", MEDIA_ID)).toMatchObject({ status: "pending", error: null });
  });

  it("reconciles a ready transaction when its database response is lost", async () => {
    const metadata = new MemoryMetadataStore();
    metadata.commitReadyThenThrow = true;
    const objects = new MemoryObjectStore();
    const service = createService(metadata, objects);
    await service.createUpload("user-1", uploadRequest());

    await expect(service.upload("user-1", MEDIA_ID, chunks(BYTES), {
      contentType: "image/png",
      contentLength: BYTES.length,
    })).resolves.toMatchObject({ status: "ready" });
    expect(objects.bytes).toEqual(BYTES);
  });

  it("recovers an upload claim left stale by an unconfirmed database write", async () => {
    const metadata = new MemoryMetadataStore();
    metadata.failReadyBeforeCommit = true;
    const objects = new MemoryObjectStore();
    let now = NOW;
    const service = new MediaService(metadata, objects, new FixedInspector(), {
      now: () => now,
      createId: () => MEDIA_ID,
      uploadTtlMs: 60_000,
      uploadProcessingTimeoutMs: 1_000,
      limits: { image: 1024 },
    });
    await service.createUpload("user-1", uploadRequest());

    await expect(service.upload("user-1", MEDIA_ID, chunks(BYTES), {
      contentType: "image/png",
      contentLength: BYTES.length,
    })).rejects.toMatchObject({ code: "MEDIA_FINALIZATION_UNCONFIRMED", status: 503 });
    expect(await service.get("user-1", MEDIA_ID)).toMatchObject({ status: "uploading" });

    metadata.failReadyBeforeCommit = false;
    now += 1_001;
    await expect(service.upload("user-1", MEDIA_ID, chunks(BYTES), {
      contentType: "image/png",
      contentLength: BYTES.length,
    })).resolves.toMatchObject({ status: "ready" });
  });

  it("enforces type, size, and ownership before consuming content", async () => {
    const service = createService(new MemoryMetadataStore());
    await expect(service.createUpload("user-1", {
      ...uploadRequest(),
      mimeType: "image/svg+xml",
    })).rejects.toMatchObject({ code: "MEDIA_TYPE_UNAVAILABLE", status: 415 });
    await service.createUpload("user-1", uploadRequest());
    await expect(service.upload("user-2", MEDIA_ID, chunks(BYTES), {
      contentType: "image/png",
      contentLength: BYTES.length,
    })).rejects.toMatchObject({ code: "MEDIA_NOT_FOUND", status: 404 });
    await expect(service.upload("user-1", MEDIA_ID, chunks(BYTES), {
      contentType: "image/jpeg",
      contentLength: BYTES.length,
    })).rejects.toMatchObject({ code: "MEDIA_CONTENT_TYPE_MISMATCH", status: 415 });
  });

  it("persists generated media idempotently without requiring a browser upload intent", async () => {
    const metadata = new MemoryMetadataStore();
    const service = createService(metadata);
    const sha256 = createHash("sha256").update(BYTES).digest("hex");
    const first = await service.persistGenerated("user-1", {
      jobId: "job-1",
      index: 0,
      kind: "image",
      name: "result.png",
      mimeType: "image/png",
      size: BYTES.length,
      sha256,
      source: chunks(BYTES),
    });
    let consumed = false;
    const second = await service.persistGenerated("user-1", {
      jobId: "job-1",
      index: 0,
      kind: "image",
      name: "result.png",
      mimeType: "image/png",
      size: BYTES.length,
      sha256,
      source: (async function* () { consumed = true; yield BYTES; })(),
    });

    expect(first).toEqual(second);
    expect(first.status).toBe("ready");
    expect(consumed).toBe(false);
    expect(metadata.records[0]).toMatchObject({ source: "generation", status: "ready" });
  });

  it("recovers a stale generated-media upload without resubmitting generation", async () => {
    const metadata = new MemoryMetadataStore();
    metadata.failReadyBeforeCommit = true;
    const objects = new MemoryObjectStore();
    let now = NOW;
    const service = new MediaService(metadata, objects, new FixedInspector(), {
      now: () => now,
      createId: () => MEDIA_ID,
      uploadTtlMs: 60_000,
      uploadProcessingTimeoutMs: 15 * 60_000,
      generatedUploadProcessingTimeoutMs: 1_000,
      limits: { image: 1024 },
    });
    const input = {
      jobId: "job-1",
      index: 0,
      kind: "image" as const,
      name: "result.png",
      mimeType: "image/png",
      size: BYTES.length,
      sha256: createHash("sha256").update(BYTES).digest("hex"),
    };

    await expect(service.persistGenerated("user-1", { ...input, source: chunks(BYTES) }))
      .rejects.toMatchObject({ code: "MEDIA_FINALIZATION_UNCONFIRMED", status: 503 });
    expect(await service.get("user-1", MEDIA_ID)).toMatchObject({ status: "uploading" });

    metadata.failReadyBeforeCommit = false;
    now += 1_001;
    await expect(service.persistGenerated("user-1", { ...input, source: chunks(BYTES) }))
      .resolves.toMatchObject({ status: "ready" });
  });

  it("signs direct uploads, validates stored bytes, and signs ready downloads", async () => {
    const metadata = new MemoryMetadataStore();
    const objects = new MemoryDirectObjectStore();
    const service = createService(metadata, objects);
    const sha256 = createHash("sha256").update(BYTES).digest("hex");
    await service.createUpload("user-1", { ...uploadRequest(), sha256 });

    await expect(service.createDirectUploadInstruction("user-1", MEDIA_ID)).resolves.toEqual({
      method: "PUT",
      url: "https://objects.example.test/upload-capability",
      headers: { "Content-Type": "image/png" },
      expiresAt: new Date(NOW + 60_000).toISOString(),
    });
    expect(objects.uploadOptions).toEqual({
      contentType: "image/png",
      contentLength: BYTES.length,
      sha256,
      expiresAt: new Date(NOW + 60_000).toISOString(),
    });
    objects.seed(BYTES);

    await expect(service.completeDirectUpload("user-1", MEDIA_ID)).resolves.toMatchObject({
      status: "ready",
      sha256,
      width: 64,
      height: 36,
    });
    await expect(service.createPrivateDownload("user-1", MEDIA_ID)).resolves.toEqual({
      url: "https://objects.example.test/download-capability",
      expiresAt: new Date(NOW + 30_000).toISOString(),
    });
    expect(JSON.stringify(await service.get("user-1", MEDIA_ID))).not.toContain("objectKey");
  });

  it("keeps a direct upload pending when remote inspection is temporarily unavailable", async () => {
    const metadata = new MemoryMetadataStore();
    const objects = new MemoryDirectObjectStore();
    const service = createService(metadata, objects);
    await service.createUpload("user-1", uploadRequest());

    await expect(service.completeDirectUpload("user-1", MEDIA_ID)).rejects.toMatchObject({
      code: "MEDIA_PROCESSING_UNAVAILABLE",
      status: 503,
    });
    expect(await service.get("user-1", MEDIA_ID)).toMatchObject({ status: "pending", error: null });
    objects.seed(BYTES);
    await expect(service.completeDirectUpload("user-1", MEDIA_ID)).resolves.toMatchObject({ status: "ready" });
  });

  it("lazily generates a thumb variant, serves it from cache, and cleans it up with the media", async () => {
    const metadata = new MemoryMetadataStore();
    const objects = new MultiKeyObjectStore();
    const png = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 180, g: 120, b: 60 } } })
      .png()
      .toBuffer();
    objects.seed(png);
    const service = createService(metadata, objects, new FixedInspector({
      kind: "image",
      mimeType: "image/png",
      size: png.length,
      width: 640,
      height: 480,
      durationMs: null,
    }));
    await service.createUpload("user-1", { ...uploadRequest(), size: png.length });
    await service.upload("user-1", MEDIA_ID, chunks(png), {
      contentType: "image/png",
      contentLength: png.length,
    });

    const thumb = await service.openThumb("user-1", MEDIA_ID);
    expect(thumb.media.id).toBe(MEDIA_ID);
    const thumbBytes: Buffer[] = [];
    for await (const chunk of thumb.object.stream) thumbBytes.push(Buffer.from(chunk));
    const meta = await sharp(Buffer.concat(thumbBytes)).metadata();
    // 640 宽等比缩到 512×384。
    expect([meta.width, meta.height]).toEqual([512, 384]);
    const baseKey = objects.keyOf(MEDIA_ID);
    expect(objects.keys()).toContain(`${baseKey}-thumb`);

    // 第二次读取命中缓存：不再有新写入。
    const writesBefore = objects.writeCount;
    await service.openThumb("user-1", MEDIA_ID);
    expect(objects.writeCount).toBe(writesBefore);

    // 他人访问被拒。
    await expect(service.openThumb("user-2", MEDIA_ID)).rejects.toMatchObject({ code: "MEDIA_NOT_FOUND", status: 404 });

    // 删除主素材时缩略派生对象一并清理。
    await service.delete("user-1", MEDIA_ID);
    expect(objects.keys()).not.toContain(`${baseKey}-thumb`);
  });

  it("warms the display thumb in the background as soon as an image upload is ready", async () => {
    const metadata = new MemoryMetadataStore();
    const objects = new MultiKeyObjectStore();
    const png = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 10, g: 20, b: 30 } } })
      .png()
      .toBuffer();
    objects.seed(png);
    const service = createService(metadata, objects, new FixedInspector({
      kind: "image",
      mimeType: "image/png",
      size: png.length,
      width: 640,
      height: 480,
      durationMs: null,
    }), { warmThumbnails: true });
    await service.createUpload("user-1", { ...uploadRequest(), size: png.length });
    await service.upload("user-1", MEDIA_ID, chunks(png), {
      contentType: "image/png",
      contentLength: png.length,
    });

    // 上传响应不等预热；预热在后台把 512px 派生对象写出去，节点首屏命中缓存。
    const baseKey = objects.keyOf(MEDIA_ID);
    await vi.waitFor(() => expect(objects.keys()).toContain(`${baseKey}-thumb`));
  });

  it("refuses thumbs for non-image kinds", async () => {
    const metadata = new MemoryMetadataStore();
    const objects = new MultiKeyObjectStore();
    const service = createService(metadata, objects);
    await service.createUpload("user-1", { ...uploadRequest(), kind: "video", mimeType: "video/mp4" });
    metadata.records[0]!.status = "ready";
    await expect(service.openThumb("user-1", MEDIA_ID)).rejects.toMatchObject({ code: "MEDIA_THUMB_UNAVAILABLE", status: 404 });
  });
});

class MemoryMetadataStore implements MediaMetadataStore {
  records: MediaRecord[] = [];
  commitReadyThenThrow = false;
  failReadyBeforeCommit = false;

  async findByIdempotency(ownerId: string, idempotencyKey: string) {
    return clone(this.records.find((item) => item.ownerId === ownerId && item.idempotencyKey === idempotencyKey) ?? null);
  }

  async getById(id: string) {
    return clone(this.records.find((item) => item.id === id) ?? null);
  }

  async create(media: MediaRecord): Promise<CreateMediaResult> {
    const existing = this.records.find((item) => item.ownerId === media.ownerId && item.idempotencyKey === media.idempotencyKey);
    if (existing) return { kind: "existing", media: clone(existing)! };
    this.records.push(clone(media)!);
    return { kind: "created", media: clone(media)! };
  }

  boundIds = new Set<string>();

  async deleteOwned(id: string, ownerId: string) {
    const index = this.records.findIndex((item) => item.id === id && item.ownerId === ownerId);
    if (index < 0) return { kind: "missing" } as const;
    if (this.boundIds.has(id)) return { kind: "bound" } as const;
    const [media] = this.records.splice(index, 1);
    return { kind: "deleted", media: clone(media)! } as const;
  }

  async claimUpload(id: string, ownerId: string, revision: number, updatedAt: string) {
    return this.transition(id, ownerId, revision, "pending", { status: "uploading", updatedAt });
  }

  async resetUpload(id: string, ownerId: string, revision: number, updatedAt: string) {
    return this.transition(id, ownerId, revision, "uploading", { status: "pending", updatedAt });
  }

  async markReady(media: MediaRecord, revision: number) {
    if (this.failReadyBeforeCommit) throw new Error("database unavailable before commit");
    const saved = this.replace(media, revision, "uploading");
    if (saved && this.commitReadyThenThrow) throw new Error("database response lost");
    return saved;
  }

  async markFailed(media: MediaRecord, revision: number) {
    return this.replace(media, revision, this.records.find((item) => item.id === media.id)?.status);
  }

  private transition(
    id: string,
    ownerId: string,
    revision: number,
    status: MediaRecord["status"],
    change: Pick<MediaRecord, "status" | "updatedAt">,
  ) {
    const index = this.records.findIndex((item) => item.id === id && item.ownerId === ownerId && item.revision === revision && item.status === status);
    if (index < 0) return null;
    const next = { ...this.records[index]!, ...change, revision: revision + 1 };
    this.records[index] = next;
    return clone(next);
  }

  private replace(media: MediaRecord, revision: number, status?: MediaRecord["status"]) {
    const index = this.records.findIndex((item) => item.id === media.id && item.ownerId === media.ownerId && item.revision === revision && (!status || item.status === status));
    if (index < 0) return null;
    this.records[index] = clone(media)!;
    return clone(media);
  }
}

class MemoryObjectStore implements MediaObjectStore {
  protected bytes: Buffer | null = null;
  nextError: Error | null = null;

  async write(_key: string, source: AsyncIterable<Uint8Array>, options: { expectedSize: number; maxBytes: number }) {
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      throw error;
    }
    const values: Buffer[] = [];
    for await (const value of source) values.push(Buffer.from(value));
    this.bytes = Buffer.concat(values);
    if (this.bytes.length > options.maxBytes) throw new MediaObjectWriteError("MEDIA_TOO_LARGE", "too large", true);
    if (this.bytes.length !== options.expectedSize) throw new MediaObjectWriteError("MEDIA_SIZE_MISMATCH", "wrong size", true);
    return { size: this.bytes.length, sha256: createHash("sha256").update(this.bytes).digest("hex") };
  }

  async withLocalFile<T>(_key: string, action: (path: string) => Promise<T>) {
    if (!this.bytes) throw new Error("missing object");
    const directory = await mkdtemp(join(tmpdir(), "kachang-service-media-"));
    const path = join(directory, "object.media");
    await writeFile(path, this.bytes);
    try {
      return await action(path);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async open(_key: string): Promise<MediaObjectRead> {
    if (!this.bytes) throw new Error("missing object");
    return { stream: Readable.from(this.bytes), totalSize: this.bytes.length, start: 0, end: this.bytes.length - 1 };
  }

  async remove() {
    this.bytes = null;
  }

  seed(bytes: Buffer) {
    this.bytes = Buffer.from(bytes);
  }
}

/** key 多槽位内存存储：缩略图派生对象与主对象可独立读写与断言。 */
class MultiKeyObjectStore implements MediaObjectStore {
  private readonly store = new Map<string, Buffer>();
  writeCount = 0;

  async write(key: string, source: AsyncIterable<Uint8Array>, options: { expectedSize: number; maxBytes: number }) {
    const values: Buffer[] = [];
    for await (const value of source) values.push(Buffer.from(value));
    const bytes = Buffer.concat(values);
    if (bytes.length > options.maxBytes) throw new MediaObjectWriteError("MEDIA_TOO_LARGE", "too large", true);
    if (bytes.length !== options.expectedSize) throw new MediaObjectWriteError("MEDIA_SIZE_MISMATCH", "wrong size", true);
    this.store.set(key, bytes);
    this.writeCount += 1;
    return { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }

  async withLocalFile<T>(key: string, action: (path: string) => Promise<T>) {
    const bytes = this.store.get(key);
    if (!bytes) throw new Error("missing object");
    const directory = await mkdtemp(join(tmpdir(), "kachang-service-media-keyed-"));
    const path = join(directory, "object.media");
    await writeFile(path, bytes);
    try {
      return await action(path);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async open(key: string): Promise<MediaObjectRead> {
    const bytes = this.store.get(key);
    if (!bytes) throw new Error("missing object");
    return { stream: Readable.from(bytes), totalSize: bytes.length, start: 0, end: bytes.length - 1 };
  }

  async remove(key: string) {
    this.store.delete(key);
  }

  seed(bytes: Buffer) {
    this.store.set(this.keyOf(MEDIA_ID), Buffer.from(bytes));
  }

  keyOf(mediaId: string) {
    return `media/${mediaId.slice(0, 2)}/${mediaId}`;
  }

  keys() {
    return [...this.store.keys()];
  }
}

class MemoryDirectObjectStore extends MemoryObjectStore {
  uploadOptions: unknown = null;

  async createUploadInstruction(
    _key: string,
    options: { contentType: string; contentLength: number; sha256: string | null; expiresAt: string },
  ) {
    this.uploadOptions = structuredClone(options);
    return {
      method: "PUT" as const,
      url: "https://objects.example.test/upload-capability",
      headers: { "Content-Type": options.contentType },
      expiresAt: options.expiresAt,
    };
  }

  async createDownloadInstruction() {
    return {
      url: "https://objects.example.test/download-capability",
      expiresAt: new Date(NOW + 30_000).toISOString(),
    };
  }

  async withPendingUploadFile<T>(
    _key: string,
    action: (file: { path: string; versionToken: string }) => Promise<T>,
  ) {
    return this.withLocalFile(_key, (path) => action({ path, versionToken: "test-version" }));
  }

  async promotePendingUpload() {}

  async removePendingUpload() {}
}

class FixedInspector implements MediaInspector {
  constructor(private readonly result: InspectedMedia | MediaInspectionError = {
    kind: "image",
    mimeType: "image/png",
    size: BYTES.length,
    width: 64,
    height: 36,
    durationMs: null,
  }) {}

  async inspect() {
    if (this.result instanceof MediaInspectionError) throw this.result;
    return structuredClone(this.result);
  }
}

function createService(
  metadata: MediaMetadataStore,
  objects: MediaObjectStore = new MemoryObjectStore(),
  inspector: MediaInspector = new FixedInspector(),
  options: { warmThumbnails?: boolean } = {},
) {
  return new MediaService(metadata, objects, inspector, {
    now: () => NOW,
    createId: () => MEDIA_ID,
    uploadTtlMs: 60_000,
    // 覆盖默认图片上限：缩略图用例要上传一张 640×480 的真实 PNG。
    limits: { image: 8 * 1024 * 1024 },
    // 缩略图预热是后台副作用，会让「精确调用次数」类断言变得不确定；
    // 预热本身由下面的专门用例覆盖。
    warmThumbnails: options.warmThumbnails ?? false,
  });
}

function uploadRequest() {
  return {
    kind: "image",
    name: "reference.png",
    mimeType: "image/png",
    size: BYTES.length,
    idempotencyKey: "upload:reference",
  };
}

async function* chunks(bytes: Buffer) {
  yield bytes.subarray(0, 4);
  yield bytes.subarray(4);
}

function clone<T>(value: T): T {
  return value === null ? value : structuredClone(value);
}
