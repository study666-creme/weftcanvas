import { describe, expect, it } from "vitest";

import type { CanvasMedia, GenerationArtifact, PublicGenerationJob } from "@weftcanvas/contracts";

import { createCanvasNode, mediaNodeDimensions } from "./node-factory";
import {
  applyArtifact,
  artifactAlreadyPresent,
  artifactKind,
  aspectRatiosEqual,
  compareGenerationOrder,
  generationWithArtifact,
  hasUsableDimensions,
  inferNodeScale,
  mediaMetadataEqual,
  nodeMediaRatioMatches,
  projectionResult,
  resizeNodeForMedia,
  restoreNodeDimensions,
} from "./canvas-node-projection";

const CREATED_AT = "2026-10-01T08:00:00.000Z";

function media(overrides: Partial<CanvasMedia> = {}): CanvasMedia {
  return {
    id: "media-1",
    name: "frame.png",
    mimeType: "image/png",
    size: 2_048,
    source: "server",
    serverId: "media-1",
    width: 1_000,
    height: 500,
    durationMs: null,
    ...overrides,
  };
}

function imageArtifact(overrides: Partial<GenerationArtifact> = {}): GenerationArtifact {
  return {
    id: "artifact-1",
    kind: "image",
    mediaId: "media-1",
    name: "frame.png",
    mimeType: "image/png",
    size: 2_048,
    width: 1_000,
    height: 500,
    createdAt: CREATED_AT,
    ...overrides,
  } as GenerationArtifact;
}

function textArtifact(text = "一段旁白"): GenerationArtifact {
  return { id: "artifact-text", kind: "text", text, createdAt: CREATED_AT };
}

function job(id = "job-1"): PublicGenerationJob {
  return {
    schemaVersion: 1,
    version: 2,
    id,
    projectId: "project-1",
    nodeId: "node-1",
    modelId: "image-model",
    modelLabel: "Image model",
    modality: "image",
    status: "completed",
    progress: 100,
    quote: {
      id: "quote-1",
      modelId: "image-model",
      modelLabel: "Image model",
      modality: "image",
      quantity: 1,
      normalizedParameters: {},
      creditMicros: 1,
      credits: "0.000001",
      yuanMicros: 1,
      yuan: "0.000001",
      estimated: false,
      pricingUnit: "image",
      catalogVersion: "catalog-1",
      capabilityVersion: "capability-1",
      pricingVersion: "pricing-1",
      expiresAt: "2026-10-01T09:00:00.000Z",
    },
    artifacts: [],
    error: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    startedAt: CREATED_AT,
    completedAt: CREATED_AT,
  };
}

