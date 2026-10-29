import type { ModelParameter } from "@weftcanvas/contracts";
import { describe, expect, it } from "vitest";

import { INLINE_CHIP_OPTION_LIMIT, supportsInlineOptionChips } from "./parameter-chips";

function parameter(overrides: Partial<ModelParameter> = {}): ModelParameter {
  return {
    name: "voice",
    label: "音色",
    type: "string",
    required: false,
    mutuallyExclusiveWith: [],
    ...overrides,
  };
}

describe("parameter chips", () => {
  it("keeps short enums inline", () => {
    expect(
      supportsInlineOptionChips(
        parameter({ options: Array.from({ length: INLINE_CHIP_OPTION_LIMIT }, (_, i) => `v${i}`) }),
        undefined,
      ),
    ).toBe(true);
  });

  it("keeps the 16-way aspect ratio inline instead of hiding it in a dropdown", () => {
    const ratios = [
      "1:1",
      "16:9",
      "9:16",
      "4:3",
      "3:4",
      "3:2",
      "2:3",
      "21:9",
      "9:21",
      "1:2",
      "2:1",
      "5:4",
      "4:5",
      "7:4",
      "4:7",
      "auto",
    ];
    expect(
      supportsInlineOptionChips(
        parameter({ name: "aspect_ratio", label: "比例", options: ratios }),
        undefined,
      ),
    ).toBe(true);
  });

  it("falls back to a dropdown for long enums such as the 30 TTS voices", () => {
    expect(
      supportsInlineOptionChips(
        parameter({
          type: "object",
          options: Array.from({ length: INLINE_CHIP_OPTION_LIMIT + 1 }, (_, i) => `voice-${i}`),
        }),
        undefined,
      ),
    ).toBe(false);
  });

  it("falls back to a dropdown when the labels themselves are long", () => {
    expect(
      supportsInlineOptionChips(
        parameter({
          options: ["prebuilt-voice-alpha", "prebuilt-voice-beta", "prebuilt-voice-gamma"],
        }),
        undefined,
      ),
    ).toBe(false);
  });

  it("does not claim parameters that need a free-form field", () => {
    expect(supportsInlineOptionChips(parameter({ type: "string" }), undefined)).toBe(false);
  });
});
