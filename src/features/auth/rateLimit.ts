import type { RateLimit } from '@cloudflare/workers-types';

export type RateLimitBucket = 'auth' | 'checkout' | 'search';

/** Public routes that can spend scarce resources or amplify credential abuse. */
export function rateLimitBucket(
  method: string,
  pathname: string,
  hasSearchQuery = false,
): RateLimitBucket | null {
  if (
    method === 'GET' &&
    hasSearchQuery &&
    (pathname === '/search' || pathname === '/api/products')
  ) {
    return 'search';
  }
  if (method !== 'POST') return null;
  if (pathname === '/admin/login' || pathname === '/account/login') return 'auth';
  if (pathname === '/api/checkout' || pathname === '/checkout' || pathname.startsWith('/pay/')) {
    return 'checkout';
  }
  return null;
}

/**
 * Anonymous auth and checkout requests have no trustworthy user id yet. Scope the
 * edge counter to the store + route + connecting client. The route keeps login
 * and checkout budgets independent; the host prevents shared namespace ids from
 * coupling separately provisioned stores in one Cloudflare account.
 */
export function anonymousRateLimitKey(request: Request, pathname: string): string {
  const client = request.headers.get('cf-connecting-ip')?.trim() || 'unknown-client';
  return `${new URL(request.url).hostname}:${pathname}:${client}`;
}

export async function checkRateLimit(
  limiter: RateLimit | undefined,
  request: Request,
  pathname: string,
): Promise<boolean> {
  // Old/custom Wrangler configs may not have adopted the binding yet. Keep the
  // storefront available while the checked-in configs make throttling the normal
  // production path.
  if (!limiter) return true;
  const result = await limiter.limit({ key: anonymousRateLimitKey(request, pathname) });
  return result.success;
}

export function rateLimitedResponse(pathname: string): Response {
  const api = pathname.startsWith('/api/');
  return new Response(
    api
      ? JSON.stringify({ error: 'Too many requests. Try again shortly.' })
      : 'Too many requests. Try again shortly.',
    {
      status: 429,
      headers: {
        'cache-control': 'no-store',
        'content-type': api ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
        'retry-after': '60',
        ...(pathname === '/api/checkout' || pathname === '/api/products'
          ? { 'access-control-allow-origin': '*' }
          : {}),
      },
    },
  );
}
