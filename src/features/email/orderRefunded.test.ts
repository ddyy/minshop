import { describe, it, expect } from 'vitest';
import { orderRefundedEmail } from './orderConfirmation';
import type { Order } from '../orders/db';

// A refunded order must read back in the currency it was CHARGED in. The store's
// current currency is irrelevant — an order taken in EUR before a switch to USD
// still refunds euros, and showing "$" would misstate the amount to the customer.

const order = (over: Partial<Order> = {}): Order =>
  ({
    id: 42,
    public_id: 'tok',
    provider_session_id: 'cs_1',
    email: 'buyer@example.com',
    amount_total_cents: 10000,
    shipping_cents: 0,
    discount_cents: 0,
    tax_cents: 0,
    currency: 'eur',
    status: 'paid',
    payment_method: 'stripe',
    provider_payment_id: 'pi_1',
    provider_refunded_cents: 0,
    external_refunded_cents: 0,
    refund_review_reason: null,
    refund_reviewed_at: null,
    refund_reviewed_by: null,
    refunded_cents: 0,
    fulfillment_status: 'unfulfilled',
    tracking_carrier: null,
    tracking_number: null,
    fulfilled_at: null,
    ship_address: null,
    created_at: '2026-01-01',
    ...over,
  }) as Order;

describe('orderRefundedEmail', () => {
  it('prices every amount in the order currency, not the store default', () => {
    const msg = orderRefundedEmail(order({ refunded_cents: 2500 }), 2500, 2500, 'S');
    for (const body of [msg.text, msg.html]) {
      expect(body).toContain('€');
      expect(body).not.toContain('$');
    }
  });

  it('shows the remaining paid amount for a partial refund', () => {
    const msg = orderRefundedEmail(order({ refunded_cents: 2500 }), 2500, 2500, 'S');
    expect(msg.text).toContain('Still paid');
    expect(msg.subject).not.toContain('has been refunded');
  });

  it('omits the remaining amount once fully refunded', () => {
    const msg = orderRefundedEmail(
      order({ refunded_cents: 10000 }),
      10000,
      10000,
      'S',
    );
    expect(msg.text).not.toContain('Still paid');
    expect(msg.subject).toContain('has been refunded');
  });

  it('reports a running total only when an earlier refund exists', () => {
    // Second partial: this refund is 2000, but 4500 has now gone back overall.
    const second = orderRefundedEmail(order({ refunded_cents: 4500 }), 2000, 4500, 'S');
    expect(second.text).toContain('Total refunded so far');
    const first = orderRefundedEmail(order({ refunded_cents: 2500 }), 2500, 2500, 'S');
    expect(first.text).not.toContain('Total refunded so far');
  });
});
