import { describe, expect, it } from "vitest";

import { thumbLodLevelForZoom } from "./local-media-thumb";

describe("local media thumb LOD ladder", () => {
  it("keeps level 1 across the normal working zoom range", () => {
    for (const zoom of [0.45, 0.5, 0.7, 1, 1.5, 2.5]) {
      expect(thumbLodLevelForZoom(zoom)).toBe(1);
    }
  });

  it("steps down as the canvas zooms out", () => {
    expect(thumbLodLevelForZoom(0.44)).toBe(2);
    expect(thumbLodLevelForZoom(0.23)).toBe(2);
    expect(thumbLodLevelForZoom(0.22)).toBe(2);
    expect(thumbLodLevelForZoom(0.21)).toBe(3);
    expect(thumbLodLevelForZoom(0.1)).toBe(3);
  });

  it("treats non-finite zoom as the most detailed level", () => {
    expect(thumbLodLevelForZoom(Number.NaN)).toBe(1);
    expect(thumbLodLevelForZoom(0)).toBe(3);
  });
});
