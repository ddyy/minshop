/**
 * At-rest encryption for secrets stored in D1 (Stripe keys, webhook secret, …).
 * AES-256-GCM via WebCrypto (no deps). The 256-bit key is derived (SHA-256) from
 * the KEK string, so the KEK can be any high-entropy value. Stored as
 *   `gcm$<ivB64>$<ctB64>`   (ct includes the GCM auth tag).
 *
 * The KEK lives ONLY in the Worker secret store, never in D1 — so a D1 leak yields
 * ciphertext alone (you need both the DB and the KEK to read a key). Pure (uses the
 * global WebCrypto) → unit-testable.
 */
const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function aesKey(kek: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(kek));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Encrypt a secret for storage. Random 96-bit IV per call. */
export async function encryptSecret(kek: string, plaintext: string): Promise<string> {
  const key = await aesKey(kek);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)),
  );
  return `gcm$${b64(iv)}$${b64(ct)}`;
}

/** Decrypt a stored `gcm$…` secret; null if the format/KEK is wrong or it was tampered. */
export async function decryptSecret(kek: string, stored: string): Promise<string | null> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'gcm') return null;
  try {
    const iv = unb64(parts[1]);
    const ct = unb64(parts[2]);
    const key = await aesKey(kek);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch {
    return null; // wrong KEK or tampered ciphertext → GCM auth tag fails
  }
}
