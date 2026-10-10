CREATE TABLE IF NOT EXISTS canvas_generation_reconciliations (
  id TEXT PRIMARY KEY,
  generation_job_id TEXT NOT NULL REFERENCES canvas_generation_jobs(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  actor TEXT NOT NULL,
  requested_state JSONB NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::JSONB,
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'rejected')),
  result_status TEXT,
  error_code TEXT,
  error_message TEXT,
  record JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (generation_job_id, idempotency_key),
  CHECK ((status = 'applied') = (result_status IS NOT NULL)),
  CHECK ((status = 'rejected') = (error_code IS NOT NULL AND error_message IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS canvas_generation_reconciliation_pending_idx
  ON canvas_generation_reconciliations (created_at)
  WHERE status = 'pending';
