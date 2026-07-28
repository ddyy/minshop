import { describe, it, expect } from 'vitest';
import {
  PUBLIC_ID_PREFIXES,
  PUBLIC_ID_ALPHABET,
  generatePublicId,
  parsePublicId,
  publicIdToken,
  isLegacyPublicId,
  parseOrderOrLegacyPublicId,
  type PublicIdKind,
} from './publicId';

const KINDS = Object.keys(PUBLIC_ID_PREFIXES) as PublicIdKind[];

describe('generatePublicId', () => {
  it('emits the requested prefix plus exactly 10 allowed characters', () => {
    for (const kind of KINDS) {
      const id = generatePublicId(kind);
      const prefix = `${PUBLIC_ID_PREFIXES[kind]}_`;
      expect(id.startsWith(prefix)).toBe(true);
      const token = id.slice(prefix.length);
      expect(token).toHaveLength(10);
      for (const ch of token) expect(PUBLIC_ID_ALPHABET).toContain(ch);
    }
  });

  it('does not repeat across a batch (50-bit space, mocked-free sanity check)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generatePublicId('product'));
    expect(seen.size).toBe(1000);
  });

  it('never emits the excluded Crockford letters i, l, o, u in the token', () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePublicId('order').slice('ord_'.length)).not.toMatch(/[ilou]/);
    }
  });
});

describe('parsePublicId', () => {
  it('normalizes uppercase input to lowercase before validating', () => {
    expect(parsePublicId('PROD_K7M2QX8VN6', 'product')).toBe('prod_k7m2qx8vn6');
    expect(parsePublicId('  prod_k7m2qx8vn6  ', 'product')).toBe('prod_k7m2qx8vn6');
  });

  it('rejects wrong prefixes so a variant cannot pass as a product', () => {
    expect(parsePublicId('var_k7m2qx8vn6', 'product')).toBeNull();
    expect(parsePublicId('prod_k7m2qx8vn6', 'variant')).toBeNull();
  });

  it('rejects wrong lengths and invalid characters', () => {
    expect(parsePublicId('prod_k7m2qx8vn', 'product')).toBeNull(); // 9
    expect(parsePublicId('prod_k7m2qx8vn6t', 'product')).toBeNull(); // 11
    expect(parsePublicId('prod_k7m2qxlvn6', 'product')).toBeNull(); // 'l' excluded
    expect(parsePublicId('prod_k7m2qx8vni', 'product')).toBeNull(); // 'i' excluded
    expect(parsePublicId(42 as unknown, 'product')).toBeNull();
    expect(parsePublicId('42', 'product')).toBeNull();
  });
});

describe('publicIdToken', () => {
  it('strips the validated prefix for the customer reference', () => {
    expect(publicIdToken('ord_h5tm8qp3vn', 'order')).toBe('h5tm8qp3vn');
    expect(publicIdToken('prod_h5tm8qp3vn', 'order')).toBeNull();
  });
});

describe('legacy shapes', () => {
  const hex32 = 'a'.repeat(32);
  const uuid = '123e4567-e89b-42d3-a456-426614174000';

  it('recognizes hex32 and uuid, rejects everything else', () => {
    expect(isLegacyPublicId(hex32)).toBe(true);
    expect(isLegacyPublicId(uuid)).toBe(true);
    expect(isLegacyPublicId('ord_h5tm8qp3vn')).toBe(false);
    expect(isLegacyPublicId('42')).toBe(false);
  });

  it('parseOrderOrLegacyPublicId accepts both shapes for orders', () => {
    expect(parseOrderOrLegacyPublicId('ord_h5tm8qp3vn', 'order')).toBe('ord_h5tm8qp3vn');
    expect(parseOrderOrLegacyPublicId(hex32, 'order')).toBe(hex32);
    expect(parseOrderOrLegacyPublicId(uuid, 'refund')).toBe(uuid);
    expect(parseOrderOrLegacyPublicId('42', 'order')).toBeNull();
  });
});
