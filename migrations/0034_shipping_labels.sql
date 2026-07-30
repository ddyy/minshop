-- 0034: one label-purchase record per order — the idempotency boundary for a
-- purchase that MOVES MONEY on the merchant's Shippo account. Additive.
--
-- Why a table and not "just call Shippo": two clicks, concurrent submits, or a
-- timeout after Shippo accepted the charge could each buy another label, and
-- the label only existed in the redirect that followed. The order_id PRIMARY
-- KEY is the claim — there is exactly one purchase attempt per order, taken
-- with a conditional INSERT before any network call.
--
-- States:
--   quoted     — a Shippo shipment exists; rates shown, nothing charged.
--   purchasing — the buy was claimed; the POST to Shippo is (or was) in flight.
--   purchased  — charge confirmed; tracking + label recorded in the same batch
--                that fulfils the order.
--   failed     — Shippo definitively declined; safe to quote again.
--   uncertain  — the POST's outcome is unknown (network error, 5xx). NEVER
--                retried automatically: the merchant checks the Shippo
--                dashboard and explicitly discards the attempt.
--
-- The shipment id lives HERE, not in the URL: a query-string shipment could be
-- swapped for another order's, buying a label addressed to customer B while
-- recording its tracking against order A.
CREATE TABLE shipping_labels (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id),
  status TEXT NOT NULL,
  shipment_id TEXT NOT NULL,
  rate_id TEXT,
  transaction_id TEXT,
  provider TEXT,
  service TEXT,
  amount_cents INTEGER,
  tracking_number TEXT,
  label_url TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
