-- 0027: per-page layout preset (additive).
--
-- Presets are a closed, named set defined in features/pages/layouts.ts, not
-- free-form width/alignment columns. Storing the KEY rather than the resolved
-- measure/alignment means changing what "wide" means is a code change, not a
-- data migration across every page that used it.
--
-- Unknown values normalize back to 'standard' at render time, so a page saved
-- under a preset a developer later removes still renders instead of breaking.
ALTER TABLE pages ADD COLUMN layout TEXT NOT NULL DEFAULT 'standard';
