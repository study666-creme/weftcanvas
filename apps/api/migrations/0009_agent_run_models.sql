ALTER TABLE canvas_agent_runs
  ADD COLUMN IF NOT EXISTS model_id TEXT;

ALTER TABLE canvas_agent_runs
  DROP CONSTRAINT IF EXISTS canvas_agent_runs_model_id_length;

ALTER TABLE canvas_agent_runs
  ADD CONSTRAINT canvas_agent_runs_model_id_length
  CHECK (model_id IS NULL OR char_length(model_id) BETWEEN 1 AND 128);
