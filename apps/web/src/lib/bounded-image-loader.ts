import { readBlobImageDimensions } from "./image-dimensions";

// Decode ceiling: keeps node thumbnails crisp while capping per-image decode cost.
const MAX_DECODE_EDGE = 2048;

export type ImageLoadPriority = "high" | "normal" | "low";

export type LoadedImageAsset = {
  url: string;
  blob: Blob | null;
  width: number | null;
  height: number | null;
  fromMemory: boolean;
};

export type ImageLoadOutcome = LoadedImageAsset | null;

/**
 * 失败分类：`transient` 是超时/网络/可重试状态码这类「再等一会可能就好了」
 * 的失败（典型场景：服务端首次惰性生成缩略图比前端单次请求预算慢）；
 * `permanent` 是内容或权限层面的确定性失败（404/409/解码失败），重试无意义。
 * 调用方据此决定是继续耐心等待还是直接落错误态。
 */
export type ImageLoadFailure = "transient" | "permanent";

export type ImageLoadResult = {
  asset: LoadedImageAsset | null;
  /** 失败原因；成功与被取消（引用释放/主动清空）时为 null。 */
  failure: ImageLoadFailure | null;
};

type DecodedDimensions = { width: number; height: number };

type FetchedOutcome =
  | { kind: "fetched"; blob: Blob; dimensions: DecodedDimensions }
  | { kind: "native"; dimensions: DecodedDimensions };

type AttemptOutcome =
  | { kind: "fetched"; blob: Blob; dimensions: DecodedDimensions }
  | { kind: "native"; dimensions: DecodedDimensions }
  | { kind: "retry" }
  | { kind: "permanent" };

type LoadAttemptResult =
  { outcome: FetchedOutcome; failure: null } | { outcome: null; failure: ImageLoadFailure | null };

class DecodeFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecodeFailureError";
  }
}

type ObjectUrlEntry = {
  key: string;
  objectUrl: string;
  blob: Blob;
  width: number;
  height: number;
  refs: number;
  revokeTimer: ReturnType<typeof setTimeout> | null;
};

type BlobCacheEntry = { blob: Blob; width: number; height: number };

type RequestEntry = {
  key: string;
  priority: ImageLoadPriority;
  credentials: RequestCredentials;
  preferNative: boolean;
  refs: number;
  status: "queued" | "inflight";
  controller: AbortController | null;
  promise: Promise<ImageLoadResult>;
  settle: (result: ImageLoadResult) => void;
};

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
type DecodeLike = (blob: Blob, signal: AbortSignal) => Promise<DecodedDimensions>;
type NativeDecodeLike = (url: string, signal: AbortSignal) => Promise<DecodedDimensions>;

const PRIORITY_ORDER: Record<ImageLoadPriority, number> = { high: 0, normal: 1, low: 2 };

const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_MAX_QUEUED = 16;
const DEFAULT_MAX_CACHED_BLOBS = 48;
// blob 缓存按张数驱逐时，一张 8K 原图就能驻留 20MB+；48 张大图会把内存
// 推到数百 MB。字节总上限让缓存条目数不变的情况下内存仍有硬界。
const DEFAULT_MAX_CACHED_BLOB_BYTES = 192 * 1024 * 1024;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_OBJECT_URL_GRACE_MS = 5_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 12_000;

export type BoundedImageLoaderOptions = {
  maxConcurrent?: number;
  maxQueued?: number;
  maxCachedBlobs?: number;
  /** blob 缓存的字节总上限；与 maxCachedBlobs 一起构成双重驱逐界。 */
  maxCachedBlobBytes?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  objectUrlGraceMs?: number;
  /** Per-attempt deadline covering fetch + blob + decode + native fallback. */
  attemptTimeoutMs?: number;
  fetchFn?: FetchLike;
  decodeFn?: DecodeLike;
  nativeDecodeFn?: NativeDecodeLike;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
};

