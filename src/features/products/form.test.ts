import { describe, it, expect } from 'vitest';
import { parseProductForm } from './form';

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
});
