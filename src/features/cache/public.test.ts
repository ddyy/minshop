import { describe, expect, it } from 'vitest';
import {
  isPublicCatalogApi,
  isPublicStorefrontPath,
  PRIVATE_CACHE_CONTROL,
  PUBLIC_CACHE_CONTROL,
  responseCacheControl,
} from './public';

describe('isPublicCatalogApi', () => {
  it('allows only the read-only catalog API namespace', () => {
    expect(isPublicCatalogApi('/api/products')).toBe(true);
    expect(isPublicCatalogApi('/api/products/mug')).toBe(true);
    expect(isPublicCatalogApi('/api/checkout')).toBe(false);
  });
});

describe('isPublicStorefrontPath', () => {
  it('allows catalog documents but excludes personalized fragments and payments', () => {
    expect(isPublicStorefrontPath('/')).toBe(true);
    expect(isPublicStorefrontPath('/products/mug')).toBe(true);
    expect(isPublicStorefrontPath('/product/mug')).toBe(true);
    expect(isPublicStorefrontPath('/pages/about')).toBe(true);
    expect(isPublicStorefrontPath('/categories/home')).toBe(true);
    expect(isPublicStorefrontPath('/category/home')).toBe(true);
    expect(isPublicStorefrontPath('/partials/cart')).toBe(false);
    expect(isPublicStorefrontPath('/pay/order-id')).toBe(false);
  });
});

describe('responseCacheControl', () => {
  it.each([
    '/',
    '/products',
    '/products/mug',
    '/categories/home',
    '/search',
    '/pages/about',
    '/robots.txt',
    '/sitemap.xml',
    '/llms.txt',
    '/api/products',
    '/api/products/mug',
  ])('marks successful public route %s with the shared policy', (path) => {
    expect(responseCacheControl(path, 200, null)).toBe(PUBLIC_CACHE_CONTROL);
  });

  it.each([
    '/cart',
    '/checkout',
    '/express',
    '/payment-setup',
    '/partials/cart',
    '/account',
    '/account/login',
    '/order/otk_example',
    '/pay/ord_example',
    '/admin',
    '/admin/products',
    '/api/admin/products',
    '/api/internal/cache-purge',
    '/api/cart',
    '/api/checkout',
  ])('marks private route %s no-store on every response path', (path) => {
    expect(responseCacheControl(path, 200, null)).toBe(PRIVATE_CACHE_CONTROL);
    expect(responseCacheControl(path, 302, 'public, s-maxage=600')).toBe(
      PRIVATE_CACHE_CONTROL,
    );
    expect(responseCacheControl(path, 404, null)).toBe(PRIVATE_CACHE_CONTROL);
  });

  it('allows only the permanent legacy storefront redirects', () => {
    expect(responseCacheControl('/product/mug', 301, null)).toBe(PUBLIC_CACHE_CONTROL);
    expect(responseCacheControl('/category/home', 301, null)).toBe(PUBLIC_CACHE_CONTROL);
    expect(responseCacheControl('/', 302, null)).toBe(PRIVATE_CACHE_CONTROL);
  });

  it('prevents heuristic caching of errors and unknown routes', () => {
    expect(responseCacheControl('/products/missing', 404, null)).toBe(
      PRIVATE_CACHE_CONTROL,
    );
    expect(responseCacheControl('/not-a-route', 404, null)).toBe(PRIVATE_CACHE_CONTROL);
    expect(responseCacheControl('/api/health', 200, null)).toBe(PRIVATE_CACHE_CONTROL);
  });

  it('preserves explicit policy on routes outside the shared-page allowlist', () => {
    const immutable = 'public, max-age=31536000, immutable';
    expect(responseCacheControl('/images/media/example.webp', 200, immutable)).toBe(
      immutable,
    );
  });

  it('forces request-specific product validation errors private', () => {
    expect(
      responseCacheControl('/products/mug', 200, PUBLIC_CACHE_CONTROL, true),
    ).toBe(PRIVATE_CACHE_CONTROL);
  });
});

describe('content pages', () => {
  it('classifies /pages/<slug> as public storefront HTML', () => {
    expect(isPublicStorefrontPath('/pages/about')).toBe(true);
    expect(isPublicStorefrontPath('/pages/shipping-returns')).toBe(true);
  });

  it('does not classify the admin pages screen as public', () => {
    expect(isPublicStorefrontPath('/admin/pages')).toBe(false);
    expect(isPublicStorefrontPath('/api/admin/pages')).toBe(false);
  });

});

describe('catalog list route', () => {
  it('treats /products as public storefront HTML', () => {
    // The catalog needs its own URL when / has been pointed at a page.
    expect(isPublicStorefrontPath('/products')).toBe(true);
  });
});
