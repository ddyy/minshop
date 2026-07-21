import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from './password';

describe('password hashing (PBKDF2)', () => {
  it('verifies the correct password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const stored = await hashPassword('s3cret');
    expect(await verifyPassword('S3cret', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('uses a random salt (same password → different hashes)', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toBe(b);
    // …but both still verify.
    expect(await verifyPassword('same', a)).toBe(true);
    expect(await verifyPassword('same', b)).toBe(true);
  });

  it('encodes the pbkdf2 format with iteration count', async () => {
    const stored = await hashPassword('x');
    const [scheme, iters, salt, hash] = stored.split('$');
    expect(scheme).toBe('pbkdf2');
    expect(Number(iters)).toBeGreaterThan(0);
    expect(salt.length).toBeGreaterThan(0);
    expect(hash.length).toBeGreaterThan(0);
  });

  it('rejects malformed stored values', async () => {
    expect(await verifyPassword('x', '')).toBe(false);
    expect(await verifyPassword('x', 'plaintext')).toBe(false);
    expect(await verifyPassword('x', 'pbkdf2$abc$salt$hash')).toBe(false);
    expect(await verifyPassword('x', 'sha256$1$a$b')).toBe(false);
  });
});
