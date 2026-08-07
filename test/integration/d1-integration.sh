#!/usr/bin/env bash
set -euo pipefail

# Clean-room D1 integration gate: use an isolated Miniflare state directory so
# neither a developer's normal local database nor production can be touched.
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/minshop-d1-integration.XXXXXX")"
worker_log="$state_dir/worker.log"
worker_pid=""
test_port="${D1_TEST_PORT:-8791}"

cleanup() {
  if [[ -n "$worker_pid" ]] && kill -0 "$worker_pid" 2>/dev/null; then
    kill "$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
  fi
  rm -rf "$state_dir"
}
trap cleanup EXIT INT TERM

npx wrangler d1 migrations apply DB --local --persist-to "$state_dir" >/dev/null
npx wrangler d1 execute DB --local --persist-to "$state_dir" --file ./seed.sql >/dev/null
npx wrangler d1 execute DB --local --persist-to "$state_dir" \
  --command "INSERT INTO settings (key, value) VALUES ('setup_complete', '1');" >/dev/null
npx wrangler d1 execute DB --local --persist-to "$state_dir" \
  --command "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 30) INSERT INTO products (name, slug, description, price_cents, stock) SELECT 'Pagination Item ' || n, 'pagination-item-' || n, 'pagination fixture', 1000 + n, 10 FROM seq;" >/dev/null
npx wrangler d1 execute DB --local --persist-to "$state_dir" \
  --command "INSERT INTO categories (name, slug) VALUES ('Apparel', 'apparel'); INSERT INTO product_categories (product_id, category_id) SELECT p.id, c.id FROM products p, categories c WHERE p.slug = 'sample-tee' AND c.slug = 'apparel';" >/dev/null
image_bucket="$(node -e '
  const config = require("node:fs").readFileSync("wrangler.jsonc", "utf8");
  const match = config.match(/"binding"\s*:\s*"BUCKET"[\s\S]*?"bucket_name"\s*:\s*"([^"]+)"/);
  if (!match) throw new Error("BUCKET binding is missing a bucket_name");
  process.stdout.write(match[1]);
')"
files_bucket="$(node -e '
  const config = require("node:fs").readFileSync("wrangler.jsonc", "utf8");
  const match = config.match(/"binding"\s*:\s*"FILES"[\s\S]*?"bucket_name"\s*:\s*"([^"]+)"/);
  if (!match) throw new Error("FILES binding is missing a bucket_name");
  process.stdout.write(match[1]);
')"
npx wrangler r2 object put "$image_bucket/media/cache-header-fixture.svg" \
  --local --persist-to "$state_dir" --file public/favicon.svg \
  --content-type image/svg+xml >/dev/null
npx wrangler r2 object put "$files_bucket/deliverables/integration/guide.txt" \
  --local --persist-to "$state_dir" --file README.md \
  --content-type text/plain --cache-control 'private, no-store' >/dev/null
npx wrangler d1 execute DB --local --persist-to "$state_dir" \
  --command "UPDATE products SET file_key = 'deliverables/integration/guide.txt', file_name = 'integration-guide.txt', file_mime = 'text/plain', file_size_bytes = 1 WHERE slug = 'sample-tee';" >/dev/null
# Fixture rows need valid public_ids (hex ⊂ the Crockford alphabet) — the
# public serializers refuse rows without one.
npx wrangler d1 execute DB --local --persist-to "$state_dir" \
  --command "UPDATE products SET public_id = 'prod_' || lower(substr(hex(randomblob(10)),1,10)) WHERE public_id IS NULL; UPDATE categories SET public_id = 'cat_' || lower(substr(hex(randomblob(10)),1,10)) WHERE public_id IS NULL;" >/dev/null

index_rows="$(npx wrangler d1 execute DB --local --persist-to "$state_dir" \
  --command "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_orders_created', 'idx_orders_email_created', 'idx_products_active_created') ORDER BY name;")"
for index_name in idx_orders_created idx_orders_email_created idx_products_active_created; do
  if [[ "$index_rows" != *"$index_name"* ]]; then
    echo "D1 integration failed: missing query index $index_name" >&2
    exit 1
  fi
done

