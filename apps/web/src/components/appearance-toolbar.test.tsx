import { describe, expect, it } from "vitest";

import { generationEffects } from "./appearance-toolbar";

describe("generation effect labels", () => {
  it("labels the persisted quiet effect 光环 while keeping the durable value quiet", () => {
    const quiet = generationEffects.find((effect) => effect.id === "quiet");
    expect(quiet).toEqual({ id: "quiet", label: "光环" });
  });

  it("keeps the other effect labels and ids unchanged for backward compatibility", () => {
    expect(generationEffects.map((effect) => [effect.id, effect.label])).toEqual([
      ["beam", "流光"],
      ["nebula", "星云"],
      ["water", "水镜"],
      ["quiet", "光环"],
    ]);
  });
});
