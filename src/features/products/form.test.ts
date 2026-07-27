import { describe, it, expect } from 'vitest';
import { parseProductForm } from './form';
import { toGrams } from '../shipping/weight';
import { validateVariantWeights } from './variants';

function form(data: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(data)) f.set(k, v);
  return f;
}

describe('parseProductForm', () => {
  it('parses valid input and converts dollars → cents', () => {
    const r = parseProductForm(
      form({ name: 'Tee', price: '25.00', stock: '10', currency: 'USD', active: 'on' }),
    );
    expect('data' in r).toBe(true);
    if ('data' in r) {
      expect(r.data.name).toBe('Tee');
      expect(r.data.price_cents).toBe(2500);
      expect(r.data.stock).toBe(10);
      expect(r.data.currency).toBe('usd');
      expect(r.data.active).toBe(1);
    }
  });

  it('treats an absent checkbox as active=0', () => {
    const r = parseProductForm(form({ name: 'Tee', price: '5', stock: '1' }));
    if ('data' in r) expect(r.data.active).toBe(0);
  });

  it('rounds fractional cents', () => {
    const r = parseProductForm(form({ name: 'X', price: '9.999', stock: '1' }));
    if ('data' in r) expect(r.data.price_cents).toBe(1000);
  });

  it('normalizes a blank description to null', () => {
    const r = parseProductForm(form({ name: 'X', price: '5', stock: '1', description: '   ' }));
    if ('data' in r) expect(r.data.description).toBeNull();
  });

  it('rejects an empty name', () => {
    expect('error' in parseProductForm(form({ name: '  ', price: '5', stock: '1' }))).toBe(true);
  });

  it('rejects a negative price', () => {
    expect('error' in parseProductForm(form({ name: 'X', price: '-5', stock: '1' }))).toBe(true);
  });

  it('rejects non-integer stock', () => {
    expect('error' in parseProductForm(form({ name: 'X', price: '5', stock: '1.5' }))).toBe(true);
  });

  it('defaults to requiring shipping with an unknown weight', () => {
    const r = parseProductForm(form({ name: 'X', price: '5', stock: '1' }));
    if ('data' in r) {
      expect(r.data.weight_grams).toBeNull();
      // Absent checkbox = 0, which is why the product FORM must always submit it
      // (see the hidden field in admin/products/[id].astro).
      expect(r.data.requires_shipping).toBe(0);
    }
  });

  it('converts weight from the store display unit to grams', () => {
    const r = parseProductForm(
      form({ name: 'X', price: '5', stock: '1', weight: '2.4', requires_shipping: 'on' }),
      { unit: 'kg' },
    );
    if ('data' in r) {
      expect(r.data.weight_grams).toBe(2400);
      expect(r.data.requires_shipping).toBe(1);
    }
  });

  it('keeps an explicit zero weight distinct from blank', () => {
    const zero = parseProductForm(form({ name: 'X', price: '5', stock: '1', weight: '0' }));
    if ('data' in zero) expect(zero.data.weight_grams).toBe(0);
    const blank = parseProductForm(form({ name: 'X', price: '5', stock: '1', weight: '' }));
    if ('data' in blank) expect(blank.data.weight_grams).toBeNull();
  });

  it('rejects a malformed weight', () => {
    const r = parseProductForm(form({ name: 'X', price: '5', stock: '1', weight: 'heavy' }));
    expect('error' in r).toBe(true);
  });

  it('requires a weight only when a missing one would block sales', () => {
    const fields = { name: 'X', price: '5', stock: '1', active: 'on', requires_shipping: 'on' };
    expect('error' in parseProductForm(form(fields), { requireWeight: true })).toBe(true);
    // Same product with a flat fallback available: blank stays legal.
    expect('data' in parseProductForm(form(fields), { requireWeight: false })).toBe(true);
    // A digital product is never blocked by weight pricing.
    const digital = { name: 'X', price: '5', stock: '1', active: 'on' };
    expect('data' in parseProductForm(form(digital), { requireWeight: true })).toBe(true);
  });
});

describe('validateVariantWeights', () => {
  // The route runs this BEFORE its first write; a mid-save failure left the
  // image/product/category changes committed behind an error page.
  const withWeights = (...weights: string[]) => {
    const f = new FormData();
    for (const w of weights) f.append('v_weight', w);
    return f;
  };
  it('refuses the inputs that used to be silently discarded', () => {
    expect(validateVariantWeights(withWeights('heavy'), 'g')).toMatch(/must be a number/);
    expect(validateVariantWeights(withWeights('-1'), 'g')).toMatch(/negative/);
    expect(validateVariantWeights(withWeights('0.5'), 'g')).toMatch(/decimal places/);
    expect(validateVariantWeights(withWeights('2000'), 'kg')).toMatch(/too heavy/);
  });
  it('names the offending row', () => {
    expect(validateVariantWeights(withWeights('1', 'heavy'), 'g')).toMatch(/^Variant 2:/);
  });
  it('accepts blank (inherit), zero, and ordinary values', () => {
    expect(validateVariantWeights(withWeights('', '0', '250'), 'g')).toBeNull();
    expect(validateVariantWeights(new FormData(), 'g')).toBeNull();
  });
  it('parses with the same rules as toGrams', () => {
    expect(toGrams('', 'g')).toEqual({ status: 'blank' });
    expect(toGrams('0', 'g')).toEqual({ status: 'ok', grams: 0 });
  });
});
