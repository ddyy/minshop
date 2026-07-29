#!/usr/bin/env bash
set -euo pipefail

# Storefront extraction-equivalence gate. Boots the BUILT Worker against an
# isolated, deterministically seeded D1 so rendered HTML can be compared before
# and after a component extraction.
#
# This is not part of `npm run verify`: a store that has customized its
# templates is SUPPOSED to differ from the default baselines. Run it while
# extracting a default component, or when deliberately updating the default
# design. The checks that must pass for every design live in
# `npm run test:storefront-contract`.
#
# Pass --update to re-capture. Review that diff like source.

state_dir="$(mktemp -d "${TMPDIR:-/tmp}/minshop-storefront-baselines.XXXXXX")"
worker_log="$state_dir/worker.log"
worker_pid=""
test_port="${STOREFRONT_TEST_PORT:-8792}"

cleanup() {
  if [[ -n "$worker_pid" ]] && kill -0 "$worker_pid" 2>/dev/null; then
    kill "$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
  fi
  rm -rf "$state_dir"
}
trap cleanup EXIT INT TERM

if [[ ! -f dist/server/wrangler.json ]]; then
  echo "storefront baselines: run 'npm run build' first" >&2
  exit 1
fi

npx wrangler d1 migrations apply DB --local --persist-to "$state_dir" >/dev/null
npx wrangler d1 execute DB --local --persist-to "$state_dir" --file ./seed.sql >/dev/null
npx wrangler d1 execute DB --local --persist-to "$state_dir" \
  --command "INSERT INTO settings (key, value) VALUES ('setup_complete', '1'), ('accounts_enabled', '1');" >/dev/null
# A second page of catalog results, so pagination and sort links are exercised.
npx wrangler d1 execute DB --local --persist-to "$state_dir" \
  --command "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 30) INSERT INTO products (name, slug, description, price_cents, stock) SELECT 'Pagination Item ' || n, 'pagination-item-' || n, 'pagination fixture', 1000 + n, 10 FROM seq;" >/dev/null
# One sold-out product: the card's out-of-stock branch is part of the contract.
npx wrangler d1 execute DB --local --persist-to "$state_dir" \
  --command "UPDATE products SET stock = 0 WHERE slug = 'pagination-item-1';" >/dev/null
npx wrangler d1 execute DB --local --persist-to "$state_dir" \
  --command "INSERT INTO categories (name, slug) VALUES ('Apparel', 'apparel'); INSERT INTO product_categories (product_id, category_id) SELECT p.id, c.id FROM products p, categories c WHERE p.slug = 'sample-tee' AND c.slug = 'apparel';" >/dev/null
# Category siblings for sample-tee, so the product page actually renders its
# "You may also like" row. Without them `related` is empty and the
# recommendation cards — a card surface this gate exists to cover — never
# appear in any baseline.
npx wrangler d1 execute DB --local --persist-to "$state_dir" \
  --command "INSERT INTO product_categories (product_id, category_id) SELECT p.id, c.id FROM products p, categories c WHERE p.slug IN ('pagination-item-1','pagination-item-2','pagination-item-3','pagination-item-4') AND c.slug = 'apparel';" >/dev/null
# A published content page, so the Markdown wrapper and the footer's page links
# are both exercised by the shell baselines.
npx wrangler d1 execute DB --local --persist-to "$state_dir" \
  --command "INSERT INTO pages (title, slug, body_markdown, published) VALUES ('About', 'about', '# About us' || char(10) || char(10) || 'A fixture page with a [link](/products) and a list:' || char(10) || char(10) || '- one' || char(10) || '- two', 1);" >/dev/null

