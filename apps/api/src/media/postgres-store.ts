import type { Pool, PoolClient } from "pg";

import {
  mediaStorageQuotaSchema,
  mediaRecordSchema,
  type CreateMediaResult,
  type DeleteOwnedMediaResult,
  type MediaEvictionItem,
  type MediaMetadataStore,
  type MediaRecord,
  type MediaStorageQuota,
} from "./types.js";
import type { CloudResourceStore, OwnedCloudMedia } from "./cloud-resource-store.js";
import { ensureCloudPrincipal } from "../project/principal.js";

type MediaRow = { record: unknown; revision: number };
type CountRow = { count: string | number };

const DEFAULT_MAX_ACTIVE_RECORDS = 64;
const DEFAULT_MAX_FAILED_RECORDS = 128;
const DEFAULT_FAILED_RETENTION_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_MAX_CREATED_RECORDS_PER_WINDOW = 120;
const DEFAULT_CREATION_WINDOW_MS = 60_000;
const MAX_EVICTION_CANDIDATES = 512;

type PostgresMediaMetadataStoreOptions = {
  maxActiveRecords?: number;
  maxFailedRecords?: number;
  failedRetentionMs?: number;
  maxCreatedRecordsPerWindow?: number;
  creationWindowMs?: number;
};

export class PostgresMediaMetadataStore implements MediaMetadataStore, CloudResourceStore {
  private readonly maxActiveRecords: number;
  private readonly maxFailedRecords: number;
  private readonly failedRetentionMs: number;
  private readonly maxCreatedRecordsPerWindow: number;
  private readonly creationWindowMs: number;

  constructor(
    private readonly pool: Pool,
    options: PostgresMediaMetadataStoreOptions = {},
  ) {
    this.maxActiveRecords = positiveInteger(
      options.maxActiveRecords ?? DEFAULT_MAX_ACTIVE_RECORDS,
      "maxActiveRecords",
    );
    this.maxFailedRecords = positiveInteger(
      options.maxFailedRecords ?? DEFAULT_MAX_FAILED_RECORDS,
      "maxFailedRecords",
    );
    this.failedRetentionMs = positiveInteger(
      options.failedRetentionMs ?? DEFAULT_FAILED_RETENTION_MS,
      "failedRetentionMs",
    );
    this.maxCreatedRecordsPerWindow = positiveInteger(
      options.maxCreatedRecordsPerWindow ?? DEFAULT_MAX_CREATED_RECORDS_PER_WINDOW,
      "maxCreatedRecordsPerWindow",
    );
    this.creationWindowMs = positiveInteger(
      options.creationWindowMs ?? DEFAULT_CREATION_WINDOW_MS,
      "creationWindowMs",
    );
  }

  async findByIdempotency(ownerId: string, idempotencyKey: string) {
    const result = await this.pool.query<MediaRow>(
      "SELECT record, revision FROM canvas_media WHERE owner_id = $1 AND idempotency_key = $2",
      [ownerId, idempotencyKey],
    );
    return result.rows[0] ? parseMedia(result.rows[0]) : null;
  }

  async getById(id: string) {
    const result = await this.pool.query<MediaRow>(
      "SELECT record, revision FROM canvas_media WHERE id = $1",
      [id],
    );
    return result.rows[0] ? parseMedia(result.rows[0]) : null;
  }