export function createBoundedImageLoader(
  options: BoundedImageLoaderOptions = {},
): BoundedImageLoader {
  return new BoundedImageLoader(options);
}

export class BoundedImageLoader {
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly maxCachedBlobs: number;
  private readonly maxCachedBlobBytes: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly objectUrlGraceMs: number;
  private readonly attemptTimeoutMs: number;
  private readonly fetchFn: FetchLike;
  private readonly decodeFn: DecodeLike;
  private readonly nativeDecodeFn: NativeDecodeLike;
  private readonly createObjectUrl: (blob: Blob) => string;
  private readonly revokeObjectUrl: (url: string) => void;
  private readonly queue: RequestEntry[] = [];
  // 队列达到 maxQueued 后溢出的请求：保留在内存中等待容量释放，绝不永久判定失败。
  private readonly overflow: RequestEntry[] = [];
  private readonly requests = new Map<string, RequestEntry>();
  private readonly objectUrls = new Map<string, ObjectUrlEntry>();
  private readonly blobCache = new Map<string, BlobCacheEntry>();
  private readonly nativeCache = new Map<string, DecodedDimensions>();
  private inflightCount = 0;

  constructor(options: BoundedImageLoaderOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED;
    this.maxCachedBlobs = options.maxCachedBlobs ?? DEFAULT_MAX_CACHED_BLOBS;
    this.maxCachedBlobBytes = options.maxCachedBlobBytes ?? DEFAULT_MAX_CACHED_BLOB_BYTES;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.objectUrlGraceMs = options.objectUrlGraceMs ?? DEFAULT_OBJECT_URL_GRACE_MS;
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? defaultFetch;
    this.decodeFn = options.decodeFn ?? defaultDecode;
    this.nativeDecodeFn = options.nativeDecodeFn ?? defaultNativeDecode;
    this.createObjectUrl = options.createObjectUrl ?? defaultCreateObjectUrl;
    this.revokeObjectUrl = options.revokeObjectUrl ?? defaultRevokeObjectUrl;
  }

  acquire(
    url: string,
    options: {
      priority?: ImageLoadPriority;
      credentials?: RequestCredentials;
      preferNative?: boolean;
    } = {},
  ): Promise<ImageLoadOutcome> {
    return this.acquireDetailed(url, options).then((result) => result.asset);
  }

  /**
   * 与 `acquire` 相同，但保留失败原因：调用方可以据此区分「瞬时慢」与
   * 「确定性失败」，对前者继续退避重试而不是立刻给用户看错误。
   */
  acquireDetailed(
    url: string,
    options: {
      priority?: ImageLoadPriority;
      credentials?: RequestCredentials;
      preferNative?: boolean;
    } = {},
  ): Promise<ImageLoadResult> {
    if (!url) return Promise.resolve({ asset: null, failure: null });
    const priority = options.priority ?? "normal";
    const credentials = options.credentials ?? "same-origin";
    const preferNative = options.preferNative ?? false;

    const cachedObjectUrl = this.objectUrls.get(url);
    if (cachedObjectUrl) {
      cachedObjectUrl.refs += 1;
      if (cachedObjectUrl.revokeTimer !== null) {
        clearTimeout(cachedObjectUrl.revokeTimer);
        cachedObjectUrl.revokeTimer = null;
      }
      return Promise.resolve({ asset: assetFromEntry(cachedObjectUrl, true), failure: null });
    }

    const cachedBlob = this.blobCache.get(url);
    if (cachedBlob) {
      const entry = this.hydrate(url, cachedBlob.blob, cachedBlob.width, cachedBlob.height, 1);
      return Promise.resolve({ asset: assetFromEntry(entry, true), failure: null });
    }

    const native = this.nativeCache.get(url);
    if (native) {
      return Promise.resolve({
        asset: {
          url,
          blob: null,
          width: native.width,
          height: native.height,
          fromMemory: true,
        },
        failure: null,
      });
    }

    const existing = this.requests.get(url);
    if (existing) {
      existing.refs += 1;
      return existing.promise;
    }

    let settle!: (result: ImageLoadResult) => void;
    const promise = new Promise<ImageLoadResult>((resolve) => {
      settle = resolve;
    });
    const entry: RequestEntry = {
      key: url,
      priority,
      credentials,
      preferNative,
      refs: 1,
      status: "queued",
      controller: null,
      promise,
      settle,
    };
    this.requests.set(url, entry);
    this.queue.push(entry);
    this.trimQueueIfNeeded();
    this.pump();
    return promise;
  }

