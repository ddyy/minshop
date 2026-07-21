import type { DeepPartial, SiteConfig } from './config';

/**
 * Copy this file to `store.config.ts` and edit it — that's the only config file
 * you touch. Its values are deep-merged on top of the defaults in `config.ts`,
 * so list ONLY what you change; anything omitted keeps its default. Arrays
 * (shipping rates, allowed countries) replace wholesale.
 *
 * Single-value defaults can also be set via wrangler vars (STORE_NAME,
 * TIME_ZONE). The setup wizard stores the effective name/time zone in D1.
 */
export const storeOverrides: DeepPartial<SiteConfig> = {
  // storeName: 'My Shop',           // or set STORE_NAME in wrangler.jsonc
  // currency: 'usd',                // ISO 4217, lowercase
  // timeZone: 'UTC',                // fallback; setup/admin settings override it
  //
  // features: { blog: false, reviews: false, accounts: false },  // accounts = magic-link login (needs AUTH_SECRET + email)
  //
  // images: { optimizeOnUpload: false, maxWidth: 1000 },
  //
  // orderNumber: { offset: 1000, step: 1, randomStep: 0 },
  //
  // shipping: {
  //   enabled: true,
  //   zones: [                        // first zone matching the country wins ('*' last)
  //     {
  //       countries: ['US'],
  //       rates: [
  //         { label: 'Standard', amountCents: 500 },
  //         { label: 'Express', amountCents: 1500 },
  //       ],
  //       freeOverCents: 5000,        // null to disable free shipping
  //     },
  //     { countries: ['*'], rates: [{ label: 'International', amountCents: 3000 }], freeOverCents: null },
  //   ],
  // },
  //
  // discounts: { enabled: true },
  // tax: { enabled: false },        // true only after activating Stripe Tax
  //
  // search: { provider: 'fts' },    // 'fts' (default) | 'vector' (semantic — needs AI + Vectorize, see README → Search)
  //
  // email: {
  //   enabled: true,
  //   provider: 'resend',           // 'resend' (free plan) | 'cloudflare' (paid)
  //   from: 'orders@yourdomain.com',
  //   notifyTo: 'you@yourdomain.com', // '' = no owner notification
  // },
};
