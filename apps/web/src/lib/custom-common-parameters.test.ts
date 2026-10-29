import { describe, expect, it } from "vitest";

import { createSyntheticCustomModel, createSyntheticCustomRoute } from "./custom-api";
import {
  CUSTOM_COMMON_ASPECT_RATIOS,
  CUSTOM_COMMON_IMAGE_RESOLUTIONS,
  CUSTOM_COMMON_VIDEO_RESOLUTIONS,
  CUSTOM_COMMON_VIDEO_SECONDS,
  withCommonCustomParameters,
} from "./custom-common-parameters";

function synthetic(modelId: string, modality: "image" | "video" | "audio") {
  const model = createSyntheticCustomModel(modelId, modality);
  const route = createSyntheticCustomRoute(modelId, modality);
  if (!route) throw new Error(`${modelId} should have a synthetic route`);
  return { model, route };
}

function names(values: { name: string }[]) {
  return values.map((value) => value.name);
}

describe("BYOK common parameters", () => {
  it("fills aspect ratio and resolution for an image model with no declared capabilities", () => {
    const { model, route } = synthetic("relay-image-unknown", "image");
    const { model: supplemented, route: supplementedRoute } = withCommonCustomParameters(
      model,
      route,
    );

    expect(names(supplemented.parameters)).toEqual(["prompt", "aspect_ratio", "resolution"]);
    expect(names(supplementedRoute!.parameters)).toEqual([
      "model",
      "prompt",
      "images",
      "aspect_ratio",
      "resolution",
    ]);

    const aspect = supplemented.parameters.find((parameter) => parameter.name === "aspect_ratio")!;
    expect(aspect.label).toBe("画面比例");
    expect(aspect.options).toEqual([...CUSTOM_COMMON_ASPECT_RATIOS]);
    expect(aspect.required).toBe(false);
    // 默认值必须落在选项内：芯片高亮的那一项就是会被提交的那一项。
    expect(aspect.default).toBe("1:1");
    const resolution = supplemented.parameters.find(
      (parameter) => parameter.name === "resolution",
    )!;
    expect(resolution.options).toEqual([...CUSTOM_COMMON_IMAGE_RESOLUTIONS]);
    expect(resolution.default).toBe("1K");
  });

  it("adds seconds on top of ratio and resolution for video models", () => {
    const { model, route } = synthetic("relay-video-unknown", "video");
    const { model: supplemented } = withCommonCustomParameters(model, route);

    expect(names(supplemented.parameters)).toEqual([
      "prompt",
      "aspect_ratio",
      "resolution",
      "seconds",
    ]);
    const seconds = supplemented.parameters.find((parameter) => parameter.name === "seconds")!;
    expect(seconds.label).toBe("时长（秒）");
    expect(seconds.options).toEqual([...CUSTOM_COMMON_VIDEO_SECONDS]);
    expect(seconds.default).toBe("5");
    const resolution = supplemented.parameters.find(
      (parameter) => parameter.name === "resolution",
    )!;
    expect(resolution.options).toEqual([...CUSTOM_COMMON_VIDEO_RESOLUTIONS]);
    expect(resolution.default).toBe("720p");
  });

  it("leaves text and audio models alone", () => {
    for (const modality of ["audio", "text"] as const) {
      const model = createSyntheticCustomModel(`relay-${modality}`, modality);
      const route = createSyntheticCustomRoute(`relay-${modality}`, modality);
      const result = withCommonCustomParameters(model, route ?? null);
      expect(result.model.parameters).toEqual(model.parameters);
      expect(result.route).toEqual(route ?? null);
    }
  });

  it("does not double up when the catalog already describes the concept", () => {
    const { model, route } = synthetic("relay-declared", "image");
    const declaredRoute = {
      ...route!,
      parameters: [...route!.parameters, { name: "size", path: "size", type: "string" as const }],
    };
    const { model: supplemented, route: supplementedRoute } = withCommonCustomParameters(
      model,
      declaredRoute,
    );
    // size 同时覆盖画幅与像素尺寸概念：两个都不再补。
    expect(supplemented.parameters).toEqual(model.parameters);
    expect(supplementedRoute).toEqual(declaredRoute);
  });

  it("fills only the missing concept when part of the capability is declared", () => {
    const { model, route } = synthetic("relay-video-partial", "video");
    const declaredRoute = {
      ...route!,
      parameters: [
        ...route!.parameters,
        { name: "aspectRatio", path: "aspectRatio", type: "string" as const },
        { name: "duration_seconds", path: "duration_seconds", type: "number" as const },
      ],
    };
    const { model: supplemented } = withCommonCustomParameters(model, declaredRoute);
    expect(names(supplemented.parameters)).toEqual(["prompt", "resolution"]);
  });

  it("returns a model without a protocol untouched", () => {
    const { model } = synthetic("relay-no-route", "image");
    const result = withCommonCustomParameters(model, null);
    expect(result.model).toBe(model);
    expect(result.route).toBeNull();
  });
});