# The production build's generated Worker must resolve the same D1 binding. Boot
# it against the isolated state and exercise the public catalog end-to-end.
# Observability capture (on by default since wrangler 4.118) adds collector/tail
# services to the dev proxy; with it on, the proxy intermittently answered a
# request with its own bare 500 without ever invoking the Worker.
export X_LOCAL_OBSERVABILITY=false
npx wrangler dev \
  --config dist/server/wrangler.json \
  --persist-to "$state_dir" \
  --var CANONICAL_ORIGIN:https://canonical.example \
  --var AUTH_SECRET:integration-auth-secret \
  --ip 127.0.0.1 \
  --port "$test_port" >"$worker_log" 2>&1 &
worker_pid="$!"

# Every curl is bounded with --max-time. The readiness loop below bounds RETRIES,
# not individual requests: if wrangler accepts the connection and then never
# responds — which a cold CI runner can produce — an unbounded curl blocks
# forever, the liveness probe keeps passing because the process still exists,
# and the job dies at its 15-minute limit having printed nothing. A bound turns
# that into a fast, legible failure with the worker log attached.
catalog=""
for _ in {1..40}; do
  if catalog="$(curl --max-time 30 --fail --silent --show-error "http://127.0.0.1:$test_port/api/products?limit=1" 2>/dev/null)"; then
    break
  fi
  if ! kill -0 "$worker_pid" 2>/dev/null; then
    sed -n '1,160p' "$worker_log" >&2
    exit 1
  fi
  sleep 0.25
done

if [[ -z "$catalog" ]]; then
  sed -n '1,160p' "$worker_log" >&2
  echo "D1 integration failed: Worker did not become ready" >&2
  exit 1
fi

node -e '
  const body = JSON.parse(process.argv[1]);
  if (!Number.isInteger(body.total) || body.total < 1) throw new Error("seeded product total missing");
  if (!Array.isArray(body.products) || body.products.length !== 1) throw new Error("catalog did not read D1");
  if (!body.products[0].slug || !Number.isInteger(body.products[0].price?.cents)) {
    throw new Error("catalog product shape is invalid");
  }
  if (!body.products[0].url?.startsWith("https://canonical.example/products/")) {
    throw new Error("catalog product URL did not use CANONICAL_ORIGIN");
  }
  if (!body.products[0].image?.startsWith("https://canonical.example/")) {
    throw new Error("catalog image URL did not use CANONICAL_ORIGIN");
  }
' "$catalog"

# Search pagination must operate at the FTS query, not slice a fixed-size result.
search_page="$(curl --max-time 30 --fail --silent --show-error \
  "http://127.0.0.1:$test_port/api/products?q=pagination&limit=10&offset=10")"
node -e '
  const body = JSON.parse(process.argv[1]);
  if (body.total !== 30) throw new Error(`expected 30 search matches, got ${body.total}`);
  if (body.limit !== 10 || body.offset !== 10) throw new Error("search page metadata is wrong");
  if (!Array.isArray(body.products) || body.products.length !== 10) {
    throw new Error("search page did not return the requested window");
  }
' "$search_page"

# Catalog list serialization should fetch categories in bulk and preserve them.
sample_page="$(curl --max-time 30 --fail --silent --show-error \
  "http://127.0.0.1:$test_port/api/products?q=sample&limit=2")"
node -e '
  const body = JSON.parse(process.argv[1]);
  const tee = body.products.find((p) => p.slug === "sample-tee");
  if (!tee || !tee.categories.includes("Apparel")) {
    throw new Error("catalog list did not include the product category");
  }
' "$sample_page"
sample_id="$(node -e '
  const body = JSON.parse(process.argv[1]);
  const tee = body.products.find((p) => p.slug === "sample-tee");
  if (!tee?.id) process.exit(1);
  process.stdout.write(String(tee.id));
' "$sample_page")"

# The media library must exist and already contain every product image key, so
# existing uploads are manageable without moving a single R2 object.
media_rows="$(npx wrangler d1 execute DB --local --persist-to "$state_dir" \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('media','pages','page_media') ORDER BY name;")"
for table in media page_media pages; do
  if [[ "$media_rows" != *"$table"* ]]; then
    echo "D1 integration failed: missing table $table" >&2
    exit 1
  fi
done

