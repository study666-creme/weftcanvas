import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, PassThrough } from "node:stream";

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  S3MediaObjectStore,
  classifyObjectStoreFailure,
  type S3MediaObjectStoreOptions,
} from "./s3-object-store.js";

const NOW = Date.parse("2026-07-15T18:00:00.000Z");
const KEY_SECRET = "test-key-derivation-secret-at-least-32-bytes";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("S3 media object store", () => {
  it("validates streamed writes before upload and supports private range reads", async () => {
    const fake = new MemoryS3();
    const store = createStore(fake);
    const bytes = Buffer.from("private-reference-media");

    await expect(
      store.write("media/aa/item", chunks(bytes, 4), {
        expectedSize: bytes.length,
        maxBytes: 1_024,
        contentType: "image/png",
      }),
    ).resolves.toEqual({
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(fake.objects.get(physicalKey("objects", "media/aa/item"))).toEqual(bytes);
    expect(fake.puts[0]).toMatchObject({
      Bucket: "canvas-test",
      Key: physicalKey("objects", "media/aa/item"),
      ContentLength: bytes.length,
      ContentType: "image/png",
    });

    await expect(
      store.withLocalFile("media/aa/item", (path) => readFile(path, "utf8")),
    ).resolves.toBe(bytes.toString("utf8"));

    const range = await store.open("media/aa/item", { start: 8, end: 16 });
    expect(await collect(range.stream)).toEqual(bytes.subarray(8, 17));
    expect(range).toMatchObject({ totalSize: bytes.length, start: 8, end: 16 });
    await expect(
      store.open("media/aa/item", { start: 2, end: bytes.length }),
    ).rejects.toBeInstanceOf(RangeError);

    await store.remove("media/aa/item");
    expect(fake.objects.has("canvas/private/media/aa/item")).toBe(false);
    await expect(temporaryEntries(store)).resolves.toEqual([]);
  });

  it("removes local staging data after rejected writes and failed inspection", async () => {
    const fake = new MemoryS3();
    const store = createStore(fake);

    await expect(
      store.write("media/bb/large", chunks(Buffer.alloc(20)), {
        expectedSize: 20,
        maxBytes: 10,
      }),
    ).rejects.toMatchObject({ code: "MEDIA_TOO_LARGE", definitive: true });
    expect(fake.puts).toHaveLength(0);

    const bytes = Buffer.from("temporary-object");
    await store.write("media/bb/item", chunks(bytes), {
      expectedSize: bytes.length,
      maxBytes: 100,
    });
    await expect(
      store.withLocalFile("media/bb/item", async () => {
        throw new Error("inspection failed");
      }),
    ).rejects.toThrow("inspection failed");
    await expect(temporaryEntries(store)).resolves.toEqual([]);
  });

  it("keeps direct uploads quarantined until validated promotion", async () => {
    const fake = new MemoryS3();
    const store = createStore(fake);
    const bytes = Buffer.from("quarantined-upload");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    fake.objects.set(physicalKey("incoming", "media/cc/item"), bytes);

    let versionToken = "";
    await expect(
      store.withPendingUploadFile("media/cc/item", async (file) => {
        versionToken = file.versionToken;
        return readFile(file.path, "utf8");
      }),
    ).resolves.toBe("quarantined-upload");
    expect(fake.objects.has(physicalKey("objects", "media/cc/item"))).toBe(false);

    await store.promotePendingUpload("media/cc/item", {
      contentType: "image/png",
      size: bytes.length,
      sha256,
      versionToken,
    });
    expect(fake.objects.get(physicalKey("objects", "media/cc/item"))).toEqual(bytes);
    expect(fake.objects.has(physicalKey("incoming", "media/cc/item"))).toBe(true);

    await store.removePendingUpload("media/cc/item");
    expect(fake.objects.has(physicalKey("incoming", "media/cc/item"))).toBe(false);
  });

  it("refuses promotion when a signed upload changes after inspection", async () => {
    const fake = new MemoryS3();
    const store = createStore(fake);
    const incoming = physicalKey("incoming", "media/dd/item");
    const inspected = Buffer.from("inspected-content");
    fake.objects.set(incoming, inspected);
    const versionToken = await store.withPendingUploadFile(
      "media/dd/item",
      async (file) => file.versionToken,
    );
    fake.objects.set(incoming, Buffer.from("changed-after-check"));

    await expect(
      store.promotePendingUpload("media/dd/item", {
        contentType: "image/png",
        size: inspected.length,
        sha256: createHash("sha256").update(inspected).digest("hex"),
        versionToken,
      }),
    ).rejects.toThrow("PreconditionFailed");
    expect(fake.objects.has(physicalKey("objects", "media/dd/item"))).toBe(false);
  });

  it("destroys the underlying S3 stream when the consumer aborts early", async () => {
    let destroyed = false;
    let source: Readable | null = null;
    const fake = new MemoryS3();
    fake.getObjectBody = () => {
      const chunks = [Buffer.from("first-"), Buffer.from("second-"), Buffer.from("third")];
      source = new Readable({
        read() {
          if (chunks.length) this.push(chunks.shift()!);
          else this.push(null);
        },
        destroy(error: Error | null, callback: (error?: Error | null) => void) {
          destroyed = true;
          callback(error);
        },
      });
      return source;
    };
    const store = createStore(fake);
    const bytes = Buffer.from("first-second-third");
    await store.write("media/aa/abort", chunks(bytes, 3), {
      expectedSize: bytes.length,
      maxBytes: 1_024,
      contentType: "image/png",
    });

    const opened = await store.open("media/aa/abort");
    // 消费一个 chunk 后主动中断（模拟客户端断开）。
    const iterator = opened.stream[Symbol.asyncIterator]();
    await iterator.next();
    await opened.stream.destroy();
    expect(destroyed).toBe(true);
    expect(opened.stream.destroyed).toBe(true);
  });

  it("destroys the underlying S3 stream when the request signal aborts", async () => {
    let destroyed = false;
    const fake = new MemoryS3();
    fake.getObjectBody = () => {
      const source = new Readable({
        read() {
          // 不给数据：让流保持打开，等待 abort 触发。
        },
        destroy(error: Error | null, callback: (error?: Error | null) => void) {
          destroyed = true;
          callback(error);
        },
      });
      return source;
    };
    const store = createStore(fake);
    const bytes = Buffer.from("signal-abort-test");
    await store.write("media/aa/signal", chunks(bytes, 3), {
      expectedSize: bytes.length,
      maxBytes: 1_024,
      contentType: "image/png",
    });

    const controller = new AbortController();
    const opened = await store.open("media/aa/signal", undefined, controller.signal);
    expect(destroyed).toBe(false);
    controller.abort();
    expect(destroyed).toBe(true);
    expect(opened.stream.destroyed).toBe(true);
  });

  it("cleans only stale adapter-owned temporary directories", async () => {
    const fake = new MemoryS3();
    const store = createStore(fake);
    const root = temporaryRoot(store);
    const stale = join(root, "read-stale");
    const fresh = join(root, "write-fresh");
    const unrelated = join(root, "operator-data");
    await Promise.all([stale, fresh, unrelated].map((path) => mkdir(path, { recursive: true })));
    const old = new Date(NOW - 25 * 60 * 60_000);
    await utimes(stale, old, old);

    await expect(store.cleanupTemporaryFiles(24 * 60 * 60_000)).resolves.toBe(1);
    expect(await readdir(root)).toEqual(expect.arrayContaining(["operator-data", "write-fresh"]));
    expect(await readdir(root)).not.toContain("read-stale");
  });

  it("issues bounded upload and download capabilities with signed constraints", async () => {
    const fake = new MemoryS3();
    const signed: Array<PutObjectCommand | GetObjectCommand> = [];
    const presign = vi.fn(
      async (_client: S3Client, command: PutObjectCommand | GetObjectCommand) => {
        signed.push(command);
        return `https://objects.example.test/signed/${signed.length}?signature=private`;
      },
    );
    const store = createStore(fake, { presign: presign as never });
    const sha256 = createHash("sha256").update("bytes").digest("hex");

    const upload = await store.createUploadInstruction("media/cc/item", {
      contentType: "video/mp4",
      contentLength: 42,
      sha256,
      expiresAt: new Date(NOW + 60 * 60_000).toISOString(),
    });
    expect(upload).toEqual({
      method: "PUT",
      url: "https://objects.example.test/signed/1?signature=private",
      headers: { "Content-Type": "video/mp4" },
      expiresAt: new Date(NOW + 15 * 60_000).toISOString(),
    });
    expect((signed[0] as PutObjectCommand).input).toMatchObject({
      Bucket: "canvas-test",
      Key: physicalKey("incoming", "media/cc/item"),
      ContentLength: 42,
      ContentType: "video/mp4",
    });

    const download = await store.createDownloadInstruction("media/cc/item", {
      contentType: "video/mp4",
      name: "../../unsafe video.mp4",
    });
    expect(download).toEqual({
      url: "https://objects.example.test/signed/2?signature=private",
      expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
    });
    expect((signed[1] as GetObjectCommand).input).toMatchObject({
      Bucket: "canvas-test",
      Key: physicalKey("objects", "media/cc/item"),
      ResponseContentType: "video/mp4",
      ResponseContentDisposition: 'inline; filename="unsafe_video.mp4"',
    });
    expect(presign).toHaveBeenNthCalledWith(
      1,
      fake as unknown as S3Client,
      expect.any(PutObjectCommand),
      { expiresIn: 900 },
    );
    expect(presign).toHaveBeenNthCalledWith(
      2,
      fake as unknown as S3Client,
      expect.any(GetObjectCommand),
      { expiresIn: 300 },
    );
  });

  it("reports an unreachable store as retryable instead of a bad asset", async () => {
    // 线上 R2 成片连接超时曾裸抛到 MediaService 的通用兜底，被回成
    // "素材暂时无法处理"——用户会以为文件有问题，且丢掉可重试语义。
    const fake = new MemoryS3();
    fake.sendError = Object.assign(
      new Error(
        "@smithy/node-http-handler - the request socket did not establish a connection with the server within the configured timeout of 5000 ms.",
      ),
      { name: "TimeoutError" },
    );
    const store = createStore(fake);
    await expect(
      store.withLocalFile("media/zz/item", async () => "unreachable"),
    ).rejects.toMatchObject({ code: "MEDIA_STORAGE_UNAVAILABLE", definitive: false });
    await expect(store.open("media/zz/item")).rejects.toMatchObject({
      code: "MEDIA_STORAGE_UNAVAILABLE",
    });
    await expect(store.remove("media/zz/item")).rejects.toMatchObject({
      code: "MEDIA_STORAGE_UNAVAILABLE",
    });
    expect(classifyObjectStoreFailure(new Error("NoSuchKey"))).toMatchObject({ name: "Error" });
  });

  it("fails fast for a cooldown window after repeated transport failures", async () => {
    let now = NOW;
    const fake = new MemoryS3();
    fake.sendError = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const store = createStore(fake, {
      now: () => now,
      transportFailureThreshold: 2,
      transportFailureCooldownMs: 5_000,
    });

    await expect(store.remove("media/yy/one")).rejects.toMatchObject({
      code: "MEDIA_STORAGE_UNAVAILABLE",
    });
    await expect(store.remove("media/yy/two")).rejects.toMatchObject({
      code: "MEDIA_STORAGE_UNAVAILABLE",
    });
    const attemptsBeforeCooldown = fake.sends;

    // 窗口内不再真的去连存储（否则每个请求都要等满连接超时）。
    await expect(store.remove("media/yy/three")).rejects.toMatchObject({
      code: "MEDIA_STORAGE_UNAVAILABLE",
    });
    expect(fake.sends).toBe(attemptsBeforeCooldown);

    // 窗口到期后放行探测，存储恢复即回到正常路径。
    now += 5_001;
    fake.sendError = null;
    const restored = Buffer.from("recovered");
    await store.write("media/yy/four", chunks(restored), {
      expectedSize: restored.length,
      maxBytes: 100,
    });
    expect(fake.sends).toBeGreaterThan(attemptsBeforeCooldown);
    expect(fake.objects.get(physicalKey("objects", "media/yy/four"))).toEqual(restored);
  });

  it("destroys the underlying S3 stream when the consumer abandons it", async () => {
    // 半挂流（没人读也没人 destroy）会永久占住连接池名额：线上进程运行三天后
    // 出现成片"建连超时"，就是这么攒出来的。看门狗必须替消费端收尾。
    vi.useFakeTimers();
    const fake = new MemoryS3();
    const store = createStore(fake);
    const bytes = Buffer.from("abandoned-object");
    fake.objects.set(physicalKey("objects", "media/ee/item"), bytes);
    const raw = new PassThrough();
    fake.getObjectBody = () => raw;

    const opened = await store.open("media/ee/item");
    expect(raw.destroyed).toBe(false);
    // 无人消费：超过遗弃窗口后底层请求流被销毁。
    vi.advanceTimersByTime(60_001);
    expect(raw.destroyed).toBe(true);
    expect(opened.stream.destroyed).toBe(true);
    vi.useRealTimers();
  });

  it("rejects traversal keys and insecure remote endpoints", () => {
    const fake = new MemoryS3();
    const store = createStore(fake);
    return expect(store.open("../outside")).rejects.toThrow("Invalid media object key");
  });

  it("disables optional response checksum validation on the real S3 client", async () => {
    // R2 对 Range GET 响应返回整对象的 x-amz-checksum-sha256；SDK 默认
    // 校验会用分段字节比对全对象摘要而必然 mismatch（2026-08-30 起线上
    // 视频流/缩略图全量报错即此因）。两个 WHEN_REQUIRED 必须同时保持。
    const root = join(tmpdir(), `weftcanvas-s3-test-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    const store = new S3MediaObjectStore({
      bucket: "canvas-test",
      region: "auto",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      keyPrefix: "canvas/private",
      keyDerivationSecret: KEY_SECRET,
      temporaryDirectory: root,
      now: () => NOW,
    });
    const client = (store as unknown as { client: S3Client }).client;
    const config = client.config as unknown as Record<string, unknown>;
    const resolve = async (key: string) => {
      const raw = config[key];
      const value =
        typeof raw === "object" && raw !== null && "value" in (raw as object)
          ? (raw as { value: unknown }).value
          : raw;
      return typeof value === "function" ? value() : value;
    };
    expect(await resolve("responseChecksumValidation")).toBe("WHEN_REQUIRED");
    expect(await resolve("requestChecksumCalculation")).toBe("WHEN_REQUIRED");
  });
});

class MemoryS3 {
  readonly objects = new Map<string, Buffer>();
  readonly puts: Array<Record<string, unknown>> = [];
  /** 测试钩子：为 GetObject 提供可观察的底层流。 */
  getObjectBody: ((bytes: Buffer) => Readable) | null = null;
  /** 测试钩子：模拟存储不可达（连接超时 / 拒连等传输层失败）。 */
  sendError: Error | null = null;
  /** 真实发出的命令次数：验证快速失败窗口内不再打存储。 */
  sends = 0;

  async send(
    command:
      | PutObjectCommand
      | CopyObjectCommand
      | HeadObjectCommand
      | GetObjectCommand
      | DeleteObjectCommand,
  ) {
    this.sends += 1;
    if (this.sendError) throw this.sendError;
    if (command instanceof PutObjectCommand) {
      const key = String(command.input.Key);
      const body = await collect(command.input.Body as Readable);
      this.objects.set(key, body);
      this.puts.push({ ...command.input, Body: undefined });
      return {};
    }
    if (command instanceof CopyObjectCommand) {
      const source = String(command.input.CopySource).replace(/^canvas-test\//, "");
      const bytes = this.require(source);
      if (command.input.CopySourceIfMatch && command.input.CopySourceIfMatch !== etag(bytes)) {
        throw new Error("PreconditionFailed");
      }
      this.objects.set(String(command.input.Key), Buffer.from(bytes));
      return { CopyObjectResult: {} };
    }
    if (command instanceof HeadObjectCommand) {
      const bytes = this.require(String(command.input.Key));
      return { ContentLength: bytes.length, ETag: etag(bytes) };
    }
    if (command instanceof GetObjectCommand) {
      const bytes = this.require(String(command.input.Key));
      if (command.input.IfMatch && command.input.IfMatch !== etag(bytes))
        throw new Error("PreconditionFailed");
      const range = parseRange(command.input.Range, bytes.length);
      // 默认一次性流；测试可注入可观察的底层流（验证提前中断时被销毁）。
      const body = this.getObjectBody
        ? this.getObjectBody(bytes.subarray(range.start, range.end + 1))
        : Readable.from([bytes.subarray(range.start, range.end + 1)]);
      return { Body: body, ContentLength: range.end - range.start + 1 };
    }
    if (command instanceof DeleteObjectCommand) {
      this.objects.delete(String(command.input.Key));
      return {};
    }
    throw new Error("Unexpected command");
  }

  private require(key: string) {
    const value = this.objects.get(key);
    if (!value) throw new Error("NoSuchKey");
    return value;
  }
}

function createStore(fake: MemoryS3, override: Partial<S3MediaObjectStoreOptions> = {}) {
  const root = join(tmpdir(), `weftcanvas-s3-test-${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  return new S3MediaObjectStore({
    bucket: "canvas-test",
    region: "auto",
    keyPrefix: "canvas/private",
    keyDerivationSecret: KEY_SECRET,
    temporaryDirectory: root,
    client: fake as unknown as S3Client,
    now: () => NOW,
    ...override,
  });
}
function physicalKey(scope: "objects" | "incoming", logicalKey: string) {
  const digest = createHmac("sha256", KEY_SECRET).update(`${scope}\0${logicalKey}`).digest("hex");
  return `canvas/private/${scope}/${digest.slice(0, 2)}/${digest}`;
}

function etag(bytes: Buffer) {
  return `"${createHash("md5").update(bytes).digest("hex")}"`;
}

async function temporaryEntries(store: S3MediaObjectStore) {
  const root = temporaryRoot(store);
  return readdir(root).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? [] : Promise.reject(error),
  );
}

function temporaryRoot(store: S3MediaObjectStore) {
  return (store as unknown as { temporaryDirectory: string }).temporaryDirectory;
}

function parseRange(value: string | undefined, length: number) {
  if (!value) return { start: 0, end: length - 1 };
  const match = /^bytes=(\d+)-(\d+)$/.exec(value);
  if (!match) throw new Error("Bad range");
  return { start: Number(match[1]), end: Number(match[2]) };
}

async function* chunks(bytes: Buffer, size = bytes.length) {
  for (let offset = 0; offset < bytes.length; offset += size)
    yield bytes.subarray(offset, offset + size);
}

async function collect(stream: AsyncIterable<unknown> | Uint8Array) {
  if (Buffer.isBuffer(stream) || stream instanceof Uint8Array) return Buffer.from(stream);
  const values: Buffer[] = [];
  for await (const value of stream) values.push(Buffer.from(value as Uint8Array));
  return Buffer.concat(values);
}
