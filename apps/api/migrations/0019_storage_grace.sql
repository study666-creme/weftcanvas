-- 存储配额宽限：会员降级导致配额低于用量时，记录 7 天调整期。
-- 到期前不清理（用户可整理素材或续费），到期后由每日清扫任务按
-- “最旧未绑定素材优先”清回配额内。配额恢复（续费）或用量回落时删除记录。

CREATE TABLE IF NOT EXISTS canvas_storage_grace (
  owner_id TEXT PRIMARY KEY,
  from_tier TEXT NOT NULL CHECK (char_length(from_tier) BETWEEN 1 AND 32),
  quota_bytes BIGINT NOT NULL CHECK (quota_bytes > 0),
  usage_bytes BIGINT NOT NULL CHECK (usage_bytes >= 0),
  deadline TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (usage_bytes > quota_bytes),
  FOREIGN KEY (owner_id) REFERENCES canvas_cloud_principals(id) ON DELETE CASCADE
);

-- 与其他 canvas_% 表一致：RLS 开启并撤销公共访问（readiness 探针会校验）。
ALTER TABLE canvas_storage_grace ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE canvas_storage_grace FROM PUBLIC;

CREATE INDEX IF NOT EXISTS canvas_storage_grace_deadline_idx
  ON canvas_storage_grace (deadline ASC);
