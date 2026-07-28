import { describe, expect, it } from 'vitest';
import { isForbiddenFormOrigin } from './formOrigin';

const URL = new globalThis.URL('https://shop.example/pay/otk_xK3mQ9vRt2LwZa8pYc4dNQ');

function request(
  method: string,
  origin?: string,
  contentType = 'application/x-www-form-urlencoded',
): Request {
  const headers = new Headers();
  if (origin !== undefined) headers.set('origin', origin);
  if (contentType) headers.set('content-type', contentType);
  return new Request(URL, { method, headers });
}

describe('isForbiddenFormOrigin', () => {
  it('allows safe methods and same-origin forms', () => {
    expect(isForbiddenFormOrigin(request('GET'), URL)).toBe(false);
    expect(isForbiddenFormOrigin(request('POST', URL.origin), URL)).toBe(false);
  });

  it('allows an originless or cross-origin form only for a capability pay token', () => {
    expect(isForbiddenFormOrigin(request('POST'), URL)).toBe(false);
    expect(isForbiddenFormOrigin(request('POST', 'https://other.example'), URL)).toBe(false);

    const bareId = new globalThis.URL('https://shop.example/pay/ord_h5tm8qp3vn');
    expect(isForbiddenFormOrigin(request('POST'), bareId)).toBe(true);

    const legacy = new globalThis.URL(
      'https://shop.example/pay/123e4567-e89b-12d3-a456-426614174000',
    );
    expect(isForbiddenFormOrigin(request('POST'), legacy)).toBe(true);
  });

  it('does not extend the exception to other methods or routes', () => {
    expect(isForbiddenFormOrigin(request('PUT'), URL)).toBe(true);
    const order = new globalThis.URL(
      'https://shop.example/order/otk_xK3mQ9vRt2LwZa8pYc4dNQ',
    );
    expect(isForbiddenFormOrigin(request('POST'), order)).toBe(true);
  });

  it('matches Astro for non-form bodies and missing content types', () => {
    expect(isForbiddenFormOrigin(request('POST', 'https://other.example', 'application/json'), URL))
      .toBe(false);
    expect(isForbiddenFormOrigin(request('POST', URL.origin, ''), URL)).toBe(false);
    expect(isForbiddenFormOrigin(request('POST', undefined, ''), URL)).toBe(true);
  });
});
