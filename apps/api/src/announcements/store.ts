import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { announcementLevelSchema, type PublicAnnouncement } from "@weftcanvas/contracts";
import { z } from "zod";

/**
 * 站点公告存储：运营后台是唯一写入方，公开接口只读。
 *
 * 可见性（启用 / 定时发布时间 / 过期）在读取时现算，不落进存储 —— 保存即生效，
 * 到点自动出现或消失，不需要任何定时任务。存储与模型覆盖同款：原子写 + 进程内
 * 缓存；文件缺失或损坏时按"没有公告"处理，画布侧静默不展示。
 */
export const adminAnnouncementSchema = z
  .object({
    id: z.string().min(1).max(64),
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(4000),
    level: announcementLevelSchema.default("info"),
    pinned: z.boolean().default(false),
    /** 停用的条目保留在后台，但不会发给画布前端。 */
    enabled: z.boolean().default(true),
    publishedAt: z.string().datetime({ offset: true }),
    /** 过期时间；null = 长期有效。 */
    expiresAt: z.string().datetime({ offset: true }).nullable().default(null),
  })
  .strict();

export const announcementCollectionSchema = z
  .object({ items: z.array(adminAnnouncementSchema).max(50) })
  .strict();

export type AdminAnnouncement = z.infer<typeof adminAnnouncementSchema>;
export type AnnouncementCollection = z.infer<typeof announcementCollectionSchema>;

export const EMPTY_ANNOUNCEMENTS: AnnouncementCollection = { items: [] };

export interface AnnouncementStore {
  load(): Promise<AnnouncementCollection>;
  save(collection: AnnouncementCollection): Promise<void>;
}

/** File-backed store with an in-process cache; the admin route is the only writer. */
export class JsonAnnouncementStore implements AnnouncementStore {
  private cache: AnnouncementCollection | null = null;

  constructor(private readonly filePath: string) {}

  async load() {
    if (this.cache) return this.cache;
    try {
      this.cache = announcementCollectionSchema.parse(
        JSON.parse(await readFile(this.filePath, "utf8")),
      );
    } catch {
      this.cache = { items: [] };
    }
    return this.cache;
  }

  async save(collection: AnnouncementCollection) {
    const parsed = announcementCollectionSchema.parse(collection);
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(parsed, null, 2), "utf8");
    await rename(temporary, this.filePath);
    this.cache = parsed;
  }
}

export class MemoryAnnouncementStore implements AnnouncementStore {
  private value: AnnouncementCollection;

  constructor(initial: AnnouncementCollection = { items: [] }) {
    this.value = structuredClone(announcementCollectionSchema.parse(initial));
  }

  async load() {
    return structuredClone(this.value);
  }

  async save(collection: AnnouncementCollection) {
    this.value = structuredClone(announcementCollectionSchema.parse(collection));
  }
}

/**
 * 公开视图：只发启用、已到发布时间、未过期的条目；置顶在前，其余按发布时间
 * 倒序。同一时刻两条公告的排序是稳定的（id 兜底），后台与前端看到的顺序一致。
 */
export function publicAnnouncements(
  collection: AnnouncementCollection,
  now: Date = new Date(),
): PublicAnnouncement[] {
  const at = now.getTime();
  return collection.items
    .filter((item) => item.enabled)
    .filter((item) => Date.parse(item.publishedAt) <= at)
    .filter((item) => item.expiresAt === null || Date.parse(item.expiresAt) > at)
    .sort(
      (left, right) =>
        Number(right.pinned) - Number(left.pinned) ||
        Date.parse(right.publishedAt) - Date.parse(left.publishedAt) ||
        left.id.localeCompare(right.id),
    )
    .map(({ enabled: _enabled, expiresAt: _expiresAt, ...item }) => item);
}
