import { describe, expect, it } from "vitest";

import { createApiApp } from "../app.js";
import { KachangCatalogAdapter } from "../catalog/adapter.js";
import { NON_MJ_NOW_ISO, buildNonMjSourceCatalog } from "../catalog/nonmj-catalog-fixture.js";
import { GenerationQuoteService } from "../catalog/quote.js";
import { MemoryCatalogSnapshotStore } from "../catalog/store.js";
import { IdentityService } from "../identity/service.js";
import type {
  ActiveIdentitySession,
  CreateIdentityAccountResult,
  IdentityPasswordHasher,
  IdentitySessionRecord,
  IdentityStore,
  IdentityUserRecord,
} from "../identity/types.js";
import {
  MemoryPromptHubGenerationStore,
  MemoryPromptHubReferenceStore,
  PromptHubGenerationService,
} from "./prompt-hub-service.js";

const NOW = Date.parse(NON_MJ_NOW_ISO);
const TIMESTAMP = NON_MJ_NOW_ISO;
const USER_ID = "99999999-9999-4999-8999-999999999999";
const TOKEN = "H".repeat(43);
const SESSION_TOKEN = "K".repeat(43);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createHostedApp(options: {
  fetch: (url: URL, init: RequestInit | undefined) => Promise<Response>;
  generationStream: { pollIntervalMs: number; heartbeatMs: number; maxDurationMs: number };
  observationSettleWaitMs?: number;
  requestTimeoutMs?: number;
  resolveUpstreamAccess?: (token?: string, options?: { force?: boolean }) => Promise<{
    data: { accessToken: string };
    refreshedToken?: string;
    expiresAt?: string;
  }>;
}) {
  const adapter = new KachangCatalogAdapter({
    sourceUrl: "https://catalog.test/models",
    store: new MemoryCatalogSnapshotStore(),
    now: () => NOW,
    includeKnownModels: true,
    fetch: async () => json(buildNonMjSourceCatalog(), 200),
  });
  const quotes = new GenerationQuoteService(adapter, { now: () => NOW });
  const store = new MemoryPromptHubGenerationStore();
  const references = new MemoryPromptHubReferenceStore();
  const generation = new PromptHubGenerationService(
    quotes,
    { resolveUpstreamAccess: options.resolveUpstreamAccess ?? (async () => ({ data: { accessToken: "access-token" } })) },
    store,
    {
      apiBaseUrl: "https://prompt-hub.test",
      now: () => NOW,
      requestTimeoutMs: options.requestTimeoutMs ?? 2_000,
      observationSettleWaitMs: options.observationSettleWaitMs ?? 40,
      fetch: options.fetch,
      references,
    },
  );
  const identity = new IdentityService(new MemoryIdentityStore(), {
    now: () => NOW,
    createId: () => USER_ID,
    createToken: () => TOKEN,
    passwordHasher: new TestPasswordHasher(),
    sessionTtlMs: 60_000,
  });
  const guard = new MemoryGuard();
  const app = createApiApp({
    catalog: adapter,
    quotes,
    identity,
    generation,
    generationGuard: guard,
    generationStream: options.generationStream,
  });
  return { app, guard, store, generation };
}

async function seedImageJob(
  store: MemoryPromptHubGenerationStore,
  id: string,
  upstreamTaskId: string,
  progress = 48,
) {
  const record = {
    ownerId: USER_ID,
    idempotencyKey: `canvas:sse-request-${id}`,
    upstreamJobId: upstreamTaskId,
    provider: "prompt-hub" as const,
    resultUrls: [],
    submission: {
      projectId: "project-sse-1",
      nodeId: "node-sse-1",
      modelId: "image2",
      modality: "image" as const,
      parameters: { prompt: "test", n: 1 },
      inputs: { images: [], styleImages: [], elementImages: [], videos: [], audios: [] },
      quantity: 1,
      expectedQuote: {
        id: "quote-sse-1",
        modelId: "image2",
        creditMicros: 5_500_000,
        pricingVersion: "pricing-sse-1",
        expiresAt: new Date(NOW + 120_000).toISOString(),
      },
      idempotencyKey: `canvas:sse-request-${id}`,
    },
    job: {
      schemaVersion: 1 as const,
      version: 0,
      id,
      projectId: "project-sse-1",
      nodeId: "node-sse-1",
      modelId: "image2",
      modelLabel: "全能模型2",
      modality: "image" as const,
      status: "running" as const,
      progress,
      quote: {
        id: "quote-sse-1",
        modelId: "image2",
        modelLabel: "全能模型2",
        modality: "image" as const,
        quantity: 1,
        normalizedParameters: { prompt: "test", n: 1 },
        creditMicros: 5_500_000,
        credits: "5.5",
        yuanMicros: 55_000,
        yuan: "0.055",
        estimated: false,
        pricingUnit: "image" as const,
        outputCount: 1,
        catalogVersion: "catalog-sse-1",
        capabilityVersion: "capability-sse-1",
        pricingVersion: "pricing-sse-1",
        expiresAt: new Date(NOW + 120_000).toISOString(),
      },
      artifacts: [],
      error: null,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      startedAt: TIMESTAMP,
      completedAt: null,
    },
  };
  expect(await store.create(record, 100)).toBe("created");
}

