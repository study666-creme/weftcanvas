import type { MediaKind, PublicModel } from "@weftcanvas/contracts";
import { describe, expect, it } from "vitest";

import {
  customGenerationArtifacts,
  directGenerationParameters,
  directGenerationReferences,
} from "./direct-custom-generation";
import type { DirectReference } from "../state/direct-reference-store";

describe("direct generation BYOK helpers", () => {
  it("maps only ready uploaded references and splits image purposes", () => {
    const references = [
      reference("img-ready", "image", { serverId: "srv-1", imagePurpose: "styleImages" }),
      reference("img-default", "image", { serverId: "srv-2" }),
      reference("img-uploading", "image", { status: "uploading", serverId: null }),
      reference("img-error", "image", { status: "error", serverId: null }),
      reference("vid-ready", "video", { serverId: "srv-3", durationMs: 4_200 }),
      reference("aud-no-server", "audio", { serverId: null }),
    ];

    const result = directGenerationReferences(references, imageModel());

    expect(result.images.map((item) => item.media.id)).toEqual(["srv-2"]);
    expect(result.styleImages.map((item) => item.media.id)).toEqual(["srv-1"]);
    expect(result.elementImages).toEqual([]);
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.media).toMatchObject({
      id: "srv-3",
      source: "server",
      serverId: "srv-3",
      durationMs: 4_200,
    });
    expect(result.audios).toEqual([]);
    expect(result.imagePurposes).toEqual(["images", "styleImages", "elementImages"]);
  });

  it("falls back to the model's first purpose when a reference carries none", () => {
    const singlePurpose = imageModel({ images: false });
    const result = directGenerationReferences(
      [reference("img-1", "image", { serverId: "srv-a" })],
      singlePurpose,
    );
    expect(result.images.map((item) => item.media.id)).toEqual(["srv-a"]);
    expect(result.styleImages).toEqual([]);
  });

  it("converts BYOK results into job artifacts with kind and duration", () => {
    const artifacts = customGenerationArtifacts({
      media: [
        {
          id: "media-image",
          name: "a.png",
          mimeType: "image/png",
          size: 120,
          source: "local",
          serverId: null,
          width: 1024,
          height: 512,
          durationMs: null,
        },
        {
          id: "media-video",
          name: "b.mp4",
          mimeType: "video/mp4",
          size: 9_000,
          source: "local",
          serverId: null,
          width: null,
          height: null,
          durationMs: 5_400,
        },
      ],
    });

    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]).toMatchObject({
      kind: "image",
      mediaId: "media-image",
      name: "a.png",
      mimeType: "image/png",
      size: 120,
      width: 1024,
      height: 512,
    });
    expect(artifacts[0]).not.toHaveProperty("duration");
    expect(artifacts[1]).toMatchObject({ kind: "video", mediaId: "media-video", duration: 5 });
  });

  it("keeps text results as a text artifact", () => {
    const [artifact] = customGenerationArtifacts({ text: "你好" });
    expect(artifact).toMatchObject({ kind: "text", text: "你好" });
  });

  it("submits the measured reference-video seconds, not a stale hand-typed value", () => {
    // 上游按这两个秒数给参考视频计费：实测必须压过草稿里残留的声明值。
    const parameters = directGenerationParameters(
      videoModel(),
      "一只猫在跑",
      { referenceVideoDurations: [1] },
      [15, 6.5],
    );

    expect(parameters).toMatchObject({
      prompt: "一只猫在跑",
      referenceVideoDurations: [15, 6.5],
    });
  });

  it("never sends reference durations to models that do not declare the parameter", () => {
    const parameters = directGenerationParameters(
      imageModel(),
      "一只猫",
      { referenceVideoDurations: [5] },
      [5],
    );

    expect(parameters).not.toHaveProperty("referenceVideoDurations");
  });

  it("drops the parameter entirely when no measured seconds exist", () => {
    const parameters = directGenerationParameters(
      videoModel(),
      "一只猫在跑",
      { referenceVideoDurations: [4] },
      null,
    );

    expect(parameters).not.toHaveProperty("referenceVideoDurations");
  });
});

function reference(
  id: string,
  kind: MediaKind,
  patch: Partial<DirectReference> = {},
): DirectReference {
  return {
    id,
    kind,
    name: `${id}.${kind === "image" ? "png" : kind === "video" ? "mp4" : "mp3"}`,
    previewUrl: null,
    serverId: "srv-default",
    status: "ready",
    error: null,
    uploadKey: `upload:${id}`,
    imagePurpose: null,
    durationMs: null,
    ...patch,
  };
}

function videoModel(): PublicModel {
  return {
    id: "custom:p:minimax_h3",
    label: "Minimax H3",
    description: "",
    modality: "video",
    operation: "generate",
    order: 0,
    input: {
      textRequired: true,
      videos: { min: 0, max: 3, multiple: true },
      referenceMedia: { videos: { min: 0, max: 3, multiple: true } },
    },
    output: { type: "video", minCount: 1, maxCount: 1 },
    parameters: [
      {
        name: "prompt",
        label: "提示词",
        type: "string",
        required: true,
        mutuallyExclusiveWith: [],
      },
      {
        name: "referenceVideos",
        label: "参考视频",
        type: "array",
        required: false,
        mutuallyExclusiveWith: [],
        items: { type: "string", format: "public-http-url" },
      },
      {
        name: "referenceVideoDurations",
        label: "参考视频时长（秒）",
        type: "array",
        required: false,
        mutuallyExclusiveWith: [],
        items: { type: "number" },
      },
    ],
    pricing: {
      mode: "fixed",
      unit: "second",
      currency: "CNY",
      creditsPerYuan: 1,
      baseCreditMicros: 0,
      baseYuanMicros: 0,
      tiers: [],
    },
  };
}

function imageModel(options: { images?: boolean } = {}): PublicModel {
  return {
    id: "custom:p:image-model",
    label: "Image Model",
    description: "",
    modality: "image",
    operation: "generate",
    order: 0,
    input: {
      textRequired: true,
      images: { min: 0, max: 16, multiple: true },
      referenceMedia:
        options.images === false
          ? { images: { min: 0, max: 4, multiple: true } }
          : {
              images: { min: 0, max: 4, multiple: true },
              styleImages: { min: 0, max: 1, multiple: false },
              elementImages: { min: 0, max: 1, multiple: false },
            },
    },
    output: { type: "image", minCount: 1, maxCount: 1 },
    parameters: [],
    pricing: {
      mode: "fixed",
      unit: "request",
      currency: "CNY",
      creditsPerYuan: 1,
      baseCreditMicros: 0,
      baseYuanMicros: 0,
      tiers: [],
    },
  };
}
