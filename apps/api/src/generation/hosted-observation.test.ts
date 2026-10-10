import { describe, expect, it } from "vitest";

import { KachangCatalogAdapter } from "../catalog/adapter.js";
import { buildNonMjSourceCatalog, NON_MJ_NOW_ISO } from "../catalog/nonmj-catalog-fixture.js";
import { GenerationQuoteService } from "../catalog/quote.js";
import { MemoryCatalogSnapshotStore } from "../catalog/store.js";
import {
  MemoryPromptHubGenerationStore,
  MemoryPromptHubReferenceStore,
  PromptHubGenerationService,
} from "./prompt-hub-service.js";

const NOW = Date.parse(NON_MJ_NOW_ISO);
const NOW_ISO = NON_MJ_NOW_ISO;

function createService(options: {
  fetch: (url: URL, init: RequestInit | undefined) => Promise<Response>;
  now?: () => number;
  requestTimeoutMs?: number;
  resolveUpstreamAccess?: (token?: string, options?: { force?: boolean }) => Promise<{ data: { accessToken: string } }>;
}) {
  const adapter = new KachangCatalogAdapter({
    sourceUrl: "https://catalog.test/models",
    store: new MemoryCatalogSnapshotStore(),
    now: () => NOW,
    includeKnownModels: true,
    fetch: async () => new Response(JSON.stringify(buildNonMjSourceCatalog()), {
      status: 200,
      headers: { "Content-Type": "application/json", ETag: '"obs-1"' },
    }),
  });
  const quotes = new GenerationQuoteService(adapter, { now: () => NOW });
  const store = new MemoryPromptHubGenerationStore();
  const references = new MemoryPromptHubReferenceStore();
  const service = new PromptHubGenerationService(
    quotes,
    { resolveUpstreamAccess: options.resolveUpstreamAccess ?? (async () => ({ data: { accessToken: "access-token" } })) },
    store,
    {
      apiBaseUrl: "https://prompt-hub.test",
      now: options.now ?? (() => NOW),
      requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
      fetch: options.fetch,
      references,
    },
  );
  return { service, store };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

// A fetch that honors an abort signal, mirroring the real fetch behaviour that
// `AbortSignal.timeout` relies on.
function abortableDelay(signal: AbortSignal | undefined, milliseconds: number) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function seedJob(
  store: MemoryPromptHubGenerationStore,
  id: string,
  status: "queued" | "running" | "submission_unknown",
  upstreamJobId: string | null,
) {
  const timestamp = NOW_ISO;
  const record = {
    ownerId: "owner-1",
    idempotencyKey: "canvas:obs-request-001",
    upstreamJobId,
    provider: "prompt-hub" as const,
    resultUrls: [],
    submission: {
      projectId: "project-1",
      nodeId: "node-1",
      modelId: "kling-o3-pro-v2v-reference",
      modality: "video" as const,
      parameters: { prompt: "人物转身", seconds: 5 },
      inputs: { images: [], styleImages: [], elementImages: [], videos: [], audios: [] },
      quantity: 1,
      expectedQuote: {
        id: "quote-obs-1",
        modelId: "kling-o3-pro-v2v-reference",
        creditMicros: 8_500_000,
        pricingVersion: "pricing-1",
        expiresAt: new Date(NOW + 120_000).toISOString(),
      },
      idempotencyKey: "canvas:obs-request-001",
    },
    job: {
      schemaVersion: 1 as const,
      version: 0,
      id,
      projectId: "project-1",
      nodeId: "node-1",
      modelId: "kling-o3-pro-v2v-reference",
      modelLabel: "Kling O3 Pro",
      modality: "video" as const,
      status,
      progress: status === "running" ? 48 : 0,
      quote: {
        id: "quote-obs-1",
        modelId: "kling-o3-pro-v2v-reference",
        modelLabel: "Kling O3 Pro",
        modality: "video" as const,
        quantity: 1,
        normalizedParameters: { prompt: "人物转身", seconds: 5 },
        creditMicros: 8_500_000,
        credits: "8.5",
        yuanMicros: 85_000,
        yuan: "0.085",
        estimated: false,
        pricingUnit: "request" as const,
        catalogVersion: "catalog-1",
        capabilityVersion: "capability-1",
        pricingVersion: "pricing-1",
        expiresAt: new Date(NOW + 120_000).toISOString(),
      },
      artifacts: [],
      error: status === "submission_unknown"
        ? { code: "GENERATION_SUBMISSION_UNCONFIRMED", message: "任务提交结果待确认，请勿重复生成", retryable: false }
        : null,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: timestamp,
      completedAt: null,
    },
  };
  expect(await store.create(record, 100)).toBe("created");
}

describe("hosted observation non-blocking boundary", () => {
  it("returns the durable local snapshot and settles the reconciliation when the resolver never settles", async () => {
    let resolverCalls = 0;
    let resolverSettles = false;
    let clock = NOW;
    const { service, store } = createService({
      now: () => clock,
      requestTimeoutMs: 60,
      resolveUpstreamAccess: async () => {
        resolverCalls += 1;
        if (!resolverSettles) return new Promise<{ data: { accessToken: string } }>(() => {});
        return { data: { accessToken: "access-token" } };
      },
      fetch: async (url) => {
        if (url.pathname === "/api/v1/video/jobs/obs-running-1") {
          return json({ ok: true, data: { jobId: "obs-running-1", status: "running", progress: 60 } });
        }
        throw new Error(`unexpected ${url.pathname}`);
      },
    });
    await seedJob(store, "phj_obs_running", "running", "obs-running-1");

    // GET returns the durable local snapshot (running/48) immediately, before
    // the never-settling access resolver can block it.
    const result = await service.get("owner-1", "phj_obs_running");
    expect(result.data.status).toBe("running");
    expect(result.data.progress).toBe(48);
    expect(result.data.version).toBe(0);

    // The background reconciliation itself settles by the configured timeout
    // even though resolveAccess never settles.
    await service.settleObservation();
    expect(resolverCalls).toBe(1);

    // Inside the failure cooldown, later observations do not retry the resolver.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      clock += 200;
      await service.get("owner-1", "phj_obs_running");
    }
    await service.settleObservation();
    expect(resolverCalls).toBe(1);

    // After the cooldown expires and the resolver can settle, a fresh
    // observation reconciles once and persists the upstream progress.
    resolverSettles = true;
    clock += 60_000;
    await service.get("owner-1", "phj_obs_running");
    await service.settleObservation();
    expect(resolverCalls).toBe(2);
    const stored = await store.get("owner-1", "phj_obs_running");
    expect(stored?.job.progress).toBe(60);
  });

  it("single-flights concurrent observation of the same job", async () => {
    let upstreamReads = 0;
    const { service, store } = createService({
      fetch: async (url) => {
        if (url.pathname === "/api/v1/video/jobs/obs-running-2") {
          upstreamReads += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return json({ ok: true, data: { jobId: "obs-running-2", status: "running", progress: 70 } });
        }
        throw new Error(`unexpected ${url.pathname}`);
      },
    });
    await seedJob(store, "phj_obs_running_2", "running", "obs-running-2");

    const results = await Promise.all([
      service.get("owner-1", "phj_obs_running_2"),
      service.get("owner-1", "phj_obs_running_2"),
      service.get("owner-1", "phj_obs_running_2"),
    ]);
    for (const result of results) expect(result.data.status).toBe("running");

    await service.settleObservation();
    expect(upstreamReads).toBe(1);
  });

  it("never replays the paid POST while observing a known upstream task", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const { service, store } = createService({
      fetch: async (url, init) => {
        calls.push({ method: init?.method ?? "GET", path: url.pathname });
        if (url.pathname === "/api/v1/video/jobs/obs-queued-1") {
          return json({ ok: true, data: { jobId: "obs-queued-1", status: "queued", progress: 0 } });
        }
        if (url.pathname === "/api/v1/video") {
          return json({ ok: true, data: { jobId: "obs-queued-1", status: "queued", progress: 0 } });
        }
        throw new Error(`unexpected ${url.pathname}`);
      },
    });
    await seedJob(store, "phj_obs_queued", "queued", "obs-queued-1");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await service.get("owner-1", "phj_obs_queued");
    }
    await service.settleObservation();

    const posts = calls.filter((call) => call.method === "POST" && call.path === "/api/v1/video");
    expect(posts).toHaveLength(0);
    expect(calls.every((call) => call.path.startsWith("/api/v1/video/jobs/"))).toBe(true);
  });

  it("never creates a paid task while observing an unconfirmed submission with a confirmed miss", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const { service, store } = createService({
      fetch: async (url, init) => {
        calls.push({ method: init?.method ?? "GET", path: url.pathname });
        if (url.pathname === "/api/v1/video/requests/canvas%3Aobs-request-001") {
          return json({ ok: false, error: { code: "NOT_FOUND", message: "missing" } }, 404);
        }
        if (url.pathname === "/api/v1/video") {
          return json({ ok: true, data: { jobId: "must-not-be-created", status: "queued" } });
        }
        throw new Error(`unexpected ${url.pathname}`);
      },
    });
    await seedJob(store, "phj_obs_unknown", "submission_unknown", null);

    // Repeated observation of an unconfirmed submission (no upstream id, with a
    // persisted envelope) and a confirmed lookup miss must only ever perform the
    // read-only idempotency lookup; the paid creation POST count stays exactly 0.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await service.get("owner-1", "phj_obs_unknown");
    }
    await service.settleObservation();

    const posts = calls.filter((call) => call.path === "/api/v1/video");
    expect(posts).toHaveLength(0);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(calls.every((call) => call.path === "/api/v1/video/requests/canvas%3Aobs-request-001")).toBe(true);
  });

  it("backs off and cools down after an upstream failure instead of hammering it", async () => {
    let upstreamReads = 0;
    let clock = NOW;
    const { service, store } = createService({
      now: () => clock,
      fetch: async (url) => {
        if (url.pathname === "/api/v1/video/jobs/obs-running-3") {
          upstreamReads += 1;
          return json({ ok: false, error: { code: "RATE_LIMITED", message: "slow down" } }, 429);
        }
        throw new Error(`unexpected ${url.pathname}`);
      },
    });
    await seedJob(store, "phj_obs_running_3", "running", "obs-running-3");

    // First observation triggers the read-only reconciliation, which fails.
    await service.get("owner-1", "phj_obs_running_3");
    await service.settleObservation();
    expect(upstreamReads).toBe(1);

    // Repeated observations inside the cooldown window do not hit the upstream.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      clock += 200;
      await service.get("owner-1", "phj_obs_running_3");
    }
    await service.settleObservation();
    expect(upstreamReads).toBe(1);

    // After the cooldown expires, the next observation reconciles exactly once.
    clock += 60_000;
    await service.get("owner-1", "phj_obs_running_3");
    await service.settleObservation();
    expect(upstreamReads).toBe(2);
  });

  it("shares one total budget between access resolution and the upstream read", async () => {
    let resolverCalls = 0;
    let readCalls = 0;
    let resolverFast = false;
    let readFast = false;
    const { service, store } = createService({
      now: () => Date.now(),
      requestTimeoutMs: 120,
      resolveUpstreamAccess: async () => {
        resolverCalls += 1;
        await delay(resolverFast ? 0 : 90);
        return { data: { accessToken: "access-token" } };
      },
      fetch: async (url, init) => {
        if (url.pathname === "/api/v1/video/jobs/obs-running-5") {
          readCalls += 1;
          await abortableDelay(init?.signal, readFast ? 0 : 90);
          return json({ ok: true, data: { jobId: "obs-running-5", status: "running", progress: 70 } });
        }
        throw new Error(`unexpected ${url.pathname}`);
      },
    });
    await seedJob(store, "phj_obs_running_5", "running", "obs-running-5");

    // GET returns the local snapshot immediately.
    const result = await service.get("owner-1", "phj_obs_running_5");
    expect(result.data.status).toBe("running");

    // The resolver (90ms) plus the upstream read (90ms) would total 180ms under
    // per-request budgets, but the shared 120ms deadline caps the read at the
    // ~30ms remaining, so the read times out and the snapshot does not advance.
    const settleStart = Date.now();
    await service.settleObservation();
    expect(Date.now() - settleStart).toBeLessThan(300);
    expect(resolverCalls).toBe(1);
    expect(readCalls).toBe(1);
    const stored = await store.get("owner-1", "phj_obs_running_5");
    expect(stored?.job.progress).toBe(48);

    // Inside the failure cooldown, observations do not retry the resolver.
    await service.get("owner-1", "phj_obs_running_5");
    await service.settleObservation();
    expect(resolverCalls).toBe(1);

    // After the cooldown and with a fast resolver/read, a fresh observation
    // reconciles once and persists the upstream progress.
    resolverFast = true;
    readFast = true;
    await delay(2_200);
    await service.get("owner-1", "phj_obs_running_5");
    await service.settleObservation();
    expect(resolverCalls).toBe(2);
    const advanced = await store.get("owner-1", "phj_obs_running_5");
    expect(advanced?.job.progress).toBe(70);
  });

  it("bounds a 401 forced refresh to the shared deadline with cooldown and no POST", async () => {
    let forcedCalls = 0;
    let forcedSettles = false;
    const calls: Array<{ method: string; path: string }> = [];
    const { service, store } = createService({
      now: () => Date.now(),
      requestTimeoutMs: 120,
      resolveUpstreamAccess: async (_token, options) => {
        if (options?.force) {
          forcedCalls += 1;
          if (!forcedSettles) return new Promise<{ data: { accessToken: string } }>(() => {});
          return { data: { accessToken: "access-token" } };
        }
        return { data: { accessToken: "access-token" } };
      },
      fetch: async (url, init) => {
        calls.push({ method: init?.method ?? "GET", path: url.pathname });
        if (url.pathname === "/api/v1/video/jobs/obs-running-6") {
          return json({ ok: false, error: { code: "UNAUTHENTICATED", message: "expired" } }, 401);
        }
        if (url.pathname === "/api/v1/video") {
          return json({ ok: true, data: { jobId: "obs-running-6", status: "queued" } });
        }
        throw new Error(`unexpected ${url.pathname}`);
      },
    });
    await seedJob(store, "phj_obs_running_6", "running", "obs-running-6");

    // GET returns the local snapshot immediately.
    const result = await service.get("owner-1", "phj_obs_running_6", "session-token");
    expect(result.data.status).toBe("running");

    // The task read returns 401 and the forced resolver never settles; the
    // shared deadline must bound the forced refresh and settle the
    // reconciliation within the total budget (not a second full timeout).
    const settleStart = Date.now();
    await service.settleObservation();
    expect(Date.now() - settleStart).toBeLessThan(300);
    expect(forcedCalls).toBe(1);
    expect(calls.filter((call) => call.method === "POST" && call.path === "/api/v1/video")).toHaveLength(0);

    // Inside the cooldown, observations do not retry the forced refresh.
    await service.get("owner-1", "phj_obs_running_6", "session-token");
    await service.settleObservation();
    expect(forcedCalls).toBe(1);

    // After the cooldown and with a settling forced resolver, a fresh
    // observation reconciles once more.
    forcedSettles = true;
    await delay(2_200);
    await service.get("owner-1", "phj_obs_running_6", "session-token");
    await service.settleObservation();
    expect(forcedCalls).toBe(2);
  });
});
