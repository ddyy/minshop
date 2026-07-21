-- 0003: FTS5 full-text search over products (name + description).
-- External-content table: products_fts mirrors `products` (content_rowid = id),
-- kept in sync by triggers. No duplicated content beyond the index.
--
-- Gotcha: `wrangler d1 export` does NOT work on a DB that has virtual tables —
-- drop products_fts, export, then recreate. See README → Gotchas.

CREATE VIRTUAL TABLE products_fts USING fts5(
  name,
  description,
  content='products',
  content_rowid='id'
);

-- Backfill the index from existing rows.
INSERT INTO products_fts(rowid, name, description)
  SELECT id, name, description FROM products;

-- Keep the index in sync with products. External-content tables require the
-- special 'delete' command to remove a row from the index.
CREATE TRIGGER products_fts_ai AFTER INSERT ON products BEGIN
  INSERT INTO products_fts(rowid, name, description)
    VALUES (new.id, new.name, new.description);
END;

CREATE TRIGGER products_fts_ad AFTER DELETE ON products BEGIN
  INSERT INTO products_fts(products_fts, rowid, name, description)
    VALUES ('delete', old.id, old.name, old.description);
END;

CREATE TRIGGER products_fts_au AFTER UPDATE ON products BEGIN
  INSERT INTO products_fts(products_fts, rowid, name, description)
    VALUES ('delete', old.id, old.name, old.description);
  INSERT INTO products_fts(rowid, name, description)
    VALUES (new.id, new.name, new.description);
END;
