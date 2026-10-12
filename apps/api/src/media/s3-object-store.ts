import { createHash, createHmac, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { PassThrough, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type CreateMultipartUploadCommandOutput,
  type GetObjectCommandOutput,
  type HeadObjectCommandOutput,
  type ListPartsCommandOutput,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { Agent as HttpsAgent } from "node:https";

import {
  MediaObjectWriteError,
  type MediaMultipartObjectPart,
  type MultipartMediaObjectStore,
} from "./types.js";

type Presign = typeof getSignedUrl;

export type S3MediaObjectStoreOptions = {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  keyPrefix?: string;
  keyDerivationSecret: string;
  temporaryDirectory?: string;
  uploadTtlSeconds?: number;
  downloadTtlSeconds?: number;
  maxMaterializedBytes?: number;
  /** 连接池并发上限，默认 50。超过后请求排队而不是无限建连。 */
  maxSockets?: number;
  /**
   * 连续多少次传输失败后直接快速失败。默认 3：线上 R2 偶发成片连接超时，
   * 若每个请求都各自把连接超时等满，一次画廊加载就能把连接池和用户时间
   * 一起耗尽；快速失败让故障期间的所有请求立刻拿到可重试的错误。
   */
  transportFailureThreshold?: number;
  /** 快速失败持续时间，默认 20 秒；窗口内放行一次探测请求。 */
  transportFailureCooldownMs?: number;
  client?: S3Client;
  presign?: Presign;
  now?: () => number;
};

const DEFAULT_MAX_MATERIALIZED_BYTES = 512 * 1024 * 1024;
const PRIVATE_MEDIA_CACHE_CONTROL = "private, no-store, no-transform";
const STORAGE_UNAVAILABLE_MESSAGE = "素材存储暂时不可达，请重试";
/** 返回后 1 分钟仍无人消费该流：判定为被遗弃，断开底层对象存储连接。 */
const ABANDONED_STREAM_MS = 60_000;
/** 开始消费后 5 分钟没有任何新数据：客户端已卡死，断开以免永久占用连接池。 */
const IDLE_STREAM_MS = 5 * 60_000;

export class S3MediaObjectStore implements MultipartMediaObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly keyPrefix: string;
  private readonly keyDerivationSecret: Buffer;
  private readonly temporaryDirectory: string;
  private readonly uploadTtlSeconds: number;
  private readonly downloadTtlSeconds: number;
  private readonly maxMaterializedBytes: number;
  private readonly transportFailureThreshold: number;
  private readonly transportFailureCooldownMs: number;
  private readonly presign: Presign;
  private readonly now: () => number;
  private consecutiveTransportFailures = 0;
  private transportFailFastUntil = 0;

  constructor(options: S3MediaObjectStoreOptions) {
    this.bucket = requiredToken(options.bucket, "S3 bucket", /^[A-Za-z0-9][A-Za-z0-9._-]{1,254}$/);
    this.keyPrefix = normalizePrefix(options.keyPrefix);
    this.keyDerivationSecret = secret(options.keyDerivationSecret, "S3 key derivation secret");
    this.temporaryDirectory = resolve(
      options.temporaryDirectory || join(tmpdir(), "weftcanvas-media"),
    );
    this.uploadTtlSeconds = boundedInteger(
      options.uploadTtlSeconds ?? 15 * 60,
      "uploadTtlSeconds",
      60,
      60 * 60,
    );
    this.downloadTtlSeconds = boundedInteger(
      options.downloadTtlSeconds ?? 5 * 60,
      "downloadTtlSeconds",
      30,
      60 * 60,
    );
    this.maxMaterializedBytes = boundedInteger(
      options.maxMaterializedBytes ?? DEFAULT_MAX_MATERIALIZED_BYTES,
      "maxMaterializedBytes",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    this.transportFailureThreshold = boundedInteger(
      options.transportFailureThreshold ?? 3,
      "transportFailureThreshold",
      1,
      100,
    );
    this.transportFailureCooldownMs = boundedInteger(
      options.transportFailureCooldownMs ?? 20_000,
      "transportFailureCooldownMs",
      1_000,
      10 * 60_000,
    );
    this.presign = options.presign ?? getSignedUrl;
    this.now = options.now ?? Date.now;
    this.client = options.client ?? new S3Client(clientConfig(options));
  }

  /**
   * 所有 S3 命令的唯一出口：把"存储够不到"和"这份素材有问题"分开。
   * 线上曾出现 R2 连接成片超时（`the request socket did not establish a
   * connection`），裸抛到 MediaService 的通用兜底后被当成"素材暂时无法
   * 处理"回给用户——既误导用户以为文件有问题，又丢了可重试语义。
   *
   * 连续传输失败达到阈值后进入短暂快速失败：故障期间每个请求都各自等满
   * 连接超时，会把连接池和用户时间一起耗尽（画廊一页就能触发几十次）；
   * 快速失败让它们立刻拿到"存储暂时不可达，请重试"。窗口到期后放行下一
   * 个请求作为探测——探测成功即恢复，失败则重新进入窗口。
   */
  private async send<T = unknown>(command: unknown): Promise<T> {
    if (this.now() < this.transportFailFastUntil) {
      throw new MediaObjectWriteError(
        "MEDIA_STORAGE_UNAVAILABLE",
        STORAGE_UNAVAILABLE_MESSAGE,
        false,
      );
    }
    try {
      const result = await (this.client.send as (input: unknown) => Promise<T>)(command);
      this.consecutiveTransportFailures = 0;
      this.transportFailFastUntil = 0;
      return result;
    } catch (error) {
      const classified = classifyObjectStoreFailure(error);
      if (
        classified instanceof MediaObjectWriteError &&
        classified.code === "MEDIA_STORAGE_UNAVAILABLE"
      ) {
        this.consecutiveTransportFailures += 1;
        if (this.consecutiveTransportFailures >= this.transportFailureThreshold) {
          this.transportFailFastUntil = this.now() + this.transportFailureCooldownMs;
          this.consecutiveTransportFailures = 0;
        }
      }
      throw classified;
    }
  }

  async write(
    key: string,
    source: AsyncIterable<Uint8Array>,
    options: { expectedSize: number; maxBytes: number; contentType?: string },
  ) {
    const temporary = await this.temporaryPath("write");
    try {
      const written = await writeExactFile(
        temporary.path,
        source,
        options.expectedSize,
        options.maxBytes,
      );
      // 缓冲 PUT：字节经本地临时文件读回为单个 Buffer 后整体上传（确定性
      // 请求体；上传完整性由写入时的 size/sha256 校验保证，见 writeExactFile）。
      // 注意：上传自带的 ChecksumSHA256 会让 R2 在之后的 Range GET 响应里返回
      // 全对象摘要——响应校验由 clientConfig 的 WHEN_REQUIRED 统一关闭，两处
      // 需一起维护。
      const body = await readFile(temporary.path);
      await this.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.objectKey(key),
          Body: body,
          ContentLength: written.size,
          ...(options.contentType ? { ContentType: options.contentType } : {}),
          CacheControl: PRIVATE_MEDIA_CACHE_CONTROL,
          ChecksumSHA256: hexToBase64(written.sha256),
          Metadata: { "canvas-sha256": written.sha256 },
        }),
      );
      return written;
    } catch (error) {
      if (error instanceof MediaObjectWriteError) throw error;
      // 对外只回可重试的"上传中断"，但原始原因必须留在服务端日志里：
      // 线上成片 503 时，没有这一行就只能看到统一的兜底文案，无法定位。
      console.warn("S3 media write failed", error);
      throw new MediaObjectWriteError("MEDIA_UPLOAD_INTERRUPTED", "素材上传中断，请重试", false);
    } finally {
      await temporary.remove();
    }
  }

  async withLocalFile<T>(key: string, action: (path: string) => Promise<T>) {
    return this.withObjectLocalFile(this.objectKey(key), (path) => action(path));
  }

  async withPendingUploadFile<T>(
    key: string,
    action: (file: { path: string; versionToken: string }) => Promise<T>,
  ) {
    return this.withObjectLocalFile(
      this.pendingObjectKey(key),
      (path, versionToken) => {
        if (!versionToken) throw new Error("Pending media object version is unavailable");
        return action({ path, versionToken });
      },
      true,
    );
  }

  async promotePendingUpload(
    key: string,
    options: { contentType: string; size: number; sha256: string; versionToken: string },
  ) {
    const source = this.pendingObjectKey(key);
    await this.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(key),
        CopySource: copySource(this.bucket, source),
        CopySourceIfMatch: validEtag(options.versionToken),
        ContentType: options.contentType,
        CacheControl: PRIVATE_MEDIA_CACHE_CONTROL,
        MetadataDirective: "REPLACE",
        Metadata: {
          "canvas-sha256": options.sha256,
          "canvas-size": String(positiveInteger(options.size, "size")),
        },
        ChecksumAlgorithm: "SHA256",
      }),
    );
  }

  async removePendingUpload(key: string) {
    await this.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.pendingObjectKey(key) }),
    );
  }

  private async withObjectLocalFile<T>(
    objectKey: string,
    action: (path: string, versionToken: string | undefined) => Promise<T>,
    lockVersion = false,
  ) {
    const metadata = await this.send<HeadObjectCommandOutput>(
      new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }),
    );
    const size = validObjectSize(metadata.ContentLength, this.maxMaterializedBytes);
    const versionToken = lockVersion ? validEtag(metadata.ETag) : undefined;
    const temporary = await this.temporaryPath("read");
    try {
      const response = await this.send<GetObjectCommandOutput>(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          ...(versionToken ? { IfMatch: versionToken } : {}),
        }),
      );
      const source = nodeReadable(response.Body);
      const written = await writeExactFile(temporary.path, source, size, this.maxMaterializedBytes);
      if (written.size !== size)
        throw new Error("Stored media object size changed during materialization");
      return await action(temporary.path, versionToken);
    } finally {
      await temporary.remove();
    }
  }

  async open(key: string, range?: { start: number; end: number }, signal?: AbortSignal) {
    const objectKey = this.objectKey(key);
    const metadata = await this.send<HeadObjectCommandOutput>(
      new HeadObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        ...(signal ? { abortSignal: signal } : {}),
      }),
    );
    const totalSize = validObjectSize(metadata.ContentLength, this.maxMaterializedBytes);
    const start = range?.start ?? 0;
    const end = range?.end ?? totalSize - 1;
    assertRange(start, end, totalSize);
    const response = await this.send<GetObjectCommandOutput>(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        ...(range ? { Range: `bytes=${start}-${end}` } : {}),
        ...(signal ? { abortSignal: signal } : {}),
      }),
    );
    const contentLength = response.ContentLength;
    if (contentLength !== undefined && contentLength !== end - start + 1) {
      throw new Error("Stored media range length is invalid");
    }
    // 返回的 Node 流外层必须负责结束时销毁本体。Readable 在排空前会
    // 持有底层 HTTP socket；任何一端的提前关闭（AbortSignal 触发、管道
    // 错误、客户端断连）都要把请求体流 destroy 掉，否则 socket 永不
    // 归还连接池——线上曾因此把 50 个 S3 socket 全部挂死。
    return {
      stream: trackedNodeReadable(response.Body, signal),
      totalSize,
      start,
      end,
    };
  }

  async remove(key: string) {
    await this.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
  }

  async cleanupTemporaryFiles(olderThanMs: number) {
    const age = boundedInteger(olderThanMs, "olderThanMs", 60_000, Number.MAX_SAFE_INTEGER);
    const cutoff = this.now() - age;
    const entries = await readdir(this.temporaryDirectory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^(?:read|write)-[A-Za-z0-9_-]+$/.test(entry.name)) continue;
      const path = resolve(this.temporaryDirectory, entry.name);
      const metadata = await lstat(path).catch(() => null);
      if (
        !metadata ||
        metadata.isSymbolicLink() ||
        !metadata.isDirectory() ||
        metadata.mtimeMs > cutoff
      )
        continue;
      await rm(path, { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }

  async createMultipartUpload(key: string, options: { contentType: string; sessionId: string }) {
    const sessionId = validSessionId(options.sessionId);
    const response = await this.send<CreateMultipartUploadCommandOutput>(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.pendingObjectKey(key),
        ContentType: options.contentType,
        CacheControl: PRIVATE_MEDIA_CACHE_CONTROL,
        Metadata: { "canvas-session-id": sessionId },
      }),
    );
    return { providerUploadId: validProviderUploadId(response.UploadId) };
  }

  async createMultipartPartUploadInstruction(
    key: string,
    providerUploadId: string,
    options: { partNumber: number; contentLength: number; expiresAt: string },
  ) {
    const expiresIn = this.uploadExpirySeconds(options.expiresAt);
    const command = new UploadPartCommand({
      Bucket: this.bucket,
      Key: this.pendingObjectKey(key),
      UploadId: validProviderUploadId(providerUploadId),
      PartNumber: validPartNumber(options.partNumber),
      ContentLength: validPartSize(options.contentLength),
    });
    const url = await this.presign(this.client, command, { expiresIn });
    return {
      method: "PUT" as const,
      url: safeSignedUrl(url),
      headers: {},
      expiresAt: new Date(this.now() + expiresIn * 1_000).toISOString(),
    };
  }

  async listMultipartUploadParts(key: string, providerUploadId: string) {
    const objectKey = this.pendingObjectKey(key);
    const uploadId = validProviderUploadId(providerUploadId);
    const parts: MediaMultipartObjectPart[] = [];
    let partNumberMarker: string | undefined;
    let pages = 0;
    do {
      const result = await this.send<ListPartsCommandOutput>(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: objectKey,
          UploadId: uploadId,
          PartNumberMarker: partNumberMarker,
          MaxParts: 1_000,
        }),
      );
      parts.push(
        ...(result.Parts ?? []).map((part) => ({
          partNumber: validPartNumber(part.PartNumber),
          size: validPartSize(part.Size),
          versionToken: validEtag(part.ETag),
        })),
      );
      pages += 1;
      if (!result.IsTruncated) {
        partNumberMarker = undefined;
        continue;
      }
      if (pages >= 10) throw new Error("Multipart upload contains too many parts");
      const nextMarker = validPartNumberMarker(result.NextPartNumberMarker);
      if (nextMarker === partNumberMarker)
        throw new Error("Multipart part listing did not advance");
      partNumberMarker = nextMarker;
    } while (partNumberMarker);

    parts.sort((left, right) => left.partNumber - right.partNumber);
    if (
      parts.some((part, index) => index > 0 && part.partNumber === parts[index - 1]!.partNumber)
    ) {
      throw new Error("Multipart upload returned duplicate parts");
    }
    return parts;
  }

  async completeMultipartUpload(
    key: string,
    providerUploadId: string,
    parts: readonly MediaMultipartObjectPart[],
  ) {
    const completedParts = validatedCompletedParts(parts);
    await this.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.pendingObjectKey(key),
        UploadId: validProviderUploadId(providerUploadId),
        MultipartUpload: {
          Parts: completedParts.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.versionToken,
          })),
        },
      }),
    );
    return this.headPendingMultipartUpload(key);
  }

  async abortMultipartUpload(key: string, providerUploadId: string) {
    await this.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.pendingObjectKey(key),
        UploadId: validProviderUploadId(providerUploadId),
      }),
    );
  }

  async headPendingMultipartUpload(key: string) {
    const metadata = await this.send<HeadObjectCommandOutput>(
      new HeadObjectCommand({
        Bucket: this.bucket,
        Key: this.pendingObjectKey(key),
      }),
    );
    return {
      size: validObjectSize(metadata.ContentLength, this.maxMaterializedBytes),
      versionToken: validEtag(metadata.ETag),
      sessionId: validSessionId(metadata.Metadata?.["canvas-session-id"]),
    };
  }

  async createUploadInstruction(
    key: string,
    options: {
      contentType: string;
      contentLength: number;
      sha256: string | null;
      expiresAt: string;
    },
  ) {
    const expiresIn = this.uploadExpirySeconds(options.expiresAt);
    const checksum = options.sha256 ? hexToBase64(options.sha256) : undefined;
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.pendingObjectKey(key),
      ContentType: options.contentType,
      ContentLength: positiveInteger(options.contentLength, "contentLength"),
      ...(checksum ? { ChecksumSHA256: checksum } : {}),
      Metadata: options.sha256 ? { "canvas-sha256": options.sha256 } : undefined,
    });
    const url = await this.presign(this.client, command, { expiresIn });
    return {
      method: "PUT" as const,
      url: safeSignedUrl(url),
      headers: { "Content-Type": options.contentType },
      expiresAt: new Date(this.now() + expiresIn * 1_000).toISOString(),
    };
  }

  private uploadExpirySeconds(expiresAt: string) {
    const requestedExpiry = Date.parse(expiresAt);
    if (!Number.isFinite(requestedExpiry) || requestedExpiry <= this.now()) {
      throw new Error("Media upload expiry is invalid");
    }
    return Math.min(
      this.uploadTtlSeconds,
      Math.max(1, Math.ceil((requestedExpiry - this.now()) / 1_000)),
    );
  }

  async createDownloadInstruction(key: string, options: { contentType: string; name: string }) {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.objectKey(key),
      ResponseContentType: options.contentType,
      ResponseContentDisposition: `inline; filename="${safeDownloadName(options.name)}"`,
      ResponseCacheControl: PRIVATE_MEDIA_CACHE_CONTROL,
    });
    const url = await this.presign(this.client, command, { expiresIn: this.downloadTtlSeconds });
    return {
      url: safeSignedUrl(url),
      expiresAt: new Date(this.now() + this.downloadTtlSeconds * 1_000).toISOString(),
    };
  }

  private objectKey(key: string) {
    return this.physicalKey("objects", key);
  }

  private pendingObjectKey(key: string) {
    return this.physicalKey("incoming", key);
  }

  private physicalKey(scope: "objects" | "incoming", key: string) {
    const logicalKey = this.validatedKey(key);
    const digest = createHmac("sha256", this.keyDerivationSecret)
      .update(`${scope}\0${logicalKey}`)
      .digest("hex");
    return `${this.keyPrefix}${scope}/${digest.slice(0, 2)}/${digest}`;
  }

  private validatedKey(key: string) {
    const segments = key.split("/");
    if (!segments.length || segments.some((segment) => !/^[A-Za-z0-9_-]{1,128}$/.test(segment))) {
      throw new Error("Invalid media object key");
    }
    return segments.join("/");
  }

  private async temporaryPath(purpose: string) {
    await mkdir(this.temporaryDirectory, { recursive: true });
    const directory = await mkdtemp(join(this.temporaryDirectory, `${purpose}-`));
    const path = join(directory, `${randomUUID()}.media`);
    return {
      path,
      remove: () => rm(directory, { recursive: true, force: true }),
    };
  }
}

