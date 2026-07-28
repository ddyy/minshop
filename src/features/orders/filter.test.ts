import { describe, it, expect } from 'vitest';
import {
  parseOrderFilters,
  orderFilterClause,
  hasOrderFilters,
  orderFilterParams,
} from './filter';

const parse = (qs: string) => parseOrderFilters(new URLSearchParams(qs));

describe('parseOrderFilters', () => {
  it('reads each supported filter', () => {
    const f = parse('status=refunded&fulfillment=fulfilled&method=lightning&review=1');
    expect(f).toEqual({
      status: 'refunded',
      fulfillment: 'fulfilled',
      method: 'lightning',
      review: true,
    });
  });

  it('drops values that are not on the whitelist', () => {
    const f = parse('status=bogus&fulfillment=maybe&method=paypal&review=yes');
    expect(f).toEqual({ status: null, fulfillment: null, method: null, review: false });
  });

  it('is empty with no params', () => {
    expect(hasOrderFilters(parse(''))).toBe(false);
    expect(hasOrderFilters(parse('status=paid'))).toBe(true);
  });
});

describe('orderFilterClause', () => {
  it('builds no clause when nothing is filtered', () => {
    expect(orderFilterClause(parse(''))).toEqual({ where: '', params: [] });
  });

  it('never interpolates a caller value into SQL', () => {
    // The injection attempt is rejected by the whitelist outright, so it can
    // reach neither the clause nor the bound params.
    const f = parse("status=' OR 1=1--&method=' OR 1=1--");
    const { where, params } = orderFilterClause(f);
    expect(where).toBe('');
    expect(params).toEqual([]);
  });

  it('binds every value it does accept', () => {
    const { where, params } = orderFilterClause(parse('fulfillment=fulfilled&method=demo'));
    expect(where).toBe('WHERE fulfillment_status = ? AND payment_method = ?');
    expect(params).toEqual(['fulfilled', 'demo']);
  });

  it('derives partial refunds from the amounts, not orders.status', () => {
    // status only stores pending/paid/refunded, so a partial refund is not
    // representable there at all.
    const { where } = orderFilterClause(parse('status=partially_refunded'));
    expect(where).toBe('WHERE (refunded_cents > 0 AND refunded_cents < amount_total_cents)');
  });

  it('does not count a zero-total order as fully refunded', () => {
    const { where } = orderFilterClause(parse('status=refunded'));
    // Without the > 0 guard, a $0 order satisfies refunded >= total.
    expect(where).toContain('refunded_cents > 0');
  });

  it('treats a legacy NULL payment_method as Stripe', () => {
    // The column postdates those orders, which were card-only — a Stripe filter
    // that ignored them would hide real card orders.
    const { where, params } = orderFilterClause(parse('method=stripe'));
    expect(where).toBe('WHERE (payment_method = ? OR payment_method IS NULL)');
    expect(params).toEqual(['stripe']);
  });

  it('combines filters with AND', () => {
    const { where, params } = orderFilterClause(parse('status=paid&fulfillment=unfulfilled'));
    expect(where).toBe("WHERE (status = 'paid' AND refunded_cents = 0) AND fulfillment_status = ?");
    expect(params).toEqual(['unfulfilled']);
  });

  it('round-trips through query params', () => {
    const f = parse('status=paid&method=demo&review=1');
    expect(orderFilterParams(f)).toEqual({
      status: 'paid',
      fulfillment: undefined,
      method: 'demo',
      review: '1',
    });
  });
});
