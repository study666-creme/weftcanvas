import { describe, expect, it } from "vitest";

import {
  GenerationReconciliationError,
  GenerationReconciliationService,
  type GenerationReconciliationRecord,
  type GenerationReconciliationStore,
} from "./reconciliation.js";
import { GenerationJobServiceError } from "./service.js";
import type { GenerationJobRecord, ProviderExecutionState } from "./types.js";

const NOW = Date.parse("2026-07-15T23:00:00.000Z");
const AUDIT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

describe("generation submission reconciliation", () => {
  it("records and applies an explicit provider state idempotently", async () => {
    const store = new MemoryReconciliationStore();
    let calls = 0;
    const service = new GenerationReconciliationService(
      store,
      {
        reconcileSubmission: async () => {
          calls += 1;
          return job("queued");
        },
        process: async () => job("queued"),
      },
      options(),
    );

    const first = await service.reconcile(request());
    const second = await service.reconcile(request());
    expect(first).toMatchObject({ status: "applied", resultStatus: "queued" });
    expect(second).toEqual(first);
    expect(calls).toBe(1);
    expect(store.records).toHaveLength(1);
  });

  it("rejects idempotency reuse for a different resolution", async () => {
    const store = new MemoryReconciliationStore();
    const service = new GenerationReconciliationService(store, processor("queued"), options());
    await service.reconcile(request());
    await expect(
      service.reconcile({
        ...request(),
        state: { kind: "failed", code: "NOT_FOUND", message: "not found" },
      }),
    ).rejects.toMatchObject({ code: "RECONCILIATION_IDEMPOTENCY_CONFLICT" });
  });

  it("marks a fresh non-reconcilable request rejected", async () => {
    const store = new MemoryReconciliationStore();
    const service = new GenerationReconciliationService(
      store,
      {
        reconcileSubmission: async () => {
          throw new GenerationJobServiceError("JOB_NOT_RECONCILABLE", "当前任务不需要核对");
        },
        process: async () => job("completed"),
      },
      options(),
    );

    await expect(service.reconcile(request())).rejects.toMatchObject({
      code: "JOB_NOT_RECONCILABLE",
    });
    expect(store.records[0]).toMatchObject({
      status: "rejected",
      error: { code: "JOB_NOT_RECONCILABLE" },
    });
  });

  it("recovers a pending audit when the job transition happened before acknowledgement", async () => {
    const store = new MemoryReconciliationStore();
    let first = true;
    const service = new GenerationReconciliationService(
      store,
      {
        reconcileSubmission: async () => {
          if (first) {
            first = false;
            throw new Error("audit database unavailable");
          }
          throw new GenerationJobServiceError("JOB_NOT_RECONCILABLE", "already moved");
        },
        process: async () => job("completed"),
      },
      options(),
    );

    await expect(service.reconcile(request())).rejects.toThrow("audit database unavailable");
    expect(store.records[0]?.status).toBe("pending");
    await expect(service.reconcile(request())).resolves.toMatchObject({
      status: "applied",
      resultStatus: "completed",
    });
  });

  it("re-reads an applied audit when finalization response is lost", async () => {
    const store = new MemoryReconciliationStore();
    store.commitAppliedThenThrow = true;
    const service = new GenerationReconciliationService(store, processor("running"), options());
    await expect(service.reconcile(request())).resolves.toMatchObject({
      status: "applied",
      resultStatus: "running",
    });
  });
});

class MemoryReconciliationStore implements GenerationReconciliationStore {
  records: GenerationReconciliationRecord[] = [];
  commitAppliedThenThrow = false;

  async begin(record: GenerationReconciliationRecord) {
    const existing = this.records.find(
      (item) => item.jobId === record.jobId && item.idempotencyKey === record.idempotencyKey,
    );
    if (existing) return { kind: "existing" as const, record: structuredClone(existing) };
    this.records.push(structuredClone(record));
    return { kind: "created" as const, record: structuredClone(record) };
  }

  async getById(id: string) {
    const record = this.records.find((item) => item.id === id);
    return record ? structuredClone(record) : null;
  }

  async markApplied(id: string, resultStatus: GenerationJobRecord["status"], updatedAt: string) {
    const result = this.finish(id, { status: "applied", resultStatus, error: null, updatedAt });
    if (result && this.commitAppliedThenThrow) throw new Error("database response lost");
    return result;
  }

  async markRejected(id: string, error: { code: string; message: string }, updatedAt: string) {
    return this.finish(id, { status: "rejected", resultStatus: null, error, updatedAt });
  }

  private finish(id: string, change: Partial<GenerationReconciliationRecord>) {
    const index = this.records.findIndex((item) => item.id === id);
    if (index < 0) return null;
    if (this.records[index]!.status !== "pending") return structuredClone(this.records[index]!);
    this.records[index] = { ...this.records[index]!, ...change };
    return structuredClone(this.records[index]!);
  }
}

function request() {
  return {
    jobId: "job-1",
    idempotencyKey: "reconcile:job-1:one",
    actor: "admin:test",
    state: { kind: "queued" as const, taskId: "task-1", progress: 10 },
    evidence: { source: "task-log" },
  };
}

function processor(status: GenerationJobRecord["status"]) {
  return {
    reconcileSubmission: async (_jobId: string, _state: ProviderExecutionState) => job(status),
    process: async () => job(status),
  };
}

function options() {
  return { now: () => NOW, createId: () => AUDIT_ID };
}

function job(status: GenerationJobRecord["status"]) {
  return { status } as GenerationJobRecord;
}
