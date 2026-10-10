import { describe, expect, it } from "vitest";

import { getStarfieldLayerPresentation, getStarfieldMetrics } from "./canvas-starfield";

describe("depth-aware canvas starfield", () => {
  it("keeps distant stars denser than foreground stars", () => {
    const metrics = getStarfieldMetrics({ x: 0, y: 0, zoom: 1 });

    expect(metrics.far.size).toBeLessThan(metrics.mid.size);
    expect(metrics.mid.size).toBeLessThan(metrics.near.size);
  });

  it("moves near stars faster to preserve parallax depth", () => {
    const origin = getStarfieldMetrics({ x: 0, y: 0, zoom: 1 });
    const moved = getStarfieldMetrics({ x: 40, y: 30, zoom: 1 });

    expect(moved.far.x - origin.far.x).toBeLessThan(moved.mid.x - origin.mid.x);
    expect(moved.mid.x - origin.mid.x).toBeLessThan(moved.near.x - origin.near.x);
    expect(moved.far.y - origin.far.y).toBeLessThan(moved.near.y - origin.near.y);
  });

  it("expresses pan as compositor transforms instead of painted background offsets", () => {
    const metrics = getStarfieldMetrics({ x: 40, y: 30, zoom: 1 });

    expect(getStarfieldLayerPresentation(metrics.far)).toEqual({
      transform: "translate3d(4.8px, 3.6px, 0)",
    });
    expect(getStarfieldLayerPresentation(metrics.near)).toEqual({
      transform: "translate3d(24.8px, 18.6px, 0)",
    });
  });

  it("keeps texture periods fixed across zoom and centers wrapped pan offsets", () => {
    const zoomedOut = getStarfieldMetrics({ x: -31, y: -17, zoom: 0.01 });
    const zoomedIn = getStarfieldMetrics({ x: 0, y: 0, zoom: 20 });

    expect(zoomedOut.far.size).toBe(173);
    expect(zoomedOut.near.size).toBe(487);
    expect(Math.abs(zoomedOut.far.x)).toBeLessThanOrEqual(zoomedOut.far.size / 2);
    expect(Math.abs(zoomedOut.near.y)).toBeLessThanOrEqual(zoomedOut.near.size / 2);
    expect(zoomedIn.far.size).toBe(173);
    expect(zoomedIn.near.size).toBe(487);
    expect(getStarfieldLayerPresentation(zoomedIn.near)).toEqual({ transform: "translate3d(0px, 0px, 0)" });
  });
});
