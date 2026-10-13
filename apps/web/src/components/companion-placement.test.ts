import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveCompanionPlacement, type Placement, type Rect } from "./companion-placement";

const SIZE = { width: 80, height: 90 };
const BOUNDS: Rect = { left: 0, top: 0, right: 1440, bottom: 900, width: 1440, height: 900 };

function fakeElement(rect: Partial<Rect> & { width: number; height: number }) {
  return {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: rect.width,
      bottom: rect.height,
      ...rect,
    }),
    checkVisibility: () => true,
    dataset: {},
    style: {},
    matches: () => false,
    parentElement: null,
  } as unknown as Element;
}

function withDocument(selectors: Record<string, Element | null>) {
  vi.stubGlobal("document", {
    querySelector: (selector: string) => selectors[selector] ?? null,
  });
  vi.stubGlobal("window", {
    innerWidth: 1440,
    innerHeight: 900,
    getComputedStyle: () => ({ zIndex: "40" }),
  });
}

beforeEach(() => {
  withDocument({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveCompanionPlacement dock fallbacks", () => {
  it("perches on the top edge of a mid-screen panel", () => {
    withDocument({ ".wc-edit-dock": fakeElement({ left: 400, top: 780, width: 400, height: 60 }) });
    const placement = resolveCompanionPlacement(
      { kind: "dock", dock: "edit-dock", x: 0.5 },
      SIZE,
      BOUNDS,
    ) as Placement;
    // 顶边趴法：她的顶边在面板顶缘之上（露出 66% 身高）。
    expect(placement.dock).toBe("edit-dock");
    expect(placement.hang).toBeUndefined();
    expect(placement.ledge?.y).toBe(780);
    expect(placement.y).toBeLessThan(780);
  });

  it("hangs below a top-edge panel that has no room above it", () => {
    // 顶栏贴着屏幕顶部：上方放不下她 → 挂到下沿。
    withDocument({ ".wc-topbar": fakeElement({ left: 20, top: 24, width: 360, height: 56 }) });
    const placement = resolveCompanionPlacement(
      { kind: "dock", dock: "topbar", x: 0.5 },
      SIZE,
      BOUNDS,
    ) as Placement;
    expect(placement.dock).toBe("topbar");
    expect(placement.hang).toBe(true);
    expect(placement.ledge).toBeUndefined();
    // 她的顶边压进面板底缘（top+height=80）一点，整只落在面板下方。
    expect(placement.y).toBeGreaterThanOrEqual(80 - SIZE.height);
    expect(placement.y).toBeLessThan(80);
    expect(placement.y + SIZE.height).toBeLessThanOrEqual(BOUNDS.height);
  });

  it("falls back to null when the docked panel is gone", () => {
    withDocument({ ".wc-topbar": null });
    expect(
      resolveCompanionPlacement({ kind: "dock", dock: "topbar", x: 0.5 }, SIZE, BOUNDS),
    ).toBeNull();
  });
});

describe("resolveCompanionPlacement node perching", () => {
  function nodeRect(left: number, top: number, width: number, height: number) {
    return fakeElement({ left, top, width, height, right: left + width, bottom: top + height });
  }

  it("sits on the top-right corner of the node", () => {
    withDocument({ '.react-flow__node[data-id="node-1"]': nodeRect(900, 300, 340, 340) });
    const placement = resolveCompanionPlacement(
      { kind: "node", nodeId: "node-1" },
      SIZE,
      BOUNDS,
    ) as Placement;
    expect(placement.onNode).toBe(true);
    expect(placement.dock).toBeUndefined();
    // 中心贴着节点右缘内侧，顶边骑在节点上缘上（露出约一半身高在上方）。
    expect(placement.x).toBeCloseTo(900 + 340 - SIZE.width * 0.18, 1);
    expect(placement.y).toBeCloseTo(300 - SIZE.height * 0.52, 1);
  });

  it("keeps her fully visible when the node hugs the viewport edges", () => {
    withDocument({ '.react-flow__node[data-id="node-2"]': nodeRect(1300, 0, 200, 160) });
    const placement = resolveCompanionPlacement(
      { kind: "node", nodeId: "node-2" },
      SIZE,
      BOUNDS,
    ) as Placement;
    expect(placement.x + SIZE.width / 2).toBeLessThanOrEqual(BOUNDS.width + 6);
    expect(placement.y).toBeGreaterThanOrEqual(4);
  });

  it("falls back to the default spot when the node is gone or off-screen", () => {
    withDocument({ '.react-flow__node[data-id="node-3"]': null });
    expect(resolveCompanionPlacement({ kind: "node", nodeId: "node-3" }, SIZE, BOUNDS)).toBeNull();
  });
});
