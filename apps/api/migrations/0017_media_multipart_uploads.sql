CREATE TABLE IF NOT EXISTS canvas_media_multipart_uploads (
  media_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  project_id TEXT,
  session_id UUID NOT NULL UNIQUE,
  storage_upload_id TEXT NOT NULL,
  part_size BIGINT NOT NULL CHECK (part_size = 8388608),
  part_count INTEGER NOT NULL CHECK (part_count BETWEEN 1 AND 10000),
  status TEXT NOT NULL CHECK (
    status IN ('active', 'completing', 'queued', 'processing', 'completed', 'aborted', 'failed')
  ),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  expires_at TIMESTAMPTZ NOT NULL,
  assembled_at TIMESTAMPTZ,
  terminal_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (owner_id, media_id)
    REFERENCES canvas_media(owner_id, id) ON DELETE CASCADE,
  CHECK (
    project_id IS NULL
    OR (
      char_length(project_id) BETWEEN 1 AND 128
      AND project_id ~ '^[A-Za-z0-9._:-]+$'
    )
  ),
  CHECK (
    char_length(storage_upload_id) BETWEEN 1 AND 2048
    AND storage_upload_id !~ '[[:cntrl:]]'
  ),
  CHECK (expires_at > created_at),
  CHECK (
    status NOT IN ('queued', 'processing', 'completed')
    OR assembled_at IS NOT NULL
  ),
  CHECK (
    status NOT IN ('active', 'completing', 'aborted')
    OR assembled_at IS NULL
  ),
  CHECK (
    (status IN ('completed', 'aborted', 'failed') AND terminal_at IS NOT NULL)
    OR (status NOT IN ('completed', 'aborted', 'failed') AND terminal_at IS NULL)
  ),
  CHECK (
    (status = 'queued' AND next_attempt_at IS NOT NULL)
    OR (status <> 'queued' AND next_attempt_at IS NULL)
  ),
  CHECK (
    (
      status = 'processing'
      AND lease_owner IS NOT NULL
      AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
    OR (
      status <> 'processing'
      AND lease_owner IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
    )
  ),
  CHECK (
    (status = 'failed' AND last_error_code IS NOT NULL AND last_error_message IS NOT NULL)
    OR status <> 'failed'
  ),
  CHECK ((last_error_code IS NULL) = (last_error_message IS NULL))
);

CREATE INDEX IF NOT EXISTS canvas_media_multipart_owner_status_idx
  ON canvas_media_multipart_uploads (owner_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS canvas_media_multipart_project_idx
  ON canvas_media_multipart_uploads (owner_id, project_id, media_id)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS canvas_media_multipart_expiry_idx
  ON canvas_media_multipart_uploads (expires_at)
  WHERE status IN ('active', 'completing');

CREATE INDEX IF NOT EXISTS canvas_media_multipart_queue_idx
  ON canvas_media_multipart_uploads (next_attempt_at, created_at, media_id)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS canvas_media_multipart_lease_idx
  ON canvas_media_multipart_uploads (lease_expires_at, media_id)
  WHERE status = 'processing';

ALTER TABLE canvas_media_multipart_uploads ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE canvas_media_multipart_uploads FROM PUBLIC;
DO $$
DECLARE
  browser_role TEXT;
BEGIN
  FOR browser_role IN
    SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE canvas_media_multipart_uploads FROM %I',
      browser_role
    );
  END LOOP;
END $$;
