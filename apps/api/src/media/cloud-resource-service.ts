import type { CloudResource, CloudResourceUsage } from "@kachang/contracts";

import type { CloudResourceStore, OwnedCloudMedia } from "./cloud-resource-store.js";
import { thumbObjectKey } from "./service.js";
import type { MediaEvictionItem, MediaObjectStore, MediaRecord } from "./types.js";

export type CloudResourceSkippedReason = "referenced" | "active" | "missing";

export type CloudResourceSkipped = {
  id: string;
  reason: CloudResourceSkippedReason;
};

export type CloudResourceCleanupResult = {
  deleted: CloudResource[];
  skipped: CloudResourceSkipped[];
  freedBytes: number;
  usage: CloudResourceUsage;
};

/**
 * 云端素材的“盘点 / 自选清理”服务。与 MediaService 分开：清理是运维型批量操作，
 * 只关心账号内素材的绑定关系与字节占用，复用 MediaObjectStore 释放对象（含缩略图）。
 */
export class CloudResourceService {
  constructor(
    private readonly store: CloudResourceStore,
    private readonly objects: MediaObjectStore,
  ) {}

  async list(ownerId: string, quotaBytes: number) {
    const resources = await this.store.listOwnedResources(ownerId);
    const items = resources.filter((item) => item.media.status !== "failed").map(toCloudResource);
    return { items, usage: buildUsage(resources, quotaBytes) };
  }

  /**
   * 自选清理：只删除“曾被云项目绑定、但项目已删除”的遗留素材。被引用、仍被本地
   * 画布/工作台使用（未绑定但非遗留）、或不存在的 id 记录在 skipped 里返回，
   * 绝不静默破坏工程引用或用户唯一副本。
   */
  async cleanup(
    ownerId: string,
    requestedIds: readonly string[],
    quotaBytes: number,
  ): Promise<CloudResourceCleanupResult> {
    const resources = await this.store.listOwnedResources(ownerId);
    const byId = new Map(resources.map((item) => [item.media.id, item]));
    const deleted: CloudResource[] = [];
    const skipped: CloudResourceSkipped[] = [];
    const deletable: string[] = [];

    for (const id of new Set(requestedIds)) {
      const item = byId.get(id);
      if (!item) {
        skipped.push({ id, reason: "missing" });
        continue;
      }
      if (item.projectIds.length > 0) {
        skipped.push({ id, reason: "referenced" });
        continue;
      }
      if (!item.orphaned) {
        skipped.push({ id, reason: "active" });
        continue;
      }
      deletable.push(id);
    }

    const evicted = await this.store.deleteUnboundMedia(ownerId, deletable);
    await this.releaseObjects(evicted);
    const evictedIds = new Set(evicted.map((item) => item.id));
    let freedBytes = 0;
    for (const id of deletable) {
      if (!evictedIds.has(id)) {
        // 并发下刚被别的请求删除：按已清理上报，不制造失败噪音。
        continue;
      }
      const item = byId.get(id);
      if (!item) continue;
      freedBytes += countedSize(item.media);
      deleted.push(toCloudResource(item));
    }

    const remaining = await this.store.listOwnedResources(ownerId);
    return { deleted, skipped, freedBytes, usage: buildUsage(remaining, quotaBytes) };
  }

  /**
   * 项目删除后释放其独占素材：调用方需在删除项目前用
   * listProjectBoundMediaIds 采集 id，删除后调用本方法。
   */
  async releaseUnbound(ownerId: string, mediaIds: readonly string[]) {
    if (!mediaIds.length) return 0;
    const evicted = await this.store.deleteUnboundMedia(ownerId, mediaIds);
    await this.releaseObjects(evicted);
    return evicted.length;
  }

  listProjectBoundMediaIds(ownerId: string, projectId: string) {
    return this.store.listProjectBoundMediaIds(ownerId, projectId);
  }

  private async releaseObjects(evicted: readonly MediaEvictionItem[]) {
    // 数据库记录已删；对象删除尽力而为，失败不影响配额回收。
    await Promise.all(evicted.flatMap((item) => [
      this.objects.remove(item.objectKey).catch(() => undefined),
      this.objects.remove(thumbObjectKey(item.objectKey)).catch(() => undefined),
    ]));
  }
}

function toCloudResource(item: OwnedCloudMedia): CloudResource {
  const media = item.media;
  return {
    id: media.id,
    kind: media.kind,
    name: media.name,
    mimeType: media.detectedMimeType ?? media.declaredMimeType,
    size: countedSize(media),
    status: media.status,
    source: media.source,
    width: media.width,
    height: media.height,
    durationMs: media.durationMs,
    projectIds: [...item.projectIds],
    orphaned: item.orphaned,
    createdAt: media.createdAt,
    updatedAt: media.updatedAt,
  };
}

/** 与 usageQuery 一致：只有 pending/uploading/ready 计入配额，失败记录不计。 */
function countedSize(media: MediaRecord) {
  if (media.status === "failed") return 0;
  return media.size ?? media.expectedSize;
}

function buildUsage(resources: readonly OwnedCloudMedia[], quotaBytes: number): CloudResourceUsage {
  let usedBytes = 0;
  let boundBytes = 0;
  let orphanBytes = 0;
  let totalCount = 0;
  let orphanCount = 0;
  for (const item of resources) {
    if (item.media.status === "failed") continue;
    const size = countedSize(item.media);
    usedBytes += size;
    totalCount += 1;
    if (item.projectIds.length > 0) {
      boundBytes += size;
    } else if (item.orphaned) {
      // 只有“项目已删除”的遗留素材算可释放的孤立资源；未绑定但在用的素材不算。
      orphanBytes += size;
      orphanCount += 1;
    }
  }
  return {
    usedBytes,
    quotaBytes: Math.max(0, quotaBytes),
    boundBytes,
    orphanBytes,
    totalCount,
    orphanCount,
  };
}
