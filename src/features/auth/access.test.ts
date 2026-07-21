import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { verifyAccessJwt, clearAccessCache } from './access';

const TEAM = 'https://team.cloudflareaccess.com';
const AUD = 'test-aud-tag';
const KID = 'test-key-1';

function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const arr = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const b64urlJson = (obj: unknown) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

const RSA = {
  name: 'RSASSA-PKCS1-v1_5',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
} as const;

let keyPair: CryptoKeyPair;
let publicJwk: JsonWebKey & { kid?: string };

async function signJwt(
  payload: Record<string, unknown>,
  opts: { kid?: string; key?: CryptoKey } = {},
): Promise<string> {
  const header = { alg: 'RS256', kid: opts.kid ?? KID };
  const input = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    opts.key ?? keyPair.privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${b64url(sig)}`;
}

function payload(over: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { iss: TEAM, aud: AUD, email: 'admin@example.com', iat: now, exp: now + 600, ...over };
}

beforeEach(async () => {
  clearAccessCache();
  keyPair = await crypto.subtle.generateKey(RSA, true, ['sign', 'verify']);
  publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  publicJwk.kid = KID;
  // Mock the team JWKS endpoint.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ keys: [{ ...publicJwk }] }), { status: 200 })),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('verifyAccessJwt', () => {
  it('accepts a valid token and returns the email', async () => {
    const id = await verifyAccessJwt(await signJwt(payload()), { teamDomain: TEAM, aud: AUD });
    expect(id?.email).toBe('admin@example.com');
  });

  it('rejects a token signed by a different (forged) key', async () => {
    const attacker = await crypto.subtle.generateKey(RSA, true, ['sign', 'verify']);
    const jwt = await signJwt(payload(), { key: attacker.privateKey });
    expect(await verifyAccessJwt(jwt, { teamDomain: TEAM, aud: AUD })).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const jwt = await signJwt(payload());
    const [h, , s] = jwt.split('.');
    const forged = `${h}.${b64urlJson(payload({ email: 'attacker@evil.com' }))}.${s}`;
    expect(await verifyAccessJwt(forged, { teamDomain: TEAM, aud: AUD })).toBeNull();
  });

  it('rejects the wrong audience', async () => {
    const jwt = await signJwt(payload({ aud: 'someone-elses-app' }));
    expect(await verifyAccessJwt(jwt, { teamDomain: TEAM, aud: AUD })).toBeNull();
  });

  it('rejects the wrong issuer', async () => {
    const jwt = await signJwt(payload({ iss: 'https://evil.cloudflareaccess.com' }));
    expect(await verifyAccessJwt(jwt, { teamDomain: TEAM, aud: AUD })).toBeNull();
  });

  it('rejects an expired token', async () => {
    const jwt = await signJwt(payload({ exp: Math.floor(Date.now() / 1000) - 10 }));
    expect(await verifyAccessJwt(jwt, { teamDomain: TEAM, aud: AUD })).toBeNull();
  });

  it('rejects malformed tokens', async () => {
    expect(await verifyAccessJwt('not.a.jwt', { teamDomain: TEAM, aud: AUD })).toBeNull();
    expect(await verifyAccessJwt('only-one-part', { teamDomain: TEAM, aud: AUD })).toBeNull();
  });

  it('accepts aud as an array containing the tag', async () => {
    const jwt = await signJwt(payload({ aud: ['other', AUD] }));
    const id = await verifyAccessJwt(jwt, { teamDomain: TEAM, aud: AUD });
    expect(id?.email).toBe('admin@example.com');
  });
});
