import { describe, expect, it } from 'vitest';
import {
  assertExpectedSumUpCheckout,
  sumupAmountValue,
} from './sumup';

describe('sumupAmountValue', () => {
  it('formats two-decimal currencies', () => {
    expect(sumupAmountValue(1999, 'gbp')).toBe(19.99);
    expect(sumupAmountValue(100, 'eur')).toBe(1);
  });

  it('formats zero-decimal currencies', () => {
    expect(sumupAmountValue(1500, 'jpy')).toBe(1500);
  });
});

describe('assertExpectedSumUpCheckout', () => {
  const expected = { amount_total_cents: 2500, currency: 'GBP' };

  it('accepts a PAID checkout that matches', () => {
    expect(() =>
      assertExpectedSumUpCheckout(expected, {
        status: 'PAID',
        amount: 25,
        currency: 'GBP',
      }),
    ).not.toThrow();
  });

  it('rejects non-PAID status', () => {
    expect(() =>
      assertExpectedSumUpCheckout(expected, {
        status: 'PENDING',
        amount: 25,
        currency: 'GBP',
      }),
    ).toThrow(/PENDING/i);
  });

  it('rejects amount mismatch', () => {
    expect(() =>
      assertExpectedSumUpCheckout(expected, {
        status: 'PAID',
        amount: 24.99,
        currency: 'GBP',
      }),
    ).toThrow(/amount/);
  });

  it('rejects currency mismatch', () => {
    expect(() =>
      assertExpectedSumUpCheckout(expected, {
        status: 'PAID',
        amount: 25,
        currency: 'EUR',
      }),
    ).toThrow(/currency/);
  });
});
