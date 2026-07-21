#!/usr/bin/env bash
#
# Provision + deploy a FRESH, fully-independent minshop instance:
#   its own D1 database, R2 bucket, Worker, and secrets (AUTH_SECRET + SECRETS_KEK).
#   FREE-PLAN default — optional add-ons (Vectorize/AI, Images, send_email) are
#   opt-in via wrangler.template.jsonc (see the comments there).
#
#   Usage:  scripts/provision-cf.sh <slug>
#   <slug>: lowercase letters/digits/hyphens, e.g. "acme-store".
#
# Deploys via the SAME path as `npm run deploy` (the Astro adapter integrates with
# ./wrangler.jsonc), so we temporarily swap in the instance config and restore the
# original on exit — even if the script fails partway.
#
# ⚠  Creates REAL Cloudflare resources on your account and may incur usage. Review
#    before running. Requires: wrangler (logged in: `npx wrangler login`), openssl.
set -euo pipefail

SLUG="${1:-}"
if [[ ! "$SLUG" =~ ^[a-z][a-z0-9-]{1,40}$ ]]; then
  echo "usage: scripts/provision-cf.sh <slug>   (lowercase a-z, 0-9, '-')" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
W="npx --yes wrangler"
DB_NAME="${SLUG}-db"
BUCKET="${SLUG}-images"
META=".instances/${SLUG}.env"
mkdir -p .instances

# Restore the canonical wrangler.jsonc no matter how we exit.
restore() { [ -f wrangler.jsonc.bak ] && mv -f wrangler.jsonc.bak wrangler.jsonc || true; }
trap restore EXIT

echo "▸ [1/5] Creating D1 database '$DB_NAME'…"
DB_OUT="$($W d1 create "$DB_NAME")"
DB_ID="$(printf '%s' "$DB_OUT" | grep -oiE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
[ -n "$DB_ID" ] || { echo "✗ could not parse database_id from output:"; echo "$DB_OUT"; exit 1; }
echo "    database_id=$DB_ID"

echo "▸ [2/5] Creating R2 bucket '$BUCKET'…"
$W r2 bucket create "$BUCKET"

# FREE-PLAN DEFAULT: D1 + R2 only. Semantic search (Workers AI + Vectorize — the
# latter needs the PAID plan) is opt-in: create the index and add its bindings to
# wrangler.template.jsonc (see the comments there), then re-run/redeploy.

echo "▸ [3/5] Rendering instance config → wrangler.jsonc (original backed up)…"
cp wrangler.jsonc wrangler.jsonc.bak
sed -e "s/__NAME__/$SLUG/g" \
    -e "s/__DB_NAME__/$DB_NAME/g" \
    -e "s/__DB_ID__/$DB_ID/g" \
    -e "s/__BUCKET__/$BUCKET/g" \
    wrangler.template.jsonc > wrangler.jsonc

echo "▸ [4/5] Applying migrations + building…"
$W d1 migrations apply DB --remote
npx --yes astro build

echo "▸ [5/5] Deploying + setting AUTH_SECRET + SECRETS_KEK…"
$W deploy
openssl rand -base64 32 | $W secret put AUTH_SECRET
# Key-encryption key for the in-dashboard payment-key vault (features/secrets).
# With this set, the store owner can paste Stripe/OpenNode keys in Settings and
# they're stored AES-GCM-encrypted in D1 — no further `wrangler secret put` needed.
openssl rand -base64 32 | $W secret put SECRETS_KEK

# Record what was created so destroy-cf.sh can find it.
{ echo "SLUG=$SLUG"; echo "DB_NAME=$DB_NAME"; echo "DB_ID=$DB_ID"; echo "BUCKET=$BUCKET"; } > "$META"

cat <<EOF

✓ Instance '$SLUG' deployed.  (metadata: $META)

  Payment keys: paste them in the dashboard (Settings → Payment keys) — they're
  stored encrypted in D1 under the SECRETS_KEK just set. Or set them as Worker
  secrets instead (they take a back seat to D1 values):
    npx wrangler secret put STRIPE_SECRET_KEY      --name $SLUG
    npx wrangler secret put STRIPE_WEBHOOK_SECRET  --name $SLUG

  Admin auth: open /admin/setup and set the admin password there (stored hashed in
  D1). The wizard is reachable until you do — so set it promptly, or front /admin
  with Cloudflare Access on a public deploy.

  Then open the store and finish onboarding at /admin/setup.
  Tear it all down with:  scripts/destroy-cf.sh $SLUG
EOF
