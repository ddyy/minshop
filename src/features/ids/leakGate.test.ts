import { describe, it, expect } from 'vitest';
import { findLeaks, findHtmlLeaks } from './leakGate';
import { toCatalogProduct } from '../catalog/serialize';
import { generateAccessToken } from './token';
import type { Product } from '../products/db';

const product: Product = {
  id: 4,
  public_id: 'prod_k7m2qx8vn6',
  name: 'Canvas Tote Bag',
  slug: 'canvas-tote-bag',
  description: null,
  price_cents: 2400,
  currency: 'usd',
  image_key: null,
  stock: 3,
  active: 1,
  variant_label: 'Size',
  weight_grams: null,
  requires_shipping: 1,
  related_ids: null,
  created_at: '2026-06-18 00:00:00',
};

describe('findLeaks', () => {
  it('passes the real catalog serializer output', () => {
    const c = toCatalogProduct(product, ['Apparel'], 'https://shop.example.com', {
      variants: [
        { id: 1, public_id: 'var_n9fx2km7qc', product_id: 4, label: 'S', price_cents: 2400, stock: 1, sku: null, position: 0, active: 1, image_id: null, weight_grams: null },
      ],
      extras: [
        { id: 9, public_id: 'xtra_q3vr8jm2np', product_id: 4, label: 'Gift wrap', price_delta_cents: 500, position: 0, active: 1 },
      ],
    });
    expect(findLeaks(c)).toEqual([]);
  });

  it('flags numeric record ids under id-named keys, at any depth', () => {
    expect(findLeaks({ id: 42 })).toHaveLength(1);
    expect(findLeaks({ items: [{ product_id: 7 }] })).toHaveLength(1);
    expect(findLeaks({ nested: { deep: { variant_id: 3 } } })).toHaveLength(1);
    // Non-id numerics are fine.
    expect(findLeaks({ price_cents: 2400, quantity: 2 })).toEqual([]);
  });

  it('flags stringified row ids the same as numbers', () => {
    expect(findLeaks({ id: '42' })).toHaveLength(1);
    expect(findLeaks({ items: [{ variant_id: '7' }] })).toHaveLength(1);
    // A non-numeric string at an untyped id key is not flagged by this rule.
    expect(findLeaks({ id: 'prod_k7m2qx8vn6' })).toEqual([]);
  });

  it('enforces the right prefix for typed id keys, allowing legacy order/refund shapes', () => {
    expect(findLeaks({ product_id: 'var_n9fx2km7qc' })).toHaveLength(1);
    expect(findLeaks({ product_id: 'prod_k7m2qx8vn6' })).toEqual([]);
    expect(findLeaks({ order_id: 'a'.repeat(32) })).toEqual([]);
    expect(findLeaks({ refund_id: '123e4567-e89b-42d3-a456-426614174000' })).toEqual([]);
    expect(findLeaks({ order_id: 'prod_k7m2qx8vn6' })).toHaveLength(1);
  });

  it('flags access tokens anywhere in a payload', () => {
    const token = generateAccessToken();
    expect(findLeaks({ url: `https://x/order/${token}` })).toHaveLength(1);
    expect(findLeaks({ note: 'no tokens' })).toEqual([]);
  });
});

describe('findHtmlLeaks', () => {
  it('flags numeric ids in form values and record URLs', () => {
    expect(findHtmlLeaks('<input name="product_id" value="42">')).toHaveLength(1);
    expect(findHtmlLeaks('<input name="id" value="42">')).toHaveLength(1);
    expect(findHtmlLeaks('<input type="hidden" name="v_id" value="7">')).toHaveLength(1);
    expect(findHtmlLeaks('<input name="grid" value="42">')).toEqual([]);
    expect(findHtmlLeaks('<a href="/admin/orders/123">o</a>')).toHaveLength(1);
    expect(findHtmlLeaks('<input name="product_id" value="prod_k7m2qx8vn6">')).toEqual([]);
    expect(findHtmlLeaks('<a href="/admin/orders/ord_h5tm8qp3vn">o</a>')).toEqual([]);
    expect(findHtmlLeaks('<a href="/products/canvas-tote">p</a>')).toEqual([]);
  });

  it('flags stray access tokens in markup', () => {
    expect(findHtmlLeaks(`<a href="/order/${generateAccessToken()}">x</a>`)).toHaveLength(1);
  });
});
