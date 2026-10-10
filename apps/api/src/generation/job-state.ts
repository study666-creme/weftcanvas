import type { GenerationArtifact, GenerationJobError } from "@kachang/contracts";

import type { GenerationJobRecord } from "./types.js";

export type GenerationJobEvent =
  | { type: "submission_started" }
  | { type: "provider_queued"; taskId: string; progress?: number }
  | { type: "provider_running"; taskId: string; progress?: number }
  | { type: "provider_output"; resultRef: string; taskId?: string }
  | { type: "validation_completed"; artifacts: GenerationArtifact[] }
  | { type: "submission_unknown" }
  | { type: "failed"; error: GenerationJobError };

const allowedTransitions: Record<GenerationJobRecord["status"], ReadonlySet<GenerationJobRecord["status"]>> = {
  reserved: new Set(["submitting", "failed"]),
  submitting: new Set(["queued", "running", "validating", "submission_unknown", "failed"]),
  queued: new Set(["queued", "running", "validating", "failed"]),
  running: new Set(["running", "validating", "failed"]),
  validating: new Set(["completed", "failed"]),
  submission_unknown: new Set(["queued", "running", "validating", "failed"]),
  completed: new Set(),
  failed: new Set(),
};

export class InvalidGenerationTransitionError extends Error {
  constructor(from: GenerationJobRecord["status"], to: GenerationJobRecord["status"]) {
    super(`Invalid generation job transition: ${from} -> ${to}`);
    this.name = "InvalidGenerationTransitionError";
  }
}

export function isGenerationTransitionAllowed(
  from: GenerationJobRecord["status"],
  to: GenerationJobRecord["status"],
) {
  return allowedTransitions[from].has(to);
}

export function transitionGenerationJob(job: GenerationJobRecord, event: GenerationJobEvent, now: number) {
  const timestamp = new Date(now).toISOString();
  const base = { ...job, revision: job.revision + 1, updatedAt: timestamp };

  if (event.type === "submission_started") {
    return transition(job, { ...base, status: "submitting", progress: Math.max(job.progress, 5), startedAt: job.startedAt ?? timestamp });
  }
  if (event.type === "provider_queued") {
    return transition(job, {
      ...base,
      status: "queued",
      progress: boundedProgress(event.progress, Math.max(job.progress, 10), 90),
      providerTaskId: event.taskId,
      error: null,
    });
  }
  if (event.type === "provider_running") {
    return transition(job, {
      ...base,
      status: "running",
      progress: boundedProgress(event.progress, Math.max(job.progress, 15), 90),
      providerTaskId: event.taskId,
      error: null,
    });
  }
  if (event.type === "provider_output") {
    return transition(job, {
      ...base,
      status: "validating",
      progress: Math.max(job.progress, 95),
      providerTaskId: event.taskId ?? job.providerTaskId,
      providerResultRef: event.resultRef,
      error: null,
    });
  }
  if (event.type === "validation_completed") {
    return transition(job, {
      ...base,
      status: "completed",
      progress: 100,
      artifacts: event.artifacts,
      error: null,
      completedAt: timestamp,
    });
  }
  if (event.type === "submission_unknown") {
    return transition(job, {
      ...base,
      status: "submission_unknown",
      error: {
        code: "SUBMISSION_STATUS_UNKNOWN",
        message: "任务提交结果待确认，请勿重复提交",
        retryable: false,
      },
    });
  }
  return transition(job, {
    ...base,
    status: "failed",
    error: event.error,
    completedAt: timestamp,
  });
}

function transition(job: GenerationJobRecord, next: GenerationJobRecord) {
  if (!isGenerationTransitionAllowed(job.status, next.status)) {
    throw new InvalidGenerationTransitionError(job.status, next.status);
  }
  return next;
}

function boundedProgress(value: number | undefined, fallback: number, max: number) {
  if (value === undefined || !Number.isFinite(value)) return Math.min(max, fallback);
  return Math.min(max, Math.max(fallback, Math.round(value)));
}
