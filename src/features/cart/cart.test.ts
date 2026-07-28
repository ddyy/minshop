import { describe, it, expect } from 'vitest';
import type { AstroCookies } from 'astro';
import { cartCount, readCart } from './cart';

const P = 'prod_k7m2qx8vn6';
const V = 'var_n9fx2km7qc';

/** Minimal AstroCookies stand-in serving one raw `cart` cookie value. */
const cookiesWith = (value: unknown): AstroCookies =>
  ({
    get: (name: string) =>
      name === 'cart' ? { json: () => value } : undefined,
  }) as unknown as AstroCookies;

describe('cartCount', () => {
  it('sums line quantities', () => {
    expect(cartCount({ [P]: 2, [`${P}:${V}`]: 3 })).toBe(5);
  });

  it('is 0 for an empty cart', () => {
    expect(cartCount({})).toBe(0);
  });
});

describe('readCart (cookie v2)', () => {
  it('reads a v2 cookie of public-ID keys', () => {
    expect(readCart(cookiesWith({ v: 2, items: { [P]: 2, [`${P}:${V}`]: 1 } }))).toEqual({
      [P]: 2,
      [`${P}:${V}`]: 1,
    });
  });

  it('expires a pre-cutover cookie (bare map, no version marker)', () => {
    expect(readCart(cookiesWith({ '5': 2, '5:12#3,7': 1 }))).toEqual({});
  });

  it('expires any other cookie version', () => {
    expect(readCart(cookiesWith({ v: 1, items: { [P]: 2 } }))).toEqual({});
    expect(readCart(cookiesWith({ v: 3, items: { [P]: 2 } }))).toEqual({});
  });

  it('drops numeric legacy keys even inside a v2 envelope', () => {
    expect(readCart(cookiesWith({ v: 2, items: { '5': 2, [P]: 1 } }))).toEqual({ [P]: 1 });
  });

  it('drops malformed quantities and clamps oversized ones', () => {
    expect(
      readCart(cookiesWith({ v: 2, items: { [P]: 'x', [`${P}:${V}`]: 500 } })),
    ).toEqual({ [`${P}:${V}`]: 99 });
  });

  it('is empty for a missing or non-object cookie', () => {
    expect(readCart(cookiesWith(undefined))).toEqual({});
    expect(readCart(cookiesWith('nope'))).toEqual({});
  });
});
