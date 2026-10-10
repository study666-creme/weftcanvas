CREATE TABLE IF NOT EXISTS canvas_cloud_asset_libraries (
  owner_id TEXT PRIMARY KEY REFERENCES canvas_cloud_principals(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL,
  current_revision BIGINT NOT NULL,
  document JSONB NOT NULL,
  document_bytes BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (schema_version = 1),
  CHECK (current_revision >= 1),
  CHECK (document_bytes >= 0),
  CHECK (jsonb_typeof(document) = 'object')
);

ALTER TABLE canvas_cloud_asset_libraries ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE canvas_cloud_asset_libraries FROM PUBLIC;

DO $$
DECLARE
  browser_role TEXT;
BEGIN
  FOR browser_role IN
    SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE canvas_cloud_asset_libraries FROM %I',
      browser_role
    );
  END LOOP;
END $$;
