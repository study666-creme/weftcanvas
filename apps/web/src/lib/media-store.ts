import { createId } from "@weftcanvas/canvas-core";
import type { CanvasMedia } from "@weftcanvas/contracts";

import { validateImageBlob, validateMediaBlob } from "./media-validation";
import { collectProjectMediaIds, readAllProjects } from "./project-library";
import { collectAssetLibraryMediaIds } from "./asset-library-store";
import {
  createMediaUpload,
  createRequestKey,
  mediaContentPath,
  uploadMediaBlob,
} from "./api-client";
import { invalidateMediaObjectUrl } from "./media-object-url-cache";
import { removeStoredThumbBlob } from "./local-media-thumb";
import { MediaCacheIdleQueue, workspaceMediaGestureActive } from "./server-media-cache";
import { MEDIA_STORE_NAME, openMediaDatabase } from "./media-database";

const MEDIA_PRUNE_GRACE_MS = 60_000;
const MEDIA_CACHE_TIMEOUT_MS = 10 * 60_000;

export const localMediaMaxBytes = {
  image: 25 * 1024 * 1024,
  video: 512 * 1024 * 1024,
  audio: 100 * 1024 * 1024,
} as const;

type StoredMedia = CanvasMedia & { blob: Blob; storedAt?: number };

export type LocalMediaListItem = {
  media: CanvasMedia;
  storedAt: number;
};

export function shouldPruneLocalMedia(
  media: Pick<StoredMedia, "id" | "storedAt">,
  retainedIds: ReadonlySet<string>,
  now = Date.now(),
) {
  return !retainedIds.has(media.id) && now - (media.storedAt ?? 0) >= MEDIA_PRUNE_GRACE_MS;
}

let persistentStorageRequest: Promise<boolean> | null = null;
const serverMediaCacheRequests = new Map<string, Promise<boolean>>();

export async function storeMedia(
  file: File,
  kind: "image" | "video" | "audio",
): Promise<CanvasMedia> {
  assertLocalMediaSize(file.size, kind);
  const validated =
    kind === "image" ? await validateImageBlob(file) : await validateMediaBlob(file, kind);
  const media: StoredMedia = {
    id: createId("media"),
    name: file.name || "未命名媒体",
    mimeType: validated.mimeType,
    size: validated.blob.size,
    source: "local",
    serverId: null,
    width: validated.width ?? null,
    height: validated.height ?? null,
    durationMs: validated.durationMs ?? null,
    blob: validated.blob,
    storedAt: Date.now(),
  };
  await writeStoredMedia(media);
  const { blob: _blob, ...metadata } = media;
  return metadata;
}

/**
 * 服务端兜底上传：本地媒体库（IndexedDB）不可用时（配额已满/站点数据被禁用/库损坏），
 * 画布上传降级为直传服务端，节点以 source:"server" 渲染，与生成产物入画布的路径一致。
 * 文件本身的问题（内容非法、解码失败、SVG）会在前置校验中原样抛出，调用方据此报真实原因。
 */
export async function uploadMediaToServer(
  file: File,
  kind: "image" | "video",
): Promise<CanvasMedia> {
  const validated =
    kind === "image" ? await validateImageBlob(file) : await validateMediaBlob(file, kind);
  if (validated.mimeType === "image/svg+xml")
    throw new Error("暂不支持 SVG 文件，请上传 PNG、JPEG 或 WebP 图片");
  const intent = await createMediaUpload({
    kind,
    name: (file.name || "").trim().slice(0, 255) || "未命名媒体",
    mimeType: validated.mimeType,
    size: validated.blob.size,
    idempotencyKey: createRequestKey("canvas-material"),
  });
  const ready = intent.upload
    ? await uploadMediaBlob(intent.media, intent.upload, validated.blob)
    : intent.media;
  if (ready.status !== "ready") throw new Error(ready.error?.message ?? "素材上传失败，请稍后重试");
  return {
    id: ready.id,
    name: ready.name,
    mimeType: ready.mimeType,
    size: ready.size,
    source: "server",
    serverId: ready.id,
    width: ready.width ?? validated.width ?? null,
    height: ready.height ?? validated.height ?? null,
    durationMs: ready.durationMs ?? validated.durationMs ?? null,
  };
}

export function cacheServerMedia(media: CanvasMedia, projectId?: string) {
  if (media.source !== "server") return Promise.resolve(false);
  const cacheKey = `${projectId ?? "self"}:${media.id}`;
  const existing = serverMediaCacheRequests.get(cacheKey);
  if (existing) return existing;
  const request = withCrossTabMediaCacheLock(cacheKey, () =>
    downloadAndCacheServerMedia(media, projectId),
  ).finally(() => {
    if (serverMediaCacheRequests.get(cacheKey) === request)
      serverMediaCacheRequests.delete(cacheKey);
  });
  serverMediaCacheRequests.set(cacheKey, request);
  return request;
}

