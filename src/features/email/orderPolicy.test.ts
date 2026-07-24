import { describe, expect, it } from 'vitest';
import { resolveRequiredOrderEmail, shouldSendCustomerOrderEmail } from './orderPolicy';

describe('shouldSendCustomerOrderEmail', () => {
  it('suppresses customer email for demo orders', () => {
    expect(shouldSendCustomerOrderEmail('demo')).toBe(false);
  });

  it.each(['stripe', 'lightning', 'opennode', null, undefined])(
    'allows customer email for %s orders',
    (paymentMethod) => {
      expect(shouldSendCustomerOrderEmail(paymentMethod)).toBe(true);
    },
  );
});

describe('resolveRequiredOrderEmail', () => {
  it('uses a valid submitted address', () => {
    expect(resolveRequiredOrderEmail(' buyer@example.com ', 'old@example.com')).toBe(
      'buyer@example.com',
    );
  });

  it('falls back to a valid address already stored with the checkout', () => {
    expect(resolveRequiredOrderEmail('', 'saved@example.com')).toBe('saved@example.com');
  });

  it.each([
    ['', null],
    ['not-an-email', null],
    ['buyer@example', null],
  ])('rejects a missing or invalid address', (submitted, existing) => {
    expect(resolveRequiredOrderEmail(submitted, existing)).toBeNull();
  });
});
