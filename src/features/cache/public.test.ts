import { describe, expect, it } from 'vitest';
import {
  isPublicCatalogApi,
  isPublicStorefrontPath,
  publicCacheRequest,
} from './public';

describe('publicCacheRequest', () => {
  it('canonicalizes equivalent catalog defaults and ignores unknown params', () => {
    const request = new Request(
      'https://shop.example/api/products?offset=0&limit=024&q=%20desk%20%20hub%20&ignored=1',
    );
    expect(publicCacheRequest(request).url).toBe(
      'https://shop.example/api/products?q=desk+hub',
    );
  });

  it('removes ignored query parameters from product detail keys', () => {
    const request = new Request('https://shop.example/api/products/mug?utm_source=test');
    expect(publicCacheRequest(request).url).toBe('https://shop.example/api/products/mug');
  });

  it('canonicalizes search whitespace and page defaults', () => {
    const request = new Request('https://shop.example/search?page=1&q=%20red%20%20mug%20');
    expect(publicCacheRequest(request).url).toBe('https://shop.example/search?q=red+mug');
  });

  it('drops tracking parameters and canonicalizes storefront list controls', () => {
    const request = new Request(
      'https://shop.example/?utm_source=post&sort=sold&dir=ASC&page=999999',
      { headers: { cookie: 'cart=private' } },
    );
    const key = publicCacheRequest(request);
    expect(key.url).toBe('https://shop.example/?dir=asc&page=10000');
    expect(key.headers.has('cookie')).toBe(false);
  });

  it('drops ignored parameters from category and product keys', () => {
    expect(
      publicCacheRequest(
        new Request('https://shop.example/category/home?sort=price&dir=desc&utm_medium=social'),
      ).url,
    ).toBe('https://shop.example/category/home?sort=price');
    expect(
      publicCacheRequest(
        new Request('https://shop.example/product/mug?utm_source=test&ref=sidebar'),
      ).url,
    ).toBe('https://shop.example/product/mug');
  });
});

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
    expect(isPublicStorefrontPath('/product/mug')).toBe(true);
    expect(isPublicStorefrontPath('/category/home')).toBe(true);
    expect(isPublicStorefrontPath('/partials/cart')).toBe(false);
    expect(isPublicStorefrontPath('/pay/order-id')).toBe(false);
  });
});