# Product-detail shapes. The detail route branches hard on variants, extras, and
# gallery length, and an extraction that quietly dropped one of those branches
# would otherwise pass every baseline. sample-tee gets all three; the pagination
# items stay plain, and item-1 is the sold-out case.
npx wrangler d1 execute DB --local --persist-to "$state_dir" \
  --command "UPDATE products SET variant_label = 'Size' WHERE slug = 'sample-tee'; INSERT INTO product_variants (product_id, label, price_cents, stock, sku, position) SELECT id, 'Small', 2400, 5, 'TEE-S', 0 FROM products WHERE slug = 'sample-tee' UNION ALL SELECT id, 'Large', 2900, 0, 'TEE-L', 1 FROM products WHERE slug = 'sample-tee';" >/dev/null
npx wrangler d1 execute DB --local --persist-to "$state_dir" \
  --command "INSERT INTO product_extras (product_id, label, price_delta_cents, position) SELECT id, 'Gift wrap', 500, 0 FROM products WHERE slug = 'sample-tee' UNION ALL SELECT id, 'Rush delivery', 0, 1 FROM products WHERE slug = 'sample-tee';" >/dev/null
npx wrangler d1 execute DB --local --persist-to "$state_dir" \
  --command "INSERT INTO product_images (product_id, image_key, position) SELECT id, 'media/tee-front.jpg', 0 FROM products WHERE slug = 'sample-tee' UNION ALL SELECT id, 'media/tee-back.jpg', 1 FROM products WHERE slug = 'sample-tee';" >/dev/null

# A low-stock product (LOW_STOCK is 5), so the scarcity marker is exercised by a
# real render rather than only by a container test.
npx wrangler d1 execute DB --local --persist-to "$state_dir" \
  --command "UPDATE products SET stock = 3 WHERE slug = 'pagination-item-5';" >/dev/null

# A product row carrying a legacy currency different from the store's. The
# storefront has always DISPLAYED the store currency, so this pins that the
# live-price hook and the JSON-LD offer agree with what is on the page rather
# than announcing the row's currency underneath it.
npx wrangler d1 execute DB --local --persist-to "$state_dir" \
  --command "UPDATE products SET currency = 'eur' WHERE slug = 'pagination-item-3';" >/dev/null

# Public serializers refuse rows without a public ID; the values are random per
# run and normalized out of the baselines.
npx wrangler d1 execute DB --local --persist-to "$state_dir" \
  --command "UPDATE products SET public_id = 'prod_' || lower(substr(hex(randomblob(10)),1,10)) WHERE public_id IS NULL; UPDATE categories SET public_id = 'cat_' || lower(substr(hex(randomblob(10)),1,10)) WHERE public_id IS NULL; UPDATE pages SET public_id = 'page_' || lower(substr(hex(randomblob(10)),1,10)) WHERE public_id IS NULL; UPDATE product_variants SET public_id = 'var_' || lower(substr(hex(randomblob(10)),1,10)) WHERE public_id IS NULL; UPDATE product_extras SET public_id = 'xtra_' || lower(substr(hex(randomblob(10)),1,10)) WHERE public_id IS NULL; UPDATE product_images SET public_id = 'pimg_' || lower(substr(hex(randomblob(10)),1,10)) WHERE public_id IS NULL;" >/dev/null

npx wrangler dev \
  --config dist/server/wrangler.json \
  --persist-to "$state_dir" \
  --var CANONICAL_ORIGIN:https://canonical.example \
  --var AUTH_SECRET:integration-auth-secret \
  --ip 127.0.0.1 \
  --port "$test_port" >"$worker_log" 2>&1 &
worker_pid="$!"

ready=""
for _ in {1..40}; do
  if curl --fail --silent --show-error "http://127.0.0.1:$test_port/api/products?limit=1" >/dev/null 2>&1; then
    ready="yes"
    break
  fi
  if ! kill -0 "$worker_pid" 2>/dev/null; then
    sed -n '1,160p' "$worker_log" >&2
    exit 1
  fi
  sleep 0.25
done

if [[ -z "$ready" ]]; then
  sed -n '1,160p' "$worker_log" >&2
  echo "storefront baselines: Worker did not become ready" >&2
  exit 1
fi

node test/helpers/baselines.mjs "$test_port" "$@"
