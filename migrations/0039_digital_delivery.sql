-- 0039: machine-readable order status + private digital-file entitlements.
-- Additive only. Public IDs are populated by scripts/backfill-public-ids.mjs
-- because SQL migrations cannot call the Web Crypto generator.

ALTER TABLE products ADD COLUMN file_key TEXT;
ALTER TABLE products ADD COLUMN file_name TEXT;
ALTER TABLE products ADD COLUMN file_mime TEXT;
ALTER TABLE products ADD COLUMN file_size_bytes INTEGER;

ALTER TABLE order_items ADD COLUMN public_id TEXT;
ALTER TABLE order_items ADD COLUMN file_key TEXT;
ALTER TABLE order_items ADD COLUMN file_name TEXT;
ALTER TABLE order_items ADD COLUMN file_mime TEXT;
ALTER TABLE order_items ADD COLUMN file_size_bytes INTEGER;
ALTER TABLE order_items ADD COLUMN downloads INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_order_items_public_id
  ON order_items(public_id) WHERE public_id IS NOT NULL;

ALTER TABLE checkout_reservations ADD COLUMN terminal_at TEXT;
ALTER TABLE order_guest_access ADD COLUMN hidden_at TEXT;

-- Permanent collision authority for item IDs. order_public_id is the canonical
-- orders.public_id and therefore also accepts preserved legacy UUID/hex IDs.
CREATE TABLE IF NOT EXISTS order_item_ids (
  public_id TEXT NOT NULL PRIMARY KEY,
  order_public_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_order_item_ids_order
  ON order_item_ids(order_public_id);

-- Keep the durable registry and row assignment in the same SQLite statement.
-- Runtime reservation code may claim first; INSERT OR IGNORE makes that path
-- idempotent while the owner check rejects a cross-order collision.
--
-- The guard uses `SELECT RAISE(ABORT, …) WHERE EXISTS (…)` rather than a
-- CASE expression, and no comment appears between BEGIN and the body's close:
-- `wrangler d1 migrations apply --remote` splits the file itself and locates a
-- trigger's close by scanning for that keyword followed by a semicolon. Any
-- earlier occurrence inside the body — a CASE's own close, or even a comment
-- that mentions one — truncates the trigger, and D1 rejects the remainder with
-- "incomplete input: SQLITE_ERROR". Local apply and `d1 execute --remote
-- --file` both parse it correctly, so this only ever fails against a real
-- remote database. Reproduced on wrangler 4.115.0 and 4.118.0; pinned by
-- test/scripts/migrations-remote-safe.test.mjs.
CREATE TRIGGER IF NOT EXISTS trg_order_item_public_id_insert
BEFORE INSERT ON order_items
WHEN NEW.public_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'order item public ID belongs to another order')
   WHERE EXISTS (
     SELECT 1 FROM order_item_ids i
     JOIN orders o ON o.id = NEW.order_id
     WHERE i.public_id = NEW.public_id AND i.order_public_id <> o.public_id
   );
  INSERT OR IGNORE INTO order_item_ids (public_id, order_public_id)
    SELECT NEW.public_id, public_id FROM orders WHERE id = NEW.order_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_order_item_public_id_update
BEFORE UPDATE OF public_id ON order_items
WHEN NEW.public_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'order item public ID belongs to another order')
   WHERE EXISTS (
     SELECT 1 FROM order_item_ids i
     JOIN orders o ON o.id = NEW.order_id
     WHERE i.public_id = NEW.public_id AND i.order_public_id <> o.public_id
   );
  INSERT OR IGNORE INTO order_item_ids (public_id, order_public_id)
    SELECT NEW.public_id, public_id FROM orders WHERE id = NEW.order_id;
END;

CREATE TABLE IF NOT EXISTS order_inventory_exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL,
  variant_id INTEGER,
  requested_qty INTEGER NOT NULL,
  consumed_qty INTEGER NOT NULL,
  shortfall_qty INTEGER NOT NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_inventory_exceptions_unresolved
  ON order_inventory_exceptions(resolved_at, created_at);
