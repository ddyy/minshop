import { describe, it, expect } from 'vitest';
import { generateAccessToken, isAccessToken, redactAccessTokens } from './token';

describe('generateAccessToken', () => {
  it('emits otk_ plus 22 base64url characters in canonical form', () => {
    for (let i = 0; i < 200; i++) {
      const t = generateAccessToken();
      expect(t).toMatch(/^otk_[A-Za-z0-9_-]{22}$/);
      // canonical final partial character: low four bits zero
      expect(['A', 'Q', 'g', 'w']).toContain(t[t.length - 1]);
    }
  });

  it('satisfies the platform redaction heuristic character-class mix', () => {
    for (let i = 0; i < 200; i++) {
      const body = generateAccessToken().slice(4);
      expect((body.match(/[A-Z]/g) ?? []).length).toBeGreaterThanOrEqual(2);
      expect((body.match(/[a-z]/g) ?? []).length).toBeGreaterThanOrEqual(2);
      expect((body.match(/[0-9]/g) ?? []).length).toBeGreaterThanOrEqual(2);
    }
  });

  it('does not repeat', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generateAccessToken());
    expect(seen.size).toBe(500);
  });
});

describe('isAccessToken', () => {
  it('accepts canonical tokens and rejects non-canonical final characters', () => {
    const good = 'otk_xK3mQ9vRt2LwZa8pYc4dNQ';
    expect(isAccessToken(good)).toBe(true);
    // same token with a non-canonical final char (low four bits set)
    expect(isAccessToken('otk_xK3mQ9vRt2LwZa8pYc4dNf')).toBe(false);
    expect(isAccessToken('otk_xK3mQ9vRt2LwZa8pYc4dNB')).toBe(false);
  });

  it('is case-sensitive and strict about length and prefix', () => {
    expect(isAccessToken('OTK_xK3mQ9vRt2LwZa8pYc4dNQ')).toBe(false);
    expect(isAccessToken('otk_xK3mQ9vRt2LwZa8pYc4dQ')).toBe(false); // 21 chars
    expect(isAccessToken('otk_xK3mQ9vRt2LwZa8pYc4dNNQ')).toBe(false); // 23 chars
    expect(isAccessToken('ord_h5tm8qp3vn')).toBe(false);
    expect(isAccessToken(null)).toBe(false);
  });
});

describe('redactAccessTokens', () => {
  it('replaces token-shaped substrings wherever they appear', () => {
    const t = generateAccessToken();
    expect(redactAccessTokens(`GET /order/${t} 200`)).toBe('GET /order/otk_REDACTED 200');
    expect(redactAccessTokens(`a ${t} b ${t}`)).toBe('a otk_REDACTED b otk_REDACTED');
    expect(redactAccessTokens('no tokens here')).toBe('no tokens here');
  });
});
