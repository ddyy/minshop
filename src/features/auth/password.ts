/**
 * Admin password hashing — PBKDF2-HMAC-SHA256 via WebCrypto (no deps). Stored as
 *   `pbkdf2$<iterations>$<saltB64>$<hashB64>`
 * A slow KDF + random per-password salt means a leaked D1 row can't be cheaply
 * brute-forced (unlike a plain SHA-256 or plaintext). The iteration count is stored
 * in the value, so it can be raised later without breaking existing hashes. Pure
 * (uses the global WebCrypto) → unit-testable.
 *
 * Iterations are tuned to stay well within a Worker's CPU budget for a login while
 * staying expensive to brute-force offline.
 */
const ITERATIONS = 100_000;
const KEY_BYTES = 32;
const SALT_BYTES = 16;

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** Hash a password for storage (random salt, encoded with its parameters). */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

/** Constant-time verify a typed password against a stored `pbkdf2$…` hash. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) return false;
  let salt: Uint8Array<ArrayBuffer>;
  let expected: Uint8Array;
  try {
    salt = unb64(parts[2]);
    expected = unb64(parts[3]);
  } catch {
    return false;
  }
  const actual = await derive(password, salt, iterations);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}
