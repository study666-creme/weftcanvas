import type { CanvasMedia } from "@weftcanvas/contracts";

import { CanvasApiError, deleteServerMedia } from "./api-client";
import { removeMedia } from "./media-store";
import { readAllProjects } from "./project-library";

// 删除节点后延迟释放服务端素材：给撤销/恢复留出窗口，避免误删刚被用户
// 恢复的内容。
const SERVER_MEDIA_DELETE_GRACE_MS = 45_000;
// 网络/鉴权失败后的重试间隔：不轰炸服务端，但保证标签页开着时迟早清掉。
const SERVER_MEDIA_DELETE_RETRY_MS = 5 * 60_000;
// 待删队列落 localStorage：45 秒定时器随刷新/关页丢失曾让素材永久卡在
// 「使用中」占配额，持久化后下次启动/上线时继续完成释放。
const PENDING_DELETIONS_STORAGE_KEY = "weftcanvas:pending-server-media-deletions:v1";

/** mediaId → 计划执行删除的时间戳。 */
type PendingDeletionQueue = Record<string, number>;

const pendingTimers = new Map<string, number>();
let recoveryInstalled = false;
let flushInFlight: Promise<void> | null = null;

function readQueue(storage: Storage): PendingDeletionQueue {
  try {
    const raw = storage.getItem(PENDING_DELETIONS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const queue: PendingDeletionQueue = {};
    for (const [id, scheduledAt] of Object.entries(parsed)) {
      if (typeof scheduledAt === "number" && Number.isFinite(scheduledAt)) queue[id] = scheduledAt;
    }
    return queue;
  } catch {
    return {};
  }
}

function writeQueue(storage: Storage, queue: PendingDeletionQueue) {
  try {
    if (Object.keys(queue).length)
      storage.setItem(PENDING_DELETIONS_STORAGE_KEY, JSON.stringify(queue));
    else storage.removeItem(PENDING_DELETIONS_STORAGE_KEY);
  } catch {
    // 隐私模式/配额满时退化为纯内存定时器：行为不劣于修复前。
  }
}

function storageOrNull(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * 本地项目库（含当前项目最新落盘文档）里是否还有节点引用该服务端素材。
 * 剪辑时间线的 clip.mediaId 也算引用（服务端素材 id 即 serverId）。
 */
function isReferencedByLocalProjects(mediaId: string): boolean {
  try {
    return readAllProjects().some((project) =>
      project.nodes.some(
        (node) =>
          node.data.media?.id === mediaId ||
          node.data.media?.serverId === mediaId ||
          (node.data.edit?.clips.some((clip) => clip.mediaId === mediaId) ?? false),
      ),
    );
  } catch {
    // 读不动项目库时宁可当作仍被引用，也不误删。
    return true;
  }
}

async function attemptServerMediaDeletion(mediaId: string) {
  const storage = storageOrNull();
  if (isReferencedByLocalProjects(mediaId)) {
    // 文档还没落盘或素材在别的项目里被重新引用：推后再查，不删。
    if (storage) {
      const queue = readQueue(storage);
      if (queue[mediaId] !== undefined) {
        queue[mediaId] = Date.now() + SERVER_MEDIA_DELETE_GRACE_MS;
        writeQueue(storage, queue);
      }
    }
    return;
  }
  try {
    await deleteServerMedia(mediaId);
    await removeMedia(mediaId);
  } catch (cause) {
    if (cause instanceof CanvasApiError && (cause.status === 404 || cause.status === 409)) {
      // 404 已不存在、409 仍被云项目绑定（保存收敛绑定后面板会变「可清理」）：
      // 出队即可，本地缓存随 404 一并回收。
      if (cause.status === 404) await removeMedia(mediaId).catch(() => undefined);
    } else {
      // 网络/401/5xx：保留队列并推迟到下一轮重试。
      if (storage) {
        const queue = readQueue(storage);
        queue[mediaId] = Date.now() + SERVER_MEDIA_DELETE_RETRY_MS;
        writeQueue(storage, queue);
      }
      return;
    }
  }
  if (storage) {
    const queue = readQueue(storage);
    delete queue[mediaId];
    writeQueue(storage, queue);
  }
}

/**
 * 安排删除一个不再被任何节点引用的服务端素材（释放账号存储配额）。
 * 已在等待队列中的 id 会被忽略；宽限期内重新引用（撤销/恢复/复制粘贴）
 * 可通过 cancelServerMediaDeletion 取消。计划同时写入 localStorage，
 * 刷新/关页后由 flushPendingServerMediaDeletions 续跑。
 */
export function scheduleServerMediaDeletion(media: CanvasMedia | null | undefined) {
  if (!media || media.source !== "server" || !media.id) return;
  const storage = storageOrNull();
  if (!storage) return;
  if (pendingTimers.has(media.id)) return;
  const queue = readQueue(storage);
  if (queue[media.id] === undefined) queue[media.id] = Date.now() + SERVER_MEDIA_DELETE_GRACE_MS;
  writeQueue(storage, queue);
  const timer = window.setTimeout(() => {
    pendingTimers.delete(media.id);
    void attemptServerMediaDeletion(media.id);
  }, SERVER_MEDIA_DELETE_GRACE_MS);
  pendingTimers.set(media.id, timer);
}

export function cancelServerMediaDeletion(mediaId: string) {
  const timer = pendingTimers.get(mediaId);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    pendingTimers.delete(mediaId);
  }
  const storage = storageOrNull();
  if (!storage) return;
  const queue = readQueue(storage);
  if (queue[mediaId] !== undefined) {
    delete queue[mediaId];
    writeQueue(storage, queue);
  }
}

/**
 * 续跑上次会话遗留的待删素材：宽限期已过的直接执行；仍在宽限期内的补挂
 * 内存定时器。队列非空时安排周期性重试（标签页开着就迟早完成）。
 * 幂等且并发安全：同一时刻只有一次 flush 在飞。
 */
export function flushPendingServerMediaDeletions(): Promise<void> {
  if (flushInFlight) return flushInFlight;
  const storage = storageOrNull();
  if (!storage) return Promise.resolve();
  const run = (async () => {
    const queue = readQueue(storage);
    const ids = Object.entries(queue);
    if (!ids.length) return;
    const now = Date.now();
    await Promise.all(
      ids.map(([id, scheduledAt]) => {
        if (scheduledAt <= now) {
          if (pendingTimers.has(id)) return; // 本标签页已有在跑的定时器。
          return attemptServerMediaDeletion(id);
        }
        if (!pendingTimers.has(id)) {
          const timer = window.setTimeout(() => {
            pendingTimers.delete(id);
            void attemptServerMediaDeletion(id);
          }, scheduledAt - now);
          pendingTimers.set(id, timer);
        }
        return Promise.resolve();
      }),
    );
    // 仍有残留（重试/宽限中）→ 安排下一轮；队列空时不留定时器。
    if (Object.keys(readQueue(storage)).length) {
      window.setTimeout(() => {
        flushInFlight = null;
        void flushPendingServerMediaDeletions();
      }, SERVER_MEDIA_DELETE_RETRY_MS);
    }
  })().finally(() => {
    flushInFlight = null;
  });
  flushInFlight = run;
  return run;
}

/**
 * 应用启动时安装释放恢复：补跑遗留队列，并在网络恢复/标签页重新可见时
 * 再试。main.tsx 调用一次即可，重复调用无副作用。
 */
export function installServerMediaDeletionRecovery() {
  if (recoveryInstalled || typeof window === "undefined") return;
  recoveryInstalled = true;
  window.addEventListener("online", () => void flushPendingServerMediaDeletions());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void flushPendingServerMediaDeletions();
  });
  // 稍候再首跑：给身份/项目库水合留出时间，避免刚启动就与登录流程抢请求。
  window.setTimeout(() => void flushPendingServerMediaDeletions(), 2_000);
}
