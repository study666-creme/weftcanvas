CREATE TABLE IF NOT EXISTS canvas_model_catalog_snapshots (
  id TEXT PRIMARY KEY,
  snapshot JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT canvas_model_catalog_snapshots_id CHECK (id = 'default')
);