backfill="$(npx wrangler d1 execute DB --local --persist-to "$state_dir" \
  --command "SELECT COUNT(*) AS missing FROM (SELECT image_key FROM product_images UNION SELECT image_key FROM products WHERE image_key IS NOT NULL AND image_key != '') refs LEFT JOIN media m ON m.image_key = refs.image_key WHERE m.id IS NULL;")"
if [[ "$backfill" != *"0"* ]]; then
  echo "D1 integration failed: product image keys missing from media" >&2
  exit 1
fi

# The public catalog routes are plural, and the retired singular URLs keep
# permanently redirecting so previously indexed links and sitemaps survive.
for pair in "product/sample-tee:/products/sample-tee" "category/apparel:/categories/apparel"; do
  old_path="${pair%%:*}"
  expected="${pair##*:}"
  redirect="$(curl --max-time 30 --silent --output /dev/null \
    --write-out '%{http_code} %{redirect_url}' \
    "http://127.0.0.1:$test_port/$old_path?sort=price")"
  if [[ "$redirect" != "301 http://127.0.0.1:$test_port$expected?sort=price" ]]; then
    echo "D1 integration failed: /$old_path did not redirect to $expected (got $redirect)" >&2
    exit 1
  fi
done

for path in /products/sample-tee /categories/apparel; do
  status="$(curl --max-time 30 --silent --output /dev/null --write-out '%{http_code}' \
    "http://127.0.0.1:$test_port$path")"
  if [[ "$status" != "200" ]]; then
    echo "D1 integration failed: $path returned $status" >&2
    exit 1
  fi
done

# Merchant-authored pages: published ones are public and discoverable, drafts are
# neither. Seeded directly because the integration harness has no admin session.
npx wrangler d1 execute DB --local --persist-to "$state_dir" \
  --command "INSERT INTO pages (title, slug, body_markdown, published) VALUES ('Shipping Info', 'shipping', '## Shipping\n\nWe ship worldwide.', 1), ('Secret Draft', 'secret-draft', 'Not ready.', 0);" >/dev/null

# Navigation is explicit now: publishing a page no longer puts it in the footer
# by itself. The migration's seed only backfills pages that existed when it ran,
# and these were created after it, so link them the way a merchant would.
npx wrangler d1 execute DB --local --persist-to "$state_dir" \
  --command "INSERT INTO menu_items (location, target_type, target_id, position) SELECT 'footer', 'page', id, 0 FROM pages WHERE slug = 'shipping';" >/dev/null

page_status="$(curl --max-time 30 --silent --output /dev/null --write-out '%{http_code}' \
  "http://127.0.0.1:$test_port/pages/shipping")"
if [[ "$page_status" != "200" ]]; then
  echo "D1 integration failed: published page returned $page_status" >&2
  exit 1
fi

page_body="$(curl --max-time 30 --fail --silent --show-error "http://127.0.0.1:$test_port/pages/shipping")"
if [[ "$page_body" != *"We ship worldwide."* ]]; then
  echo "D1 integration failed: published page did not render its Markdown" >&2
  exit 1
fi

# Workers Caching runs before the Worker and heuristically stores headerless
# responses. Crawl every GET/HEAD route class so only known public responses can
# ever leave with a shared directive; redirects, errors, and private routes must
# also be explicit.
assert_cache_control() {
  local path="$1"
  local expected="$2"
  local method="${3:-GET}"
  local headers="$state_dir/cache-headers.txt"
  local body="$state_dir/cache-body.txt"

  local status
  if [[ "$method" == "HEAD" ]]; then
    status="$(curl --max-time 30 --silent --head --output /dev/null --dump-header "$headers" \
      --write-out '%{http_code}' \
      "http://127.0.0.1:$test_port$path")"
    : >"$body"
  else
    status="$(curl --max-time 30 --silent --output "$body" --dump-header "$headers" \
      --write-out '%{http_code}' \
      "http://127.0.0.1:$test_port$path")"
  fi

  local actual
  actual="$(tr -d '\r' <"$headers" | awk 'tolower($0) ~ /^cache-control:/ { sub(/^[^:]+:[[:space:]]*/, ""); print; exit }')"
  if [[ "$actual" != "$expected" ]]; then
    echo "D1 integration failed: $method $path cache-control was '$actual' (expected '$expected'; HTTP status $status)" >&2
    echo "--- response headers ---" >&2
    tr -d '\r' <"$headers" >&2
    echo "--- response body (first 500 bytes) ---" >&2
    head -c 500 "$body" >&2; echo >&2
    echo "--- last 80 lines of wrangler dev log ---" >&2
    tail -n 80 "$worker_log" >&2
    exit 1
  fi
}

