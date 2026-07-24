import { describe, expect, it, vi } from 'vitest';
import {
  anonymousRateLimitKey,
  checkRateLimit,
  rateLimitBucket,
  rateLimitedResponse,
} from './rateLimit';

describe('rateLimitBucket', () => {
  it.each(['/admin/login', '/account/login'])('limits auth POST %s', (path) => {
    expect(rateLimitBucket('POST', path)).toBe('auth');
  });

  it.each(['/api/checkout', '/checkout', '/pay/order-token'])('limits checkout POST %s', (path) => {
    expect(rateLimitBucket('POST', path)).toBe('checkout');
  });

  it.each(['/search', '/api/products'])('limits search GET %s only when q is present', (path) => {
    expect(rateLimitBucket('GET', path, true)).toBe('search');
    expect(rateLimitBucket('GET', path, false)).toBeNull();
  });

  it('does not limit unrelated reads, webhooks, or authenticated admin APIs', () => {
    expect(rateLimitBucket('GET', '/admin/login')).toBeNull();
    expect(rateLimitBucket('GET', '/api/products/mug', true)).toBeNull();
    expect(rateLimitBucket('POST', '/api/webhook/stripe')).toBeNull();
    expect(rateLimitBucket('POST', '/api/admin/products')).toBeNull();
  });
});

it('scopes anonymous counters to host, route, and connecting client', () => {
  const request = new Request('https://shop.example/api/checkout', {
    headers: { 'CF-Connecting-IP': '203.0.113.7' },
  });
  expect(anonymousRateLimitKey(request, '/api/checkout')).toBe(
    'shop.example:/api/checkout:203.0.113.7',
  );
});

it('passes the scoped key to the Cloudflare binding and honors its decision', async () => {
  const limit = vi.fn(async () => ({ success: false }));
  const limiter = { limit };
  const request = new Request('https://shop.example/admin/login', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': '203.0.113.8' },
  });

  await expect(checkRateLimit(limiter, request, '/admin/login')).resolves.toBe(false);
  expect(limit).toHaveBeenCalledWith({ key: 'shop.example:/admin/login:203.0.113.8' });
  await expect(checkRateLimit(undefined, request, '/admin/login')).resolves.toBe(true);
});

it('returns a non-cacheable 429 with retry guidance', async () => {
  const response = rateLimitedResponse('/api/checkout');
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('60');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('access-control-allow-origin')).toBe('*');
  await expect(response.json()).resolves.toEqual({ error: 'Too many requests. Try again shortly.' });
});

it('keeps catalog search 429s readable cross-origin', () => {
  expect(rateLimitedResponse('/api/products').headers.get('access-control-allow-origin')).toBe('*');
});
