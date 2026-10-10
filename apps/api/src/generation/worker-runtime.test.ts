import { describe, expect, it } from "vitest";

import type { GenerationJobRecord } from "./types.js";
import type { GenerationWorkLease, GenerationWorkQueue } from "./work-queue.js";
import { GenerationWorkerRuntime } from "./worker-runtime.js";

const NOW = Date.parse("2026-07-15T20:00:00.000Z");

describe("generation worker runtime", () => {
  it("returns idle when no runnable task is available", async () => {
    const queue = new MemoryQueue(null);
    const runtime = createRuntime(queue, async () => job("completed"));
    await expect(runtime.runOnce()).resolves.toBe(false);
    expect(queue.releases).toHaveLength(0);
  });

  it("acknowledges terminal work and schedules active polling without an error", async () => {
    const terminalQueue = new MemoryQueue(lease());
    await createRuntime(terminalQueue, async () => job("completed")).runOnce();
    expect(terminalQueue.releases[0]).toMatchObject({ nextAttemptAt: null, error: null });

    const runningQueue = new MemoryQueue(lease());
    await createRuntime(runningQueue, async () => job("running")).runOnce();
    expect(runningQueue.releases[0]).toEqual({
      nextAttemptAt: new Date(NOW + 2_000).toISOString(),
      error: null,
    });
  });

  it("backs off temporary failures without changing job state", async () => {
    const queue = new MemoryQueue({ ...lease(), consecutiveErrorCount: 2 });
    const errors: unknown[] = [];
    await createRuntime(queue, async () => { throw new Error("storage\nunavailable"); }, errors).runOnce();

    expect(queue.releases[0]).toEqual({
      nextAttemptAt: new Date(NOW + 4_000).toISOString(),
      error: "storage unavailable",
    });
    expect(errors).toHaveLength(1);
  });

  it("renews a lease during long processing and does not release a lost lease", async () => {
    const renewed = new MemoryQueue(lease());
    await createRuntime(renewed, async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return job("queued");
    }, [], { heartbeatMs: 5, leaseDurationMs: 30 }).runOnce();
    expect(renewed.renewals).toBeGreaterThan(0);
    expect(renewed.releases).toHaveLength(1);

    const lost = new MemoryQueue(lease());
    lost.renewResult = false;
    await createRuntime(lost, async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return job("queued");
    }, [], { heartbeatMs: 5, leaseDurationMs: 30 }).runOnce();
    expect(lost.renewals).toBe(1);
    expect(lost.releases).toHaveLength(0);
  });
});

class MemoryQueue implements GenerationWorkQueue {
  releases: Array<{ nextAttemptAt: string | null; error: string | null }> = [];
  renewals = 0;
  renewResult = true;

  constructor(private next: GenerationWorkLease | null) {}

  async leaseNext() {
    const value = this.next;
    this.next = null;
    return value;
  }

  async renew() {
    this.renewals += 1;
    return this.renewResult;
  }

  async release(_jobId: string, _token: string, options: { nextAttemptAt: string | null; error: string | null }) {
    this.releases.push(options);
    return true;
  }
}

function createRuntime(
  queue: GenerationWorkQueue,
  process: (jobId: string) => Promise<GenerationJobRecord>,
  errors: unknown[] = [],
  timing: { heartbeatMs?: number; leaseDurationMs?: number } = {},
) {
  return new GenerationWorkerRuntime(queue, { process }, {
    owner: "worker:test",
    now: () => NOW,
    heartbeatMs: timing.heartbeatMs ?? 20,
    leaseDurationMs: timing.leaseDurationMs ?? 60,
    idleDelayMs: 10,
    onError: (error) => { errors.push(error); },
  });
}

function lease(): GenerationWorkLease {
  return {
    jobId: "job-1",
    status: "reserved",
    token: "lease-token-1",
    owner: "worker:test",
    expiresAt: new Date(NOW + 60).toISOString(),
    attemptCount: 1,
    consecutiveErrorCount: 0,
  };
}

function job(status: GenerationJobRecord["status"]) {
  return { status } as GenerationJobRecord;
}
