import { describe, expect, it } from 'vitest';
import { assertExpectedPayPalCapture, paypalAmountValue } from './paypal';

describe('paypalAmountValue', () => {
  it('formats USD with two decimals', () => {
    expect(paypalAmountValue(1995, 'USD')).toBe('19.95');
    expect(paypalAmountValue(0, 'usd')).toBe('0.00');
  });
});

describe('assertExpectedPayPalCapture', () => {
  it('accepts a matching completed capture', () => {
    expect(() => assertExpectedPayPalCapture(
      { amount_total_cents: 4295, currency: 'USD' },
      {
        id: 'CAP-1',
        status: 'COMPLETED',
        amount: { value: '42.95', currency_code: 'USD' },
      },
    )).not.toThrow();
  });

  it('rejects amount, currency, or status mismatches', () => {
    expect(() => assertExpectedPayPalCapture(
      { amount_total_cents: 4295, currency: 'USD' },
      {
        id: 'CAP-1',
        status: 'COMPLETED',
        amount: { value: '42.94', currency_code: 'USD' },
      },
    )).toThrow(/amount/);

    expect(() => assertExpectedPayPalCapture(
      { amount_total_cents: 4295, currency: 'USD' },
      {
        id: 'CAP-1',
        status: 'COMPLETED',
        amount: { value: '42.95', currency_code: 'GBP' },
      },
    )).toThrow(/currency/);

    expect(() => assertExpectedPayPalCapture(
      { amount_total_cents: 4295, currency: 'USD' },
      {
        id: 'CAP-1',
        status: 'PENDING',
        amount: { value: '42.95', currency_code: 'USD' },
      },
    )).toThrow(/PENDING/);
  });
});
