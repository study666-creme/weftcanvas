import { describe, expect, it } from "vitest";

import { h3Resolution, h3SuperResolutionRequiresImage, isMinimaxH3Model } from "./minimax-h3.js";

describe("MiniMax H3 capability helpers", () => {
  it("recognizes public H3 id variants without matching other MiniMax models", () => {
    expect(
      ["minimax_h3", "MiniMax-H3-量化版", "MiniMax H3 漫剧优化", "MiniMaxH3"].every((id) =>
        isMinimaxH3Model(id),
      ),
    ).toBe(true);
    expect(isMinimaxH3Model("minimax_h2")).toBe(false);
  });

  it("normalizes super-resolution labels from both public aliases", () => {
    expect(h3Resolution({ resolution: "2K" })).toBe("2K");
    expect(h3Resolution({ size: "4k" })).toBe("4K");
    expect(h3Resolution({ resolution: "1080p" })).toBeUndefined();
    expect(h3SuperResolutionRequiresImage("minimax_h3", { resolution: "4K" })).toBe(true);
  });
});
