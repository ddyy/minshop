import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import ProductCard from '../../src/storefront/ProductCard.astro';
import AltProductCard from './fixtures/product-card/AltProductCard.astro';
import { buildProductCard } from '../../src/features/storefront/productCard';
import type { Product } from '../../src/features/products/db';

const product = (overrides: Partial<Product> = {}): Product => ({
  id: 42,
  public_id: 'prod_k7m2qx8vn6',
  name: 'Sample Tee',
  slug: 'sample-tee',
  description: null,
  price_cents: 2400,
  currency: 'usd',
  image_key: 'media/sample-tee.jpg',
  stock: 7,
  active: 1,
  variant_label: null,
  weight_grams: null,
  requires_shipping: 1,
  related_ids: null,
  created_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

const render = async (component: unknown, card: unknown) => {
  const container = await AstroContainer.create();
  // No request, no locals. If either template or StoreImage ever needs them,
  // this call is where the contract breaks.
  return container.renderToString(component as never, { props: { card } });
};

describe('buildProductCard', () => {
  it('exposes the public ID, never the row ID', () => {
    const card = buildProductCard(product());

    expect(card.id).toBe('prod_k7m2qx8vn6');
    expect(JSON.stringify(card)).not.toContain('42');
  });

  it('refuses a row without a public ID rather than leaking the row ID', () => {
    expect(() => buildProductCard(product({ public_id: null }))).toThrow(/no public_id/);
  });

  it('reports availability as a boolean, never a count', () => {
    expect(buildProductCard(product({ stock: 7 })).inStock).toBe(true);
    expect(buildProductCard(product({ stock: 3 })).inStock).toBe(true); // low, still purchasable
    expect(buildProductCard(product({ stock: 0 })).inStock).toBe(false);

    // The quantity must not survive into the model in any form. Asserted on the
    // shape rather than the serialized string: public IDs contain digits, so a
    // substring check quietly matches the wrong thing.
    const card = buildProductCard(product({ stock: 7 }));
    expect(Object.keys(card)).not.toContain('stock');
    expect(Object.values(card)).not.toContain(7);
  });

  it('resolves original delivery to a plain URL with no ladder', () => {
    const { image } = buildProductCard(product(), { delivery: 'original' });

    expect(image.src).toBe('/images/media/sample-tee.jpg');
    expect(image.srcset).toBeUndefined();
  });

  it('resolves cloudflare delivery into a real srcset', () => {
    const { image } = buildProductCard(product(), {
      delivery: 'cloudflare',
      baseUrl: 'https://img.example.com',
      sizes: '(min-width: 1024px) 352px, 50vw',
    });

    expect(image.srcset).toContain('/cdn-cgi/image/');
    expect(image.srcset).toContain('384w');
    expect(image.sizes).toBe('(min-width: 1024px) 352px, 50vw');
    // The key itself must not survive into the model.
    expect(image.src).not.toBe('media/sample-tee.jpg');
  });

  it('falls back to the placeholder when a product has no image', () => {
    expect(buildProductCard(product({ image_key: null })).image.src).toBe('/placeholder.png');
  });

  it('gives the priority image the wider fallback candidate', () => {
    const options = { delivery: 'cloudflare' as const, baseUrl: 'https://img.example.com' };
    const lazy = buildProductCard(product(), options).image;
    const lcp = buildProductCard(product(), { ...options, priority: true }).image;

    expect(lazy.src).toContain('width=384');
    expect(lcp.src).toContain('width=768');
    expect(lcp.priority).toBe(true);
  });
});

describe('the store-owned product card', () => {
  it('renders from props alone', async () => {
    const html = await render(ProductCard, buildProductCard(product()));

    expect(html).toContain('href="/products/sample-tee"');
    expect(html).toContain('Sample Tee');
    expect(html).toContain('$24.00');
  });

  it('marks a sold-out product without publishing the count', async () => {
    const html = await render(ProductCard, buildProductCard(product({ stock: 0 })));

    expect(html).toContain('Sold out');
    expect(html).toContain('opacity-60');
  });

  it('emits eager/high only for the LCP card', async () => {
    const lazy = await render(ProductCard, buildProductCard(product()));
    const lcp = await render(ProductCard, buildProductCard(product(), { priority: true }));

    expect(lazy).toContain('loading="lazy"');
    expect(lazy).toContain('fetchpriority="auto"');
    expect(lcp).toContain('loading="eager"');
    expect(lcp).toContain('fetchpriority="high"');
  });

  it('never fades the LCP image', async () => {
    // An opacity:0 element is not a valid LCP candidate, so fading a priority
    // image would undo the head start `priority` just bought.
    const lcp = await render(ProductCard, buildProductCard(product(), { priority: true }));

    expect(lcp).not.toContain('data-image-fade');
  });
});

describe('an independently authored card', () => {
  it('satisfies the same contract with different anatomy', async () => {
    const html = await render(AltProductCard, buildProductCard(product({ stock: 0 })));

    expect(html).toContain('<figure>');
    expect(html).toContain('Sold out');
    expect(html).toContain('href="/products/sample-tee"');
    // Structurally different from the default, which is the point.
    expect(html).not.toContain('reveal group');
  });
});
