import type { PublicGenerationJob } from "@weftcanvas/contracts";
import { describe, expect, it } from "vitest";

import { resolveGenerationPanelLock } from "./generation-panel-lock";

describe("generation panel lock", () => {
  it("keeps an idle node without an identity or job unlocked", () => {
    const lock = resolveGenerationPanelLock(input({ nodeStatus: "idle" }));

    expect(lock).toMatchObject({
      activeJob: false,
      awaitingConfirmation: false,
      generationLocked: false,
    });
  });

  it("locks a node while an active job is running", () => {
    const active = generationJob("job-active", "queued");
    const lock = resolveGenerationPanelLock(
      input({
        nodeStatus: "running",
        nodeJobs: [active],
        newestNodeJob: active,
      }),
    );

    expect(lock).toMatchObject({
      activeJob: true,
      awaitingConfirmation: false,
      generationLocked: true,
    });
  });

  it("locks a node stuck on submission_unknown with no known job", () => {
    const lock = resolveGenerationPanelLock(
      input({
        nodeStatus: "running",
        nodeJobStatus: "submission_unknown",
      }),
    );

    expect(lock).toMatchObject({
      activeJob: true,
      awaitingConfirmation: true,
      generationLocked: true,
    });
  });

  it("locks a node whose restored result coexists with a pending ambiguous identity", () => {
    // A newer durable identity is still pending while recovery restored an
    // unrelated older terminal result. The public snapshot lacks the
    // clientRequestId, so the pending request is not authoritatively resolved:
    // the node must stay protected from a fresh submit and expose the pending
    // surface instead of implying completion.
    const olderCompleted = generationJob("job-older-completed", "completed");
    const lock = resolveGenerationPanelLock(
      input({
        nodeStatus: "success",
        nodeJobStatus: "completed",
        nodeJobs: [olderCompleted],
        newestNodeJob: olderCompleted,
        pendingAmbiguousIdentity: true,
      }),
    );

    expect(lock).toMatchObject({
      activeJob: false,
      awaitingConfirmation: true,
      generationLocked: true,
    });
  });

  it("does not treat an in-session submit in flight as a refresh-ambiguous identity", () => {
    // During an in-session submit the durable identity is present, but the
    // browser submission is in flight, so the pending message must not claim a
    // pre-refresh acceptance; the node is locked by the running optimistic
    // state instead.
    const lock = resolveGenerationPanelLock(
      input({
        nodeStatus: "running",
        nodeJobStatus: "submitting",
        pendingAmbiguousIdentity: true,
        browserSubmissionInFlight: true,
      }),
    );

    expect(lock).toMatchObject({
      activeJob: true,
      awaitingConfirmation: false,
      generationLocked: true,
    });
  });

  it("unlocks a node with a resolved submission and no lingering identity", () => {
    const completed = generationJob("job-completed", "completed");
    const lock = resolveGenerationPanelLock(
      input({
        nodeStatus: "success",
        nodeJobStatus: "completed",
        nodeJobs: [completed],
        newestNodeJob: completed,
        pendingAmbiguousIdentity: false,
      }),
    );

    expect(lock).toMatchObject({
      activeJob: false,
      awaitingConfirmation: false,
      generationLocked: false,
    });
  });

  it("never locks configuration nodes through generation state", () => {
    const lock = resolveGenerationPanelLock(
      input({ isConfiguration: true, pendingAmbiguousIdentity: true }),
    );

    expect(lock.generationLocked).toBe(false);
  });
});

function input(
  overrides: Partial<Parameters<typeof resolveGenerationPanelLock>[0]> = {},
): Parameters<typeof resolveGenerationPanelLock>[0] {
  return {
    isConfiguration: false,
    nodeJobs: [],
    newestNodeJob: null,
    nodeStatus: "idle",
    nodeJobStatus: null,
    pendingAmbiguousIdentity: false,
    browserSubmissionInFlight: false,
    ...overrides,
  };
}

function generationJob(id: string, status: "queued" | "completed"): PublicGenerationJob {
  return {
    schemaVersion: 1,
    version: 1,
    id,
    projectId: "project-a",
    nodeId: "node-a",
    modelId: "image-model",
    modelLabel: "图像模型",
    modality: "image",
    status,
    progress: status === "completed" ? 100 : 0,
    quote: {
      id: "quote-1",
      modelId: "image-model",
      modelLabel: "图像模型",
      modality: "image",
      quantity: 1,
      normalizedParameters: { prompt: "test" },
      creditMicros: 1_000_000,
      credits: "1",
      yuanMicros: 10_000,
      yuan: "0.01",
      estimated: false,
      pricingUnit: "request",
      catalogVersion: "catalog-1",
      capabilityVersion: "capability-1",
      pricingVersion: "pricing-1",
      expiresAt: "2026-07-23T09:00:00.000Z",
    },
    artifacts: [],
    error: null,
    createdAt: "2026-07-23T08:00:00.000Z",
    updatedAt: "2026-07-23T08:01:00.000Z",
    startedAt: "2026-07-23T08:00:30.000Z",
    completedAt: status === "completed" ? "2026-07-23T08:01:00.000Z" : null,
  };
}