function clientConfig(options: S3MediaObjectStoreOptions): S3ClientConfig {
  const credentialsConfigured = Boolean(options.accessKeyId || options.secretAccessKey);
  if (credentialsConfigured && (!options.accessKeyId || !options.secretAccessKey)) {
    throw new Error("S3 access key id and secret access key must be configured together");
  }
  const maxSockets = boundedInteger(options.maxSockets ?? 50, "maxSockets", 8, 200);
  return {
    region: requiredToken(options.region, "S3 region", /^[A-Za-z0-9._-]{1,128}$/),
    // Multipart part bodies are uploaded later by the browser. The SDK's
    // optional checksum middleware otherwise presigns the CRC32 of an empty
    // body, which R2 rejects when the real part bytes arrive.
    requestChecksumCalculation: "WHEN_REQUIRED",
    // R2 对 Range GET 响应仍返回整对象的 x-amz-checksum-sha256；SDK 默认
    // 校验响应体会用分段字节比对全对象摘要，必然 mismatch（2026-08-30 起
    // 画布视频流/缩略图 Range 读全部报错即此因）。WHEN_REQUIRED 只在请求
    // 本身要求校验时才验证响应，Range/普通 GET 不再误杀。
    responseChecksumValidation: "WHEN_REQUIRED",
    // 连接池显式上限 + 短空闲回收：池满时排队而不是无限建连；
    // 空闲 socket 30 秒后回收，避免“逻辑已结束但 socket 常驻”的池内残留。
    requestHandler: new NodeHttpHandler({
      httpsAgent: new HttpsAgent({
        keepAlive: true,
        maxSockets,
        keepAliveMsecs: 30_000,
        timeout: 30_000,
      }),
      // connectionTimeout 只覆盖建连阶段（socket connect 事件即清除，见
      // @smithy/node-http-handler 的 setConnectionTimeout），不影响大文件
      // 开始传输后的数据流，所以可以按"建连应该很快"来收紧。实测本机到 R2
      // 建连 16–70ms，5 秒是 70 倍余量；原来的 10 秒只是让每次失败都多等
      // 5 秒——线上成片连接超时时，这段时间就是用户看到的卡顿。
      connectionTimeout: 5_000,
    }),
    ...(options.endpoint ? { endpoint: safeEndpoint(options.endpoint) } : {}),
    ...(options.forcePathStyle !== undefined ? { forcePathStyle: options.forcePathStyle } : {}),
    ...(options.accessKeyId && options.secretAccessKey
      ? {
          credentials: {
            accessKeyId: options.accessKeyId,
            secretAccessKey: options.secretAccessKey,
          },
        }
      : {}),
  };
}

