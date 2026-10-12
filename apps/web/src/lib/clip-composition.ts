import type { CanvasEditClip, CanvasEditClipTrack, CanvasMedia } from "@weftcanvas/contracts";
import { createId } from "@weftcanvas/canvas-core";

import type { WeftcanvasEdge, WeftcanvasNode } from "../types";

/** 图片素材的默认展示时长。 */
export const EDIT_IMAGE_CLIP_DURATION_MS = 3_000;
/** 素材片段最短时长，避免裁剪到不可操作。 */
export const EDIT_MIN_CLIP_DURATION_MS = 300;
/** 视频/音频素材无法读取时长时的兜底展示时长。 */
export const EDIT_FALLBACK_CLIP_DURATION_MS = 4_000;

export type EditAssetKind = "image" | "video" | "audio";

export type EditAsset = {
  nodeId: string;
  media: CanvasMedia;
  kind: EditAssetKind;
  /**
   * 流式素材的直连 URL（如音乐链接解析出的同源代理流）：这类素材没有
   * CanvasMedia 记录，media 是按节点合成的稳定占位，URL 不走
   * IndexedDB/服务器媒体解析，直接进媒体池与时间线。
   */
  sourceUrl?: string;
};

/** 按时间线顺序返回指定轨道的片段。 */
export function trackClips(clips: readonly CanvasEditClip[], track: CanvasEditClipTrack) {
  return clips.filter((clip) => clip.track === track);
}

/** 片段在时间线上的时长（in/out 半开区间）。 */
export function clipDurationMs(clip: CanvasEditClip) {
  return Math.max(0, clip.outMs - clip.inMs);
}

/** 轨道内片段的起始时标：按顺序累计。 */
export function clipStartMs(track: readonly CanvasEditClip[], index: number) {
  let start = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    start += clipDurationMs(track[cursor]!);
  }
  return start;
}

/** 轨道总时长。 */
export function trackDurationMs(clips: readonly CanvasEditClip[], track: CanvasEditClipTrack) {
  return trackClips(clips, track).reduce((total, clip) => total + clipDurationMs(clip), 0);
}

/** 合成总时长：取各轨道最大值。 */
export function compositionDurationMs(clips: readonly CanvasEditClip[]) {
  return Math.max(trackDurationMs(clips, "video"), trackDurationMs(clips, "audio"));
}

/**
 * 给定时标返回轨道内的当前片段与其在时间线上的起始时标。
 * 片段之间不允许重叠（顺序排列），因此按结束时间线性查找即可。
 */
export function activeClipAt(
  track: readonly CanvasEditClip[],
  timelineMs: number,
): { clip: CanvasEditClip; startMs: number } | null {
  let start = 0;
  for (const clip of track) {
    const duration = clipDurationMs(clip);
    if (timelineMs < start + duration) return { clip, startMs: start };
    start += duration;
  }
  return null;
}

/** 时间线时标 → 素材源时标（未命中返回 null）。 */
export function resolveSourceTimeMs(
  track: readonly CanvasEditClip[],
  timelineMs: number,
): number | null {
  const active = activeClipAt(track, timelineMs);
  return active ? active.clip.inMs + (timelineMs - active.startMs) : null;
}

/** 限制裁剪区间并保持最小值，返回新片段（无变化时返回原引用）。 */
export function setClipRange(
  clip: CanvasEditClip,
  next: { inMs?: number; outMs?: number },
): CanvasEditClip {
  const sourceEnd = clip.sourceDurationMs ?? Number.MAX_SAFE_INTEGER;
  let inMs = Math.max(0, Math.min(next.inMs ?? clip.inMs, sourceEnd - EDIT_MIN_CLIP_DURATION_MS));
  let outMs = Math.max(
    inMs + EDIT_MIN_CLIP_DURATION_MS,
    Math.min(next.outMs ?? clip.outMs, sourceEnd),
  );
  inMs = Math.min(inMs, outMs - EDIT_MIN_CLIP_DURATION_MS);
  if (inMs === clip.inMs && outMs === clip.outMs) return clip;
  return { ...clip, inMs, outMs };
}

/** 轨道内移动片段到新位置（按时间线顺序）。 */
export function moveClip(
  clips: readonly CanvasEditClip[],
  clipId: string,
  toIndex: number,
): CanvasEditClip[] {
  const fromIndex = clips.findIndex((clip) => clip.id === clipId);
  if (fromIndex < 0) return [...clips];
  const target = Math.max(0, Math.min(toIndex, clips.length - 1));
  if (target === fromIndex) return [...clips];
  const next = [...clips];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(target, 0, moved!);
  return next;
}

/** 删除片段。 */
export function removeClip(clips: readonly CanvasEditClip[], clipId: string): CanvasEditClip[] {
  return clips.filter((clip) => clip.id !== clipId);
}

/**
 * 片段在轨道内重排到新序号（0 到 轨道长度-1）。
 * 返回结果统一保持「视频轨片段在前、音频轨在后」的存储顺序。
 */
