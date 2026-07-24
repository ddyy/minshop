import { env } from 'cloudflare:workers';
import { storeOverrides } from './store.config';
import type { ShippingConfig } from './features/shipping/calculator';

/**
 * Site-wide settings SCHEMA + DEFAULTS. This file is upstream-owned: to change
 * settings for your store, edit `store.config.ts` (its values are merged on top
 * of the defaults below) — that way pulling template updates never conflicts
 * with your config. A small set of operator-facing values additionally has a D1
 * runtime overlay; see features/settings/db.ts.
 *
 * - storeName: also overridable per-environment via the STORE_NAME var (wrangler.jsonc)
 * - currency:  store-wide currency code; drives formatPrice(), new-product
 *              default, and checkout.
 * - favicon:   replace the file at public/favicon.svg (not configured here).
 */
export interface SiteConfig {
  storeName: string;
  currency: string;
  /**
   * IANA time zone (e.g. 'America/Los_Angeles', 'Europe/London', 'UTC') used to
   * display stored timestamps in the admin. Dates are stored as UTC; this only
   * changes how they're formatted for the store owner. The first-run wizard
   * detects the admin browser's zone and stores a runtime override in D1;
   * TIME_ZONE remains the deployment-level fallback.
   */
  timeZone: string;
  features: {
    blog: boolean;
    reviews: boolean;
    /**
     * Customer accounts (passwordless magic-link login + /account order history).
     * Off by default. When on, needs the AUTH_SECRET secret (signs the login token
     * + session cookie) AND email configured (to send the link). See README → Accounts.
     */
    accounts: boolean;
  };
  /**
   * Downscale + recompress uploaded product images to WebP on upload via the
   * Cloudflare Images binding. OFF by default. Free up to 5,000 transforms/mo
   * (one per uploaded image), then usage-billed — separate from the Workers plan,
   * works on Workers Free. Transforms in local dev too (miniflare's offline binding
   * handles width + format; verified). On = smaller images served from R2.
   */
  images: {
    optimizeOnUpload: boolean;
    maxWidth: number;
    /** Absolute base to serve product images from (e.g. an R2 custom domain like
     *  https://images.example.com) so they bypass the Worker's /images route, or
     *  '' to serve via that route. Set with the IMAGE_BASE_URL var. No trailing slash. */
    baseUrl: string;
  };
  /**
   * Customer-facing order number, derived from the internal id (the id stays the
   * key; this is just the friendly receipt number). `offset` sets the start;
   * `step` spaces consecutive orders; `randomStep` adds a deterministic per-order
   * jitter in [0, randomStep] so the number doesn't read as a raw count. Keep
   * step > randomStep so numbers stay unique. Security is the random public_id.
   */
  orderNumber: {
    offset: number;
    step: number;
    randomStep: number;
  };
  /**
   * Shipping. Provider-agnostic destination ZONES of flat rates (see
   * features/shipping/calculator) — the same engine feeds Stripe Checkout's
   * options AND the own-checkout total used by Lightning, so every rail charges
   * the same shipping. A zone matches by country ('*' = catch-all); `freeOverCents`
   * adds a $0 option once the subtotal qualifies. Note: Stripe Checkout shows a
   * STATIC option list (no address yet), so it uses the first zone's rates;
   * zone-accurate shipping applies on the own-checkout (Lightning) path.
   */
  shipping: ShippingConfig;
  /**
   * Discount codes. When enabled, hosted checkout shows a promo-code field. The
   * codes themselves are created + managed in the Stripe Dashboard
   * (Products → Coupons → Promotion codes); the applied discount lands on the order.
   */
  discounts: {
    enabled: boolean;
  };
  /**
   * Sales tax / VAT via Stripe Tax. OFF by default — you must first ACTIVATE
   * Stripe Tax in the Dashboard (set origin address + registrations); enabling
   * this without that setup makes Stripe reject the checkout session. When on,
   * tax is computed from the customer's address and captured on the order.
   */
  tax: {
    enabled: boolean;
  };
  /**
   * Cloudflare Turnstile bot protection on admin login + customer sign-in. OFF by default,
   * configured in Admin → Settings → Bot protection (enabled + sitekey in D1, the
   * secret in the vault). The value here is just the build-time default.
   */
  turnstile: {
    enabled: boolean;
  };
  /**
   * Product search backend (features/search). 'fts' (default) = SQLite FTS5
   * keyword search — $0, fully local, exact/typo-tolerant. 'vector' = SEMANTIC
   * search via Workers AI embeddings + Vectorize (meaning-based; needs the AI +
   * VECTORIZE bindings and a created index — see README → Search). Overridable via
   * the SEARCH_PROVIDER var. `embeddingModel` must match the index's dimensions
   * (bge-base-en-v1.5 = 768). `topK` caps semantic results.
   */
  search: {
    provider: 'fts' | 'vector';
    embeddingModel: string;
    topK: number;
  };
  /**
   * Payment method. The checkout + webhook routes depend on the PaymentProvider
   * port (features/payments), so this just selects which adapter is active:
   * - 'stripe'    — hosted card checkout (default).
   * - 'lightning' — Bitcoin Lightning via a self-hosted node (phoenixd / LNbits);
   *                 minshop mints a BOLT11 invoice and renders its own /pay page.
   * - 'opennode'  — hosted Lightning checkout (OpenNode; custodial processor).
   * Overridable per-environment via the PAYMENT_PROVIDER var (wrangler.jsonc).
   * NOTE: the Lightning flows are total-of-line-items only — shipping address,
   * Stripe Tax, and promo codes are Stripe-Checkout features and are skipped.
   */
  payments: {
    provider: 'stripe' | 'lightning' | 'opennode';
    lightning: {
      /** Which self-hosted node mints invoices when provider is 'lightning'. */
      backend: 'phoenixd' | 'lnbits';
      /** Minutes a Lightning invoice (and its /pay page) stays valid. */
      invoiceExpiryMinutes: number;
      /**
       * BTC spot-price source for fiat→sats conversion (Lightning invoices are
       * denominated in sats). `{currency}` is substituted with the store currency.
       * Default is Coinbase spot — no API key, supports the major fiat currencies.
       */
      rateUrl: string;
    };
  };
  /**
   * Order-confirmation / login email — configured at runtime in Admin → Settings →
   * Email (enabled, provider, from-address all live in D1; the Resend key in the
   * vault). The values here are only build-time DEFAULTS, overlaid by those D1
   * settings. Unconfigured = no-op, so checkout still succeeds.
   * - 'resend': plain HTTPS API, Workers FREE plan. `from` must be on a
   *   Resend-verified domain (or onboarding@resend.dev to test to your own address).
   * - 'cloudflare': the `EMAIL` send binding — needs Workers PAID plan + a domain
   *   onboarded via `wrangler email sending enable <domain>`.
   */
  email: {
    enabled: boolean;
    provider: 'resend' | 'cloudflare';
    from: string;
    fromName: string;
    /** Store-owner address for a "new order" notification ('' = don't notify). */
    notifyTo: string;
  };
}

