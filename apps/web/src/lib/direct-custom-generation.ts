import type { GenerationArtifact } from "@weftcanvas/contracts";

import type { CustomGenerationResult } from "./custom-api";
import { composeModelParameters } from "./generation-config";
import {
  REFERENCE_VIDEO_DURATIONS_PARAMETER,
  getReferenceImagePurposes,
  referenceVideoDurationsParameter,
} from "./generation-inputs";
import type { GenerationReferences, MediaReference } from "./generation-inputs";
import type { PublicModel } from "@weftcanvas/contracts";
import type { DirectReference } from "../state/direct-reference-store";

/**
 * 工作台（/generate）的 BYOK 直连辅助：把草稿素材映射成与画布同一形状的
 * 参考引用，把提交参数补成与托管路径同一份合成规则，并把直连执行结果转成
 * 任务工件。纯函数，不碰 React 与网络。
 */

/**
 * 直连提交的参数：提示词绑定 + 目录参数（与托管路径同一个 composeModelParameters），
 * 再补上「参考视频 ↔ referenceVideoDurations」的成对声明——H3 系路线缺了这一项会被
 * 上游整单 400 拒（用户侧看到的是「当提供参考视频时，必须填写 reference_video_durations」）。
 * 顺序必须与 inputs.videos 一致；模型没有声明该参数（无能力目录）时，合成会自然丢弃
 * 这个键，绝不发未知字段。
 */
export function directGenerationParameters(
  model: PublicModel,
  body: string,
  configured: Record<string, unknown>,
  videoDurations: readonly number[] | null,
): Record<string, unknown> {
  const parameters = composeModelParameters(model, body, configured);
  // 会话里可能残留旧的声明值（早期草稿手填过）：先删再按实测写入，绝不让
  // 手填/过期值进入请求——上游按这个秒数计费。模型没声明该参数（无能力目录的
  // 合成模型）时一个字节都不发。
  delete parameters[REFERENCE_VIDEO_DURATIONS_PARAMETER];
  const durations = videoDurations ? [...videoDurations] : null;
  if (durations?.length && referenceVideoDurationsParameter(model))
    parameters[REFERENCE_VIDEO_DURATIONS_PARAMETER] = durations;
  return parameters;
}

/**
 * 工作台素材已上传到托管媒体服务（serverId）；直连执行按画布同一管线
 * 读取字节（data URL 或公网引用），这里只补一份可解析的媒体描述。
 */
export function directGenerationReferences(
  references: DirectReference[],
  model: PublicModel,
): GenerationReferences {
  const purposes = getReferenceImagePurposes(model);
  const mediaOf = (reference: DirectReference): MediaReference => ({
    nodeId: reference.id,
    kind: reference.kind,
    media: {
      id: reference.serverId as string,
      name: reference.name,
      mimeType:
        reference.kind === "image"
          ? "image/png"
          : reference.kind === "video"
            ? "video/mp4"
            : "audio/mpeg",
      size: 0,
      source: "server",
      serverId: reference.serverId as string,
      width: null,
      height: null,
      durationMs: reference.durationMs,
    },
  });
  const images: MediaReference[] = [];
  const styleImages: MediaReference[] = [];
  const elementImages: MediaReference[] = [];
  const videos: MediaReference[] = [];
  const audios: MediaReference[] = [];
  for (const reference of references) {
    if (reference.status !== "ready" || !reference.serverId) continue;
    if (reference.kind === "image") {
      const purpose =
        reference.imagePurpose && purposes.includes(reference.imagePurpose)
          ? reference.imagePurpose
          : purposes[0];
      if (purpose === "styleImages") styleImages.push(mediaOf(reference));
      else if (purpose === "elementImages") elementImages.push(mediaOf(reference));
      else images.push(mediaOf(reference));
    } else if (reference.kind === "video") videos.push(mediaOf(reference));
    else audios.push(mediaOf(reference));
  }
  return {
    images,
    styleImages,
    elementImages,
    videos,
    audios,
    connectedImages: [],
    unassignedImages: [],
    imagePurposes: purposes,
    overflow: [],
    aggregateOverflow: null,
  };
}

/** 直连结果 → 任务工件：媒体已在本地媒体库，工件按 mediaId 引用。 */
export function customGenerationArtifacts(result: CustomGenerationResult): GenerationArtifact[] {
  const createdAt = new Date().toISOString();
  if (result.text !== undefined)
    return [{ id: crypto.randomUUID(), createdAt, kind: "text", text: result.text }];
  return (result.media ?? []).map((media) => ({
    id: crypto.randomUUID(),
    createdAt,
    kind: media.mimeType.startsWith("video/")
      ? ("video" as const)
      : media.mimeType.startsWith("audio/")
        ? ("audio" as const)
        : ("image" as const),
    mediaId: media.id,
    name: media.name,
    mimeType: media.mimeType,
    size: media.size,
    ...(media.width ? { width: media.width } : {}),
    ...(media.height ? { height: media.height } : {}),
    ...(media.durationMs ? { duration: Math.max(1, Math.round(media.durationMs / 1_000)) } : {}),
  }));
}
