# AGENTS.md — working on minshop

A guide for contributors and automated tooling making changes to minshop: a
small, full-Cloudflare ecommerce store (Astro 7 SSR on Workers + D1 + R2 +
Stripe / Lightning). Read this before editing. It's the map, the rules, the
recipes, and the traps.

## The loop (run this constantly)

```sh
nvm use 22         # REQUIRED — the supported toolchain runs on Node 22
npm run verify     # complete storefront + D1 + MCP green/red gate
```

`npm run verify` is the single signal that a change is sound: it runs unit tests,
full Astro diagnostics, the production build, the clean-room D1 integration, and
the MCP typecheck/deployment dry run. If it's green, the change holds together.
Run it after every meaningful edit, not just at the end.

Other commands: `npm run dev` (astro dev), `npm run preview` (wrangler dev =
production mode, for testing middleware/auth), `npm run db:migrate` (local D1),
`npm test`.

### Inspecting local data: use Local Explorer, not the CLI

Any local dev server (`npm run dev`, `npm run preview`) serves Cloudflare's
Local Explorer — a UI at `/cdn-cgi/explorer` and a self-describing REST API at
`/cdn-cgi/explorer/api` covering D1, KV, R2, Durable Objects and Workflows.
It reads the same local state the app does, with no setup.

Prefer it over `npx wrangler d1 execute --local` for reads and fixture setup:
that spawns a process each time (~1.2s) where this is an HTTP call (~0.02s) —
roughly 70x, which is the difference between checking state freely and avoiding
it. `GET /cdn-cgi/explorer/api` returns the OpenAPI spec, so the endpoints are
discoverable rather than memorized. The D1 database id is the binding name:

```sh
curl -s localhost:4321/cdn-cgi/explorer/api/d1/database/DB/raw \
  -H 'content-type: application/json' \
  -d '{"sql":"SELECT status, COUNT(*) FROM orders GROUP BY status"}'
```

Local only, and unauthenticated on the dev origin — it is never exposed on a
deployed Worker, but do not bind a dev server to a public interface. Anything
touching `--remote` still goes through wrangler. The API reports itself as
version `0.0.1`, so use it for working loops, not as the basis of a test gate.

## Customizing a cloned shop

Use the narrowest customization surface that fits the change:

1. **Admin → Settings** for runtime settings: store identity, time zone,
   storefront toggles, payment rails, email, bot protection, and search. These
   values live in D1 and apply without a deploy.
2. **`src/store.config.ts`** for versioned, build-time settings: currency,
   shipping zones and rates, image dimensions, order numbering, and
   template-only features. Override only changed keys; never customize
   `src/config.ts` defaults directly.
3. **`src/themes/<theme>/tokens.css`** for brand colors, fonts, surfaces, and
   corner radii — each theme owns its `@theme` block. `src/styles/overrides.css` is a
   normally-empty override layer applied after the theme's tokens. Keep
   structural styles in `src/styles/base.css` and avoid restyling individual
   components when a shared token will do.
4. **`public/favicon.svg`** for the browser icon. Products, categories, images,
   and other catalog content belong in the admin, not source files.
5. **`wrangler.jsonc`** for optional infrastructure bindings such as image
   optimization, semantic search, and email delivery. Keep optional bindings
   disabled unless the corresponding feature is configured.

Provider credentials belong in Admin → Settings, where the secret vault stores
them encrypted. Deployment-only secrets belong in the platform secret store.
Never put real credentials, customer data, payment data, personal paths, or
local environment files in the repository.

Before handing off a customized shop, run `npm run verify` and review
`git diff --check` plus `git status --short`. Add a new numbered migration for
schema changes; never rewrite a migration that may already have run.

## Architecture in one screen

**Feature folders (vertical slices).** Each owns its data access, types, and
components. Deleting a folder still builds.

```
src/
  config.ts              SCHEMA + DEFAULTS (upstream-owned). getConfig() = source of truth.
  store.config.ts        build-time shop overrides, deep-merged on top
  styles/overrides.css   post-theme override layer (normally empty; theme tokens live in themes/<theme>/tokens.css)
  middleware.ts          admin auth gate (fail-closed)
  env.d.ts               Cloudflare.Env binding/secret types
  layouts/               Layout.astro (storefront), AdminLayout.astro
  features/
    products/  db · form · image · ProductForm.astro · sort · search · stock · slug
    orders/    db · number · reservations (atomic checkout stock holds)
    payments/  provider (port) · stripe · opennode · lightning-provider · index (factory)
               lightning/  backend (port) · phoenixd · lnbits · index · rate · pending
    shipping/  calculator (zones + ShippingCalculator port)
    storage/   provider (port) · r2 · index (factory)
    email/     provider (port) · resend · cloudflare · index (factory) · orderConfirmation
    auth/      access (CF Access JWT) · session (admin login cookie) · turnstile · Turnstile.astro
    catalog/   serialize · http  (public API shapes for /api/products)
    cart/ categories/ customers/ media/ pages/
  pages/
    index, products/[slug], categories/[slug], pages/[slug], search, cart, checkout
    product/[slug], category/[slug] — 301s to the plural URLs; keep indefinitely
    pay/[publicId] (Lightning invoice page), order/[token] (confirmation)
    admin/ (CRUD UI, login, logout)
    api/ (cart, webhook, admin/*; checkout — form OR JSON {items} → checkout_url;
          products, products/[slug] — public machine-readable catalog)
    images/[...key] (serves R2), sitemap.xml, robots.txt
```

