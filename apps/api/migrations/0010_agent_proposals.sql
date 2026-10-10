ALTER TABLE canvas_agent_runs
  ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS proposal JSONB,
  ADD COLUMN IF NOT EXISTS proposal_status TEXT,
  ADD COLUMN IF NOT EXISTS context_revision TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS receipt JSONB;

UPDATE canvas_agent_runs
SET context_revision = COALESCE(NULLIF(canvas_context ->> 'contextRevision', ''), 'legacy');

-- Runs completed before proposal support already executed in the browser. Keep
-- their historical behavior while all new runtime output follows the policy.
UPDATE canvas_agent_runs
SET execution_mode = 'direct'
WHERE jsonb_typeof(actions) = 'array' AND jsonb_array_length(actions) > 0;

ALTER TABLE canvas_agent_runs
  DROP CONSTRAINT IF EXISTS canvas_agent_runs_execution_mode,
  DROP CONSTRAINT IF EXISTS canvas_agent_runs_proposal_status,
  DROP CONSTRAINT IF EXISTS canvas_agent_runs_proposal_object,
  DROP CONSTRAINT IF EXISTS canvas_agent_runs_receipt_object,
  DROP CONSTRAINT IF EXISTS canvas_agent_runs_context_revision_length;

ALTER TABLE canvas_agent_runs
  ADD CONSTRAINT canvas_agent_runs_execution_mode
    CHECK (execution_mode IN ('none', 'direct', 'proposal')),
  ADD CONSTRAINT canvas_agent_runs_proposal_status
    CHECK (proposal_status IS NULL OR proposal_status IN ('pending', 'confirmed', 'dismissed')),
  ADD CONSTRAINT canvas_agent_runs_proposal_object
    CHECK (proposal IS NULL OR jsonb_typeof(proposal) = 'object'),
  ADD CONSTRAINT canvas_agent_runs_receipt_object
    CHECK (receipt IS NULL OR jsonb_typeof(receipt) = 'object'),
  ADD CONSTRAINT canvas_agent_runs_context_revision_length
    CHECK (char_length(context_revision) BETWEEN 1 AND 128);
