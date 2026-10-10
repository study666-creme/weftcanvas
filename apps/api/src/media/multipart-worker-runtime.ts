import { randomUUID } from "node:crypto";

import type { MediaMultipartLease, MediaMultipartUploadStore } from "./postgres-multipart-store.js";
import { MediaServiceError, type MediaService } from "./service.js";

type MediaMultipartWorkerOptions = {
  owner?: string;
  now?: () => number;
  leaseDurationMs?: number;
  heartbeatMs?: number;
  idleDelayMs?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  onError?: (error: unknown) => void;
};

export class MediaMultipartWorkerRuntime {
  private readonly owner: string;
  private readonly now: () => number;
  private readonly leaseDurationMs: number;
  private readonly heartbeatMs: number;
  private readonly idleDelayMs: number;
  private readonly sleep: NonNullable<MediaMultipartWorkerOptions["sleep"]>;
  private readonly onError: NonNullable<MediaMultipartWorkerOptions["onError"]>;
  private active = false;

  constructor(
    private readonly queue: MediaMultipartUploadStore,
    private readonly media: Pick<MediaService, "completeDirectUpload" | "failUploadSafely">,
    options: MediaMultipartWorkerOptions = {},
  ) {
    this.owner = options.owner ?? `multipart:${randomUUID()}`;
    this.now = options.now ?? Date.now;
    this.leaseDurationMs = positiveInteger(options.leaseDurationMs ?? 60_000, "leaseDurationMs");
    this.heartbeatMs = positiveInteger(options.heartbeatMs ?? 20_000, "heartbeatMs");
    if (this.heartbeatMs >= this.leaseDurationMs) throw new Error("heartbeatMs must be shorter than leaseDurationMs");
    this.idleDelayMs = positiveInteger(options.idleDelayMs ?? 1_000, "idleDelayMs");
    this.sleep = options.sleep ?? sleep;
    this.onError = options.onError ?? ((error) => console.error("Multipart media worker iteration failed", error));
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
    if (this.active) return false;
    this.active = true;
    try {
      const lease = await this.queue.leaseNext(this.owner, this.timestamp(), this.leaseDurationMs);
      if (!lease) return false;
      await this.processLease(lease);
      return true;
    } finally {
      this.active = false;
    }
  }

  private async processLease(lease: MediaMultipartLease) {
    const heartbeatController = new AbortController();
    let leaseLost = false;
    const heartbeat = this.heartbeat(lease, heartbeatController.signal, () => { leaseLost = true; });
    try {
      await this.media.completeDirectUpload(
        lease.ownerId,
        lease.mediaId,
        lease.projectId ?? undefined,
        { allowExpired: true },
      );
    } catch (error) {
      heartbeatController.abort();
      await heartbeat;
      if (!leaseLost) await this.handleFailure(lease, error);
      this.onError(error);
      return;
    }
    heartbeatController.abort();
    await heartbeat;
    if (leaseLost) return;
    await this.queue.completeLease(lease.mediaId, lease.token, this.timestamp());
  }

  private async handleFailure(lease: MediaMultipartLease, error: unknown) {
    const failure = workerFailure(error);
    if (!failure.terminal) {
      await this.queue.releaseForRetry(
        lease.mediaId,
        lease.token,
        new Date(this.now() + retryBackoffMs(lease.attemptCount)).toISOString(),
        failure.code,
        failure.message,
        this.timestamp(),
      );
      return;
    }

    try {
      await this.media.failUploadSafely(
        lease.ownerId,
        lease.mediaId,
        failure.code,
        failure.message,
        lease.projectId ?? undefined,
      );
    } catch (markError) {
      const retry = workerFailure(markError);
      await this.queue.releaseForRetry(
        lease.mediaId,
        lease.token,
        new Date(this.now() + retryBackoffMs(lease.attemptCount)).toISOString(),
        retry.code,
        retry.message,
        this.timestamp(),
      );
      this.onError(markError);
      return;
    }
    await this.queue.failLease(
      lease.mediaId,
      lease.token,
      this.timestamp(),
      failure.code,
      failure.message,
    );
  }

  private async heartbeat(lease: MediaMultipartLease, signal: AbortSignal, lost: () => void) {
    while (!signal.aborted) {
      await this.sleep(this.heartbeatMs, signal).catch(() => undefined);
      if (signal.aborted) return;
      try {
        if (!await this.queue.renew(lease.mediaId, lease.token, this.timestamp(), this.leaseDurationMs)) {
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

function workerFailure(error: unknown) {
  if (error instanceof MediaServiceError) {
    const temporary = error.status >= 500 || [
      "MEDIA_UPLOAD_IN_PROGRESS",
      "MEDIA_UPLOAD_CONFLICT",
      "MEDIA_FINALIZATION_UNCONFIRMED",
    ].includes(error.code);
    return { code: safeCode(error.code), message: safeMessage(error.message), terminal: !temporary };
  }
  const message = error instanceof Error ? error.message : "Multipart media processing failed";
  return {
    code: "MEDIA_MULTIPART_PROCESSING_UNAVAILABLE",
    message: safeMessage(message),
    terminal: false,
  };
}

function retryBackoffMs(attemptCount: number) {
  return Math.min(5 * 60_000, 1_000 * 2 ** Math.min(8, Math.max(0, attemptCount - 1)));
}

function safeCode(value: string) {
  const normalized = value.replace(/[^A-Z0-9_:-]+/gi, "_").slice(0, 128);
  return normalized || "MEDIA_MULTIPART_ERROR";
}

function safeMessage(value: string) {
  return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 1_000) || "Multipart media processing failed";
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
