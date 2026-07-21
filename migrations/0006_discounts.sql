-- 0006: capture promo-code discount on orders. Additive.
-- discount_cents = amount taken off by a promotion code (part of the total math:
-- items + shipping - discount = amount_total).

ALTER TABLE orders ADD COLUMN discount_cents INTEGER NOT NULL DEFAULT 0;
