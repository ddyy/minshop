-- 0010: the primary image is now the FIRST gallery image (lowest position).
-- Sync products.image_key to match, so existing data is consistent. Idempotent.

UPDATE products
SET image_key = (
  SELECT image_key FROM product_images
  WHERE product_id = products.id
  ORDER BY position, id
  LIMIT 1
)
WHERE id IN (SELECT DISTINCT product_id FROM product_images);
