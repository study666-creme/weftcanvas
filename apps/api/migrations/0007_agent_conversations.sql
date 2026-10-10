CREATE TABLE IF NOT EXISTS canvas_agent_conversations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES canvas_users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (char_length(project_id) BETWEEN 1 AND 128),
  CHECK (char_length(title) BETWEEN 1 AND 60)
);

CREATE INDEX IF NOT EXISTS canvas_agent_conversations_owner_project_updated_idx
  ON canvas_agent_conversations (owner_id, project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS canvas_agent_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES canvas_agent_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (char_length(content) BETWEEN 1 AND 16000)
);

CREATE INDEX IF NOT EXISTS canvas_agent_messages_conversation_created_idx
  ON canvas_agent_messages (conversation_id, created_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS canvas_agent_runs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES canvas_users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES canvas_agent_conversations(id) ON DELETE CASCADE,
  user_message_id TEXT NOT NULL REFERENCES canvas_agent_messages(id) ON DELETE RESTRICT,
  assistant_message_id TEXT REFERENCES canvas_agent_messages(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  canvas_context JSONB NOT NULL,
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (owner_id, idempotency_key),
  CHECK (char_length(idempotency_key) BETWEEN 8 AND 128)
);

CREATE INDEX IF NOT EXISTS canvas_agent_runs_conversation_created_idx
  ON canvas_agent_runs (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS canvas_agent_runs_active_idx
  ON canvas_agent_runs (status, created_at)
  WHERE status IN ('queued', 'running');
