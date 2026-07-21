/**
 * Signed admin session cookie for the password-login flow:
 *   `v1.<exp>.<credTag>.<sigHex>`
 *   sig     = HMAC-SHA256(signingKey, "v1.<exp>.<credTag>")
 *   credTag = first 16 hex of HMAC-SHA256(signingKey, "cred:" + credential)
 *
 * The `signingKey` is a high-entropy secret (AUTH_SECRET), NOT the admin password —
 * so a leaked cookie can't be brute-forced back into the password (the old design
 * keyed the HMAC on the password itself). `credTag` binds the session to the current
 * credential, so rotating the password still invalidates every existing session.
 * Pure + dependency-free (no `cloudflare:workers`) → unit-testable.
 *
 * App-password stopgap's session layer; Cloudflare Access remains the recommended
 * production auth and is unaffected.
 */
const PREFIX = 'v1';

async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string compare — avoids leaking via timing (password + signature). */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 16-hex tag binding a session to the current credential (password or its hash). */
export async function credentialTag(signingKey: string, credential: string): Promise<string> {
  return (await hmacHex(signingKey, `cred:${credential}`)).slice(0, 16);
}

/** Sign a session token valid for `ttlSeconds` from `nowSeconds`. */
export async function signSession(
  signingKey: string,
  credential: string,
  ttlSeconds: number,
  nowSeconds: number,
): Promise<string> {
  const exp = Math.floor(nowSeconds) + ttlSeconds;
  const tag = await credentialTag(signingKey, credential);
  const payload = `${PREFIX}.${exp}.${tag}`;
  return `${payload}.${await hmacHex(signingKey, payload)}`;
}

/** True only if the signature verifies, the credential tag matches, AND it's unexpired. */
export async function verifySession(
  token: string | null | undefined,
  signingKey: string,
  credential: string,
  nowSeconds: number,
): Promise<boolean> {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 4) return false;
  const [prefix, expStr, tag, sig] = parts;
  if (prefix !== PREFIX) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= Math.floor(nowSeconds)) return false;
  // Credential changed (password rotated) → tag no longer matches → reject.
  if (!constantTimeEqual(tag, await credentialTag(signingKey, credential))) return false;
  const expected = await hmacHex(signingKey, `${PREFIX}.${expStr}.${tag}`);
  return constantTimeEqual(sig, expected);
}
