-- 0005: random public_id for orders so customer-facing order URLs aren't
-- guessable sequential ids. `id` stays the internal/admin key. Additive.

ALTER TABLE orders ADD COLUMN public_id TEXT;

-- Backfill existing rows with a random token (32 hex chars).
UPDATE orders SET public_id = lower(hex(randomblob(16))) WHERE public_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_public_id ON orders(public_id);
