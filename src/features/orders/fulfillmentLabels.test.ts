import { describe, expect, it } from 'vitest';
import {
  deliveryMethodLabel,
  fulfillActionLabel,
  fulfillmentStatusLabel,
  unfulfillActionLabel,
} from './fulfillmentLabels';

describe('fulfillmentStatusLabel', () => {
  it('uses collection wording for pickup orders', () => {
    expect(fulfillmentStatusLabel('unfulfilled', 'pickup')).toBe('Ready for collection');
    expect(fulfillmentStatusLabel('fulfilled', 'pickup')).toBe('Collected');
  });

  it('uses dispatch wording for postage orders', () => {
    expect(fulfillmentStatusLabel('unfulfilled', 'shipping')).toBe('Awaiting dispatch');
    expect(fulfillmentStatusLabel('fulfilled', 'shipping')).toBe('Dispatched');
  });

  it('falls back for unknown delivery methods', () => {
    expect(fulfillmentStatusLabel('unfulfilled', null)).toBe('Unfulfilled');
    expect(fulfillmentStatusLabel('fulfilled', 'mystery')).toBe('Fulfilled');
  });
});

describe('fulfill action labels', () => {
  it('matches the delivery mode', () => {
    expect(fulfillActionLabel('pickup')).toBe('Mark as collected');
    expect(fulfillActionLabel('shipping')).toBe('Mark as dispatched');
    expect(unfulfillActionLabel('pickup')).toBe('Mark not collected');
    expect(deliveryMethodLabel('shipping')).toBe('Postage');
  });
});
