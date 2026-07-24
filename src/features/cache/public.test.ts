import { describe, expect, it } from 'vitest';
import { isPublicCatalogApi, publicCacheRequest } from './public';

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
});

describe('isPublicCatalogApi', () => {
  it('allows only the read-only catalog API namespace', () => {
    expect(isPublicCatalogApi('/api/products')).toBe(true);
    expect(isPublicCatalogApi('/api/products/mug')).toBe(true);
    expect(isPublicCatalogApi('/api/checkout')).toBe(false);
  });
});