public_cache='public, max-age=0, s-maxage=600'
private_cache='private, no-store'

for path in \
  / /products /products/sample-tee /categories/apparel '/search?q=sample' \
  /pages/shipping /robots.txt /sitemap.xml /llms.txt \
  /api/products /api/products/sample-tee
do
  assert_cache_control "$path" "$public_cache"
done
assert_cache_control / "$public_cache" HEAD

for path in \
  /cart /checkout /express /payment-setup /partials/cart-count \
  /account /account/login /order/not-a-token /order/not-a-token/status \
  /order/not-a-token/download/itm_k7m2qx8vn6 /pay/not-an-id \
  /admin /api/admin/products /api/internal/cache-purge /api/cart /api/checkout
do
  assert_cache_control "$path" "$private_cache"
done

deploy_purge_headers="$state_dir/deploy-purge-headers.txt"
deploy_purge_status="$(curl --max-time 30 --silent --output /dev/null \
  --dump-header "$deploy_purge_headers" \
  --write-out '%{http_code}' \
  --request POST \
  --header 'content-type: application/json' \
  --header 'authorization: MinshopDeploy invalid' \
  --data '{}' \
  "http://127.0.0.1:$test_port/api/internal/cache-purge")"
if [[ "$deploy_purge_status" != "401" ]]; then
  echo "D1 integration failed: unsigned deploy purge returned $deploy_purge_status" >&2
  exit 1
fi
if ! tr -d '\r' <"$deploy_purge_headers" | grep -qi '^cache-control: private, no-store$'; then
  echo "D1 integration failed: deploy purge response was cacheable" >&2
  exit 1
fi

assert_cache_control /product/sample-tee "$public_cache"
assert_cache_control /category/apparel "$public_cache"
assert_cache_control /images/media/cache-header-fixture.svg \
  'public, max-age=31536000, immutable'
assert_cache_control /pages/no-such-page 'no-store'
assert_cache_control /not-a-route "$private_cache"

# Purge metadata follows the same allowlist. Product-bearing responses carry
# narrow product tags in addition to their family tags; private/error responses
# carry none.
assert_cache_tags() {
  local path="$1"
  local expected="$2"
  local headers="$state_dir/cache-tag-headers.txt"

  curl --max-time 30 --silent --output /dev/null --dump-header "$headers" \
    "http://127.0.0.1:$test_port$path"

  local actual
  actual="$(tr -d '\r' <"$headers" | awk 'tolower($0) ~ /^cache-tag:/ { sub(/^[^:]+:[[:space:]]*/, ""); print; exit }')"
  if [[ "$actual" != "$expected" ]]; then
    echo "D1 integration failed: GET $path cache-tag was '$actual' (expected '$expected')" >&2
    exit 1
  fi
}

assert_cache_tags_match() {
  local path="$1"
  local expected_pattern="$2"
  local headers="$state_dir/cache-tag-headers.txt"

  curl --max-time 30 --silent --output /dev/null --dump-header "$headers" \
    "http://127.0.0.1:$test_port$path"

  local actual
  actual="$(tr -d '\r' <"$headers" | awk 'tolower($0) ~ /^cache-tag:/ { sub(/^[^:]+:[[:space:]]*/, ""); print; exit }')"
  if [[ ! "$actual" =~ $expected_pattern ]]; then
    echo "D1 integration failed: GET $path cache-tag was '$actual' (expected pattern '$expected_pattern')" >&2
    exit 1
  fi
}

assert_cache_tags /pages/shipping 'catalog,shell'
assert_cache_tags /robots.txt 'catalog,shell'
assert_cache_tags_match /api/products/sample-tee '^catalog,product:prod_[0-9a-z]+$'
assert_cache_tags_match /products/sample-tee '^catalog,product:prod_[0-9a-z]+,shell$'
assert_cache_tags /cart ''
assert_cache_tags /not-a-route ''

# A draft must 404, and must say no-store so a browser or proxy cannot keep
# serving that 404 after the page is published.
draft_headers="$(curl --max-time 30 --silent --include --output /dev/null --write-out '%{http_code}' \
  --dump-header - "http://127.0.0.1:$test_port/pages/secret-draft")"
