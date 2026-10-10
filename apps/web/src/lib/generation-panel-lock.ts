import type { PublicGenerationJob } from "@kachang/contracts";

/**
 * Decides whether a generation node stays protected from a fresh submission.
 *
 * A durable pending identity (browserSubmissionIdentity) means a submission may
 * still be unresolved after a reload. The public job snapshot lacks the
 * clientRequestId/idempotency identity, so an unrelated older job restored onto
 * the node must not imply the pending request is resolved or enable a fresh
 * submit: the node stays locked and the panel exposes the abandon/status
 * surface until the identity is released by an authoritative outcome or an
 * explicit user abandonment. An in-session submit in flight is excluded so the
 * transient busy state keeps its own message.
 */
export type GenerationPanelLockInput = {
  isConfiguration: boolean;
  nodeJobs: readonly PublicGenerationJob[];
  newestNodeJob: PublicGenerationJob | null;
  nodeStatus: string;
  nodeJobStatus: string | null;
  pendingAmbiguousIdentity: boolean;
  browserSubmissionInFlight: boolean;
};

export type GenerationPanelLockState = {
  currentJobUnresolved: PublicGenerationJob | null;
  currentJobActive: PublicGenerationJob | null;
  activeJob: boolean;
  awaitingConfirmation: boolean;
  generationLocked: boolean;
};

export function resolveGenerationPanelLock(input: GenerationPanelLockInput): GenerationPanelLockState {
  const {
    isConfiguration,
    nodeJobs,
    newestNodeJob,
    nodeStatus,
    nodeJobStatus,
    pendingAmbiguousIdentity,
    browserSubmissionInFlight,
  } = input;
  const currentJobUnresolved = nodeJobs.find((job) => job.status === "submission_unknown")
    ?? (newestNodeJob?.status === "submission_unknown" ? newestNodeJob : null);
  const currentJobActive = nodeJobs.find((job) => !isTerminalGenerationJob(job)) ?? null;
  const activeJob = !isConfiguration && (currentJobActive !== null || nodeStatus === "running");
  const awaitingConfirmation = !isConfiguration && (
    currentJobUnresolved !== null
    || (nodeJobs.length === 0 && nodeJobStatus === "submission_unknown")
    || (pendingAmbiguousIdentity && !browserSubmissionInFlight)
  );
  const generationLocked = activeJob || awaitingConfirmation;
  return { currentJobUnresolved, currentJobActive, activeJob, awaitingConfirmation, generationLocked };
}

export function isTerminalGenerationJob(job: PublicGenerationJob) {
  return job.status === "completed" || job.status === "failed" || job.status === "submission_unknown";
}
