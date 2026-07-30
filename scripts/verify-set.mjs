#!/usr/bin/env node
/**
 * Per-set verification: sync, contract suite, type check, build — for the set
 * this process resolves (usually `STOREFRONT=<id> npm run verify:set`).
 *
 * A script rather than an npm `&&` chain for one reason: `astro check` must be
 * told which set to type-check. Its default tsconfig follows
 * storefront.config.json — deliberately, so an env-selected process never
 * rewrites the shared file (see scripts/storefront-css.mjs) — which means the
 * env-selected check has to pass its per-set tsconfig explicitly, and npm
 * scripts cannot interpolate the resolved id portably.
 *
 * Deliberately narrower than `npm run verify`: what it omits (integration,
 * MCP, scaffold, Stripe country data) is set-independent, and re-running it
 * per set would triple the bill to re-prove the same thing.
 */
import { spawnSync } from 'node:child_process';
import { relative } from 'node:path';
import { resolveStorefrontSet } from './storefront-set.mjs';
import { setTsconfigPath, writeStorefrontArtifacts } from './storefront-css.mjs';

writeStorefrontArtifacts();
const { id, source } = resolveStorefrontSet();
const tsconfig = relative(process.cwd(), setTsconfigPath(id));
console.log(`verify:set — ${id} (from ${source})`);

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
