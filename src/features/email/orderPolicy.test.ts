import { describe, expect, it } from 'vitest';
import { shouldSendCustomerOrderEmail } from './orderPolicy';

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
