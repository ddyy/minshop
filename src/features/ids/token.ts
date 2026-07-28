/**
 * Guest access tokens — the revocable credential behind /order/<token> and
 * /pay/<token>. Format: `otk_` + the canonical 22-character unpadded base64url
 * encoding of 128 random bits.
 *
 * Deliberately NOT Crockford base32: tokens are never typed or spoken, and the
 * mixed-case shape is chosen so Cloudflare's trace-event URL redaction
 * heuristic (an ID-like run of 21+ chars with ≥2 uppercase, ≥2 lowercase, and
 * ≥2 digits) recognizes and redacts it in platform logs. Application-level
 * redaction (redactAccessTokens) remains authoritative.
 *
 * Canonical form: 21 chars carry 126 bits, the 22nd carries the final 2, so
 * its low four bits must be zero — the only legal final characters are
 * A, Q, g, w. The validator rejects the 15 non-canonical equivalents.
 * Token matching is case-sensitive, unlike public IDs.
 */

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export const ACCESS_TOKEN_PREFIX = 'otk_';

/** Strict shape check: otk_ + 22 base64url chars ending in A/Q/g/w. */
const TOKEN_RE = /^otk_[A-Za-z0-9_-]{21}[AQgw]$/;

function encodeBase64Url128(bytes: Uint8Array): string {
  // 16 bytes -> 22 chars: pack 6 bits at a time; the final char holds the last
  // 2 bits in its HIGH positions (low 4 bits zero -> canonical).
  let out = '';
  let acc = 0;
  let accBits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    accBits += 8;
    while (accBits >= 6) {
      accBits -= 6;
      out += B64URL[(acc >> accBits) & 0x3f];
    }
  }
  // 128 bits % 6 = 2 trailing bits.
  out += B64URL[(acc & ((1 << accBits) - 1)) << (6 - accBits)];
  return out;
}

const countClass = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

/**
 * Generate a guest access token. Regenerates until the character-class mix
 * that triggers platform redaction is present (≥2 upper, ≥2 lower, ≥2 digits) —
 * a rare miss with 22 mixed-alphabet characters.
 */
export function generateAccessToken(): string {
  for (;;) {
    const body = encodeBase64Url128(crypto.getRandomValues(new Uint8Array(16)));
    if (
      countClass(body, /[A-Z]/g) >= 2 &&
      countClass(body, /[a-z]/g) >= 2 &&
      countClass(body, /[0-9]/g) >= 2
    ) {
      return ACCESS_TOKEN_PREFIX + body;
    }
  }
}

/** Case-sensitive, canonical-form-only. No normalization — tokens are pasted, not typed. */
export function isAccessToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

/**
 * Replace anything token-shaped with otk_REDACTED. Authoritative app-level
 * redaction for log/error paths; platform trace-event redaction is
 * defense-in-depth on top.
 */
export function redactAccessTokens(text: string): string {
  return text.replace(/otk_[A-Za-z0-9_-]{22}/g, 'otk_REDACTED');
}
