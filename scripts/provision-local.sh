#!/usr/bin/env bash
#
# Set up THIS repo's local store: build, migrate, and (optionally) seed the local
# D1 (standard .wrangler/state), then print how to run it. The dev server runs in
# PROD MODE (admin gate active, unlike `astro dev`); secrets come from ./.dev.vars.
#
# One checkout = one local store. To run a SECOND, independent store, copy the repo
# to another directory and run this there — each copy keeps its own local data.
# (This is the local counterpart to provision-cf.sh, which creates a cloud instance.)
#
#   Usage:  scripts/provision-local.sh [--seed] [--no-build]
#   --seed:     load ./seed.sql after migrating.
#   --no-build: skip `astro build` (reuse the existing dist/ — faster reruns).
#
# Auto-generates SECRETS_KEK + AUTH_SECRET into .dev.vars if missing (idempotent),
# so the encrypted key vault and admin sessions work locally with no manual setup.
# Reset this repo's local data with:  npm run destroy:local
set -euo pipefail

SEED=0
BUILD=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --seed) SEED=1; shift ;;
    --no-build) BUILD=0; shift ;;
    -*) echo "unknown option: $1" >&2; exit 1 ;;
    *) echo "unexpected arg '$1' — provision:local takes no slug; it sets up the current repo." >&2; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
W="npx --yes wrangler"
GEN="dist/server/wrangler.json"        # adapter-generated config (has main + bindings)

# Locally there's no Worker secret store — secrets come from .dev.vars. Generate the
# two the store needs (SECRETS_KEK encrypts the D1 key vault; AUTH_SECRET signs admin
# + customer sessions) if they're not already set. Idempotent: never overwrites an
# existing value. .dev.vars is gitignored, so these stay on your machine.
ensure_devvar() {
  local name="$1"
  [[ -f .dev.vars ]] || : > .dev.vars
  grep -qE "^${name}=" .dev.vars && return 0
  # Make sure the file ends with a newline before appending.
  [[ -s .dev.vars && -n "$(tail -c1 .dev.vars)" ]] && printf '\n' >> .dev.vars
  printf '%s=%s\n' "$name" "$(openssl rand -base64 32)" >> .dev.vars
  echo "  • generated ${name} → .dev.vars"
}
echo "▸ Ensuring local secrets in .dev.vars…"
ensure_devvar SECRETS_KEK
ensure_devvar AUTH_SECRET

if [[ "$BUILD" == "1" || ! -f "$GEN" ]]; then
  echo "▸ [1/2] Building (astro build)…"
  npx --yes astro build
else
  echo "▸ [1/2] Skipping build (--no-build); reusing $GEN"
fi
[[ -f "$GEN" ]] || { echo "✗ $GEN missing — run without --no-build." >&2; exit 1; }

echo "▸ [2/2] Migrating + seeding the local D1…"
# CI=1 → wrangler skips the interactive "apply N migrations?" confirmation.
CI=1 $W d1 migrations apply DB --local
if [[ "$SEED" == "1" ]]; then
  [[ -f seed.sql ]] && $W d1 execute DB --local --file=./seed.sql \
    || echo "  (--seed given but ./seed.sql not found — skipped)"
fi

cat <<EOF

✓ Local store ready (this repo).

  Start it (PROD mode — admin gate active) with:

    npm run preview                 # add -- --port N for a custom port

  Then: http://localhost:8787/   ·   admin http://localhost:8787/admin/setup
  Reset local data:  npm run destroy:local
  Another store:     copy this repo to another directory and run provision:local there
EOF
