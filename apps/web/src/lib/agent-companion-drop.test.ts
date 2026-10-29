import { describe, expect, it } from "vitest";

import {
  agentLinkRejectionMessage,
  agentLinkVerdict,
  companionLinkableKind,
  dragEventPoint,
  isPointOverElement,
} from "./agent-companion-drop";

function rectElement(left: number, top: number, width: number, height: number) {
  return {
    getBoundingClientRect: () => ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
    }),
  } as Element;
}

describe("companionLinkableKind", () => {
  it("带图片/视频素材的节点可引用", () => {
    expect(
      companionLinkableKind({ id: "a", data: { kind: "image", media: { name: "a.png" } } }),
    ).toBe("image");
    expect(
      companionLinkableKind({ id: "b", data: { kind: "video", media: { name: "b.mp4" } } }),
    ).toBe("video");
  });

  it("没有素材或非图片视频节点返回 null", () => {
    expect(companionLinkableKind({ id: "c", data: { kind: "image", media: null } })).toBeNull();
    expect(
      companionLinkableKind({ id: "d", data: { kind: "text", media: { name: "t" } } }),
    ).toBeNull();
  });
});

describe("dragEventPoint", () => {
  it("鼠标事件直接取 clientX/Y", () => {
    expect(dragEventPoint({ clientX: 12, clientY: 34 } as MouseEvent)).toEqual({ x: 12, y: 34 });
  });

  it("触屏事件取 changedTouches 首点", () => {
    const touch = { clientX: 5, clientY: 6 };
    expect(dragEventPoint({ changedTouches: [touch] } as unknown as TouchEvent)).toEqual({
      x: 5,
      y: 6,
    });
  });
});

describe("isPointOverElement", () => {
  it("点在包围盒内为真，元素缺失为假", () => {
    const element = rectElement(10, 20, 100, 100);
    expect(isPointOverElement(50, 60, element)).toBe(true);
    expect(isPointOverElement(9, 60, element)).toBe(false);
    expect(isPointOverElement(50, 121, element)).toBe(false);
    expect(isPointOverElement(50, 60, null)).toBe(false);
  });

  it("padding 把命中区向外扩一圈", () => {
    const port = rectElement(100, 100, 44, 44);
    expect(isPointOverElement(90, 120, port)).toBe(false);
    expect(isPointOverElement(90, 120, port, 14)).toBe(true);
    expect(isPointOverElement(158, 158, port, 14)).toBe(true);
    expect(isPointOverElement(159, 120, port, 14)).toBe(false);
  });

  it("没有尺寸的元素（display:none）永远不命中", () => {
    expect(isPointOverElement(0, 0, rectElement(0, 0, 0, 0), 20)).toBe(false);
  });
});

describe("agentLinkVerdict", () => {
  const image = { id: "img", data: { kind: "image", media: { name: "a.png" } } };

  it("带素材、未引用、未满时可引用并报出类型", () => {
    expect(agentLinkVerdict(image, [], 8)).toEqual({ ok: true, kind: "image" });
  });

  it("按 缺失 → 类型 → 已引用 → 已满 的顺序给出拒绝原因", () => {
    expect(agentLinkVerdict(undefined, [], 8)).toEqual({ ok: false, reason: "missing" });
    expect(agentLinkVerdict({ id: "t", data: { kind: "text", media: null } }, [], 8)).toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(agentLinkVerdict(image, ["img"], 1)).toEqual({ ok: false, reason: "linked" });
    expect(agentLinkVerdict(image, ["a", "b"], 2)).toEqual({ ok: false, reason: "full" });
  });

  it("每种拒绝都有能直接给用户看的说明", () => {
    expect(agentLinkRejectionMessage("unsupported", 8)).toContain("图片或视频");
    expect(agentLinkRejectionMessage("linked", 8)).toContain("已经引用");
    expect(agentLinkRejectionMessage("full", 8)).toBe("最多引用 8 个素材节点");
    expect(agentLinkRejectionMessage("missing", 8)).toContain("不在画布");
  });
});
