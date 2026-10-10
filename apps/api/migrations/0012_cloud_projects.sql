CREATE TABLE IF NOT EXISTS canvas_cloud_principals (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  CHECK (char_length(id) BETWEEN 1 AND 128)
);

INSERT INTO canvas_cloud_principals (id, created_at, last_seen_at)
SELECT id, created_at, updated_at
FROM canvas_users
ON CONFLICT (id) DO NOTHING;

ALTER TABLE canvas_media
  DROP CONSTRAINT IF EXISTS canvas_media_owner_id_fkey;
ALTER TABLE canvas_media
  ADD CONSTRAINT canvas_media_owner_principal_fk
  FOREIGN KEY (owner_id) REFERENCES canvas_cloud_principals(id) ON DELETE RESTRICT
  NOT VALID;
ALTER TABLE canvas_media VALIDATE CONSTRAINT canvas_media_owner_principal_fk;

ALTER TABLE canvas_agent_conversations
  DROP CONSTRAINT IF EXISTS canvas_agent_conversations_owner_id_fkey;
ALTER TABLE canvas_agent_conversations
  ADD CONSTRAINT canvas_agent_conversations_owner_principal_fk
  FOREIGN KEY (owner_id) REFERENCES canvas_cloud_principals(id) ON DELETE CASCADE
  NOT VALID;
ALTER TABLE canvas_agent_conversations VALIDATE CONSTRAINT canvas_agent_conversations_owner_principal_fk;

ALTER TABLE canvas_agent_runs
  DROP CONSTRAINT IF EXISTS canvas_agent_runs_owner_id_fkey;
ALTER TABLE canvas_agent_runs
  ADD CONSTRAINT canvas_agent_runs_owner_principal_fk
  FOREIGN KEY (owner_id) REFERENCES canvas_cloud_principals(id) ON DELETE CASCADE
  NOT VALID;
ALTER TABLE canvas_agent_runs VALIDATE CONSTRAINT canvas_agent_runs_owner_principal_fk;

CREATE TABLE IF NOT EXISTS canvas_cloud_projects (
  owner_id TEXT NOT NULL REFERENCES canvas_cloud_principals(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  current_revision BIGINT NOT NULL,
  document JSONB NOT NULL,
  document_bytes BIGINT NOT NULL,
  local_media_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (owner_id, id),
  CHECK (char_length(id) BETWEEN 1 AND 128),
  CHECK (char_length(title) BETWEEN 1 AND 64),
  CHECK (schema_version = 1),
  CHECK (current_revision >= 1),
  CHECK (document_bytes >= 0),
  CHECK (local_media_count >= 0),
  CHECK (jsonb_typeof(document) = 'object'),
  CHECK (document->>'projectId' = id)
);

CREATE INDEX IF NOT EXISTS canvas_cloud_projects_owner_updated_idx
  ON canvas_cloud_projects (owner_id, updated_at DESC, id ASC);

CREATE TABLE IF NOT EXISTS canvas_cloud_project_revisions (
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  revision BIGINT NOT NULL,
  schema_version INTEGER NOT NULL,
  document JSONB NOT NULL,
  document_bytes BIGINT NOT NULL,
  checksum TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (owner_id, project_id, revision),
  FOREIGN KEY (owner_id, project_id)
    REFERENCES canvas_cloud_projects(owner_id, id) ON DELETE CASCADE,
  CHECK (revision >= 1),
  CHECK (schema_version = 1),
  CHECK (document_bytes >= 0),
  CHECK (checksum ~ '^[a-f0-9]{64}$'),
  CHECK (jsonb_typeof(document) = 'object')
);

CREATE INDEX IF NOT EXISTS canvas_cloud_project_revisions_project_created_idx
  ON canvas_cloud_project_revisions (owner_id, project_id, created_at DESC, revision DESC);

-- Canvas tables are server-only. MemFire/Supabase-style deployments may grant
-- public-schema objects to PostgREST roles through default privileges, so new
-- cloud data must be deny-by-default before this migration commits.
ALTER TABLE canvas_cloud_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE canvas_cloud_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE canvas_cloud_project_revisions ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE canvas_cloud_principals FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE canvas_cloud_projects FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE canvas_cloud_project_revisions FROM PUBLIC;
