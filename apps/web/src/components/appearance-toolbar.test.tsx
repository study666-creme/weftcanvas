import { describe, expect, it } from "vitest";

import { listAppearanceOptions } from "../lib/appearance-registry";
import "../lib/builtin-appearance";

describe("generation effect labels", () => {
  it("labels the persisted quiet effect 光环 while keeping the durable value quiet", () => {
    const quiet = listAppearanceOptions("generationEffectStyle").find(
      (effect) => effect.id === "quiet",
    );
    expect(quiet).toMatchObject({ id: "quiet", label: "光环" });
  });

  it("keeps the other effect labels and ids unchanged for backward compatibility", () => {
    expect(
      listAppearanceOptions("generationEffectStyle").map((effect) => [effect.id, effect.label]),
    ).toEqual([
      ["beam", "流光"],
      ["nebula", "星云"],
      ["water", "水镜"],
      ["quiet", "光环"],
    ]);
  });
});

describe("node visual styles", () => {
  it("registers 敛锋 as the sixth node preset and keeps the earlier ids", () => {
    expect(
      listAppearanceOptions("canvasVisualStyle").map((option) => [option.id, option.label]),
    ).toEqual([
      ["airy", "疏朗"],
      ["studio", "无界"],
      ["classic", "经典"],
      ["onyx", "纯黑"],
      ["imax", "巨幕"],
      ["facet", "敛锋"],
    ]);
  });

  it("keeps 敛锋 out of the chrome slot so界面档位仍是五个", () => {
    expect(listAppearanceOptions("chromeVisualStyle").map((option) => option.id)).toEqual([
      "airy",
      "studio",
      "classic",
      "onyx",
    ]);
  });
});
