ALTER TABLE canvas_media
  ADD COLUMN IF NOT EXISTS project_id TEXT;

-- Old records predate project binding. Keep them explicitly unbound; only
-- trusted references from an existing cloud project are backfilled below.
UPDATE canvas_media
SET record = jsonb_set(record, '{projectId}', 'null'::JSONB, true)
WHERE NOT (record ? 'projectId');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'canvas_media_project_id_format_check'
  ) THEN
    ALTER TABLE canvas_media
      ADD CONSTRAINT canvas_media_project_id_format_check
      CHECK (
        project_id IS NULL
        OR (
          char_length(project_id) BETWEEN 1 AND 128
          AND project_id ~ '^[A-Za-z0-9._:-]+$'
        )
      ) NOT VALID;
  END IF;
END $$;
ALTER TABLE canvas_media VALIDATE CONSTRAINT canvas_media_project_id_format_check;

CREATE UNIQUE INDEX IF NOT EXISTS canvas_media_owner_id_unique_idx
  ON canvas_media (owner_id, id);

CREATE TABLE IF NOT EXISTS canvas_media_project_bindings (
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (owner_id, project_id, media_id),
  FOREIGN KEY (owner_id, project_id)
    REFERENCES canvas_cloud_projects(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, media_id)
    REFERENCES canvas_media(owner_id, id) ON DELETE CASCADE
);

-- A legacy document is the only available binding signal, but it is not safe
-- to guess when one owner media id appears in several projects. Backfill only
-- an unambiguous single-project reference; all ambiguous history stays
-- unbound and must be copied through a new project-scoped upload.
WITH document_reference AS (
  SELECT DISTINCT
    project.owner_id,
    project.id AS project_id,
    node.value->'data'->'media'->>'serverId' AS media_id
  FROM canvas_cloud_projects AS project
  JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(project.document->'nodes') = 'array' THEN project.document->'nodes'
      ELSE '[]'::JSONB
    END
  ) AS node(value) ON TRUE
  WHERE NULLIF(node.value->'data'->'media'->>'serverId', '') IS NOT NULL
), unambiguous_reference AS (
  SELECT owner_id, media_id, MIN(project_id) AS project_id
  FROM document_reference
  GROUP BY owner_id, media_id
  HAVING COUNT(*) = 1
)
INSERT INTO canvas_media_project_bindings (owner_id, project_id, media_id, created_at)
SELECT reference.owner_id, reference.project_id, media.id, COALESCE(media.ready_at, media.created_at)
FROM unambiguous_reference AS reference
JOIN canvas_media AS media
  ON media.owner_id = reference.owner_id
 AND media.id = reference.media_id
 AND media.status = 'ready'
ON CONFLICT DO NOTHING;

-- Preserve the immutable primary binding for every safely backfilled row.
WITH single_binding AS (
  SELECT owner_id, media_id, MIN(project_id) AS project_id
  FROM canvas_media_project_bindings
  GROUP BY owner_id, media_id
  HAVING COUNT(*) = 1
)
UPDATE canvas_media AS media
SET project_id = binding.project_id,
    record = jsonb_set(media.record, '{projectId}', to_jsonb(binding.project_id), true)
FROM single_binding AS binding
WHERE media.owner_id = binding.owner_id
  AND media.id = binding.media_id
  AND media.project_id IS NULL;

-- Supports a safe rerun after an interrupted rollout where project_id was
-- written before its authoritative binding row.
INSERT INTO canvas_media_project_bindings (owner_id, project_id, media_id, created_at)
SELECT media.owner_id, media.project_id, media.id, media.created_at
FROM canvas_media AS media
JOIN canvas_cloud_projects AS project
  ON project.owner_id = media.owner_id
 AND project.id = media.project_id
WHERE media.project_id IS NOT NULL
ON CONFLICT DO NOTHING;

ALTER TABLE canvas_media
  DROP CONSTRAINT IF EXISTS canvas_media_project_record_check;
ALTER TABLE canvas_media
  ADD CONSTRAINT canvas_media_project_record_check
  CHECK (
    COALESCE(
      (record ? 'projectId')
      AND (
        (project_id IS NULL AND jsonb_typeof(record->'projectId') = 'null')
        OR (
          project_id IS NOT NULL
          AND jsonb_typeof(record->'projectId') = 'string'
          AND record->>'projectId' IS NOT DISTINCT FROM project_id
        )
      ),
      FALSE
    )
  ) NOT VALID;
ALTER TABLE canvas_media VALIDATE CONSTRAINT canvas_media_project_record_check;

ALTER TABLE canvas_media_project_bindings ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE canvas_media_project_bindings FROM PUBLIC;
DO $$
DECLARE
  browser_role TEXT;
BEGIN
  FOR browser_role IN
    SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE canvas_media_project_bindings FROM %I',
      browser_role
    );
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS canvas_media_binding_media_idx
  ON canvas_media_project_bindings (owner_id, media_id, project_id);

CREATE INDEX IF NOT EXISTS canvas_media_owner_active_idx
  ON canvas_media (owner_id, status)
  WHERE status IN ('pending', 'uploading');

CREATE INDEX IF NOT EXISTS canvas_media_owner_failed_retention_idx
  ON canvas_media (owner_id, updated_at DESC, id DESC)
  WHERE status = 'failed';

CREATE INDEX IF NOT EXISTS canvas_media_owner_created_idx
  ON canvas_media (owner_id, created_at DESC);
