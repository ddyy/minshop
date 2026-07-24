-- Keep the common paginated storefront/admin reads on indexes as catalogs and
-- order histories grow. Alternate admin sort columns remain intentionally
-- unindexed; adding every possible sort would slow writes for little benefit.
CREATE INDEX IF NOT EXISTS idx_orders_created
ON orders(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_orders_email_created
ON orders(email, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_products_active_created
ON products(active, created_at DESC);
