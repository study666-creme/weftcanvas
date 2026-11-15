import { describe, expect, it } from "vitest";

import { createSyntheticCustomModel, createSyntheticCustomRoute } from "./custom-api";
import { composeModelParameters } from "./generation-config";
import {
  CUSTOM_COMMON_ASPECT_RATIOS,
  CUSTOM_COMMON_IMAGE_RESOLUTIONS,
  CUSTOM_COMMON_VIDEO_IMAGE_INPUT,
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

    expect(names(supplemented.parameters)).toEqual([
      "prompt",
      "aspect_ratio",
      "resolution",
      "negative_prompt",
      "seed",
      "watermark",
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
    expect(names(supplementedRoute!.parameters)).toEqual([
      "model",
      "prompt",
      "images",
      "aspect_ratio",
      "resolution",
      "negative_prompt",
      "seed",
      "watermark",
    ]);
  });

  it("adds seconds on top of ratio and resolution for video models", () => {
    const { model, route } = synthetic("relay-video-unknown", "video");
    const { model: supplemented } = withCommonCustomParameters(model, route);

    expect(names(supplemented.parameters).slice(0, 4)).toEqual([
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

  /**
   * 用户口径（2026-11-06）：自带 API 的模型以前只能文生——参考图没有输入槽位，
   * 上传控件根本不存在。视频模型必须补出「首帧/多图参考」入口。
   */
  it("gives an unknown video model an image and a video reference slot", () => {
    const { model, route } = synthetic("relay-video-unknown", "video");
    const { model: supplemented, route: supplementedRoute } = withCommonCustomParameters(
      model,
      route,
    );

    expect(supplemented.input.images).toEqual(CUSTOM_COMMON_VIDEO_IMAGE_INPUT);
    expect(supplemented.input.videos).toEqual({ min: 0, max: 1, multiple: false });
    expect(names(supplementedRoute!.parameters)).toEqual(
      expect.arrayContaining(["image", "reference_images", "video"]),
    );
    const single = supplementedRoute!.parameters.find((parameter) => parameter.name === "image")!;
    expect(single.format).toBe("public-http-url");
    const multiple = supplementedRoute!.parameters.find(
      (parameter) => parameter.name === "reference_images",
    )!;
    expect(multiple.type).toBe("array");
    expect(multiple.itemsFormat).toBe("public-http-url");
  });

  /**
   * 线上反馈的原始场景：seedance 是有知识库条目的「已识别」视频模型，
   * 以前走 createKnownCustomRoute 只声明提示词，所以素材区整块消失。
   */
  it("gives a recognized video family (seedance) the same reference slots", () => {
    const { model, route } = synthetic("doubao-seedance-2.0", "video");
    expect(model.parameters.map((parameter) => parameter.name)).toEqual(["prompt"]);

    const { model: supplemented, route: supplementedRoute } = withCommonCustomParameters(
      model,
      route,
    );
    expect(supplemented.input.images).toEqual(CUSTOM_COMMON_VIDEO_IMAGE_INPUT);
    expect(names(supplementedRoute!.parameters)).toEqual(
      expect.arrayContaining(["image", "reference_images", "video"]),
    );
    expect(names(supplemented.parameters)).toEqual(
      expect.arrayContaining(["aspect_ratio", "resolution", "seconds"]),
    );
  });

  it("never duplicates a media slot the catalog already declares", () => {
    const { model, route } = synthetic("relay-video-declared", "video");
    const declaredRoute = {
      ...route!,
      parameters: [
        ...route!.parameters,
        { name: "first_frame_image", path: "first_frame_image", type: "string" as const },
      ],
    };
    const { model: supplemented, route: supplementedRoute } = withCommonCustomParameters(
      { ...model, input: { ...model.input, images: { min: 0, max: 1, multiple: false } } },
      declaredRoute,
    );
    expect(supplemented.input.images).toEqual({ min: 0, max: 1, multiple: false });
    expect(names(supplementedRoute!.parameters)).not.toContain("image");
    expect(names(supplementedRoute!.parameters)).not.toContain("reference_images");
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
      parameters: [
        ...route!.parameters,
        { name: "size", path: "size", type: "string" as const },
        { name: "negative_prompt", path: "negative_prompt", type: "string" as const },
        { name: "seed", path: "seed", type: "number" as const },
        { name: "watermark", path: "watermark", type: "boolean" as const },
      ],
    };
    const { model: supplemented, route: supplementedRoute } = withCommonCustomParameters(
      model,
      declaredRoute,
    );
    // size 同时覆盖画幅与像素尺寸概念，其余三个也已声明：一个都不补。
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
        { name: "negative_prompt", path: "negative_prompt", type: "string" as const },
        { name: "seed", path: "seed", type: "number" as const },
        { name: "watermark", path: "watermark", type: "boolean" as const },
        { name: "camera_fixed", path: "camera_fixed", type: "boolean" as const },
        { name: "generate_audio", path: "generate_audio", type: "boolean" as const },
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

  /**
   * 给够选项的前提：多出来的字段不能自己跑进请求。旧字段（比例/分辨率/时长）仍然
   * 所见即所发；新增字段一律「不填不下发」，用户不动它们时请求与以前一致。
   */
  it("never sends the opt-in knobs unless the user sets them", () => {
    const { model, route } = synthetic("doubao-seedance-2.0", "video");
    const { model: supplemented } = withCommonCustomParameters(model, route);

    const untouched = composeModelParameters(supplemented, "一只猫在雪地里奔跑", {});
    expect(untouched).toEqual({
      prompt: "一只猫在雪地里奔跑",
      aspect_ratio: "16:9",
      resolution: "720p",
      seconds: "5",
    });

    const tuned = composeModelParameters(supplemented, "一只猫在雪地里奔跑", {
      negative_prompt: "模糊",
      seed: 42,
      watermark: false,
      camera_fixed: true,
      generate_audio: true,
    });
    expect(tuned).toMatchObject({
      negative_prompt: "模糊",
      seed: 42,
      watermark: false,
      camera_fixed: true,
      generate_audio: true,
    });
  });
});