/**
 * A recursive Partial used by `store.config.ts` — override only the keys you
 * change. Arrays (shipping rates, countries) are replaced wholesale, not merged
 * element-by-element.
 */
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Deep-merge `override` onto `base`: nested objects recurse, arrays/primitives
 * replace, and `undefined` is ignored (so an omitted key keeps its default).
 */
function deepMerge<T>(base: T, override: DeepPartial<T>): T {
  if (!isPlainObject(base) || !isPlainObject(override)) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue;
    const b = (base as Record<string, unknown>)[k];
    out[k] = isPlainObject(b) && isPlainObject(v) ? deepMerge(b, v as DeepPartial<typeof b>) : v;
  }
  return out as T;
}

/** Upstream defaults. Don't edit these per-store — override in `store.config.ts`. */
function defaultConfig(): SiteConfig {
  return {
    storeName: env.STORE_NAME ?? 'My Shop',
    currency: 'usd', // store-wide currency (ISO 4217, lowercase)
    timeZone: env.TIME_ZONE ?? 'UTC', // setup/admin settings can override this at runtime
    features: {
      blog: false,
      reviews: false,
      accounts: false, // magic-link customer login; needs AUTH_SECRET + email
    },
    images: {
      optimizeOnUpload: false, // set true after enabling Transformations (free ≤5k/mo)
      maxWidth: 1000,
      baseUrl: (env.IMAGE_BASE_URL ?? '').replace(/\/+$/, ''),
    },
    orderNumber: {
      offset: 1000, // first order shows as #1000
      step: 1, // 1 = sequential; raise to spread numbers out
      randomStep: 0, // 0 = none; up to (step - 1) to jitter and obscure the count
    },
    shipping: {
      enabled: true,
      zones: [
        {
          countries: ['US'],
          rates: [
            { label: 'Standard', amountCents: 500 },
            { label: 'Express', amountCents: 1500 },
          ],
          freeOverCents: 5000, // free shipping at $50+ (null to disable)
        },
        // Add more zones as needed, e.g. an international catch-all (matched last):
        // { countries: ['*'], rates: [{ label: 'International', amountCents: 3000 }], freeOverCents: null },
      ],
    },
    discounts: {
      enabled: true, // show the promo-code field; create codes in the Stripe Dashboard
    },
    tax: {
      enabled: false, // true ONLY after activating Stripe Tax in the Dashboard
    },
    turnstile: {
      // Build-time default; Admin → Settings → Bot protection overlays this at
      // runtime (turnstile_enabled in D1, with the sitekey + secret).
      enabled: false,
    },
    search: {
      // 'fts' (default, $0/local) | 'vector' (semantic — needs AI + VECTORIZE).
      provider: (env.SEARCH_PROVIDER as SiteConfig['search']['provider']) ?? 'fts',
      embeddingModel: '@cf/baai/bge-base-en-v1.5', // 768 dims — match the Vectorize index
      topK: 20,
    },
    payments: {
      // Build-time defaults; Admin → Settings → Payments overlays the rail + node
      // choice at runtime (payment_provider / lightning_backend in D1).
      provider: 'stripe', // 'stripe' (cards) | 'lightning' (self-hosted BTC) | 'opennode'
      lightning: {
        backend: 'phoenixd', // 'phoenixd' | 'lnbits'
        invoiceExpiryMinutes: 15,
        rateUrl: 'https://api.coinbase.com/v2/prices/BTC-{currency}/spot',
      },
    },
    email: {
      // Defaults; Admin → Settings → Email overlays enabled/provider/from at runtime.
      enabled: true, // sends once a provider key is configured (else no-op)
      provider: 'resend', // 'resend' (free-plan friendly) | 'cloudflare' (paid plan)
      from: 'onboarding@resend.dev', // Resend test sender; set a verified domain in admin for real customers
      fromName: env.STORE_NAME ?? 'My Shop',
      notifyTo: '', // owner "new order" notification — set yours in store.config.ts ('' = off)
    },
  };
}

