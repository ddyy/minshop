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
# Every product and page shape comes from the shared fixture, so the states this
# gate protects are the same ones `npm run db:seed:storefront-states` makes
# browsable. A shape that exists only here could never be looked at.
npx wrangler d1 execute DB --local --persist-to "$state_dir" \
  --file ./test/fixtures/storefront-states.sql >/dev/null

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
ready=""
for _ in {1..40}; do
  if curl --max-time 30 --fail --silent --show-error "http://127.0.0.1:$test_port/api/products?limit=1" >/dev/null 2>&1; then
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
