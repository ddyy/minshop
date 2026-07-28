-- 0033: prefixed public IDs (additive). Row IDs stay the primary keys and
-- foreign keys; `public_id` is the immutable external identity for every
-- record referenced outside server internals. Columns are nullable because
-- migrations are SQL-only and the values come from the Web Crypto generator:
-- creation code populates new rows, scripts/backfill-public-ids.mjs fills
-- existing ones, and creation-code + verification enforce the non-null
-- invariant instead of rebuilding tables for a NOT NULL constraint.
-- Orders (0005) and refunds (0025) already have public_id; their existing
-- values are preserved forever.

ALTER TABLE products         ADD COLUMN public_id TEXT;  -- prod_
ALTER TABLE product_variants ADD COLUMN public_id TEXT;  -- var_
ALTER TABLE product_extras   ADD COLUMN public_id TEXT;  -- xtra_
ALTER TABLE categories       ADD COLUMN public_id TEXT;  -- cat_
ALTER TABLE pages            ADD COLUMN public_id TEXT;  -- page_
ALTER TABLE media            ADD COLUMN public_id TEXT;  -- med_
ALTER TABLE product_images   ADD COLUMN public_id TEXT;  -- pimg_
ALTER TABLE menu_items       ADD COLUMN public_id TEXT;  -- nav_

-- Unique partial indexes: the collision authority. Generation retries on
-- conflict; NULLs (pre-backfill rows) stay out of the index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_public_id         ON products(public_id)         WHERE public_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_variants_public_id ON product_variants(public_id) WHERE public_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_extras_public_id   ON product_extras(public_id)   WHERE public_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_public_id       ON categories(public_id)       WHERE public_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pages_public_id            ON pages(public_id)            WHERE public_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_public_id            ON media(public_id)            WHERE public_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_images_public_id   ON product_images(public_id)   WHERE public_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_menu_items_public_id       ON menu_items(public_id)       WHERE public_id IS NOT NULL;

-- Guest access registry: the ONE authoritative token->order mapping, created
-- at checkout before provider handoff. The raw token is stored by design (a
-- hash cannot regenerate guest URLs for later settlement/shipping/refund
-- emails); reissue atomically rotates it and bumps `generation`, which also
-- versions the reissue notification kind (guest-link-reissue:<generation>).
-- Rows for checkouts that fail or expire without settling are garbage-collected
-- only after provider-confirmed terminal state; settled orders keep theirs
-- forever. NOT NULL on the PK because SQLite permits NULL in non-integer
-- primary keys without it.
CREATE TABLE order_guest_access (
  order_public_id TEXT NOT NULL PRIMARY KEY,
  access_token    TEXT NOT NULL UNIQUE,
  generation      INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  rotated_at      TEXT
);

-- Legacy customer references: the calculated display numbers already
-- communicated for pre-cutover orders, snapshotted by the backfill so later
-- order-number config changes cannot orphan an emailed reference. New ord_
-- orders never get rows here — their reference is the public-ID token.
CREATE TABLE order_reference_aliases (
  reference       TEXT NOT NULL PRIMARY KEY,
  order_public_id TEXT NOT NULL UNIQUE
);
