import { randomUUID } from "node:crypto";

import type { GenerationJobStatus } from "@kachang/contracts";

import type { GenerationJobProcessor } from "./service.js";
import type { GenerationJobRecord } from "./types.js";
import type { GenerationWorkLease, GenerationWorkQueue } from "./work-queue.js";

const TERMINAL_STATUSES = new Set<GenerationJobStatus>(["completed", "failed", "submission_unknown"]);

type WorkerRuntimeOptions = {
  owner?: string;
  now?: () => number;
  leaseDurationMs?: number;
  heartbeatMs?: number;
  idleDelayMs?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  onError?: (error: unknown) => void;
};

export class GenerationWorkerRuntime {
  private readonly owner: string;
  private readonly now: () => number;
  private readonly leaseDurationMs: number;
  private readonly heartbeatMs: number;
  private readonly idleDelayMs: number;
  private readonly sleep: NonNullable<WorkerRuntimeOptions["sleep"]>;
  private readonly onError: NonNullable<WorkerRuntimeOptions["onError"]>;

  constructor(
    private readonly queue: GenerationWorkQueue,
    private readonly processor: Pick<GenerationJobProcessor, "process">,
    options: WorkerRuntimeOptions = {},
  ) {
    this.owner = options.owner ?? `worker:${randomUUID()}`;
    this.now = options.now ?? Date.now;
    this.leaseDurationMs = positiveInteger(options.leaseDurationMs ?? 60_000, "leaseDurationMs");
    this.heartbeatMs = positiveInteger(options.heartbeatMs ?? 20_000, "heartbeatMs");
    if (this.heartbeatMs >= this.leaseDurationMs) throw new Error("heartbeatMs must be shorter than leaseDurationMs");
    this.idleDelayMs = positiveInteger(options.idleDelayMs ?? 1_000, "idleDelayMs");
    this.sleep = options.sleep ?? sleep;
    this.onError = options.onError ?? ((error) => console.error("Generation worker iteration failed", error));
  }

  async run(signal: AbortSignal) {
    while (!signal.aborted) {
      let worked = false;
      try {
        worked = await this.runOnce();
      } catch (error) {
        this.onError(error);
      }
      if (!worked && !signal.aborted) await this.sleep(this.idleDelayMs, signal).catch(() => undefined);
    }
  }

  async runOnce() {
    const lease = await this.queue.leaseNext(this.owner, this.timestamp(), this.leaseDurationMs);
    if (!lease) return false;
    await this.processLease(lease);
    return true;
  }

  private async processLease(lease: GenerationWorkLease) {
    const heartbeatController = new AbortController();
    let leaseLost = false;
    const heartbeat = this.heartbeat(lease, heartbeatController.signal, () => { leaseLost = true; });
    let result: GenerationJobRecord;
    try {
      result = await this.processor.process(lease.jobId);
    } catch (error) {
      heartbeatController.abort();
      await heartbeat;
      if (!leaseLost) {
        const failures = lease.consecutiveErrorCount + 1;
        await this.queue.release(lease.jobId, lease.token, {
          nextAttemptAt: new Date(this.now() + failureBackoffMs(failures)).toISOString(),
          error: safeError(error),
        });
      }
      this.onError(error);
      return;
    }
    heartbeatController.abort();
    await heartbeat;
    if (leaseLost) return;

    if (TERMINAL_STATUSES.has(result.status)) {
      await this.queue.release(lease.jobId, lease.token, { nextAttemptAt: null, error: null });
      return;
    }
    await this.queue.release(lease.jobId, lease.token, {
      nextAttemptAt: new Date(this.now() + nextDelayMs(result.status)).toISOString(),
      error: null,
    });
  }

  private async heartbeat(lease: GenerationWorkLease, signal: AbortSignal, lost: () => void) {
    while (!signal.aborted) {
      await this.sleep(this.heartbeatMs, signal).catch(() => undefined);
      if (signal.aborted) return;
      try {
        if (!await this.queue.renew(lease.jobId, lease.token, this.timestamp(), this.leaseDurationMs)) {
          lost();
          return;
        }
      } catch (error) {
        this.onError(error);
        lost();
        return;
      }
    }
  }

  private timestamp() {
    return new Date(this.now()).toISOString();
  }
}

function nextDelayMs(status: GenerationJobStatus) {
  if (status === "validating") return 250;
  if (status === "reserved" || status === "submitting") return 1_000;
  if (status === "queued" || status === "running") return 2_000;
  return 5_000;
}

function failureBackoffMs(consecutiveErrors: number) {
  return Math.min(60_000, 1_000 * 2 ** Math.min(6, Math.max(0, consecutiveErrors - 1)));
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown worker error";
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 1_000);
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function sleep(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
