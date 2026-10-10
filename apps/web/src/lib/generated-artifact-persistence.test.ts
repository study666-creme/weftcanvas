import type { PublicGenerationJob } from "@kachang/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const persistence = vi.hoisted(() => ({
  cacheServerMedia: vi.fn(),
  readMedia: vi.fn(),
  ensureMediaAsset: vi.fn(),
}));

vi.mock("./media-store", () => ({
  cacheServerMedia: persistence.cacheServerMedia,
  readMedia: persistence.readMedia,
}));
vi.mock("./asset-library-store", () => ({ ensureMediaAsset: persistence.ensureMediaAsset }));

import { persistCompletedGenerationArtifacts } from "./generated-artifact-persistence";

describe("completed generation artifact persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    persistence.cacheServerMedia.mockResolvedValue(true);
    persistence.readMedia.mockImplementation(async (mediaId: string) => {
      const cachedMedia = persistence.cacheServerMedia.mock.calls
        .map(([media]) => media)
        .find((media) => media.id === mediaId);
      if (!cachedMedia) return null;
      const blob = new Blob([new Uint8Array(2_048)], { type: cachedMedia.mimeType });
      return { ...cachedMedia, size: blob.size, blob, storedAt: Date.now() };
    });
    persistence.ensureMediaAsset.mockResolvedValue(undefined);
  });

  it("caches and archives every generated media kind with project authorization", async () => {
    await persistCompletedGenerationArtifacts(completedJob("all-media"));

    expect(persistence.cacheServerMedia).toHaveBeenCalledTimes(3);
    expect(persistence.cacheServerMedia.mock.calls.map(([media, projectId]) => [media.id, projectId])).toEqual([
      ["media-image-all-media", "project-creation-flow"],
      ["media-video-all-media", "project-creation-flow"],
      ["media-audio-all-media", "project-creation-flow"],
    ]);
    expect(persistence.ensureMediaAsset.mock.calls.map(([media, kind, source]) => [
      media.size,
      media.durationMs,
      kind,
      source,
    ])).toEqual([
      [2_048, null, "image", "canvas"],
      [2_048, 1_250, "video", "canvas"],
      [2_048, 2_200, "audio", "canvas"],
    ]);
  });

  it("waits for measured browser media before writing the asset", async () => {
    let finishCache: ((value: boolean) => void) | null = null;
    persistence.cacheServerMedia.mockImplementation(() => new Promise<boolean>((resolve) => {
      finishCache = resolve;
    }));
    const request = persistCompletedGenerationArtifacts(completedJob("measured", ["video"]));

    expect(persistence.readMedia).not.toHaveBeenCalled();
    expect(persistence.ensureMediaAsset).not.toHaveBeenCalled();
    finishCache!(true);
    await request;

    expect(persistence.readMedia).toHaveBeenCalledWith("media-video-measured");
    expect(persistence.ensureMediaAsset.mock.calls[0]?.[0]).toMatchObject({
      id: "media-video-measured",
      size: 2_048,
      source: "server",
    });
  });

  it("falls back to owner-scoped media when a recovered job has moved projects", async () => {
    persistence.cacheServerMedia.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await persistCompletedGenerationArtifacts(completedJob("moved-project", ["video"]));

    const media = expect.objectContaining({ id: "media-video-moved-project" });
    expect(persistence.cacheServerMedia).toHaveBeenNthCalledWith(1, media, "project-creation-flow");
    expect(persistence.cacheServerMedia).toHaveBeenNthCalledWith(2, media);
    expect(persistence.ensureMediaAsset).toHaveBeenCalledTimes(1);
  });

  it("coalesces duplicate completion delivery and permits a later retry", async () => {
    let finishCache: ((value: boolean) => void) | null = null;
    persistence.cacheServerMedia.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      finishCache = resolve;
    })).mockResolvedValueOnce(false);
    const job = completedJob("dedupe", ["video"]);
    const first = persistCompletedGenerationArtifacts(job);
    const second = persistCompletedGenerationArtifacts(job);
    expect(persistence.cacheServerMedia).toHaveBeenCalledTimes(1);
    finishCache!(false);
    await expect(Promise.all([first, second])).rejects.toThrow("could not be cached");
    expect(persistence.cacheServerMedia).toHaveBeenCalledTimes(2);

    await expect(persistCompletedGenerationArtifacts(job)).resolves.toBeUndefined();
    expect(persistence.cacheServerMedia).toHaveBeenCalledTimes(3);
    expect(persistence.ensureMediaAsset).toHaveBeenCalledTimes(1);
  });

  it("limits historical restoration to two concurrent browser writes", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let maximumActive = 0;
    persistence.cacheServerMedia.mockImplementation(() => new Promise<boolean>((resolve) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      releases.push(() => {
        active -= 1;
        resolve(true);
      });
    }));

    const request = persistCompletedGenerationArtifacts(completedJob("bounded"));
    await vi.waitFor(() => expect(persistence.cacheServerMedia).toHaveBeenCalledTimes(2));
    releases.shift()!();
    await vi.waitFor(() => expect(persistence.cacheServerMedia).toHaveBeenCalledTimes(3));
    while (releases.length) releases.shift()!();
    await request;
    expect(maximumActive).toBe(2);
  });

  it("does nothing before the job completes", async () => {
    await persistCompletedGenerationArtifacts({ ...completedJob("running"), status: "running" });
    expect(persistence.cacheServerMedia).not.toHaveBeenCalled();
    expect(persistence.ensureMediaAsset).not.toHaveBeenCalled();
  });
});

function completedJob(
  suffix: string,
  kinds: Array<"image" | "video" | "audio"> = ["image", "video", "audio"],
): PublicGenerationJob {
  const createdAt = "2026-07-27T08:00:00.000Z";
  return {
    schemaVersion: 1,
    version: 4,
    id: `job-${suffix}`,
    projectId: "project-creation-flow",
    nodeId: "node-generation",
    modelId: "creation-model",
    modelLabel: "Creation Model",
    modality: kinds[0] ?? "image",
    status: "completed",
    progress: 100,
    quote: {
      id: `quote-${suffix}`,
      modelId: "creation-model",
      modelLabel: "Creation Model",
      modality: kinds[0] ?? "image",
      quantity: 1,
      normalizedParameters: {},
      creditMicros: 1_000_000,
      credits: "1",
      yuanMicros: 10_000,
      yuan: "0.01",
      estimated: false,
      pricingUnit: "request",
      catalogVersion: "catalog-flow",
      capabilityVersion: "capability-flow",
      pricingVersion: "pricing-flow",
      expiresAt: "2026-07-27T09:00:00.000Z",
    },
    artifacts: [
      { id: `text-${suffix}`, kind: "text", text: "ignored", createdAt },
      ...kinds.map((kind) => ({
        id: `${kind}-${suffix}`,
        kind,
        mediaId: `media-${kind}-${suffix}`,
        name: `${kind}-${suffix}.${kind === "image" ? "png" : kind === "video" ? "mp4" : "mp3"}`,
        mimeType: kind === "image" ? "image/png" : kind === "video" ? "video/mp4" : "audio/mpeg",
        size: 1_024,
        ...(kind === "image" ? { width: 1_024, height: 768 } : { duration: kind === "video" ? 1.25 : 2.2 }),
        createdAt,
      })),
    ],
    error: null,
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
    completedAt: createdAt,
  };
}
