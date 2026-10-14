import { describe, expect, it } from "vitest";

import {
  inferKnowledgePlan,
  isGrokImagineVideoModel,
  isRecognizedModel,
  knowledgeModalities,
  modelSupportsModality,
} from "./custom-model-knowledge";

describe("BYOK model knowledge base", () => {
  it("infers modality from official ids across the supported families", () => {
    const video = [
      "doubao-seedance-2.0",
      "seedance-2.0-fast",
      "sora-2",
      "kling-v2",
      "veo-3",
      "wan-2.1",
      "hunyuan-video",
      "minimax-hailuo-02",
      "hailuo-02",
      "pika-2.0",
      "ray-2",
      "gen-4",
    ];
    for (const id of video) expect(knowledgeModalities(id), id).toEqual(["video"]);

    const image = [
      "midjourney",
      "mj_v6",
      "gpt-image-1",
      "dall-e-3",
      "flux-1.1-pro",
      "nano-banana",
      "imagen-4",
      "doubao-seedream-3.0",
      "seedream-3.0",
      "hunyuan-image-3.0",
    ];
    for (const id of image) expect(knowledgeModalities(id), id).toEqual(["image"]);
  });

  it("keeps the Grok entries fully specified with vendor-official labels", () => {
    expect(isGrokImagineVideoModel("grok-imagine-video")).toBe(true);
    expect(isGrokImagineVideoModel("grok-imagine-video-1.5")).toBe(true);
    expect(isGrokImagineVideoModel("grok-imagine-video-2")).toBe(false);

    const plan = inferKnowledgePlan("grok-imagine-video-1.5")!;
    expect(plan.label).toBe("Grok Imagine Video 1.5");
    expect(plan.endpointPath).toBe("/v1/videos");
    expect(plan.imageInput).toEqual({ min: 1, max: 1, multiple: false });
    expect(plan.uiParameters.map((parameter) => parameter.name)).toEqual([
      "prompt",
      "seconds",
      "aspect_ratio",
      "resolution",
    ]);
    expect(plan.wireParameters.map((parameter) => parameter.name)).toEqual([
      "prompt",
      "seconds",
      "aspect_ratio",
      "resolution",
      "first_frame_image",
    ]);
  });

  it("does not infer video from a vendor name shared with text or image models", () => {
    for (const id of ["MiniMax-M2.1", "MiniMax-Text-01", "hunyuan-large", "hunyuan-turbo"]) {
      expect(inferKnowledgePlan(id), id).toBeNull();
      expect(knowledgeModalities(id), id).not.toContain("video");
    }
    expect(inferKnowledgePlan("hunyuan-image-3.0")?.endpointPath).toBe("/v1/images/generations");
    expect(knowledgeModalities("video-01-live")).toEqual(["video"]);
  });

  it("refuses to guess unknown ids and never rewrites official ids into our aliases", () => {
    for (const id of [
      "motion-video",
      "higgsfield-sd2",
      "my-seedance-clone",
      "not-a-sora-model",
      "vendor-mystery-model",
      "",
    ]) {
      expect(inferKnowledgePlan(id), id).toBeNull();
      expect(isRecognizedModel(id), id).toBe(false);
    }

    // 官方 id 原样呈现：知识库不为它编造我方别称或中文名。
    expect(inferKnowledgePlan("doubao-seedance-2.0")?.label).toBeUndefined();
  });

  it("stays conservative outside Grok: prompt-only until a protocol profile fills in", () => {
    for (const id of ["kling-v2", "sora-2", "gpt-image-1", "midjourney"]) {
      const plan = inferKnowledgePlan(id)!;
      expect(
        plan.uiParameters.map((parameter) => parameter.name),
        id,
      ).toEqual(["prompt"]);
      expect(
        plan.wireParameters.map((parameter) => parameter.name),
        id,
      ).toEqual(["prompt"]);
    }
    const midjourney = inferKnowledgePlan("midjourney")!;
    expect(midjourney.endpointPath).toBe("/v1/midjourney/generations");
    expect(inferKnowledgePlan("flux-1.1-pro")?.endpointPath).toBe("/v1/images/generations");
  });

  it("lets manual assignment win and knowledge fill the gap", () => {
    expect(modelSupportsModality("kling-v2", undefined, "video")).toBe(true);
    expect(modelSupportsModality("kling-v2", undefined, "image")).toBe(false);
    // 未知 id 手动标注后即可用：未识别不等于不可用。
    expect(modelSupportsModality("higgsfield-sd2", undefined, "video")).toBe(false);
    expect(modelSupportsModality("higgsfield-sd2", ["video"], "video")).toBe(true);
    // 手动标注可以覆盖知识库判断。
    expect(modelSupportsModality("kling-v2", ["image"], "image")).toBe(true);
  });
});
