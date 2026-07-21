import { describe, it, expect } from 'vitest';
import { signSession, verifySession, constantTimeEqual } from './session';

const KEY = 'auth-secret-high-entropy'; // signing key (AUTH_SECRET)
const CRED = 'admin-password'; // bound credential (the password / its hash)
const NOW = 1_700_000_000; // fixed epoch seconds

describe('session sign/verify', () => {
  it('accepts a freshly signed token', async () => {
    const token = await signSession(KEY, CRED, 3600, NOW);
    expect(await verifySession(token, KEY, CRED, NOW + 10)).toBe(true);
  });

  it('rejects a token signed with a different signing key', async () => {
    const token = await signSession(KEY, CRED, 3600, NOW);
    expect(await verifySession(token, 'other-key', CRED, NOW + 10)).toBe(false);
  });

  it('rejects after the bound credential rotates (password change kills sessions)', async () => {
    const token = await signSession(KEY, CRED, 3600, NOW);
    expect(await verifySession(token, KEY, 'new-password', NOW + 10)).toBe(false);
  });

  it('rejects an expired token', async () => {
    const token = await signSession(KEY, CRED, 3600, NOW);
    expect(await verifySession(token, KEY, CRED, NOW + 3601)).toBe(false);
  });

  it('rejects a tampered expiry (signature no longer matches)', async () => {
    const token = await signSession(KEY, CRED, 3600, NOW);
    const [, , tag, sig] = token.split('.');
    const forged = `v1.${NOW + 999_999}.${tag}.${sig}`;
    expect(await verifySession(forged, KEY, CRED, NOW + 10)).toBe(false);
  });

  it('rejects malformed / empty tokens', async () => {
    expect(await verifySession('', KEY, CRED, NOW)).toBe(false);
    expect(await verifySession(null, KEY, CRED, NOW)).toBe(false);
    expect(await verifySession('v1.123', KEY, CRED, NOW)).toBe(false);
    expect(await verifySession('v1.123.abc', KEY, CRED, NOW)).toBe(false); // 3 parts → invalid now
    expect(await verifySession('v2.123.abc.def', KEY, CRED, NOW)).toBe(false);
  });
});

describe('constantTimeEqual', () => {
  it('matches equal strings and rejects others', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});
