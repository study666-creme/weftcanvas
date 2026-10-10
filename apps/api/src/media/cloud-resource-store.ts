import type { MediaEvictionItem, MediaRecord } from "./types.js";

export type OwnedCloudMedia = {
  media: MediaRecord;
  /** 引用该素材的云项目 id（空数组代表未被任何云项目绑定）。 */
  projectIds: string[];
  /** 曾被某个云项目绑定、但该项目已删除的遗留素材（唯一可安全清理的类别）。 */
  orphaned: boolean;
};

/**
 * 云端资源清理所需的元数据读取/删除能力。由 PostgresMediaMetadataStore 实现；
 * 与 MediaMetadataStore 分开是因为测试用的内存实现只覆盖上传流程，不需要这些运维查询。
 */
export interface CloudResourceStore {
  listOwnedResources(ownerId: string): Promise<OwnedCloudMedia[]>;
  /** 该项目当前绑定的素材 id（项目删除前采集，删除后据此释放独占素材）。 */
  listProjectBoundMediaIds(ownerId: string, projectId: string): Promise<string[]>;
  /** 存在“已删除项目遗留素材”的 owner，供运维清理遍历。 */
  listOwnersWithOrphanedMedia(): Promise<string[]>;
  /** 只删除当前没有任何项目绑定的素材，返回被删记录的对象键以便释放字节。 */
  deleteUnboundMedia(ownerId: string, ids: readonly string[]): Promise<MediaEvictionItem[]>;
}
