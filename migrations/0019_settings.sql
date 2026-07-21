-- 0019: runtime settings store (key/value).
--
-- minshop's config is otherwise build-time (env + src/config.ts). This table holds
-- the few values the setup wizard lets an owner set at runtime without a redeploy
-- — e.g. the store name, the setup-complete flag, and the Stripe webhook signing
-- secret captured by webhook auto-registration. Reads overlay the build-time
-- config; anything not present here falls back to env/config defaults.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
