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

/** 后台「用户」页的单行：账号 + 可直接支撑运营判断的聚合量。 */
export type OpsUserRow = {
  id: string;
  email: string;
  displayName: string;
  status: "active" | "disabled";
  createdAt: string;
  lastLoginAt: string | null;
  /** 可用余额（画布积分）；1 元 = 100 积分，库里存 micros。 */
  credits: number;
  /** 云项目数。 */
  projects: number;
  /** 已就绪素材数与占用字节。 */
  mediaCount: number;
  mediaBytes: number;
  /** 该用户全部任务数。 */
  jobs: number;
  /** 窗口内（默认 24h）终态任务：完成 / 失败。 */
  jobsCompleted: number;
  jobsFailed: number;
};

export type OpsUserQuery = {
  query: string;
  sinceIso: string;
  limit: number;
};

export type OpsStore = {
  countUsers(): Promise<number>;
  countProjects(): Promise<number>;
  mediaTotals(): Promise<{ count: number; bytes: number }>;
  jobCounts(sinceIso: string, staleBeforeIso: string): Promise<OpsJobCounts>;
  recentJobs(status: "failed" | "all", limit: number): Promise<OpsJobRow[]>;
  recentUsers(input: OpsUserQuery): Promise<{ total: number; users: OpsUserRow[] }>;
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
type UserRow = {
  id: string;
  email: string;
  display_name: string;
  status: string;
  created_at: Date | string;
  last_login_at: Date | string | null;
  available_credit_micros: string | number | null;
  projects: string | number;
  media_count: string | number;
  media_bytes: string | number | null;
  jobs: string | number;
  jobs_completed: string | number;
  jobs_failed: string | number;
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

  /**
   * 后台「用户」页：账号列表（邮箱/昵称/用户 id 模糊搜索）+ 每人聚合量。
   * 全部来自通用表（canvas_users / canvas_wallets / canvas_cloud_projects /
   * canvas_media / canvas_generation_jobs），公开树自托管者同样可用。
   */
  async recentUsers(input: OpsUserQuery): Promise<{ total: number; users: OpsUserRow[] }> {
    const search = input.query;
    const searchArgs = [search];
    const totalResult = await this.pool.query<CountRow>(
      `SELECT COUNT(*) AS n FROM canvas_users u
       WHERE ($1::TEXT = '' OR u.email ILIKE '%' || $1 || '%'
              OR u.display_name ILIKE '%' || $1 || '%'
              OR u.id ILIKE '%' || $1 || '%')`,
      searchArgs,
    );
    const result = await this.pool.query<UserRow>(
      `SELECT u.id, u.email, u.display_name, u.status, u.created_at, u.last_login_at,
              COALESCE(w.available_credit_micros, 0) AS available_credit_micros,
              (SELECT COUNT(*) FROM canvas_cloud_projects p WHERE p.owner_id = u.id) AS projects,
              (SELECT COUNT(*) FROM canvas_media m
               WHERE m.owner_id = u.id AND m.status = 'ready') AS media_count,
              (SELECT COALESCE(SUM(COALESCE(m.size, m.expected_size)), 0) FROM canvas_media m
               WHERE m.owner_id = u.id AND m.status = 'ready') AS media_bytes,
              (SELECT COUNT(*) FROM canvas_generation_jobs j WHERE j.owner_id = u.id) AS jobs,
              (SELECT COUNT(*) FROM canvas_generation_jobs j
               WHERE j.owner_id = u.id AND j.updated_at >= $2
                 AND j.status = 'completed') AS jobs_completed,
              (SELECT COUNT(*) FROM canvas_generation_jobs j
               WHERE j.owner_id = u.id AND j.updated_at >= $2
                 AND j.status = 'failed') AS jobs_failed
       FROM canvas_users u
       LEFT JOIN canvas_wallets w ON w.owner_id = u.id
       WHERE ($1::TEXT = '' OR u.email ILIKE '%' || $1 || '%'
              OR u.display_name ILIKE '%' || $1 || '%'
              OR u.id ILIKE '%' || $1 || '%')
       ORDER BY u.created_at DESC
       LIMIT $3`,
      [search, input.sinceIso, input.limit],
    );
    return {
      total: Number(totalResult.rows[0]?.n ?? 0),
      users: result.rows.map((row) => ({
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        status: row.status === "disabled" ? "disabled" : "active",
        createdAt: toIso(row.created_at),
        lastLoginAt: row.last_login_at ? toIso(row.last_login_at) : null,
        credits: Number(row.available_credit_micros ?? 0) / 1_000_000,
        projects: Number(row.projects ?? 0),
        mediaCount: Number(row.media_count ?? 0),
        mediaBytes: Number(row.media_bytes ?? 0),
        jobs: Number(row.jobs ?? 0),
        jobsCompleted: Number(row.jobs_completed ?? 0),
        jobsFailed: Number(row.jobs_failed ?? 0),
      })),
    };
  }
}
