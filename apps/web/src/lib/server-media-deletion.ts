import type { CanvasMedia } from "@weftcanvas/contracts";

import { deleteServerMedia } from "./api-client";
import { removeMedia } from "./media-store";

// 删除节点后延迟释放服务端素材：给撤销/恢复留出窗口，避免误删刚被用户
// 恢复的内容。
const SERVER_MEDIA_DELETE_GRACE_MS = 45_000;

const pendingDeletions = new Map<string, number>();

/**
 * 安排删除一个不再被任何节点引用的服务端素材（释放账号存储配额）。
 * 已在等待队列中的 id 会被忽略；45 秒内重新引用（撤销/恢复/复制粘贴）
 * 可通过 cancelServerMediaDeletion 取消。
 */
export function scheduleServerMediaDeletion(media: CanvasMedia | null | undefined) {
  if (!media || media.source !== "server" || !media.id) return;
  if (typeof window === "undefined") return;
  if (pendingDeletions.has(media.id)) return;
  const timer = window.setTimeout(() => {
    pendingDeletions.delete(media.id);
    void deleteServerMedia(media.id)
      .then(() => removeMedia(media.id))
      .catch(() => undefined);
  }, SERVER_MEDIA_DELETE_GRACE_MS);
  pendingDeletions.set(media.id, timer);
}

export function cancelServerMediaDeletion(mediaId: string) {
  const timer = pendingDeletions.get(mediaId);
  if (timer === undefined) return;
  window.clearTimeout(timer);
  pendingDeletions.delete(mediaId);
}
