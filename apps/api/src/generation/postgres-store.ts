import { isDeepStrictEqual } from "node:util";

import type { Pool, PoolClient } from "pg";

import { isGenerationTransitionAllowed } from "./job-state.js";
import {
  generationJobRecordSchema,
  type CreateReservedJobResult,
  type GenerationJobRecord,
  type GenerationJobStore,
} from "./types.js";

type JobRow = { record: unknown; revision: number };
type WalletRow = { available_credit_micros: string; reserved_credit_micros: string };
type ReservationRow = { amount_credit_micros: string; status: "active" | "captured" | "released" };
const ACTIVE_JOB_STATUSES = ["reserved", "submitting", "queued", "running", "validating", "submission_unknown"] as const;

export class PostgresGenerationJobStore implements GenerationJobStore {
  constructor(private readonly pool: Pool) {}

  async findByIdempotency(ownerId: string, idempotencyKey: string) {
    const result = await this.pool.query<JobRow>(
      "SELECT record, revision FROM canvas_generation_jobs WHERE owner_id = $1 AND idempotency_key = $2",
      [ownerId, idempotencyKey],
    );
    return result.rows[0] ? parseJob(result.rows[0]) : null;
  }

  async getById(jobId: string) {
    const result = await this.pool.query<JobRow>(
      "SELECT record, revision FROM canvas_generation_jobs WHERE id = $1",
      [jobId],
    );
    return result.rows[0] ? parseJob(result.rows[0]) : null;
  }

  async listByOwner(ownerId: string, options: { projectId?: string; limit: number }) {
    const limit = positiveInteger(options.limit, "limit");
    const result = options.projectId
      ? await this.pool.query<JobRow>(
        `SELECT record, revision FROM canvas_generation_jobs
         WHERE owner_id = $1 AND project_id = $2
         ORDER BY updated_at DESC, id DESC LIMIT $3`,
        [ownerId, options.projectId, limit],
      )
      : await this.pool.query<JobRow>(
        `SELECT record, revision FROM canvas_generation_jobs
         WHERE owner_id = $1
         ORDER BY updated_at DESC, id DESC LIMIT $2`,
        [ownerId, limit],
      );
    return result.rows.map(parseJob);
  }

