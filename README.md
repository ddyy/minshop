# minshop

A small, full-Cloudflare ecommerce store: storefront + admin + Stripe payments, running on Cloudflare Workers. No brand baked in — the store name is a config value, so it clones cleanly as a template.

It's intentionally lightweight and cheap to run: Cloudflare's free tier covers it until real volume, and the only hard cost is Stripe's per-sale fee.

## Features

- **Storefront** — server-rendered product list + product detail, near-zero client JS
- **Cart** — cookie-based (no client JS), with both "Add to cart" and one-click "Buy now"
- **Search** — FTS5 full-text (bm25, prefix match, typo-correct), no JS — or **semantic search** via Workers AI + Vectorize, one config toggle (see [Search](#search))
- **Categories** — nested (arbitrary-depth tree), many-to-many with products; storefront category pages with breadcrumbs + sub-category drill-down (recursive descendant queries)
- **Admin** — product CRUD (create / edit / delete) with image upload, plus a recent-orders view
- **Payments** — Stripe Checkout (hosted, single or multi-item) with a signature-verified webhook that records orders + line items — or **Bitcoin Lightning** (phoenixd / LNbits self-hosted, or OpenNode hosted), one config switch (see [Payments](#payments))
- **Shipping** — Stripe Checkout collects the shipping address + offers configurable rates (flat rates + free-over-threshold); the address & cost are captured onto the order
- **Discount codes** — promo-code field on checkout (toggle in config); codes are created/managed in the Stripe Dashboard, and the applied discount is captured onto the order
- **Tax** — sales tax / VAT via Stripe Tax (off by default — **activate Stripe Tax in the Dashboard first**); computed from the customer address and captured onto the order
- **Order email** — confirmation email behind an `EmailProvider` seam with two adapters: **Resend** (HTTPS API, works on the Workers free plan) or **Cloudflare Email** (binding, paid plan); gated by config (off until configured, then it's a flag)
- **Images** — uploaded to R2, served through the app (no public bucket required)
- **Swappable seams** — payments and storage sit behind interfaces (see [Architecture](#architecture))

## Stack

| Piece | Choice |
|---|---|
| Framework | [Astro](https://astro.build) (SSR) on Cloudflare Workers via `@astrojs/cloudflare` |
| Styling | Tailwind CSS v4 (`@tailwindcss/vite`) |
| Data | Cloudflare D1 (SQLite) — products, orders |
| Images | Cloudflare R2 — zero egress |
| Payments | Stripe Checkout, or Bitcoin Lightning (phoenixd / LNbits / OpenNode) |

## Quick start (local)

> **Requires Node ≥ 22.12** — use Node 22, the tested/supported release line.

```sh
npm install

# One shot: build, migrate + seed the local DB, and generate the two local
# secrets (SECRETS_KEK + AUTH_SECRET) into .dev.vars
npm run provision:local -- --seed

npm run dev                        # http://localhost:4321
```

Storefront is at `/`, admin at `/admin` — first visit lands on the **setup wizard**. There are no provider secrets to fill in by hand: payment/email/Turnstile keys are pasted in **Admin → Settings** and stored encrypted in D1 (see [Settings](#settings)). Granular scripts also exist (`db:migrate`, `db:seed`), `npm run preview` runs the built worker in prod-mode (admin gate active), and `npm run destroy:local` resets the local store.

### Tests

```sh
npm test          # vitest run (unit tests for pure logic)
npm run test:watch
npm run test:d1   # fresh migrations + seed + built Worker against isolated D1
```

Covers the pure functions — `slugify`, the FTS search sanitizer + edit-distance, `parseProductForm`, image validation, cart counting, reservation target aggregation, the order-number scheme, the Access-JWT verifier, pagination clamping, and the whitelisted `orderByClause` sort builders (the SQL-injection boundary for sortable tables). `npm run test:d1` adds clean-room D1 gates for reservation concurrency/release/settlement/legacy compatibility, then boots the production Worker against an isolated database and runs a demo checkout through paid-order settlement and confirmation. `npm run verify` runs both suites, full Astro diagnostics, the production build, and the MCP typecheck/deployment dry run.

### Testing payments locally

Paste your `sk_test_…` key in **Admin → Settings → Payments → Card (Stripe)**, then forward Stripe events to your dev server with the [Stripe CLI](https://docs.stripe.com/stripe-cli):

```sh
stripe listen --forward-to localhost:4321/api/webhook
# paste the printed whsec_… into Settings → Payments → Card (Stripe) → webhook signing secret
stripe trigger checkout.session.completed
```

The order shows up in `/admin` (and in D1: `npx wrangler d1 execute minshop-db --local --command "SELECT * FROM orders"`).

## Deploy

### One-click (Deploy to Cloudflare)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ddyy/minshop)

Forks the repo, provisions D1 (`minshop-db`) + R2 (`minshop-images`), applies migrations, and deploys — free-plan resources only. Then finish onboarding at `/admin/setup` (below). Optional paid add-ons (Images, semantic search, Cloudflare Email) are commented in `wrangler.jsonc` — uncomment + redeploy.

**Fields the deploy form shows:**

- **`SECRETS_KEK`, `AUTH_SECRET`** (masked) — the only two you must set. Paste a fresh random value into *each* (they must differ): run `openssl rand -base64 32` twice. The button can't generate them yet, and because these fields are masked their placeholder hints are hidden — so a leading label field, **`SET_SECRETS_KEK_AND_AUTH_SECRET_BELOW`**, appears above them as a reminder (ignore its value; it's unused). If you skip them and deploy with the `replace_with_*` defaults, the store fails closed with fix instructions on every route (by design — see [Gotchas](#gotchas)).
- **Location hint** — Cloudflare's own field for where to place the D1 database; pick the region nearest your shoppers.
- **No store name / time zone / search fields** — those are runtime settings you configure in the setup wizard and **Admin → Settings** (stored in D1), not at deploy time. Defaults until then: `My Shop` / `UTC` / keyword (FTS) search.

### CLI (one shot)

**One shot** — provisions a fresh, fully-independent instance (its own D1, R2, Vectorize index, Worker) and sets both Worker secrets:

```sh
npx wrangler login
npm run provision:cf my-store      # scripts/provision-cf.sh <slug>
```

Or **manually**:

```sh
npx wrangler login

# Provision real resources. The committed wrangler.jsonc declares D1/R2 by NAME
# with no ids (so a one-click / Workers Builds deploy auto-provisions them); for a
# manual deploy, add the printed database_id to the "DB" entry — or let
# `wrangler deploy` create it.
npx wrangler d1 create minshop-db
npx wrangler r2 bucket create minshop-images
npm run db:migrate:remote          # applies migrations/ to the production DB

# The ONLY two Worker secrets. Everything else (Stripe, OpenNode, Lightning,
# Resend, Turnstile keys + their config) is entered in Admin → Settings and
# stored encrypted in D1 under SECRETS_KEK.
openssl rand -base64 32 | npx wrangler secret put AUTH_SECRET   # signs sessions
openssl rand -base64 32 | npx wrangler secret put SECRETS_KEK   # encrypts the key vault

npm run deploy                     # astro build && wrangler deploy
```

Then open the site — it funnels to the **setup wizard**: set the admin password (required to finish; until then `/admin/setup` is open, so do it right away or front `/admin` with Access), then paste your payment keys in **Settings → Payments**. Finally point a **production Stripe webhook** at `https://<your-host>/api/webhook/stripe` (events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, and `checkout.session.expired`; async success fulfils delayed methods, while failure/expiry releases held inventory) and paste its `whsec_…` signing secret in the same card. Tear an instance down with `npm run destroy:cf <slug>`; reset its data in place with `npm run reset:remote`.

## Admin auth

Both `/admin` **and** `/api/admin/*` are gated by [`src/middleware.ts`](src/middleware.ts). You authenticate one of two ways:

- **Setup-wizard password (built-in).** On a fresh store the setup wizard at **`/admin/setup`** is reachable so you can create an admin password; it's stored as a PBKDF2 hash in D1 (there is **no `ADMIN_PASSWORD` env var**). The moment you save it the gate activates: `/admin` + `/api/admin` require sign-in at **`/admin/login`** (a form issuing an HMAC-signed, HttpOnly session cookie; `/api/admin` returns 401 instead of redirecting), and saving logs you in immediately. **First-run is open** — until a password exists, `/admin/setup` is publicly reachable, so set it promptly on a public deploy (or front `/admin` with Access, below).
  - **Optional Turnstile** on the login form: enable it in **Admin → Settings → Bot protection** (toggle + sitekey, with the secret stored in the encrypted vault) to add Cloudflare's bot challenge before the password is checked. The same toggle also gates the customer account sign-in. Cloudflare's documented always-pass test keys work for local trials.
- **Cloudflare Access (recommended for production).** Edge SSO/MFA, no app passwords, and it protects first-run setup too. In the Zero Trust dashboard add a **self-hosted application** covering **both** paths `your-host/admin` *and* `your-host/api/admin` (the API is a separate path — gating only `/admin` leaves the mutation endpoints open), add an identity provider (One-time PIN is enough), and an Allow policy for your email. Set both `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` in `wrangler.jsonc` vars; they are **required for Access mode** so the middleware can verify every JWT signature (zero-dependency, Web Crypto — see [`src/features/auth/access.ts`](src/features/auth/access.ts)). With either variable present, requests fail closed unless both are set and a valid assertion is supplied—including direct `*.workers.dev` requests with no header. (Use Access *or* the wizard password; if a password is set, password login takes precedence.)

**Forgot the admin password?** The hash lives in your D1 database, so the store owner can always reset it — clearing it drops the store back into the open setup wizard:

```bash
npm run admin:reset:remote   # deployed store  (or: npm run admin:reset for local)
```

Then reload `/admin/setup` and set a new one. (Same effect as running `DELETE FROM settings WHERE key='admin_password_hash';` in the Cloudflare dashboard → D1 console.) It requires Cloudflare account access, so it isn't a public reset — and if you run Cloudflare Access you're never locked out in the first place.

Local dev (`astro dev`) bypasses the gate so you're never locked out. Don't make `/admin` a "secret" path — that's security-through-obscurity; the gate is what protects it.

The Worker also applies native edge rate limits to anonymous login POSTs (10/minute per store, route, and connecting client) and checkout/invoice POSTs (20/minute). Webhooks and authenticated admin APIs are deliberately excluded; provider signatures and the admin gate protect those paths without disrupting legitimate retries or bulk administration. The limits are declared as `AUTH_RATE_LIMITER` and `CHECKOUT_RATE_LIMITER` bindings in the provisioning template; existing manually maintained Wrangler configs need the same `ratelimits` block.

## Payments

Checkout and the webhook depend on a `PaymentProvider` port (`src/features/payments`). Every rail is configured in **Admin → Settings → Payments** — its keys go in the encrypted vault, its config (default rail, node URLs) in D1 settings; a rail's checkout button appears automatically once its key is set, and the always-on **Demo** checkout works with zero keys. The "default rail" selector picks which one is offered first:

| Rail | What it is | Setup (all in Settings → Payments) |
|---|---|---|
| `stripe` *(default)* | Hosted card checkout | paste the secret key + webhook signing secret |
| `lightning` | Bitcoin Lightning via a **self-hosted** node — minshop mints a BOLT11 invoice and renders its own `/pay` page (QR + `lightning:` link), then confirms settlement | run **phoenixd** or **LNbits** (below); enter its URL + key |
| `opennode` | **Hosted** Lightning checkout (custodial processor) — redirect + webhook, like Stripe | paste the OpenNode API key |

Two ports, nested: the outer `PaymentProvider` (stripe / lightning / opennode) and an inner `LightningBackend` (phoenixd / lnbits) shared by the self-rendered flow. Adding another node is one adapter file.

**How settlement is trusted.** Lightning webhooks are treated as an untrusted *nudge* — on receipt minshop **re-polls the node** for the payment (the authority), so a forged webhook can't fake a sale. The `/pay` page also settles on load by polling, so it works even with no public webhook (e.g. local dev). Orders stay "paid-only": unpaid invoices live in a `pending_payments` table, never in `orders`.

**Shipping (Lightning).** When `shipping.enabled`, the Lightning cart routes through minshop's own `/checkout` page — a server-rendered address + shipping-option step (zone-based rates from `cfg.shipping`, see [Shipping](#shipping--order-email-config)) — so the invoice total includes shipping and the address + email land on the order, same as Stripe. (Stripe keeps its own hosted address/shipping collection, unchanged.)

**Limitations (Lightning).** **Tax** and promo codes are still Stripe-Checkout features and are skipped on the Lightning path — to charge tax on a non-Stripe rail you'd compute it yourself (e.g. Stripe's Tax *Calculation* API) and add it to the total. No automatic refunds (Lightning can't reverse in place). Invoices are priced in sats from a BTC spot rate fetched at checkout (`payments.lightning.rateUrl`, default Coinbase — no key).

### Running phoenixd (recommended self-hosted backend)

[phoenixd](https://phoenix.acinq.co/server) is ACINQ's self-custodial headless daemon — no full Bitcoin node, no manual channel management (ACINQ is the LSP), mainnet (real sats).

1. Run `phoenixd` on an always-on host (small VPS / Pi). First launch writes a **seed** to `~/.phoenix/` — back it up.
2. Expose its API (`127.0.0.1:9740`) to the Worker over HTTPS — a **Cloudflare Tunnel** (`cloudflared`) is the cleanest, no open ports.
3. In **Settings → Payments → Lightning**, pick the phoenixd node, enter its public URL, and paste the password — use the **`http-password-limited-access`** value (`~/.phoenix/phoenix.conf`): receive-only, can't spend.
4. Point phoenixd's `webhook-url` at `https://<your-host>/api/webhook/lightning`.

**LNbits** instead: pick LNbits in the same card and enter its URL + the wallet's *Invoice/read key*. **OpenNode**: paste the API key in its card and set the default rail to OpenNode.

## Architecture

Organized as **feature folders** (vertical slices) — each owns its data access, types, and components. Deleting a folder still builds.

```
src/
  config.ts                  store name + feature toggles
  layouts/Layout.astro
  features/
    products/  db · form · image · ProductForm.astro
    orders/    db
    payments/  provider (port) · stripe (adapter) · index (factory)
    storage/   provider (port) · r2 (adapter) · index (factory)
  pages/
    index.astro              storefront
    product/[id].astro
    admin/                   admin UI (CRUD)
    images/[...key].ts       serves R2 objects
    api/                     checkout · webhook · admin product endpoints
```

Two **ports-and-adapters seams** keep vendor code at the edges:

- **`PaymentProvider`** — `checkout.ts` / `webhook.ts` depend on the interface, not Stripe. Swapping to Paddle / Lemon Squeezy is one new adapter file.
- **`StorageProvider`** — the app stores and serves images by key; R2 is one adapter.

Deliberately **no runtime plugin system** — Workers bundle at build time, so composition is just imports + a factory.

## Database migrations

Schema lives in `migrations/` as numbered, additive SQL files (D1 tracks which have run, so deploys only apply new ones). To evolve the schema, add a new file — never edit an applied one:

```sh
npx wrangler d1 migrations create minshop-db add_product_sku   # writes migrations/0002_…
# edit it (ALTER TABLE / CREATE TABLE — additive, no destructive DROP)
npm run db:migrate            # local
npm run db:migrate:remote     # production
```

`seed.sql` is dev-only sample data (re-runnable), kept separate from schema.

## Settings

Most settings are **runtime** — changed in **`/admin/settings`**, stored in a D1 `settings` table, applied instantly, no redeploy. Secret keys are stored in the same table **AES-256-GCM-encrypted** under the `SECRETS_KEK` Worker secret (write-only from the UI, never echoed back), which is what makes an instance fully configurable — and clonable — from the dashboard:

- **General** — store name, cart/checkout on/off, "Buy now" on/off.
- **Payments** — one card per rail (Stripe / Lightning / OpenNode / Demo): its on/off toggle, config (node URLs, default rail), and keys.
- **Email** — on/off, provider (Resend / Cloudflare), from-address, key, send-test button.
- **Bot protection** — Turnstile toggle + sitekey + secret.
- **Search** — keyword (FTS5) vs semantic (Workers AI + Vectorize) + reindex.

A few **data-coupled** settings stay build-time (change + `npm run deploy`):

| Setting | Where | Effect |
|---|---|---|
| Currency | `currency` in `src/config.ts` | One store-wide currency — prices are stored as integer minor-units bound to it, so it can't safely flip at runtime |
| Image optimization | `images.optimizeOnUpload` / `images.maxWidth` in `src/config.ts` | Off by default ($0). On = downscale uploads to `maxWidth` px + WebP via Cloudflare Images (**paid** feature; doesn't transform in local dev — falls back to the original) |
| Order number | `orderNumber.{offset,step,randomStep}` in `src/config.ts` | Friendly customer-facing number derived from the internal id (e.g. `#1000`). `step` spaces them out; `randomStep` adds jitter to obscure the count (keep `step > randomStep`). The URL/security uses the random `public_id`, not this number |
| Favicon | replace `public/favicon.svg` | Browser tab icon |

Change a value, then `npm run deploy`. Currency uses `Intl.NumberFormat`, so `usd → $`, `eur → €`, `gbp → £`, `jpy → ¥` (decimals handled per-currency).

### Shipping (config) & order email (dashboard)

- **`shipping`** — lives in `src/config.ts`: `enabled` + destination **`zones`** (provider-agnostic, see `features/shipping/calculator`). Each zone has `countries` (ISO alpha-2, or `['*']` catch-all, matched top-to-bottom), `rates` (label + amount), and `freeOverCents` (a $0 "Free shipping" option once the subtotal qualifies; `null` to disable). The same engine feeds **Stripe Checkout's** options and the **Lightning** `/checkout` total, so both rails charge the same shipping. (Stripe shows a static list — the first zone's rates — since it collects the address after; the Lightning `/checkout` page is zone-accurate per the entered country.)
- **Email** — configured in **Admin → Settings → Email** (on/off, provider, from-address; the key in the encrypted vault). Unconfigured it's a safe no-op — checkout still succeeds. A **Send test email** button verifies real delivery. Two providers:
  - **Resend** (default, **works on the Workers free plan** — a plain HTTPS call): get a free key at [resend.com](https://resend.com), paste it in Settings → Email, and set the from-address (a Resend-verified domain, or `onboarding@resend.dev` to test to your own address).
  - **Cloudflare (Workers Paid plan)**: `wrangler email sending enable <yourdomain.com>` (the `EMAIL` binding is already declared), then pick Cloudflare in Settings → Email with a from-address on that domain. The section flags whether the binding is wired.

## Theming

Brand color, accent, font, and corner radius are **design tokens** in `src/styles/global.css` (a Tailwind v4 `@theme` block) — rebrand a clone by editing a few values, no component changes:

```css
@theme {
  --color-brand: #111827;        /* solid buttons, focus ring */
  --color-brand-hover: #374151;  /* its hover shade */
  --color-accent: #2563eb;       /* text links */
  --font-sans: ...;
}
```

These generate the `bg-brand` / `border-brand` / `text-accent` utilities used across the UI, so changing one value re-skins every button and link at once. There is no runtime templating or theme engine: the components are the template, and tokens are the knobs.

## Gotchas

Collected while building (the kind of thing that costs an afternoon):

- **Node ≥ 22.12 required** — use Node 22, the tested/supported release line.
- **Bindings via `import { env } from 'cloudflare:workers'`** — `Astro.locals.runtime.env` was removed in Astro v6.
- **No `main` / `assets` in `wrangler.jsonc`** — the Cloudflare adapter supplies the worker entry itself; setting `main` breaks a clean build.
- **CSRF is on by default** — Astro rejects cross-origin form POSTs (403). Real browsers send `Origin` and pass; only scripted requests need to set it.
- **Webhooks need `constructEventAsync`** — the sync verifier uses Node crypto, which isn't available on Workers.
- **One local dev server at a time** — two `astro dev` instances share the same `.wrangler` local-D1 state and race, surfacing as transient `no such table` errors. Use one server, or pass a separate persist dir.
- **`wrangler d1 export` fails with FTS5 virtual tables** — D1 can't export a DB that has virtual tables. To back up: drop `products_fts`, export, then recreate it (re-run migration `0003`).
- **FTS5 `MATCH` throws on raw input** — special chars (`-`, `"`, `:`, `*`) cause `fts5: syntax error`. Sanitize to alphanumeric prefix tokens before querying (see `features/products/search.ts`).
- **Placeholder secrets fail closed** — if `SECRETS_KEK` or `AUTH_SECRET` is still the `replace_with_*` value shipped in `.dev.vars.example`, `src/middleware.ts` blocks *every* route with a 500 + fix instructions (rather than run under a public key). The `provision:local` / `provision:cf` scripts generate real values; only hand-copying `.dev.vars.example` → `.dev.vars` without editing trips it.

## Search

Product search sits behind a `SearchProvider` seam (`features/search`) with a one-line toggle, `search.provider` in `src/config.ts` (or the `SEARCH_PROVIDER` var):

- **`fts`** *(default)* — SQLite **FTS5** keyword search: $0, fully local, exact-match + typo-correction ("did you mean"). Nothing to set up.
- **`vector`** — **semantic** search via **Workers AI** embeddings + **Vectorize**: matches by *meaning* ("something to drink coffee from" → mug), and powers similarity. Needs the AI + Vectorize bindings, so:

```sh
# 1. Create the index (dimensions must match the model — bge-base = 768)
wrangler vectorize create minshop-products --dimensions=768 --metric=cosine
# 2. Uncomment the "ai" + "vectorize" bindings in wrangler.jsonc
# 3. Turn it on: SEARCH_PROVIDER=vector (var) — or search.provider in store.config.ts
# 4. Backfill existing products: POST /api/admin/search/reindex (button in /admin/settings)
```

The same embeddings also power **"you may also like"** on product pages — semantic similarity (the product's nearest neighbours in Vectorize), falling back to category-based related when vector search is off. After enabling, products are embedded automatically on create/update (and removed on delete). If `vector` is selected but the bindings are missing, it **falls back to FTS** rather than breaking. FTS stays available either way — keep it for exact/SKU lookups. Cost: Workers AI is pay-per-inference (cheap embeddings, free daily allocation) and Vectorize is usage-billed beyond a free tier — so semantic search trades the strict $0 for meaning-based matching.

## Accounts (passwordless customer login)

Optional customer accounts via **magic-link** sign-in — no passwords, so no hashing/reset/breach liability. Off by default (`features.accounts`); guest checkout is unaffected (login is only for order history). When on it needs the `AUTH_SECRET` secret (signs the login token + session cookie) and email configured (to send the link).

How it works: `/account/login` emails a single-use, 15-min link → `/account/verify` sets a 30-day signed session cookie → `/account` lists the customer's orders (queried by their verified email — which orders already store, so there's barely any new schema). Reuses the Web-Crypto HMAC token primitive and the `EmailProvider` seam; swapping to OAuth = replacing `features/auth/customer.ts`.

```sh
# enable: features.accounts: true in store.config.ts
# needs: the AUTH_SECRET worker secret (provision scripts set it automatically)
#        + email configured in Admin → Settings → Email (to deliver the links)
```

In local dev the magic link is also logged to the server console, so you can test without email delivery.

## MCP server (operate the store from an assistant)

`mcp/` is a **standalone Cloudflare Worker** (Cloudflare Agents SDK / `McpAgent`) that exposes store operations as MCP tools, so an assistant like Claude can run the store conversationally — "what was revenue this week?", "mark order 1142 shipped", "create a product". It binds the **same D1** as the storefront and **reuses `features/*/db.ts`** (no duplicated logic).

**Why a separate Worker** (own `mcp/package.json`, own `node_modules`): the Astro adapter owns the storefront Worker's entry, and the Agents SDK pulls in workerd/miniflare deps that perturb Astro's build if hoisted into the root tree. Keeping it a sibling Worker isolates both.

**Tools:** `list_products`, `get_product`, `list_orders`, `get_order`, `order_stats`, `daily_totals` (reads) + `create_product`, `update_product`, `fulfill_order` (writes).

**Auth:** a bearer token. Set `MCP_TOKEN`; clients send `Authorization: Bearer <token>`. Unset = the server returns 503 (fail-closed). (Cloudflare's Workers OAuth Provider is the upgrade for scoped/multi-user access.)

```sh
cd mcp && npm install && cd ..
cp mcp/.dev.vars.example mcp/.dev.vars      # set MCP_TOKEN
npm run mcp:dev                              # local, shares the storefront's local D1
npm run mcp:check                            # dry-run build
# deploy: wrangler secret put MCP_TOKEN --config mcp/wrangler.jsonc ; npm run mcp:deploy
```

In production both Workers bind the same D1 (by `database_id`), so the MCP server operates the **real** store automatically. Connect any MCP client to `https://<your-mcp-host>/mcp` (streamable HTTP) with the bearer header. Note: write tools (create/fulfill) change live data — guard the token like a password.

## Agent API (catalog + checkout)

A small, **public**, machine-readable API so an AI agent can **browse and buy** without scraping HTML or driving a browser — the "agent *shops* the store" counterpart to the MCP server's "agent *operates* the store". Clean JSON, absolute URLs, open CORS.

| Method & path | Purpose |
|---|---|
| `GET /api/products` | Active catalog. `?q=` (uses the active **search** backend — semantic when on), `?limit=` (1–100, default 24), `?offset=` |
| `GET /api/products/:slug` | One product as JSON (404 if missing/inactive) |
| `POST /api/checkout` | Programmatic checkout. Body `{ "items": [{ "slug", "quantity" }] }` → `{ checkout_url, … }` |

Each product is self-describing, price in both major + minor units:

```json
{ "slug": "merino-wool-beanie", "name": "Merino Wool Beanie",
  "price": { "amount": 32, "cents": 3200, "currency": "USD" },
  "in_stock": true, "categories": ["Apparel"],
  "image": "https://…/images/products/merino-wool-beanie.webp",
  "url": "https://…/product/merino-wool-beanie" }
```

`POST /api/checkout` reuses the **same** Stripe/OpenNode session as the storefront (shipping/tax/discounts apply on the hosted page) and returns a `checkout_url` the agent hands to the human to pay — minshop stops at *"produce a pay link"*, not *"move money on the user's behalf"*, since agentic-payment standards aren't settled. The browser form checkout is unchanged; the JSON path triggers only on `Content-Type: application/json`.

### Demo — an agent shops the store

```sh
node scripts/agent-demo.mjs https://<your-host> "warm hat" 40
# Search "warm hat" under 40: 3 in-stock candidate(s)
#   USD 32  Merino Wool Beanie  [merino-wool-beanie]   ← picked (most relevant in budget)
# → prints the full Stripe checkout URL
```

Or just ask any tool-using LLM:

> "Using `<host>/api/products`, find a warm hat under $40, then `POST /api/checkout` with `{items:[{slug,quantity}]}` and give me the checkout URL."

Complete payment with the Stripe **test** card `4242 4242 4242 4242` (any future expiry/CVC/postal) — prod runs Stripe test keys, so **nothing is charged**; the order then appears in `/admin → Orders`.

> **Gotcha:** the checkout URL's `#`-fragment carries the session token — copy/print it **whole**. A truncated link yields Stripe's "Something went wrong".

## Cost

Cloudflare free tier (Workers 100k req/day, D1 5 GB, R2 10 GB) covers a small store comfortably — effectively $0 until scale. Stripe charges only per transaction.
