-- 0017: product variants + extras (additive; products with neither behave as before).
--
-- variants  — mutually-exclusive, each its OWN price + stock + SKU (the inventory
--             unit). A product with variants sells one variant per line.
-- extras    — checkbox add-ons: a price delta layered on top, NO stock of their own.
-- products.variant_label — the variant group's display name (e.g. "Size").
-- order_items.variant_id — which variant a line sold (for stock + the record;
--             selected extras are captured in the line name/price).

CREATE TABLE IF NOT EXISTS product_variants (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  label       TEXT    NOT NULL,            -- "Small", "Red"
  price_cents INTEGER NOT NULL,            -- the variant's full price (minor units)
  stock       INTEGER NOT NULL DEFAULT 0,
  sku         TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id, position);

CREATE TABLE IF NOT EXISTS product_extras (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id        INTEGER NOT NULL REFERENCES products(id),
  label             TEXT    NOT NULL,      -- "Gift wrap"
  price_delta_cents INTEGER NOT NULL DEFAULT 0, -- +500 (can be 0)
  position          INTEGER NOT NULL DEFAULT 0,
  active            INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_extras_product ON product_extras(product_id, position);

ALTER TABLE products ADD COLUMN variant_label TEXT;     -- NULL = no variant group
ALTER TABLE order_items ADD COLUMN variant_id INTEGER;  -- NULL = no variant on the line