if [[ "$draft_headers" != *"404"* ]]; then
  echo "D1 integration failed: draft page did not 404" >&2
  exit 1
fi
if [[ "$draft_headers" != *"no-store"* ]]; then
  echo "D1 integration failed: draft 404 is missing cache-control: no-store" >&2
  exit 1
fi

missing_status="$(curl --max-time 30 --silent --output /dev/null --write-out '%{http_code}' \
  "http://127.0.0.1:$test_port/pages/no-such-page")"
if [[ "$missing_status" != "404" ]]; then
  echo "D1 integration failed: unknown page returned $missing_status" >&2
  exit 1
fi

# The footer renders what the merchant put in the menu, and hides a menu item
# whose target stops being published — the draft below is deliberately linked to
# prove the storefront drops it rather than rendering a dead link.
npx wrangler d1 execute DB --local --persist-to "$state_dir" \
  --command "INSERT INTO menu_items (location, target_type, target_id, position) SELECT 'footer', 'page', id, 1 FROM pages WHERE slug = 'secret-draft';" >/dev/null

home="$(curl --max-time 30 --fail --silent --show-error "http://127.0.0.1:$test_port/")"
if [[ "$home" != *"/pages/shipping"* ]]; then
  echo "D1 integration failed: menu-linked page missing from the footer" >&2
  exit 1
fi
if [[ "$home" == *"/pages/secret-draft"* ]]; then
  echo "D1 integration failed: draft page leaked into the footer via a menu item" >&2
  exit 1
fi

# Discovery surfaces published pages and hides drafts.
for surface in sitemap.xml llms.txt; do
  body="$(curl --max-time 30 --fail --silent --show-error "http://127.0.0.1:$test_port/$surface")"
  if [[ "$body" != *"/pages/shipping"* ]]; then
    echo "D1 integration failed: published page missing from $surface" >&2
    exit 1
  fi
  if [[ "$body" == *"secret-draft"* ]]; then
    echo "D1 integration failed: draft page leaked into $surface" >&2
    exit 1
  fi
  if [[ "$body" != *"https://canonical.example/"* ]]; then
    echo "D1 integration failed: $surface did not use CANONICAL_ORIGIN" >&2
    exit 1
  fi
done

robots="$(curl --max-time 30 --fail --silent --show-error "http://127.0.0.1:$test_port/robots.txt")"
if [[ "$robots" != *"Sitemap: https://canonical.example/sitemap.xml"* ]]; then
  echo "D1 integration failed: robots.txt did not use CANONICAL_ORIGIN" >&2
  exit 1
fi

# A shopper's cart stays private while the catalog shell remains shared. The
# count fragment reads only the HttpOnly cookie, and the full drawer resolves
# all cart rows through the batched product/variant/extra path.
cookie_jar="$state_dir/cart-cookies.txt"
cart_status="$(curl --max-time 30 --silent --output /dev/null --write-out '%{http_code}' \
  --cookie-jar "$cookie_jar" \
  -H 'content-type: application/x-www-form-urlencoded' \
  -H "origin: http://127.0.0.1:$test_port" \
  -H 'x-partial: 1' \
  --data "_action=add&product_id=$sample_id" \
  "http://127.0.0.1:$test_port/api/cart")"
if [[ "$cart_status" != "204" ]]; then
  echo "D1 integration failed: add-to-cart returned HTTP $cart_status" >&2
  exit 1
fi

cart_count_json="$(curl --max-time 30 --fail --silent --show-error \
  --cookie "$cookie_jar" \
  "http://127.0.0.1:$test_port/partials/cart-count")"
node -e '
  const body = JSON.parse(process.argv[1]);
  if (body.count !== 1) throw new Error(`expected cart count 1, got ${body.count}`);
' "$cart_count_json"

cart_fragment="$(curl --max-time 30 --fail --silent --show-error \
  --cookie "$cookie_jar" \
  "http://127.0.0.1:$test_port/partials/cart")"
if [[ "$cart_fragment" != *"Sample Tee"* ]]; then
  echo "D1 integration failed: private cart fragment did not resolve its product" >&2
  exit 1
fi

