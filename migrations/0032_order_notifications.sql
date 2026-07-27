-- 0032: transactional-email outbox, one row per email per order. Additive.
--
-- Why: the order INSERT and the confirmation/notification sends were only
-- connected by "the same request usually does both". A crash, cancelled
-- waitUntil, or failed send after the order committed lost the email forever —
-- and the webhook redelivery path returns early on an existing order, so the
-- provider's retries never reached the email code. These rows are committed in
-- the SAME batch as the order, so an order cannot exist without its
-- notification intent, and any later touch can finish the delivery.
--
-- One row PER EMAIL, not per order: the customer receipt and the owner
-- notification succeed or fail independently, and a single marker cannot say
-- "customer got it, owner didn't".
--
-- States: pending → processing (leased, attempt counted) → sent.
--   skipped = not applicable at send time (no customer email, notify-to unset,
--             email disabled) — terminal, not an error.
--   dead    = gave up after repeated failures; last_error says why.
-- The claim to processing is a conditional UPDATE, so concurrent deliverers
-- (settlement, webhook redelivery, the piggyback sweep) cannot double-send.
-- Delivery is at-least-once BY CHOICE: rows are marked sent only after the
-- send succeeds, so a crash between the two can duplicate. A missing receipt
-- for money taken is worse than a duplicate.
CREATE TABLE order_notifications (
  order_id INTEGER NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  PRIMARY KEY (order_id, kind)
);

-- The sweep scans for stale undelivered work; keep that read off the main PK.
CREATE INDEX idx_order_notifications_unsent
  ON order_notifications (state, lease_expires_at, created_at);
