-- 0011: per-image alt text for accessibility + SEO. Additive.
ALTER TABLE product_images ADD COLUMN alt TEXT;
