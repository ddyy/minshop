import { describe, it, expect } from 'vitest';
import { cartKey, parseCartKey, lineUnitPriceCents } from './key';

const P = 'prod_k7m2qx8vn6';
const V = 'var_n9fx2km7qc';
const XA = 'xtra_0000000000';
const XB = 'xtra_q3vr8jm2np';

describe('cartKey', () => {
  it('plain product (no variant/extras)', () => {
    expect(cartKey(P)).toBe(P);
    expect(cartKey(P, null, [])).toBe(P);
  });
  it('with a variant', () => {
    expect(cartKey(P, V)).toBe(`${P}:${V}`);
  });
  it('with extras (de-duped + sorted)', () => {
    expect(cartKey(P, null, [XB, XA, XB])).toBe(`${P}#${XA},${XB}`);
  });
  it('with variant + extras', () => {
    expect(cartKey(P, V, [XB, XA])).toBe(`${P}:${V}#${XA},${XB}`);
  });
  it('drops an empty/invalid variant', () => {
    expect(cartKey(P, null)).toBe(P);
    expect(cartKey(P, '')).toBe(P);
  });
});

describe('parseCartKey', () => {
  it('round-trips every shape', () => {
    for (const [pid, vid, ex] of [
      [P, null, []],
      [P, V, []],
      [P, null, [XA, XB]],
      [P, V, [XA, XB]],
    ] as const) {
      const parsed = parseCartKey(cartKey(pid, vid, [...ex]));
      expect(parsed).toEqual({
        productPublicId: pid,
        variantPublicId: vid,
        extraPublicIds: [...ex],
      });
    }
  });
  it('rejects legacy numeric keys', () => {
    expect(parseCartKey('5')).toBeNull();
    expect(parseCartKey('5:12')).toBeNull();
    expect(parseCartKey('5:12#3,7')).toBeNull();
  });
  it('rejects malformed keys', () => {
    expect(parseCartKey('abc')).toBeNull();
    expect(parseCartKey('')).toBeNull();
    expect(parseCartKey(`${P}:${V}:${V}`)).toBeNull(); // more than one ':'
    expect(parseCartKey(`${P}#${XA}#${XB}`)).toBeNull(); // more than one '#'
    expect(parseCartKey(`${P}:`)).toBeNull(); // empty variant part
    expect(parseCartKey(`${P}#`)).toBeNull(); // empty extras part
  });
  it('rejects wrong-prefix parts (a variant is never a product)', () => {
    expect(parseCartKey(V)).toBeNull();
    expect(parseCartKey(`${P}:${XA}`)).toBeNull();
    expect(parseCartKey(`${P}#${V}`)).toBeNull();
  });
  it('rejects the line when ANY extra is invalid', () => {
    expect(parseCartKey(`${P}#${XA},junk`)).toBeNull();
    expect(parseCartKey(`${P}#${XA},7`)).toBeNull();
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
