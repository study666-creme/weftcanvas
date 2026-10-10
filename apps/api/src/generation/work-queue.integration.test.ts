import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../database/migrate.js";
import { PostgresGenerationWorkQueue } from "./work-queue.js";

const databaseUrl = process.env.CANVAS_TEST_DATABASE_URL;
if (databaseUrl && !new URL(databaseUrl).pathname.toLowerCase().includes("test")) {
  throw new Error("CANVAS_TEST_DATABASE_URL must name a dedicated database containing 'test'");
}
const NOW = Date.parse("2026-07-15T21:00:00.000Z");

describe.skipIf(!databaseUrl)("PostgreSQL generation work queue", () => {
  let pool: Pool;
  let sequence = 0;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
    await runMigrations(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE canvas_generation_jobs CASCADE");
    sequence = 0;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("leases one runnable job to only one concurrent worker", async () => {
    await insertJob(pool, "job-1", "reserved", NOW);
    const queue = createQueue(pool, () => `lease-token-${++sequence}`);
    const [first, second] = await Promise.all([
      queue.leaseNext("worker:one", iso(NOW), 60_000),
      queue.leaseNext("worker:two", iso(NOW), 60_000),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect([first, second].find(Boolean)).toMatchObject({ jobId: "job-1", attemptCount: 1 });
  });

  it("honors retry schedules and resets consecutive errors after success", async () => {
    await insertJob(pool, "job-1", "queued", NOW);
    const queue = createQueue(pool, () => `lease-token-${++sequence}`);
    const first = (await queue.leaseNext("worker:one", iso(NOW), 60_000))!;
    expect(await queue.release(first.jobId, first.token, {
      nextAttemptAt: iso(NOW + 5_000),
      error: "temporary",
    })).toBe(true);
    expect(await queue.leaseNext("worker:one", iso(NOW + 4_999), 60_000)).toBeNull();
    const retry = (await queue.leaseNext("worker:one", iso(NOW + 5_000), 60_000))!;
    expect(retry.consecutiveErrorCount).toBe(1);
    await queue.release(retry.jobId, retry.token, { nextAttemptAt: iso(NOW + 6_000), error: null });
    const reset = await pool.query<{ consecutive_error_count: number; last_worker_error: string | null }>(
      "SELECT consecutive_error_count, last_worker_error FROM canvas_generation_jobs WHERE id = 'job-1'",
    );
    expect(reset.rows[0]).toEqual({ consecutive_error_count: 0, last_worker_error: null });
  });

  it("recovers expired leases but refuses stale renewal and release tokens", async () => {
    await insertJob(pool, "job-1", "running", NOW);
    const queue = createQueue(pool, () => `lease-token-${++sequence}`);
    const first = (await queue.leaseNext("worker:one", iso(NOW), 1_000))!;
    expect(await queue.leaseNext("worker:two", iso(NOW + 999), 1_000)).toBeNull();
    expect(await queue.renew(first.jobId, "wrong-token", iso(NOW + 500), 1_000)).toBe(false);
    const recovered = await queue.leaseNext("worker:two", iso(NOW + 1_000), 1_000);
    expect(recovered).toMatchObject({ jobId: "job-1", owner: "worker:two", attemptCount: 2 });
    expect(await queue.release(first.jobId, first.token, { nextAttemptAt: null, error: null })).toBe(false);
  });

  it("never leases terminal or ambiguous-submission jobs", async () => {
    await insertJob(pool, "job-complete", "completed", NOW);
    await insertJob(pool, "job-failed", "failed", NOW);
    await insertJob(pool, "job-unknown", "submission_unknown", NOW);
    const queue = createQueue(pool, () => "lease-token-none");
    expect(await queue.leaseNext("worker:one", iso(NOW), 60_000)).toBeNull();
  });
});

function createQueue(pool: Pool, createToken: () => string) {
  return new PostgresGenerationWorkQueue(pool, createToken);
}

async function insertJob(pool: Pool, id: string, status: string, timestamp: number) {
  await pool.query(
    `INSERT INTO canvas_generation_jobs (
      id, owner_id, idempotency_key, project_id, node_id, model_id,
      modality, status, revision, record, created_at, updated_at, next_attempt_at
    ) VALUES ($1, 'user-1', $2, 'project-1', 'node-1', 'model-1',
      'image', $3, 0, '{}'::JSONB, $4, $4, $4)`,
    [id, `request:${id}`, status, iso(timestamp)],
  );
}

function iso(timestamp: number) {
  return new Date(timestamp).toISOString();
}
