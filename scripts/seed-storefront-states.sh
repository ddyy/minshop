#!/usr/bin/env bash
set -euo pipefail

# Seeds a BROWSABLE local instance with every storefront state.
#
# The equivalence gate already builds these shapes, but in a throwaway database
# nobody can open. Customizing a template you cannot see most of the branches of
# is the problem this solves: without it, a developer editing ProductDetail has
# no variants, no extras, no gallery, and no low-stock product to look at —
# which is exactly the situation on the live demo today.
#
# Usage:
#   bash scripts/seed-storefront-states.sh [scenario]
#
# Scenarios set store-wide state that cannot coexist in one render:
#   default        cart and buy-now on, demo rail available
#   cart-off       browse-only catalog
#   buy-now-off    cart only, no instant purchase
#   no-payment     no rail can take money, so buy-now disappears entirely
#
# Re-runnable. The SQL fixture guards its own inserts, and each scenario resets
# the settings it owns before applying its own.

scenario="${1:-default}"
d1() { npx wrangler d1 execute DB --local --command "$1" >/dev/null; }

case "$scenario" in
  default|cart-off|buy-now-off|no-payment) ;;
  *)
    echo "Unknown scenario: $scenario" >&2
    echo "Use one of: default, cart-off, buy-now-off, no-payment" >&2
    exit 1
    ;;
esac

echo "Applying migrations…"
npx wrangler d1 migrations apply DB --local >/dev/null

echo "Seeding base catalog…"
npx wrangler d1 execute DB --local --file ./seed.sql >/dev/null

echo "Seeding storefront states…"
npx wrangler d1 execute DB --local --file ./test/fixtures/storefront-states.sql >/dev/null

# Gallery rows point at object keys. Without matching objects the page renders
# with broken images, which makes the gallery unusable for exactly the visual
# review this seed exists to enable.
echo "Seeding gallery objects…"
bucket="$(node -e '
  const config = require("node:fs").readFileSync("wrangler.jsonc", "utf8");
  const match = config.match(/"binding"\s*:\s*"BUCKET"[\s\S]*?"bucket_name"\s*:\s*"([^"]+)"/);
  if (!match) throw new Error("BUCKET binding is missing a bucket_name");
  process.stdout.write(match[1]);
')"
for key in media/tee-front.jpg media/tee-back.jpg; do
  npx wrangler r2 object put "$bucket/$key" --local \
    --file public/placeholder.png --content-type image/png >/dev/null
done

echo "Applying scenario: $scenario"
# Clear whatever a previous run left, then set only this scenario's state.
d1 "DELETE FROM settings WHERE key IN ('cart_enabled','buy_now_enabled','payment_methods_disabled');"
case "$scenario" in
  cart-off)    d1 "INSERT INTO settings (key, value) VALUES ('cart_enabled', '0');" ;;
  buy-now-off) d1 "INSERT INTO settings (key, value) VALUES ('buy_now_enabled', '0');" ;;
  # Demo is always AVAILABLE but can be disabled; with no real rail configured
  # that empties the enabled list, which is what hides Buy now.
  no-payment)  d1 "INSERT INTO settings (key, value) VALUES ('payment_methods_disabled', 'demo');" ;;
esac

cat <<'ROUTES'

Seeded. Routes worth looking at (npm run dev):

  /                                catalog, first card is the LCP image
  /products?sort=price&dir=asc     sort links
  /products?page=2                 pagination
  /categories/apparel              category listing
  /search?q=sample                 search results
  /search?q=zzzznomatch            empty search
  /products/sample-tee             variants, extras, multi-image gallery
  /products/pagination-item-2      plain product, no options
  /products/pagination-item-1      sold out
  /products/pagination-item-5      low stock
  /products/pagination-item-3      row currency differs from the store's
  /pages/about                     content page
  /cart  /checkout  /account       shell on transactional and auth routes
  /no-such-page                    404

Re-run with a scenario to change store-wide state:
  bash scripts/seed-storefront-states.sh cart-off
  bash scripts/seed-storefront-states.sh buy-now-off
  bash scripts/seed-storefront-states.sh no-payment
ROUTES
