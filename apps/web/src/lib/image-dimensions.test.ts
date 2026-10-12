import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { readBlobImageDimensions, readImageHeaderDimensions } from "./image-dimensions";

// 尺寸取自浏览器 createImageBitmap 的实测结果，作为头部解析的交叉校验基准。
const REAL_FIXTURES = [
  { file: "product-canvas-wide.jpg", width: 3102, height: 1685 },
  { file: "product-canvas.jpg", width: 1600, height: 1000 },
  { file: "canvas-water-surface.jpg", width: 1920, height: 1200 },
  { file: "canvas-grain.png", width: 192, height: 192 },
  { file: "resource-library-mark.png", width: 128, height: 128 },
] as const;

function asciiBytes(value: string) {
  return [...value].map((character) => character.charCodeAt(0));
}

/** 最小的无损 WebP：RIFF/WEBP + VP8L chunk，宽高各存 14 位。 */
function webpLosslessBytes(width: number, height: number) {
  const bits = (width - 1) | ((height - 1) << 14);
  return new Uint8Array([
    ...asciiBytes("RIFF"),
    0x1a,
    0x00,
    0x00,
    0x00,
    ...asciiBytes("WEBP"),
    ...asciiBytes("VP8L"),
    0x0e,
    0x00,
    0x00,
    0x00,
    0x2f,
    bits & 0xff,
    (bits >> 8) & 0xff,
    (bits >> 16) & 0xff,
    (bits >> 24) & 0xff,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
  ]);
}

function gifBytes(width: number, height: number) {
  return new Uint8Array([
    ...asciiBytes("GIF89a"),
    width & 0xff,
    (width >> 8) & 0xff,
    height & 0xff,
    (height >> 8) & 0xff,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
  ]);
}

describe("image dimensions", () => {
  it.each(REAL_FIXTURES)(
    "reads $file header without a full decode",
    async ({ file, width, height }) => {
      const bytes = new Uint8Array(readFileSync(new URL(`../assets/${file}`, import.meta.url)));
      expect(readImageHeaderDimensions(bytes)).toEqual({ width, height });
      expect(await readBlobImageDimensions(new Blob([bytes]))).toEqual({ width, height });
    },
  );

  it("reads lossless webp and gif containers", () => {
    expect(readImageHeaderDimensions(webpLosslessBytes(16, 16))).toEqual({ width: 16, height: 16 });
    expect(readImageHeaderDimensions(webpLosslessBytes(1600, 900))).toEqual({
      width: 1600,
      height: 900,
    });
    expect(readImageHeaderDimensions(gifBytes(32, 16))).toEqual({ width: 32, height: 16 });
  });

  it("returns null when the header cannot be trusted", async () => {
    // 调用方依赖 null 回退到完整解码，绝不能返回错误尺寸。
    expect(readImageHeaderDimensions(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(readImageHeaderDimensions(new Uint8Array(0))).toBeNull();
    expect(await readBlobImageDimensions(new Blob([]))).toBeNull();
    // 截断的 PNG：签名有效但宽高不完整。
    expect(readImageHeaderDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });
});
