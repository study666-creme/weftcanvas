import { afterEach, describe, expect, it, vi } from "vitest";

import { createBoundedImageLoader, type BoundedImageLoader } from "./bounded-image-loader";

function fakeBlob(): Blob {
  return new Blob(["image"], { type: "image/png" });
}

function okResponse(blob: Blob = fakeBlob()): Response {
  return { ok: true, status: 200, blob: async () => blob } as unknown as Response;
}

function statusResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    blob: async () => new Blob([]),
  } as unknown as Response;
}

type LoaderHarness = {
  loader: BoundedImageLoader;
  fetchCalls: string[];
  revoke: ReturnType<typeof vi.fn>;
};

function makeLoader(
  overrides: {
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
    decode?: () => Promise<{ width: number; height: number }>;
    nativeDecode?: (url: string, signal: AbortSignal) => Promise<{ width: number; height: number }>;
    maxConcurrent?: number;
    maxQueued?: number;
    maxCachedBlobs?: number;
    maxRetries?: number;
    retryBaseDelayMs?: number;
    objectUrlGraceMs?: number;
    attemptTimeoutMs?: number;
  } = {},
): LoaderHarness {
  const fetchCalls: string[] = [];
  const revoke = vi.fn();
  let urlSequence = 0;
  const loader = createBoundedImageLoader({
    fetchFn: async (url, init) => {
      fetchCalls.push(url);
      if (overrides.fetch) return overrides.fetch(url, init);
      return okResponse();
    },
    decodeFn: overrides.decode ?? (async () => ({ width: 100, height: 80 })),
    nativeDecodeFn: overrides.nativeDecode ?? (async () => ({ width: 60, height: 40 })),
    createObjectUrl: () => {
      urlSequence += 1;
      return `blob:img-${urlSequence}`;
    },
    revokeObjectUrl: revoke,
    maxConcurrent: overrides.maxConcurrent ?? 2,
    maxQueued: overrides.maxQueued ?? 16,
    maxCachedBlobs: overrides.maxCachedBlobs ?? 48,
    maxRetries: overrides.maxRetries ?? 2,
    retryBaseDelayMs: overrides.retryBaseDelayMs ?? 10,
    objectUrlGraceMs: overrides.objectUrlGraceMs ?? 10,
    attemptTimeoutMs: overrides.attemptTimeoutMs ?? 20_000,
  });
  return { loader, fetchCalls, revoke };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("bounded image loader", () => {
  it("bounds concurrent fetches and starts queued work when a slot frees", async () => {
    const { loader, fetchCalls } = makeLoader({
      maxConcurrent: 2,
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return okResponse();
      },
    });
    const first = loader.acquire("a");
    const second = loader.acquire("b");
    const third = loader.acquire("c");

    await vi.waitFor(() => expect(fetchCalls).toEqual(["a", "b"]), { interval: 5 });
    await Promise.all([first, second, third]);
    expect(fetchCalls).toEqual(["a", "b", "c"]);
  });

  it("starts a high-priority queued request before a low-priority one", async () => {
    const { loader, fetchCalls } = makeLoader({
      maxConcurrent: 1,
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return okResponse();
      },
    });
    const running = loader.acquire("running");
    const low = loader.acquire("low", { priority: "low" });
    const high = loader.acquire("high", { priority: "high" });

    await vi.waitFor(() => expect(fetchCalls).toEqual(["running"]), { interval: 5 });
    await running;
    await vi.waitFor(() => expect(fetchCalls).toEqual(["running", "high"]), { interval: 5 });
    await high;
    await low;
    expect(fetchCalls).toEqual(["running", "high", "low"]);
  });

  it("deduplicates concurrent acquires of the same URL into one fetch", async () => {
    const { loader, fetchCalls } = makeLoader();
    const [first, second] = await Promise.all([loader.acquire("same"), loader.acquire("same")]);
    expect(fetchCalls.filter((url) => url === "same")).toHaveLength(1);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.url).toBe(second!.url);
    expect(first!.width).toBe(100);
    expect(first!.height).toBe(80);
  });

  it("never starts a queued request that is released before a slot opens", async () => {
    const { loader, fetchCalls } = makeLoader({
      maxConcurrent: 1,
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return okResponse();
      },
    });
    const running = loader.acquire("running");
    const dropped = loader.acquire("dropped");
    await vi.waitFor(() => expect(fetchCalls).toEqual(["running"]));
    loader.release("dropped");
    await expect(dropped).resolves.toBeNull();
    await running;
    expect(fetchCalls).toEqual(["running"]);
  });

  it("aborts an in-flight request when its last reference releases", async () => {
    let pendingSignal: AbortSignal | null | undefined = null;
    let rejectFetch!: (cause: Error) => void;
    const { loader, fetchCalls } = makeLoader({
      fetch: (_url, init) => {
        pendingSignal = init.signal;
        return new Promise<Response>((_resolve, reject) => {
          rejectFetch = reject;
        });
      },
    });
    const request = loader.acquire("slow");
    await vi.waitFor(() => expect(pendingSignal).not.toBeNull());
    expect(fetchCalls).toEqual(["slow"]);
    loader.release("slow");
    expect(pendingSignal!.aborted).toBe(true);
    rejectFetch(new Error("aborted"));
    await expect(request).resolves.toBeNull();
  });

  it("resolves only after decode, then reuses the object URL from memory", async () => {
    let releaseDecode!: () => void;
    let decoded = false;
    const decodeGate = new Promise<void>((resolve) => {
      releaseDecode = resolve;
    });
    const { loader, fetchCalls, revoke } = makeLoader({
      decode: async () => {
        await decodeGate;
        decoded = true;
        return { width: 120, height: 90 };
      },
    });
    const request = loader.acquire("decode-gated");
    let settled = false;
    void request.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);
    releaseDecode();
    const first = await request;
    expect(decoded).toBe(true);
    expect(first!.width).toBe(120);
    expect(first!.height).toBe(90);

    const second = await loader.acquire("decode-gated");
    expect(second!.url).toBe(first!.url);
    expect(fetchCalls.filter((url) => url === "decode-gated")).toHaveLength(1);

    loader.release("decode-gated");
    loader.release("decode-gated");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(revoke).not.toHaveBeenCalled();
    const withinGrace = await loader.acquire("decode-gated");
    expect(withinGrace!.url).toBe(first!.url);
    expect(fetchCalls.filter((url) => url === "decode-gated")).toHaveLength(1);
    loader.release("decode-gated");

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(revoke).toHaveBeenCalledWith(first!.url);
    const afterGrace = await loader.acquire("decode-gated");
    expect(fetchCalls.filter((url) => url === "decode-gated")).toHaveLength(1);
    expect(afterGrace).not.toBeNull();
    expect(afterGrace!.width).toBe(120);
    loader.release("decode-gated");
  });

  it("retries transient 5xx responses with bounded backoff before succeeding", async () => {
    let attempts = 0;
    const { loader, fetchCalls } = makeLoader({
      maxRetries: 2,
      retryBaseDelayMs: 5,
      fetch: async () => {
        attempts += 1;
        return attempts < 3 ? statusResponse(503) : okResponse();
      },
    });
    const result = await loader.acquire("retryable");
    expect(result).not.toBeNull();
    expect(attempts).toBe(3);
    expect(fetchCalls).toEqual(["retryable", "retryable", "retryable"]);
  });

  it("treats a 404 as a permanent failure without retries", async () => {
    const { loader, fetchCalls } = makeLoader({ fetch: async () => statusResponse(404) });
    await expect(loader.acquire("missing")).resolves.toBeNull();
    expect(fetchCalls).toEqual(["missing"]);
  });

  it("treats undecodable content as a permanent failure", async () => {
    const { loader, fetchCalls } = makeLoader({
      decode: async () => {
        throw new Error("decode failed");
      },
    });
    await expect(loader.acquire("bad")).resolves.toBeNull();
    expect(fetchCalls).toEqual(["bad"]);
  });

  it("falls back to a native decode when fetch cannot reach a cross-origin resource", async () => {
    const nativeDecode = vi.fn(async (_url: string) => ({ width: 60, height: 40 }));
    const { loader, fetchCalls } = makeLoader({
      maxRetries: 2,
      retryBaseDelayMs: 2,
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
      nativeDecode,
    });
    const result = await loader.acquire("cdn-image");
    expect(result).not.toBeNull();
    expect(result!.url).toBe("cdn-image");
    expect(result!.blob).toBeNull();
    expect(result!.width).toBe(60);
    expect(nativeDecode).toHaveBeenCalledTimes(1);
    expect(fetchCalls.filter((url) => url === "cdn-image")).toHaveLength(3);

    const cached = await loader.acquire("cdn-image");
    expect(cached!.url).toBe("cdn-image");
    expect(fetchCalls.filter((url) => url === "cdn-image")).toHaveLength(3);
  });

  it("keeps an overflowing queued request waitable instead of failing it permanently", async () => {
    const { loader, fetchCalls } = makeLoader({
      maxConcurrent: 1,
      maxQueued: 1,
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return okResponse();
      },
    });
    const running = loader.acquire("running");
    const low = loader.acquire("low", { priority: "low" });
    const high = loader.acquire("high", { priority: "high" });
    // 队列爆满时最低优先级请求进入 overflow，仍可等待，绝不会 settle(null)。
    let lowSettledNull = false;
    void low.then((outcome) => {
      if (outcome === null) lowSettledNull = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(lowSettledNull).toBe(false);
    await Promise.all([running, high, low]);
    expect(lowSettledNull).toBe(false);
    expect(fetchCalls).toEqual(["running", "high", "low"]);
  });

  it("releases an overflow entry when its last reference goes away", async () => {
    const { loader, fetchCalls } = makeLoader({
      maxConcurrent: 1,
      maxQueued: 1,
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return okResponse();
      },
    });
    const running = loader.acquire("running");
    const low = loader.acquire("low", { priority: "low" });
    const high = loader.acquire("high", { priority: "high" });
    loader.release("low");
    await expect(low).resolves.toBeNull();
    await Promise.all([running, high]);
    expect(fetchCalls).toEqual(["running", "high"]);
  });

  it("promotes the highest-priority overflow entry once queue capacity frees", async () => {
    const { loader, fetchCalls } = makeLoader({
      maxConcurrent: 1,
      maxQueued: 1,
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return okResponse();
      },
    });
    const running = loader.acquire("running");
    const low = loader.acquire("low", { priority: "low" });
    const high = loader.acquire("high", { priority: "high" });
    await running;
    await high;
    await low;
    expect(fetchCalls).toEqual(["running", "high", "low"]);
  });

  it("evicts the oldest decoded blob once the memory cache is full", async () => {
    const { loader, fetchCalls, revoke } = makeLoader({ maxCachedBlobs: 1, objectUrlGraceMs: 5 });
    const first = await loader.acquire("img-a");
    const second = await loader.acquire("img-b");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    loader.release("img-a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(revoke).toHaveBeenCalledWith(first!.url);

    const reloaded = await loader.acquire("img-a");
    expect(reloaded).not.toBeNull();
    expect(fetchCalls.filter((url) => url === "img-a")).toHaveLength(2);
    loader.release("img-a");
    loader.release("img-b");
  });

  it("times out a never-resolving fetch, aborts it, and settles within bounded retries", async () => {
    let pendingSignalAfterTimeout: AbortSignal | null | undefined = null;
    const { loader, fetchCalls } = makeLoader({
      maxRetries: 2,
      attemptTimeoutMs: 5,
      nativeDecode: () => new Promise(() => {}),
      fetch: (_url, init) => {
        pendingSignalAfterTimeout = init.signal;
        return new Promise<Response>(() => {});
      },
    });

    const outcome = await loader.acquire("never-resolves");
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(outcome).toBeNull();
    expect(fetchCalls).toEqual(["never-resolves", "never-resolves", "never-resolves"]);
    // Every timed-out attempt aborted its pending fetch.
    expect(pendingSignalAfterTimeout!.aborted).toBe(true);
  });

  it("settles a hung decode on the per-attempt deadline instead of spinning forever", async () => {
    let hung = true;
    const { loader } = makeLoader({
      maxRetries: 1,
      retryBaseDelayMs: 2,
      attemptTimeoutMs: 5,
      decode: () =>
        hung
          ? new Promise<{ width: number; height: number }>(() => {})
          : Promise.resolve({ width: 100, height: 80 }),
      nativeDecode: () => new Promise(() => {}),
    });

    const outcome = await loader.acquire("hung-decode");
    expect(outcome).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 10));
    hung = false;
    // A fresh acquire after the hung decode timed out no longer hangs.
    const retry = await loader.acquire("hung-decode");
    expect(retry).not.toBeNull();
    loader.release("hung-decode");
  });

  it("frees the concurrency slot when an attempt times out and ignores a late completion", async () => {
    let lateResolve!: (response: Response) => void;
    const { loader, fetchCalls } = makeLoader({
      maxConcurrent: 1,
      maxRetries: 0,
      // 宽松的超时窗口 + 用「等 fetch 真发出」代替固定 sleep：真实计时器下
      // 5ms 级别的固定等待会在 CI 负载下漂移（曾致 CI 首绿失败）。
      attemptTimeoutMs: 300,
      nativeDecode: () => new Promise(() => {}),
      fetch: () =>
        new Promise<Response>((resolve) => {
          lateResolve = resolve;
        }),
    });

    const first = loader.acquire("slow-a");
    const second = loader.acquire("slow-b");
    // "槽位已释放、b 的 fetch 已发出"的确定信号——不再靠固定时长去撞窗口。
    await vi.waitFor(() => expect(fetchCalls).toEqual(["slow-a", "slow-b"]), {
      timeout: 5_000,
      interval: 10,
    });

    // The timed-out first attempt released its slot and the queued second
    // request started instead of waiting forever.
    expect(await first).toBeNull();
    // 在 b 的 fetch 窗口内解除挂起；a 的迟到完成被忽略（already null）。
    lateResolve(okResponse());
    expect(await second).not.toBeNull();
    loader.release("slow-a");
    loader.release("slow-b");
  });

  it("keeps retry count and backoff bounded across consecutive timeouts", async () => {
    const { loader, fetchCalls } = makeLoader({
      maxRetries: 2,
      attemptTimeoutMs: 5,
      nativeDecode: () => new Promise(() => {}),
      fetch: () => new Promise<Response>(() => {}),
    });

    const outcome = await loader.acquire("always-times-out");
    expect(outcome).toBeNull();
    // Exactly one initial attempt plus the bounded retry budget; never more.
    expect(fetchCalls).toHaveLength(3);
  });

  it("reports an exhausted retryable status as transient so callers can keep waiting", async () => {
    const { loader, fetchCalls } = makeLoader({
      maxRetries: 2,
      retryBaseDelayMs: 2,
      fetch: async () => statusResponse(503),
    });

    await expect(loader.acquireDetailed("warming")).resolves.toEqual({
      asset: null,
      failure: "transient",
    });
    // One initial attempt plus the bounded retry budget, then reported transient
    // (a slow first-time derivative generation is expected to recover).
    expect(fetchCalls).toEqual(["warming", "warming", "warming"]);
  });

  it("reports a 404 and undecodable content as permanent failures", async () => {
    const missing = makeLoader({ fetch: async () => statusResponse(404) });
    await expect(missing.loader.acquireDetailed("missing")).resolves.toEqual({
      asset: null,
      failure: "permanent",
    });

    const bad = makeLoader({
      decode: async () => {
        throw new Error("decode failed");
      },
    });
    await expect(bad.loader.acquireDetailed("bad")).resolves.toEqual({
      asset: null,
      failure: "permanent",
    });
  });

  it("reports exhausted timeouts as transient", async () => {
    const { loader } = makeLoader({
      maxRetries: 1,
      attemptTimeoutMs: 5,
      nativeDecode: () => new Promise(() => {}),
      fetch: () => new Promise<Response>(() => {}),
    });

    await expect(loader.acquireDetailed("never-resolves")).resolves.toEqual({
      asset: null,
      failure: "transient",
    });
  });

  it("reports a released request as neither success nor failure", async () => {
    const { loader, fetchCalls } = makeLoader({ maxConcurrent: 1 });
    const running = loader.acquire("running");
    const dropped = loader.acquireDetailed("dropped");
    await vi.waitFor(() => expect(fetchCalls).toEqual(["running"]));
    loader.release("dropped");
    await expect(dropped).resolves.toEqual({ asset: null, failure: null });
    await running;
  });

  it("keeps the legacy acquire contract returning null for every failure", async () => {
    const transient = makeLoader({
      maxRetries: 0,
      attemptTimeoutMs: 5,
      fetch: async () => statusResponse(503),
    });
    await expect(transient.loader.acquire("warming")).resolves.toBeNull();

    const permanent = makeLoader({ fetch: async () => statusResponse(404) });
    await expect(permanent.loader.acquire("missing")).resolves.toBeNull();
  });
});
