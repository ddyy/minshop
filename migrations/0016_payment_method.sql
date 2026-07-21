-- 0016: record which payment rail an order used, so refunds route to the right
-- provider (Stripe refunds via API; Lightning can't reverse) and the admin can
-- show it. Additive. NULL on legacy rows = treat as the store's default provider.

ALTER TABLE orders ADD COLUMN payment_method TEXT;
