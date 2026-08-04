#!/usr/bin/env bash
#
# Tear down an instance created by scripts/provision-cf.sh: deletes the Worker, its
# Vectorize index, both R2 buckets, D1 database, and the auto-provisioned sessions KV.
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
FILES_BUCKET="${SLUG}-files"
INDEX="${SLUG}-products"
KV_TITLE="${SLUG}-session" # Astro sessions KV, auto-provisioned by the adapter on deploy
META=".instances/${SLUG}.env"
if [[ -f "$META" ]]; then
  recorded_files_bucket="$(sed -n 's/^FILES_BUCKET=//p' "$META" | head -1)"
  if [[ "$recorded_files_bucket" =~ ^[a-z][a-z0-9-]{1,63}$ ]]; then
    FILES_BUCKET="$recorded_files_bucket"
  fi
fi

echo "About to DELETE instance '$SLUG':"
echo "  • Worker          $SLUG"
echo "  • Vectorize index $INDEX"
echo "  • R2 bucket       $BUCKET   (must be empty)"
echo "  • Private files   $FILES_BUCKET   (must be empty)"
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
echo "▸ Deleting private-file R2 bucket '$FILES_BUCKET'…"
files_bucket_deleted=1
if ! $W r2 bucket delete "$FILES_BUCKET"; then
  files_bucket_deleted=0
  echo "  The private files bucket still holds deliverables; empty it manually to remove it."
  echo "  Its exact name and cleanup command will remain recorded in $META."
fi

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

if [[ "$files_bucket_deleted" == "1" ]]; then
  rm -f "$META"
else
  {
    echo "RESIDUAL_RESOURCE=private-files"
    echo "CLEANUP_COMMAND=npx wrangler r2 bucket delete $FILES_BUCKET"
  } >> "$META"
fi
echo "✓ Teardown of '$SLUG' issued. Check the Cloudflare dashboard to confirm."
