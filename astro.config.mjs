import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';
import { resolveStorefrontSet } from './scripts/storefront-set.mjs';
import { setCssPath, writeStorefrontArtifacts } from './scripts/storefront-css.mjs';

// SSR on Cloudflare Workers. platformProxy lets `astro dev` read bindings
// (D1, R2, vars) from wrangler.jsonc locally.
// Tailwind v4 is wired via its Vite plugin (the old @astrojs/tailwind
// integration is deprecated).

// Which storefront set this build compiles. Resolved once, here, and shared
// with Tailwind through the #storefront-css alias below — the template alias
// and the CSS scope must never disagree, or the build succeeds while shipping
// an unstyled or wrongly styled site. The generated files are written for ALL
// sets and are byte-identical no matter which set this process selected, so a
// concurrent build for another set cannot fight a running dev server over
// them (see the design rule in scripts/storefront-css.mjs).
const storefront = resolveStorefrontSet();
writeStorefrontArtifacts();

export default defineConfig({
  output: 'server',
  // Replaced by the equivalent middleware guard so the bearer-capability
  // /pay/otk_… form can support clients that omit Origin without weakening
  // cookie-authenticated Admin/account forms.
  security: { checkOrigin: false },
  adapter: cloudflare({
    // Keep Cloudflare Images opt-in. The adapter otherwise auto-provisions an
    // IMAGES binding even though minshop stores and serves originals from R2.
    imageService: 'passthrough',
    platformProxy: { enabled: true },
  }),
  vite: {
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        '#storefront': storefront.dir,
        // The per-set stylesheet this process compiles. Selection by alias is
        // the point: the files on disk never change per process, only which
        // one global.css's @import resolves to. Tailwind v4's plugin follows
        // Vite aliases in CSS @import (probed before relying on it).
        '#storefront-css': setCssPath(storefront.id),
      },
    },
  },
});
