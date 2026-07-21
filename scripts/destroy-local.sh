#!/usr/bin/env bash
#
# Reset THIS repo's local store: wipe the local D1 + R2 data under .wrangler/state
# so the next `provision:local` / dev run starts fresh — no products, orders,
# settings, or images (the setup wizard runs again). Local only, no cloud calls.
#
#   Usage:  scripts/destroy-local.sh [--yes]
#   --yes:  skip the confirmation prompt.
#
# Removes only the D1 + R2 data dirs under .wrangler/state — never the .wrangler root.
set -euo pipefail

YES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) YES=1; shift ;;
    *) echo "unknown option: $1 (destroy:local takes no slug — it resets the current repo)" >&2; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
D1=".wrangler/state/v3/d1"
R2=".wrangler/state/v3/r2"

if [[ ! -d "$D1" && ! -d "$R2" ]]; then
  echo "No local store data found — nothing to reset."
  exit 0
fi

if [[ "$YES" != "1" ]]; then
  read -rp "Reset this repo's local store (delete local products, orders, settings, images)? [y/N] " ans
  [[ "$ans" == "y" || "$ans" == "Y" ]] || { echo "aborted."; exit 0; }
fi

# Stop any local dev server so the data dirs aren't locked / re-created under us.
pkill -f "wrangler dev" 2>/dev/null || true

rm -rf "$D1" "$R2"
echo "✓ Local store reset. Set it up again with:  npm run provision:local -- --seed"
