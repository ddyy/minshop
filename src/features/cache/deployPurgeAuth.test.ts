import { describe, expect, it } from 'vitest';
import {
  DEPLOY_PURGE_WINDOW_SECONDS,
  signDeployPurgeAuthorization,
  verifyDeployPurgeAuthorization,
} from './deployPurgeAuth';

const SECRET = 'deployment-secret-with-enough-entropy';
const NOW = 1_785_267_000;

describe('deploy cache purge authentication', () => {
  it('accepts a fresh signature', async () => {
    const authorization = await signDeployPurgeAuthorization(SECRET, NOW);
    await expect(
      verifyDeployPurgeAuthorization(authorization, SECRET, NOW + 1),
    ).resolves.toBe(true);
  });

  it('rejects a signature made with another secret', async () => {
    const authorization = await signDeployPurgeAuthorization('another-secret', NOW);
    await expect(
      verifyDeployPurgeAuthorization(authorization, SECRET, NOW),
    ).resolves.toBe(false);
  });

  it('rejects stale and far-future signatures', async () => {
    const stale = await signDeployPurgeAuthorization(
      SECRET,
      NOW - DEPLOY_PURGE_WINDOW_SECONDS - 1,
    );
    const future = await signDeployPurgeAuthorization(
      SECRET,
      NOW + DEPLOY_PURGE_WINDOW_SECONDS + 1,
    );
    await expect(verifyDeployPurgeAuthorization(stale, SECRET, NOW)).resolves.toBe(false);
    await expect(verifyDeployPurgeAuthorization(future, SECRET, NOW)).resolves.toBe(false);
  });

  it.each([
    null,
    '',
    'Bearer token',
    'MinshopDeploy 123.signature',
    `MinshopDeploy ${NOW}.${'g'.repeat(64)}`,
    `MinshopDeploy ${NOW}.${'0'.repeat(63)}`,
  ])('rejects malformed authorization %j', async (authorization) => {
    await expect(
      verifyDeployPurgeAuthorization(authorization, SECRET, NOW),
    ).resolves.toBe(false);
  });
});
