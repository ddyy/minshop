-- Refund accounting: split the single refunded_cents aggregate into two
-- independent components and make the aggregate structurally derived.
--
--   provider_refunded_cents  ABSOLUTE cumulative total confirmed by the provider
--                            (Stripe's charge.amount_refunded). Never additive —
--                            it is synchronised to the provider's own number, so
--                            replayed and out-of-order webhooks are no-ops.
--   external_refunded_cents  ADDITIVE. Manual records: Lightning/OpenNode
--                            repayments, cash/bank refunds, demo adjustments.
--
-- refunded_cents stays under its original name so every existing consumer of
-- `amount_total_cents - refunded_cents` keeps working, but it is now GENERATED:
-- no write path can leave it out of sync with its components, and it is clamped
-- at the order total so net revenue can never go negative even if the two
-- components are made to disagree with reality.

-- ---------------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------------

-- Freeing the name for the generated column. Verified on D1: rename → add →
-- backfill → add-generated → drop works without a table rebuild.
ALTER TABLE orders RENAME COLUMN refunded_cents TO refunded_cents_legacy;

-- Stripe PaymentIntent. charge.refunded identifies the Charge and its
-- PaymentIntent but not the Checkout Session, so this is what refund webhooks
-- resolve an order by. Backfilled lazily for pre-existing orders (see
-- refund_sync_events.status = 'unmatched').
ALTER TABLE orders ADD COLUMN provider_payment_id TEXT;

ALTER TABLE orders ADD COLUMN provider_refunded_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN external_refunded_cents INTEGER NOT NULL DEFAULT 0;

-- Reconciliation review. An ACTIVE review is `reason IS NOT NULL AND
-- reviewed_at IS NULL` — a state rather than a permanent boolean, so a new
-- conflict can reopen a previously acknowledged one.
ALTER TABLE orders ADD COLUMN refund_review_reason TEXT;
ALTER TABLE orders ADD COLUMN refund_reviewed_at TEXT;
ALTER TABLE orders ADD COLUMN refund_reviewed_by TEXT;

-- Attribute the existing aggregate to the component that will own future
-- writes for that rail, so the two models agree from the first request.
-- Stripe (and legacy NULL, which predates payment_method and was Stripe-only)
-- is provider-authoritative; every other rail can only ever be recorded by hand.
UPDATE orders
   SET provider_refunded_cents = refunded_cents_legacy
 WHERE refunded_cents_legacy > 0
   AND (payment_method IS NULL OR payment_method = 'stripe');

UPDATE orders
   SET external_refunded_cents = refunded_cents_legacy
 WHERE refunded_cents_legacy > 0
   AND payment_method IS NOT NULL
   AND payment_method <> 'stripe';

ALTER TABLE orders ADD COLUMN refunded_cents INTEGER
  GENERATED ALWAYS AS (
    MIN(amount_total_cents, provider_refunded_cents + external_refunded_cents)
  ) VIRTUAL;

-- ---------------------------------------------------------------------------
-- refunds — the audit ledger
-- ---------------------------------------------------------------------------
--
-- History and idempotency, NOT the accounting source: the order's two component
-- columns are. A ledger row can be `pending` (claimed) or `failed` without ever
-- having moved the totals.

CREATE TABLE IF NOT EXISTS refunds (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id           TEXT    NOT NULL UNIQUE,
  order_id            INTEGER NOT NULL REFERENCES orders(id),

  -- provider_api      minshop called the provider's refund API
  -- provider_sync     provider told us a total we didn't have (webhook/manual sync)
  -- manual_external   money returned outside the provider, recorded by hand
  -- manual_reversal   corrects a mistaken manual/demo entry; moves no money
  -- demo              demo order bookkeeping; never touches a provider
  -- legacy            backfilled from refunded_cents at this migration
  kind                TEXT    NOT NULL,

  -- pending → succeeded | failed | canceled. `pending` doubles as the claim
  -- that makes the guarded refund batch idempotent (see features/refunds).
  status              TEXT    NOT NULL DEFAULT 'pending',

  -- Always the DELTA this row represents, never a cumulative total — including
  -- for provider_sync rows, which record only the amount the provider's new
  -- total advanced by. Negative for manual_reversal.
  amount_cents        INTEGER NOT NULL,

  provider            TEXT,
  provider_refund_id  TEXT,
  provider_event_id   TEXT,
  reason              TEXT,
  note                TEXT,
  created_by          TEXT,

  -- Full (not partial) UNIQUE: ON CONFLICT can only target a full unique index.
  idempotency_key     TEXT    NOT NULL UNIQUE,

  -- Multiple NULLs are allowed under UNIQUE in SQLite, so this permits any
  -- number of non-reversal rows while allowing each refund to be voided once.
  reverses_refund_id  INTEGER UNIQUE REFERENCES refunds(id),

  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- One ledger row per provider refund / per provider event, but only where those
-- ids exist — hence partial, so the many manual rows with NULLs don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS refunds_provider_refund
  ON refunds (provider, provider_refund_id)
  WHERE provider_refund_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS refunds_provider_event
  ON refunds (provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL;

-- Order detail reads the history newest-first.
CREATE INDEX IF NOT EXISTS refunds_order_created ON refunds (order_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- refund_sync_events — provider webhook reconciliation
-- ---------------------------------------------------------------------------
--
-- Persisted BEFORE the order is resolved, so a valid event for an order we
-- can't correlate yet is never lost and Stripe is never made to retry it
-- forever. Only the fields reconciliation needs, not the whole payload.

CREATE TABLE IF NOT EXISTS refund_sync_events (
  provider_event_id         TEXT    PRIMARY KEY,
  provider                  TEXT    NOT NULL,
  provider_payment_id       TEXT,
  provider_charge_id        TEXT,
  -- The provider's ABSOLUTE cumulative refunded total for that charge.
  cumulative_refunded_cents INTEGER NOT NULL,
  currency                  TEXT,
  -- pending → processed | unmatched | failed | dismissed
  -- `dismissed` is the terminal state for a conflict a human resolved out of
  -- band; without it the reconciliation queue could never empty.
  status                    TEXT    NOT NULL DEFAULT 'pending',
  attempts                  INTEGER NOT NULL DEFAULT 0,
  last_error                TEXT,
  created_at                TEXT    NOT NULL DEFAULT (datetime('now')),
  processed_at              TEXT
);

-- Drives the admin reconciliation queue and the retry of unmatched events.
CREATE INDEX IF NOT EXISTS refund_sync_events_status
  ON refund_sync_events (status, created_at);

CREATE INDEX IF NOT EXISTS refund_sync_events_payment
  ON refund_sync_events (provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- history backfill
-- ---------------------------------------------------------------------------
--
-- One entry per already-refunded order so the ledger isn't blank for refunds
-- that predate it. Historical only — the component columns backfilled above
-- remain the accounting source, and these rows are never re-applied.
INSERT INTO refunds (
  public_id, order_id, kind, status, amount_cents, provider,
  reason, idempotency_key, created_at, updated_at
)
SELECT
  'legacy-' || o.id,
  o.id,
  'legacy',
  'succeeded',
  o.refunded_cents_legacy,
  o.payment_method,
  'Recorded before the refund ledger existed',
  'legacy-order-' || o.id,
  COALESCE(o.created_at, datetime('now')),
  datetime('now')
  FROM orders o
 WHERE o.refunded_cents_legacy > 0;

ALTER TABLE orders DROP COLUMN refunded_cents_legacy;

-- Refund webhooks resolve an order by PaymentIntent on every charge.refunded.
CREATE INDEX IF NOT EXISTS orders_provider_payment
  ON orders (provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;
