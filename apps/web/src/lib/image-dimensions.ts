export type ImageDimensions = { width: number; height: number };

/**
 * 直接解析图片容器头部得到像素尺寸，不做完整解码。
 *
 * 画布加载图片时原本为了拿尺寸会 createImageBitmap 完整解码一次并立刻丢弃，
 * 随后 <img> 渲染时浏览器还要再解码一遍——图片一多就是双倍解码开销。解析头部
 * 只需读前若干 KB 再做少量位运算，成本比完整解码低几个数量级。
 *
 * 只覆盖画布实际会遇到的常见格式（PNG / JPEG / WebP / GIF）。解析不了时返回
 * null，由调用方回退到完整解码，不会让任何图片因此失败。
 */
const HEADER_SCAN_BYTES = 65_536;
const JPEG_SCAN_BYTES = HEADER_SCAN_BYTES;

export async function readBlobImageDimensions(blob: Blob): Promise<ImageDimensions | null> {
  if (blob.size === 0) return null;
  try {
    const slice = blob.slice(0, Math.min(blob.size, HEADER_SCAN_BYTES));
    const bytes = new Uint8Array(await slice.arrayBuffer());
    return readPngDimensions(bytes)
      ?? readGifDimensions(bytes)
      ?? readWebpDimensions(bytes)
      ?? readJpegDimensions(bytes);
  } catch {
    // Restricted or detached blobs fall back to a real decode.
    return null;
  }
}

export function readImageHeaderDimensions(bytes: Uint8Array): ImageDimensions | null {
  return readPngDimensions(bytes)
    ?? readGifDimensions(bytes)
    ?? readWebpDimensions(bytes)
    ?? readJpegDimensions(bytes);
}

function readPngDimensions(bytes: Uint8Array): ImageDimensions | null {
  // 8 字节签名 + 4 字节长度 + "IHDR" + 宽高各 4 字节。
  if (bytes.length < 24) return null;
  if (!matches(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return null;
  if (!asciiEquals(bytes, 12, "IHDR")) return null;
  return { width: readUint32BE(bytes, 16), height: readUint32BE(bytes, 20) };
}

function readGifDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 10) return null;
  if (!asciiEquals(bytes, 0, "GIF")) return null;
  return { width: readUint16LE(bytes, 6), height: readUint16LE(bytes, 8) };
}

function readWebpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 30) return null;
  if (!asciiEquals(bytes, 0, "RIFF") || !asciiEquals(bytes, 8, "WEBP")) return null;

  const fourCC = ascii(bytes, 12, 16);
  if (fourCC === "VP8 ") {
    // 有损：chunk data 从 20 开始，3 字节帧头 + 3 字节起始码，之后是宽高（低 14 位有效）。
    return { width: readUint16LE(bytes, 26) & 0x3fff, height: readUint16LE(bytes, 28) & 0x3fff };
  }
  if (fourCC === "VP8L") {
    // 无损：data[20] 是 0x2f 签名，接着是 14 位 width-1 与 14 位 height-1（低位在前）。
    if (bytes[20] !== 0x2f) return null;
    const bits = readUint32LE(bytes, 21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height };
  }
  if (fourCC === "VP8X") {
    // 扩展：24 起 3 字节 canvas width-1，27 起 3 字节 canvas height-1。
    return { width: readUint24LE(bytes, 24) + 1, height: readUint24LE(bytes, 27) + 1 };
  }
  return null;
}

function readJpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4) return null;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let offset = 2;
  const limit = Math.min(bytes.length, JPEG_SCAN_BYTES);
  while (offset + 9 < limit) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    if (isStartOfFrameMarker(marker)) {
      // 段内布局：FF + marker + 2 字节长度 + 1 字节精度 + 2 字节高 + 2 字节宽
      return { width: readUint16BE(bytes, offset + 7), height: readUint16BE(bytes, offset + 5) };
    }
    // 独立标记与填充字节没有长度字段。
    const standalone = marker === 0x01
      || marker === 0xd8
      || marker === 0xd9
      || (marker >= 0xd0 && marker <= 0xd7);
    if (standalone) {
      offset += 2;
      continue;
    }
    if (marker === 0xda) return null; // 已进入扫描数据，说明 SOF 在扫描窗口之外。
    const length = readUint16BE(bytes, offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

function isStartOfFrameMarker(marker: number) {
  // SOF0-SOF3、SOF5-SOF7、SOF9-SOF11、SOF13-SOF15；C4/C8/CC 分别是 DHT/JPG/DAC。
  return (marker >= 0xc0 && marker <= 0xc3)
    || (marker >= 0xc5 && marker <= 0xc7)
    || (marker >= 0xc9 && marker <= 0xcb)
    || (marker >= 0xcd && marker <= 0xcf);
}

function matches(bytes: Uint8Array, offset: number, expected: readonly number[]) {
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected[index]) return false;
  }
  return true;
}

function asciiEquals(bytes: Uint8Array, offset: number, expected: string) {
  return ascii(bytes, offset, offset + expected.length) === expected;
}

function ascii(bytes: Uint8Array, start: number, end: number) {
  let value = "";
  for (let index = start; index < end; index += 1) value += String.fromCharCode(bytes[index] ?? 0);
  return value;
}

function readUint16BE(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint16LE(bytes: Uint8Array, offset: number) {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint32BE(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] ?? 0) * 0x1_00_00_00)
    + (((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0));
}

function readUint32LE(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16))
    + ((bytes[offset + 3] ?? 0) * 0x1_00_00_00);
}

function readUint24LE(bytes: Uint8Array, offset: number) {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}
