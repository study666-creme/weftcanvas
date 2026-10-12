import {
  canvasProjectSchema,
  type CanvasMedia,
  type CanvasProject,
  type MediaKind,
} from "@weftcanvas/contracts";

import { useCanvasStore } from "../state/canvas-store";
import {
  CanvasApiError,
  createMediaUpload,
  fetchMediaMetadata,
  uploadMediaBlob,
} from "./api-client";
import { cloudUploadsSkipped } from "./cloud-media-preference";
import { cacheServerMedia, readMedia } from "./media-store";

export class CloudProjectMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudProjectMediaError";
  }
}

export async function prepareProjectMediaForCloud(
  value: CanvasProject,
  options: { applyToCanvas?: boolean } = {},
) {
  const project = canvasProjectSchema.parse(structuredClone(value));
  // 用户在“清理云端资源”里开启了“不再保存到云端”：文档照常同步，素材保持本地
  // （source:"local"），不再新建云端素材占用配额。
  if (cloudUploadsSkipped()) return project;
  const pending = new Map<string, { kind: MediaKind; media: CanvasMedia; nodeIds: string[] }>();
  project.nodes.forEach((node) => {
    const media = node.data.media;
    const kind = mediaKind(node.data.kind);
    if (!media || !kind) return;
    const existing = pending.get(media.id);
    if (existing) existing.nodeIds.push(node.id);
    else pending.set(media.id, { kind, media, nodeIds: [node.id] });
  });
  if (!pending.size) return project;

  const uploads = new Map<string, string>();
  await mapWithConcurrency([...pending], 2, async ([mediaId, item]) => {
    const durableId = durableCanvasMediaId(item.media.serverId);
    if (durableId) {
      try {
        const existing = await fetchMediaMetadata(durableId, project.id);
        if (existing.status !== "ready" || existing.kind !== item.kind) {
          throw new CloudProjectMediaError("云端素材尚未完成处理");
        }
        uploads.set(mediaId, durableId);
        return;
      } catch (error) {
        if (!(error instanceof CanvasApiError) || error.status !== 404) throw error;
        // Personal native-generation results and pre-binding historical rows
        // are copied into this project below. A row bound to another project
        // remains unreadable unless its bytes are already cached locally.
      }
    }
    let stored = await readMedia(mediaId);
    if (!stored && item.media.source === "server") {
      await cacheServerMedia(item.media);
      stored = await readMedia(mediaId);
    }
    if (!stored) throw new CloudProjectMediaError("本地素材已不在当前浏览器中，无法保存到云端");
    const intent = await createMediaUpload({
      kind: item.kind,
      name: stored.name,
      mimeType: stored.mimeType,
      size: stored.blob.size,
      idempotencyKey: await mediaUploadRequestKey(project.id, mediaId),
      projectId: project.id,
    });
    const ready = intent.upload
      ? await uploadMediaBlob(intent.media, intent.upload, stored.blob)
      : intent.media;
    if (ready.status !== "ready") throw new CloudProjectMediaError("素材尚未完成云端处理");
    uploads.set(mediaId, ready.id);
  });

  project.nodes = project.nodes.map((node) => {
    const media = node.data.media;
    const serverId = media ? uploads.get(media.id) : undefined;
    if (!media || !serverId) return node;
    return { ...node, data: { ...node.data, media: { ...media, serverId } } };
  });

  const canvas = useCanvasStore.getState();
  if (options.applyToCanvas !== false && canvas.projectId === project.id) {
    project.nodes.forEach((node) => {
      const media = node.data.media;
      if (!media?.serverId) return;
      const current = useCanvasStore.getState().nodes.find((item) => item.id === node.id)
        ?.data.media;
      if (current?.id === media.id && current.serverId !== media.serverId) {
        useCanvasStore
          .getState()
          .updateNodeData(node.id, { media: { ...current, serverId: media.serverId } }, false);
      }
    });
  }
  return canvasProjectSchema.parse(project);
}

async function mediaUploadRequestKey(projectId: string, localId: string) {
  if (!crypto.subtle) return `cloud-upload:${crypto.randomUUID()}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${projectId}:${localId}`),
  );
  const hex = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `cloud-upload:${hex}`;
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  action: (item: T) => Promise<void>,
) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      if (item !== undefined) await action(item);
    }
  });
  await Promise.all(workers);
}

function mediaKind(kind: CanvasProject["nodes"][number]["data"]["kind"]): MediaKind | null {
  return kind === "image" || kind === "video" || kind === "audio" ? kind : null;
}

function durableCanvasMediaId(serverId: string | null) {
  return serverId && !serverId.startsWith("phm_") ? serverId : null;
}
