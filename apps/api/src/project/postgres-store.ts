import {
  canvasDocumentSchema,
  cloudProjectSharedSummarySchema,
  cloudProjectSummarySchema,
  type CloudProjectEntitlements,
} from "@weftcanvas/contracts";
import type { Pool, PoolClient } from "pg";

import type {
  CloudProjectRecord,
  CloudProjectStore,
  CreateCloudProjectStoreResult,
  DeleteCloudProjectStoreResult,
  SaveCloudProjectStoreResult,
} from "./types.js";
import { ensureCloudPrincipal } from "./principal.js";

type ProjectRow = {
  owner_id: string;
  id: string;
  title: string;
  schema_version: number;
  current_revision: string | number;
  document: unknown;
  document_bytes: string | number;
  local_media_count: number;
  created_at: Date | string;
  updated_at: Date | string;
};

type UsageRow = {
  project_count: number;
  project_storage_bytes: string | number;
  media_storage_bytes: string | number;
};

const DEFAULT_CHECKPOINT_INTERVAL_MS = 5 * 60_000;

class ProjectStorageLimitRollback extends Error {
  constructor() {
    super("Cloud project storage quota would be exceeded");
    this.name = "ProjectStorageLimitRollback";
  }
}

export class PostgresCloudProjectStore implements CloudProjectStore {
  constructor(
    private readonly pool: Pool,
    private readonly options: { checkpointIntervalMs?: number } = {},
  ) {}

  async list(ownerId: string, limit: number) {
    const result = await this.pool.query<ProjectRow>(
      `${projectSelect()}
       WHERE owner_id = $1
       ORDER BY updated_at DESC, id ASC
       LIMIT $2`,
      [ownerId, limit],
    );
    return result.rows.map((row) => projectSummary(projectRecord(row)));
  }

  async listForActor(principalId: string, limit: number) {
    const result = await this.pool.query<ProjectRow>(
      `${projectSelect("project")}
       INNER JOIN canvas_cloud_project_members AS member
         ON member.owner_id = project.owner_id
        AND member.project_id = project.id
        AND member.principal_id = $1
        AND member.role = 'member'
       ORDER BY project.updated_at DESC, project.id ASC, project.owner_id ASC
       LIMIT $2`,
      [principalId, limit],
    );
    return result.rows.map((row) => {
      const project = projectRecord(row);
      return cloudProjectSharedSummarySchema.parse({
        ...projectSummary(project),
        ownerId: project.ownerId,
        role: "member",
      });
    });
  }

  async get(ownerId: string, projectId: string) {
    const result = await this.pool.query<ProjectRow>(
      `${projectSelect()} WHERE owner_id = $1 AND id = $2`,
      [ownerId, projectId],
    );
    return result.rows[0] ? projectRecord(result.rows[0]) : null;
  }

  async getForActor(ownerId: string, projectId: string, actorId: string) {
    const result = await this.pool.query<ProjectRow>(
      `${projectSelect("project")}
       INNER JOIN canvas_cloud_project_members AS member
         ON member.owner_id = project.owner_id
        AND member.project_id = project.id
        AND member.principal_id = $3
        AND member.role = 'member'
       WHERE project.owner_id = $1 AND project.id = $2`,
      [ownerId, projectId, actorId],
    );
    return result.rows[0] ? projectRecord(result.rows[0]) : null;
  }

  async usage(ownerId: string) {
    const result = await this.pool.query<UsageRow>(usageQuery(), [ownerId]);
    return usageRecord(result.rows[0]);
  }

  async create(
    project: CloudProjectRecord,
    checksum: string,
    entitlements: CloudProjectEntitlements,
  ): Promise<CreateCloudProjectStoreResult> {
    try {
      return await withTransaction(this.pool, async (client) => {
        await lockOwner(client, project.ownerId);
        await ensureCloudPrincipal(client, project.ownerId, project.createdAt);
        const existing = await client.query(
          "SELECT 1 FROM canvas_cloud_projects WHERE owner_id = $1 AND id = $2",
          [project.ownerId, project.id],
        );
        if (existing.rowCount) return { kind: "exists" } as const;

        const before = usageRecord(
          (await client.query<UsageRow>(usageQuery(), [project.ownerId])).rows[0],
        );
        if (before.projectCount >= entitlements.cloudProjectLimit)
          return { kind: "project_limit" } as const;

        await insertProject(client, project);
        await insertOwnerMember(client, project);
        await insertRevision(client, project, checksum);
        await pruneRevisions(
          client,
          project.ownerId,
          project.id,
          entitlements.revisionRetentionCount,
        );
        const finalUsage = usageRecord(
          (await client.query<UsageRow>(usageQuery(), [project.ownerId])).rows[0],
        );
        if (finalUsage.projectStorageBytes > entitlements.projectStorageBytes) {
          throw new ProjectStorageLimitRollback();
        }
        return { kind: "created", project } as const;
      });
    } catch (error) {
      if (error instanceof ProjectStorageLimitRollback) return { kind: "storage_limit" };
      throw error;
    }
  }