storefront_headers="$state_dir/storefront-headers.txt"
storefront_body="$state_dir/storefront.html"
curl --max-time 30 --fail --silent --show-error \
  --cookie "$cookie_jar" \
  --dump-header "$storefront_headers" \
  --output "$storefront_body" \
  "http://127.0.0.1:$test_port/?utm_source=integration"
if ! tr -d '\r' <"$storefront_headers" | grep -qi '^cache-control: public, max-age=0, s-maxage=600$'; then
  echo "D1 integration failed: cookied storefront shell was not cacheable" >&2
  exit 1
fi
if ! grep -q '<link rel="canonical" href="https://canonical.example/"' "$storefront_body"; then
  echo "D1 integration failed: storefront canonical did not use CANONICAL_ORIGIN" >&2
  exit 1
fi
if grep -q 'Cart (1)' "$storefront_body"; then
  echo "D1 integration failed: shared storefront leaked a personalized cart count" >&2
  exit 1
fi

# Exercise a real application write through the binding: demo checkout creates a
# stock reservation + pending payment, settlement atomically writes the paid
# order + items without decrementing twice, and the confirmation page reads that
# committed state back.
stock_before_demo="$(npx wrangler d1 execute DB --local --persist-to "$state_dir" --json \
  --command "SELECT stock FROM products WHERE slug = 'sample-tee';" |
  node -e 'let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s)[0].results[0].stock)))')"
checkout="$(curl --max-time 30 --fail --silent --show-error \
  -H 'content-type: application/json' \
  -H "origin: http://127.0.0.1:$test_port" \
  --data '{"items":[{"slug":"sample-tee","quantity":1}],"method":"demo","ship_to":{"email":"integration@example.com","name":"Integration Test","line1":"1 Test St","city":"Testville","postal":"12345","country":"US"}}' \
  "http://127.0.0.1:$test_port/api/checkout")"
status_path="$(node -e 'const b=JSON.parse(process.argv[1]); if (!b.order_status_url) process.exit(1); process.stdout.write(new URL(b.order_status_url).pathname)' "$checkout")"
confirming="$(curl --max-time 30 --fail --silent --show-error -H 'Accept:' "http://127.0.0.1:$test_port$status_path")"
confirming_item_id="$(node -e '
  const b=JSON.parse(process.argv[1]);
  if (b.status !== "confirming") throw new Error(`expected confirming, got ${b.status}`);
  if (!b.items?.[0]?.item_public_id?.startsWith("itm_")) throw new Error("confirming item has no itm_ identity");
  process.stdout.write(b.items[0].item_public_id);
' "$confirming")"
stock_after_demo_hold="$(npx wrangler d1 execute DB --local --persist-to "$state_dir" --json \
  --command "SELECT stock FROM products WHERE slug = 'sample-tee';" |
  node -e 'let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s)[0].results[0].stock)))')"
if [[ "$stock_after_demo_hold" -ne $((stock_before_demo - 1)) ]]; then
  echo "D1 integration failed: demo checkout did not reserve one unit of stock" >&2
  exit 1
fi

# In-app rails must be judged on the destination they SUBMIT, not on a preflight
# quote of the first configured zone. Zone 1 here is weight-only (and the seeded
# products carry no weights, so it can serve nothing); the catch-all zone 2 can.
# A demo order shipped to CA must therefore succeed — the pre-fix preflight 422'd
# it against zone 1 before ship_to was even read — while a US order still fails
# with the real missing_weight reason.
two_zone_config='{"schema":2,"revision":1,"enabled":true,"packageWeightGrams":0,"zones":[{"name":"United States","countries":["US"],"rates":[{"label":"By weight","pricing":{"type":"weight","bands":[{"upToGrams":1000,"amountCents":500}]}}],"freeOverCents":null},{"name":"Rest of world","countries":["*"],"rates":[{"label":"International","pricing":{"type":"flat","amountCents":3000}}],"freeOverCents":null}]}'
npx wrangler d1 execute DB --local --persist-to "$state_dir" \
  --command "INSERT INTO settings (key, value) VALUES ('shipping_config', '$two_zone_config')" >/dev/null

