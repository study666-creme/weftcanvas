import type { PublicGenerationJob } from "@weftcanvas/contracts";
import { describe, expect, it } from "vitest";

import { createApiApp } from "../app.js";
import { IdentityService } from "../identity/service.js";
import type {
  ActiveIdentitySession,
  CreateIdentityAccountResult,
  IdentityPasswordHasher,
  IdentitySessionRecord,
  IdentityStore,
  IdentityUserRecord,
} from "../identity/types.js";
import { GenerationApiLimitError } from "./api-rate-limit.js";

const NOW = Date.parse("2026-07-15T22:00:00.000Z");
const USER_ID = "99999999-9999-4999-8999-999999999999";
const TOKEN = "H".repeat(43);

describe("generation job HTTP API", () => {
  it("requires identity, rejects cross-site submission, and exposes owner-scoped jobs", async () => {
    const generation = new MemoryGenerationApi();
    const guard = new MemoryGuard();
    const app = createApp(generation, guard);
    expect((await app.request("http://localhost/api/v1/generation-jobs/job-1")).status).toBe(401);
    const cookie = await register(app);

    const crossSite = await app.request("http://localhost/api/v1/generation-jobs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        Origin: "https://attacker.example",
        "Sec-Fetch-Site": "cross-site",
      },
      body: JSON.stringify({ ignored: true }),
    });
    expect(crossSite.status).toBe(403);
    expect(guard.submissionChecks).toBe(0);

    const submitted = await app.request("http://localhost/api/v1/generation-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: "http://localhost" },
      body: JSON.stringify({ request: "job" }),
    });
    expect(submitted.status).toBe(202);
    expect(await submitted.json()).toMatchObject({ ok: true, data: { id: "job-1", version: 0 } });
    expect(generation.lastSubmission).toEqual({ ownerId: USER_ID, value: { request: "job" } });

    const list = await app.request(
      "http://localhost/api/v1/generation-jobs?projectId=project-1&limit=10",
      {
        headers: { Cookie: cookie },
      },
    );
    expect(await list.json()).toMatchObject({ data: [{ id: "job-1", projectId: "project-1" }] });
    expect(generation.lastList).toEqual({
      ownerId: USER_ID,
      value: { projectId: "project-1", limit: 10 },
    });

    const item = await app.request("http://localhost/api/v1/generation-jobs/job-1", {
      headers: { Cookie: cookie },
    });
    expect(item.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await item.json()).toMatchObject({
      data: { status: "completed", artifacts: [{ kind: "image" }] },
    });
  });

  it("streams a versioned terminal snapshot and releases the connection slot", async () => {
    const generation = new MemoryGenerationApi();
    const guard = new MemoryGuard();
    const app = createApp(generation, guard);
    const cookie = await register(app);
    const response = await app.request("http://localhost/api/v1/generation-jobs/job-1/events", {
      headers: { Cookie: cookie },
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(body).toContain("event: job");
    expect(body).toContain("id: generation:job-1:0");
    expect(body).toContain('"type":"job"');
    expect(body).not.toContain("ownerId");
    expect(guard.streamAcquires).toBe(1);
    expect(guard.streamReleases).toBe(1);

    const resumed = await app.request("http://localhost/api/v1/generation-jobs/job-1/events", {
      headers: { Cookie: cookie, "Last-Event-ID": "generation:job-1:0" },
    });
    expect(await resumed.text()).toContain("event: job");
    expect(guard.streamReleases).toBe(2);
  });

  it("streams each active task version in order until completion", async () => {
    const completed = { ...completedJob(), version: 2 };
    const running: PublicGenerationJob = {
      ...completed,
      version: 1,
      status: "running",
      progress: 54,
      artifacts: [],
      completedAt: null,
      updatedAt: "2026-07-15T22:00:00.500Z",
    };
    const reserved: PublicGenerationJob = {
      ...running,
      version: 0,
      status: "reserved",
      progress: 0,
      startedAt: null,
      updatedAt: "2026-07-15T22:00:00.000Z",
    };
    const generation = new MemoryGenerationApi([reserved, running, completed]);
    const guard = new MemoryGuard();
    const app = createApp(generation, guard, {
      pollIntervalMs: 1,
      heartbeatMs: 100,
      maxDurationMs: 1_000,
    });
    const cookie = await register(app);
    const response = await app.request("http://localhost/api/v1/generation-jobs/job-1/events", {
      headers: { Cookie: cookie },
    });
    const body = await response.text();

    expect(body).toContain("id: generation:job-1:0");
    expect(body).toContain("id: generation:job-1:1");
    expect(body).toContain("id: generation:job-1:2");
    expect(body.indexOf("job-1:0")).toBeLessThan(body.indexOf("job-1:1"));
    expect(body.indexOf("job-1:1")).toBeLessThan(body.indexOf("job-1:2"));
    expect(guard.streamReleases).toBe(1);
  });

  it("emits a submission awaiting reconciliation once and closes the stream", async () => {
    const pending: PublicGenerationJob = {
      ...completedJob(),
      status: "submission_unknown",
      progress: 0,
      artifacts: [],
      error: {
        code: "SUBMISSION_STATUS_UNKNOWN",
        message: "任务提交结果待确认，请勿重复提交",
        retryable: false,
      },
      completedAt: null,
    };
    const generation = new MemoryGenerationApi([pending]);
    const guard = new MemoryGuard();
    const app = createApp(generation, guard, {
      pollIntervalMs: 1,
      heartbeatMs: 100,
      maxDurationMs: 1_000,
    });
    const cookie = await register(app);
    const response = await app.request("http://localhost/api/v1/generation-jobs/job-1/events", {
      headers: { Cookie: cookie, "Last-Event-ID": "generation:job-1:0" },
    });
    const body = await response.text();

    expect(body.match(/event: job/g)).toHaveLength(1);
    expect(body).toContain('"status":"submission_unknown"');
    expect(guard.streamReleases).toBe(1);
  });

  it("returns retry guidance when the persistent submission limit is exhausted", async () => {
    const generation = new MemoryGenerationApi();
    const guard = new MemoryGuard();
    guard.submissionError = new GenerationApiLimitError(
      "GENERATION_RATE_LIMITED",
      "提交过于频繁，请稍后再试",
      27,
    );
    const app = createApp(generation, guard);
    const cookie = await register(app);
    const response = await app.request("http://localhost/api/v1/generation-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: "http://localhost" },
      body: JSON.stringify({ request: "job" }),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("27");
    expect(await response.json()).toMatchObject({ error: { code: "GENERATION_RATE_LIMITED" } });
    expect(generation.lastSubmission).toBeNull();
  });

  it("rejects oversized JSON before parsing or submitting it", async () => {
    const generation = new MemoryGenerationApi();
    const guard = new MemoryGuard();
    const app = createApp(generation, guard);
    const cookie = await register(app);
    const response = await app.request("http://localhost/api/v1/generation-jobs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(1024 * 1024 + 1),
        Cookie: cookie,
        Origin: "http://localhost",
      },
      body: "{}",
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "JSON_TOO_LARGE" } });
    expect(generation.lastSubmission).toBeNull();
  });

  it("reconciles one durable job by its idempotency identity as a read-only owner-scoped lookup", async () => {
    const generation = new MemoryGenerationApi();
    const guard = new MemoryGuard();
    const app = createApp(generation, guard);
    const cookie = await register(app);

    const missing = await app.request(
      "http://localhost/api/v1/generation-jobs/reconcile?key=request-0001",
      {
        headers: { Cookie: cookie },
      },
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      ok: false,
      error: { code: "GENERATION_JOB_NOT_FOUND" },
    });

    generation.reconciledJob = { ...generation.job, status: "completed" };
    const found = await app.request(
      "http://localhost/api/v1/generation-jobs/reconcile?key=request-0001",
      {
        headers: { Cookie: cookie },
      },
    );
    expect(found.status).toBe(200);
    expect(found.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await found.json()).toMatchObject({
      ok: true,
      data: { id: "job-1", status: "completed" },
    });
    expect(generation.reconcileCalls).toEqual([
      { ownerId: USER_ID, key: "request-0001" },
      { ownerId: USER_ID, key: "request-0001" },
    ]);
    expect(generation.lastSubmission).toBeNull();
    expect(guard.readChecks).toBe(2);
  });

  it("rejects invalid or oversized reconciliation keys before any lookup and requires auth first", async () => {
    const generation = new MemoryGenerationApi();
    const guard = new MemoryGuard();
    const app = createApp(generation, guard);
    const cookie = await register(app);

    for (const key of ["", "short", "x".repeat(200), "bad key"]) {
      const response = await app.request(
        `http://localhost/api/v1/generation-jobs/reconcile?key=${encodeURIComponent(key)}`,
        { headers: { Cookie: cookie } },
      );
      expect(response.status).toBe(422);
    }
    expect(generation.reconcileCalls).toHaveLength(0);

    const unauthenticated = await app.request(
      "http://localhost/api/v1/generation-jobs/reconcile?key=request-0001",
    );
    expect(unauthenticated.status).toBe(401);
    expect(generation.reconcileCalls).toHaveLength(0);
  });
});

