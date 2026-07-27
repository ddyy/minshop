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
  // Shipping (zones, rates, weight bands, free-over thresholds) is managed in
  // Admin → Shipping. The block that used to live here is only the default for a
  // brand-new store; editing it after the first Admin save has no effect.
};
