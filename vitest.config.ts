import { defineConfig } from 'vitest/config';

// Standalone config (does NOT load astro.config.mjs / the Cloudflare plugin) so
// pure-function unit tests run in plain Node without pulling in `cloudflare:workers`.
// Functions that need bindings (D1/R2) aren't covered here — those are integration
// concerns, verified against `wrangler dev`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    alias: {
      // Lets pure-function modules that merely read deployment vars at import
      // time (config.ts, and the email templates through it) be unit-tested.
      // Real bindings stay out of scope — see the stub's own note.
      'cloudflare:workers': new URL('./test/helpers/cloudflare-workers-stub.ts', import.meta.url).pathname,
    },
  },
});
