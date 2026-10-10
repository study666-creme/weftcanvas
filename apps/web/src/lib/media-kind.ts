import type { MediaKind } from "@kachang/contracts";

/**
 * 素材类型推断，工作台与画布共用：MIME → 扩展名 → 文件头魔数三层兜底。
 * 从网络下载的图片在 Windows 上常常 MIME 为空、扩展名生僻，只看 MIME 会
 * 被误判为「无法加入画布」；魔数嗅探（前 64 字节）能把这类文件捞回来。
 */
export async function inferMaterialKind(file: File): Promise<MediaKind | null> {
  const mimeKind = mediaKindFromMime(file.type);
  const nameKind = mediaKindFromFileName(file.name);
  try {
    const bytes = new Uint8Array(await file.slice(0, 64).arrayBuffer());
    return mediaKindFromBytes(bytes, mimeKind, nameKind) ?? mimeKind ?? nameKind;
  } catch {
    return mimeKind ?? nameKind;
  }
}

function mediaKindFromMime(mimeType: string): MediaKind | null {
  const mime = mimeType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return null;
}

function mediaKindFromFileName(name: string): MediaKind | null {
  const extension = name.split(".").at(-1)?.toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "heif", "tif", "tiff", "bmp", "svg"].includes(extension ?? "")) return "image";
  if (["mp4", "mov", "m4v", "webm", "avi", "mpeg", "mpg", "ogv", "3gp", "3g2"].includes(extension ?? "")) return "video";
  if (["mp3", "wav", "flac", "aac", "m4a", "ogg", "oga", "opus", "aiff", "aif", "wma"].includes(extension ?? "")) return "audio";
  return null;
}

function mediaKindFromBytes(bytes: Uint8Array, mimeKind: MediaKind | null, nameKind: MediaKind | null): MediaKind | null {
  if (matchesBytes(bytes, [0x89, 0x50, 0x4e, 0x47]) || matchesBytes(bytes, [0xff, 0xd8, 0xff])) return "image";
  if (asciiBytes(bytes, 0, 6) === "GIF87a" || asciiBytes(bytes, 0, 6) === "GIF89a") return "image";
  if (asciiBytes(bytes, 0, 4) === "RIFF" && asciiBytes(bytes, 8, 4) === "WEBP") return "image";
  if (asciiBytes(bytes, 0, 2) === "BM" || matchesBytes(bytes, [0x49, 0x49, 0x2a, 0x00]) || matchesBytes(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return "image";
  if (asciiBytes(bytes, 0, 4) === "RIFF" && asciiBytes(bytes, 8, 4) === "WAVE") return "audio";
  if (asciiBytes(bytes, 0, 4) === "fLaC" || asciiBytes(bytes, 0, 3) === "ID3") return "audio";
  if ((bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xf6) === 0xf0)) return "audio";
  if (matchesBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return mimeKind === "audio" || nameKind === "audio" ? "audio" : "video";
  if (asciiBytes(bytes, 0, 4) === "RIFF" && asciiBytes(bytes, 8, 4) === "AVI ") return "video";
  if (matchesBytes(bytes, [0x00, 0x00, 0x01, 0xba]) || matchesBytes(bytes, [0x00, 0x00, 0x01, 0xb3])) return "video";
  if (asciiBytes(bytes, 0, 4) === "OggS") return mimeKind === "video" || nameKind === "video" ? "video" : "audio";
  if (asciiBytes(bytes, 4, 4) === "ftyp") {
    const brand = asciiBytes(bytes, 8, 4).toLowerCase();
    if (["avif", "avis", "heic", "heix", "hevc", "mif1", "msf1"].includes(brand)) return "image";
    return mimeKind === "audio" || nameKind === "audio" ? "audio" : "video";
  }
  return null;
}

function matchesBytes(bytes: Uint8Array, signature: number[]) {
  return signature.every((value, index) => bytes[index] === value);
}

function asciiBytes(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}
