import { describe, expect, it } from "vitest";

import { inferCanvasFileKind, layoutCanvasIngestDrafts } from "./canvas-ingest";

describe("canvas ingest", () => {
  it("classifies supported media and text without accepting arbitrary files", async () => {
    expect(await inferCanvasFileKind(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "frame.png", { type: "image/png" }))).toBe("image");
    expect(await inferCanvasFileKind(new File([new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])], "scene.mp4", { type: "video/mp4" }))).toBe("video");
    expect(await inferCanvasFileKind(new File(["hello"], "dialogue.md", { type: "" }))).toBe("text");
    expect(await inferCanvasFileKind(new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "archive.zip", { type: "application/zip" }))).toBeNull();
  });

  it("recovers files with an empty MIME type via extension or magic bytes", async () => {
    // 下载图片常见 MIME 为空：扩展名认识 → image
    expect(await inferCanvasFileKind(new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "photo.png", { type: "" }))).toBe("image");
    // 扩展名也生僻：文件头魔数兜底（PNG / JPEG）
    expect(await inferCanvasFileKind(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])], "frame.bin", { type: "" }))).toBe("image");
    expect(await inferCanvasFileKind(new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "photo.dat", { type: "" }))).toBe("image");
    // 魔数与扩展名都救不回来的仍然拒绝
    expect(await inferCanvasFileKind(new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "archive.unknown", { type: "" }))).toBeNull();
  });

  it("centers one item and lays batches out without overlap", () => {
    const single = layoutCanvasIngestDrafts([{ kind: "text" }], { x: 500, y: 400 });
    expect(single[0]!.position).toEqual({ x: 346, y: 312 });

    const batch = layoutCanvasIngestDrafts([
      { kind: "text" },
      { kind: "image" },
      { kind: "video" },
      { kind: "audio" },
    ], { x: 700, y: 500 });
    expect(batch).toHaveLength(4);
    expect(batch[1]!.position.x).toBeGreaterThan(batch[0]!.position.x + 308);
    expect(batch[3]!.position.y).toBeGreaterThan(batch[0]!.position.y + 176);
  });

  it("uses the selected default aspect ratio when positioning newly imported media", () => {
    const landscape = layoutCanvasIngestDrafts([{ kind: "image" }], { x: 500, y: 400 }, "16:9");
    const portrait = layoutCanvasIngestDrafts([{ kind: "image" }], { x: 500, y: 400 }, "9:16");

    expect(landscape[0]!.position).toEqual({ x: 330, y: 304.5 });
    expect(portrait[0]!.position).toEqual({ x: 404.5, y: 230 });
  });

  it("lays imported drafts out at stable intrinsic sizes independent of the canvas zoom", () => {
    const landscape = layoutCanvasIngestDrafts([
      { kind: "image" },
      { kind: "video" },
    ], { x: 500, y: 400 }, "16:9");

    expect(landscape).toHaveLength(2);
    expect(landscape[0]!.position).toEqual({ x: 143, y: 304.5 });
    expect(landscape[1]!.position).toEqual({ x: 517, y: 304.5 });
    expect(landscape[1]!.position.x - landscape[0]!.position.x).toBeGreaterThanOrEqual(340 + 34);
  });
});
