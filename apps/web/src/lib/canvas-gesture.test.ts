import { describe, expect, it } from "vitest";

import { classListIsMoving, type ClassListLike } from "./canvas-gesture";

/** 用最小的类名集合替身覆盖手势判定，无需真实 DOM。 */
function classList(names: string[]): ClassListLike {
  const set = new Set(names);
  return { contains: (name) => set.has(name) };
}

describe("workspace gesture detection", () => {
  it("reports moving for either pan gesture class", () => {
    expect(classListIsMoving(classList([]))).toBe(false);
    expect(classListIsMoving(classList(["is-viewport-moving"]))).toBe(true);
    expect(classListIsMoving(classList(["is-space-pan"]))).toBe(true);
    expect(classListIsMoving(classList(["is-viewport-moving", "is-space-pan"]))).toBe(true);
  });

  it("ignores unrelated workspace classes", () => {
    expect(classListIsMoving(classList(["kc-workspace", "is-dense", "is-agent-open"]))).toBe(false);
  });

  it("treats a missing workspace as not moving", () => {
    expect(classListIsMoving(null)).toBe(false);
    expect(classListIsMoving(undefined)).toBe(false);
  });
});

/**
 * 回归：手势期间背景层跳过重画是刻意的性能取舍，但手势结束不会再有 transform
 * 事件，所以必须由手势结束本身补画一次。这里钉住「还在别的持续手势里时不补画」
 * 这条判定——否则补画会撞上手势，退化成原来的抢帧问题。
 */
describe("gesture settle gating", () => {
  it("stays pending while any gesture class remains", () => {
    const stillPanning = classList(["is-space-pan"]);
    expect(classListIsMoving(stillPanning)).toBe(true);

    const settled = classList([]);
    expect(classListIsMoving(settled)).toBe(false);
  });
});
