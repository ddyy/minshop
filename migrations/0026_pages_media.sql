-- 0026: shared media library + Markdown pages. Additive.
--
-- `media` is the catalogue of stored files and the ONLY place a file may be
-- deleted from. Products, pages, and branding record how a file is USED; they
-- never own it. Removing an image from a product or page therefore drops the
-- association only — the object stays until it is explicitly deleted from the
-- media library, which refuses while anything still references it.
--
-- Products keep referencing files by their immutable `image_key` rather than a
-- new `media_id`: the key is already stable and already stored, so adding a
-- second reference would just be duplicated relationship state that can drift.

CREATE TABLE IF NOT EXISTS media (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  image_key     TEXT    NOT NULL UNIQUE,
  original_name TEXT    NOT NULL,
  -- Nullable: rows backfilled below come from R2 objects that cannot be
  -- inspected from D1, so legacy entries carry no type/size. The admin grid
  -- renders those without the metadata rather than showing zeros.
  mime_type     TEXT,
  size_bytes    INTEGER,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS media_created
  ON media (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS pages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT    NOT NULL,
  slug          TEXT    NOT NULL UNIQUE,
  body_markdown TEXT    NOT NULL DEFAULT '',
  published     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  -- Application-maintained: every update sets datetime('now') explicitly.
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- NOCASE so it can actually serve the footer's `ORDER BY title COLLATE NOCASE`.
-- A BINARY index cannot satisfy a NOCASE sort and SQLite would sort every
-- published row instead.
CREATE INDEX IF NOT EXISTS pages_published_title
  ON pages (published, title COLLATE NOCASE);

-- Which media a page's Markdown references. Rebuilt from the parsed body on
-- every save, so it always reflects the current text.
CREATE TABLE IF NOT EXISTS page_media (
  page_id  INTEGER NOT NULL REFERENCES pages(id),
  media_id INTEGER NOT NULL REFERENCES media(id),
  PRIMARY KEY (page_id, media_id)
);

-- Reverse lookup: "is this media used by any page?" during deletion checks.
CREATE INDEX IF NOT EXISTS page_media_media
  ON page_media (media_id, page_id);

-- Backfill every distinct product image key so existing uploads appear in the
-- library without moving or renaming a single R2 object. Both sources matter:
-- the gallery and the denormalized primary can each hold a key the other lacks.
-- original_name falls back to the key itself — the real filename was never
-- stored.
INSERT OR IGNORE INTO media (image_key, original_name)
SELECT DISTINCT image_key, image_key
FROM product_images
WHERE image_key IS NOT NULL AND image_key != '';

INSERT OR IGNORE INTO media (image_key, original_name)
SELECT DISTINCT image_key, image_key
FROM products
WHERE image_key IS NOT NULL AND image_key != '';
