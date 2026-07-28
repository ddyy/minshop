-- Local dev seed data (not run by migrations). Re-runnable: each insert is a
-- no-op if a product with that name already exists.
--   wrangler d1 execute minshop-db --local --file=./seed.sql   (or: npm run db:seed)

INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Sample Tee', 'sample-tee', 'A comfy cotton t-shirt.', 2500, 100
WHERE NOT EXISTS (SELECT 1 FROM products WHERE name = 'Sample Tee');

INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Sample Mug', 'sample-mug', 'Holds hot and cold beverages.', 1200, 50
WHERE NOT EXISTS (SELECT 1 FROM products WHERE name = 'Sample Mug');

-- Fixture normalization: give every seeded row a valid public_id so the
-- public serializers (which refuse to emit rows without one) work out of the
-- box. Hex chars are a subset of the Crockford base32 alphabet, so
-- 10 hex chars is a valid token. Real production data is backfilled by
-- scripts/backfill-public-ids.mjs with the Web Crypto generator instead.
UPDATE products         SET public_id = 'prod_' || lower(substr(hex(randomblob(10)),1,10)) WHERE public_id IS NULL;
UPDATE product_variants SET public_id = 'var_'  || lower(substr(hex(randomblob(10)),1,10)) WHERE public_id IS NULL;
UPDATE product_extras   SET public_id = 'xtra_' || lower(substr(hex(randomblob(10)),1,10)) WHERE public_id IS NULL;
UPDATE categories       SET public_id = 'cat_'  || lower(substr(hex(randomblob(10)),1,10)) WHERE public_id IS NULL;
UPDATE pages            SET public_id = 'page_' || lower(substr(hex(randomblob(10)),1,10)) WHERE public_id IS NULL;
UPDATE media            SET public_id = 'med_'  || lower(substr(hex(randomblob(10)),1,10)) WHERE public_id IS NULL;
UPDATE product_images   SET public_id = 'pimg_' || lower(substr(hex(randomblob(10)),1,10)) WHERE public_id IS NULL;
UPDATE menu_items       SET public_id = 'nav_'  || lower(substr(hex(randomblob(10)),1,10)) WHERE public_id IS NULL;
