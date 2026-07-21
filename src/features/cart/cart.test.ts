import { describe, it, expect } from 'vitest';
import { cartCount } from './cart';

describe('cartCount', () => {
  it('sums line quantities', () => {
    expect(cartCount({ '1': 2, '2': 3 })).toBe(5);
  });

  it('is 0 for an empty cart', () => {
    expect(cartCount({})).toBe(0);
  });
});
