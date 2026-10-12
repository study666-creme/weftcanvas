import { describe, expect, it } from "vitest";

import {
  GENERATION_STALL_THRESHOLD_MS,
  isAdvancingGenerationStatus,
  isGenerationStalled,
} from "./use-generation-stall";

describe("generation stall detection", () => {
  it("treats every advancing generation status as eligible for a stall marker", () => {
    for (const status of [
      "reserved",
      "submitting",
      "queued",
      "running",
      "validating",
      "submission_unknown",
    ]) {
      expect(isAdvancingGenerationStatus(status)).toBe(true);
    }
    for (const status of ["completed", "failed", null, undefined, ""]) {
      expect(isAdvancingGenerationStatus(status)).toBe(false);
    }
  });

  it("marks a frozen advancing job as stalled once the threshold passes", () => {
    expect(
      isGenerationStalled({
        status: "running",
        lastProgressChangeAt: 1_000,
        now: 1_000 + GENERATION_STALL_THRESHOLD_MS,
      }),
    ).toBe(true);
    expect(
      isGenerationStalled({
        status: "queued",
        lastProgressChangeAt: 1_000,
        now: 1_000 + GENERATION_STALL_THRESHOLD_MS + 60_000,
      }),
    ).toBe(true);
  });

  it("keeps a recently advancing job unstalled", () => {
    expect(
      isGenerationStalled({
        status: "running",
        lastProgressChangeAt: 1_000,
        now: 1_000 + GENERATION_STALL_THRESHOLD_MS - 1,
      }),
    ).toBe(false);
  });

  it("never reports a terminal or idle state as stalled", () => {
    for (const status of ["completed", "failed", null]) {
      expect(
        isGenerationStalled({
          status,
          lastProgressChangeAt: 0,
          now: Number.MAX_SAFE_INTEGER,
        }),
      ).toBe(false);
    }
  });
});
