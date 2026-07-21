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

# The production build's generated Worker must resolve the same D1 binding. Boot
# it against the isolated state and exercise the public catalog end-to-end.
npx wrangler dev \
  --config dist/server/wrangler.json \
  --persist-to "$state_dir" \
  --ip 127.0.0.1 \
  --port "$test_port" >"$worker_log" 2>&1 &
worker_pid="$!"

catalog=""
for _ in {1..40}; do
  if catalog="$(curl --fail --silent --show-error "http://127.0.0.1:$test_port/api/products?limit=1" 2>/dev/null)"; then
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
' "$catalog"

# Exercise a real application write through the binding: demo checkout creates a
# pending payment, settlement atomically writes the paid order + items, and the
# confirmation page reads that committed state back.
checkout="$(curl --fail --silent --show-error \
  -H 'content-type: application/json' \
  -H "origin: http://127.0.0.1:$test_port" \
  --data '{"items":[{"slug":"sample-tee","quantity":1}],"method":"demo"}' \
  "http://127.0.0.1:$test_port/api/checkout")"

pay_path="$(node -e 'const b=JSON.parse(process.argv[1]); if (!b.checkout_url) process.exit(1); process.stdout.write(new URL(b.checkout_url).pathname)' "$checkout")"
order_id="$(node -e 'const b=JSON.parse(process.argv[1]); if (!b.order_public_id) process.exit(1); process.stdout.write(b.order_public_id)' "$checkout")"
settle_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  -H 'content-type: application/x-www-form-urlencoded' \
  -H "origin: http://127.0.0.1:$test_port" \
  --data 'outcome=approve&email=integration%40example.com' \
  "http://127.0.0.1:$test_port$pay_path")"
if [[ "$settle_status" != "303" ]]; then
  echo "D1 integration failed: demo settlement returned HTTP $settle_status" >&2
  exit 1
fi

confirmation="$(curl --fail --silent --show-error "http://127.0.0.1:$test_port/order/$order_id")"
if [[ "$confirmation" != *"Sample Tee"* ]]; then
  echo "D1 integration failed: committed order was not readable" >&2
  exit 1
fi

echo "D1 integration passed: migrations + seed + bound reads + paid-order write/read"
