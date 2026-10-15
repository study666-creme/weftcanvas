import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DOCK_RIGHT_CORNER_X,
  resolveCompanionPlacement,
  type Placement,
  type Rect,
} from "./companion-placement";
import type { CompanionAnchor } from "../state/ui-preferences-store";

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

describe("resolveCompanionPlacement input box corner", () => {
  it("perches on the top-right corner of the open input box", () => {
    // 输入框（wc-node-prompt-shell）打开时她趴到右上角：中心落在顶边右端，
    // 身体骑在面板上缘之上，层级压到面板之下（下半身被面板盖住）。
    withDocument({
      ".wc-node-prompt-shell": fakeElement({ left: 100, top: 600, width: 1200, height: 300 }),
    });
    const placement = resolveCompanionPlacement(
      { kind: "dock", dock: "node-prompt", x: DOCK_RIGHT_CORNER_X },
      SIZE,
      BOUNDS,
    ) as Placement;
    expect(placement.dock).toBe("node-prompt");
    expect(placement.ledge?.y).toBe(600);
    expect(placement.y).toBeLessThan(600);
    // 右上角：中心贴在面板右侧 6% 一带，而不是趴在正中（600 附近）。
    expect(placement.x).toBeGreaterThan(100 + 1200 * 0.9);
  });

  it("returns to the sky when the input box closes", () => {
    // 输入框关掉后元素不在 DOM 里：解不出停靠点 → null，
    // 她用 CSS 默认位（画布顶部居中）——她平时就该在天上待着。
    withDocument({ ".wc-node-prompt-shell": null });
    expect(
      resolveCompanionPlacement(
        { kind: "dock", dock: "node-prompt", x: DOCK_RIGHT_CORNER_X },
        SIZE,
        BOUNDS,
      ),
    ).toBeNull();
  });

  it("has no node-perching target left (she must never attach to a node)", () => {
    // 用户：「大肥鱼不准挂节点上」。节点锚点已从 CompanionAnchor 里删掉，
    // 这里锁住「画布节点不再是可停靠面」——节点就算在 DOM 里也不产生落点。
    withDocument({
      ".react-flow__node[data-id='node-1']": fakeElement({
        left: 900,
        top: 300,
        width: 340,
        height: 340,
      }),
    });
    const anchor: CompanionAnchor = { kind: "free", x: 400, y: 300 };
    const placement = resolveCompanionPlacement(anchor, SIZE, BOUNDS) as Placement;
    expect(placement.dock).toBeUndefined();
    expect(placement.x).toBe(400);
  });
});
