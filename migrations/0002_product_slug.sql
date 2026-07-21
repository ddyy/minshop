-- 0002: product slugs for public URLs. `id` stays the internal key (cart,
-- order_items, admin, checkout); `slug` is only the storefront URL. Additive.

ALTER TABLE products ADD COLUMN slug TEXT;

-- Backfill existing rows with a basic slug from the name (lowercase, spaces →
-- dashes, drop a few punctuation marks). Good enough for seeded/simple names;
-- the app generates clean unique slugs going forward.
UPDATE products
SET slug = lower(replace(replace(replace(replace(name, ' ', '-'), '''', ''), '.', ''), ',', ''))
WHERE slug IS NULL OR slug = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_slug ON products(slug);
