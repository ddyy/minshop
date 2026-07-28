import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';

// SSR on Cloudflare Workers. platformProxy lets `astro dev` read bindings
// (D1, R2, vars) from wrangler.jsonc locally.
// Tailwind v4 is wired via its Vite plugin (the old @astrojs/tailwind
// integration is deprecated).
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
  },
});
