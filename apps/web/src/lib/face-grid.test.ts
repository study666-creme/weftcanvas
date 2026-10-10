import { describe, expect, it } from "vitest";
import { buildFaceRegion, buildGridLines, expandFaceBox } from "./face-grid";

describe("face grid geometry", () => {
  it("expands a detector box and clamps it to the image", () => {
    expect(expandFaceBox({ x: 10, y: 8, width: 40, height: 30 }, 100, 80, 0.5)).toEqual({
      x: 0,
      y: 0,
      width: 70,
      height: 53,
    });
  });

  it("builds stable ellipse and circle geometry", () => {
    expect(
      buildFaceRegion(
        { x: 20, y: 10, width: 40, height: 60 },
        100,
        100,
        { facePadding: 0, circleScale: 1, rotationRadians: Math.PI / 8 },
      ),
    ).toEqual({
      x: 20,
      y: 10,
      width: 40,
      height: 60,
      centerX: 40,
      centerY: 40,
      radiusX: 20,
      radiusY: 30,
      circleRadius: 30,
      rotationRadians: Math.PI / 8,
    });
  });

  it("creates parallel grid lines that cover the target bounds", () => {
    const lines = buildGridLines({ x: 20, y: 30, width: 100, height: 80 }, 12, 45);
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) {
      const dx = line.x2 - line.x1;
      const dy = line.y2 - line.y1;
      expect(dx).toBeGreaterThan(0);
      expect(dy / dx).toBeCloseTo(1, 8);
    }
  });

  it("keeps malformed geometry finite", () => {
    const region = buildFaceRegion(
      { x: Number.NaN, y: Number.NEGATIVE_INFINITY, width: Number.POSITIVE_INFINITY, height: -10 },
      100,
      100,
    );
    expect(Object.values(region).every(Number.isFinite)).toBe(true);
    expect(region.width).toBe(0);
    expect(region.height).toBe(0);
  });
});
