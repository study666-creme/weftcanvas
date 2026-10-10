CREATE TABLE IF NOT EXISTS canvas_collaboration_seat_purchases (
  order_no TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES canvas_cloud_principals(id) ON DELETE RESTRICT,
  product_id TEXT NOT NULL,
  seat_count INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  provider_trade_no TEXT,
  purchased_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT,
  CHECK (order_no ~ '^PAY[A-Z0-9]+$'),
  CHECK (product_id = 'canvas-collaboration-seat-1'),
  CHECK (seat_count BETWEEN 1 AND 100),
  CHECK (amount_cents = seat_count * 1500),
  CHECK (provider_trade_no IS NULL OR char_length(provider_trade_no) BETWEEN 1 AND 128),
  CHECK (revocation_reason IS NULL OR char_length(revocation_reason) BETWEEN 1 AND 240),
  CHECK ((revoked_at IS NULL AND revocation_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS canvas_collaboration_seat_purchases_trade_idx
  ON canvas_collaboration_seat_purchases (provider_trade_no)
  WHERE provider_trade_no IS NOT NULL;

CREATE INDEX IF NOT EXISTS canvas_collaboration_seat_purchases_owner_active_idx
  ON canvas_collaboration_seat_purchases (owner_id, purchased_at DESC)
  WHERE revoked_at IS NULL;

ALTER TABLE canvas_collaboration_seat_purchases ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE canvas_collaboration_seat_purchases FROM PUBLIC;

DO $canvas_seat_table_roles$
DECLARE
  browser_role TEXT;
BEGIN
  FOR browser_role IN
    SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE canvas_collaboration_seat_purchases FROM %I',
      browser_role
    );
  END LOOP;
END
$canvas_seat_table_roles$;

-- Prompt Hub settles a paid order through this single idempotent boundary.
-- The order row is the entitlement ledger: active seat capacity is derived
-- from non-revoked purchases instead of trusting a mutable aggregate counter.
CREATE OR REPLACE FUNCTION canvas_grant_collaboration_seats(
  p_owner_id TEXT,
  p_order_no TEXT,
  p_seat_count INTEGER,
  p_amount_cents INTEGER,
  p_provider_trade_no TEXT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $canvas_grant_seats$
DECLARE
  existing_purchase public.canvas_collaboration_seat_purchases%ROWTYPE;
  active_seats BIGINT;
  granted_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF p_owner_id IS NULL OR char_length(p_owner_id) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'invalid collaboration seat owner';
  END IF;
  IF p_order_no IS NULL OR p_order_no !~ '^PAY[A-Z0-9]+$' THEN
    RAISE EXCEPTION 'invalid collaboration seat order';
  END IF;
  IF p_seat_count IS NULL OR p_seat_count NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid collaboration seat count';
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <> p_seat_count * 1500 THEN
    RAISE EXCEPTION 'invalid collaboration seat amount';
  END IF;
  IF p_provider_trade_no IS NULL OR char_length(p_provider_trade_no) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'invalid collaboration seat provider trade';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_owner_id, 0));

  INSERT INTO public.canvas_cloud_principals (id, created_at, last_seen_at)
  VALUES (p_owner_id, granted_at, granted_at)
  ON CONFLICT (id) DO UPDATE
    SET last_seen_at = GREATEST(public.canvas_cloud_principals.last_seen_at, EXCLUDED.last_seen_at);

  INSERT INTO public.canvas_collaboration_seat_purchases (
    order_no,
    owner_id,
    product_id,
    seat_count,
    amount_cents,
    provider_trade_no,
    purchased_at
  ) VALUES (
    p_order_no,
    p_owner_id,
    'canvas-collaboration-seat-1',
    p_seat_count,
    p_amount_cents,
    p_provider_trade_no,
    granted_at
  )
  ON CONFLICT (order_no) DO NOTHING;

  SELECT * INTO existing_purchase
  FROM public.canvas_collaboration_seat_purchases
  WHERE order_no = p_order_no;

  IF existing_purchase.order_no IS NULL
    OR existing_purchase.owner_id IS DISTINCT FROM p_owner_id
    OR existing_purchase.product_id IS DISTINCT FROM 'canvas-collaboration-seat-1'
    OR existing_purchase.seat_count IS DISTINCT FROM p_seat_count
    OR existing_purchase.amount_cents IS DISTINCT FROM p_amount_cents
    OR existing_purchase.provider_trade_no IS DISTINCT FROM p_provider_trade_no
  THEN
    RAISE EXCEPTION 'collaboration seat order mismatch';
  END IF;

  SELECT COALESCE(SUM(seat_count), 0)::BIGINT INTO active_seats
  FROM public.canvas_collaboration_seat_purchases
  WHERE owner_id = p_owner_id AND revoked_at IS NULL;

  RETURN active_seats;
END
$canvas_grant_seats$;

REVOKE ALL ON FUNCTION public.canvas_grant_collaboration_seats(TEXT, TEXT, INTEGER, INTEGER, TEXT) FROM PUBLIC;

DO $canvas_seat_function_roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.canvas_grant_collaboration_seats(TEXT, TEXT, INTEGER, INTEGER, TEXT) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.canvas_grant_collaboration_seats(TEXT, TEXT, INTEGER, INTEGER, TEXT) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.canvas_grant_collaboration_seats(TEXT, TEXT, INTEGER, INTEGER, TEXT) TO service_role;
  END IF;
END
$canvas_seat_function_roles$;

-- Refunds revoke the purchase row rather than decrementing a second balance.
-- The owner advisory lock is the same lock used by invitation creation and
-- acceptance, so a refund cannot race a newly occupied seat.
CREATE OR REPLACE FUNCTION canvas_revoke_collaboration_seats(
  p_owner_id TEXT,
  p_order_no TEXT,
  p_reason TEXT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $canvas_revoke_seats$
DECLARE
  purchase public.canvas_collaboration_seat_purchases%ROWTYPE;
  active_seats BIGINT;
  occupied_seats BIGINT;
BEGIN
  IF p_owner_id IS NULL OR char_length(p_owner_id) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'invalid collaboration seat owner';
  END IF;
  IF p_order_no IS NULL OR p_order_no !~ '^PAY[A-Z0-9]+$' THEN
    RAISE EXCEPTION 'invalid collaboration seat order';
  END IF;
  IF p_reason IS NULL OR char_length(p_reason) NOT BETWEEN 1 AND 240 THEN
    RAISE EXCEPTION 'invalid collaboration seat revocation reason';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_owner_id, 0));

  SELECT * INTO purchase
  FROM public.canvas_collaboration_seat_purchases
  WHERE order_no = p_order_no
  FOR UPDATE;

  IF purchase.order_no IS NULL OR purchase.owner_id IS DISTINCT FROM p_owner_id THEN
    RAISE EXCEPTION 'collaboration seat purchase not found';
  END IF;

  IF purchase.revoked_at IS NOT NULL THEN
    SELECT COALESCE(SUM(seat_count), 0)::BIGINT INTO active_seats
    FROM public.canvas_collaboration_seat_purchases
    WHERE owner_id = p_owner_id AND revoked_at IS NULL;
    RETURN active_seats;
  END IF;

  SELECT COALESCE(SUM(seat_count), 0)::BIGINT - purchase.seat_count INTO active_seats
  FROM public.canvas_collaboration_seat_purchases
  WHERE owner_id = p_owner_id AND revoked_at IS NULL;

  SELECT COUNT(*)::BIGINT INTO occupied_seats
  FROM (
    SELECT principal_id
    FROM public.canvas_cloud_project_members
    WHERE owner_id = p_owner_id AND role = 'member'
    UNION
    SELECT invitee_id AS principal_id
    FROM public.canvas_cloud_project_invitations
    WHERE owner_id = p_owner_id
      AND status = 'pending'
      AND expires_at > clock_timestamp()
  ) AS occupied;

  -- Every account keeps one included collaborator seat. Do not revoke paid
  -- capacity when that would put current members or pending invites over it.
  IF occupied_seats > active_seats + 1 THEN
    RAISE EXCEPTION 'collaboration seat refund would exceed current usage';
  END IF;

  UPDATE public.canvas_collaboration_seat_purchases
  SET revoked_at = clock_timestamp(), revocation_reason = p_reason
  WHERE order_no = p_order_no;

  RETURN active_seats;
END
$canvas_revoke_seats$;

REVOKE ALL ON FUNCTION public.canvas_revoke_collaboration_seats(TEXT, TEXT, TEXT) FROM PUBLIC;

DO $canvas_seat_revoke_roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.canvas_revoke_collaboration_seats(TEXT, TEXT, TEXT) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.canvas_revoke_collaboration_seats(TEXT, TEXT, TEXT) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.canvas_revoke_collaboration_seats(TEXT, TEXT, TEXT) TO service_role;
  END IF;
END
$canvas_seat_revoke_roles$;

NOTIFY pgrst, 'reload schema';
