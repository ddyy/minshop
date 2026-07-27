import { describe, it, expect } from 'vitest';
import {
  MAX_WEIGHT_GRAMS,
  WEIGHT_UNITS,
  formatWeight,
  formatWeightValue,
  isWeightUnit,
  resolveShipmentWeight,
  resolveUnitWeight,
  toGrams,
  type WeightLine,
  type WeightUnit,
} from './weight';

const ok = (value: string, unit: WeightUnit) => {
  const parsed = toGrams(value, unit);
  if (parsed.status !== 'ok') throw new Error(`expected ok, got ${parsed.status}`);
  return parsed.grams;
};

describe('toGrams', () => {
  it('converts each unit to the nearest gram', () => {
    expect(ok('850', 'g')).toBe(850);
    expect(ok('2.4', 'kg')).toBe(2400);
    expect(ok('1', 'lb')).toBe(454);
    expect(ok('16', 'oz')).toBe(454);
  });
  it('accepts an explicit zero', () => {
    expect(ok('0', 'g')).toBe(0);
    expect(ok('0', 'lb')).toBe(0);
  });
  it('reports blank separately from malformed input', () => {
    expect(toGrams('', 'g')).toEqual({ status: 'blank' });
    expect(toGrams('   ', 'g')).toEqual({ status: 'blank' });
    expect(toGrams('heavy', 'g')).toEqual({ status: 'error', reason: 'not_number' });
    expect(toGrams('1e3', 'g')).toEqual({ status: 'error', reason: 'not_number' });
    expect(toGrams('1,5', 'kg')).toEqual({ status: 'error', reason: 'not_number' });
  });
  it('rejects negatives, over-precision, and absurd weights', () => {
    expect(toGrams('-1', 'g')).toEqual({ status: 'error', reason: 'negative' });
    expect(toGrams('0.5', 'g')).toEqual({ status: 'error', reason: 'precision' });
    expect(toGrams('1.0001', 'kg')).toEqual({ status: 'error', reason: 'precision' });
    expect(toGrams('2000', 'kg')).toEqual({ status: 'error', reason: 'over_limit' });
  });
  it('accepts exactly one tonne', () => {
    expect(ok(String(MAX_WEIGHT_GRAMS), 'g')).toBe(MAX_WEIGHT_GRAMS);
  });
});

describe('formatWeight', () => {
  it('renders a compact value with the store unit', () => {
    expect(formatWeight(850, 'g')).toBe('850 g');
    expect(formatWeight(2400, 'kg')).toBe('2.4 kg');
  });
  it('trims trailing zeroes', () => {
    expect(formatWeightValue(2000, 'kg')).toBe('2');
    expect(formatWeightValue(454, 'lb')).toBe('1.001');
  });
});

describe('unit round-trip idempotence', () => {
  // The display precision per unit is chosen so one displayed step is finer than a
  // gram. Sampled rather than exhaustive: 4M format+parse cycles would slow every
  // `npm run verify` for a property the precision table already guarantees.
  const samples = new Set<number>([0, 1, 2, 7, 9, 453, 454, 999, 1000, MAX_WEIGHT_GRAMS]);
  for (let grams = 0; grams <= 2000; grams += 1) samples.add(grams);
  for (let grams = 2000; grams <= MAX_WEIGHT_GRAMS; grams += 997) samples.add(grams);

  for (const unit of WEIGHT_UNITS) {
    it(`survives format → parse → format in ${unit}`, () => {
      for (const grams of samples) {
        const displayed = formatWeightValue(grams, unit);
        const parsed = toGrams(displayed, unit);
        expect(parsed, `${grams} g displayed as "${displayed}" ${unit}`).toEqual({
          status: 'ok',
          grams,
        });
      }
    });
  }
});

describe('isWeightUnit', () => {
  it('accepts the four supported units only', () => {
    expect(isWeightUnit('kg')).toBe(true);
    expect(isWeightUnit('stone')).toBe(false);
    expect(isWeightUnit(null)).toBe(false);
  });
});

describe('resolveUnitWeight', () => {
  it('inherits the product weight when the variant is blank', () => {
    expect(resolveUnitWeight(250, null)).toBe(250);
  });
  it('lets a variant override its product', () => {
    expect(resolveUnitWeight(250, 1000)).toBe(1000);
  });
  it('treats an explicit zero as a known weight, not as inherit', () => {
    expect(resolveUnitWeight(250, 0)).toBe(0);
  });
  it('stays unknown when neither is set', () => {
    expect(resolveUnitWeight(null, null)).toBeNull();
  });
});

const line = (over: Partial<WeightLine> = {}): WeightLine => ({
  productId: 1,
  variantId: null,
  name: 'Pin',
  quantity: 1,
  requiresShipping: true,
  productWeightGrams: 10,
  variantWeightGrams: null,
  ...over,
});

describe('resolveShipmentWeight', () => {
  it('multiplies unit weight by quantity', () => {
    const resolved = resolveShipmentWeight([line({ quantity: 3, productWeightGrams: 250 })]);
    expect(resolved).toEqual({ shippingRequired: true, itemWeightGrams: 750, missingWeight: [] });
  });
  it('sums mixed lines and applies variant overrides', () => {
    const resolved = resolveShipmentWeight([
      line({ productId: 1, productWeightGrams: 250 }),
      line({ productId: 2, variantId: 9, productWeightGrams: 250, variantWeightGrams: 1000, quantity: 2 }),
    ]);
    expect(resolved.itemWeightGrams).toBe(250 + 2000);
  });
  it('reports the unknown records and refuses to guess a total', () => {
    const resolved = resolveShipmentWeight([
      line({ productId: 4, name: 'Cast iron pan', productWeightGrams: null }),
      line({ productId: 4, name: 'Cast iron pan', productWeightGrams: null }),
      line({ productId: 5, productWeightGrams: 100 }),
    ]);
    expect(resolved.itemWeightGrams).toBeNull();
    // Deduplicated: one repair per catalog record, not one per cart line.
    expect(resolved.missingWeight).toEqual([{ productId: 4, variantId: null, name: 'Cast iron pan' }]);
  });
  it('excludes lines that do not require shipping', () => {
    const resolved = resolveShipmentWeight([
      line({ productId: 1, productWeightGrams: 500 }),
      line({ productId: 2, requiresShipping: false, productWeightGrams: null }),
    ]);
    expect(resolved).toEqual({ shippingRequired: true, itemWeightGrams: 500, missingWeight: [] });
  });
  it('reports an all-digital cart as not requiring shipping', () => {
    const resolved = resolveShipmentWeight([
      line({ requiresShipping: false, productWeightGrams: null }),
    ]);
    expect(resolved).toEqual({ shippingRequired: false, itemWeightGrams: 0, missingWeight: [] });
  });
  it('treats an empty cart as not requiring shipping', () => {
    expect(resolveShipmentWeight([]).shippingRequired).toBe(false);
  });
});
