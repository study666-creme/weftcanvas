import type { Pool } from "pg";

export interface CloudProjectMediaValidator {
  validateReadyMedia(
    ownerId: string,
    projectId: string,
    mediaIds: readonly string[],
  ): Promise<boolean>;
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
}
