#!/usr/bin/env node
/**
 * Regenerates the files that must agree with the storefront sets on disk.
 *
 * `astro build` does this through astro.config.mjs, but `astro check` reads
 * tsconfig before that config is evaluated, and a fresh clone has never
 * generated any of them. Run this first so type checking and the boundary
 * checker see the same artifacts the build would.
 *
 * Writes are deterministic — see the design rule in storefront-css.mjs. The
 * STOREFRONT variable changes which set THIS process selects (reported below),
 * never what gets written.
 */
import { resolveStorefrontSet } from './storefront-set.mjs';
import { writeStorefrontArtifacts } from './storefront-css.mjs';

const { ids, configured } = writeStorefrontArtifacts();
const active = resolveStorefrontSet();
console.log(
  `storefront sets: ${ids.join(', ')} — active for this process: ${active.id} (from ${active.source})` +
    (active.id === configured.id ? '' : `; editor/shared tsconfig stays on ${configured.id}`),
);
