import { describe, expect, it } from 'vitest';
import {
  CACHE_TAG,
  addCacheTags,
  normalizeCacheTags,
  productCacheTags,
  responseCacheTags,
} from './tags';

describe('cache tags', () => {
  it('classifies public response families', () => {
    expect(responseCacheTags('/products/mug', 200)).toEqual(['shell', 'catalog']);
    expect(responseCacheTags('/pages/about', 200)).toEqual(['shell', 'catalog']);
    expect(responseCacheTags('/api/products/mug', 200)).toEqual(['catalog']);
    expect(responseCacheTags('/cart', 200)).toEqual([]);
    expect(responseCacheTags('/products/missing', 404)).toEqual([]);
  });

  it('merges generic and route-specific tags deterministically', () => {
    const headers = new Headers({ 'cache-tag': CACHE_TAG.product('prod_abc123') });
    addCacheTags(headers, [
      CACHE_TAG.catalog,
      CACHE_TAG.product('prod_abc123'),
      CACHE_TAG.shell,
    ]);
    expect(headers.get('cache-tag')).toBe('catalog,product:prod_abc123,shell');
  });

  it('rejects values Cloudflare would silently discard', () => {
    expect(() => normalizeCacheTags(['has space'])).toThrow('Invalid cache tag');
    expect(() => normalizeCacheTags(['has,comma'])).toThrow('Invalid cache tag');
    expect(() => normalizeCacheTags(['café'])).toThrow('Invalid cache tag');
  });

  it('builds unique tags only from prefixed public product ids', () => {
    expect(productCacheTags(['prod_b', 'prod_a', 'prod_b', null, '7'])).toEqual([
      'product:prod_a',
      'product:prod_b',
    ]);
  });
});