**Ports & adapters (the seams).** Routes depend on interfaces, never on a vendor.
To swap/add a provider, write one adapter file + wire the factory:

| Port | Where | Factory | Adapters |
|---|---|---|---|
| `PaymentProvider` | `payments/provider.ts` | `payments/index.ts` | stripe, opennode, lightning |
| `LightningBackend` | `payments/lightning/backend.ts` | `payments/lightning/index.ts` | phoenixd, lnbits |
| `ShippingCalculator` | `shipping/calculator.ts` | (config-rates) | carrier rates (future) |
| `StorageProvider` | `storage/provider.ts` | `storage/index.ts` | r2 |
| `EmailProvider` | `email/provider.ts` | `email/index.ts` | resend, cloudflare |
| `SearchProvider` | `search/provider.ts` | `search/index.ts` | fts, vector (Workers AI + Vectorize) |

**Bindings.** Access Cloudflare bindings via `import { env } from 'cloudflare:workers'`
(typed by `Cloudflare.Env` in `env.d.ts`). Never `Astro.locals.runtime.env`
(removed in Astro v6). D1 = `env.DB`, R2 = `env.BUCKET`.

## Invariants — do not break these

1. **Storefront is near-zero client JS.** Server-render everything; progressive
   enhancement only. A little JS is allowed where it earns it (cart drawer,
   /pay polling, Turnstile) — never required for the page to work.
2. **Orders are paid-only.** The `orders` table holds settled orders. In-flight
   Lightning invoices live in `pending_payments` until settled — never write an
   unpaid order.
3. **Config has two layers.** Operational settings live in the D1 settings table
   and are managed through the admin. Data-coupled defaults live in `config.ts`
   and are overridden by clones in `store.config.ts`. Read effective values
   through the existing settings/config helpers. Currency remains build-time
   and store-wide.
4. **Provider-agnostic core.** `checkout.ts` / `webhook.ts` / shipping never
   import a vendor SDK directly — only the ports. Vendor code stays in adapters.
5. **Admin is fail-closed.** In production, if nothing is configured the admin is
   blocked. Don't add an open admin path. Don't make `/admin` a "secret" path
   (security-through-obscurity) — the auth gate is the protection.
6. **Migrations are additive.** Numbered files in `migrations/`, `CREATE TABLE IF
   NOT EXISTS` / `ALTER TABLE ADD COLUMN`. Never edit an applied migration; never
   `DROP` destructively.
7. **Money is integer minor units** (cents) end to end; format only at the edge
   via `formatPrice()`. Use `toMajorUnits()` / `minorUnitsPerMajor()` for
   currency math (handles JPY/BHD, not just 2-decimal).