function copySource(bucket: string, key: string) {
  if (!/^[A-Za-z0-9._/-]+$/.test(`${bucket}/${key}`)) throw new Error("S3 copy source is invalid");
  return `${bucket}/${key}`;
}

/**
 * 连接/传输类失败的判定集合。smithy 的连接超时用 `TimeoutError`（见
 * @smithy/node-http-handler），其余是 socket / DNS / 路由层的原生错误码。
 * 这些错误说明"存储这一刻够不到"，与素材内容和权限都无关，必须保留可重试
 * 语义（否则调用方会把它当成素材本身不合格）。
 */
const TRANSPORT_FAILURE_NAMES = new Set([
  "TimeoutError",
  "RequestTimeout",
  "RequestTimeoutException",
  "NetworkingError",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EADDRINUSE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
]);

/** 传输失败的兜底文案判定（错误码缺失时按消息识别）。 */
const TRANSPORT_FAILURE_MESSAGES =
  /socket did not establish a connection|socket hang up|ECONNRESET|getaddrinfo|network error|connection (?:refused|reset|timed out)/i;

export function isObjectStoreTransportFailure(error: unknown) {
  if (!(error instanceof Error)) return false;
  if (TRANSPORT_FAILURE_NAMES.has(error.name)) return true;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && TRANSPORT_FAILURE_NAMES.has(code)) return true;
  return TRANSPORT_FAILURE_MESSAGES.test(error.message);
}

