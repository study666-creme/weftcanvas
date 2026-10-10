export type MediaKind = "image" | "video" | "audio";

export type ValidatedMedia = {
  blob: Blob;
  mimeType: string;
  width?: number;
  height?: number;
  durationMs?: number;
};

const MEDIA_TIMEOUT_MS = 15_000;
const TEXT_PREVIEW_BYTES = 768;

export async function validateImageBlob(input: Blob): Promise<ValidatedMedia & { width: number; height: number }> {
  const blob = await normalizeAndValidatePayload(input, "image");
  const dimensions = await readImageDimensions(blob);
  return { blob, mimeType: blob.type || "image/png", ...dimensions };
}

export async function validateMediaBlob(input: Blob, kind: "video" | "audio"): Promise<ValidatedMedia> {
  const blob = await normalizeAndValidatePayload(input, kind);
  const metadata = await readMediaMetadata(blob, kind);
  return { blob, mimeType: blob.type || fallbackMimeType(kind), ...metadata };
}

export async function isValidMediaBlob(input: Blob, kind: MediaKind) {
  try {
    if (kind === "image") await validateImageBlob(input);
    else await validateMediaBlob(input, kind);
    return true;
  } catch {
    return false;
  }
}

async function normalizeAndValidatePayload(input: Blob, kind: MediaKind) {
  if (!input.size) throw new Error(`${mediaLabel(kind)}内容为空，请重新选择`);

  const bytes = new Uint8Array(await input.slice(0, TEXT_PREVIEW_BYTES).arrayBuffer());
  const declaredMime = input.type.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  await rejectTextErrorPayload(input, bytes, declaredMime, kind);

  const textStart = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^\uFEFF/, "").trim().toLowerCase();
  const isSvg = kind === "image" && (textStart.startsWith("<svg") || (textStart.startsWith("<?xml") && textStart.includes("<svg")));
  const sniffed = isSvg ? { kind: "image" as const, mimeType: "image/svg+xml" } : sniffMedia(bytes, kind);
  const declaredMatches = declaredMime.startsWith(`${kind}/`);
  if (sniffed?.kind && sniffed.kind !== kind) throw new Error(`文件内容是${mediaLabel(sniffed.kind)}，不是${mediaLabel(kind)}`);
  if (!sniffed && !declaredMatches && declaredMime && declaredMime !== "application/octet-stream") {
    throw new Error(`文件类型为 ${declaredMime}，不是有效${mediaLabel(kind)}`);
  }

  const mimeType = sniffed?.mimeType || (declaredMatches ? declaredMime : fallbackMimeType(kind));
  return declaredMime === mimeType ? input : new Blob([input], { type: mimeType });
}

async function rejectTextErrorPayload(blob: Blob, bytes: Uint8Array, mimeType: string, kind: MediaKind) {
  const preview = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^\uFEFF/, "").trim();
  const lower = preview.toLowerCase();
  const textMime = mimeType.includes("json") || mimeType.startsWith("text/") || mimeType.includes("xml");
  const previewLength = Math.min(bytes.length, 160);
  const printableCount = Array.from(bytes.slice(0, previewLength)).filter((byte) => byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126)).length;
  const printable = previewLength > 0 && printableCount / previewLength > 0.88;
  const looksLikeErrorText = lower.startsWith("{") || lower.startsWith("[") || lower.startsWith("<!doctype") || lower.startsWith("<html") || lower.startsWith("<head") || lower.startsWith("<body");
  const validSvg = kind === "image" && (lower.startsWith("<svg") || (lower.startsWith("<?xml") && lower.includes("<svg")));
  if (validSvg || (!textMime && !printable && !looksLikeErrorText)) return;

  const message = extractErrorMessage(await blob.slice(0, 16_384).text().catch(() => preview));
  throw new Error(message ? `${mediaLabel(kind)}处理失败：${message}` : `文件内容不是有效${mediaLabel(kind)}`);
}

function extractErrorMessage(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const payload = JSON.parse(trimmed) as Record<string, unknown>;
      const error = payload.error;
      if (typeof error === "string") return error.slice(0, 240);
      if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message.slice(0, 240);
      for (const key of ["message", "msg", "detail"]) {
        if (typeof payload[key] === "string") return String(payload[key]).slice(0, 240);
      }
    } catch {
      // Fall through to a short plain-text preview.
    }
  }
  return trimmed.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 180);
}

function byteAt(bytes: Uint8Array, index: number) {
  return bytes[index] ?? 0;
}

