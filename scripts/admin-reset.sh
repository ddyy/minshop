#!/usr/bin/env bash
#
# Forgot the admin password? This clears the `admin_password_hash` row from the
# `settings` table, which drops the store back into BOOTSTRAP mode — /admin/setup
# reopens so you can set a new password (see src/middleware.ts).
#
#   Usage:  scripts/admin-reset.sh [--remote] [--yes]
#   --remote: target the DEPLOYED D1 (default: the local .wrangler/state store).
#   --yes:    skip the confirmation prompt.
#
# Requires Cloudflare account access (wrangler) — only the store owner can run it;
# it is NOT a public "forgot password" endpoint. After running, open /admin/setup
# and set a new password promptly (the wizard is open until you do).
set -euo pipefail

REMOTE=0
YES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote) REMOTE=1; shift ;;
    --yes|-y) YES=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
W="npx --yes wrangler"
if [[ "$REMOTE" == "1" ]]; then TARGET="--remote"; WHERE="DEPLOYED"; else TARGET="--local"; WHERE="local"; fi

if [[ "$YES" != "1" ]]; then
  read -rp "Clear the admin password on the $WHERE store (reopens /admin/setup)? [y/N] " ans
  [[ "$ans" == "y" || "$ans" == "Y" ]] || { echo "aborted."; exit 0; }
fi

# CI=1 → skip wrangler's own confirmation on a --remote write (we already confirmed).
CI=1 $W d1 execute DB $TARGET --command "DELETE FROM settings WHERE key='admin_password_hash';"
echo "✓ Admin password cleared on the $WHERE store. Open /admin/setup to set a new one."
