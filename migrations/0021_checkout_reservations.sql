-- 0021_checkout_reservations — atomically reserve finite inventory before a
-- shopper leaves for a hosted checkout or Lightning invoice.
--
-- The compact cart snapshot lives here rather than in provider metadata (Stripe
-- metadata values are capped at 500 characters). Reservations are settled with
-- the paid order or released by a verified provider failure/expiry event.
-- Self-rendered Lightning holds are also reclaimed lazily after invoice expiry.

CREATE TABLE IF NOT EXISTS checkout_reservations (
  public_id   TEXT PRIMARY KEY,
  items       TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active', -- active | payment_pending | settled | released
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_checkout_reservations_expiry
  ON checkout_reservations(payment_method, status, expires_at);

-- Explicit linkage keeps pending rows created before this migration on the
-- legacy settlement path instead of incorrectly assuming they own a hold.
ALTER TABLE pending_payments ADD COLUMN reservation_id TEXT;