function sniffMedia(bytes: Uint8Array, expected: MediaKind): { kind: MediaKind; mimeType: string } | null {
  if (matches(bytes, [0x89, 0x50, 0x4e, 0x47])) return { kind: "image", mimeType: "image/png" };
  if (matches(bytes, [0xff, 0xd8, 0xff])) return { kind: "image", mimeType: "image/jpeg" };
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return { kind: "image", mimeType: "image/gif" };
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return { kind: "image", mimeType: "image/webp" };
  if (ascii(bytes, 0, 2) === "BM") return { kind: "image", mimeType: "image/bmp" };
  if (matches(bytes, [0x49, 0x49, 0x2a, 0x00]) || matches(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return { kind: "image", mimeType: "image/tiff" };

  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return { kind: "audio", mimeType: "audio/wav" };
  if (ascii(bytes, 0, 4) === "fLaC") return { kind: "audio", mimeType: "audio/flac" };
  if (ascii(bytes, 0, 3) === "ID3" || (byteAt(bytes, 0) === 0xff && (byteAt(bytes, 1) & 0xe0) === 0xe0)) return { kind: "audio", mimeType: "audio/mpeg" };
  if (byteAt(bytes, 0) === 0xff && (byteAt(bytes, 1) & 0xf6) === 0xf0) return { kind: "audio", mimeType: "audio/aac" };

  if (matches(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return { kind: "video", mimeType: "video/webm" };
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "AVI ") return { kind: "video", mimeType: "video/x-msvideo" };
  if (matches(bytes, [0x00, 0x00, 0x01, 0xba]) || matches(bytes, [0x00, 0x00, 0x01, 0xb3])) return { kind: "video", mimeType: "video/mpeg" };
  if (ascii(bytes, 0, 4) === "OggS") return { kind: expected === "audio" ? "audio" : "video", mimeType: expected === "audio" ? "audio/ogg" : "video/ogg" };

  if (ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4).toLowerCase();
    if (["avif", "avis", "heic", "heix", "hevc", "mif1", "msf1"].includes(brand)) return { kind: "image", mimeType: brand.startsWith("av") ? "image/avif" : "image/heif" };
    return { kind: expected === "audio" ? "audio" : "video", mimeType: expected === "audio" ? "audio/mp4" : "video/mp4" };
  }

  return null;
}

function readImageDimensions(blob: Blob) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      URL.revokeObjectURL(url);
      image.onload = null;
      image.onerror = null;
      if (error) reject(error);
      else resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    const timer = window.setTimeout(() => finish(new Error("图片读取超时，请重新选择")), MEDIA_TIMEOUT_MS);
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight) finish(new Error("图片尺寸无效，请重新选择"));
      else finish();
    };
    image.onerror = () => finish(new Error("浏览器无法读取这张图片，请更换文件"));
    image.src = url;
  });
}

function readMediaMetadata(blob: Blob, kind: "video" | "audio") {
  return new Promise<{ width?: number; height?: number; durationMs?: number }>((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const media = document.createElement(kind);
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timer);
      media.onloadedmetadata = null;
      media.onerror = null;
      media.removeAttribute("src");
      media.load();
      URL.revokeObjectURL(url);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      const width = kind === "video" ? (media as HTMLVideoElement).videoWidth : undefined;
      const height = kind === "video" ? (media as HTMLVideoElement).videoHeight : undefined;
      const durationMs = Number.isFinite(media.duration) && media.duration > 0 ? Math.round(media.duration * 1000) : undefined;
      cleanup();
      if (error) reject(error);
      else resolve({ width, height, durationMs });
    };
    const timer = window.setTimeout(() => finish(new Error(`${mediaLabel(kind)}读取超时，请更换文件`)), MEDIA_TIMEOUT_MS);
    media.preload = "metadata";
    media.onloadedmetadata = () => {
      if (kind === "video" && (!(media as HTMLVideoElement).videoWidth || !(media as HTMLVideoElement).videoHeight)) {
        finish(new Error("视频画面尺寸无效，请更换文件"));
        return;
      }
      finish();
    };
    media.onerror = () => finish(new Error(`浏览器无法读取这个${mediaLabel(kind)}，请更换格式`));
    media.src = url;
    media.load();
  });
}

function fallbackMimeType(kind: MediaKind) {
  return kind === "image" ? "image/png" : kind === "video" ? "video/mp4" : "audio/mpeg";
}

function mediaLabel(kind: MediaKind) {
  return kind === "image" ? "图片" : kind === "video" ? "视频" : "音频";
}

function matches(bytes: Uint8Array, signature: number[]) {
  return signature.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}