describe("canvas node projection", () => {
  it("orders generation results by time and then by id", () => {
    expect(
      compareGenerationOrder("2026-10-01T08:00:00.000Z", "a", "2026-10-01T09:00:00.000Z", "b"),
    ).toBeLessThan(0);
    expect(
      compareGenerationOrder("2026-10-01T09:00:00.000Z", "b", "2026-10-01T08:00:00.000Z", "a"),
    ).toBeGreaterThan(0);
    expect(
      compareGenerationOrder("2026-10-01T08:00:00.000Z", "a", "2026-10-01T08:00:00.000Z", "b"),
    ).toBeLessThan(0);
  });

  it("classifies the projection result from the artifact kind", () => {
    expect(projectionResult(undefined)).toBe("none");
    expect(projectionResult(null)).toBe("none");
    expect(projectionResult(textArtifact())).toBe("text");
    expect(projectionResult(imageArtifact())).toBe("media");
  });

  it("maps a media artifact onto the node kind it represents", () => {
    expect(artifactKind(textArtifact())).toBe("text");
    expect(artifactKind(imageArtifact())).toBe("image");
    expect(artifactKind(imageArtifact({ kind: "video" }))).toBe("video");
  });

  it("keeps the artifact id while preserving the rest of the generation state", () => {
    const node = createCanvasNode("image", { x: 0, y: 0 });
    const generation = generationWithArtifact(node.data.generation, "artifact-1");

    expect(generation.artifactId).toBe("artifact-1");
    expect(generation.modelId).toBe(node.data.generation.modelId);
    expect(node.data.generation.artifactId).toBeUndefined();
  });

  it("only treats positive finite dimensions as usable", () => {
    const node = createCanvasNode("image", { x: 0, y: 0 });

    expect(hasUsableDimensions({ ...node, width: 320, height: 180 })).toBe(true);
    expect(hasUsableDimensions({ ...node, width: 0, height: 180 })).toBe(false);
    expect(hasUsableDimensions({ ...node, width: Number.NaN, height: 180 })).toBe(false);
    expect(hasUsableDimensions({ ...node, width: undefined, height: undefined })).toBe(false);
  });

  it("compares aspect ratios with the documented tolerance", () => {
    expect(aspectRatiosEqual(null, 2)).toBe(false);
    expect(aspectRatiosEqual(2, null)).toBe(false);
    expect(aspectRatiosEqual(2, 2)).toBe(true);
    expect(aspectRatiosEqual(2, 2.0001)).toBe(true);
    expect(aspectRatiosEqual(2, 2.5)).toBe(false);
  });

  it("compares media metadata across every persisted field", () => {
    expect(mediaMetadataEqual(media(), media())).toBe(true);
    expect(mediaMetadataEqual(null, media())).toBe(false);
    expect(mediaMetadataEqual(media(), media({ size: 4_096 }))).toBe(false);
    expect(mediaMetadataEqual(media(), media({ width: null }))).toBe(false);
  });

  it("writes text artifacts into the body without media", () => {
    const node = createCanvasNode("text", { x: 0, y: 0 });
    const next = applyArtifact(node.data, textArtifact("第一幕"));

    expect(next.body).toBe("第一幕");
    expect(next.media).toBeNull();
    expect(next.status).toBe("success");
    expect(next.progress).toBeNull();
  });

  it("maps media artifacts into a server-owned media record with millisecond duration", () => {
    const node = createCanvasNode("video", { x: 0, y: 0 });
    const next = applyArtifact(
      node.data,
      imageArtifact({ kind: "video", duration: 3.2, width: 1_280, height: 720 }),
    );

    expect(next.media).toMatchObject({
      id: "media-1",
      serverId: "media-1",
      source: "server",
      width: 1_280,
      height: 720,
      durationMs: 3_200,
    });
    expect(next.status).toBe("success");
  });

  it("clamps inferred node scale to the supported range", () => {
    const base = createCanvasNode("image", { x: 0, y: 0 });

    expect(inferNodeScale({ ...base, width: 100, height: 100 })).toBeCloseTo(0.35);
    expect(inferNodeScale({ ...base, width: 10_000, height: 10_000 })).toBe(12);
    expect(inferNodeScale(base)).toBe(1);
  });

  it("fits a node to its media dimensions", () => {
    const node = createCanvasNode("image", { x: 0, y: 0 });
    const fitted = resizeNodeForMedia({ ...node, width: 0, height: 0 }, media());

    expect({ width: fitted.width, height: fitted.height }).toEqual(
      mediaNodeDimensions("image", media()),
    );
  });

  it("keeps a node that cannot be fitted because the media has no dimensions", () => {
    const node = { ...createCanvasNode("image", { x: 0, y: 0 }), width: 320, height: 180 };
    const result = resizeNodeForMedia(node, media({ width: null, height: null }));

    expect(result).toBe(node);
  });

  it("restores dimensions from media when the node has none", () => {
    const node = createCanvasNode("image", { x: 0, y: 0 });
    const restored = restoreNodeDimensions({
      ...node,
      width: 0,
      height: 0,
      data: { ...node.data, media: media() },
    });

    expect({ width: restored.width, height: restored.height }).toEqual(
      mediaNodeDimensions("image", media()),
    );
  });

  it("recognizes a node that already matches its media ratio", () => {
    const node = createCanvasNode("image", { x: 0, y: 0 });
    const fitted = mediaNodeDimensions("image", media());

    expect(nodeMediaRatioMatches({ ...node, ...fitted }, media())).toBe(true);
    expect(nodeMediaRatioMatches({ ...node, width: 200, height: 400 }, media())).toBe(false);
  });

  it("detects an artifact that already landed on the canvas", () => {
    const node = createCanvasNode("image", { x: 0, y: 0 });

    expect(
      artifactAlreadyPresent(
        [{ ...node, data: { ...node.data, media: media() } }],
        job(),
        imageArtifact(),
      ),
    ).toBe(true);
    expect(
      artifactAlreadyPresent(
        [
          {
            ...node,
            data: {
              ...node.data,
              body: "第一幕",
              generation: { ...node.data.generation, jobId: "job-1" },
            },
          },
        ],
        job(),
        textArtifact("第一幕"),
      ),
    ).toBe(true);
    expect(artifactAlreadyPresent([node], job(), imageArtifact())).toBe(false);
  });
});
