import type { DeepPartial, SiteConfig } from './config';

/**
 * YOUR store's settings — the one config file you edit. List ONLY what you
 * change; everything else inherits the defaults in `config.ts`. These values
 * are deep-merged on top of those defaults (arrays replace wholesale).
 *
 * Upstream (the template) never edits this file, so pulling template updates
 * won't conflict with your settings. See `store.config.example.ts` for the full
 * set of overridable keys. Common overrides:
 *
 *   features: { accounts: true },          // passwordless customer accounts
 *   email:    { notifyTo: 'you@…' },       // owner "new order" notification
 *   images:   { optimizeOnUpload: true },  // WebP-downscale uploads (needs the
 *                                          // IMAGES binding + Transformations)
 */
export const storeOverrides: DeepPartial<SiteConfig> = {};