export function classifyObjectStoreFailure(error: unknown) {
  if (error instanceof MediaObjectWriteError) return error;
  if (!isObjectStoreTransportFailure(error)) return error;
  return new MediaObjectWriteError("MEDIA_STORAGE_UNAVAILABLE", STORAGE_UNAVAILABLE_MESSAGE, false);
}

async function writeExactFile(
  path: string,
  source: AsyncIterable<Uint8Array>,
  expectedSize: number,
  maxBytes: number,
) {
  const expected = positiveInteger(expectedSize, "expectedSize");
  const maximum = positiveInteger(maxBytes, "maxBytes");
  const hash = createHash("sha256");
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maximum) {
        callback(new MediaObjectWriteError("MEDIA_TOO_LARGE", "素材大小超过当前限制", true));
        return;
      }
      hash.update(bytes);
      callback(null, bytes);
    },
  });
  try {
    await mkdir(dirname(path), { recursive: true });
    await pipeline(
      Readable.from(source),
      meter,
      createWriteStream(path, { flags: "wx", mode: 0o600 }),
    );
    if (size !== expected) {
      throw new MediaObjectWriteError("MEDIA_SIZE_MISMATCH", "上传内容大小与文件信息不一致", true);
    }
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size !== size)
      throw new Error("Temporary media file is invalid");
    return { size, sha256: hash.digest("hex") };
  } catch (error) {
    await unlink(path).catch(() => undefined);
    throw error;
  }
}

