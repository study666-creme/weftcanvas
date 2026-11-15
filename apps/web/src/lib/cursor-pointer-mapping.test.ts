import { describe, expect, it } from "vitest";

import {
  isFramedDocument,
  localPointerFromScreen,
  screenToClientOffset,
} from "./cursor-pointer-mapping";

// 实测数据：iframe 在父页中的原点是 (260,56)，页面点 (700,300) 对应帧内
// client 坐标 (440,244)；同一物理位置下 pointerrawupdate 给的是 (700,300)，
// 而两种事件的 screen 坐标一致。
const IFRAME_ORIGIN = { x: 260, y: 56 };
const PAGE_POINT = { x: 700, y: 300 };
const LOCAL_POINT = { x: 440, y: 244 };

describe("cursor pointer mapping", () => {
  const windowLike = (self: unknown, top: unknown) =>
    ({ self, top }) as Pick<Window, "self" | "top">;

  it("treats a top-level document as not framed", () => {
    const self = {};
    expect(isFramedDocument(windowLike(self, self))).toBe(false);
  });

  it("treats a nested document as framed", () => {
    expect(isFramedDocument(windowLike({}, {}))).toBe(true);
  });

  it("assumes framed when reading top throws", () => {
    const win = { self: {} };
    Object.defineProperty(win, "top", {
      get() {
        throw new Error("cross-origin");
      },
    });
    expect(isFramedDocument(win as unknown as Pick<Window, "self" | "top">)).toBe(true);
  });

  it("learns the screen-to-client offset from a localized event", () => {
    expect(
      screenToClientOffset({
        screenX: PAGE_POINT.x,
        screenY: PAGE_POINT.y,
        clientX: LOCAL_POINT.x,
        clientY: LOCAL_POINT.y,
      }),
    ).toEqual(IFRAME_ORIGIN);
  });

  it("rejects non-finite offsets", () => {
    expect(screenToClientOffset({ screenX: NaN, screenY: 0, clientX: 0, clientY: 0 })).toBeNull();
  });

  // 这条是回归钉：跨源 iframe 里 raw 坐标不带本地化，折回后必须等于真实帧内坐标。
  it("folds a raw screen position back into frame coordinates", () => {
    expect(
      localPointerFromScreen({ screenX: PAGE_POINT.x, screenY: PAGE_POINT.y }, IFRAME_ORIGIN),
    ).toEqual(LOCAL_POINT);
  });

  it("keeps fractional coordinates exact", () => {
    const offset = { x: 260, y: 56 };
    expect(localPointerFromScreen({ screenX: 1100.75, screenY: 640.5 }, offset)).toEqual({
      x: 840.75,
      y: 584.5,
    });
  });

  it("returns null until the offset is known", () => {
    expect(localPointerFromScreen({ screenX: 1, screenY: 1 }, null)).toBeNull();
  });
});
