#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { signDeployPurgeAuthorization } from '../src/features/cache/deployPurgeAuth.ts';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build');
const preflightOnly = args.includes('--preflight-only');
const generatedConfigPath = resolve(root, 'dist/server/wrangler.json');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function parseDevVars(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const [, name, raw] = match;
    const quoted =
      raw.length >= 2 &&
      ((raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'")));
    values[name] = quoted ? raw.slice(1, -1) : raw;
  }
  return values;
}

function deploySecret() {
  const devVars = parseDevVars(resolve(root, '.dev.vars'));
  return process.env.CACHE_PURGE_SECRET ||
    devVars.CACHE_PURGE_SECRET ||
    process.env.AUTH_SECRET ||
    devVars.AUTH_SECRET ||
    '';
}

function deploymentCacheConfig() {
  if (!existsSync(generatedConfigPath)) {
    throw new Error(
      'Missing dist/server/wrangler.json. Run a build or omit --skip-build.',
    );
  }
  const config = JSON.parse(readFileSync(generatedConfigPath, 'utf8'));
  const crossVersion = config.cache?.enabled === true &&
    config.cache?.cross_version_cache === true;
  if (!crossVersion) return { crossVersion: false };

  const origin = config.vars?.CANONICAL_ORIGIN;
  if (
    typeof origin !== 'string' ||
    !origin.startsWith('https://') ||
    new URL(origin).origin !== origin
  ) {
    throw new Error(
      'cross_version_cache requires CANONICAL_ORIGIN to be one exact HTTPS origin.',
    );
  }
  if (config.workers_dev !== false) {
    throw new Error('cross_version_cache requires workers_dev: false.');
  }
  const secret = deploySecret();
  if (!secret) {
    throw new Error(
      'cross_version_cache requires CACHE_PURGE_SECRET (or legacy AUTH_SECRET) in the deploy environment or .dev.vars.',
    );
  }
  return { crossVersion: true, origin, secret };
}

const wait = (milliseconds) =>
  new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

async function purgeAfterDeploy(origin, secret) {
  const delays = [0, 1_000, 2_000, 4_000];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) await wait(delays[attempt]);
    const authorization = await signDeployPurgeAuthorization(
      secret,
      Date.now() / 1000,
    );
    try {
      const response = await fetch(`${origin}/api/internal/cache-purge`, {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      if (response.ok) {
        console.log('✓ Cross-version Worker cache purged.');
        return;
      }
      console.error(
        `Cache purge attempt ${attempt + 1}/${delays.length} returned HTTP ${response.status}.`,
      );
    } catch (error) {
      console.error(
        `Cache purge attempt ${attempt + 1}/${delays.length} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  throw new Error(
    [
      'The new Worker version is live, but its cross-version cache could not be purged.',
      'Retry this deploy first. If purging still fails, set cache.cross_version_cache',
      'to false and deploy again so the Worker returns to a cold version-keyed cache.',
    ].join(' '),
  );
}

if (!preflightOnly) {
  run('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote']);
}
if (!skipBuild) run('npx', ['astro', 'build']);

let cacheConfig;
try {
  cacheConfig = deploymentCacheConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (preflightOnly) {
  console.log(
    cacheConfig.crossVersion
      ? '✓ Cross-version cache deployment preflight passed.'
      : '✓ Deployment preflight passed; cross-version caching is disabled.',
  );
  process.exit(0);
}

run('npx', ['wrangler', 'deploy']);

if (cacheConfig.crossVersion) {
  try {
    await purgeAfterDeploy(cacheConfig.origin, cacheConfig.secret);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
