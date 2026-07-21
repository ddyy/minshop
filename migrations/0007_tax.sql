-- 0007: capture sales tax / VAT on orders. Additive.
-- tax_cents = tax computed by Stripe Tax (part of: items + shipping - discount + tax = total).

ALTER TABLE orders ADD COLUMN tax_cents INTEGER NOT NULL DEFAULT 0;