function nodeReadable(body: unknown): Readable {
  if (body instanceof Readable) return body;
  if (
    body &&
    typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  ) {
    return Readable.from(body as AsyncIterable<Uint8Array>);
  }
  throw new Error("Stored media object body is unavailable");
}

/**
 * 包装 S3 GetObject 返回的流：把底层请求流生命周期与消费端绑定。
 * 消费端提前 destroy（客户端断连、管道错误）、底层流结束或 AbortSignal
 * 触发时，底层请求流一并 destroy——底层是 smithy 的 ResponseBody，
 * destroy 即断开 HTTP socket 归还连接池。线上曾因流未释放把 50 个
 * S3 socket 全部挂死（smithy 排队 100+ 单调增长）。
 *
 * 另加两道兜底看门狗，防止"没人读也没人销毁"的半挂流长期占住连接池
 * 名额（哪怕未来又多出一条相似的消费端路径）：
 *  - 从返回起 ABANDONED_STREAM_MS 内没有任何数据被消费 → 判定为被遗弃；
 *  - 开始消费后连续 IDLE_STREAM_MS 没有新数据（客户端卡住又不取消）→ 断开。
 * 两种情况下浏览器都会用 Range 重试，代价远小于一个永不归还的 socket。
 */
function trackedNodeReadable(body: unknown, signal?: AbortSignal): Readable {
  const source = nodeReadable(body);
  const raw = source as Readable & { destroy?: (error?: Error) => Readable };
  const tracked = new PassThrough();
  let released = false;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const clearWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
  };
  const release = () => {
    if (released) return;
    released = true;
    clearWatchdog();
    signal?.removeEventListener("abort", onAbort);
    if (!raw.destroyed && typeof raw.destroy === "function") raw.destroy();
  };
  const onAbort = () => {
    release();
    tracked.destroy(new Error("Media stream aborted"));
  };
  const armWatchdog = (delayMs: number) => {
    clearWatchdog();
    watchdog = setTimeout(() => {
      watchdog = null;
      if (released) return;
      release();
      tracked.destroy(new Error("Media stream abandoned"));
    }, delayMs);
    watchdog.unref?.();
  };

  // 底层流结束/出错/关闭 → 释放底层并把状态反映到追踪流。
  raw.on("end", () => {
    release();
    tracked.end();
  });
  raw.on("error", (error) => {
    release();
    tracked.destroy(error as Error);
  });
  raw.on("close", () => release());
  // 消费端结束/销毁/出错 → 释放底层（消费端半途 destroy 是最常见的泄漏路径）。
  tracked.on("close", () => release());
  tracked.on("error", () => release());
  tracked.on("data", () => {
    armWatchdog(IDLE_STREAM_MS);
  });

  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  armWatchdog(ABANDONED_STREAM_MS);
  // pipe 处理背压与自动消费；消费端 destroy 时 pipe 解除，由上面的
  // tracked close 钩子把底层请求流也销毁。
  raw.pipe(tracked);
  return tracked;
}