  /**
   * 维护存储宽限记录（与配额检查同事务调用）：用量超出配额时幂等 upsert
   * （已存在且 deadline 未过则不重置 7 天窗口，只刷新用量快照）；回到配额内
   * （续费或用户清理）时删除记录。fromTier 供前端提示展示降级来源。
   */
  async maintainStorageGrace(
    ownerId: string,
    usedBytes: number,
    quotaBytes: number,
    fromTier: string,
    graceMs: number,
    now = Date.now(),
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [ownerId]);
      if (usedBytes > quotaBytes && quotaBytes > 0) {
        await client.query(
          `INSERT INTO canvas_storage_grace
             (owner_id, from_tier, quota_bytes, usage_bytes, deadline, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::TIMESTAMPTZ, $6::TIMESTAMPTZ)
           ON CONFLICT (owner_id) DO UPDATE
             SET quota_bytes = EXCLUDED.quota_bytes,
                 usage_bytes = EXCLUDED.usage_bytes,
                 updated_at = EXCLUDED.updated_at,
                 -- deadline 只在首次创建或已过期后重建时刷新，避免持续超额
                 -- 用户被反复顺延。续费后再次降级则重新计时。
                 deadline = CASE
                   WHEN canvas_storage_grace.deadline > $6::TIMESTAMPTZ THEN canvas_storage_grace.deadline
                   ELSE EXCLUDED.deadline
                 END`,
          [
            ownerId,
            fromTier,
            quotaBytes,
            usedBytes,
            new Date(now + graceMs).toISOString(),
            new Date(now).toISOString(),
          ],
        );
      } else {
        await client.query("DELETE FROM canvas_storage_grace WHERE owner_id = $1", [ownerId]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** 读取一个 owner 的活跃宽限记录（usage 查询用；无则 null）。 */
  async readStorageGrace(ownerId: string): Promise<{
    fromTier: string;
    quotaBytes: number;
    usageBytes: number;
    deadline: string;
  } | null> {
    const result = await this.pool.query<{
      from_tier: string;
      quota_bytes: string | number;
      usage_bytes: string | number;
      deadline: Date;
    }>(
      "SELECT from_tier, quota_bytes, usage_bytes, deadline FROM canvas_storage_grace WHERE owner_id = $1",
      [ownerId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      fromTier: row.from_tier,
      quotaBytes: safeBytes(row.quota_bytes),
      usageBytes: safeBytes(row.usage_bytes),
      deadline: row.deadline.toISOString(),
    };
  }

  /**
   * 宽限期到期的配额执行（每日清扫任务调用）：按“最旧未绑定素材优先”
   * 清理到配额内；未绑定素材清完仍超出时，继续清理绑定素材里所在项目
   * 更新最早的那部分。返回被删除的 media id + objectKey 列表（调用方负责
   * 释放对象存储字节），以及仍无法清到的缺口（理论上不会发生）。
   */
  async enforceQuotaAfterGrace(
    ownerId: string,
    quotaBytes: number,
    now = Date.now(),
  ): Promise<{ evicted: MediaEvictionItem[]; remainingOverage: number }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [ownerId]);
      const usage = await this.readUsageBytes(client, ownerId);
      const usedBytes = safeBytes(usage);
      let remaining = usedBytes - quotaBytes;
      const evicted: MediaEvictionItem[] = [];
      if (remaining > 0) {
        // 阶段一：未绑定素材，最旧优先（生成结果先于上传，同 evictOldestForQuota 语义）。
        remaining = await deleteOldestMedia(
          client,
          ownerId,
          remaining,
          /* boundOnly */ false,
          evicted,
        );
      }
      if (remaining > 0) {
        // 阶段二：绑定素材按其所在项目 updated_at 最早的优先——项目近期
        // 还在编辑的尽量保住，最久不动的画布先让出超额部分。
        remaining = await deleteOldestMedia(
          client,
          ownerId,
          remaining,
          /* boundOnly */ true,
          evicted,
        );
      }
      await client.query(
        remaining > 0
          ? "UPDATE canvas_storage_grace SET usage_bytes = $2, updated_at = $3::TIMESTAMPTZ WHERE owner_id = $1"
          : "DELETE FROM canvas_storage_grace WHERE owner_id = $1",
        remaining > 0 ? [ownerId, quotaBytes + remaining, new Date(now).toISOString()] : [ownerId],
      );
      await client.query("COMMIT");
      return { evicted, remainingOverage: Math.max(0, remaining) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** 找出所有宽限期已过的 owner（清扫任务用）。 */
  async overdueStorageGrace(now = Date.now()): Promise<string[]> {
    const result = await this.pool.query<{ owner_id: string }>(
      "SELECT owner_id FROM canvas_storage_grace WHERE deadline <= $1::TIMESTAMPTZ ORDER BY deadline ASC",
      [new Date(now).toISOString()],
    );
    return result.rows.map((row) => row.owner_id);
  }

  async getByAccessScope(id: string, ownerId: string, projectId: string | null) {
    const result = await this.pool.query<MediaRow>(
      `SELECT media.record, media.revision
       FROM canvas_media AS media
       WHERE media.id = $1
         AND media.owner_id = $2
         AND (
           (
             -- 所有者为空的访问域：未被任何项目绑定的素材都归所有者本人可读，
             -- 包括所属项目已删除的孤立素材（绑定已级联移除，但 project_id 仍在），
             -- 否则“清理云端资源”里保存到本地的下载会 404。
             $3::TEXT IS NULL
             AND NOT EXISTS (
               SELECT 1
               FROM canvas_media_project_bindings AS binding
               WHERE binding.owner_id = media.owner_id
                 AND binding.media_id = media.id
             )
           )
           OR (
             $3::TEXT IS NOT NULL
             AND EXISTS (
               SELECT 1
               FROM canvas_media_project_bindings AS binding
               WHERE binding.owner_id = media.owner_id
                 AND binding.project_id = $3
                 AND binding.media_id = media.id
             )
           )
         )`,
      [id, ownerId, projectId],
    );
    return result.rows[0] ? parseMedia(result.rows[0]) : null;
  }

  async create(value: MediaRecord, quotaValue?: MediaStorageQuota): Promise<CreateMediaResult> {
    const media = mediaRecordSchema.parse(value);
    const quota = quotaValue ? mediaStorageQuotaSchema.parse(quotaValue) : undefined;
    if (media.status !== "pending" || media.revision !== 0)
      throw new Error("New media must start pending at revision zero");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await ensureCloudPrincipal(client, media.ownerId, media.createdAt);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [media.ownerId]);
      if (media.idempotencyKey) {
        const existing = await client.query<MediaRow>(
          "SELECT record, revision FROM canvas_media WHERE owner_id = $1 AND idempotency_key = $2",
          [media.ownerId, media.idempotencyKey],
        );
        if (existing.rows[0]) {
          await client.query("COMMIT");
          return { kind: "existing", media: parseMedia(existing.rows[0]) };
        }
      }
      if (quota) await expireQuotaReservations(client, media.ownerId, quota);
      const recent = await client.query<CountRow>(
        `SELECT COUNT(*)::BIGINT AS count
         FROM canvas_media
         WHERE owner_id = $1 AND created_at >= $2::TIMESTAMPTZ`,
        [
          media.ownerId,
          new Date(Date.parse(media.createdAt) - this.creationWindowMs).toISOString(),
        ],
      );
      const recentRecords = safeBytes(recent.rows[0]?.count ?? 0);
      await pruneFailedRecords(
        client,
        media.ownerId,
        new Date(Date.parse(media.createdAt) - this.failedRetentionMs).toISOString(),
        this.maxFailedRecords,
      );
      if (recentRecords >= this.maxCreatedRecordsPerWindow) {
        await client.query("COMMIT");
        return {
          kind: "intent_limit",
          currentRecords: recentRecords,
          limit: this.maxCreatedRecordsPerWindow,
        };
      }
      const active = await client.query<CountRow>(
        `SELECT COUNT(*)::BIGINT AS count
         FROM canvas_media
         WHERE owner_id = $1 AND status IN ('pending', 'uploading')`,
        [media.ownerId],
      );
      const activeRecords = safeBytes(active.rows[0]?.count ?? 0);
      if (activeRecords >= this.maxActiveRecords) {
        await client.query("COMMIT");
        return {
          kind: "intent_limit",
          currentRecords: activeRecords,
          limit: this.maxActiveRecords,
        };
      }
      if (quota) {
        let evicted: MediaEvictionItem[] = [];
        let usage = await this.readUsageBytes(client, media.ownerId);
        let usedBytes = safeBytes(usage);
        if (usedBytes + media.expectedSize > quota.maxStorageBytes) {
          evicted = await this.evictOldestForQuota(
            client,
            media.ownerId,
            usedBytes + media.expectedSize - quota.maxStorageBytes,
          );
          if (evicted.length) {
            usage = await this.readUsageBytes(client, media.ownerId);
            usedBytes = safeBytes(usage);
          }
        }
        if (usedBytes + media.expectedSize > quota.maxStorageBytes) {
          // 删除后再写仍超限：回滚，避免白白销毁内容。
          await client.query("ROLLBACK");
          return { kind: "storage_limit", usedBytes, limitBytes: quota.maxStorageBytes };
        }
        if (evicted.length) {
          const insert = await this.insertMedia(client, media);
          if (!insert)
            throw new Error("Media insert conflict did not resolve to an idempotent record");
          await client.query("COMMIT");
          return { kind: "created", media: parseMedia(insert), evicted };
        }
      }
      const insert = await this.insertMedia(client, media);
      if (!insert) throw new Error("Media insert conflict did not resolve to an idempotent record");
      await client.query("COMMIT");
      return { kind: "created", media: parseMedia(insert) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async readUsageBytes(client: PoolClient, ownerId: string) {
    const usage = await client.query<{ used_bytes: string | number }>(
      `SELECT COALESCE(SUM(CASE WHEN status = 'ready' THEN size ELSE expected_size END), 0)::BIGINT AS used_bytes
       FROM canvas_media
       WHERE owner_id = $1 AND status IN ('pending', 'uploading', 'ready')`,
      [ownerId],
    );
    return safeBytes(usage.rows[0]?.used_bytes ?? 0);
  }

  /**
   * 配额不足时在同一事务里淘汰最旧的可用素材（先生成结果，其次未绑定项目
   * 的本地上传），为新增记录腾出空间。被云项目绑定的素材绝不自动淘汰。
   */
  private async evictOldestForQuota(client: PoolClient, ownerId: string, neededBytes: number) {
    const candidates = await client.query<{
      id: string;
      object_key: string;
      bytes: string | number;
    }>(
      `SELECT id, object_key, COALESCE(size, expected_size, 0)::BIGINT AS bytes
       FROM canvas_media
       WHERE owner_id = $1 AND status = 'ready'
         AND NOT EXISTS (
           SELECT 1
           FROM canvas_media_project_bindings AS binding
           WHERE binding.owner_id = canvas_media.owner_id
             AND binding.media_id = canvas_media.id
         )
       ORDER BY CASE WHEN source = 'generation' THEN 0 ELSE 1 END, created_at ASC, id ASC
       LIMIT $2`,
      [ownerId, MAX_EVICTION_CANDIDATES],
    );
    let freed = 0;
    const chosen: Array<{ id: string; objectKey: string }> = [];
    for (const candidate of candidates.rows) {
      chosen.push({ id: candidate.id, objectKey: candidate.object_key });
      freed += safeBytes(candidate.bytes);
      if (freed >= neededBytes) break;
    }
    if (!chosen.length) return [];
    await client.query(
      `DELETE FROM canvas_media
       WHERE owner_id = $1 AND id = ANY($2::TEXT[])`,
      [ownerId, chosen.map((item) => item.id)],
    );
    await client.query(
      `DELETE FROM canvas_media_project_bindings
       WHERE owner_id = $1 AND media_id = ANY($2::TEXT[])`,
      [ownerId, chosen.map((item) => item.id)],
    );
    return chosen;
  }

  private async insertMedia(client: PoolClient, media: MediaRecord) {
    const result = await client.query<MediaRow>(
      `INSERT INTO canvas_media (
        id, owner_id, project_id, source, idempotency_key, object_key, kind, name,
        declared_mime_type, detected_mime_type, expected_size, size,
        expected_sha256, sha256, width, height, duration_ms, status,
        error_code, error_message, revision, record, created_at, updated_at,
        upload_expires_at, ready_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, NULL,
        $11, NULL, NULL, NULL, NULL, 'pending', NULL, NULL, 0,
        $12::JSONB, $13, $13, $14, NULL
      )
      ON CONFLICT (owner_id, idempotency_key) DO NOTHING
      RETURNING record, revision`,
      [
        media.id,
        media.ownerId,
        media.projectId,
        media.source,
        media.idempotencyKey,
        media.objectKey,
        media.kind,
        media.name,
        media.declaredMimeType,
        media.expectedSize,
        media.expectedSha256,
        serialize(media),
        media.createdAt,
        media.uploadExpiresAt,
      ],
    );
    if (!result.rows[0]) return null;
    if (media.projectId) {
      await client.query(
        `INSERT INTO canvas_media_project_bindings (owner_id, project_id, media_id, created_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [media.ownerId, media.projectId, media.id, media.createdAt],
      );
    }
    return result.rows[0];
  }

  async deleteOwned(id: string, ownerId: string): Promise<DeleteOwnedMediaResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<MediaRow>(
        `DELETE FROM canvas_media
         WHERE id = $1 AND owner_id = $2
           AND NOT EXISTS (
             SELECT 1
             FROM canvas_media_project_bindings AS binding
             WHERE binding.owner_id = canvas_media.owner_id
               AND binding.media_id = canvas_media.id
           )
         RETURNING record, revision`,
        [id, ownerId],
      );
      await client.query("COMMIT");
      if (!result.rows[0]) {
        const owned = await client.query(
          "SELECT id FROM canvas_media WHERE id = $1 AND owner_id = $2",
          [id, ownerId],
        );
        if (!owned.rows.length) return { kind: "missing" };
        return { kind: "bound" };
      }
      return { kind: "deleted", media: parseMedia(result.rows[0]) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** 列出账号下全部素材及其云项目绑定，供“清理云端资源”自选删除。 */
  async listOwnedResources(ownerId: string): Promise<OwnedCloudMedia[]> {
    const result = await this.pool.query<
      MediaRow & { project_ids: string[] | null; orphaned: boolean }
    >(
      `SELECT media.record, media.revision,
        COALESCE((
          SELECT array_agg(binding.project_id ORDER BY binding.project_id)
          FROM canvas_media_project_bindings AS binding
          WHERE binding.owner_id = media.owner_id AND binding.media_id = media.id
        ), ARRAY[]::TEXT[]) AS project_ids,
        (
          media.project_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM canvas_media_project_bindings AS binding
            WHERE binding.owner_id = media.owner_id AND binding.media_id = media.id
          )
        ) AS orphaned
       FROM canvas_media AS media
       WHERE media.owner_id = $1
       ORDER BY media.created_at DESC, media.id DESC
       LIMIT 1000`,
      [ownerId],
    );
    return result.rows.map((row) => ({
      media: parseMedia(row),
      projectIds: row.project_ids ?? [],
      orphaned: row.orphaned === true,
    }));
  }

  async listProjectBoundMediaIds(ownerId: string, projectId: string): Promise<string[]> {
    const result = await this.pool.query<{ media_id: string }>(
      `SELECT media_id FROM canvas_media_project_bindings
       WHERE owner_id = $1 AND project_id = $2`,
      [ownerId, projectId],
    );
    return result.rows.map((row) => row.media_id);
  }

  async listOwnersWithOrphanedMedia(): Promise<string[]> {
    const result = await this.pool.query<{ owner_id: string }>(
      `SELECT DISTINCT media.owner_id
       FROM canvas_media AS media
       WHERE media.status <> 'failed'
         AND media.project_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
           FROM canvas_media_project_bindings AS binding
           WHERE binding.owner_id = media.owner_id AND binding.media_id = media.id
         )`,
    );
    return result.rows.map((row) => row.owner_id);
  }

  async deleteUnboundMedia(ownerId: string, ids: readonly string[]): Promise<MediaEvictionItem[]> {
    if (!ids.length) return [];
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [ownerId]);
      const result = await client.query<MediaRow>(
        `DELETE FROM canvas_media
         WHERE owner_id = $1 AND id = ANY($2::TEXT[])
           AND NOT EXISTS (
             SELECT 1
             FROM canvas_media_project_bindings AS binding
             WHERE binding.owner_id = canvas_media.owner_id
               AND binding.media_id = canvas_media.id
           )
         RETURNING record, revision`,
        [ownerId, [...ids]],
      );
      await client.query("COMMIT");
      return result.rows.map((row) => {
        const media = parseMedia(row);
        return { id: media.id, objectKey: media.objectKey };
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async claimUpload(id: string, ownerId: string, expectedRevision: number, updatedAt: string) {
    const current = await this.getOwned(id, ownerId);
    if (!current || current.revision !== expectedRevision || current.status !== "pending")
      return null;
    return this.save(
      {
        ...current,
        status: "uploading",
        revision: current.revision + 1,
        updatedAt,
      },
      expectedRevision,
    );
  }

  async resetUpload(id: string, ownerId: string, expectedRevision: number, updatedAt: string) {
    const current = await this.getOwned(id, ownerId);
    if (!current || current.revision !== expectedRevision || current.status !== "uploading")
      return null;
    return this.save(
      {
        ...current,
        status: "pending",
        revision: current.revision + 1,
        updatedAt,
      },
      expectedRevision,
    );
  }

  async markReady(value: MediaRecord, expectedRevision: number) {
    const media = mediaRecordSchema.parse(value);
    if (media.status !== "ready") throw new Error("Only ready media can complete an upload");
    return this.save(media, expectedRevision);
  }

  async markFailed(value: MediaRecord, expectedRevision: number) {
    const media = mediaRecordSchema.parse(value);
    if (media.status !== "failed")
      throw new Error("Only failed media can persist an upload failure");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [media.ownerId]);
      const saved = await this.save(media, expectedRevision, client);
      if (saved) {
        await pruneFailedRecords(
          client,
          media.ownerId,
          new Date(Date.parse(media.updatedAt) - this.failedRetentionMs).toISOString(),
          this.maxFailedRecords,
        );
      }
      await client.query("COMMIT");
      return saved;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async getOwned(
    id: string,
    ownerId: string,
    client: Pick<PoolClient, "query"> = this.pool,
  ) {
    const result = await client.query<MediaRow>(
      "SELECT record, revision FROM canvas_media WHERE id = $1 AND owner_id = $2",
      [id, ownerId],
    );
    return result.rows[0] ? parseMedia(result.rows[0]) : null;
  }

  private async save(
    media: MediaRecord,
    expectedRevision: number,
    client: Pick<PoolClient, "query"> = this.pool,
  ) {
    if (media.revision !== expectedRevision + 1)
      throw new Error("Media revision must increment exactly once");
    const current = await this.getOwned(media.id, media.ownerId, client);
    if (!current || current.revision !== expectedRevision) return null;
    assertImmutable(current, media);
    const result = await client.query<MediaRow>(
      `UPDATE canvas_media SET
        detected_mime_type = $3,
        size = $4,
        sha256 = $5,
        width = $6,
        height = $7,
        duration_ms = $8,
        status = $9,
        error_code = $10,
        error_message = $11,
        revision = $12,
        record = $13::JSONB,
        updated_at = $14,
        ready_at = $15
       WHERE id = $1 AND owner_id = $2 AND revision = $16
       RETURNING record, revision`,
      [
        media.id,
        media.ownerId,
        media.detectedMimeType,
        media.size,
        media.sha256,
        media.width,
        media.height,
        media.durationMs,
        media.status,
        media.error?.code ?? null,
        media.error?.message ?? null,
        media.revision,
        serialize(media),
        media.updatedAt,
        media.readyAt,
        expectedRevision,
      ],
    );
    return result.rows[0] ? parseMedia(result.rows[0]) : null;
  }
}

async function pruneFailedRecords(
  client: Pick<PoolClient, "query">,
  ownerId: string,
  retentionBefore: string,
  retainedRecords: number,
) {
  await client.query(
    `DELETE FROM canvas_media
     WHERE owner_id = $1
       AND status = 'failed'
       AND (
         updated_at < $2::TIMESTAMPTZ
         OR (error_code <> 'MEDIA_UPLOAD_EXPIRED' AND id IN (
           SELECT id
           FROM canvas_media
           WHERE owner_id = $1
             AND status = 'failed'
             AND error_code <> 'MEDIA_UPLOAD_EXPIRED'
           ORDER BY updated_at DESC, id DESC
           OFFSET $3
         ))
       )`,
    [ownerId, retentionBefore, retainedRecords],
  );
}

async function expireQuotaReservations(
  client: Pick<PoolClient, "query">,
  ownerId: string,
  quota: MediaStorageQuota,
) {
  const code = "MEDIA_UPLOAD_EXPIRED";
  const message = "Upload reservation expired before completion";
  await client.query(
    `UPDATE canvas_media SET
       status = 'failed',
       error_code = $4,
       error_message = $5,
       revision = revision + 1,
       record = record || jsonb_build_object(
         'status', 'failed',
         'error', jsonb_build_object('code', $4::TEXT, 'message', $5::TEXT),
         'revision', revision + 1,
         'updatedAt', $6::TEXT
       ),
       updated_at = $2::TIMESTAMPTZ,
       ready_at = NULL
     WHERE owner_id = $1
       AND (
         (status = 'pending' AND upload_expires_at <= $2::TIMESTAMPTZ)
         OR (
           status = 'uploading'
           AND upload_expires_at <= $2::TIMESTAMPTZ
           AND updated_at <= $3::TIMESTAMPTZ
         )
       )`,
    [ownerId, quota.evaluatedAt, quota.staleUploadingBefore, code, message, quota.evaluatedAt],
  );
}

function parseMedia(row: MediaRow) {
  const media = mediaRecordSchema.parse(row.record);
  if (media.revision !== row.revision)
    throw new Error("Media revision does not match its stored record");
  return media;
}

/**
 * 删除最旧的可用素材直到释放 neededBytes；boundOnly=false 只删未绑定素材
 * （复用 evictOldestForQuota 的候选语义），返回未满足的剩余缺口。
 */
async function deleteOldestMedia(
  client: Pick<PoolClient, "query">,
  ownerId: string,
  neededBytes: number,
  boundOnly: boolean,
  evicted: MediaEvictionItem[],
): Promise<number> {
  const candidates = await client.query<{ id: string; object_key: string; bytes: string | number }>(
    `SELECT media.id, media.object_key, COALESCE(media.size, media.expected_size, 0)::BIGINT AS bytes
     FROM canvas_media AS media
     WHERE media.owner_id = $1
       AND media.status = 'ready'
       AND ${
         boundOnly
           ? "EXISTS (SELECT 1 FROM canvas_media_project_bindings AS binding WHERE binding.owner_id = media.owner_id AND binding.media_id = media.id)"
           : "NOT EXISTS (SELECT 1 FROM canvas_media_project_bindings AS binding WHERE binding.owner_id = media.owner_id AND binding.media_id = media.id)"
       }
     ORDER BY ${
       boundOnly
         ? // 绑定素材阶段：按所在项目 updated_at 最早优先（最久不动的画布先让出），
           // 同一项目内再按素材创建时间从旧到新。
           `(SELECT MIN(projects.updated_at) FROM canvas_media_project_bindings AS binding
               JOIN canvas_cloud_projects AS projects ON projects.owner_id = binding.owner_id AND projects.id = binding.project_id
               WHERE binding.owner_id = media.owner_id AND binding.media_id = media.id) ASC NULLS LAST,
            media.created_at ASC, media.id ASC`
         : "CASE WHEN media.source = 'generation' THEN 0 ELSE 1 END, media.created_at ASC, media.id ASC"
     }
     LIMIT $2`,
    [ownerId, MAX_EVICTION_CANDIDATES],
  );
  let freed = 0;
  const chosen: string[] = [];
  for (const candidate of candidates.rows) {
    chosen.push(candidate.id);
    evicted.push({ id: candidate.id, objectKey: candidate.object_key });
    freed += safeBytes(candidate.bytes);
    if (freed >= neededBytes) break;
  }
  if (!chosen.length) return neededBytes;
  await client.query("DELETE FROM canvas_media WHERE owner_id = $1 AND id = ANY($2::TEXT[])", [
    ownerId,
    chosen,
  ]);
  return Math.max(0, neededBytes - freed);
}

function safeBytes(value: string | number) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error("Media storage usage is invalid");
  return parsed;
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function serialize(media: MediaRecord) {
  return JSON.stringify(media);
}

function assertImmutable(current: MediaRecord, next: MediaRecord) {
  const stable =
    current.id === next.id &&
    current.ownerId === next.ownerId &&
    current.projectId === next.projectId &&
    current.source === next.source &&
    current.idempotencyKey === next.idempotencyKey &&
    current.objectKey === next.objectKey &&
    current.kind === next.kind &&
    current.name === next.name &&
    current.declaredMimeType === next.declaredMimeType &&
    current.expectedSize === next.expectedSize &&
    current.expectedSha256 === next.expectedSha256 &&
    current.createdAt === next.createdAt &&
    current.uploadExpiresAt === next.uploadExpiresAt;
  if (!stable) throw new Error("Immutable media fields cannot change after upload intent creation");
}