  async save(input: {
    project: CloudProjectRecord;
    baseRevision: number;
    checksum: string;
    checkpoint: boolean;
    entitlements: CloudProjectEntitlements;
    actorId?: string;
  }): Promise<SaveCloudProjectStoreResult> {
    try {
      return await withTransaction(this.pool, async (client) => {
        await lockOwner(client, input.project.ownerId);
        const locked = await client.query<ProjectRow>(
          `${projectSelect()}
           WHERE owner_id = $1 AND id = $2
           FOR UPDATE`,
          [input.project.ownerId, input.project.id],
        );
        const current = locked.rows[0] ? projectRecord(locked.rows[0]) : null;
        if (!current) return { kind: "not_found" } as const;
        if (input.actorId) {
          const member = await client.query(
            `SELECT 1 FROM canvas_cloud_project_members
             WHERE owner_id = $1 AND project_id = $2 AND principal_id = $3 AND role = 'member'`,
            [input.project.ownerId, input.project.id, input.actorId],
          );
          if (!member.rowCount) return { kind: "not_found" } as const;
        }
        if (current.revision !== input.baseRevision) {
          return { kind: "revision_conflict", revision: current.revision } as const;
        }

        const before = usageRecord(
          (await client.query<UsageRow>(usageQuery(), [input.project.ownerId])).rows[0],
        );
        const revision = current.revision + 1;
        const project = { ...input.project, revision };
        await client.query(
          `UPDATE canvas_cloud_projects
           SET title = $3, schema_version = $4, current_revision = $5,
               document = $6::JSONB, document_bytes = $7, local_media_count = $8,
               updated_at = $9
           WHERE owner_id = $1 AND id = $2`,
          [
            project.ownerId,
            project.id,
            project.title,
            project.schemaVersion,
            project.revision,
            JSON.stringify(project.document),
            project.documentBytes,
            project.localMediaCount,
            project.updatedAt,
          ],
        );

        if (
          input.checkpoint ||
          (await checkpointDue(
            client,
            project.ownerId,
            project.id,
            project.updatedAt,
            this.options.checkpointIntervalMs,
          ))
        ) {
          await insertRevision(client, project, input.checksum);
        }
        await pruneRevisions(
          client,
          project.ownerId,
          project.id,
          input.entitlements.revisionRetentionCount,
        );
        const finalUsage = usageRecord(
          (await client.query<UsageRow>(usageQuery(), [input.project.ownerId])).rows[0],
        );
        const remainsOverLimit =
          finalUsage.projectStorageBytes > input.entitlements.projectStorageBytes;
        if (remainsOverLimit && finalUsage.projectStorageBytes >= before.projectStorageBytes) {
          throw new ProjectStorageLimitRollback();
        }
        return { kind: "saved", project } as const;
      });
    } catch (error) {
      if (error instanceof ProjectStorageLimitRollback) return { kind: "storage_limit" };
      throw error;
    }
  }

  async delete(
    ownerId: string,
    projectId: string,
    baseRevision: number,
  ): Promise<DeleteCloudProjectStoreResult> {
    return withTransaction(this.pool, async (client) => {
      await lockOwner(client, ownerId);
      const locked = await client.query<{ current_revision: string | number }>(
        `SELECT current_revision
         FROM canvas_cloud_projects
         WHERE owner_id = $1 AND id = $2
         FOR UPDATE`,
        [ownerId, projectId],
      );
      if (!locked.rows[0]) return { kind: "not_found" };
      const revision = safeInteger(locked.rows[0].current_revision, "project revision");
      if (revision !== baseRevision) return { kind: "revision_conflict", revision };
      await client.query("DELETE FROM canvas_cloud_projects WHERE owner_id = $1 AND id = $2", [
        ownerId,
        projectId,
      ]);
      return { kind: "deleted" };
    });
  }
}

function projectSelect(alias?: string) {
  const prefix = alias ? `${alias}.` : "";
  const table = alias ? `canvas_cloud_projects AS ${alias}` : "canvas_cloud_projects";
  return `SELECT ${prefix}owner_id, ${prefix}id, ${prefix}title, ${prefix}schema_version,
    ${prefix}current_revision, ${prefix}document, ${prefix}document_bytes,
    ${prefix}local_media_count, ${prefix}created_at, ${prefix}updated_at
    FROM ${table}`;
}

