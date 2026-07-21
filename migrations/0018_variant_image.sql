-- 0018: optional per-variant photo (additive).
--
-- A variant can point at one of its product's existing gallery images. Selecting
-- the variant on the storefront swaps the hero to that image. NULL = no specific
-- image (falls back to the gallery's primary). Reuses product_images, so there's
-- no separate upload or orphan cleanup — deleting a gallery image nulls any
-- variant that referenced it (handled in app code, since D1 doesn't enforce FKs).
ALTER TABLE product_variants ADD COLUMN image_id INTEGER;  -- → product_images.id, or NULL
