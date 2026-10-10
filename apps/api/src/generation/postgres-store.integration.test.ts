import type { GenerationArtifact, GenerationQuote } from "@kachang/contracts";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../database/migrate.js";
import { transitionGenerationJob } from "./job-state.js";
import { PostgresGenerationJobStore } from "./postgres-store.js";
import { GenerationJobProcessor, GenerationJobService } from "./service.js";
import { GenerationProviderError, type GenerationArtifactStore, type GenerationProvider } from "./types.js";

const databaseUrl = process.env.CANVAS_TEST_DATABASE_URL;
if (databaseUrl && !new URL(databaseUrl).pathname.toLowerCase().includes("test")) {
  throw new Error("CANVAS_TEST_DATABASE_URL must name a dedicated database containing 'test'");
}
const NOW = Date.parse("2026-07-15T10:00:00.000Z");
const STARTING_BALANCE = 100_000_000;
const quote: GenerationQuote = {
  id: "quote-postgres",
  modelId: "image2",
  modelLabel: "全能模型2",
  modality: "image",
  quantity: 1,
  normalizedParameters: { prompt: "雨夜街道", size: "16:9" },
  creditMicros: 5_500_000,
  credits: "5.5",
  yuanMicros: 55_000,
  yuan: "0.055",
  estimated: false,
  pricingUnit: "image",
  catalogVersion: "catalog-1",
  capabilityVersion: "capability-1",
  pricingVersion: "pricing-1",
  expiresAt: new Date(NOW + 120_000).toISOString(),
};
const executionRoute = {
  sourceModelId: "private-image-route",
  modality: "image" as const,
  endpoint: { method: "POST" as const, path: "/v1/images/generations", contentType: "application/json" as const },
  parameters: [
    { name: "model", path: "model", type: "string" as const, fixed: "private-image-route" },
    { name: "prompt", path: "prompt", type: "string" as const },
    { name: "size", path: "size", type: "string" as const },
  ],
};

