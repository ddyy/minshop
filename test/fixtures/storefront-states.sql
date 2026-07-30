-- Storefront state fixtures.
--
-- One source for every product and page shape the storefront renders
-- differently. Both consumers apply this file after ./seed.sql:
--
--   test/integration/storefront-baselines.sh   the equivalence gate
--   npm run db:seed:storefront-states          a browsable local instance
--
-- Keeping them on one fixture is the point. A shape that exists only in the
-- gate cannot be looked at, and a shape that exists only locally is not
-- protected by anything.
--
-- Re-runnable: every insert guards against duplicating itself, so seeding twice
-- does not create two galleries or four variants.

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('setup_complete', '1'),
  ('accounts_enabled', '1');

-- Enough products for a second catalog page, so pagination and sort links are
-- exercised rather than merely present.
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 30)
INSERT INTO products (name, slug, description, price_cents, stock)
SELECT 'Pagination Item ' || n, 'pagination-item-' || n, 'pagination fixture', 1000 + n, 10
FROM seq
WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug = 'pagination-item-1');

-- The per-product shapes the detail route branches on.
UPDATE products SET stock = 0 WHERE slug = 'pagination-item-1';   -- sold out
UPDATE products SET stock = 3 WHERE slug = 'pagination-item-5';   -- low stock (LOW_STOCK is 5)
UPDATE products SET currency = 'eur' WHERE slug = 'pagination-item-3'; -- legacy row currency

INSERT INTO categories (name, slug)
SELECT 'Apparel', 'apparel'
WHERE NOT EXISTS (SELECT 1 FROM categories WHERE slug = 'apparel');

-- sample-tee plus siblings, so the product page renders a populated
-- "You may also like" row instead of omitting the section.
INSERT INTO product_categories (product_id, category_id)
SELECT p.id, c.id FROM products p, categories c
WHERE p.slug IN ('sample-tee', 'pagination-item-1', 'pagination-item-2',
                 'pagination-item-3', 'pagination-item-4')
  AND c.slug = 'apparel'
  AND NOT EXISTS (
    SELECT 1 FROM product_categories pc WHERE pc.product_id = p.id AND pc.category_id = c.id
  );

-- sample-tee carries all three option shapes: variants (one sold out), extras
-- (one free), and a multi-image gallery.
UPDATE products SET variant_label = 'Size' WHERE slug = 'sample-tee';

INSERT INTO product_variants (product_id, label, price_cents, stock, sku, position)
SELECT p.id, v.label, v.price_cents, v.stock, v.sku, v.position
FROM products p
JOIN (SELECT 'Small' AS label, 2400 AS price_cents, 5 AS stock, 'TEE-S' AS sku, 0 AS position
      UNION ALL SELECT 'Large', 2900, 0, 'TEE-L', 1) v
WHERE p.slug = 'sample-tee'
  AND NOT EXISTS (
    SELECT 1 FROM product_variants x WHERE x.product_id = p.id AND x.label = v.label
  );

INSERT INTO product_extras (product_id, label, price_delta_cents, position)
SELECT p.id, e.label, e.price_delta_cents, e.position
FROM products p
JOIN (SELECT 'Gift wrap' AS label, 500 AS price_delta_cents, 0 AS position
      UNION ALL SELECT 'Rush delivery', 0, 1) e
WHERE p.slug = 'sample-tee'
  AND NOT EXISTS (
    SELECT 1 FROM product_extras x WHERE x.product_id = p.id AND x.label = e.label
  );

INSERT INTO product_images (product_id, image_key, position)
SELECT p.id, i.image_key, i.position
FROM products p
JOIN (SELECT 'media/tee-front.jpg' AS image_key, 0 AS position
      UNION ALL SELECT 'media/tee-back.jpg', 1) i
WHERE p.slug = 'sample-tee'
  AND NOT EXISTS (
    SELECT 1 FROM product_images x WHERE x.product_id = p.id AND x.image_key = i.image_key
  );

-- A published content page, so the Markdown wrapper and the footer's page links
-- both render.
INSERT INTO pages (title, slug, body_markdown, published)
SELECT 'About', 'about',
  '# About us' || char(10) || char(10) ||
  'A fixture page with a [link](/products) and a list:' || char(10) || char(10) ||
  '- one' || char(10) || '- two',
  1
WHERE NOT EXISTS (SELECT 1 FROM pages WHERE slug = 'about');

-- Header navigation. Without this the header renders with no merchant links,
-- so neither the inline row nor the mobile disclosure is ever exercised — and
-- "no links" would be the only header state any gate or local instance sees.
-- Four items is enough to show truncation pressure beside search and the cart.
INSERT INTO menu_items (location, target_type, target_id, label, position)
SELECT 'header', 'catalog', NULL, 'Shop', 0
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE location = 'header');

INSERT INTO menu_items (location, target_type, target_id, label, position)
SELECT 'header', 'category', c.id, 'Apparel', 1 FROM categories c
WHERE c.slug = 'apparel'
  AND NOT EXISTS (SELECT 1 FROM menu_items WHERE location = 'header' AND position = 1);

INSERT INTO menu_items (location, target_type, target_id, label, position)
SELECT 'header', 'page', p.id, 'About', 2 FROM pages p
WHERE p.slug = 'about'
  AND NOT EXISTS (SELECT 1 FROM menu_items WHERE location = 'header' AND position = 2);

INSERT INTO menu_items (location, target_type, target_id, label, position)
SELECT 'header', 'product', p.id, 'Featured: Sample Tee', 3 FROM products p
WHERE p.slug = 'sample-tee'
  AND NOT EXISTS (SELECT 1 FROM menu_items WHERE location = 'header' AND position = 3);

-- Public serializers refuse rows without a public ID, and the storefront now
-- fails loudly rather than leaking a storage key, so every fixture row needs
-- one. Values are random per run and normalized out of the baselines.
UPDATE products         SET public_id = 'prod_' || lower(substr(hex(randomblob(10)),1,10)) WHERE public_id IS NULL;
UPDATE categories       SET public_id = 'cat_'  || lower(substr(hex(randomblob(10)),1,10)) WHERE public_id IS NULL;
UPDATE pages            SET public_id = 'page_' || lower(substr(hex(randomblob(10)),1,10)) WHERE public_id IS NULL;
UPDATE product_variants SET public_id = 'var_'  || lower(substr(hex(randomblob(10)),1,10)) WHERE public_id IS NULL;
UPDATE product_extras   SET public_id = 'xtra_' || lower(substr(hex(randomblob(10)),1,10)) WHERE public_id IS NULL;
UPDATE menu_items       SET public_id = 'nav_'  || lower(substr(hex(randomblob(10)),1,10)) WHERE public_id IS NULL;
UPDATE product_images   SET public_id = 'pimg_' || lower(substr(hex(randomblob(10)),1,10)) WHERE public_id IS NULL;
