-- 0028: merchant-managed header and footer navigation.
--
-- Replaces two implicit mechanisms: the footer auto-listing every published page,
-- and the header's conditional "Shop" link. Both were invisible to the merchant
-- and neither was orderable.
--
-- Targets are first-class objects (page/product/category) referenced BY ID, not
-- by slug, so renaming a page never breaks a link. 'home' and 'catalog' are
-- singletons resolved from store settings rather than from a row.
--
-- No custom URLs: those need URL validation, external-link rel/target handling,
-- and broken-link management. They can be added later as a sixth target_type
-- without changing this model.

CREATE TABLE IF NOT EXISTS menu_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  location    TEXT    NOT NULL CHECK (location IN ('header', 'footer')),
  target_type TEXT    NOT NULL CHECK (
                target_type IN ('home', 'catalog', 'page', 'product', 'category')
              ),
  target_id   INTEGER,
  label       TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),

  -- 'home' and 'catalog' have no row to point at; the other three are
  -- meaningless without one. Without this a 'product' item with a NULL target_id
  -- is representable and silently resolves to nothing.
  CHECK (
    (target_type IN ('home', 'catalog') AND target_id IS NULL) OR
    (target_type IN ('page', 'product', 'category') AND target_id IS NOT NULL)
  )
);

-- Every storefront request reads by location in position order.
CREATE INDEX IF NOT EXISTS idx_menu_items_location ON menu_items(location, position, id);

-- Home and Catalog are singletons per menu: one '/' link is navigation, two is a
-- bug. Partial, so page/product/category items stay unconstrained — the same
-- product may legitimately appear in both menus.
CREATE UNIQUE INDEX IF NOT EXISTS idx_menu_items_singleton
  ON menu_items(location, target_type)
  WHERE target_type IN ('home', 'catalog');

-- ── Seed ────────────────────────────────────────────────────────────────────
-- Reproduces what each store renders TODAY. Without this the migration would
-- blank the footer of every existing store the moment it lands, which would make
-- an additive feature a breaking change.

-- Header: the conditional "Shop" link, seeded only for stores that actually show
-- it today (those whose home page has been pointed away from the catalog).
-- The label is pinned rather than left to the resolver's default so a later
-- change to that default cannot silently rename a link on a live store.
INSERT INTO menu_items (location, target_type, target_id, label, position)
SELECT 'header', 'catalog', NULL, 'Shop', 0
WHERE EXISTS (SELECT 1 FROM settings WHERE key = 'home_page' AND value != '');

-- Footer: one item per published page, in the order the footer already uses
-- (PUBLISHED_PAGE_LINKS_SQL — title COLLATE NOCASE, then id), up to the same
-- limit that query already enforces, so nothing currently rendered is lost.
--
-- The outer ORDER BY is NOT redundant with the one inside ROW_NUMBER(). The
-- window's ordering decides which numbers are assigned; it does not decide which
-- rows an unordered LIMIT keeps. Without it a store over the limit would get
-- correctly-numbered positions on an arbitrary subset of its pages.
INSERT INTO menu_items (location, target_type, target_id, label, position)
SELECT 'footer', 'page', id, NULL,
       ROW_NUMBER() OVER (ORDER BY title COLLATE NOCASE, id) - 1
FROM pages
WHERE published = 1
ORDER BY title COLLATE NOCASE, id
LIMIT 50;

-- Deliberately no 'home' item: the store name / logo in the header already links
-- to '/', so seeding one would render a duplicate link on every existing store.
