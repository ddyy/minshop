-- 0029: pixel dimensions for media, so images can reserve their space.
--
-- Without these an <img> has no width/height and no aspect-ratio, so it occupies
-- only its alt-text line box until the bitmap arrives and then jumps to full
-- height — measured at 181px of layout shift on a 242x209 page image. The
-- renderer had nothing to emit because nothing recorded the size.
--
-- Nullable on purpose: rows created before this migration have unknown
-- dimensions, and a guessed default would be worse than none — the renderer
-- omits the attributes when either value is NULL, which is exactly the old
-- behaviour. scripts/backfill-media-dimensions.mjs fills them in.
ALTER TABLE media ADD COLUMN width INTEGER;
ALTER TABLE media ADD COLUMN height INTEGER;
