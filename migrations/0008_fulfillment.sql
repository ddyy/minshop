-- 0008: order fulfillment (mark shipped + tracking). Additive.
-- fulfillment_status: 'unfulfilled' | 'fulfilled'. Separate from payment `status`.

ALTER TABLE orders ADD COLUMN fulfillment_status TEXT NOT NULL DEFAULT 'unfulfilled';
ALTER TABLE orders ADD COLUMN tracking_carrier TEXT;
ALTER TABLE orders ADD COLUMN tracking_number TEXT;
ALTER TABLE orders ADD COLUMN fulfilled_at TEXT;
