import type { ModelModality, PublicGenerationJob } from "@weftcanvas/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DIRECT_GENERATION_NODE_IDS,
  DIRECT_GENERATION_PROJECT_ID,
  directGenerationArtifactKey,
  emptyDirectGenerationHistory,
  mergeDirectGenerationJobs,
  readDirectGenerationHiddenArtifacts,
  readDirectGenerationHistory,
  writeDirectGenerationHiddenArtifacts,
  writeDirectGenerationHistory,
} from "./direct-generation-history";

describe("direct generation history", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps validated image and video jobs isolated by account", () => {
    const image = job("image-job", "image");
    const video = job("video-job", "video");

    expect(writeDirectGenerationHistory("user-a", { image: [image], video: [video] })).toBe(true);
    expect(readDirectGenerationHistory("user-a")).toEqual({ image: [image], video: [video] });
    expect(readDirectGenerationHistory("user-b")).toEqual(emptyDirectGenerationHistory());
  });

  it("rejects malformed records and keeps the newest version of a recovered job", () => {
    const original = job("same-job", "image", 1);
    const current = {
      ...original,
      version: 3,
      progress: 80,
      updatedAt: "2026-07-22T02:00:00.000Z",
    };
    const wrongProject = { ...job("other", "image"), projectId: "another-project" };

    const merged = mergeDirectGenerationJobs({ image: [original], video: [] }, [
      current,
      wrongProject,
      { broken: true } as unknown as PublicGenerationJob,
    ]);

    expect(merged.image).toEqual([current]);
    expect(merged.video).toEqual([]);
  });

  it("keeps removed result artifacts hidden after remote job recovery", () => {
    const key = directGenerationArtifactKey("image-job", "artifact-1");

    expect(writeDirectGenerationHiddenArtifacts("user-a", new Set([key]))).toBe(true);
    expect(readDirectGenerationHiddenArtifacts("user-a")).toEqual(new Set([key]));
    expect(readDirectGenerationHiddenArtifacts("user-b")).toEqual(new Set());
  });
});

function job(
  id: string,
  modality: Extract<ModelModality, "image" | "video">,
  version = 1,
): PublicGenerationJob {
  const createdAt = "2026-07-22T01:00:00.000Z";
  return {
    schemaVersion: 1,
    version,
    id,
    projectId: DIRECT_GENERATION_PROJECT_ID,
    nodeId: DIRECT_GENERATION_NODE_IDS[modality],
    modelId: `${modality}-model`,
    modelLabel: `${modality} model`,
    modality,
    status: "queued",
    progress: 0,
    quote: {
      id: `${id}-quote`,
      modelId: `${modality}-model`,
      modelLabel: `${modality} model`,
      modality,
      quantity: 1,
      normalizedParameters: {},
      creditMicros: 1_000_000,
      credits: "1",
      yuanMicros: 10_000,
      yuan: "0.01",
      estimated: false,
      pricingUnit: modality === "image" ? "image" : "request",
      catalogVersion: "catalog-1",
      capabilityVersion: "capability-1",
      pricingVersion: "pricing-1",
      expiresAt: "2026-07-22T03:00:00.000Z",
    },
    artifacts: [],
    error: null,
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    completedAt: null,
  };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, String(value));
    },
  };
}
