// Cloudflare Access JWT verification using Web Crypto — no dependency.
//
// Access signs application tokens (the `Cf-Access-Jwt-Assertion` header) with
// RS256. We fetch the team's public keys (JWKS), import the one matching the
// token's `kid`, verify the signature, and validate `iss` / `aud` / `exp`.
//
// This is "Layer 2": it stops anyone bypassing the edge by hitting the origin
// (`*.workers.dev`) directly with a forged header — only a token actually signed
// by Cloudflare for YOUR application passes.

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
}

// Cache JWKS per team domain (keys rotate rarely). Module scope persists across
// requests in a warm isolate.
const jwksCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>();
const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Test seam: drop the in-memory JWKS cache. */
export function clearAccessCache(): void {
  jwksCache.clear();
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeSegment<T>(seg: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(seg))) as T;
}

async function fetchKeys(teamDomain: string, force: boolean): Promise<Jwk[]> {
  const base = teamDomain.replace(/\/$/, '');
  const cached = jwksCache.get(base);
  if (!force && cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  const res = await fetch(`${base}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access JWKS fetch failed: ${res.status}`);
  const data = (await res.json()) as { keys?: Jwk[] };
  const keys = data.keys ?? [];
  jwksCache.set(base, { keys, fetchedAt: Date.now() });
  return keys;
}

async function importVerifyKey(jwk: Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}

export interface AccessIdentity {
  email: string;
  sub?: string;
}

interface AccessHeader {
  alg?: string;
  kid?: string;
}
interface AccessPayload {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  email?: string;
  sub?: string;
}

/**
 * Verify a Cloudflare Access JWT. Returns the identity on success, or `null` if
 * the token is missing/malformed/expired, the signature doesn't verify, or the
 * `iss`/`aud` don't match. Throws only on infrastructure errors (JWKS
 * unreachable) — callers should treat a throw as "deny" (fail closed).
 */
export async function verifyAccessJwt(
  token: string,
  opts: { teamDomain: string; aud: string },
): Promise<AccessIdentity | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;

  let header: AccessHeader;
  let payload: AccessPayload;
  try {
    header = decodeSegment<AccessHeader>(h);
    payload = decodeSegment<AccessPayload>(p);
  } catch {
    return null; // not valid base64url JSON
  }
  if (header.alg !== 'RS256' || !header.kid) return null;

  // Cheap claim checks before any crypto.
  const base = opts.teamDomain.replace(/\/$/, '');
  if (payload.iss !== base && payload.iss !== `${base}/`) return null;
  const auds = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if (!auds.includes(opts.aud)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && now >= payload.exp) return null;
  if (typeof payload.nbf === 'number' && now < payload.nbf) return null;

  const signed = new TextEncoder().encode(`${h}.${p}`);
  const sig = b64urlToBytes(s);
  const verifyWith = async (keys: Jwk[]): Promise<boolean> => {
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) return false;
    const key = await importVerifyKey(jwk);
    return crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, sig, signed);
  };

  let keys = await fetchKeys(opts.teamDomain, false);
  // kid not present → keys may have rotated; refetch once.
  if (!keys.some((k) => k.kid === header.kid)) keys = await fetchKeys(opts.teamDomain, true);
  if (!(await verifyWith(keys))) return null;

  return { email: payload.email ?? '', sub: payload.sub };
}