function usageQuery() {
  return `SELECT COUNT(*)::INTEGER AS project_count,
    (
      COALESCE(SUM(document_bytes), 0)
      + COALESCE((
        SELECT SUM(document_bytes)
        FROM canvas_cloud_project_revisions
        WHERE owner_id = $1
      ), 0)
    )::BIGINT AS project_storage_bytes,
    COALESCE((
      SELECT SUM(CASE WHEN status = 'ready' THEN size ELSE expected_size END)
      FROM canvas_media
      WHERE owner_id = $1 AND status IN ('pending', 'uploading', 'ready')
    ), 0)::BIGINT AS media_storage_bytes
    FROM canvas_cloud_projects
    WHERE owner_id = $1`;
}

function projectRecord(row: ProjectRow): CloudProjectRecord {
  const document = canvasDocumentSchema.parse(row.document);
  return {
    ownerId: row.owner_id,
    schemaVersion: 1,
    id: row.id,
    title: row.title,
    revision: safeInteger(row.current_revision, "project revision"),
    documentBytes: safeInteger(row.document_bytes, "project document bytes"),
    localMediaCount: safeInteger(row.local_media_count, "project local media count"),
    document,
    createdAt: dateIso(row.created_at),
    updatedAt: dateIso(row.updated_at),
  };
}

function projectSummary(project: CloudProjectRecord) {
  return cloudProjectSummarySchema.parse({
    schemaVersion: project.schemaVersion,
    id: project.id,
    title: project.title,
    revision: project.revision,
    documentBytes: project.documentBytes,
    localMediaCount: project.localMediaCount,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  });
}

function usageRecord(row: UsageRow | undefined) {
  return {
    projectCount: safeInteger(row?.project_count ?? 0, "project count"),
    projectStorageBytes: safeInteger(row?.project_storage_bytes ?? 0, "project storage bytes"),
    mediaStorageBytes: safeInteger(row?.media_storage_bytes ?? 0, "media storage bytes"),
  };
}

async function lockOwner(client: PoolClient, ownerId: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [ownerId]);
}

async function insertProject(client: PoolClient, project: CloudProjectRecord) {
  await client.query(
    `INSERT INTO canvas_cloud_projects (
      owner_id, id, title, schema_version, current_revision, document,
      document_bytes, local_media_count, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6::JSONB, $7, $8, $9, $10)`,
    [
      project.ownerId,
      project.id,
      project.title,
      project.schemaVersion,
      project.revision,
      JSON.stringify(project.document),
      project.documentBytes,
      project.localMediaCount,
      project.createdAt,
      project.updatedAt,
    ],
  );
}

async function insertRevision(client: PoolClient, project: CloudProjectRecord, checksum: string) {
  await client.query(
    `INSERT INTO canvas_cloud_project_revisions (
      owner_id, project_id, revision, schema_version, document,
      document_bytes, checksum, created_at
    ) VALUES ($1, $2, $3, $4, $5::JSONB, $6, $7, $8)`,
    [
      project.ownerId,
      project.id,
      project.revision,
      project.schemaVersion,
      JSON.stringify(project.document),
      project.documentBytes,
      checksum,
      project.updatedAt,
    ],
  );
}

async function insertOwnerMember(client: PoolClient, project: CloudProjectRecord) {
  await client.query(
    `INSERT INTO canvas_cloud_project_members (
      owner_id, project_id, principal_id, role, created_at
    ) VALUES ($1, $2, $1, 'owner', $3)
    ON CONFLICT (owner_id, project_id, principal_id) DO NOTHING`,
    [project.ownerId, project.id, project.createdAt],
  );
}

async function checkpointDue(
  client: PoolClient,
  ownerId: string,
  projectId: string,
  updatedAt: string,
  checkpointIntervalMs = DEFAULT_CHECKPOINT_INTERVAL_MS,
) {
  const latest = await client.query<{ created_at: Date | string }>(
    `SELECT created_at
     FROM canvas_cloud_project_revisions
     WHERE owner_id = $1 AND project_id = $2
     ORDER BY created_at DESC, revision DESC
     LIMIT 1`,
    [ownerId, projectId],
  );
  if (!latest.rows[0]) return true;
  return (
    Date.parse(updatedAt) - Date.parse(dateIso(latest.rows[0].created_at)) >= checkpointIntervalMs
  );
}

async function pruneRevisions(
  client: PoolClient,
  ownerId: string,
  projectId: string,
  retentionCount: number,
) {
  await client.query(
    `DELETE FROM canvas_cloud_project_revisions
     WHERE owner_id = $1 AND project_id = $2
       AND revision NOT IN (
         SELECT revision
         FROM canvas_cloud_project_revisions
         WHERE owner_id = $1 AND project_id = $2
         ORDER BY created_at DESC, revision DESC
         LIMIT $3
       )`,
    [ownerId, projectId, retentionCount],
  );
}

async function withTransaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function dateIso(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Cloud project timestamp is invalid");
  return date.toISOString();
}

function safeInteger(value: string | number, label: string) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is invalid`);
  return parsed;
}