  async createWithReservation(
    value: GenerationJobRecord,
    creditMicros: number,
    options: { maxActiveJobs: number },
  ): Promise<CreateReservedJobResult> {
    const job = generationJobRecordSchema.parse(value);
    assertNewReservation(job, creditMicros);
    const maxActiveJobs = positiveInteger(options.maxActiveJobs, "maxActiveJobs");
    return withTransaction(this.pool, async (client) => {
      const first = await findByIdempotency(client, job.ownerId, job.idempotencyKey);
      if (first) return { kind: "existing", job: first };

      const wallet = await client.query<WalletRow>(
        "SELECT available_credit_micros, reserved_credit_micros FROM canvas_wallets WHERE owner_id = $1 FOR UPDATE",
        [job.ownerId],
      );
      if (!wallet.rows[0]) return { kind: "insufficient_credits" };

      const existing = await findByIdempotency(client, job.ownerId, job.idempotencyKey);
      if (existing) return { kind: "existing", job: existing };
      const active = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM canvas_generation_jobs
         WHERE owner_id = $1 AND status = ANY($2::TEXT[])`,
        [job.ownerId, ACTIVE_JOB_STATUSES],
      );
      if (databaseInteger(active.rows[0]?.count ?? "0") >= maxActiveJobs) return { kind: "active_limit" };
      if (databaseInteger(wallet.rows[0].available_credit_micros) < creditMicros) {
        return { kind: "insufficient_credits" };
      }

      await client.query(
        `INSERT INTO canvas_generation_jobs (
          id, owner_id, idempotency_key, project_id, node_id, model_id,
          modality, status, revision, record, created_at, updated_at,
          next_attempt_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::JSONB, $11, $12, $12)`,
        [
          job.id, job.ownerId, job.idempotencyKey, job.projectId, job.nodeId, job.modelId,
          job.modality, job.status, job.revision, serialize(job), job.createdAt, job.updatedAt,
        ],
      );
      const updated = await client.query(
        `UPDATE canvas_wallets
         SET available_credit_micros = available_credit_micros - $2,
             reserved_credit_micros = reserved_credit_micros + $2,
             updated_at = NOW()
         WHERE owner_id = $1 AND available_credit_micros >= $2`,
        [job.ownerId, creditMicros],
      );
      if (updated.rowCount !== 1) throw new Error("Wallet reservation update failed");
      await client.query(
        `INSERT INTO canvas_wallet_reservations (
          id, owner_id, generation_job_id, amount_credit_micros, status
        ) VALUES ($1, $2, $3, $4, 'active')`,
        [job.reservationId, job.ownerId, job.id, creditMicros],
      );
      await client.query(
        `INSERT INTO canvas_wallet_ledger (
          id, owner_id, generation_job_id, reservation_id, entry_type,
          available_delta_micros, reserved_delta_micros, metadata
        ) VALUES ($1, $2, $3, $4, 'reserve', $5, $6, $7::JSONB)`,
        [
          `ledger:reserve:${job.id}`,
          job.ownerId,
          job.id,
          job.reservationId,
          -creditMicros,
          creditMicros,
          JSON.stringify({ quoteId: job.quote.id, pricingVersion: job.quote.pricingVersion }),
        ],
      );
      return { kind: "created", job };
    });
  }

  async save(value: GenerationJobRecord, expectedRevision: number) {
    const job = generationJobRecordSchema.parse(value);
    assertRevision(job, expectedRevision);
    if (job.status === "completed" || job.status === "failed") {
      throw new Error("Terminal jobs must use an atomic wallet settlement operation");
    }
    const currentResult = await this.pool.query<JobRow>(
      "SELECT record, revision FROM canvas_generation_jobs WHERE id = $1 AND owner_id = $2",
      [job.id, job.ownerId],
    );
    if (!currentResult.rows[0] || currentResult.rows[0].revision !== expectedRevision) return null;
    const current = parseJob(currentResult.rows[0]);
    assertJobIdentity(current, job);
    if (!isGenerationTransitionAllowed(current.status, job.status)) {
      throw new Error(`Invalid persisted generation job transition: ${current.status} -> ${job.status}`);
    }
    const result = await this.pool.query<JobRow>(
      `UPDATE canvas_generation_jobs
       SET status = $2, revision = $3, record = $4::JSONB, updated_at = $5
       WHERE id = $1 AND owner_id = $6 AND revision = $7
       RETURNING record, revision`,
      [job.id, job.status, job.revision, serialize(job), job.updatedAt, job.ownerId, expectedRevision],
    );
    return result.rows[0] ? parseJob(result.rows[0]) : null;
  }

  async completeWithCapture(value: GenerationJobRecord, expectedRevision: number, creditMicros: number) {
    const job = generationJobRecordSchema.parse(value);
    if (job.status !== "completed") throw new Error("Only completed jobs can capture a reservation");
    validAmount(creditMicros);
    return this.settle(job, expectedRevision, "capture", creditMicros);
  }

  async failWithRelease(value: GenerationJobRecord, expectedRevision: number) {
    const job = generationJobRecordSchema.parse(value);
    if (job.status !== "failed") throw new Error("Only failed jobs can release a reservation");
    return this.settle(job, expectedRevision, "release", 0);
  }

  private async settle(
    job: GenerationJobRecord,
    expectedRevision: number,
    kind: "capture" | "release",
    captureCreditMicros: number,
  ) {
    assertRevision(job, expectedRevision);
    return withTransaction(this.pool, async (client) => {
      const current = await client.query<JobRow>(
        "SELECT record, revision FROM canvas_generation_jobs WHERE id = $1 AND owner_id = $2 FOR UPDATE",
        [job.id, job.ownerId],
      );
      if (!current.rows[0] || current.rows[0].revision !== expectedRevision) return null;
      const currentJob = parseJob(current.rows[0]);
      assertJobIdentity(currentJob, job);
      if (!isGenerationTransitionAllowed(currentJob.status, job.status)) {
        throw new Error(`Invalid persisted generation job transition: ${currentJob.status} -> ${job.status}`);
      }

      const reservation = await client.query<ReservationRow>(
        `SELECT amount_credit_micros, status
         FROM canvas_wallet_reservations
         WHERE id = $1 AND owner_id = $2 AND generation_job_id = $3
         FOR UPDATE`,
        [job.reservationId, job.ownerId, job.id],
      );
      const hold = reservation.rows[0];
      if (!hold || hold.status !== "active") return null;
      const heldCreditMicros = databaseInteger(hold.amount_credit_micros);
      if (captureCreditMicros > heldCreditMicros) throw new Error("Capture exceeds the active reservation");
      if (heldCreditMicros !== job.quote.creditMicros) throw new Error("Reservation does not match the immutable job quote");

      const wallet = await client.query<WalletRow>(
        "SELECT available_credit_micros, reserved_credit_micros FROM canvas_wallets WHERE owner_id = $1 FOR UPDATE",
        [job.ownerId],
      );
      if (!wallet.rows[0] || databaseInteger(wallet.rows[0].reserved_credit_micros) < heldCreditMicros) {
        throw new Error("Wallet reservation balance is inconsistent");
      }

      const refundCreditMicros = kind === "capture" ? heldCreditMicros - captureCreditMicros : heldCreditMicros;
      const updatedWallet = await client.query(
        `UPDATE canvas_wallets
         SET available_credit_micros = available_credit_micros + $2,
             reserved_credit_micros = reserved_credit_micros - $3,
             updated_at = NOW()
         WHERE owner_id = $1 AND reserved_credit_micros >= $3`,
        [job.ownerId, refundCreditMicros, heldCreditMicros],
      );
      if (updatedWallet.rowCount !== 1) throw new Error("Wallet settlement update failed");
      await client.query(
        `UPDATE canvas_wallet_reservations
         SET status = $2, captured_credit_micros = $3, settled_at = NOW()
         WHERE id = $1 AND status = 'active'`,
        [job.reservationId, kind === "capture" ? "captured" : "released", captureCreditMicros],
      );
      await client.query(
        `INSERT INTO canvas_wallet_ledger (
          id, owner_id, generation_job_id, reservation_id, entry_type,
          available_delta_micros, reserved_delta_micros, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::JSONB)`,
        [
          `ledger:${kind}:${job.id}`,
          job.ownerId,
          job.id,
          job.reservationId,
          kind,
          refundCreditMicros,
          -heldCreditMicros,
          JSON.stringify(kind === "capture"
            ? { capturedCreditMicros: captureCreditMicros, quoteId: job.quote.id }
            : { errorCode: job.error?.code ?? "UNKNOWN" }),
        ],
      );
      const saved = await updateJob(client, job, expectedRevision);
      if (!saved) throw new Error("Generation job settlement revision changed");
      return saved;
    });
  }
}

async function findByIdempotency(client: PoolClient, ownerId: string, idempotencyKey: string) {
  const result = await client.query<JobRow>(
    "SELECT record, revision FROM canvas_generation_jobs WHERE owner_id = $1 AND idempotency_key = $2",
    [ownerId, idempotencyKey],
  );
  return result.rows[0] ? parseJob(result.rows[0]) : null;
}

async function updateJob(client: PoolClient, job: GenerationJobRecord, expectedRevision: number) {
  const result = await client.query<JobRow>(
    `UPDATE canvas_generation_jobs
     SET status = $2, revision = $3, record = $4::JSONB, updated_at = $5
     WHERE id = $1 AND owner_id = $6 AND revision = $7
     RETURNING record, revision`,
    [job.id, job.status, job.revision, serialize(job), job.updatedAt, job.ownerId, expectedRevision],
  );
  return result.rows[0] ? parseJob(result.rows[0]) : null;
}

async function withTransaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  let started = false;
  try {
    await client.query("BEGIN");
    started = true;
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (started) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function parseJob(row: JobRow) {
  const job = generationJobRecordSchema.parse(row.record);
  if (job.revision !== row.revision) throw new Error("Generation job revision does not match its stored record");
  return job;
}

function serialize(job: GenerationJobRecord) {
  return JSON.stringify(job);
}

function assertNewReservation(job: GenerationJobRecord, creditMicros: number) {
  if (job.status !== "reserved" || job.revision !== 0) throw new Error("A new reserved job must start at revision zero");
  validAmount(creditMicros);
  if (creditMicros !== job.quote.creditMicros) throw new Error("Reservation amount must match the server quote");
}

function assertRevision(job: GenerationJobRecord, expectedRevision: number) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || job.revision !== expectedRevision + 1) {
    throw new Error("Generation job revision must increment exactly once");
  }
}

function assertJobIdentity(current: GenerationJobRecord, next: GenerationJobRecord) {
  const stable = current.id === next.id
    && current.ownerId === next.ownerId
    && current.idempotencyKey === next.idempotencyKey
    && current.projectId === next.projectId
    && current.nodeId === next.nodeId
    && current.modelId === next.modelId
    && current.modelLabel === next.modelLabel
    && current.modality === next.modality
    && current.quantity === next.quantity
    && current.inputTokens === next.inputTokens
    && current.maxOutputTokens === next.maxOutputTokens
    && current.reservationId === next.reservationId
    && current.createdAt === next.createdAt
    && isDeepStrictEqual(current.parameters, next.parameters)
    && isDeepStrictEqual(current.inputs, next.inputs)
    && isDeepStrictEqual(current.quote, next.quote)
    && isDeepStrictEqual(current.pricing, next.pricing)
    && isDeepStrictEqual(current.executionRoute, next.executionRoute);
  if (!stable) throw new Error("Immutable generation job fields cannot change after reservation");
}

function validAmount(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Credit amount must be a non-negative safe integer");
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function databaseInteger(value: string | number | bigint) {
  const parsed = typeof value === "bigint" ? value : BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER) || parsed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error("Database credit amount exceeds JavaScript safe integer precision");
  }
  return Number(parsed);
}
