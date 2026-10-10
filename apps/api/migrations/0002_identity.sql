CREATE TABLE IF NOT EXISTS canvas_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  normalized_email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  last_login_at TIMESTAMPTZ,
  CHECK (normalized_email = LOWER(normalized_email)),
  CHECK (CHAR_LENGTH(normalized_email) BETWEEN 3 AND 254),
  CHECK (CHAR_LENGTH(display_name) BETWEEN 1 AND 48)
);

CREATE TABLE IF NOT EXISTS canvas_sessions (
  token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id TEXT NOT NULL REFERENCES canvas_users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS canvas_sessions_user_active_idx
  ON canvas_sessions (user_id, expires_at DESC)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS canvas_sessions_expiry_idx
  ON canvas_sessions (expires_at)
  WHERE revoked_at IS NULL;

ALTER TABLE canvas_wallets
  ADD CONSTRAINT canvas_wallets_owner_user_fk
  FOREIGN KEY (owner_id) REFERENCES canvas_users(id) ON DELETE RESTRICT
  NOT VALID;