function validProviderUploadId(value: string | undefined) {
  if (!value || value.length > 2_048 || /[\r\n\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Multipart provider upload id is invalid");
  }
  return value;
}

function validSessionId(value: string | undefined) {
  if (
    !value ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
  ) {
    throw new Error("Multipart upload session id is invalid");
  }
  return value;
}

function validPartNumber(value: number | undefined) {
  return boundedInteger(value ?? 0, "partNumber", 1, 10_000);
}

function validPartSize(value: number | undefined) {
  return boundedInteger(value ?? 0, "part size", 1, 5 * 1024 * 1024 * 1024);
}

function validPartNumberMarker(value: string | undefined) {
  if (!value || !/^\d{1,5}$/.test(value)) throw new Error("Multipart part marker is invalid");
  const parsed = Number(value);
  validPartNumber(parsed);
  return String(parsed);
}

function validatedCompletedParts(parts: readonly MediaMultipartObjectPart[]) {
  if (!parts.length || parts.length > 10_000)
    throw new Error("Multipart completion parts are invalid");
  const sorted = parts
    .map((part) => ({
      partNumber: validPartNumber(part.partNumber),
      size: validPartSize(part.size),
      versionToken: validEtag(part.versionToken),
    }))
    .sort((left, right) => left.partNumber - right.partNumber);
  if (
    sorted.some((part, index) => index > 0 && part.partNumber === sorted[index - 1]!.partNumber)
  ) {
    throw new Error("Multipart completion contains duplicate parts");
  }
  return sorted;
}

function validObjectSize(value: number | undefined, maximum: number) {
  if (!Number.isSafeInteger(value) || value === undefined || value <= 0 || value > maximum) {
    throw new Error("Stored media object size is invalid");
  }
  return value;
}

function validEtag(value: string | undefined) {
  if (!value || value.length > 256 || /[\r\n\u0000]/.test(value))
    throw new Error("Stored media object version is invalid");
  return value;
}

function assertRange(start: number, end: number, totalSize: number) {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end >= totalSize
  ) {
    throw new RangeError("Requested media range is invalid");
  }
}

