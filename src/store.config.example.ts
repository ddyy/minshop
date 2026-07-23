import type { DeepPartial, SiteConfig } from './config';

/**
 * Copy this file to `store.config.ts` and edit it — that's the only config file
 * you touch. Its values are deep-merged on top of the defaults in `config.ts`,
 * so list ONLY what you change; anything omitted keeps its default. Arrays
 * (shipping rates, allowed countries) replace wholesale.
 *
 * Store identity, feature switches, integrations, and provider credentials are
 * configured at runtime in Admin → Settings and do not belong in this file.
 */
export const storeOverrides: DeepPartial<SiteConfig> = {
  // currency: 'usd',                // ISO 4217, lowercase
  //
  // features: { blog: false, reviews: false },
  //
  // images: { maxWidth: 1000 },      // optimization on/off lives in Admin
  //
  // orderNumber: { offset: 1000, step: 1, randomStep: 0 },
  //
  // shipping: {
  //   // Shipping on/off lives in Admin; zones and rates remain build-time.
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
};
