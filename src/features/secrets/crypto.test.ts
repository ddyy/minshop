import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret } from './crypto';

const KEK = 'a-high-entropy-key-encryption-secret';

describe('secret encryption (AES-256-GCM)', () => {
  it('round-trips a secret', async () => {
    const enc = await encryptSecret(KEK, 'sk_live_deadbeef');
    expect(enc.startsWith('gcm$')).toBe(true);
    expect(await decryptSecret(KEK, enc)).toBe('sk_live_deadbeef');
  });

  it('fails to decrypt with the wrong KEK', async () => {
    const enc = await encryptSecret(KEK, 'sk_live_x');
    expect(await decryptSecret('different-kek', enc)).toBe(null);
  });

  it('fails on tampered ciphertext (GCM auth tag)', async () => {
    const enc = await encryptSecret(KEK, 'sk_live_x');
    const [scheme, iv, ct] = enc.split('$');
    const flipped = ct.slice(0, -2) + (ct.slice(-2) === 'AA' ? 'BB' : 'AA');
    expect(await decryptSecret(KEK, `${scheme}$${iv}$${flipped}`)).toBe(null);
  });

  it('uses a fresh IV each time (same input → different ciphertext)', async () => {
    const a = await encryptSecret(KEK, 'same');
    const b = await encryptSecret(KEK, 'same');
    expect(a).not.toBe(b);
    expect(await decryptSecret(KEK, a)).toBe('same');
    expect(await decryptSecret(KEK, b)).toBe('same');
  });

  it('returns null on malformed input', async () => {
    expect(await decryptSecret(KEK, '')).toBe(null);
    expect(await decryptSecret(KEK, 'plaintext')).toBe(null);
    expect(await decryptSecret(KEK, 'aes$iv$ct')).toBe(null);
  });
});
