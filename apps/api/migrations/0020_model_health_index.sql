-- 模型成功率聚合（catalog health）：按模型滚动窗口统计终态任务，
-- 只覆盖 completed/failed 的部分索引让 GROUP BY 走索引扫描。
CREATE INDEX IF NOT EXISTS canvas_generation_jobs_model_health_idx
  ON canvas_generation_jobs (model_id, updated_at DESC)
  WHERE status IN ('completed', 'failed');
