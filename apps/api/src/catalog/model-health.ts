import type { Pool } from "pg";

import type { ModelHealth } from "@weftcanvas/contracts";

export type { ModelHealth };

/** 聚合窗口：近 7 天的终态生成任务。 */
export const MODEL_HEALTH_WINDOW_HOURS = 24 * 7;
/** 样本少于该值的模型不产出健康度，避免小样本噪声被读成结论。 */
export const MODEL_HEALTH_MIN_SAMPLES = 5;
/** 聚合结果缓存时长：目录路由是热路径，GROUP BY 不需要每次请求都跑。 */
const MODEL_HEALTH_CACHE_TTL_MS = 5 * 60_000;

export interface ModelHealthProvider {
  /** modelId → 近窗成功率；查询失败时回落到旧缓存（绝不编造数据）。 */
  get(): Promise<Map<string, ModelHealth>>;
}

type HealthRow = { model_id: string; completed: string | number; failed: string | number };

export class PostgresModelHealthProvider implements ModelHealthProvider {
  private cache: { at: number; map: Map<string, ModelHealth> } | null = null;
  private inflight: Promise<Map<string, ModelHealth>> | null = null;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(
    private readonly pool: Pick<Pool, "query">,
    options: { now?: () => number; ttlMs?: number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? MODEL_HEALTH_CACHE_TTL_MS;
  }

  async get(): Promise<Map<string, ModelHealth>> {
    const now = this.now();
    if (this.cache && now - this.cache.at < this.ttlMs) return this.cache.map;
    if (this.inflight) return this.inflight;
    const run = (async () => {
      try {
        const map = await this.query(now);
        this.cache = { at: now, map };
        return map;
      } catch {
        // 聚合失败不阻断目录：有旧缓存就继续供给（哪怕过期），否则视为无数据。
        return this.cache?.map ?? new Map<string, ModelHealth>();
      } finally {
        this.inflight = null;
      }
    })();
    this.inflight = run;
    return run;
  }

  private async query(now: number): Promise<Map<string, ModelHealth>> {
    const result = await this.pool.query<HealthRow>(
      `SELECT model_id,
              COUNT(*) FILTER (WHERE status = 'completed') AS completed,
              COUNT(*) FILTER (WHERE status = 'failed') AS failed
       FROM canvas_generation_jobs
       WHERE status IN ('completed', 'failed')
         AND updated_at >= $1
       GROUP BY model_id`,
      [new Date(now - MODEL_HEALTH_WINDOW_HOURS * 3_600_000).toISOString()],
    );
    const map = new Map<string, ModelHealth>();
    for (const row of result.rows) {
      const completed = Number(row.completed);
      const failed = Number(row.failed);
      const sampleCount = completed + failed;
      if (sampleCount < MODEL_HEALTH_MIN_SAMPLES) continue;
      map.set(row.model_id, {
        successRate: completed / sampleCount,
        sampleCount,
        windowHours: MODEL_HEALTH_WINDOW_HOURS,
      });
    }
    return map;
  }
}

/** 空实现：未配置 Postgres 时目录响应不带健康度（显示侧自动隐藏）。 */
export const EMPTY_MODEL_HEALTH_PROVIDER: ModelHealthProvider = {
  get: async () => new Map<string, ModelHealth>(),
};