function normalizePrefix(value: string | undefined) {
  const normalized = value?.trim().replace(/^\/+|\/+$/g, "") ?? "";
  if (!normalized) return "";
  if (normalized.split("/").some((segment) => !/^[A-Za-z0-9_-]{1,128}$/.test(segment))) {
    throw new Error("S3 key prefix is invalid");
  }
  return `${normalized}/`;
}

function safeEndpoint(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))
  ) {
    throw new Error("S3 endpoint must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error("S3 endpoint is invalid");
  return url.toString().replace(/\/$/, "");
}

function safeSignedUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))
  ) {
    throw new Error("Signed media URL must use HTTPS");
  }
  if (url.username || url.password || url.hash) throw new Error("Signed media URL is invalid");
  return url.toString();
}

function safeDownloadName(value: string) {
  const name = basename(value)
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 128);
  return name || "media";
}

function hexToBase64(value: string) {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("Media SHA-256 is invalid");
  return Buffer.from(value, "hex").toString("base64");
}

function requiredToken(value: string, name: string, pattern: RegExp) {
  const normalized = value.trim();
  if (!pattern.test(normalized)) throw new Error(`${name} is invalid`);
  return normalized;
}

function secret(value: string, name: string) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length < 32) throw new Error(`${name} must contain at least 32 bytes`);
  return bytes;
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