ca_body="$state_dir/ca-checkout.json"
ca_status="$(curl --max-time 30 --silent --output "$ca_body" --write-out '%{http_code}' \
  -H 'content-type: application/json' \
  -H "origin: http://127.0.0.1:$test_port" \
  --data '{"items":[{"slug":"sample-tee","quantity":1}],"method":"demo","ship_to":{"email":"integration@example.com","name":"Integration Test","line1":"1 Test St","city":"Testville","postal":"12345","country":"CA"}}' \
  "http://127.0.0.1:$test_port/api/checkout")"
if [[ "$ca_status" != "200" ]]; then
  echo "D1 integration failed: catch-all destination refused (HTTP $ca_status): $(cat "$ca_body")" >&2
  exit 1
fi

us_body="$state_dir/us-checkout.json"
us_status="$(curl --max-time 30 --silent --output "$us_body" --write-out '%{http_code}' \
  -H 'content-type: application/json' \
  -H "origin: http://127.0.0.1:$test_port" \
  --data '{"items":[{"slug":"sample-tee","quantity":1}],"method":"demo","ship_to":{"email":"integration@example.com","name":"Integration Test","line1":"1 Test St","city":"Testville","postal":"12345","country":"US"}}' \
  "http://127.0.0.1:$test_port/api/checkout")"
if [[ "$us_status" != "422" ]]; then
  echo "D1 integration failed: weight-only zone with weightless products returned HTTP $us_status (expected 422)" >&2
  exit 1
fi
# The REASON matters: a destination 422 here would mean the zone was never
# matched, not that the missing weight was detected.
node -e '
  const b = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (b.reason !== "missing_weight") throw new Error(`expected reason missing_weight, got ${b.reason}`);
  if (!Array.isArray(b.items) || !b.items.some((i) => i.name === "Sample Tee")) {
    throw new Error("missing_weight response did not name the product");
  }
' "$us_body"

npx wrangler d1 execute DB --local --persist-to "$state_dir" \
  --command "DELETE FROM settings WHERE key = 'shipping_config'" >/dev/null

# A shipped in-app order without a destination must be refused, not quietly
# accepted with zero shipping (the pre-fix behaviour this test used to rely on).
no_ship_status="$(curl --max-time 30 --silent --output /dev/null --write-out '%{http_code}' \
  -H 'content-type: application/json' \
  -H "origin: http://127.0.0.1:$test_port" \
  --data '{"items":[{"slug":"sample-tee","quantity":1}],"method":"demo"}' \
  "http://127.0.0.1:$test_port/api/checkout")"
if [[ "$no_ship_status" != "400" ]]; then
  echo "D1 integration failed: shipped demo checkout without ship_to returned HTTP $no_ship_status (expected 400)" >&2
  exit 1
fi

pay_path="$(node -e 'const b=JSON.parse(process.argv[1]); if (!b.checkout_url) process.exit(1); process.stdout.write(new URL(b.checkout_url).pathname)' "$checkout")"
order_id="$(node -e 'const b=JSON.parse(process.argv[1]); if (!b.order_public_id) process.exit(1); process.stdout.write(b.order_public_id)' "$checkout")"

# Some privacy-focused clients omit Origin on ordinary same-site form POSTs.
# The otk_ URL is already the bearer credential, so its demo form must remain
# usable without relaxing origin checks for any cookie-authenticated route.
originless_decline="$state_dir/originless-decline.html"
originless_status="$(curl --max-time 30 --silent --output "$originless_decline" --write-out '%{http_code}' \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data 'outcome=decline&email=integration%40example.com' \
  "http://127.0.0.1:$test_port$pay_path")"
if [[ "$originless_status" != "200" ]] || ! grep -q 'Payment declined' "$originless_decline"; then
  echo "D1 integration failed: originless capability payment returned HTTP $originless_status" >&2
  exit 1
fi

stock_before_demo_settle="$(npx wrangler d1 execute DB --local --persist-to "$state_dir" --json \
  --command "SELECT stock FROM products WHERE slug = 'sample-tee';" |
  node -e 'let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s)[0].results[0].stock)))')"
settle_status="$(curl --max-time 30 --silent --output /dev/null --write-out '%{http_code}' \
  -H 'content-type: application/x-www-form-urlencoded' \
  -H "origin: http://127.0.0.1:$test_port" \
  --data 'outcome=approve&email=integration%40example.com' \
  "http://127.0.0.1:$test_port$pay_path")"
