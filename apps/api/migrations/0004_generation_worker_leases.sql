ALTER TABLE canvas_generation_jobs
  ADD COLUMN lease_owner TEXT,
  ADD COLUMN lease_token TEXT,
  ADD COLUMN lease_expires_at TIMESTAMPTZ,
  ADD COLUMN next_attempt_at TIMESTAMPTZ,
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN consecutive_error_count INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_error_count >= 0),
  ADD COLUMN last_worker_error TEXT,
  ADD CONSTRAINT canvas_generation_jobs_lease_shape CHECK (
    NUM_NONNULLS(lease_owner, lease_token, lease_expires_at) IN (0, 3)
  );

UPDATE canvas_generation_jobs
SET next_attempt_at = updated_at
WHERE status IN ('reserved', 'submitting', 'queued', 'running', 'validating')
  AND next_attempt_at IS NULL;

DROP INDEX IF EXISTS canvas_generation_jobs_runnable_idx;
CREATE INDEX canvas_generation_jobs_runnable_idx
  ON canvas_generation_jobs (next_attempt_at, lease_expires_at, updated_at)
  WHERE status IN ('reserved', 'submitting', 'queued', 'running', 'validating');

CREATE INDEX canvas_generation_jobs_unknown_idx
  ON canvas_generation_jobs (updated_at)
  WHERE status = 'submission_unknown';
