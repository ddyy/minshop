import { describe, expect, it } from 'vitest';
import { requirePublicId } from '../../src/features/catalog/serialize';

/**
 * The loader itself needs D1, so these cover the policy it applies rather than
 * the query: a row reaching a public surface without its public ID is a
 * deploy-order bug, and the storefront must fail loudly instead of shipping a
 * page whose Add to cart is broken.
 *
 * Before this, a missing ID became an empty string — the page rendered 200 with
 * `product_id=""`, and the failure only surfaced when a shopper tried to buy.
 */
describe('the missing-public-ID policy', () => {
  it.each(['product', 'variant', 'extra', 'product image'])(
    'refuses a %s row without a public ID',
    (kind) => {
      expect(() => requirePublicId(null, 42, kind)).toThrow(/no public_id/);
    },
  );

  it('names the row and the backfill in the error', () => {
    // The message has to be actionable: which table, which row, what to run.
    expect(() => requirePublicId(null, 7, 'variant')).toThrow(/variant row 7/);
    expect(() => requirePublicId(null, 7, 'variant')).toThrow(/backfill/);
  });

  it('passes a present ID straight through', () => {
    expect(requirePublicId('prod_k7m2qx8vn6', 42, 'product')).toBe('prod_k7m2qx8vn6');
  });
});
