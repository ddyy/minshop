/**
 * Generic signed, expiring token carrying a string payload — used for both the
 * magic-link login token (short TTL) and the customer session cookie (long TTL).
 * Format: `<b64url(payload)>.<exp>.<sigHex>` where sig = HMAC-SHA256(key, the
 * "<b64url>.<exp>" prefix). The payload is base64url-encoded so an email's `.`/`@`
 * never clashes with the delimiter. Pure (no `cloudflare:workers`) → unit-testable.
 */
function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): string | null {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

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

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Sign `payload` into a token valid for `ttlSeconds` from `nowSeconds`. */
export async function signToken(
  payload: string,
  key: string,
  ttlSeconds: number,
  nowSeconds: number,
): Promise<string> {
  const exp = Math.floor(nowSeconds) + ttlSeconds;
  const head = `${b64urlEncode(payload)}.${exp}`;
  return `${head}.${await hmacHex(key, head)}`;
}

/** Verify a token: signature valid AND not expired → the payload, else null. */
export async function verifyToken(
  token: string | null | undefined,
  key: string,
  nowSeconds: number,
): Promise<string | null> {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [p, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= Math.floor(nowSeconds)) return null;
  const expected = await hmacHex(key, `${p}.${expStr}`);
  if (!constantTimeEqual(sig, expected)) return null;
  return b64urlDecode(p);
}
