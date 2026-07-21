-- Local dev seed data (not run by migrations). Re-runnable: each insert is a
-- no-op if a product with that name already exists.
--   wrangler d1 execute minshop-db --local --file=./seed.sql   (or: npm run db:seed)

INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Sample Tee', 'sample-tee', 'A comfy cotton t-shirt.', 2500, 100
WHERE NOT EXISTS (SELECT 1 FROM products WHERE name = 'Sample Tee');

INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Sample Mug', 'sample-mug', 'Holds hot and cold beverages.', 1200, 50
WHERE NOT EXISTS (SELECT 1 FROM products WHERE name = 'Sample Mug');