function createApp(
  generation: MemoryGenerationApi,
  guard: MemoryGuard,
  generationStream?: { pollIntervalMs: number; heartbeatMs: number; maxDurationMs: number },
) {
  const identity = new IdentityService(new MemoryIdentityStore(), {
    now: () => NOW,
    createId: () => USER_ID,
    createToken: () => TOKEN,
    passwordHasher: new TestPasswordHasher(),
    sessionTtlMs: 60_000,
  });
  return createApiApp({
    catalog: {
      getCatalog: async () => {
        throw new Error("unused");
      },
    },
    quotes: {
      createQuote: async () => {
        throw new Error("unused");
      },
    },
    identity,
    generation,
    generationGuard: guard,
    ...(generationStream ? { generationStream } : {}),
  });
}

async function register(app: ReturnType<typeof createApiApp>) {
  const response = await app.request("http://localhost/api/v1/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify({ email: "creator@example.com", password: "private-password" }),
  });
  return response.headers.get("Set-Cookie")!.split(";", 1)[0]!;
}

class MemoryGenerationApi {
  lastSubmission: { ownerId: string; value: unknown } | null = null;
  lastList: { ownerId: string; value: unknown } | null = null;
  reconcileCalls: Array<{ ownerId: string; key: string }> = [];
  reconciledJob: PublicGenerationJob | null = null;
  private getCalls = 0;
  readonly job: PublicGenerationJob;