export function cacheServerMediaBlob(media: CanvasMedia, blob: Blob, projectId?: string) {
  if (media.source !== "server") return Promise.resolve(false);
  const cacheKey = `${projectId ?? "self"}:${media.id}`;
  return withCrossTabMediaCacheLock(cacheKey, async () => {
    if (await readMedia(media.id)) return true;
    const kind = mediaKind(media.mimeType);
    if (!kind) return false;
    try {
      const validated =
        kind === "image" ? await validateImageBlob(blob) : await validateMediaBlob(blob, kind);
      await writeStoredMedia({
        ...media,
        mimeType: validated.mimeType,
        size: validated.blob.size,
        width: media.width ?? validated.width ?? null,
        height: media.height ?? validated.height ?? null,
        durationMs: media.durationMs ?? validated.durationMs ?? null,
        blob: validated.blob,
        storedAt: Date.now(),
      });
      return true;
    } catch {
      return false;
    }
  });
}

// 有界低优先级服务器媒体落盘队列：只在空闲（无视口/节点手势）时串行写入。
const serverMediaCacheQueue = new MediaCacheIdleQueue({
  isGestureActive: workspaceMediaGestureActive,
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
});

/**
 * 把已由有界加载器解码/校验的服务器媒体 blob 低优先级落盘。blob 的宽高来自
 * 那次成功解码，因此不再二次解码；手势期间推迟写入，空闲后串行写进 IndexedDB。
 * 返回的 Promise 在写入完成（或被上限淘汰）后以真实结果 resolve，绝不虚构成功。
 */
export function queueServerMediaBlobCache(
  media: CanvasMedia,
  blob: Blob,
  dimensions: { width?: number | null; height?: number | null },
  projectId?: string,
): Promise<boolean> {
  if (media.source !== "server") return Promise.resolve(false);
  if (!media.mimeType.startsWith("image/")) return Promise.resolve(false);
  const cacheKey = `${projectId ?? "self"}:${media.id}`;
  return serverMediaCacheQueue.enqueue(cacheKey, () =>
    writeServerMediaCacheEntry(media, blob, dimensions, projectId),
  );
}

async function writeServerMediaCacheEntry(
  media: CanvasMedia,
  blob: Blob,
  dimensions: { width?: number | null; height?: number | null },
  projectId?: string,
): Promise<boolean> {
  const cacheKey = `${projectId ?? "self"}:${media.id}`;
  return withCrossTabMediaCacheLock(cacheKey, async () => {
    if (await readMedia(media.id)) return true;
    try {
      await writeStoredMedia({
        ...media,
        mimeType: media.mimeType,
        size: blob.size,
        width: dimensions.width ?? media.width ?? null,
        height: dimensions.height ?? media.height ?? null,
        durationMs: media.durationMs ?? null,
        blob,
        storedAt: Date.now(),
      });
      return true;
    } catch {
      return false;
    }
  });
}

function withCrossTabMediaCacheLock(cacheKey: string, work: () => Promise<boolean>) {
  if (typeof navigator === "undefined" || !navigator.locks?.request) return work();
  return navigator.locks.request(`weftcanvas-media:${cacheKey}`, work);
}

export function requestPersistentMediaStorage() {
  if (persistentStorageRequest) return persistentStorageRequest;
  if (typeof navigator === "undefined" || !navigator.storage?.persist)
    return Promise.resolve(false);
  persistentStorageRequest = (async () => {
    if (await navigator.storage.persisted?.()) return true;
    return navigator.storage.persist();
  })().catch(() => false);
  return persistentStorageRequest;
}

export async function readMedia(id: string) {
  const database = await openMediaDatabase();
  return new Promise<StoredMedia | null>((resolve, reject) => {
    const request = database
      .transaction(MEDIA_STORE_NAME, "readonly")
      .objectStore(MEDIA_STORE_NAME)
      .get(id);
    request.onsuccess = () => resolve((request.result as StoredMedia | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("媒体读取失败"));
  });
}

export async function listLocalMedia(): Promise<LocalMediaListItem[]> {
  const database = await openMediaDatabase();
  const records = await new Promise<StoredMedia[]>((resolve, reject) => {
    const request = database
      .transaction(MEDIA_STORE_NAME, "readonly")
      .objectStore(MEDIA_STORE_NAME)
      .getAll();
    request.onsuccess = () => resolve(request.result as StoredMedia[]);
    request.onerror = () => reject(request.error ?? new Error("媒体列表读取失败"));
  });
  return records
    .filter((media) => media.source === "local")
    .map(({ blob: _blob, storedAt = 0, ...media }) => ({ media, storedAt }))
    .sort((left, right) => right.storedAt - left.storedAt);
}

export async function removeMedia(id: string) {
  const database = await openMediaDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(MEDIA_STORE_NAME, "readwrite");
    transaction.objectStore(MEDIA_STORE_NAME).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("媒体删除失败"));
  });
  invalidateMediaObjectUrl(id);
  void removeStoredThumbBlob(id);
}

