CREATE TABLE IF NOT EXISTS canvas_api_rate_limits (
  scope TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scope, subject_id, window_start),
  CHECK (scope ~ '^[a-z0-9:_-]{1,64}$'),
  CHECK (char_length(subject_id) BETWEEN 1 AND 256)
);

CREATE INDEX IF NOT EXISTS canvas_api_rate_limits_expiry_idx
  ON canvas_api_rate_limits (expires_at);

CREATE INDEX IF NOT EXISTS canvas_generation_jobs_owner_project_updated_idx
  ON canvas_generation_jobs (owner_id, project_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS canvas_generation_jobs_owner_active_idx
  ON canvas_generation_jobs (owner_id, status)
  WHERE status IN (
    'reserved', 'submitting', 'queued', 'running', 'validating',
    'submission_unknown'
  );
