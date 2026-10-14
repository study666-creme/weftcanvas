import { describe, expect, it } from "vitest";

import {
  boundedDurationOptions,
  generationParameterOptionLabel,
  generationParameterScalarOptions,
  generationParameterTextInputValue,
  isMultilineTextParameter,
  normalizeBoundedDurationValue,
} from "./generation-parameter-field";

function parameter(overrides: Record<string, unknown> = {}) {
  return {
    name: "duration",
    label: "时长",
    type: "integer" as const,
    required: false,
    mutuallyExclusiveWith: [],
    ...overrides,
  };
}

describe("video and audio duration parameter options", () => {
  it("filters model-provided options to the guarded 4-60 second range", () => {
    expect(boundedDurationOptions(parameter({ options: [0, 1, 4, 7, 15, 16, 60, 61] }))).toEqual([
      4, 7, 15, 16, 60,
    ]);
  });

  it("accepts numeric strings without changing the model-provided value type", () => {
    expect(
      boundedDurationOptions(
        parameter({
          type: "string",
          options: ["0", "1", "4", "10", "16", "not-a-duration"],
        }),
      ),
    ).toEqual(["4", "10", "16"]);
  });

  it("builds a bounded one-second list when the model has no options", () => {
    expect(boundedDurationOptions(parameter({ min: 4, max: 10 }))).toEqual([4, 5, 6, 7, 8, 9, 10]);
  });

  it("honors fractional steps and the model bounds", () => {
    expect(
      boundedDurationOptions(parameter({ type: "number", min: 4.5, max: 6, step: 0.5 })),
    ).toEqual([4.5, 5, 5.5, 6]);
  });

  it("returns no legal values when the model range does not overlap 4-60", () => {
    expect(boundedDurationOptions(parameter({ min: 61, max: 70 }))).toEqual([]);
  });

  it("leaves unrelated parameters untouched", () => {
    expect(boundedDurationOptions(parameter({ name: "resolution", options: [1, 2] }))).toBeNull();
  });

  it("supports the seconds alias", () => {
    expect(boundedDurationOptions(parameter({ name: "seconds", min: 16, max: 20 }))).toEqual([
      16, 17, 18, 19, 20,
    ]);
  });

  it("exposes the full 4-30 second range for the fixed-price SD2 face model", () => {
    // 目录给该模型声明 min:4, max:30 时，画布必须能选到 30 秒
    // （此前 catalog 停在 max:15，用户因此无法选 16-30 秒）。
    expect(boundedDurationOptions(parameter({ name: "seconds", min: 4, max: 30 }))).toEqual(
      Array.from({ length: 27 }, (_, i) => 4 + i),
    );
  });

  it("renders the canonical video.v1 duration as the model's complete dropdown", () => {
    expect(
      boundedDurationOptions(
        parameter({
          name: "duration_seconds",
          min: 4,
          max: 15,
          options: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        }),
      ),
    ).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it("generates string values for a string duration without model options", () => {
    expect(boundedDurationOptions(parameter({ type: "string", min: 4, max: 6 }))).toEqual([
      "4",
      "5",
      "6",
    ]);
  });

  it("normalizes an illegal default to the first legal model option", () => {
    const duration = parameter({ options: [1, 5, 10] });
    expect(normalizeBoundedDurationValue(duration, 0)).toBe(5);
    expect(normalizeBoundedDurationValue(duration, 1)).toBe(5);
    expect(normalizeBoundedDurationValue(duration, 10)).toBe(10);
  });
});

describe("generation parameter option labels", () => {
  it("renders a fixed scalar such as resolution as a one-value dropdown", () => {
    const resolution = parameter({
      name: "resolution",
      label: "分辨率",
      type: "string",
      fixed: "720p",
    });

    expect(generationParameterScalarOptions(resolution, "720p")).toEqual(["720p"]);
  });

  it("localizes the five image2.5 quality tiers without changing their values", () => {
    const quality = parameter({
      name: "quality",
      label: "质量",
      type: "string",
      options: ["low", "medium", "high", "xhigh", "max"],
    });
    const options = ["low", "medium", "high", "xhigh", "max"];

    expect(
      options.map((option) => ({
        value: JSON.stringify(option),
        label: generationParameterOptionLabel(quality, option),
      })),
    ).toEqual([
      { value: '"low"', label: "低" },
      { value: '"medium"', label: "中" },
      { value: '"high"', label: "高" },
      { value: '"xhigh"', label: "超高" },
      { value: '"max"', label: "最高" },
    ]);
  });

  it("localizes a three-tier quality set as 低/中/高", () => {
    const quality = parameter({
      name: "quality",
      label: "质量",
      type: "string",
      options: ["low", "medium", "high"],
    });

    expect(
      ["low", "medium", "high"].map((option) => generationParameterOptionLabel(quality, option)),
    ).toEqual(["低", "中", "高"]);
  });

  it("keeps unknown quality values and non-quality options unchanged", () => {
    const quality = parameter({ name: "quality", label: "质量", type: "string" });
    const speed = parameter({ name: "speed", label: "速度", type: "string" });

    expect(generationParameterOptionLabel(quality, "cinema")).toBe("cinema");
    expect(generationParameterOptionLabel(speed, "medium")).toBe("medium");
    expect(generationParameterOptionLabel(quality, 2)).toBe("2");
  });

  it("shows Midjourney's numeric quality tiers as bare numbers", () => {
    // Midjourney 的 `quality` 是算力档（0.25/0.5/1/2），不是分辨率档。以前把它写成
    // 「2 高清」，用户会当成 2K 出图开关，与真正的 `hd` 开关混为一谈。
    const quality = parameter({
      name: "quality",
      label: "生成质量",
      type: "string",
      options: ["0.25", "0.5", "1", "2"],
    });

    expect(
      ["0.25", "0.5", "1", "2"].map((option) => generationParameterOptionLabel(quality, option)),
    ).toEqual(["0.25", "0.5", "1", "2"]);
  });

  it("localizes a locked quality text field without changing editable values", () => {
    const fixedQuality = parameter({
      name: "quality",
      label: "质量",
      type: "string",
      fixed: "standard",
    });
    const editableQuality = parameter({ name: "quality", label: "质量", type: "string" });

    expect(generationParameterTextInputValue(fixedQuality, "standard")).toBe("标准");
    expect(generationParameterTextInputValue(editableQuality, "standard")).toBe("standard");
  });
});

describe("long text parameter fields", () => {
  it("renders a negative prompt as a multi-line field", () => {
    expect(
      isMultilineTextParameter(
        parameter({ name: "negative_prompt", label: "负向提示词", type: "string" }),
      ),
    ).toBe(true);
  });

  it("renders reference image URL fields as multi-line fields", () => {
    expect(
      isMultilineTextParameter(
        parameter({ name: "cref", label: "角色参考图 URL", type: "string" }),
      ),
    ).toBe(true);
    expect(
      isMultilineTextParameter(
        parameter({ name: "style_reference", label: "风格参考图 URL", type: "string" }),
      ),
    ).toBe(true);
  });

  it("keeps short scalar and option fields single-line", () => {
    expect(
      isMultilineTextParameter(parameter({ name: "seed", label: "随机种子", type: "integer" })),
    ).toBe(false);
    expect(
      isMultilineTextParameter(parameter({ name: "iw", label: "参考图权重", type: "number" })),
    ).toBe(false);
    expect(
      isMultilineTextParameter(
        parameter({ name: "quality", label: "画质", type: "string", options: ["1", "2"] }),
      ),
    ).toBe(false);
    expect(
      isMultilineTextParameter(
        parameter({ name: "size", label: "画面比例", type: "string", options: ["1:1"] }),
      ),
    ).toBe(false);
  });

  it("keeps locked text fields read-only instead of turning them into editors", () => {
    expect(
      isMultilineTextParameter(
        parameter({ name: "negative_prompt", label: "负向提示词", type: "string", fixed: "" }),
      ),
    ).toBe(false);
  });
});
