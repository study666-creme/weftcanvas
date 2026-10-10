import { describe, expect, it } from "vitest";

import { getZoomDotGridMetrics } from "./canvas-background";

describe("zoom-responsive canvas dot grid", () => {
  it("tracks canvas zoom using a stable world-space rhythm", () => {
    expect(getZoomDotGridMetrics({ x: 0, y: 0, zoom: 0.33 })).toEqual({
      size: 15.84,
      halfSize: 7.92,
      x: 0,
      y: 0,
    });
    expect(getZoomDotGridMetrics({ x: 0, y: 0, zoom: 2.98 }).size).toBe(143.04);
  });

  it("bounds extreme densities and keeps negative pan offsets aligned", () => {
    expect(getZoomDotGridMetrics({ x: -17, y: 13, zoom: 0.1 })).toEqual({
      size: 8,
      halfSize: 4,
      x: 7,
      y: 5,
    });
    expect(getZoomDotGridMetrics({ x: 0, y: 0, zoom: 20 }).size).toBe(192);
  });
});
