import type { CanvasMedia } from "@kachang/contracts";

import { readBlobImageDimensions } from "./image-dimensions";
import { MEDIA_THUMB_STORE_NAME, __resetMediaDatabaseForTests, openMediaDatabase } from "./media-database";

/**
 * 本地图片缩略管线（多级）。
 *
 * 画布节点的图片展示此前直接使用 IndexedDB 里的原始字节：2K 原图解码后
 * 每张约 9MB 位图内存，60+ 张就是 500MB+ 解码位图常驻，集显/软渲染机器
 * 上平移与缩放直接掉到个位数帧率（服务端图片已有 variant=thumb，本地没有）。
 *
 * 多级缩略（mipmap 思路，Figma/tldraw 同款）：节点展示位图成本应随
 * 「屏上可见像素数」而不是「节点数」走。缩放越远、同屏节点越多，每个
 * 节点用越小的缩略图，达到动态平衡：
 * - L1 = 512px 长边（节点常态展示，zoom > 0.45）
 * - L2 = 256px（远观，0.22 < zoom <= 0.45）
 * - L3 = 128px（全图纵览，zoom <= 0.22）
 *
 * 档位切换只在缩放跨档时发生，同一档内平移/微调不换图（切换抖动由
 * 调用方按档位缓存避免）。各级缩略独立落盘复用；全屏预览/下载/编辑
 * 仍走原始字节。
 */

const THUMB_LONG_EDGE = 512;
/** 原图长边不超过该值时不生成缩略：原图本身就是节点展示级别，存缩略反而翻倍。 */
const THUMB_SOURCE_MIN_EDGE = 640;
const THUMB_MIME = "image/jpeg";
const THUMB_QUALITY = 0.86;

export type ThumbLodLevel = 1 | 2 | 3;

export const THUMB_LOD_EDGES: Record<ThumbLodLevel, number> = {
  1: 512,
  2: 256,
  3: 128,
};

/** zoom -> 缩略档位：档位少（3 档）且边界远离常用缩放区，跨档是低频事件。 */
export function thumbLodLevelForZoom(zoom: number): ThumbLodLevel {
  if (!Number.isFinite(zoom) || zoom >= 0.45) return 1;
  if (zoom >= 0.22) return 2;
  return 3;
}

type ThumbCacheEntry = {
  promise: Promise<Blob | null>;
};

const inFlightThumbs = new Map<string, ThumbCacheEntry>();

/**
 * 为本地媒体生成（或复用）指定档位的缩略图。失败时返回 null，调用方回退原图。
 * 并发去重：同一媒体同一档位同时只有一个生成任务。
 */
export async function ensureLocalThumbBlob(
  media: CanvasMedia,
  blob: Blob,
  level: ThumbLodLevel = 1,
): Promise<Blob | null> {
  if (!blob.type.startsWith("image/") || blob.type === "image/svg+xml") return null;
  const cacheKey = thumbKey(media.id, level);
  const cached = await readStoredThumbBlob(cacheKey);
  if (cached) return cached;
  const existing = inFlightThumbs.get(cacheKey);
  if (existing) return existing.promise;
  const entry: ThumbCacheEntry = {
    promise: (async () => {
      try {
        const thumb = await generateThumbBlob(blob, THUMB_LOD_EDGES[level]);
        if (thumb) await storeThumbBlob(cacheKey, thumb);
        return thumb;
      } catch {
        return null;
      } finally {
        inFlightThumbs.delete(cacheKey);
      }
    })(),
  };
  inFlightThumbs.set(cacheKey, entry);
  return entry.promise;
}

async function generateThumbBlob(blob: Blob, longEdge: number): Promise<Blob | null> {
  const dimensions = await readBlobImageDimensions(blob);
  if (!dimensions) return null;
  const longest = Math.max(dimensions.width, dimensions.height);
  if (longest <= THUMB_SOURCE_MIN_EDGE) return null;
  const scale = Math.min(1, longEdge / longest);

  let bitmap: ImageBitmap | null = null;
  if (typeof createImageBitmap === "function") {
    bitmap = await createImageBitmap(blob, {
      resizeWidth: Math.max(1, Math.round(dimensions.width * scale)),
      resizeHeight: Math.max(1, Math.round(dimensions.height * scale)),
      resizeQuality: "high",
    });
  } else {
    return null;
  }

  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((result) => resolve(result), THUMB_MIME, THUMB_QUALITY);
    });
  } finally {
    if (typeof bitmap.close === "function") bitmap.close();
  }
}

function thumbKey(mediaId: string, level: ThumbLodLevel) {
  return `${mediaId}@${level}`;
}

// ---------------------------------------------------------------------------
// 缩略图落盘：与主媒体记录同库不同 store，版本由 media-database 统一管理。
// ---------------------------------------------------------------------------

async function storeThumbBlob(cacheKey: string, blob: Blob): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const database = await openMediaDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(MEDIA_THUMB_STORE_NAME, "readwrite");
      transaction.objectStore(MEDIA_THUMB_STORE_NAME).put({ mediaId: cacheKey, blob, storedAt: Date.now() });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("缩略图保存失败"));
    });
  } catch {
    // 缩略图落盘失败不阻断展示：调用方会回退原图。
  }
}

export async function readStoredThumbBlob(cacheKey: string): Promise<Blob | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    const database = await openMediaDatabase();
    return await new Promise<Blob | null>((resolve, reject) => {
      const request = database.transaction(MEDIA_THUMB_STORE_NAME, "readonly").objectStore(MEDIA_THUMB_STORE_NAME).get(cacheKey);
      request.onsuccess = () => resolve((request.result as { blob: Blob } | undefined)?.blob ?? null);
      request.onerror = () => reject(request.error ?? new Error("缩略图读取失败"));
    });
  } catch {
    return null;
  }
}

/** 删除媒体的所有档位缩略（媒体删除/清理时调用）。 */
export async function removeStoredThumbBlob(mediaId: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const database = await openMediaDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(MEDIA_THUMB_STORE_NAME, "readwrite");
      const store = transaction.objectStore(MEDIA_THUMB_STORE_NAME);
      for (const level of [1, 2, 3] as const) store.delete(thumbKey(mediaId, level));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("缩略图删除失败"));
    });
  } catch {
    // 删除失败无碍：媒体清理流程的孤儿缩略图不会复用（媒体 id 不存在即不展示）。
  }
}

/** 仅供测试重置内部状态。 */
export function resetThumbPipelineForTests() {
  inFlightThumbs.clear();
  __resetMediaDatabaseForTests();
}
