import { randomUUID } from "node:crypto";

import { generationJobStatusSchema } from "@weftcanvas/contracts";
import type { Pool } from "pg";
import { z } from "zod";

import { GenerationJobProcessor, GenerationJobServiceError } from "./service.js";
import type { GenerationJobRecord, ProviderExecutionState } from "./types.js";

const providerStateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("queued"),
      taskId: z.string().min(1),
      progress: z.number().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("running"),
      taskId: z.string().min(1),
      progress: z.number().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("output"),
      resultRef: z.string().min(1),
      taskId: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("failed"),
      code: z.string().min(1),
      message: z.string().min(1),
      retryable: z.boolean().optional(),
    })
    .strict(),
]);

const reconciliationRequestSchema = z
  .object({
    jobId: z.string().min(1).max(128),
    idempotencyKey: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    actor: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._:@-]+$/),
    state: providerStateSchema,
    evidence: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

const reconciliationRecordSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  actor: z.string().min(1),
  requestedState: providerStateSchema,
  evidence: z.record(z.string(), z.unknown()),
  status: z.enum(["pending", "applied", "rejected"]),
  resultStatus: generationJobStatusSchema.nullable(),
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type GenerationReconciliationRecord = z.infer<typeof reconciliationRecordSchema>;

type BeginResult = { kind: "created" | "existing"; record: GenerationReconciliationRecord };

export interface GenerationReconciliationStore {
  begin(record: GenerationReconciliationRecord): Promise<BeginResult>;
  getById(id: string): Promise<GenerationReconciliationRecord | null>;
  markApplied(
    id: string,
    resultStatus: GenerationJobRecord["status"],
    updatedAt: string,
  ): Promise<GenerationReconciliationRecord | null>;
  markRejected(
    id: string,
    error: { code: string; message: string },
    updatedAt: string,
  ): Promise<GenerationReconciliationRecord | null>;
}

export class GenerationReconciliationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GenerationReconciliationError";
  }
}