/**
 * Effective config: upstream defaults with your `store.config.ts` overrides
 * merged on top. Read everywhere via getConfig() — the single source of truth.
 */
export function getConfig(): SiteConfig {
  return deepMerge<SiteConfig>(defaultConfig(), storeOverrides);
}

// Currency scaling lives in the dependency-free ./money module (so unit-tested
// code can use it without the Cloudflare runtime). Re-exported here as the app's
// single money entry point.
export { currencyDecimals, minorUnitsPerMajor, toMinorUnits, toMajorUnits } from './money';
import { toMajorUnits } from './money';

/**
 * Format integer minor units as a localized price string. Defaults to the store
 * currency; pass an explicit currency for historical records (e.g. an order
 * charged in a different currency). Single source of truth for money display.
 */
export function formatPrice(cents: number, currency: string = getConfig().currency): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(toMajorUnits(cents, currency));
}

/**
 * Format a stored UTC timestamp in the configured time zone. Accepts SQLite's
 * `datetime('now')` format ("YYYY-MM-DD HH:MM:SS", UTC) or any ISO string;
 * returns '' for null/empty and the raw input if it can't be parsed. Single
 * source of truth for date display in the admin.
 */
export function formatDate(
  value: string | null | undefined,
  opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
  timeZone: string = getConfig().timeZone,
): string {
  if (!value) return '';
  // SQLite stores UTC without a zone marker; make it explicit so it isn't parsed
  // as local time. (Our timestamps never contain 'T' or 'Z'.)
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return value;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, ...opts }).format(d);
  } catch {
    // A bad deployment override should never break an order/admin page.
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }).format(d);
  }
}