export function reorderClipInTrack(
  clips: readonly CanvasEditClip[],
  clipId: string,
  trackIndex: number,
): CanvasEditClip[] {
  const clip = clips.find((candidate) => candidate.id === clipId);
  if (!clip) return [...clips];
  const track = trackClips(clips, clip.track);
  const fromIndex = track.findIndex((candidate) => candidate.id === clipId);
  const toIndex = Math.max(0, Math.min(trackIndex, track.length - 1));
  if (fromIndex < 0 || toIndex === fromIndex) return [...clips];
  const reordered = [...track];
  const [moved] = reordered.splice(fromIndex, 1);
  reordered.splice(toIndex, 0, moved!);
  const video = clip.track === "video" ? reordered : trackClips(clips, "video");
  const audio = clip.track === "audio" ? reordered : trackClips(clips, "audio");
  return [...video, ...audio];
}

/** 素材加入时间线末尾。 */
export function buildClipFromAsset(
  asset: EditAsset,
  sourceDurationMs: number | null,
): CanvasEditClip {
  const isImage = asset.kind === "image";
  const duration = isImage
    ? (sourceDurationMs ?? EDIT_IMAGE_CLIP_DURATION_MS)
    : (sourceDurationMs ?? EDIT_FALLBACK_CLIP_DURATION_MS);
  return {
    id: createId("clip"),
    track: asset.kind === "audio" ? "audio" : "video",
    nodeId: asset.nodeId,
    mediaId: asset.media.id,
    name: asset.media.name,
    kind: asset.kind,
    sourceDurationMs,
    inMs: 0,
    outMs: Math.max(EDIT_MIN_CLIP_DURATION_MS, Math.round(duration)),
  };
}

/**
 * 收集剪辑节点左侧所有直连素材节点的媒体：
 * 按连线顺序、按 mediaId 去重，只保留图片/视频/音频；
 * 音频节点没有本地/服务器媒体但持有音乐链接流（music.streamPath）时，
 * 合成稳定 mediaId 并以同源代理流直连进池。
 */
export function collectEditAssets(
  nodes: readonly WeftcanvasNode[],
  edges: readonly WeftcanvasEdge[],
  editNodeId: string,
): EditAsset[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const assets: EditAsset[] = [];
  const seenMediaIds = new Set<string>();
  for (const edge of edges) {
    if (edge.target !== editNodeId) continue;
    const source = nodeById.get(edge.source);
    if (!source) continue;
    const media = source.data.media;
    if (media) {
      if (seenMediaIds.has(media.id)) continue;
      if (
        source.data.kind !== "image" &&
        source.data.kind !== "video" &&
        source.data.kind !== "audio"
      )
        continue;
      seenMediaIds.add(media.id);
      assets.push({ nodeId: source.id, media, kind: source.data.kind });
      continue;
    }
    if (source.data.kind !== "audio") continue;
    // 同源守卫与音乐节点渲染一致：只接受 /api/v1/music/ 代理路径，
    // 第三方直链永远不进时间线媒体池。
    const streamPath = source.data.music?.streamPath;
    if (!streamPath?.startsWith("/api/v1/music/")) continue;
    const syntheticMediaId = `music-${source.id}`;
    if (seenMediaIds.has(syntheticMediaId)) continue;
    seenMediaIds.add(syntheticMediaId);
    assets.push({
      nodeId: source.id,
      kind: "audio",
      sourceUrl: streamPath,
      media: {
        id: syntheticMediaId,
        name: source.data.music?.title || "音频流",
        mimeType: "audio/mpeg",
        size: 0,
        source: "local",
        serverId: null,
        width: null,
        height: null,
        durationMs: null,
      },
    });
  }
  return assets;
}

/** 片段在时间线上的起始时标（按轨道顺序）。 */
export function clipTimelineStart(clips: readonly CanvasEditClip[], clipId: string) {
  const track = trackClips(clips, clips.find((clip) => clip.id === clipId)?.track ?? "video");
  const index = track.findIndex((clip) => clip.id === clipId);
  return index < 0 ? 0 : clipStartMs(track, index);
}

/** mm:ss（超过一小时为 hh:mm:ss），统一 tabular 数字宽度。 */
export function formatTimecode(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

/** 读取素材元数据时长（<video>/<audio> 探测），失败返回 null。 */
export function probeMediaDuration(url: string, kind: "video" | "audio", timeoutMs = 4_000) {
  return new Promise<number | null>((resolve) => {
    let settled = false;
    const element = document.createElement(kind === "video" ? "video" : "audio");
    const finish = (durationMs: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      element.removeAttribute("src");
      element.load();
      resolve(durationMs);
    };
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    element.preload = "metadata";
    element.muted = true;
    element.addEventListener(
      "loadedmetadata",
      () => {
        finish(Number.isFinite(element.duration) ? Math.round(element.duration * 1000) : null);
      },
      { once: true },
    );
    element.addEventListener("error", () => finish(null), { once: true });
    element.src = url;
  });
}
