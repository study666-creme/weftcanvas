CREATE TABLE IF NOT EXISTS canvas_wallets (
  owner_id TEXT PRIMARY KEY,
  available_credit_micros BIGINT NOT NULL DEFAULT 0 CHECK (available_credit_micros >= 0),
  reserved_credit_micros BIGINT NOT NULL DEFAULT 0 CHECK (reserved_credit_micros >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS canvas_generation_jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  project_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  modality TEXT NOT NULL CHECK (modality IN ('text', 'image', 'video', 'audio')),
  status TEXT NOT NULL CHECK (status IN (
    'reserved', 'submitting', 'queued', 'running', 'validating',
    'submission_unknown', 'completed', 'failed'
  )),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  record JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (owner_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS canvas_generation_jobs_owner_updated_idx
  ON canvas_generation_jobs (owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS canvas_generation_jobs_runnable_idx
  ON canvas_generation_jobs (status, updated_at)
  WHERE status IN ('reserved', 'submitting', 'queued', 'running', 'validating');

CREATE TABLE IF NOT EXISTS canvas_wallet_reservations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES canvas_wallets(owner_id) ON DELETE RESTRICT,
  generation_job_id TEXT NOT NULL UNIQUE REFERENCES canvas_generation_jobs(id) ON DELETE RESTRICT,
  amount_credit_micros BIGINT NOT NULL CHECK (amount_credit_micros >= 0),
  captured_credit_micros BIGINT NOT NULL DEFAULT 0 CHECK (captured_credit_micros >= 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'captured', 'released')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS canvas_wallet_ledger (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES canvas_wallets(owner_id) ON DELETE RESTRICT,
  generation_job_id TEXT REFERENCES canvas_generation_jobs(id) ON DELETE RESTRICT,
  reservation_id TEXT REFERENCES canvas_wallet_reservations(id) ON DELETE RESTRICT,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('credit', 'reserve', 'capture', 'release', 'adjustment')),
  available_delta_micros BIGINT NOT NULL,
  reserved_delta_micros BIGINT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS canvas_wallet_ledger_owner_created_idx
  ON canvas_wallet_ledger (owner_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS canvas_wallet_ledger_reservation_entry_idx
  ON canvas_wallet_ledger (reservation_id, entry_type)
  WHERE reservation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS canvas_wallet_ledger_reservation_settlement_idx
  ON canvas_wallet_ledger (reservation_id)
  WHERE entry_type IN ('capture', 'release');
