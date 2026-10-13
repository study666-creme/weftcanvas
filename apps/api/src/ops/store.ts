import type { Pool } from "pg";

export type OpsJobRow = {
  id: string;
  ownerId: string;
  modelId: string;
  modality: string;
  status: string;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OpsJobCounts = {
  completed: number;
  failed: number;
  inFlight: number;
  staleInFlight: number;
  oldestInFlightUpdatedAt: string | null;
};

export type OpsStore = {
  countUsers(): Promise<number>;
  countProjects(): Promise<number>;
  mediaTotals(): Promise<{ count: number; bytes: number }>;
  jobCounts(sinceIso: string, staleBeforeIso: string): Promise<OpsJobCounts>;
  recentJobs(status: "failed" | "all", limit: number): Promise<OpsJobRow[]>;
};

type CountRow = { n: string | number };
type MediaRow = { n: string | number; bytes: string | number };
type JobCountRow = {
  completed: string | number;
  failed: string | number;
  in_flight: string | number;
  stale_in_flight: string | number;
  oldest: Date | string | null;
};
type JobRow = {
  id: string;
  owner_id: string;
  model_id: string;
  modality: string;
  status: string;
  error_code: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export class PostgresOpsStore implements OpsStore {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async countUsers() {
    const result = await this.pool.query<CountRow>("SELECT COUNT(*) AS n FROM canvas_users");
    return Number(result.rows[0]?.n ?? 0);
  }

  async countProjects() {
    const result = await this.pool.query<CountRow>(
      "SELECT COUNT(*) AS n FROM canvas_cloud_projects",
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  async mediaTotals() {
    const result = await this.pool.query<MediaRow>(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(COALESCE(size, expected_size)), 0) AS bytes
       FROM canvas_media
       WHERE status <> 'failed'`,
    );
    return { count: Number(result.rows[0]?.n ?? 0), bytes: Number(result.rows[0]?.bytes ?? 0) };
  }

  async jobCounts(sinceIso: string, staleBeforeIso: string): Promise<OpsJobCounts> {
    const result = await this.pool.query<JobCountRow>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'completed' AND updated_at >= $1) AS completed,
         COUNT(*) FILTER (WHERE status = 'failed' AND updated_at >= $1) AS failed,
         COUNT(*) FILTER (WHERE status NOT IN ('completed', 'failed')) AS in_flight,
         COUNT(*) FILTER (
           WHERE status NOT IN ('completed', 'failed') AND updated_at < $2
         ) AS stale_in_flight,
         (
           SELECT MIN(updated_at) FROM canvas_generation_jobs
           WHERE status NOT IN ('completed', 'failed')
         ) AS oldest
       FROM canvas_generation_jobs`,
      [sinceIso, staleBeforeIso],
    );
    const row = result.rows[0];
    return {
      completed: Number(row?.completed ?? 0),
      failed: Number(row?.failed ?? 0),
      inFlight: Number(row?.in_flight ?? 0),
      staleInFlight: Number(row?.stale_in_flight ?? 0),
      oldestInFlightUpdatedAt: row?.oldest ? toIso(row.oldest) : null,
    };
  }

  async recentJobs(status: "failed" | "all", limit: number): Promise<OpsJobRow[]> {
    const result = await this.pool.query<JobRow>(
      `SELECT id, owner_id, model_id, modality, status,
              record -> 'error' ->> 'code' AS error_code,
              created_at, updated_at
       FROM canvas_generation_jobs
       WHERE ($1::TEXT = 'all' OR status = $1)
       ORDER BY updated_at DESC
       LIMIT $2`,
      [status, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      ownerId: row.owner_id,
      modelId: row.model_id,
      modality: row.modality,
      status: row.status,
      errorCode: row.error_code,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    }));
  }
}
