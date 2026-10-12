import { randomUUID } from "node:crypto";

import type { GenerationJobStatus } from "@weftcanvas/contracts";
import type { Pool } from "pg";

const RUNNABLE_STATUSES = ["reserved", "submitting", "queued", "running", "validating"] as const;

export type GenerationWorkLease = {
  jobId: string;
  status: GenerationJobStatus;
  token: string;
  owner: string;
  expiresAt: string;
  attemptCount: number;
  consecutiveErrorCount: number;
};

export interface GenerationWorkQueue {
  leaseNext(
    owner: string,
    now: string,
    leaseDurationMs: number,
  ): Promise<GenerationWorkLease | null>;
  renew(jobId: string, token: string, now: string, leaseDurationMs: number): Promise<boolean>;
  release(
    jobId: string,
    token: string,
    options: { nextAttemptAt: string | null; error: string | null },
  ): Promise<boolean>;
}

type LeaseRow = {
  id: string;
  status: GenerationJobStatus;
  lease_token: string;
  lease_owner: string;
  lease_expires_at: Date | string;
  attempt_count: number;
  consecutive_error_count: number;
};

export class PostgresGenerationWorkQueue implements GenerationWorkQueue {
  constructor(
    private readonly pool: Pool,
    private readonly createToken: () => string = randomUUID,
  ) {}

  async leaseNext(owner: string, now: string, leaseDurationMs: number) {
    const workerOwner = validOwner(owner);
    const duration = positiveInteger(leaseDurationMs, "leaseDurationMs");
    const token = validToken(this.createToken());
    const result = await this.pool.query<LeaseRow>(
      `WITH candidate AS (
        SELECT id
        FROM canvas_generation_jobs
        WHERE status = ANY($1::TEXT[])
          AND (next_attempt_at IS NULL OR next_attempt_at <= $2)
          AND (lease_expires_at IS NULL OR lease_expires_at <= $2)
        ORDER BY next_attempt_at NULLS FIRST, updated_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE canvas_generation_jobs AS jobs
      SET lease_owner = $3,
          lease_token = $4,
          lease_expires_at = $2::TIMESTAMPTZ + ($5 * INTERVAL '1 millisecond'),
          attempt_count = attempt_count + 1
      FROM candidate
      WHERE jobs.id = candidate.id
      RETURNING jobs.id, jobs.status, jobs.lease_token, jobs.lease_owner,
        jobs.lease_expires_at, jobs.attempt_count, jobs.consecutive_error_count`,
      [RUNNABLE_STATUSES, now, workerOwner, token, duration],
    );
    const row = result.rows[0];
    return row ? leaseFromRow(row) : null;
  }

  async renew(jobId: string, token: string, now: string, leaseDurationMs: number) {
    const result = await this.pool.query(
      `UPDATE canvas_generation_jobs
       SET lease_expires_at = $3::TIMESTAMPTZ + ($4 * INTERVAL '1 millisecond')
       WHERE id = $1
         AND lease_token = $2
         AND lease_expires_at > $3
       RETURNING id`,
      [jobId, validToken(token), now, positiveInteger(leaseDurationMs, "leaseDurationMs")],
    );
    return result.rowCount === 1;
  }

  async release(
    jobId: string,
    token: string,
    options: { nextAttemptAt: string | null; error: string | null },
  ) {
    const error = options.error ? options.error.slice(0, 1_000) : null;
    const result = await this.pool.query(
      `UPDATE canvas_generation_jobs
       SET lease_owner = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           next_attempt_at = $3,
           consecutive_error_count = CASE WHEN $4::TEXT IS NULL THEN 0 ELSE consecutive_error_count + 1 END,
           last_worker_error = $4
       WHERE id = $1 AND lease_token = $2
       RETURNING id`,
      [jobId, validToken(token), options.nextAttemptAt, error],
    );
    return result.rowCount === 1;
  }
}

function leaseFromRow(row: LeaseRow): GenerationWorkLease {
  return {
    jobId: row.id,
    status: row.status,
    token: row.lease_token,
    owner: row.lease_owner,
    expiresAt: dateIso(row.lease_expires_at),
    attemptCount: row.attempt_count,
    consecutiveErrorCount: row.consecutive_error_count,
  };
}

function validOwner(value: string) {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(normalized)) throw new Error("Worker owner is invalid");
  return normalized;
}

function validToken(value: string) {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(value)) throw new Error("Worker lease token is invalid");
  return value;
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function dateIso(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Worker lease timestamp is invalid");
  return date.toISOString();
}
