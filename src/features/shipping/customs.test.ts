import { describe, expect, it } from 'vitest';
import {
  buildCustomsDeclaration,
  needsCustomsDeclaration,
  normalizeHsCode,
  normalizeOriginCountry,
} from './customs';

describe('needsCustomsDeclaration', () => {
  it('is true when countries differ', () => {
    expect(needsCustomsDeclaration('GB', 'FR')).toBe(true);
    expect(needsCustomsDeclaration('gb', 'fr')).toBe(true);
  });
  it('is false for domestic', () => {
    expect(needsCustomsDeclaration('GB', 'GB')).toBe(false);
  });
});

describe('normalizeHsCode', () => {
  it('strips punctuation and accepts 6+ digits', () => {
    expect(normalizeHsCode('0901.21')).toBe('090121');
    expect(normalizeHsCode('8708 99 9790')).toBe('8708999790');
  });
  it('rejects short codes', () => {
    expect(normalizeHsCode('12345')).toBeNull();
  });
});

describe('normalizeOriginCountry', () => {
  it('uppercases ISO2', () => {
    expect(normalizeOriginCountry('gb')).toBe('GB');
  });
  it('rejects junk', () => {
    expect(normalizeOriginCountry('GBR')).toBeNull();
  });
});

describe('buildCustomsDeclaration', () => {
  const products = new Map([
    [
      1,
      {
        hs_code: '610910',
        country_of_origin: 'GB',
        customs_description: 'Cotton t-shirt',
        weight_grams: 200,
        requires_shipping: 1,
      },
    ],
    [
      2,
      {
        hs_code: null,
        country_of_origin: 'GB',
        customs_description: null,
        weight_grams: 100,
        requires_shipping: 1,
      },
    ],
    [
      3,
      {
        hs_code: '490199',
        country_of_origin: 'GB',
        customs_description: null,
        weight_grams: null,
        requires_shipping: 0,
      },
    ],
  ]);

  it('builds lines from product customs fields', () => {
    const result = buildCustomsDeclaration({
      lines: [{ name: 'Tee', price_cents: 2500, quantity: 2, product_id: 1 }],
      productsById: products,
      currency: 'gbp',
      parcelWeightGrams: 500,
      eori: 'GB123456789000',
      certifySigner: 'Ada',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.declaration.items).toEqual([
      {
        description: 'Cotton t-shirt',
        quantity: 2,
        unitValueMajor: 25,
        unitWeightGrams: 200,
        hsCode: '610910',
        originCountry: 'GB',
      },
    ]);
    expect(result.declaration.eori).toBe('GB123456789000');
    expect(result.declaration.certifySigner).toBe('Ada');
  });

  it('reports missing HS codes', () => {
    const result = buildCustomsDeclaration({
      lines: [{ name: 'Hat', price_cents: 1000, quantity: 1, product_id: 2 }],
      productsById: products,
      currency: 'GBP',
      parcelWeightGrams: 300,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing[0]).toMatch(/HS code/);
  });

  it('skips digital products', () => {
    const result = buildCustomsDeclaration({
      lines: [
        { name: 'Tee', price_cents: 2500, quantity: 1, product_id: 1 },
        { name: 'PDF', price_cents: 500, quantity: 1, product_id: 3 },
      ],
      productsById: products,
      currency: 'GBP',
      parcelWeightGrams: 300,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.declaration.items).toHaveLength(1);
  });

  it('splits parcel weight when product weight is unknown', () => {
    const map = new Map([
      [
        9,
        {
          hs_code: '950300',
          country_of_origin: 'CN',
          customs_description: null,
          weight_grams: null,
          requires_shipping: 1,
        },
      ],
    ]);
    const result = buildCustomsDeclaration({
      lines: [{ name: 'Toy', price_cents: 999, quantity: 2, product_id: 9 }],
      productsById: map,
      currency: 'GBP',
      parcelWeightGrams: 400,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.declaration.items[0]!.unitWeightGrams).toBe(200);
    expect(result.declaration.items[0]!.description).toBe('Toy');
  });
});
