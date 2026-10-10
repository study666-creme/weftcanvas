import { open, stat } from "node:fs/promises";

import mediaInfoFactory, {
  isTrackType,
  type AudioTrack,
  type GeneralTrack,
  type VideoTrack,
} from "mediainfo.js";
import sharp from "sharp";

import { MediaInspectionError, type InspectedMedia, type MediaInspector } from "./types.js";

const MAX_IMAGE_PIXELS = 100_000_000;
const MAX_IMAGE_DIMENSION = 32_768;
const IMAGE_MIME_TYPES: Record<string, string> = {
  avif: "image/avif",
  gif: "image/gif",
  heif: "image/heif",
  jpeg: "image/jpeg",
  png: "image/png",
  tiff: "image/tiff",
  webp: "image/webp",
};

export class DefaultMediaInspector implements MediaInspector {
  async inspect(path: string, expectedKind: "image" | "video" | "audio"): Promise<InspectedMedia> {
    if (expectedKind === "image") return inspectImage(path);
    return inspectAudioVideo(path, expectedKind);
  }
}

async function inspectImage(path: string): Promise<InspectedMedia> {
  try {
    const image = sharp(path, {
      animated: true,
      failOn: "error",
      limitInputPixels: MAX_IMAGE_PIXELS,
      sequentialRead: true,
    });
    const metadata = await image.metadata();
    await image.clone().stats();
    const width = metadata.width;
    const height = metadata.pageHeight ?? metadata.height;
    const pages = metadata.pages ?? 1;
    const mimeType = metadata.format ? IMAGE_MIME_TYPES[metadata.format] : undefined;
    if (!width || !height || !mimeType) throw invalid("图片格式或尺寸无法识别");
    if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height * pages > MAX_IMAGE_PIXELS) {
      throw new MediaInspectionError("IMAGE_DIMENSIONS_TOO_LARGE", "图片尺寸超过当前限制");
    }
    return {
      kind: "image",
      mimeType,
      size: (await stat(path)).size,
      width,
      height,
      durationMs: null,
    };
  } catch (error) {
    if (error instanceof MediaInspectionError) throw error;
    throw invalid("图片内容无法解码");
  }
}

async function inspectAudioVideo(path: string, expectedKind: "video" | "audio"): Promise<InspectedMedia> {
  const mediaInfo = await mediaInfoFactory({ format: "object", chunkSize: 256 * 1024 });
  try {
    const file = await open(path, "r");
    try {
      const metadata = await file.stat();
      const result = await mediaInfo.analyzeData(metadata.size, async (size, offset) => {
        const buffer = Buffer.allocUnsafe(size);
        const read = await file.read(buffer, 0, size, offset);
        return buffer.subarray(0, read.bytesRead);
      });
      const tracks = result.media?.track ?? [];
      const general = tracks.find((track): track is GeneralTrack => isTrackType(track, "General"));
      const video = tracks.find((track): track is VideoTrack => isTrackType(track, "Video"));
      const audio = tracks.find((track): track is AudioTrack => isTrackType(track, "Audio"));
      if (expectedKind === "video" && !video) throw mismatch("文件中没有可识别的视频轨道");
      if (expectedKind === "audio" && (!audio || video)) throw mismatch("文件内容不是独立音频");

      const duration = expectedKind === "video"
        ? positiveNumber(video?.Duration) ?? positiveNumber(general?.Duration)
        : positiveNumber(audio?.Duration) ?? positiveNumber(general?.Duration);
      if (!duration) throw invalid(`${expectedKind === "video" ? "视频" : "音频"}时长无法识别`);
      const mimeType = mediaMimeType(general, expectedKind);
      if (!mimeType) throw invalid(`${expectedKind === "video" ? "视频" : "音频"}容器格式无法识别`);

      const width = expectedKind === "video" ? positiveInteger(video?.Width) : null;
      const height = expectedKind === "video" ? positiveInteger(video?.Height) : null;
      if (expectedKind === "video" && (!width || !height)) throw invalid("视频画面尺寸无法识别");
      return {
        kind: expectedKind,
        mimeType,
        size: metadata.size,
        width,
        height,
        durationMs: Math.max(1, Math.round(duration * 1_000)),
      };
    } catch (error) {
      if (error instanceof MediaInspectionError) throw error;
      throw invalid(`${expectedKind === "video" ? "视频" : "音频"}内容无法解析`);
    } finally {
      await file.close();
    }
  } finally {
    mediaInfo.close();
  }
}

function mediaMimeType(general: GeneralTrack | undefined, kind: "video" | "audio") {
  const reported = general?.InternetMediaType?.toLowerCase();
  if (reported?.startsWith(`${kind}/`)) return reported;
  const format = general?.Format?.toLowerCase() ?? "";
  if (kind === "video") {
    if (format.includes("webm")) return "video/webm";
    if (format.includes("matroska")) return "video/x-matroska";
    if (format.includes("quicktime")) return "video/quicktime";
    if (format.includes("avi")) return "video/x-msvideo";
    if (format.includes("mpeg-4")) return "video/mp4";
    if (format.includes("mpeg-ts")) return "video/mp2t";
    if (format.includes("mpeg")) return "video/mpeg";
    if (format.includes("ogg")) return "video/ogg";
  } else {
    if (format.includes("mpeg-4")) return "audio/mp4";
    if (format.includes("mpeg audio")) return "audio/mpeg";
    if (format.includes("wave")) return "audio/wav";
    if (format.includes("flac")) return "audio/flac";
    if (format.includes("aac")) return "audio/aac";
    if (format.includes("ogg")) return "audio/ogg";
    if (format.includes("webm")) return "audio/webm";
  }
  return null;
}

function positiveNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function invalid(message: string) {
  return new MediaInspectionError("MEDIA_INVALID", message);
}

function mismatch(message: string) {
  return new MediaInspectionError("MEDIA_TYPE_MISMATCH", message);
}
