import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';
import { resolveStorefrontSet } from './scripts/storefront-set.mjs';
import {
  writeActiveStorefrontCss,
  writeActiveStorefrontTsconfig,
} from './scripts/storefront-css.mjs';

// SSR on Cloudflare Workers. platformProxy lets `astro dev` read bindings
// (D1, R2, vars) from wrangler.jsonc locally.
// Tailwind v4 is wired via its Vite plugin (the old @astrojs/tailwind
// integration is deprecated).

// Which storefront set this build compiles. Resolved once, here, and shared
// with Tailwind through a generated stylesheet — the alias and the CSS scope
// must never disagree, or the build succeeds while shipping an unstyled or
// wrongly styled site.
const storefront = resolveStorefrontSet();
writeActiveStorefrontCss(storefront.id);
writeActiveStorefrontTsconfig(storefront.id);

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
      alias: { '#storefront': storefront.dir },
    },
  },
});
