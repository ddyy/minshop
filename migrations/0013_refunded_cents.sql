-- 0013: track refunded amount per order so analytics can report NET revenue.
-- Additive. `refunded_cents` is the total refunded on an order (0 = none). A full
-- refund sets it to amount_total_cents; partial refunds (future) set a portion.
-- Net revenue everywhere = SUM(amount_total_cents - refunded_cents).

ALTER TABLE orders ADD COLUMN refunded_cents INTEGER NOT NULL DEFAULT 0;

-- Backfill existing full refunds (recorded only as status='refunded' until now).
UPDATE orders SET refunded_cents = amount_total_cents WHERE status = 'refunded';
