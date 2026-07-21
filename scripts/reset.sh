#!/usr/bin/env bash
#
# Reset a store's DATA back to a fresh install — WITHOUT destroying or reprovisioning
# the instance. Empties every app table (products, orders, customers, categories,
# images metadata) AND the settings table — which clears all dashboard config, the
# encrypted provider keys, and the admin password — so the setup wizard reappears.
# The D1 database, R2 bucket, Worker, and current deploy all stay; the schema and
# migration history are untouched (no re-migrate needed). Re-seed demo data with
# --seed.
#
#   Usage:  scripts/reset.sh [--remote] [--seed] [--yes]
#   --remote: target the DEPLOYED D1 (default: the local .wrangler/state store).
#   --seed:   load ./seed.sql after clearing.
#   --yes:    skip the confirmation prompt.
#
# ⚠  IRREVERSIBLE — deletes ALL products, orders, and settings in the target store.
#    Note: R2 image blobs are left (orphaned, harmless — overwritten on re-upload).
set -euo pipefail

REMOTE=0
SEED=0
YES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote) REMOTE=1; shift ;;
    --seed) SEED=1; shift ;;
    --yes|-y) YES=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
W="npx --yes wrangler"
if [[ "$REMOTE" == "1" ]]; then TARGET="--remote"; WHERE="DEPLOYED"; else TARGET="--local"; WHERE="local"; fi

if [[ "$YES" != "1" ]]; then
  echo "This empties ALL products, orders, and settings (config, keys, admin password)"
  echo "in the $WHERE store. The instance (D1/R2/Worker/deploy) stays."
  read -rp "Reset the $WHERE store to a fresh install? [y/N] " ans
  [[ "$ans" == "y" || "$ans" == "Y" ]] || { echo "aborted."; exit 0; }
fi

# Delete child rows before parents (safe whether or not FK checks are on). The FTS
# index (products_fts) is external-content + trigger-maintained, so clearing
# `products` clears it too — don't touch it directly. Update this list if you add
# a table.
RESET_SQL="
DELETE FROM order_items;
DELETE FROM product_categories;
DELETE FROM product_extras;
DELETE FROM product_images;
DELETE FROM product_variants;
DELETE FROM pending_payments;
DELETE FROM orders;
DELETE FROM products;
DELETE FROM categories;
DELETE FROM settings;
"

echo "▸ Clearing the $WHERE store…"
# CI=1 → skip wrangler's own confirmation on a --remote write (we already confirmed).
CI=1 $W d1 execute DB $TARGET --command "$RESET_SQL"
# Belt-and-suspenders: rebuild the (now empty) FTS index so it's definitely clean.
CI=1 $W d1 execute DB $TARGET --command "INSERT INTO products_fts(products_fts) VALUES('rebuild');" >/dev/null 2>&1 || true

if [[ "$SEED" == "1" ]]; then
  [[ -f seed.sql ]] && CI=1 $W d1 execute DB $TARGET --file=./seed.sql \
    || echo "  (--seed given but ./seed.sql not found — skipped)"
fi

echo "✓ $WHERE store reset to a fresh install. Open /admin/setup to configure it again."
