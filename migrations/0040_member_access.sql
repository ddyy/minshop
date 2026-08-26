-- Optional members’ access codes (Admin → Member access).
-- Mode lives in settings (`member_access_mode`); codes are stored in plaintext
-- for admin reference (migration 0041). products.members_only / categories.members_only
-- apply in selective mode.

CREATE TABLE IF NOT EXISTS member_access_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_member_access_codes_enabled
  ON member_access_codes(enabled, expires_at);

ALTER TABLE products ADD COLUMN members_only INTEGER NOT NULL DEFAULT 0
  CHECK (members_only IN (0, 1));

ALTER TABLE categories ADD COLUMN members_only INTEGER NOT NULL DEFAULT 0
  CHECK (members_only IN (0, 1));
