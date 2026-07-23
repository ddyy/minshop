#!/usr/bin/env bash
#
# Tear down an instance created by scripts/provision-cf.sh: deletes the Worker, its
# Vectorize index, R2 bucket, D1 database, and the auto-provisioned sessions KV.
#
#   Usage:  scripts/destroy-cf.sh <slug>
#
# ⚠  IRREVERSIBLE — permanently deletes that instance's data (orders, products,
#    images). Deleting the Worker also removes its secrets. Some wrangler commands
#    prompt for their own confirmation; answer them.
set -euo pipefail

SLUG="${1:-}"
[[ -n "$SLUG" ]] || { echo "usage: scripts/destroy-cf.sh <slug>" >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
W="npx --yes wrangler"
DB_NAME="${SLUG}-db"
BUCKET="${SLUG}-images"
INDEX="${SLUG}-products"
KV_TITLE="${SLUG}-session" # Astro sessions KV, auto-provisioned by the adapter on deploy
META=".instances/${SLUG}.env"

echo "About to DELETE instance '$SLUG':"
echo "  • Worker          $SLUG"
echo "  • Vectorize index $INDEX"
echo "  • R2 bucket       $BUCKET   (must be empty)"
echo "  • D1 database     $DB_NAME"
echo "  • KV namespace    $KV_TITLE"
read -rp "This is IRREVERSIBLE. Type the slug to confirm: " confirm
[[ "$confirm" == "$SLUG" ]] || { echo "aborted."; exit 0; }

echo "▸ Deleting Worker '$SLUG'…"
$W delete --name "$SLUG" || echo "  (worker not found / already gone)"

echo "▸ Deleting Vectorize index '$INDEX'…"
$W vectorize delete "$INDEX" || echo "  (index not found)"

echo "▸ Deleting R2 bucket '$BUCKET'…"
# R2 buckets must be EMPTY to delete. If this fails, empty it first — e.g. loop
# 'wrangler r2 object delete' over the keys, or empty it in the dashboard — then retry.
$W r2 bucket delete "$BUCKET" || echo "  (could not delete — bucket may be non-empty; empty it then retry)"

echo "▸ Deleting D1 database '$DB_NAME'…"
$W d1 delete "$DB_NAME" || echo "  (database not found)"

echo "▸ Deleting KV namespace '$KV_TITLE' (Astro sessions)…"
# KV can only be deleted by id, so resolve it from the namespace list by title.
# node (already required by wrangler) keeps this portable — no jq/python dependency.
KV_ID="$($W kv namespace list 2>/dev/null \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const m=d.match(/\[[\s\S]*\]/);const a=m?JSON.parse(m[0]):[];const n=a.find(x=>x.title===process.argv[1]);process.stdout.write(n&&n.id?n.id:"")}catch(e){}})' "$KV_TITLE" 2>/dev/null || true)"
if [[ -n "$KV_ID" ]]; then
  $W kv namespace delete --namespace-id "$KV_ID" || echo "  (KV delete failed / already gone)"
else
  echo "  (no KV namespace '$KV_TITLE' found — nothing to delete)"
fi

rm -f "$META"
echo "✓ Teardown of '$SLUG' issued. Check the Cloudflare dashboard to confirm."
