import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../database/migrate.js";
import {
  PostgresGenerationReconciliationStore,
  type GenerationReconciliationRecord,
} from "./reconciliation.js";

const databaseUrl = process.env.CANVAS_TEST_DATABASE_URL;
if (databaseUrl && !new URL(databaseUrl).pathname.toLowerCase().includes("test")) {
  throw new Error("CANVAS_TEST_DATABASE_URL must name a dedicated database containing 'test'");
}
const NOW = "2026-07-16T00:00:00.000Z";

describe.skipIf(!databaseUrl)("PostgreSQL generation reconciliation store", () => {
  let pool: Pool;
  let store: PostgresGenerationReconciliationStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
    await runMigrations(pool);
    store = new PostgresGenerationReconciliationStore(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE canvas_generation_reconciliations, canvas_generation_jobs CASCADE");
    await insertUnknownJob(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("creates one audit for concurrent idempotent requests and applies it once", async () => {
    const audit = pendingAudit();
    const [first, second] = await Promise.all([store.begin(audit), store.begin(audit)]);
    expect([first.kind, second.kind].sort()).toEqual(["created", "existing"]);
    expect(await store.markApplied(audit.id, "queued", "2026-07-16T00:00:01.000Z")).toMatchObject({
      status: "applied",
      resultStatus: "queued",
    });
    expect(await store.markApplied(audit.id, "running", "2026-07-16T00:00:02.000Z")).toMatchObject({
      status: "applied",
      resultStatus: "queued",
    });
  });

  it("persists rejected reconciliation with safe error fields", async () => {
    const audit = pendingAudit();
    await store.begin(audit);
    const rejected = await store.markRejected(
      audit.id,
      {
        code: "JOB_NOT_RECONCILABLE",
        message: "当前任务不需要核对",
      },
      "2026-07-16T00:00:01.000Z",
    );
    expect(rejected).toMatchObject({
      status: "rejected",
      resultStatus: null,
      error: { code: "JOB_NOT_RECONCILABLE" },
    });
  });
});

function pendingAudit(): GenerationReconciliationRecord {
  return {
    id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    jobId: "job-unknown",
    idempotencyKey: "reconcile:unknown:one",
    actor: "admin:test",
    requestedState: { kind: "queued", taskId: "task-1", progress: 10 },
    evidence: { source: "integration-test" },
    status: "pending",
    resultStatus: null,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function insertUnknownJob(pool: Pool) {
  await pool.query(
    `INSERT INTO canvas_generation_jobs (
      id, owner_id, idempotency_key, project_id, node_id, model_id,
      modality, status, revision, record, created_at, updated_at, next_attempt_at
    ) VALUES ('job-unknown', 'user-1', 'request:unknown', 'project-1', 'node-1', 'model-1',
      'image', 'submission_unknown', 0, '{}'::JSONB, $1, $1, NULL)`,
    [NOW],
  );
}
