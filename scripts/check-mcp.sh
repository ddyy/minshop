#!/usr/bin/env bash
set -euo pipefail

# Reproducible MCP gate for fresh clones. The real deploy config is per-instance
# and gitignored, so render the tracked template with inert, schema-valid ids for
# Wrangler's local-only dry run.
root="$(cd "$(dirname "$0")/.." && pwd)"
check_config="$(mktemp "$root/mcp/.wrangler-check.XXXXXX.jsonc")"
cleanup() { rm -f "$check_config"; }
trap cleanup EXIT INT TERM

sed \
  -e 's/__NAME__/minshop-check/g' \
  -e 's/__DB_NAME__/minshop-check-db/g' \
  -e 's/__DB_ID__/00000000-0000-0000-0000-000000000000/g' \
  "$root/mcp/wrangler.template.jsonc" > "$check_config"

npx tsc -p "$root/mcp/tsconfig.json" --noEmit
npx wrangler deploy --config "$check_config" --dry-run
