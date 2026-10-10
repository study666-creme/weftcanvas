ALTER TABLE canvas_agent_runs
  ADD COLUMN IF NOT EXISTS actions JSONB NOT NULL DEFAULT '[]'::JSONB;

ALTER TABLE canvas_agent_runs
  DROP CONSTRAINT IF EXISTS canvas_agent_runs_actions_array;

ALTER TABLE canvas_agent_runs
  ADD CONSTRAINT canvas_agent_runs_actions_array
  CHECK (jsonb_typeof(actions) = 'array');