export async function pruneUnreferencedLocalMedia(
  referencedIds = collectProjectMediaIds(readAllProjects()),
) {
  if (typeof indexedDB === "undefined") return 0;
  const assetMediaIds = await collectAssetLibraryMediaIds();
  const retainedIds = new Set([...referencedIds, ...assetMediaIds]);
  const database = await openMediaDatabase();
  const records = await new Promise<Array<Pick<StoredMedia, "id" | "storedAt">>>(
    (resolve, reject) => {
      const items: Array<Pick<StoredMedia, "id" | "storedAt">> = [];
      const request = database
        .transaction(MEDIA_STORE_NAME, "readonly")
        .objectStore(MEDIA_STORE_NAME)
        .openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(items);
          return;
        }
        const media = cursor.value as StoredMedia;
        items.push({ id: media.id, storedAt: media.storedAt });
        cursor.continue();
      };
      request.onerror = () => reject(request.error ?? new Error("media keys could not be read"));
    },
  );
  const now = Date.now();
  const removable = records
    .filter((media) => shouldPruneLocalMedia(media, retainedIds, now))
    .map((media) => media.id);
  if (!removable.length) return 0;
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(MEDIA_STORE_NAME, "readwrite");
    const store = transaction.objectStore(MEDIA_STORE_NAME);
    removable.forEach((id) => store.delete(id));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("media could not be removed"));
  });
  removable.forEach(invalidateMediaObjectUrl);
  removable.forEach((id) => void removeStoredThumbBlob(id));
  return removable.length;
}

async function downloadAndCacheServerMedia(media: CanvasMedia, projectId?: string) {
  try {
    if (await readMedia(media.id)) return true;
    const kind = mediaKind(media.mimeType);
    if (!kind) return false;
    const response = await fetch(mediaContentPath(media.id, projectId), {
      // same-origin：同源段带 Cookie 过鉴权，302 到 R2 预签名地址后浏览器自动
      // 去掉凭据；带 include 跟随跳转会被 R2 的 CORS（无 ACAC）拒绝。
      credentials: "same-origin",
      signal: AbortSignal.timeout(MEDIA_CACHE_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const blob = await boundedResponseBlob(response, localMediaMaxBytes[kind], media.mimeType);
    const validated =
      kind === "image" ? await validateImageBlob(blob) : await validateMediaBlob(blob, kind);
    await writeStoredMedia({
      ...media,
      mimeType: validated.mimeType,
      size: validated.blob.size,
      width: media.width ?? validated.width ?? null,
      height: media.height ?? validated.height ?? null,
      durationMs: media.durationMs ?? validated.durationMs ?? null,
      blob: validated.blob,
      storedAt: Date.now(),
    });
    return true;
  } catch {
    return false;
  }
}

async function writeStoredMedia(media: StoredMedia) {
  const database = await openMediaDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(MEDIA_STORE_NAME, "readwrite");
    transaction.objectStore(MEDIA_STORE_NAME).put(media);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("媒体保存失败"));
  });
  void requestPersistentMediaStorage();
}

async function boundedResponseBlob(response: Response, maxBytes: number, fallbackMimeType: string) {
  const declaredSize = response.headers.get("Content-Length");
  if (declaredSize && /^\d+$/.test(declaredSize) && Number(declaredSize) > maxBytes) {
    throw new Error("Media exceeds the local cache limit");
  }
  const mimeType =
    response.headers.get("Content-Type")?.split(";", 1)[0]?.trim() || fallbackMimeType;
  if (!response.body) {
    const blob = await response.blob();
    if (blob.size > maxBytes) throw new Error("Media exceeds the local cache limit");
    return blob.type ? blob : new Blob([blob], { type: mimeType });
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Media exceeds the local cache limit");
    }
    const copy = new Uint8Array(value.byteLength);
    copy.set(value);
    chunks.push(copy);
  }
  return new Blob(chunks, { type: mimeType });
}

function mediaKind(mimeType: string) {
  if (mimeType.startsWith("image/")) return "image" as const;
  if (mimeType.startsWith("video/")) return "video" as const;
  if (mimeType.startsWith("audio/")) return "audio" as const;
  return null;
}

function assertLocalMediaSize(size: number, kind: keyof typeof localMediaMaxBytes) {
  if (size <= localMediaMaxBytes[kind]) return;
  throw new Error(
    `Media exceeds the ${Math.round(localMediaMaxBytes[kind] / 1024 / 1024)} MB local limit`,
  );
}