  release(url: string): void {
    const request = this.requests.get(url);
    if (request) {
      request.refs -= 1;
      if (request.refs > 0) return;
      this.requests.delete(url);
      if (request.status === "queued") {
        removePendingEntry(this.queue, request);
        removePendingEntry(this.overflow, request);
        request.settle({ asset: null, failure: null });
      } else {
        request.controller?.abort();
      }
      return;
    }
    const cached = this.objectUrls.get(url);
    if (!cached) return;
    cached.refs -= 1;
    if (cached.refs > 0 || cached.revokeTimer !== null) return;
    cached.revokeTimer = setTimeout(() => {
      cached.revokeTimer = null;
      if (cached.refs > 0 || this.objectUrls.get(url) !== cached) return;
      this.objectUrls.delete(url);
      this.revokeObjectUrl(cached.objectUrl);
    }, this.objectUrlGraceMs);
  }

  clear(): void {
    this.queue.length = 0;
    this.overflow.length = 0;
    for (const request of this.requests.values()) {
      request.controller?.abort();
      request.settle({ asset: null, failure: null });
    }
    this.requests.clear();
    for (const entry of this.objectUrls.values()) {
      if (entry.revokeTimer !== null) clearTimeout(entry.revokeTimer);
      this.revokeObjectUrl(entry.objectUrl);
    }
    this.objectUrls.clear();
    this.blobCache.clear();
    this.nativeCache.clear();
    this.inflightCount = 0;
  }

  private pump(): void {
    this.promoteIfNeeded();
    while (this.inflightCount < this.maxConcurrent && this.queue.length > 0) {
      const nextIndex = this.pickNextIndex();
      const entry = this.queue.splice(nextIndex, 1)[0]!;
      entry.status = "inflight";
      entry.controller = new AbortController();
      this.inflightCount += 1;
      void this.execute(entry).finally(() => {
        this.inflightCount -= 1;
        if (this.requests.get(entry.key) === entry) this.requests.delete(entry.key);
        this.pump();
      });
    }
  }

  private promoteIfNeeded(): void {
    while (this.queue.length < this.maxQueued && this.overflow.length > 0) {
      const best = this.indexOfHighestOverflowPriority();
      const entry = this.overflow.splice(best, 1)[0]!;
      this.queue.push(entry);
    }
  }

  private indexOfHighestOverflowPriority(): number {
    let best = 0;
    for (let index = 1; index < this.overflow.length; index += 1) {
      if (
        PRIORITY_ORDER[this.overflow[index]!.priority] <
        PRIORITY_ORDER[this.overflow[best]!.priority]
      )
        best = index;
    }
    return best;
  }

  private pickNextIndex(): number {
    let best = 0;
    for (let index = 1; index < this.queue.length; index += 1) {
      if (PRIORITY_ORDER[this.queue[index]!.priority] < PRIORITY_ORDER[this.queue[best]!.priority])
        best = index;
    }
    return best;
  }

  private trimQueueIfNeeded(): void {
    // 队列溢出时把最低优先级请求移入 overflow 而不是 settle(null)：可见图片
    // 不能因瞬时队列爆满被永久判定失败，容量释放后会被重新入队等待。
    while (this.queue.length > this.maxQueued) {
      const dropIndex = this.indexOfLowestPriority();
      this.overflow.push(this.queue.splice(dropIndex, 1)[0]!);
    }
  }

