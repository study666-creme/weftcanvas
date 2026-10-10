import { describe, expect, it } from "vitest";

import { getWaterMaterialTransform, getWaterSurfaceOffset } from "./canvas-water-surface";

describe("optimized canvas water surface", () => {
  it("starts the material at the viewport origin", () => {
    expect(getWaterSurfaceOffset({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });

  it("moves continuously with canvas pans", () => {
    const origin = getWaterSurfaceOffset({ x: 0, y: 0 });
    const moved = getWaterSurfaceOffset({ x: 60, y: 40 });

    expect(moved.x).toBeGreaterThan(origin.x);
    expect(moved.y).toBeGreaterThan(origin.y);
  });

  it("expresses pan as compositor transforms", () => {
    const offset = getWaterSurfaceOffset({ x: 60, y: 40 });

    expect(getWaterMaterialTransform(offset)).toBe("translate3d(5.284px, 2.434px, 0)");
  });

  it("bounds large pans within the material overscan", () => {
    const nearby = getWaterSurfaceOffset({ x: -31, y: -17 });
    const farAway = getWaterSurfaceOffset({ x: -100_000, y: -100_000 });

    expect(nearby.x).toBeLessThan(0);
    expect(nearby.y).toBeLessThan(0);
    expect(Math.abs(farAway.x)).toBeLessThanOrEqual(32);
    expect(Math.abs(farAway.y)).toBeLessThanOrEqual(22);
  });

  it("keeps small pans responsive when a saved viewport starts far from zero", () => {
    const origin = { x: 12_000, y: -8_000 };
    const moved = getWaterSurfaceOffset({ x: 12_060, y: -7_960 }, origin);

    expect(moved).toEqual(getWaterSurfaceOffset({ x: 60, y: 40 }));
  });
});