if [[ "$settle_status" != "303" ]]; then
  echo "D1 integration failed: demo settlement returned HTTP $settle_status" >&2
  exit 1
fi
stock_after_demo_settle="$(npx wrangler d1 execute DB --local --persist-to "$state_dir" --json \
  --command "SELECT stock FROM products WHERE slug = 'sample-tee';" |
  node -e 'let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s)[0].results[0].stock)))')"
if [[ "$stock_after_demo_settle" -ne "$stock_before_demo_settle" ]]; then
  echo "D1 integration failed: demo settlement decremented reserved stock twice" >&2
  exit 1
fi
reservation_status="$(npx wrangler d1 execute DB --local --persist-to "$state_dir" --json \
  --command "SELECT status FROM checkout_reservations WHERE public_id = '$order_id';" |
  node -e 'let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s)[0].results[0].status)))')"
if [[ "$reservation_status" != "settled" ]]; then
  echo "D1 integration failed: demo reservation ended as $reservation_status, expected settled" >&2
  exit 1
fi

status_headers="$state_dir/status-headers.txt"
paid_status="$(curl --max-time 30 --fail --silent --show-error --dump-header "$status_headers" "http://127.0.0.1:$test_port$status_path")"
download_path="$(node -e '
  const b=JSON.parse(process.argv[1]);
  if (b.status !== "paid") throw new Error(`expected paid, got ${b.status}`);
  if (b.items?.[0]?.item_public_id !== process.argv[2]) throw new Error("item identity changed at settlement");
  if (!b.items[0].download_url) throw new Error("paid deliverable has no download URL");
  process.stdout.write(new URL(b.items[0].download_url).pathname);
' "$paid_status" "$confirming_item_id")"
if ! tr -d '\r' <"$status_headers" | grep -qi '^cache-control: private, no-store$'; then
  echo "D1 integration failed: status response was cacheable" >&2
  exit 1
fi
download_headers="$state_dir/download-headers.txt"
curl --max-time 30 --fail --silent --show-error --dump-header "$download_headers" \
  --output "$state_dir/downloaded-guide.txt" "http://127.0.0.1:$test_port$download_path"
cmp README.md "$state_dir/downloaded-guide.txt"
if ! tr -d '\r' <"$download_headers" | grep -qi '^content-disposition: attachment; filename="integration-guide.txt"'; then
  echo "D1 integration failed: download did not use its snapshotted filename" >&2
  exit 1
fi
download_count="$(npx wrangler d1 execute DB --local --persist-to "$state_dir" --json \
  --command "SELECT downloads FROM order_items WHERE public_id = '$confirming_item_id';" |
  node -e 'let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s)[0].results[0].downloads)))')"
if [[ "$download_count" != "1" ]]; then
  echo "D1 integration failed: download counter was $download_count" >&2
  exit 1
fi

# The order page is a capability URL: the guest TOKEN (from checkout_url's
# /pay/<token>) reads it; the bare ord_ public id must NOT.
guest_token="${pay_path#/pay/}"
confirmation="$(curl --max-time 30 --fail --silent --show-error "http://127.0.0.1:$test_port/order/$guest_token")"
if [[ "$confirmation" != *"Sample Tee"* ]]; then
  echo "D1 integration failed: committed order was not readable via its guest token" >&2
  exit 1
fi

bare_status="$(curl --max-time 30 --silent --output /dev/null --write-out '%{http_code}' \
  "http://127.0.0.1:$test_port/order/$order_id")"
if [[ "$bare_status" != "404" ]]; then
  echo "D1 integration failed: bare order public id granted access (HTTP $bare_status)" >&2
  exit 1
fi

# The cron handler only exists because wrangler `main` points at src/worker.ts
# and the Astro adapter bundles it. If an adapter upgrade stops honouring that,
# the build still succeeds and every scheduled sweep silently stops running —
# which is invisible until a store notices stock stuck on hold. Assert the built
# artifact really exposes the handler.
scheduled_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  "http://127.0.0.1:$test_port/cdn-cgi/handler/scheduled")"
if [[ "$scheduled_status" != "200" ]]; then
  echo "D1 integration failed: built worker exposes no scheduled handler (got $scheduled_status)" >&2
  exit 1
fi

echo "D1 integration passed: migrations + seed + bound reads + paid-order write/read + cron handler"