  private indexOfLowestPriority(): number {
    let worst = 0;
    for (let index = 1; index < this.queue.length; index += 1) {
      if (PRIORITY_ORDER[this.queue[index]!.priority] > PRIORITY_ORDER[this.queue[worst]!.priority])
        worst = index;
    }
    return worst;
  }

  private async execute(entry: RequestEntry): Promise<void> {
    const signal = entry.controller!.signal;
    const result = await this.loadWithRetries(entry);
    if (!result.outcome || entry.refs <= 0 || signal.aborted) {
      // 引用被释放/主动中止不算失败：调用方已经不再等待这次结果。
      entry.settle({ asset: null, failure: signal.aborted ? null : result.failure });
      return;
    }
    const outcome = result.outcome;
    if (outcome.kind === "fetched") {
      const hydrated = this.hydrate(
        entry.key,
        outcome.blob,
        outcome.dimensions.width,
        outcome.dimensions.height,
        entry.refs,
      );
      entry.settle({ asset: assetFromEntry(hydrated, false), failure: null });
      return;
    }
    this.cacheNative(entry.key, outcome.dimensions);
    entry.settle({
      asset: {
        url: entry.key,
        blob: null,
        width: outcome.dimensions.width,
        height: outcome.dimensions.height,
        fromMemory: false,
      },
      failure: null,
    });
  }

  /**
   * Bound every attempt to one explicit deadline covering fetch + blob +
   * decode (and the native fallback). A never-resolving fetch or hung decode
   * therefore settles instead of holding a concurrency slot forever, the
   * pending fetch is aborted on timeout, retries stay bounded, and a late
   * completion after the attempt settled is ignored by the loader.
   *
   * Exhausting the bounded retry budget on timeouts/network/retryable status
   * is reported as `transient` rather than a hard failure: the bytes may well
   * arrive on a later try (a slow first-time derivative generation is the
   * common case), and the caller decides how much longer to stay patient.
   */
  private async loadWithRetries(entry: RequestEntry): Promise<LoadAttemptResult> {
    const signal = entry.controller!.signal;
    // 跨域图片（卡片库远端缩略图）的 fetch 一定被 CORS 拦截，重试只会把同一张
    // 图下载好几遍再丢弃；直接走原生 <img> 解码，一次下载即可显示。
    if (entry.preferNative) {
      try {
        const dimensions = await raceWithTimeout(
          this.nativeDecodeFn(entry.key, signal),
          this.attemptTimeoutMs,
          () => undefined,
        );
        return { outcome: { kind: "native", dimensions }, failure: null };
      } catch {
        return { outcome: null, failure: signal.aborted ? null : "permanent" };
      }
    }
    for (let attempt = 0; ; attempt += 1) {
      if (signal.aborted) return { outcome: null, failure: null };
      const outcome = await this.attemptOnce(entry, attempt, signal);
      if (outcome.kind === "fetched" || outcome.kind === "native")
        return { outcome, failure: null };
      if (signal.aborted) return { outcome: null, failure: null };
      if (outcome.kind === "permanent") return { outcome: null, failure: "permanent" };
      if (attempt >= this.maxRetries) return { outcome: null, failure: "transient" };
      await awaitableDelay(this.retryBaseDelayMs * 2 ** attempt, signal);
      if (signal.aborted) return { outcome: null, failure: null };
    }
  }