export class GenerationReconciliationService {
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(
    private readonly store: GenerationReconciliationStore,
    private readonly processor: Pick<GenerationJobProcessor, "process" | "reconcileSubmission">,
    options: { now?: () => number; createId?: () => string } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  async reconcile(value: unknown) {
    const input = reconciliationRequestSchema.parse(value);
    if (Buffer.byteLength(JSON.stringify(input.evidence)) > 32 * 1024) {
      throw new GenerationReconciliationError("EVIDENCE_TOO_LARGE", "对账证据内容过大");
    }
    const timestamp = this.timestamp();
    const begun = await this.store.begin(
      reconciliationRecordSchema.parse({
        id: this.createId(),
        jobId: input.jobId,
        idempotencyKey: input.idempotencyKey,
        actor: input.actor,
        requestedState: input.state,
        evidence: input.evidence,
        status: "pending",
        resultStatus: null,
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    assertSameRequest(begun.record, input);
    if (begun.record.status === "applied") return begun.record;
    if (begun.record.status === "rejected") {
      throw new GenerationReconciliationError(
        begun.record.error!.code,
        begun.record.error!.message,
      );
    }

    let job: GenerationJobRecord;
    try {
      job = await this.processor.reconcileSubmission(
        input.jobId,
        input.state as ProviderExecutionState,
      );
    } catch (error) {
      if (
        begun.kind === "existing" &&
        error instanceof GenerationJobServiceError &&
        error.code === "JOB_NOT_RECONCILABLE"
      ) {
        job = await this.processor.process(input.jobId);
      } else if (
        error instanceof GenerationJobServiceError &&
        error.code === "JOB_NOT_RECONCILABLE"
      ) {
        const rejected = await this.store.markRejected(
          begun.record.id,
          { code: error.code, message: error.message },
          this.timestamp(),
        );
        throw new GenerationReconciliationError(
          rejected?.error?.code ?? error.code,
          rejected?.error?.message ?? error.message,
        );
      } else {
        throw error;
      }
    }

    let applied: GenerationReconciliationRecord | null;
    try {
      applied = await this.store.markApplied(begun.record.id, job.status, this.timestamp());
    } catch {
      applied = await this.store.getById(begun.record.id).catch(() => null);
      if (applied?.status !== "applied") {
        throw new GenerationReconciliationError(
          "RECONCILIATION_FINALIZATION_UNCONFIRMED",
          "任务状态已核对，正在确认审计记录",
        );
      }
    }
    if (!applied)
      throw new GenerationReconciliationError(
        "RECONCILIATION_CONFLICT",
        "对账记录已被其他进程更新",
      );
    return applied;
  }

  private timestamp() {
    return new Date(this.now()).toISOString();
  }
}

type ReconciliationRow = { record: unknown };

export class PostgresGenerationReconciliationStore implements GenerationReconciliationStore {
  constructor(private readonly pool: Pool) {}

  async begin(value: GenerationReconciliationRecord): Promise<BeginResult> {
    const record = reconciliationRecordSchema.parse(value);
    const result = await this.pool.query<ReconciliationRow>(
      `INSERT INTO canvas_generation_reconciliations (
        id, generation_job_id, idempotency_key, actor, requested_state,
        evidence, status, result_status, error_code, error_message,
        record, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5::JSONB, $6::JSONB, 'pending', NULL, NULL, NULL, $7::JSONB, $8, $8)
      ON CONFLICT (generation_job_id, idempotency_key) DO NOTHING
      RETURNING record`,
      [
        record.id,
        record.jobId,
        record.idempotencyKey,
        record.actor,
        JSON.stringify(record.requestedState),
        JSON.stringify(record.evidence),
        JSON.stringify(record),
        record.createdAt,
      ],
    );
    if (result.rows[0]) return { kind: "created", record: parseRecord(result.rows[0]) };
    const existing = await this.pool.query<ReconciliationRow>(
      "SELECT record FROM canvas_generation_reconciliations WHERE generation_job_id = $1 AND idempotency_key = $2",
      [record.jobId, record.idempotencyKey],
    );
    if (!existing.rows[0]) throw new Error("Reconciliation conflict did not resolve to a record");
    return { kind: "existing", record: parseRecord(existing.rows[0]) };
  }

  async getById(id: string) {
    const result = await this.pool.query<ReconciliationRow>(
      "SELECT record FROM canvas_generation_reconciliations WHERE id = $1",
      [id],
    );
    return result.rows[0] ? parseRecord(result.rows[0]) : null;
  }

  async markApplied(id: string, resultStatus: GenerationJobRecord["status"], updatedAt: string) {
    return this.finish(id, "applied", resultStatus, null, updatedAt);
  }

  async markRejected(id: string, error: { code: string; message: string }, updatedAt: string) {
    return this.finish(id, "rejected", null, error, updatedAt);
  }

  private async finish(
    id: string,
    status: "applied" | "rejected",
    resultStatus: GenerationJobRecord["status"] | null,
    error: { code: string; message: string } | null,
    updatedAt: string,
  ) {
    const current = await this.getById(id);
    if (!current) return null;
    if (current.status !== "pending") return current;
    const next = reconciliationRecordSchema.parse({
      ...current,
      status,
      resultStatus,
      error,
      updatedAt,
    });
    const result = await this.pool.query<ReconciliationRow>(
      `UPDATE canvas_generation_reconciliations SET
        status = $2,
        result_status = $3,
        error_code = $4,
        error_message = $5,
        record = $6::JSONB,
        updated_at = $7
       WHERE id = $1 AND status = 'pending'
       RETURNING record`,
      [
        id,
        status,
        resultStatus,
        error?.code ?? null,
        error?.message ?? null,
        JSON.stringify(next),
        updatedAt,
      ],
    );
    if (result.rows[0]) return parseRecord(result.rows[0]);
    return this.getById(id);
  }
}

function parseRecord(row: ReconciliationRow) {
  return reconciliationRecordSchema.parse(row.record);
}

function assertSameRequest(
  record: GenerationReconciliationRecord,
  input: z.infer<typeof reconciliationRequestSchema>,
) {
  const same =
    record.jobId === input.jobId &&
    record.idempotencyKey === input.idempotencyKey &&
    record.actor === input.actor &&
    JSON.stringify(record.requestedState) === JSON.stringify(input.state) &&
    JSON.stringify(record.evidence) === JSON.stringify(input.evidence);
  if (!same)
    throw new GenerationReconciliationError(
      "RECONCILIATION_IDEMPOTENCY_CONFLICT",
      "对账请求标识已经用于其他核对结果",
    );
}