8. **Tests stay pure.** A `*.test.ts` must NOT import `cloudflare:workers` (vitest
   can't load it). Keep DB/env logic out of unit-tested modules — pass `db` and
   secrets as params (see `lightning/rate.ts`, `auth/session.ts`).
9. **Public routes are plural for browsable collections** — `/products/<slug>`,
   `/categories/<slug>` — matching the admin (`/admin/products`), the JSON API
   (`/api/products/<slug>`), and the feature directories. Token-addressed single
   resources stay singular: `/order/<token>`, `/pay/<publicId>`. Retiring a
   public URL means leaving a 301 stub behind permanently; these paths appear in
   sitemaps, `llms.txt`, and search indexes on stores you don't control.

10. **Media is the only owner of stored files.** Products, pages, and the logo
    record USAGE by `image_key`; removing an image from any of them deletes the
    association only. Only `/api/admin/media/:id` deletes an R2 object, and it
    refuses while anything still references the row. Deletion and every
    association write are guarded in a single SQL statement so the two cannot
    race; never re-introduce a check-then-write.
11. **Page bodies are Markdown with `html: false`.** Raw HTML is escaped, not
    parsed, so a page body can never inject script — including from a
    compromised admin session. The storefront and the admin preview call the
    SAME server-side `renderMarkdown()`; do not add a client-side parser.

## Recipes — how to add X

- **A product field:** new migration (`ALTER TABLE products ADD COLUMN …`) →
  update `Product`/`AdminProduct` + queries in `features/products/db.ts` → add to
  `ProductForm.astro` + `parseProductForm` in `features/products/form.ts`.
- **A content page:** nothing to add — merchants create them at `/admin/pages`.
  Published pages appear at `/pages/<slug>`, in the footer, sitemap, and
  `llms.txt` automatically.
- **A page layout preset:** add ONE entry to `PAGE_LAYOUTS` in
  `features/pages/layouts.ts`. The editor dropdown, validation, the storefront,
  and the admin preview all derive from it, and `measure`/`titleAlign` are
  emitted as CSS custom properties, so no stylesheet edit is needed. A preset
  that needs more than those two axes can also target
  `[data-page-layout="<key>"]` in `global.css`. Unknown/removed presets fall
  back to `standard` at render time, so old rows never break.
- **A config setting:** build-time → add to the `SiteConfig` interface AND
  `defaultConfig()` in `config.ts`; read via `getConfig()`; document the override
  in `store.config.example.ts` (per-env overrides can read an env var, see
  `TIME_ZONE`). Runtime (dashboard) → add a `SettingKey` + `StoreSettings` field in
  `features/settings/db.ts` and a form in `/admin/settings`.
- **A payment provider:** implement `PaymentProvider` in a new
  `features/payments/<name>.ts`; add a case to `getPaymentProvider()` in
  `payments/index.ts`; add its key as a `SecretName` in `features/secrets/store.ts`
  (stored encrypted in D1 via the admin vault — provider keys are NOT env vars) and
  a `SecretField` in the settings Payments card.
- **A Lightning backend:** implement `LightningBackend` in
  `features/payments/lightning/<name>.ts`; add a case to `getLightningBackend()`.
- **A shipping zone/rate:** edit `shipping.zones` in `config.ts` default (or
  `store.config.ts`). Pure logic lives in `shipping/calculator.ts` — unit-test it.
- **A migration:** `npx wrangler d1 migrations create minshop-db <name>` → edit →
  `npm run db:migrate` (local) → `npm run db:migrate:remote` (prod, before deploy).
- **An admin page:** `src/pages/admin/<x>.astro` using `AdminLayout` (add a nav
  entry there). Mutations go through `/api/admin/*` (covered by the auth gate).
- **A storefront feature behind a flag:** `config.features.<x>` toggle; gate the
  nav link in `Layout.astro` and the route.
- **Customer auth:** `features/auth/customer.ts` is the magic-link adapter (no
  passwords) — reuses `token.ts` (signed HMAC) + the `EmailProvider`. Pages live
  under `pages/account/`. Swap to OAuth by replacing that module. Orders are keyed
  by email, so "my orders" = `listOrdersByEmail` (no per-user join needed).
- **A search backend:** implement `SearchProvider` in `features/search/<name>.ts`;
  add a branch to `getSearchProvider()`. Semantic (`vector`) keeps the index in
  sync via `indexProduct`/`unindexProduct` called from the admin product routes.

## Gotchas — preflight checklist

These cost afternoons. Most are in the README "Gotchas" section too.

- **Node ≥ 22.12** (`nvm use 22`). Use Node 22 (the tested/supported release line).
- **Bare `<` / `<=` in an Astro `{expression}`** parses as a tag open → a
  misleading "Unable to assign attributes when using <> Fragment shorthand"
  error. Fix: flip operands (`0 >= x`), use `!==`, or compute the boolean in
  frontmatter. (`>` is fine; only `<` bites.)
- **No `main`/`assets` in `wrangler.jsonc`** — the adapter supplies the worker
  entry; setting `main` breaks a clean build.
- **CSRF on POST:** Astro rejects cross-origin form POSTs (403). Browsers send
  `Origin` automatically; `curl` needs `-H "Origin: http://localhost:4321"` +
  `-H "Content-Type: application/x-www-form-urlencoded"`.
- **Admin auth only enforces in production mode.** `astro dev` bypasses the gate
  (so you can't lock yourself out). Test login/middleware with `npm run preview`
  (wrangler dev). On a fresh store the password is set via the `/admin/setup`
  wizard (hashed in D1) — there is no `ADMIN_PASSWORD` env var; until one is set,
  `/admin/setup` is open (bootstrap), then the gate locks.
- **Lightning settlement = re-poll the node.** The webhook is an untrusted nudge;
  authority is `backend.getIncoming()`. Don't trust a webhook to mark paid.
- **Webhooks need `constructEventAsync`** (Stripe) — the sync verifier uses Node
  crypto, absent on Workers. Web Crypto everywhere (see `auth/access.ts`).
- **FTS5 `MATCH` throws on raw input** — sanitize to alphanumeric prefix tokens
  (`features/products/search.ts`).
- **`wrangler d1 export` fails with FTS5 virtual tables** — drop `products_fts`,
  export, recreate (re-run migration `0003`).
- **The `mcp/` Worker has its OWN `package.json` + `node_modules`.** Never add
  `agents` / `@modelcontextprotocol/sdk` to the ROOT package.json — the Agents SDK
  pulls in workerd/miniflare deps that silently break the storefront's Astro build
  ("require_dist is not a function" in the CF Vite plugin). Install MCP deps in
  `mcp/` only. Build it independently with `npm run mcp:check` (`npm run verify`
  also includes it).

## Conventions

- Comments explain *why*, match surrounding density. No attribution in commits.
- Colocate tests: `foo.ts` + `foo.test.ts`. Test pure logic; integration (D1/R2)
  is verified against `wrangler dev`.
- Don't install npm packages without asking. Don't run deploy/publish commands
  unless explicitly told.
- After non-trivial UI changes, screenshot to verify (see README → Frontend
  Testing). Screenshots to `/tmp`, deleted after.
