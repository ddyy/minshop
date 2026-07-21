import { describe, it, expect } from 'vitest';
import { cartKey, parseCartKey, lineUnitPriceCents } from './key';

describe('cartKey', () => {
  it('plain product (no variant/extras)', () => {
    expect(cartKey(5)).toBe('5');
    expect(cartKey(5, null, [])).toBe('5');
  });
  it('with a variant', () => {
    expect(cartKey(5, 12)).toBe('5:12');
  });
  it('with extras (de-duped + sorted)', () => {
    expect(cartKey(5, null, [7, 3, 7])).toBe('5#3,7');
  });
  it('with variant + extras', () => {
    expect(cartKey(5, 12, [7, 3])).toBe('5:12#3,7');
  });
  it('drops a zero/invalid variant', () => {
    expect(cartKey(5, 0, [])).toBe('5');
  });
});

describe('parseCartKey', () => {
  it('round-trips every shape', () => {
    for (const [pid, vid, ex] of [
      [5, null, []],
      [5, 12, []],
      [5, null, [3, 7]],
      [5, 12, [3, 7]],
    ] as const) {
      const parsed = parseCartKey(cartKey(pid, vid, [...ex]));
      expect(parsed).toEqual({ productId: pid, variantId: vid, extraIds: [...ex] });
    }
  });
  it('parses a legacy plain-product key', () => {
    expect(parseCartKey('5')).toEqual({ productId: 5, variantId: null, extraIds: [] });
  });
  it('rejects malformed keys', () => {
    expect(parseCartKey('abc')).toBeNull();
    expect(parseCartKey('0')).toBeNull();
    expect(parseCartKey('5:0')).toBeNull();
    expect(parseCartKey('5:1:2')).toBeNull();
    expect(parseCartKey('-3')).toBeNull();
  });
  it('drops junk extra ids but keeps the line', () => {
    expect(parseCartKey('5#3,x,-1,7')).toEqual({ productId: 5, variantId: null, extraIds: [3, 7] });
  });
});

describe('lineUnitPriceCents', () => {
  it('uses the base price when there is no variant', () => {
    expect(lineUnitPriceCents(2000, null, [])).toBe(2000);
  });
  it('uses the variant price (replaces base)', () => {
    expect(lineUnitPriceCents(2000, { price_cents: 2500 }, [])).toBe(2500);
  });
  it('adds extras on top', () => {
    expect(lineUnitPriceCents(2000, null, [{ price_delta_cents: 500 }, { price_delta_cents: 300 }])).toBe(2800);
  });
  it('variant + extras together', () => {
    expect(lineUnitPriceCents(2000, { price_cents: 2500 }, [{ price_delta_cents: 500 }])).toBe(3000);
  });
});
