#!/usr/bin/env node
/**
 * Per-theme verification: sync, contract suite, type check, build — for the theme
 * this process resolves (usually `THEME=<id> npm run verify:theme`).
 *
 * A script rather than an npm `&&` chain for one reason: `astro check` must be
 * told which theme to type-check. Its default tsconfig follows
 * theme.config.json — deliberately, so an env-selected process never
 * rewrites the shared file (see scripts/theme-css.mjs) — which means the
 * env-selected check has to pass its per-theme tsconfig explicitly, and npm
 * scripts cannot interpolate the resolved id portably.
 *
 * Deliberately narrower than `npm run verify`: what it omits (integration,
 * MCP, scaffold, Stripe country data) is theme-independent, and re-running it
 * per theme would triple the bill to re-prove the same thing.
 */
import { spawnSync } from 'node:child_process';
import { relative } from 'node:path';
import { resolveTheme } from './themes.mjs';
import { themeTsconfigPath, writeThemeArtifacts } from './theme-css.mjs';

writeThemeArtifacts();
const { id, source } = resolveTheme();
const tsconfig = relative(process.cwd(), themeTsconfigPath(id));
console.log(`verify:theme — ${id} (from ${source})`);

const steps = [
  ['npx', ['vitest', 'run', 'test/storefront']],
  ['npx', ['astro', 'check', '--tsconfig', tsconfig]],
  ['npx', ['astro', 'build']],
  ['node', ['scripts/check-built-css.mjs']],
];

for (const [cmd, args] of steps) {
  const { status } = spawnSync(cmd, args, { stdio: 'inherit' });
  if (status !== 0) process.exit(status ?? 1);
}
