-- 0001_init — initial schema (products, orders, order_items).
-- Migrations are additive and non-destructive: no DROP, IF NOT EXISTS so a
-- re-run on an existing DB is a safe no-op. Apply with:
--   wrangler d1 migrations apply minshop-db --local   (or --remote)

CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  description   TEXT,
  price_cents   INTEGER NOT NULL,
  currency      TEXT    NOT NULL DEFAULT 'usd',
  image_key     TEXT,                         -- R2 object key for product image
  stock         INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_session_id   TEXT    UNIQUE,
  email               TEXT,
  amount_total_cents  INTEGER NOT NULL,
  currency            TEXT    NOT NULL DEFAULT 'usd',
  status              TEXT    NOT NULL DEFAULT 'pending',
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES orders(id),
  product_id  INTEGER REFERENCES products(id),
  name        TEXT    NOT NULL,
  price_cents INTEGER NOT NULL,
  quantity    INTEGER NOT NULL DEFAULT 1
);
