import { describe, it, expect } from 'vitest';
import { sitemapLocs } from './sitemap.xml';

const origin = 'https://shop.example';
const data = {
  categories: [{ slug: 'hats' }],
  products: [{ slug: 'beanie' }],
  pages: [{ slug: 'about' }],
};

describe('sitemapLocs', () => {
  it('lists the catalog at / when the home page is the catalog', () => {
    const locs = sitemapLocs(origin, null, data);
    expect(locs[0]).toBe(`${origin}/`);
    expect(locs).not.toContain(`${origin}/products`);
  });

  // With `/` taken over, it renders the chosen target and canonicals to it — so
  // listing `/` would be a non-canonical duplicate of a URL already in the
  // sitemap, and the real catalog would be absent altogether.
  it('lists the catalog at /products once the home page is overridden', () => {
    const locs = sitemapLocs(origin, 'page:3', data);
    expect(locs[0]).toBe(`${origin}/products`);
    expect(locs).not.toContain(`${origin}/`);
  });

  it('covers every category, product, and published page', () => {
    const locs = sitemapLocs(origin, null, data);
    expect(locs).toContain(`${origin}/categories/hats`);
    expect(locs).toContain(`${origin}/products/beanie`);
    expect(locs).toContain(`${origin}/pages/about`);
    expect(locs).toHaveLength(4);
  });

  it('never emits a duplicate URL', () => {
    for (const home of [null, 'page:3', 'product:9']) {
      const locs = sitemapLocs(origin, home, data);
      expect(new Set(locs).size).toBe(locs.length);
    }
  });
});
