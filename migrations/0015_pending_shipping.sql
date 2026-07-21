-- 0015: carry shipping on pending Lightning payments. Additive.
--
-- The own-checkout (Lightning) flow collects the address + a shipping option
-- before invoicing, so the pending row must hold the shipping amount and address
-- to copy onto the order at settlement (parity with how Stripe orders record them).

ALTER TABLE pending_payments ADD COLUMN shipping_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pending_payments ADD COLUMN ship_address TEXT; -- JSON snapshot (ShippingAddress) or null