  private async attemptOnce(
    entry: RequestEntry,
    attempt: number,
    signal: AbortSignal,
  ): Promise<AttemptOutcome> {
    const attemptController = new AbortController();
    const onAbort = () => attemptController.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const outcome = await raceWithTimeout(
        this.fetchAndDecode(entry, attemptController.signal),
        this.attemptTimeoutMs,
        () => attemptController.abort(),
      );
      if (outcome.kind === "status") {
        // 可重试状态码（429/5xx 等）用尽重试预算算瞬时失败，不算永久失败：
        // 服务端派生对象可能只是还没准备好。
        return isRetryableStatus(outcome.status) ? { kind: "retry" } : { kind: "permanent" };
      }
      return outcome;
    } catch (error) {
      if (signal.aborted) return { kind: "retry" };
      // A decode rejection is a definitive content failure, never retried.
      if (error instanceof DecodeFailureError) return { kind: "permanent" };
      // A network failure, blob failure, or per-attempt deadline expiring is
      // transient: bounded retry, then a native fallback on the last attempt.
      if (attempt >= this.maxRetries) {
        try {
          const dimensions = await raceWithTimeout(
            this.nativeDecodeFn(entry.key, attemptController.signal),
            this.attemptTimeoutMs,
            () => attemptController.abort(),
          );
          return { kind: "native", dimensions };
        } catch {
          // 原生兜底也超时/失败：仍然按瞬时失败上报，交给调用方决定是否再等。
          return { kind: "retry" };
        }
      }
      return { kind: "retry" };
    } finally {
      signal.removeEventListener("abort", onAbort);
      attemptController.abort();
    }
  }

  private async fetchAndDecode(
    entry: RequestEntry,
    attemptSignal: AbortSignal,
  ): Promise<
    | { kind: "fetched"; blob: Blob; dimensions: DecodedDimensions }
    | { kind: "status"; status: number }
  > {
    const response = await this.fetchFn(entry.key, {
      signal: attemptSignal,
      credentials: entry.credentials,
    });
    if (attemptSignal.aborted) throw new Error("aborted");
    if (!response.ok) return { kind: "status", status: response.status };
    const blob = await response.blob();
    if (attemptSignal.aborted) throw new Error("aborted");
    let dimensions: DecodedDimensions;
    try {
      dimensions = await this.decodeFn(blob, attemptSignal);
    } catch {
      throw new DecodeFailureError("decode failed");
    }
    return { kind: "fetched", blob, dimensions };
  }

  private hydrate(
    key: string,
    blob: Blob,
    width: number,
    height: number,
    refs: number,
  ): ObjectUrlEntry {
    const objectUrl = this.createObjectUrl(blob);
    const entry: ObjectUrlEntry = { key, objectUrl, blob, width, height, refs, revokeTimer: null };
    this.objectUrls.set(key, entry);
    this.cacheBlob(key, blob, width, height);
    return entry;
  }

  private cacheBlob(key: string, blob: Blob, width: number, height: number): void {
    this.blobCache.set(key, { blob, width, height });
    // FIFO 双界驱逐：先按张数，再按字节总预算从最老条目开始释放。
    // 单张 blob 超过整个字节预算时只保留它自己（否则会把刚插入的也删掉）。
    while (this.blobCache.size > this.maxCachedBlobs) {
      const oldest = this.blobCache.keys().next().value;
      if (oldest === undefined) break;
      this.blobCache.delete(oldest);
    }
    let totalBytes = 0;
    for (const entry of this.blobCache.values()) totalBytes += entry.blob.size;
    while (this.blobCache.size > 1 && totalBytes > this.maxCachedBlobBytes) {
      const oldest = this.blobCache.keys().next().value;
      if (oldest === undefined) break;
      const removed = this.blobCache.get(oldest);
      this.blobCache.delete(oldest);
      totalBytes -= removed?.blob.size ?? 0;
    }
  }

  private cacheNative(key: string, dimensions: DecodedDimensions): void {
    this.nativeCache.set(key, dimensions);
    while (this.nativeCache.size > this.maxCachedBlobs) {
      const oldest = this.nativeCache.keys().next().value;
      if (oldest === undefined) break;
      this.nativeCache.delete(oldest);
    }
  }
}

export const boundedImageLoader = createBoundedImageLoader();

export function acquireBoundedImage(
  url: string,
  options: {
    priority?: ImageLoadPriority;
    credentials?: RequestCredentials;
    preferNative?: boolean;
  } = {},
): Promise<ImageLoadOutcome> {
  return boundedImageLoader.acquire(url, options);
}

