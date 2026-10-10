CREATE TABLE IF NOT EXISTS canvas_media (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES canvas_users(id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK (source IN ('upload', 'generation')),
  idempotency_key TEXT,
  object_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio')),
  name TEXT NOT NULL,
  declared_mime_type TEXT NOT NULL,
  detected_mime_type TEXT,
  expected_size BIGINT NOT NULL CHECK (expected_size > 0),
  size BIGINT CHECK (size >= 0),
  expected_sha256 TEXT CHECK (expected_sha256 IS NULL OR expected_sha256 ~ '^[a-f0-9]{64}$'),
  sha256 TEXT CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  width INTEGER CHECK (width > 0),
  height INTEGER CHECK (height > 0),
  duration_ms INTEGER CHECK (duration_ms > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'uploading', 'ready', 'failed')),
  error_code TEXT,
  error_message TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  record JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  upload_expires_at TIMESTAMPTZ NOT NULL,
  ready_at TIMESTAMPTZ,
  UNIQUE (owner_id, idempotency_key),
  CHECK ((status = 'ready') = (detected_mime_type IS NOT NULL AND size IS NOT NULL AND sha256 IS NOT NULL AND ready_at IS NOT NULL)),
  CHECK ((status = 'failed') = (error_code IS NOT NULL AND error_message IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS canvas_media_owner_updated_idx
  ON canvas_media (owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS canvas_media_pending_expiry_idx
  ON canvas_media (status, upload_expires_at)
  WHERE status IN ('pending', 'uploading');
