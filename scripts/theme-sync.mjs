#!/usr/bin/env node
/**
 * Regenerates the files that must agree with the themes on disk.
 *
 * `astro build` does this through astro.config.mjs, but `astro check` reads
 * tsconfig before that config is evaluated, and a fresh clone has never
 * generated any of them. Run this first so type checking and the boundary
 * checker see the same artifacts the build would.
 *
 * Writes are deterministic — see the design rule in theme-css.mjs. The
 * THEME variable changes which theme THIS process selects (reported below),
 * never what gets written.
 */
import { resolveTheme } from './themes.mjs';
import { writeThemeArtifacts } from './theme-css.mjs';

const { ids, configured } = writeThemeArtifacts();
const active = resolveTheme();
console.log(
  `themes: ${ids.join(', ')} — active for this process: ${active.id} (from ${active.source})` +
    (active.id === configured.id ? '' : `; editor/shared tsconfig stays on ${configured.id}`),
);
