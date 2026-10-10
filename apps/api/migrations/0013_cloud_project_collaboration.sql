CREATE TABLE IF NOT EXISTS canvas_cloud_project_members (
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES canvas_cloud_principals(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (owner_id, project_id, principal_id),
  FOREIGN KEY (owner_id, project_id)
    REFERENCES canvas_cloud_projects(owner_id, id) ON DELETE CASCADE,
  CHECK (role = 'member' OR principal_id = owner_id)
);

CREATE INDEX IF NOT EXISTS canvas_cloud_project_members_project_idx
  ON canvas_cloud_project_members (owner_id, project_id, created_at ASC, principal_id ASC);

CREATE INDEX IF NOT EXISTS canvas_cloud_project_members_principal_idx
  ON canvas_cloud_project_members (principal_id, created_at DESC);

INSERT INTO canvas_cloud_project_members (owner_id, project_id, principal_id, role, created_at)
SELECT owner_id, id, owner_id, 'owner', created_at
FROM canvas_cloud_projects
ON CONFLICT (owner_id, project_id, principal_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS canvas_cloud_project_invitations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  inviter_id TEXT NOT NULL REFERENCES canvas_cloud_principals(id) ON DELETE CASCADE,
  invitee_id TEXT NOT NULL REFERENCES canvas_cloud_principals(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role = 'member'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  FOREIGN KEY (owner_id, project_id)
    REFERENCES canvas_cloud_projects(owner_id, id) ON DELETE CASCADE,
  CHECK (id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'),
  CHECK (invitee_id <> owner_id),
  CHECK (expires_at > created_at),
  CHECK ((status = 'accepted' AND accepted_at IS NOT NULL) OR (status <> 'accepted'))
);

CREATE INDEX IF NOT EXISTS canvas_cloud_project_invitations_invitee_idx
  ON canvas_cloud_project_invitations (invitee_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS canvas_cloud_project_invitations_project_idx
  ON canvas_cloud_project_invitations (owner_id, project_id, status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS canvas_cloud_project_invitations_pending_unique_idx
  ON canvas_cloud_project_invitations (owner_id, project_id, invitee_id)
  WHERE status = 'pending';

-- Collaboration state is authorized only by the Canvas API. No browser role
-- receives a direct table policy.
ALTER TABLE canvas_cloud_project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE canvas_cloud_project_invitations ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE canvas_cloud_project_members FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE canvas_cloud_project_invitations FROM PUBLIC;