describe.skipIf(!databaseUrl)("PostgreSQL generation job store", () => {
  let pool: Pool;
  let store: PostgresGenerationJobStore;
  let sequence = 0;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
    await runMigrations(pool);
    store = new PostgresGenerationJobStore(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE canvas_wallet_ledger, canvas_wallet_reservations, canvas_generation_jobs, canvas_sessions, canvas_users CASCADE");
    await seedWallet(pool, "user-1", STARTING_BALANCE);
    sequence = 0;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("reserves exactly once for concurrent idempotent submissions", async () => {
    const service = createService(store, () => `job-${++sequence}`);
    const [first, second] = await Promise.all([
      service.submit("user-1", submission("same-request")),
      service.submit("user-1", submission("same-request")),
    ]);

    expect(first.id).toBe(second.id);
    expect(await wallet(pool)).toEqual({ available: STARTING_BALANCE - quote.creditMicros, reserved: quote.creditMicros });
    expect(await count(pool, "canvas_generation_jobs")).toBe(1);
    expect(await count(pool, "canvas_wallet_reservations")).toBe(1);
    expect(await ledgerTypes(pool)).toEqual(["credit", "reserve"]);
  });

  it("captures a validated result and atomically refunds an unused hold", async () => {
    const service = createService(store, () => "job-capture");
    const submitted = await service.submit("user-1", submission("capture-request"));
    const processor = new GenerationJobProcessor(
      store,
      immediateProvider({ kind: "output", resultRef: "result-1" }),
      artifactStore({ artifacts: [imageArtifact()], captureCreditMicros: 4_000_000 }),
      { now: () => NOW + 1_000 },
    );

    expect(await processor.process(submitted.id)).toMatchObject({ status: "completed", progress: 100 });
    expect(await wallet(pool)).toEqual({ available: STARTING_BALANCE - 4_000_000, reserved: 0 });
    expect(await reservation(pool, submitted.id)).toEqual({ status: "captured", amount: quote.creditMicros, captured: 4_000_000 });
    expect(await ledgerTypes(pool)).toEqual(["credit", "reserve", "capture"]);
    expect((await store.getById(submitted.id))?.status).toBe("completed");
  });

  it("releases a rejected job once and keeps terminal replay idempotent", async () => {
    const service = createService(store, () => "job-release");
    const submitted = await service.submit("user-1", submission("release-request"));
    const processor = new GenerationJobProcessor(
      store,
      rejectingProvider(),
      artifactStore({ artifacts: [] }),
      { now: () => NOW + 1_000 },
    );

    expect((await processor.process(submitted.id)).status).toBe("failed");
    expect((await processor.process(submitted.id)).status).toBe("failed");
    expect(await wallet(pool)).toEqual({ available: STARTING_BALANCE, reserved: 0 });
    expect(await reservation(pool, submitted.id)).toMatchObject({ status: "released", captured: 0 });
    expect(await ledgerTypes(pool)).toEqual(["credit", "reserve", "release"]);
  });

  it("allows only one compare-and-swap transition per revision", async () => {
    const service = createService(store, () => "job-cas");
    const submitted = await service.submit("user-1", submission("cas-request"));
    const current = (await store.getById(submitted.id))!;
    const first = transitionGenerationJob(current, { type: "submission_started" }, NOW + 1_000);
    const second = transitionGenerationJob(current, { type: "submission_started" }, NOW + 2_000);

    const results = await Promise.all([store.save(first, current.revision), store.save(second, current.revision)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await store.getById(submitted.id))?.revision).toBe(1);
    expect(await wallet(pool)).toEqual({ available: STARTING_BALANCE - quote.creditMicros, reserved: quote.creditMicros });
  });

  it("enforces the active-job cap under the wallet lock and lists owner work", async () => {
    const service = createService(store, () => `job-limit-${++sequence}`, 1);
    const first = await service.submit("user-1", submission("limit-request-1"));
    await expect(service.submit("user-1", submission("limit-request-2")))
      .rejects.toMatchObject({ code: "ACTIVE_JOB_LIMIT" });

    await expect(service.list("user-1", { projectId: "project-1", limit: 10 }))
      .resolves.toMatchObject([{ id: first.id, version: 0 }]);
    await expect(service.list("missing-user", { limit: 10 })).resolves.toEqual([]);
    expect(await count(pool, "canvas_generation_jobs")).toBe(1);
  });

  it("rejects immutable-field changes and terminal saves without settlement", async () => {
    const service = createService(store, () => "job-invariants");
    const submitted = await service.submit("user-1", submission("invariant-request"));
    const current = (await store.getById(submitted.id))!;
    const submitting = transitionGenerationJob(current, { type: "submission_started" }, NOW + 1_000);
    const mutated = { ...submitting, projectId: "other-project" };
    const repriced = {
      ...submitting,
      pricing: { ...submitting.pricing, baseCreditMicros: quote.creditMicros + 1 },
    };
    const failed = transitionGenerationJob(current, {
      type: "failed",
      error: { code: "TEST", message: "test", retryable: false },
    }, NOW + 1_000);

    await expect(store.save(mutated, current.revision)).rejects.toThrow("Immutable generation job fields");
    await expect(store.save(repriced, current.revision)).rejects.toThrow("Immutable generation job fields");
    await expect(store.save(failed, current.revision)).rejects.toThrow("atomic wallet settlement");
    expect((await store.getById(submitted.id))?.status).toBe("reserved");
    expect(await wallet(pool)).toEqual({ available: STARTING_BALANCE - quote.creditMicros, reserved: quote.creditMicros });
  });
});

function createService(store: PostgresGenerationJobStore, createId: () => string, maxActiveJobs = 3) {
  return new GenerationJobService(
    { createQuote: async () => structuredClone(quote) },
    { getExecutionRoute: async () => ({
      route: structuredClone(executionRoute),
      pricing: {
        mode: "fixed" as const,
        unit: "image" as const,
        currency: "CNY" as const,
        creditsPerYuan: 100,
        baseCreditMicros: quote.creditMicros,
        baseYuanMicros: quote.yuanMicros,
        tiers: [],
      },
      catalogVersion: quote.catalogVersion,
      capabilityVersion: quote.capabilityVersion,
      pricingVersion: quote.pricingVersion,
    }) },
    store,
    { now: () => NOW, createId, maxActiveJobs },
  );
}

function submission(idempotencyKey: string) {
  return {
    projectId: "project-1",
    nodeId: "node-1",
    modelId: "image2",
    modality: "image",
    parameters: { prompt: "雨夜街道", size: "16:9" },
    expectedQuote: quote,
    idempotencyKey,
  };
}

function immediateProvider(state: Awaited<ReturnType<GenerationProvider["submit"]>>): GenerationProvider {
  return {
    submit: async () => structuredClone(state),
    poll: async () => structuredClone(state),
  };
}

function rejectingProvider(): GenerationProvider {
  return {
    submit: async () => { throw new GenerationProviderError("REQUEST_REJECTED", "当前参数无法提交", "rejected"); },
    poll: async () => { throw new Error("poll should not run"); },
  };
}

function artifactStore(result: Awaited<ReturnType<GenerationArtifactStore["persist"]>>): GenerationArtifactStore {
  return { persist: async () => structuredClone(result) };
}

function imageArtifact(): GenerationArtifact {
  return {
    id: "artifact-1",
    kind: "image",
    mediaId: "media-1",
    name: "result.png",
    mimeType: "image/png",
    size: 1024,
    width: 1024,
    height: 1024,
    createdAt: new Date(NOW + 1_000).toISOString(),
  };
}

async function seedWallet(pool: Pool, ownerId: string, amount: number) {
  const timestamp = new Date(NOW).toISOString();
  await pool.query(
    `INSERT INTO canvas_users (
      id, email, normalized_email, display_name, password_hash, status,
      created_at, updated_at, last_login_at
    ) VALUES ($1, $2, $2, $3, $4, 'active', $5, $5, $5)`,
    [ownerId, `${ownerId}@example.test`, ownerId, "test-password-hash", timestamp],
  );
  await pool.query(
    "INSERT INTO canvas_wallets (owner_id, available_credit_micros) VALUES ($1, $2)",
    [ownerId, amount],
  );
  await pool.query(
    `INSERT INTO canvas_wallet_ledger (
      id, owner_id, entry_type, available_delta_micros, reserved_delta_micros, metadata
    ) VALUES ($1, $2, 'credit', $3, 0, $4::JSONB)`,
    [`ledger:credit:${ownerId}`, ownerId, amount, JSON.stringify({ source: "integration-test" })],
  );
}

async function wallet(pool: Pool) {
  const result = await pool.query<{ available_credit_micros: string; reserved_credit_micros: string }>(
    "SELECT available_credit_micros, reserved_credit_micros FROM canvas_wallets WHERE owner_id = 'user-1'",
  );
  return {
    available: Number(result.rows[0]?.available_credit_micros),
    reserved: Number(result.rows[0]?.reserved_credit_micros),
  };
}

async function reservation(pool: Pool, jobId: string) {
  const result = await pool.query<{ status: string; amount_credit_micros: string; captured_credit_micros: string }>(
    `SELECT status, amount_credit_micros, captured_credit_micros
     FROM canvas_wallet_reservations WHERE generation_job_id = $1`,
    [jobId],
  );
  return {
    status: result.rows[0]?.status,
    amount: Number(result.rows[0]?.amount_credit_micros),
    captured: Number(result.rows[0]?.captured_credit_micros),
  };
}

async function ledgerTypes(pool: Pool) {
  const result = await pool.query<{ entry_type: string }>(
    "SELECT entry_type FROM canvas_wallet_ledger ORDER BY created_at, id",
  );
  return result.rows.map((row) => row.entry_type);
}

async function count(pool: Pool, table: "canvas_generation_jobs" | "canvas_wallet_reservations") {
  const result = await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${table}`);
  return Number(result.rows[0]?.count);
}