  constructor(private readonly snapshots: PublicGenerationJob[] = [completedJob()]) {
    this.job = structuredClone(snapshots.at(-1)!);
  }

  async submit(ownerId: string, value: unknown) {
    this.lastSubmission = { ownerId, value: structuredClone(value) };
    return structuredClone(this.job);
  }

  async get(ownerId: string, jobId: string) {
    if (ownerId !== USER_ID || jobId !== this.job.id) throw new Error("unexpected job lookup");
    const snapshot = this.snapshots[Math.min(this.getCalls, this.snapshots.length - 1)]!;
    this.getCalls += 1;
    return structuredClone(snapshot);
  }

  async list(ownerId: string, value: { projectId?: string; limit?: number }) {
    this.lastList = { ownerId, value: structuredClone(value) };
    return ownerId === USER_ID ? [structuredClone(this.job)] : [];
  }

  async resolveByIdempotency(ownerId: string, key: string) {
    this.reconcileCalls.push({ ownerId, key });
    return this.reconciledJob ? structuredClone(this.reconciledJob) : null;
  }
}

class MemoryGuard {
  submissionChecks = 0;
  readChecks = 0;
  streamAcquires = 0;
  streamReleases = 0;
  submissionError: Error | null = null;

  async checkSubmission() {
    this.submissionChecks += 1;
    if (this.submissionError) throw this.submissionError;
  }

  async checkRead() {
    this.readChecks += 1;
  }

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

  async createAccount(
    user: IdentityUserRecord,
    session: IdentitySessionRecord,
  ): Promise<CreateIdentityAccountResult> {
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
    if (
      !this.user ||
      !this.session ||
      this.session.tokenHash !== tokenHash ||
      this.session.expiresAt <= now
    )
      return null;
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

function completedJob(): PublicGenerationJob {
  return {
    schemaVersion: 1,
    version: 0,
    id: "job-1",
    projectId: "project-1",
    nodeId: "node-1",
    modelId: "image2",
    modelLabel: "全能模型2",
    modality: "image",
    status: "completed",
    progress: 100,
    quote: {
      id: "quote-1",
      modelId: "image2",
      modelLabel: "全能模型2",
      modality: "image",
      quantity: 1,
      normalizedParameters: { prompt: "雨夜街道" },
      creditMicros: 5_500_000,
      credits: "5.5",
      yuanMicros: 55_000,
      yuan: "0.055",
      estimated: false,
      pricingUnit: "image",
      catalogVersion: "catalog-1",
      capabilityVersion: "capability-1",
      pricingVersion: "pricing-1",
      expiresAt: "2026-07-15T22:02:00.000Z",
    },
    artifacts: [
      {
        id: "artifact-1",
        kind: "image",
        mediaId: "media-1",
        name: "result.png",
        mimeType: "image/png",
        size: 1024,
        width: 1024,
        height: 1024,
        createdAt: "2026-07-15T22:00:01.000Z",
      },
    ],
    error: null,
    createdAt: "2026-07-15T22:00:00.000Z",
    updatedAt: "2026-07-15T22:00:01.000Z",
    startedAt: "2026-07-15T22:00:00.100Z",
    completedAt: "2026-07-15T22:00:01.000Z",
  };
}
