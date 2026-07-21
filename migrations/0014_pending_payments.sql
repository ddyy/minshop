-- 0014: pending Lightning payments. Additive.
--
-- Self-rendered Lightning checkout (phoenixd / LNbits) mints a BOLT11 invoice
-- BEFORE the customer pays, then we render our own /pay/<public_id> page and
-- wait for settlement (webhook + poll). The cart snapshot + amounts must survive
-- that wait, but an unpaid invoice is NOT an order — so it lives here, not in
-- `orders`. On settlement we call recordPaidOrder() which creates the real order;
-- this row is marked 'settled'. Keeping unpaid invoices out of `orders` preserves
-- the "orders are paid" invariant (admin lists, revenue stats stay clean).
--
-- Stripe alone skips this table — it round-trips its snapshot via session
-- metadata. OpenNode's webhook can't echo a cart snapshot, so it stores one here
-- too (with bolt11/amount_sat null — it has no BOLT11 of its own to render).

CREATE TABLE IF NOT EXISTS pending_payments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id           TEXT    NOT NULL UNIQUE,   -- customer pay-page + order token
  payment_hash        TEXT    NOT NULL UNIQUE,   -- settlement key (LN payment hash / charge id)
  backend             TEXT    NOT NULL,          -- 'phoenixd' | 'lnbits' | 'opennode'
  bolt11              TEXT,                       -- invoice to render on /pay (null for opennode)
  amount_sat          INTEGER,                    -- invoice amount in sats (null for opennode)
  amount_total_cents  INTEGER NOT NULL,          -- fiat total recorded on the order
  currency            TEXT    NOT NULL,
  email               TEXT,
  items               TEXT,                       -- JSON cart snapshot (→ order_items + stock)
  status              TEXT    NOT NULL DEFAULT 'pending', -- 'pending' | 'settled' | 'expired'
  expires_at          TEXT,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
