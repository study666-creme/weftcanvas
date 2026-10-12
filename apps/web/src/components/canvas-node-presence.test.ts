import { describe, expect, it } from "vitest";

import {
  expandRect,
  nodeIntersectsRect,
  nodeStaysVisible,
  rectContainsRect,
  viewportRectFromTransform,
} from "./canvas-node-presence";

describe("canvas node presence culling", () => {
  it("converts the viewport transform into a flow-space rect", () => {
    // 视口 1440x900，zoom 1，平移 (100, 50)：flow 坐标下可见区起点是
    // (-100, -50)，尺寸随 zoom 缩放。
    expect(viewportRectFromTransform(1440, 900, [100, 50, 1])).toEqual({
      x: -100,
      y: -50,
      width: 1440,
      height: 900,
    });
    const zoomed = viewportRectFromTransform(1440, 900, [0, 0, 0.5])!;
    expect(zoomed.width).toBe(2880);
    expect(zoomed.height).toBe(1800);
    // -0 与 0 语义等价：加 0 归一化避免 toEqual 的 -0 陷阱。
    expect(zoomed.x + 0).toBe(0);
    expect(zoomed.y + 0).toBe(0);
    expect(viewportRectFromTransform(0, 900, [0, 0, 1])).toBeNull();
    expect(viewportRectFromTransform(1440, 900, [0, 0, 0])).toBeNull();
  });

  it("expands the rect by the culling margin on all sides", () => {
    expect(expandRect({ x: 0, y: 0, width: 100, height: 100 }, 320)).toEqual({
      x: -320,
      y: -320,
      width: 740,
      height: 740,
    });
  });

  it("detects containment for the hysteresis fast path", () => {
    const outer = expandRect({ x: 0, y: 0, width: 1000, height: 600 }, 320);
    // 平移后视口仍在上次余量矩形内：可见集必然不变，跳过重算。
    expect(rectContainsRect(outer, { x: 100, y: 50, width: 800, height: 500 })).toBe(true);
    // 逃出半余量区（右边越界）：必须重算。
    expect(rectContainsRect(outer, { x: 900, y: 0, width: 800, height: 500 })).toBe(false);
    // 逃出半余量区（下边越界）。
    expect(rectContainsRect(outer, { x: 0, y: 700, width: 500, height: 500 })).toBe(false);
  });

  it("counts partial overlap as visible (nodes straddling the edge stay mounted)", () => {
    const cull = expandRect({ x: 0, y: 0, width: 1440, height: 900 }, 320);
    const node = { positionAbsoluteX: 1750, positionAbsoluteY: 100, width: 340, height: 214 };
    // 1750 在余量右边界 1760 之内，只露出一条也算可见。
    expect(nodeIntersectsRect(node, cull)).toBe(true);
    expect(nodeIntersectsRect({ ...node, positionAbsoluteX: 1800 }, cull)).toBe(false);
    expect(nodeIntersectsRect({ ...node, positionAbsoluteY: 1300 }, cull)).toBe(false);
  });

  it("keeps an unmeasured off-screen node visible so React Flow can read its handles", () => {
    const cull = expandRect({ x: 0, y: 0, width: 1440, height: 900 }, 320);
    const far = { x: 4000, y: 100 };
    // 首次测量前就隐藏会让 handleBounds 永远为空，连线锚点塌陷到 (0,0)。
    expect(nodeStaysVisible({ measured: null, position: far }, cull)).toBe(true);
    expect(nodeStaysVisible({ measured: { width: 0, height: 0 }, position: far }, cull)).toBe(true);
    // 量过一次之后就按余量视口正常裁剪。
    expect(nodeStaysVisible({ measured: { width: 340, height: 214 }, position: far }, cull)).toBe(
      false,
    );
    expect(
      nodeStaysVisible({ measured: { width: 340, height: 214 }, position: { x: 40, y: 40 } }, cull),
    ).toBe(true);
    // 选中/拖拽中的节点永远可见。
    expect(
      nodeStaysVisible(
        { selected: true, measured: { width: 340, height: 214 }, position: far },
        cull,
      ),
    ).toBe(true);
    expect(
      nodeStaysVisible(
        { dragging: true, measured: { width: 340, height: 214 }, position: far },
        cull,
      ),
    ).toBe(true);
  });
});
