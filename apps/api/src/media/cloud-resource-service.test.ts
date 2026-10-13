import { describe, expect, it } from "vitest";

import { CloudResourceService } from "./cloud-resource-service.js";
import type { CloudResourceStore, OwnedCloudMedia } from "./cloud-resource-store.js";
import type { MediaEvictionItem, MediaObjectStore, MediaRecord } from "./types.js";

const OWNER = "owner-1";
const NOW = "2026-01-01T00:00:00.000Z";

class MemoryCloudResourceStore implements CloudResourceStore {
  items: OwnedCloudMedia[] = [];

  async listOwnedResources(ownerId: string) {
    return this.items
      .filter((item) => item.media.ownerId === ownerId)
      .map((item) => ({
        media: structuredClone(item.media),
        projectIds: [...item.projectIds],
        orphaned: item.orphaned,
      }));
  }

  async listProjectBoundMediaIds(ownerId: string, projectId: string) {
    return this.items
      .filter((item) => item.media.ownerId === ownerId && item.projectIds.includes(projectId))
      .map((item) => item.media.id);
  }

  async listOwnersWithOrphanedMedia() {
    return [
      ...new Set(
        this.items
          .filter((item) => item.media.status !== "failed" && item.orphaned)
          .map((item) => item.media.ownerId),
      ),
    ];
  }

  async deleteUnboundMedia(ownerId: string, ids: readonly string[]): Promise<MediaEvictionItem[]> {
    const target = new Set(ids);
    const removed: MediaEvictionItem[] = [];
    this.items = this.items.filter((item) => {
      if (
        item.media.ownerId !== ownerId ||
        !target.has(item.media.id) ||
        item.projectIds.length > 0
      )
        return true;
      removed.push({ id: item.media.id, objectKey: item.media.objectKey });
      return false;
    });
    return removed;
  }
}

class MemoryObjectStore implements MediaObjectStore {
  removed: string[] = [];
  async write() {
    throw new Error("not used");
  }
  async withLocalFile<T>(): Promise<T> {
    throw new Error("not used");
  }
  async open(): Promise<never> {
    throw new Error("not used");
  }
  async remove(key: string) {
    this.removed.push(key);
  }
}

function readyMedia(id: string, size: number): MediaRecord {
  return {
    id,
    ownerId: OWNER,
    projectId: null,
    source: "upload",
    idempotencyKey: null,
    objectKey: `media/${id.slice(0, 2)}/${id}`,
    kind: "image",
    name: `${id}.png`,
    declaredMimeType: "image/png",
    detectedMimeType: "image/png",
    expectedSize: size,
    size,
    expectedSha256: null,
    sha256: "a".repeat(64),
    width: 100,
    height: 100,
    durationMs: null,
    status: "ready",
    error: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    uploadExpiresAt: NOW,
    readyAt: NOW,
  };
}

const ORPHAN_ID = "11111111-1111-4111-8111-111111111111";
const ACTIVE_ID = "33333333-3333-4333-8333-333333333333";
const BOUND_ID = "22222222-2222-4222-8222-222222222222";

function setup() {
  const store = new MemoryCloudResourceStore();
  const objects = new MemoryObjectStore();
  store.items = [
    // 画布已删除的遗留素材：可安全清理。
    { media: readyMedia(ORPHAN_ID, 120), projectIds: [], orphaned: true },
    // 未绑定但在用（本地画布/工作台直传，用户唯一副本）：不可清理。
    { media: readyMedia(ACTIVE_ID, 50), projectIds: [], orphaned: false },
    { media: readyMedia(BOUND_ID, 80), projectIds: ["project-a"], orphaned: false },
  ];
  return { store, objects, service: new CloudResourceService(store, objects) };
}

describe("CloudResourceService", () => {
  it("splits usage into bound / orphaned and ignores active unbound media", async () => {
    const { service } = setup();
    const result = await service.list(OWNER, 300);

    expect(result.items).toHaveLength(3);
    expect(result.usage).toMatchObject({
      usedBytes: 250,
      quotaBytes: 300,
      boundBytes: 80,
      orphanBytes: 120,
      totalCount: 3,
      orphanCount: 1,
    });
    expect(result.items.find((item) => item.id === ACTIVE_ID)?.orphaned).toBe(false);
    expect(result.items.find((item) => item.id === ORPHAN_ID)?.orphaned).toBe(true);
  });

  it("cleans only deleted-project orphans and reports referenced/active ones as skipped", async () => {
    const { service, objects } = setup();
    const result = await service.cleanup(
      OWNER,
      [ORPHAN_ID, ACTIVE_ID, BOUND_ID, "44444444-4444-4444-8444-444444444444"],
      300,
    );

    expect(result.deleted.map((item) => item.id)).toEqual([ORPHAN_ID]);
    expect(result.freedBytes).toBe(120);
    expect(result.usage.orphanBytes).toBe(0);
    expect(result.usage.boundBytes).toBe(80);
    expect(result.skipped).toEqual([
      { id: ACTIVE_ID, reason: "active" },
      { id: BOUND_ID, reason: "referenced" },
      { id: "44444444-4444-4444-8444-444444444444", reason: "missing" },
    ]);
    expect(objects.removed).toEqual([
      `media/${ORPHAN_ID.slice(0, 2)}/${ORPHAN_ID}`,
      `media/${ORPHAN_ID.slice(0, 2)}/${ORPHAN_ID}-thumb`,
    ]);
  });

  it("releases media that are no longer bound after a project delete", async () => {
    const { service, store } = setup();
    const boundIds = await service.listProjectBoundMediaIds(OWNER, "project-a");
    expect(boundIds).toEqual([BOUND_ID]);

    // 模拟项目删除：绑定关系级联移除，但 canvas_media 记录还在（project_id 仍指向已删项目）。
    store.items = store.items.map((item) =>
      item.media.id === BOUND_ID ? { ...item, projectIds: [], orphaned: true } : item,
    );
    const released = await service.releaseUnbound(OWNER, [...boundIds, ORPHAN_ID]);

    expect(released).toBe(2);
    const remaining = await service.list(OWNER, 300);
    // 未被项目绑定、但仍在使用的素材（ACTIVE_ID）必须保留。
    expect(remaining.items.map((item) => item.id)).toEqual([ACTIVE_ID]);
    expect(remaining.usage.usedBytes).toBe(50);
  });

  it("forceUnbound also cleans unbound-but-active media, never referenced ones", async () => {
    const { service } = setup();
    const result = await service.cleanup(
      OWNER,
      [ACTIVE_ID, BOUND_ID, "44444444-4444-4444-8444-444444444444"],
      300,
      { forceUnbound: true },
    );

    // 「使用中」素材经用户显式确认后随 forceUnbound 删除；绑定项照旧跳过。
    expect(result.deleted.map((item) => item.id)).toEqual([ACTIVE_ID]);
    expect(result.freedBytes).toBe(50);
    expect(result.skipped).toEqual([
      { id: BOUND_ID, reason: "referenced" },
      { id: "44444444-4444-4444-8444-444444444444", reason: "missing" },
    ]);
  });
});
