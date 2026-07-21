-- 0005: capture shipping on orders. Additive.
-- shipping_cents = amount charged for shipping (part of amount_total_cents).
-- ship_address  = JSON snapshot of the shipping address collected at checkout.

ALTER TABLE orders ADD COLUMN shipping_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN ship_address TEXT;
