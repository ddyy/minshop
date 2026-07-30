#!/usr/bin/env node
/**
 * Regenerates the files that must agree with the selected storefront set.
 *
 * `astro build` does this through astro.config.mjs, but `astro check` reads
 * tsconfig before that config is evaluated, and a fresh clone has never
 * generated either file. Run this first so type checking and the boundary
 * checker see the same set the build would compile.
 */
import { resolveStorefrontSet } from './storefront-set.mjs';
import { writeActiveStorefrontCss, writeActiveStorefrontTsconfig } from './storefront-css.mjs';

const { id, source } = resolveStorefrontSet();
writeActiveStorefrontCss(id);
writeActiveStorefrontTsconfig(id);
console.log(`storefront set: ${id} (from ${source})`);
