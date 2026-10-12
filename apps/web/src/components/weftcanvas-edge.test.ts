import { getBezierPath, Position } from "@xyflow/react";
import { describe, expect, it } from "vitest";

import { getWeftcanvasEdgePath } from "./weftcanvas-edge";

const horizontalConnection = {
  sourceX: 0,
  sourceY: 40,
  targetX: 400,
  targetY: 40,
  sourcePosition: Position.Right,
  targetPosition: Position.Left,
};

describe("Weftcanvas edge paths", () => {
  it("keeps the established taut curve available", () => {
    const geometry = getWeftcanvasEdgePath(horizontalConnection, "taut");

    expect(geometry.path).toMatch(/^M/);
    expect(geometry.path).toContain("C");
    expect(geometry.focusX).toBe(200);
    expect(geometry.focusY).toBe(40);
  });

  it("uses one LibTV-style cubic without forcing a vertical sag", () => {
    const geometry = getWeftcanvasEdgePath(horizontalConnection, "gravity");

    expect(geometry.path).toMatch(/^M/);
    expect(geometry.path.match(/C/g)).toHaveLength(1);
    expect(geometry.focusX).toBe(200);
    expect(geometry.focusY).toBe(40);
  });

  it("keeps same-height soft curves on their baseline at every length", () => {
    const short = getWeftcanvasEdgePath({ ...horizontalConnection, targetX: 48 }, "gravity");
    const long = getWeftcanvasEdgePath({ ...horizontalConnection, targetX: 4_000 }, "gravity");

    expect(short.focusY).toBe(horizontalConnection.sourceY);
    expect(long.focusY).toBe(horizontalConnection.sourceY);
    expect(short.path.match(/C/g)).toHaveLength(1);
    expect(long.path.match(/C/g)).toHaveLength(1);
  });

  it("keeps an offset soft curve continuous between differently placed ports", () => {
    const input = {
      ...horizontalConnection,
      targetY: 240,
      targetPosition: Position.Top,
    };
    const geometry = getWeftcanvasEdgePath(input, "gravity");
    const [libtvPath, libtvFocusX, libtvFocusY] = getBezierPath(input);

    expect(geometry).toEqual({ path: libtvPath, focusX: libtvFocusX, focusY: libtvFocusY });
    expect(geometry.path.match(/C/g)).toHaveLength(1);
    expect(geometry.focusX).toBeGreaterThan(horizontalConnection.sourceX);
    expect(geometry.focusX).toBeLessThan(horizontalConnection.targetX);
    expect(geometry.focusY).toBeGreaterThan(horizontalConnection.sourceY);
    expect(geometry.focusY).toBeLessThan(240);
  });

  it("shares the same focus when the path is traversed from the target", () => {
    const forward = getWeftcanvasEdgePath(horizontalConnection, "gravity");
    const reverse = getWeftcanvasEdgePath(
      {
        sourceX: horizontalConnection.targetX,
        sourceY: horizontalConnection.targetY,
        targetX: horizontalConnection.sourceX,
        targetY: horizontalConnection.sourceY,
        sourcePosition: horizontalConnection.targetPosition,
        targetPosition: horizontalConnection.sourcePosition,
      },
      "gravity",
    );

    expect(reverse.focusX).toBe(forward.focusX);
    expect(reverse.focusY).toBe(forward.focusY);
    expect(reverse.path).toMatch(/^M400,40 C/);
    expect(reverse.path).toMatch(/0,40$/);
  });
});
