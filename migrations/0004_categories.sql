-- 0004: nested categories + many-to-many product links. Additive.
-- categories.parent_id is a self-reference (NULL = top level) → arbitrary-depth tree.
-- product_categories is the M:N join (a product can sit in several categories).

CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  parent_id  INTEGER REFERENCES categories(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);

CREATE TABLE IF NOT EXISTS product_categories (
  product_id  INTEGER NOT NULL REFERENCES products(id),
  category_id INTEGER NOT NULL REFERENCES categories(id),
  PRIMARY KEY (product_id, category_id)
);
CREATE INDEX IF NOT EXISTS idx_pc_category ON product_categories(category_id);
