import { describe, expect, it } from "vitest";

import { createCanvasEdge, createCanvasNode } from "./node-factory";
import { findConfigurationSource, syncConfigurationTargets } from "./node-configuration";

describe("node configuration", () => {
  it("finds a matching direct configuration source", () => {
    const config = createCanvasNode("config", { x: 0, y: 0 }, { config: { modality: "image" } });
    const image = createCanvasNode("image", { x: 400, y: 0 });
    const edge = createCanvasEdge(config.id, image.id);

    expect(findConfigurationSource(image.id, [config, image], [edge])?.id).toBe(config.id);
  });

  it("does not bind configuration nodes with another modality", () => {
    const config = createCanvasNode("config", { x: 0, y: 0 }, { config: { modality: "video" } });
    const image = createCanvasNode("image", { x: 400, y: 0 });
    const edge = createCanvasEdge(config.id, image.id);

    expect(findConfigurationSource(image.id, [config, image], [edge])).toBeNull();
  });

  it("ignores a legacy text configuration instead of binding a text target", () => {
    const config = createCanvasNode("config", { x: 0, y: 0 });
    config.data.config = { modality: "text" } as never;
    const text = createCanvasNode("text", { x: 400, y: 0 });
    const edge = createCanvasEdge(config.id, text.id);

    expect(findConfigurationSource(text.id, [config, text], [edge])).toBeNull();
    expect(syncConfigurationTargets([config, text], [edge], config.id)).toEqual([config, text]);
  });

  it("treats a historical null configuration as an image configuration", () => {
    const config = createCanvasNode(
      "config",
      { x: 0, y: 0 },
      {
        config: null,
        generation: {
          modelId: "legacy-image-model",
          parameters: {},
          referenceImagePurposes: {},
          maxOutputTokens: null,
          referenceMode: "auto",
          referenceNodeIds: [],
          jobId: null,
          jobVersion: null,
          jobCreatedAt: null,
          jobStatus: null,
          error: null,
        },
      },
    );
    const image = createCanvasNode("image", { x: 400, y: 0 });
    const edge = createCanvasEdge(config.id, image.id);

    expect(findConfigurationSource(image.id, [config, image], [edge])?.id).toBe(config.id);
    const synced = syncConfigurationTargets([config, image], [edge], config.id);
    expect(synced.find((node) => node.id === image.id)?.data.generation.modelId).toBe(
      "legacy-image-model",
    );
  });

  it("lets the latest matching configuration own a shared target", () => {
    const first = createCanvasNode("config", { x: 0, y: 0 }, { config: { modality: "image" } });
    const latest = createCanvasNode("config", { x: 0, y: 220 }, { config: { modality: "image" } });
    const image = createCanvasNode("image", { x: 400, y: 0 });
    const edges = [createCanvasEdge(first.id, image.id), createCanvasEdge(latest.id, image.id)];

    expect(findConfigurationSource(image.id, [first, latest, image], edges)?.id).toBe(latest.id);
  });

  it("copies reusable settings without overwriting target job state", () => {
    const config = createCanvasNode(
      "config",
      { x: 0, y: 0 },
      {
        config: { modality: "image" },
        generation: {
          modelId: "image-model",
          parameters: { aspect_ratio: "16:9" },
          referenceImagePurposes: {},
          maxOutputTokens: null,
          referenceMode: "auto",
          referenceNodeIds: [],
          jobId: null,
          jobVersion: null,
          jobCreatedAt: null,
          jobStatus: null,
          error: null,
        },
      },
    );
    const image = createCanvasNode("image", { x: 400, y: 0 });
    image.data.generation.jobId = "existing-job";
    image.data.generation.referenceNodeIds = ["reference-1"];
    const edge = createCanvasEdge(config.id, image.id);

    const result = syncConfigurationTargets([config, image], [edge], config.id);
    const target = result.find((node) => node.id === image.id)!;
    expect(target.data.generation).toMatchObject({
      modelId: "image-model",
      parameters: { aspect_ratio: "16:9" },
      jobId: "existing-job",
      referenceNodeIds: ["reference-1"],
    });
  });
});
