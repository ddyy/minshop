import { getViteConfig } from 'astro/config';

// Astro-aware but config-file-free. `getViteConfig` is what compiles `.astro`
// components, so storefront presentation contracts can be rendered through
// AstroContainer instead of only through a built Worker. `configFile: false`
// keeps astro.config.mjs — and with it the Cloudflare adapter and its bindings —
// out of the unit suite, which is what the previous standalone `defineConfig`
// was protecting. Pure-function tests still run in plain Node.
export default getViteConfig(
  {
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts', 'test/storefront/**/*.test.ts'],
      alias: {
        // Lets pure-function modules that merely read deployment vars at import
        // time (config.ts, and the email templates through it) be unit-tested.
        // Real bindings stay out of scope — see the stub's own note.
        'cloudflare:workers': new URL('./test/helpers/cloudflare-workers-stub.ts', import.meta.url).pathname,
      },
    },
  },
  { configFile: false },
);