/** 同 `acquireBoundedImage`，但返回带失败原因的结果，供自愈式重试使用。 */
export function acquireBoundedImageDetailed(
  url: string,
  options: {
    priority?: ImageLoadPriority;
    credentials?: RequestCredentials;
    preferNative?: boolean;
  } = {},
): Promise<ImageLoadResult> {
  return boundedImageLoader.acquireDetailed(url, options);
}

export function releaseBoundedImage(url: string): void {
  boundedImageLoader.release(url);
}

export function clearBoundedImageCache(): void {
  boundedImageLoader.clear();
}

function assetFromEntry(entry: ObjectUrlEntry, fromMemory: boolean): LoadedImageAsset {
  return {
    url: entry.objectUrl,
    blob: entry.blob,
    width: entry.width,
    height: entry.height,
    fromMemory,
  };
}

function removePendingEntry(entries: RequestEntry[], target: RequestEntry): void {
  const index = entries.indexOf(target);
  if (index >= 0) entries.splice(index, 1);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

/**
 * Race a promise against the per-attempt deadline. On timeout the attempt's
 * AbortController is aborted (so a pending fetch is actually cancelled) and the
 * race rejects. The inner promise keeps its own settled handlers attached, so a
 * late rejection after the race already settled can never become an unhandled
 * rejection, and the timer is always cleared.
 */
function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    promise.then(resolve, reject);
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error("attempt timed out"));
    }, timeoutMs);
  }).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function awaitableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function defaultFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, init);
}

function defaultCreateObjectUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}

function defaultRevokeObjectUrl(url: string): void {
  URL.revokeObjectURL(url);
}

async function defaultDecode(blob: Blob, signal: AbortSignal): Promise<DecodedDimensions> {
  // 这里只需要尺寸，不必把整张图解码一遍：先解析容器头部，命中就直接返回，
  // 省下的这一次完整解码在图片多时非常可观（<img> 渲染时浏览器还会解码一次）。
  // 解析不了的格式（AVIF/HEIC 等）自然落到下面的完整解码。
  const headerDimensions = await readBlobImageDimensions(blob);
  if (headerDimensions) return headerDimensions;

  if (typeof createImageBitmap === "function") {
    try {
      // Cap decode dimensions: a 4K/8K reference image decoded at full size on a
      // high-DPR display is the single biggest per-node cost. Anything beyond
      // this still renders crisply at node size while bounding decode work.
      let resize: { resizeWidth: number; resizeHeight: number } | undefined;
      const known = headerDimensions as DecodedDimensions | null;
      if (known) {
        const longest = Math.max(known.width, known.height);
        if (longest > MAX_DECODE_EDGE) {
          const scale = MAX_DECODE_EDGE / longest;
          resize = {
            resizeWidth: Math.max(1, Math.round(known.width * scale)),
            resizeHeight: Math.max(1, Math.round(known.height * scale)),
          };
        }
      }
      const bitmap = resize ? await createImageBitmap(blob, resize) : await createImageBitmap(blob);
      const dimensions = { width: bitmap.width, height: bitmap.height };
      if (typeof bitmap.close === "function") bitmap.close();
      return dimensions;
    } catch {
      // Fall through to a detached <img> decode.
    }
  }
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await decodeViaImageElement(objectUrl, signal);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function defaultNativeDecode(url: string, signal: AbortSignal): Promise<DecodedDimensions> {
  return decodeViaImageElement(url, signal);
}

function decodeViaImageElement(url: string, signal: AbortSignal): Promise<DecodedDimensions> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const image = new Image();
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      image.src = "";
      reject(new Error("aborted"));
    };
    image.onload = () => {
      cleanup();
      if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
        reject(new Error("empty image"));
        return;
      }
      if (typeof image.decode === "function") {
        void image.decode().then(
          () => resolve({ width: image.naturalWidth, height: image.naturalHeight }),
          () => reject(new Error("decode failed")),
        );
        return;
      }
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      cleanup();
      reject(new Error("image load failed"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    image.decoding = "async";
    image.src = url;
  });
}
