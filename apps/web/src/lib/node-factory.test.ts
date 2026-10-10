import { describe, expect, it } from "vitest";

import { createCanvasNode, mediaNodeDimensions, nodeCreationDimensions, nodeDefaultDimensions } from "./node-factory";

describe("mediaNodeDimensions", () => {
  it("matches common landscape, portrait, and square media", () => {
    expect(mediaNodeDimensions("image", { width: 1920, height: 1080 })).toEqual({ width: 360, height: 203 });
    expect(mediaNodeDimensions("video", { width: 1920, height: 1080 })).toEqual({ width: 380, height: 214 });
    expect(mediaNodeDimensions("image", { width: 1080, height: 1920 })).toEqual({ width: 219, height: 390 });
    expect(mediaNodeDimensions("video", { width: 1080, height: 1920 })).toEqual({ width: 225, height: 400 });
    expect(mediaNodeDimensions("image", { width: 1024, height: 1024 })).toEqual({ width: 360, height: 360 });
  });

  it("clamps extreme aspect ratios to usable canvas nodes", () => {
    expect(mediaNodeDimensions("image", { width: 4000, height: 500 })).toEqual({ width: 460, height: 180 });
    expect(mediaNodeDimensions("video", { width: 500, height: 4000 })).toEqual({ width: 200, height: 440 });
  });

  it("keeps existing defaults when dimensions are missing or media is not visual", () => {
    expect(mediaNodeDimensions("image", { width: null, height: null })).toEqual({ width: 340, height: 214 });
    expect(mediaNodeDimensions("video", null)).toEqual({ width: 340, height: 192 });
    expect(mediaNodeDimensions("audio", { width: 1920, height: 1080 })).toEqual({ width: 340, height: 164 });
  });

  it("applies the global size preset without changing the media ratio", () => {
    expect(nodeDefaultDimensions("image", "small")).toEqual({ width: 272, height: 171 });
    expect(nodeDefaultDimensions("image", "standard")).toEqual({ width: 340, height: 214 });
    expect(nodeDefaultDimensions("image", "large")).toEqual({ width: 408, height: 257 });
    expect(mediaNodeDimensions("image", { width: 1920, height: 1080 }, "small")).toEqual({ width: 288, height: 162 });
    expect(mediaNodeDimensions("image", { width: 1920, height: 1080 }, "large")).toEqual({ width: 432, height: 244 });
  });

  it("creates empty visual nodes with the selected global aspect ratio", () => {
    expect(nodeDefaultDimensions("image", "16:9")).toEqual({ width: 340, height: 191 });
    expect(nodeDefaultDimensions("video", "9:16")).toEqual({ width: 191, height: 340 });
    expect(nodeDefaultDimensions("image", "1:1")).toEqual({ width: 340, height: 340 });
    expect(nodeDefaultDimensions("image", "4:3")).toEqual({ width: 340, height: 255 });
    expect(nodeDefaultDimensions("video", "3:4")).toEqual({ width: 255, height: 340 });
    expect(nodeDefaultDimensions("text", "9:16")).toEqual({ width: 308, height: 176 });
  });

  it("creates new nodes at the requested default size", () => {
    expect(createCanvasNode("video", { x: 0, y: 0 }, {}, "small")).toMatchObject({ width: 272, height: 154, data: { accent: "blue" } });
    expect(createCanvasNode("video", { x: 0, y: 0 }, {}, "large")).toMatchObject({ width: 408, height: 230 });
  });

  it("creates new visual nodes at the requested default aspect ratio", () => {
    expect(createCanvasNode("image", { x: 0, y: 0 }, {}, "4:3")).toMatchObject({ width: 340, height: 255 });
    expect(createCanvasNode("video", { x: 0, y: 0 }, {}, "3:4")).toMatchObject({ width: 255, height: 340 });
  });

  it("keeps intrinsic node dimensions independent of the creation zoom", () => {
    const image = createCanvasNode("image", { x: 0, y: 0 });
    expect(image).toMatchObject({ width: 340, height: 191 });
    expect(nodeCreationDimensions("image", "16:9")).toEqual({ width: 340, height: 191 });
    expect(nodeCreationDimensions("video", "16:9")).toEqual({ width: 340, height: 191 });
    expect(nodeCreationDimensions("text", "16:9")).toEqual({ width: 308, height: 176 });
    expect(nodeCreationDimensions("image", "9:16")).toEqual({ width: 191, height: 340 });
  });
});
