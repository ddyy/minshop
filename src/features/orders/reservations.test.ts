import { describe, expect, it } from 'vitest';
import { aggregateStockTargets } from './reservations';

describe('aggregateStockTargets', () => {
  it('combines lines that share product stock', () => {
    expect(
      aggregateStockTargets([
        { productId: 1, name: 'Tee (wrap)', priceCents: 1000, quantity: 2 },
        { productId: 1, name: 'Tee', priceCents: 900, quantity: 3 },
      ]),
    ).toEqual([{ productId: 1, variantId: null, quantity: 5 }]);
  });

  it('keeps variant stock independent', () => {
    expect(
      aggregateStockTargets([
        { productId: 1, variantId: 10, name: 'Small', priceCents: 1000, quantity: 2 },
        { productId: 1, variantId: 11, name: 'Large', priceCents: 1000, quantity: 1 },
      ]),
    ).toEqual([
      { productId: 1, variantId: 10, quantity: 2 },
      { productId: 1, variantId: 11, quantity: 1 },
    ]);
  });
});
