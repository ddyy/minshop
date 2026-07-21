import { describe, it, expect } from 'vitest';
import { signToken, verifyToken } from './token';

const KEY = 'auth-secret';
const NOW = 1_700_000_000;

describe('signToken / verifyToken', () => {
  it('round-trips a payload (incl. an email with . and @)', async () => {
    const token = await signToken('user.name@example.com', KEY, 900, NOW);
    expect(await verifyToken(token, KEY, NOW + 10)).toBe('user.name@example.com');
  });

  it('rejects a wrong key', async () => {
    const token = await signToken('a@b.com', KEY, 900, NOW);
    expect(await verifyToken(token, 'other', NOW + 10)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = await signToken('a@b.com', KEY, 900, NOW);
    expect(await verifyToken(token, KEY, NOW + 901)).toBeNull();
  });

  it('rejects a tampered payload (signature no longer matches)', async () => {
    const token = await signToken('a@b.com', KEY, 900, NOW);
    const [, exp, sig] = token.split('.');
    // swap in a different (valid base64url) payload, keep the old sig
    const forged = `${btoa('evil@x.com').replace(/=+$/, '')}.${exp}.${sig}`;
    expect(await verifyToken(forged, KEY, NOW + 10)).toBeNull();
  });

  it('rejects malformed / empty tokens', async () => {
    expect(await verifyToken('', KEY, NOW)).toBeNull();
    expect(await verifyToken(null, KEY, NOW)).toBeNull();
    expect(await verifyToken('a.b', KEY, NOW)).toBeNull();
  });
});
