import type { CanvasMedia } from "@kachang/contracts";

import type { ProjectAssetKind } from "./asset-library-store";
import type { KachangNode } from "../types";

export type CanvasMediaCapture = {
  media: CanvasMedia;
  kind: Exclude<ProjectAssetKind, "prompt">;
  prompt: string;
};

/** mime → 资产类型；识别不了的类型不入库。 */
export function projectAssetKindOfMedia(media: CanvasMedia): Exclude<ProjectAssetKind, "prompt"> | null {
  if (media.mimeType.startsWith("image/")) return "image";
  if (media.mimeType.startsWith("video/")) return "video";
  if (media.mimeType.startsWith("audio/")) return "audio";
  return null;
}

/**
 * 收集画布节点上可入库的媒体资产：每个媒体 id 只取第一次出现的节点，
 * 节点提示词（body）随资产一起保存，插回画布时能还原创作语境。
 */
export function collectCanvasMediaCaptures(nodes: KachangNode[]): CanvasMediaCapture[] {
  const byMediaId = new Map<string, CanvasMediaCapture>();
  for (const node of nodes) {
    const media = node.data.media;
    if (!media || byMediaId.has(media.id)) continue;
    const kind = projectAssetKindOfMedia(media);
    if (!kind) continue;
    byMediaId.set(media.id, { media, kind, prompt: (node.data.body ?? "").trim() });
  }
  return [...byMediaId.values()];
}

/** 入库展示名：优先用提示词开头（更有辨识度），退回媒体文件名。 */
export function projectAssetDisplayName(prompt: string, media: CanvasMedia) {
  const fromPrompt = prompt.replace(/\s+/g, " ").trim().slice(0, 28);
  return fromPrompt || media.name || "未命名资产";
}
