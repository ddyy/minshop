-- 0038: durable, append-only audit history for submitted label attempts.
--
-- shipping_labels remains the single active row and purchase lock for an
-- order. It is deliberately mutable so a definitively failed/refunded attempt
-- can yield to a replacement quote. Money-bearing outcomes cannot live only in
-- that row: the replacement would hide or overwrite the previous transaction.
CREATE TABLE shipping_label_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  claim_token TEXT NOT NULL UNIQUE,
  outcome TEXT NOT NULL CHECK (
    outcome IN ('purchased', 'refunded', 'failed', 'force_discarded')
  ),
  shipment_id TEXT NOT NULL,
  rate_id TEXT,
  transaction_id TEXT,
  provider TEXT,
  service TEXT,
  amount_cents INTEGER,
  tracking_number TEXT,
  label_url TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_shipping_label_attempts_order
  ON shipping_label_attempts(order_id, settled_at DESC, id DESC);

-- Preserve money-bearing rows created before this table existed. A legacy
-- active row may predate claim tokens, so give it a deterministic audit token.
INSERT OR IGNORE INTO shipping_label_attempts (
  order_id, claim_token, outcome, shipment_id, rate_id, transaction_id,
  provider, service, amount_cents, tracking_number, label_url, error,
  created_at, settled_at
)
SELECT
  order_id,
  COALESCE(claim_token, 'legacy-order-' || order_id),
  CASE WHEN status = 'purchased' THEN 'purchased' ELSE 'refunded' END,
  shipment_id,
  rate_id,
  transaction_id,
  provider,
  service,
  amount_cents,
  tracking_number,
  label_url,
  error,
  created_at,
  updated_at
FROM shipping_labels
WHERE status = 'purchased'
   OR (status = 'failed' AND transaction_id IS NOT NULL);
