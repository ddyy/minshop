/// <reference types="vitest/config" />
import { getViteConfig } from 'astro/config';
import { resolveTheme } from './scripts/themes.mjs';
import { themeCssPath, writeThemeArtifacts } from './scripts/theme-css.mjs';

// Astro-aware but config-file-free. `getViteConfig` is what compiles `.astro`
// components, so storefront presentation contracts can be rendered through
// AstroContainer instead of only through a built Worker. `configFile: false`
// keeps astro.config.mjs — and with it the Cloudflare adapter and its bindings —
// out of the unit suite, which is what the previous standalone `defineConfig`
// was protecting. Pure-function tests still run in plain Node.
//
// Because astro.config.mjs is skipped, the #theme alias it declares does
// NOT exist here. It has to be resolved again from the same helper, or the
// contract suite would test whichever set happens to be first on disk instead
// of the selected one. Run one set per process (THEME=<id> vitest run):
// looping ids inside a single run re-uses the module cache and silently
// re-tests the first.
// Generate the per-set artifacts before resolving: the root tsconfig extends
// generated tsconfig.theme.json, so on a fresh checkout the documented
// standalone commands (test:storefront-contract, test:watch) would otherwise
// die collecting tests with "Tsconfig not found". Safe to run from any number
// of concurrent processes — writes are deterministic and idempotent (see the
// design rule in scripts/theme-css.mjs).
writeThemeArtifacts();
const theme = resolveTheme();

export default getViteConfig(
  {
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts', 'test/storefront/**/*.test.{ts,mjs}', 'test/scripts/**/*.test.mjs'],
      alias: {
        '#theme': theme.dir,
        // Mirrors astro.config.mjs: if a test ever renders something that
        // pulls global.css, the CSS import resolves to the same per-set file.
        '#theme-css': themeCssPath(theme.id),
        // Lets pure-function modules that merely read deployment vars at import
        // time (config.ts, and the email templates through it) be unit-tested.
        // Real bindings stay out of scope — see the stub's own note.
        'cloudflare:workers': new URL('./test/helpers/cloudflare-workers-stub.ts', import.meta.url).pathname,
      },
    },
  },
  { configFile: false },
);
