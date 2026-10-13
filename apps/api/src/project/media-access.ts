import type { Pool } from "pg";

export interface CloudProjectMediaValidator {
  validateReadyMedia(
    ownerId: string,
    projectId: string,
    mediaIds: readonly string[],
  ): Promise<boolean>;
  /**
   * 保存成功后把该项目的素材绑定收敛到文档仍引用的素材集合：节点删除后，
   * 素材不再显示「已被引用」，转为可清理。keepMediaIds 之外的绑定行会被移除。
   */
  reconcileBindings?(
    ownerId: string,
    projectId: string,
    keepMediaIds: readonly string[],
  ): Promise<void>;
}

export class PostgresCloudProjectMediaValidator implements CloudProjectMediaValidator {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async validateReadyMedia(
    ownerId: string,
    projectId: string,
    mediaIds: readonly string[],
  ): Promise<boolean> {
    const uniqueIds = [...new Set(mediaIds)];
    if (uniqueIds.length === 0) return true;

    const result = await this.pool.query<{ id: string }>(
      `SELECT DISTINCT media.id
       FROM canvas_media AS media
       JOIN canvas_media_project_bindings AS binding
         ON binding.owner_id = media.owner_id
        AND binding.media_id = media.id
       WHERE media.owner_id = $1
         AND binding.project_id = $2
         AND media.id = ANY($3::text[])
         AND media.status = 'ready'`,
      [ownerId, projectId, uniqueIds],
    );
    const foundIds = new Set(result.rows.map((row) => row.id));
    return uniqueIds.every((id) => foundIds.has(id));
  }

  async reconcileBindings(
    ownerId: string,
    projectId: string,
    keepMediaIds: readonly string[],
  ): Promise<void> {
    await this.pool.query(
      `DELETE FROM canvas_media_project_bindings
       WHERE owner_id = $1 AND project_id = $2
         AND NOT (media_id = ANY($3::text[]))`,
      [ownerId, projectId, [...new Set(keepMediaIds)]],
    );
  }
}
