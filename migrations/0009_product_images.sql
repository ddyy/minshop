-- 0009: product image gallery. Images are PRODUCT-scoped (a future variant can
-- reference an image row, but images don't hang off variants). `products.image_key`
-- stays the denormalized PRIMARY (used for thumbnails everywhere); this table is
-- the full gallery shown on the product page. Additive.

CREATE TABLE IF NOT EXISTS product_images (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  image_key  TEXT    NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images(product_id, position);

-- Backfill: each product's existing image becomes its first gallery image.
INSERT INTO product_images (product_id, image_key, position)
  SELECT id, image_key, 0 FROM products WHERE image_key IS NOT NULL AND image_key != '';
