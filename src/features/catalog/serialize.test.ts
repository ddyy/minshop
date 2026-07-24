import { describe, it, expect } from 'vitest';
import { toCatalogProduct } from './serialize';
import type { Product } from '../products/db';

const base: Product = {
  id: 4,
  name: 'Canvas Tote Bag',
  slug: 'canvas-tote-bag',
  description: 'Heavyweight cotton canvas tote.',
  price_cents: 2400,
  currency: 'usd',
  image_key: 'products/canvas-tote-bag.webp',
  stock: 120,
  active: 1,
  variant_label: null,
  created_at: '2026-06-18 00:00:00',
};
const ORIGIN = 'https://shop.example.com';

describe('toCatalogProduct', () => {
  it('builds the public shape with absolute urls', () => {
    const c = toCatalogProduct(base, ['Apparel'], ORIGIN);
    expect(c).toMatchObject({
      id: 4,
      slug: 'canvas-tote-bag',
      name: 'Canvas Tote Bag',
      in_stock: true,
      categories: ['Apparel'],
      image: 'https://shop.example.com/images/products/canvas-tote-bag.webp',
      url: 'https://shop.example.com/product/canvas-tote-bag',
    });
    expect(c).not.toHaveProperty('stock');
  });

  it('reports price in both major and minor units, currency upper-cased', () => {
    expect(toCatalogProduct(base, [], ORIGIN).price).toEqual({
      amount: 24,
      cents: 2400,
      currency: 'USD',
    });
  });

  it('scales price by the product currency (JPY has no minor unit)', () => {
    const jpy = { ...base, price_cents: 3000, currency: 'jpy' };
    expect(toCatalogProduct(jpy, [], ORIGIN).price).toEqual({
      amount: 3000,
      cents: 3000,
      currency: 'JPY',
    });
  });

  it('marks out-of-stock and falls back to the placeholder image', () => {
    const oos = { ...base, stock: 0, image_key: null };
    const c = toCatalogProduct(oos, [], ORIGIN);
    expect(c.in_stock).toBe(false);
    expect(c.image).toBe('https://shop.example.com/placeholder.png');
  });

  it('omits variants/extras when not provided (list shape)', () => {
    const c = toCatalogProduct(base, [], ORIGIN);
    expect(c.variant_label).toBeNull();
    expect(c.variants).toBeUndefined();
    expect(c.extras).toBeUndefined();
  });

  it('embeds variants + extras and derives availability from variants', () => {
    const p = { ...base, stock: 0, variant_label: 'Size' }; // product row stock is irrelevant
    const variants = [
      { id: 1, product_id: 4, label: 'S', price_cents: 2400, stock: 0, sku: 'T-S', position: 0, active: 1, image_id: null },
      { id: 2, product_id: 4, label: 'L', price_cents: 2600, stock: 5, sku: null, position: 1, active: 1, image_id: null },
    ];
    const extras = [
      { id: 9, product_id: 4, label: 'Gift wrap', price_delta_cents: 500, position: 0, active: 1 },
    ];
    const c = toCatalogProduct(p, [], ORIGIN, { variants, extras });
    expect(c.variant_label).toBe('Size');
    expect(c.in_stock).toBe(true); // L is in stock
    expect(c).not.toHaveProperty('stock');
    expect(c.variants).toEqual([
      { id: 1, label: 'S', price: { amount: 24, cents: 2400, currency: 'USD' }, in_stock: false, sku: 'T-S' },
      { id: 2, label: 'L', price: { amount: 26, cents: 2600, currency: 'USD' }, in_stock: true, sku: null },
    ]);
    expect(c.extras).toEqual([
      { id: 9, label: 'Gift wrap', price_delta: { amount: 5, cents: 500, currency: 'USD' } },
    ]);
  });
});