async function register(app: ReturnType<typeof createApiApp>["app"]) {
  const response = await app.request("http://localhost/api/v1/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify({ email: "creator@example.com", password: "private-password" }),
  });
  return response.headers.get("Set-Cookie")!.split(";", 1)[0]!;
}

describe("hosted observation SSE route with the real reconciliation service", () => {
  it("emits the initial stale running snapshot and then the background-completed durable result on the same bounded stream", async () => {
    let upstreamReads = 0;
    const { app, guard, store } = createHostedApp({
      generationStream: { pollIntervalMs: 5, heartbeatMs: 100, maxDurationMs: 2_000 },
      fetch: async (url) => {
        if (url.pathname === "/api/v1/generate/jobs/task-sse-live") {
          upstreamReads += 1;
          if (upstreamReads === 1) {
            // The first owner-scoped read observes only the old nonterminal
            // snapshot; the background read-only reconciliation then persists
            // a higher-version completed snapshot.
            return json({ ok: true, data: { jobId: "task-sse-live", status: "running", progress: 48 } });
          }
          return json({
            ok: true,
            data: {
              jobId: "task-sse-live",
              status: "completed",
              progress: 100,
              image_urls: ["https://cdn.example/results/sse-1.png"],
            },
          });
        }
        throw new Error(`unexpected upstream request ${url.href}`);
      },
    });
    await seedImageJob(store, "phj_sse_live", "task-sse-live");
    const cookie = await register(app);

    const response = await app.request("http://localhost/api/v1/generation-jobs/phj_sse_live/events", {
      headers: { Cookie: cookie },
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const runningIndex = body.indexOf('"status":"running"');
    const completedIndex = body.indexOf('"status":"completed"');
    expect(runningIndex).toBeGreaterThanOrEqual(0);
    expect(completedIndex).toBeGreaterThan(runningIndex);
    expect(body).toContain("id: generation:phj_sse_live:0");
    expect(body).toContain("id: generation:phj_sse_live:1");
    expect((body.match(/event: job/g) ?? [])).toHaveLength(2);
    expect(guard.streamReleases).toBe(1);
    expect(upstreamReads).toBe(2);
  });

  it("does not duplicate events for an unchanged version and still terminates the stream at its deadline", async () => {
    const { app, guard, store } = createHostedApp({
      generationStream: { pollIntervalMs: 5, heartbeatMs: 100, maxDurationMs: 300 },
      fetch: async (url) => {
        if (url.pathname === "/api/v1/generate/jobs/task-sse-stable") {
          // Same status and progress as the seeded durable snapshot: the
          // read-only reconciliation has nothing to advance, so the public
          // version never changes and the stream must not re-emit it.
          return json({ ok: true, data: { jobId: "task-sse-stable", status: "running", progress: 48 } });
        }
        throw new Error(`unexpected upstream request ${url.href}`);
      },
    });
    await seedImageJob(store, "phj_sse_stable", "task-sse-stable");
    const cookie = await register(app);

    const response = await app.request("http://localhost/api/v1/generation-jobs/phj_sse_stable/events", {
      headers: { Cookie: cookie },
    });
    const body = await response.text();

    // Exactly one running snapshot is emitted; repeated reads of the same
    // durable version never re-emit it.
    expect((body.match(/event: job/g) ?? [])).toHaveLength(1);
    expect(body).toContain('"status":"running"');
    expect(body).not.toContain('"status":"completed"');
    expect(guard.streamReleases).toBe(1);
  });

  it("writes a status-error fallback and releases the stream when a rotated session is returned mid-stream", async () => {
    const { app, guard, store } = createHostedApp({
      generationStream: { pollIntervalMs: 5, heartbeatMs: 100, maxDurationMs: 2_000 },
      resolveUpstreamAccess: async () => ({
        data: { accessToken: "access-token" },
        refreshedToken: "rotated-session-token-1",
        expiresAt: new Date(NOW + 60_000).toISOString(),
      }),
      fetch: async (url) => {
        if (url.pathname === "/api/v1/generate/jobs/task-sse-session") {
          return json({ ok: true, data: { jobId: "task-sse-session", status: "running", progress: 40 } });
        }
        throw new Error(`unexpected upstream request ${url.href}`);
      },
    });
    await seedImageJob(store, "phj_sse_session", "task-sse-session");
    const cookie = await register(app);

    const response = await app.request("http://localhost/api/v1/generation-jobs/phj_sse_session/events", {
      headers: { Cookie: cookie },
    });
    const body = await response.text();

    expect(body).toContain('event: status-error');
    expect(body).toContain("SESSION_REFRESH_REQUIRED");
    expect(guard.streamReleases).toBe(1);
  });

  it("releases the connection and stops reading when the client aborts the stream", async () => {
    let upstreamReads = 0;
    const { app, guard, store } = createHostedApp({
      generationStream: { pollIntervalMs: 5, heartbeatMs: 100, maxDurationMs: 10_000 },
      fetch: async (url) => {
        if (url.pathname === "/api/v1/generate/jobs/task-sse-abort") {
          upstreamReads += 1;
          return json({ ok: true, data: { jobId: "task-sse-abort", status: "running", progress: 40 } });
        }
        throw new Error(`unexpected upstream request ${url.href}`);
      },
    });
    await seedImageJob(store, "phj_sse_abort", "task-sse-abort");
    const cookie = await register(app);

    const response = await app.request("http://localhost/api/v1/generation-jobs/phj_sse_abort/events", {
      headers: { Cookie: cookie },
    });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();

    await expect.poll(() => guard.streamReleases).toBe(1);
    const readsAfterAbort = upstreamReads;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(upstreamReads).toBe(readsAfterAbort);
  });

  it("bounds a hanging upstream inside the stream and cools the reconciliation down without blocking delivery", async () => {
    let upstreamReads = 0;
    const { app, guard, store, generation } = createHostedApp({
      generationStream: { pollIntervalMs: 5, heartbeatMs: 100, maxDurationMs: 300 },
      requestTimeoutMs: 80,
      fetch: async (_url, init) => {
        upstreamReads += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      },
    });
    await seedImageJob(store, "phj_sse_hang", "task-sse-hang");
    const cookie = await register(app);

    const response = await app.request("http://localhost/api/v1/generation-jobs/phj_sse_hang/events", {
      headers: { Cookie: cookie },
    });
    const body = await response.text();

    // The initial snapshot is still emitted; the stream is never blocked by the
    // hung upstream read and terminates at its bounded deadline.
    expect(body).toContain('"status":"running"');
    expect(body).not.toContain('"status":"completed"');
    expect(body).not.toContain('event: status-error');
    expect(guard.streamReleases).toBe(1);

    // The hung reconciliation has settled into its failure backoff/cooldown, so
    // a later observation performs no further upstream read inside the window.
    await generation.settleObservation();
    const readsAfterStream = upstreamReads;
    await generation.get(USER_ID, "phj_sse_hang", SESSION_TOKEN);
    expect(upstreamReads).toBe(readsAfterStream);
  });
});

class MemoryGuard {
  streamAcquires = 0;
  streamReleases = 0;

  async checkSubmission() {}

  async checkRead() {}

  async acquireStream() {
    this.streamAcquires += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.streamReleases += 1;
    };
  }
}

class MemoryIdentityStore implements IdentityStore {
  private user: IdentityUserRecord | null = null;
  private session: IdentitySessionRecord | null = null;

  async createAccount(user: IdentityUserRecord, session: IdentitySessionRecord): Promise<CreateIdentityAccountResult> {
    this.user = structuredClone(user);
    this.session = structuredClone(session);
    return { kind: "created" };
  }

  async findUserByNormalizedEmail() {
    return this.user ? structuredClone(this.user) : null;
  }

  async createSession(session: IdentitySessionRecord) {
    this.session = structuredClone(session);
    return true;
  }

  async findActiveSession(tokenHash: string, now: string): Promise<ActiveIdentitySession | null> {
    if (!this.user || !this.session || this.session.tokenHash !== tokenHash || this.session.expiresAt <= now) return null;
    return { user: structuredClone(this.user), session: structuredClone(this.session) };
  }

  async revokeSession() {
    if (this.session) this.session.revokedAt = new Date(NOW).toISOString();
  }
}

class TestPasswordHasher implements IdentityPasswordHasher {
  async hash(password: string) {
    return `test:${password}`;
  }

  async verify(password: string, hash: string) {
    return hash === `test:${password}`;
  }
}
