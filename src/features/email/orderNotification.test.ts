import { describe, expect, it } from 'vitest';
import type { Order } from '../orders/db';
import { orderNotificationEmail } from './orderConfirmation';

const order = (overrides: Partial<Order> = {}): Order =>
  ({
    id: 105,
    public_id: 'ord_zdpyy315je',
    provider_session_id: 'demo_session',
    email: 'buyer@example.com',
    amount_total_cents: 100,
    shipping_cents: 0,
    shipping_label: null,
    shipping_weight_grams: null,
    discount_cents: 0,
    tax_cents: 0,
    currency: 'usd',
    status: 'paid',
    payment_method: 'demo',
    provider_payment_id: null,
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
    label_url: null,
    ship_address: null,
    created_at: '2026-07-28 00:00:00',
    ...overrides,
  });

describe('orderNotificationEmail', () => {
  it('shows the sequential order number and public ID in the owner subject and message', () => {
    const message = orderNotificationEmail(
      order(),
      [],
      'owner@example.com',
      'https://demo.minshop.dev',
      'Minshop',
    );

    // ASCII hyphen: keeps the header out of RFC 2047 encoded-words in raw logs.
    expect(message.subject).toBe('New Minshop order #105 - ord_zdpyy315je');
    for (const body of [message.text, message.html]) {
      expect(body.toLowerCase()).toContain('order #105');
      expect(body).toContain('ord_zdpyy315je');
    }
    expect(message.html).toContain('/admin/orders/ord_zdpyy315je');
  });

  it('does not render null when a legacy order has no public ID', () => {
    const message = orderNotificationEmail(
      order({ public_id: null }),
      [],
      'owner@example.com',
      'https://demo.minshop.dev',
      'Minshop',
    );

    expect(message.subject).toBe('New Minshop order #105');
    expect(message.text).toContain('Public ID: —');
    expect(message.html).not.toContain('null');
  });
});
