import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import Catalog from '#storefront/Catalog.astro';
import AltCatalog from './fixtures/catalog/AltCatalog.astro';
import { buildPaginationModel, buildSortModel } from '../../src/features/storefront/catalog';
import { buildProductCard } from '../../src/features/storefront/productCard';
import type { CatalogPageModel } from '../../src/features/storefront/models';
import type { Product } from '../../src/features/products/db';

const product = (n: number, overrides: Partial<Product> = {}): Product => ({
  id: n,
  public_id: `prod_k7m2qx8vn${n}`,
  name: `Item ${n}`,
  slug: `item-${n}`,
  description: null,
  price_cents: 1000 + n,
  currency: 'usd',
  image_key: null,
  stock: 5,
  active: 1,
  variant_label: null,
  weight_grams: null,
  requires_shipping: 1,
  related_ids: null,
  created_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

const model = (overrides: Partial<CatalogPageModel> = {}): CatalogPageModel => ({
  eyebrow: 'Shop',
  heading: 'All products',
  categories: [{ text: 'Apparel', href: '/categories/apparel' }],
  // Mirrors the loader: only the first card is the page's likely LCP image.
  products: [product(1), product(2)].map((p, i) => buildProductCard(p, { currency: 'usd', priority: i === 0 })),
  sort: buildSortModel('/products', 'newest', 'desc'),
  pagination: buildPaginationModel('/products', 1, 3, 'newest', 'desc'),
  ...overrides,
});

const render = async (component: unknown, value: CatalogPageModel) => {
  const container = await AstroContainer.create();
  return container.renderToString(component as never, { props: { model: value } });
};

describe('buildSortModel', () => {
  it('names sort and direction explicitly, defaults included', () => {
    const [newest] = buildSortModel('/products', 'price', 'asc').options;

    // Pre-existing behavior: sort links are always explicit, so the default
    // option points at ?sort=newest&dir=desc rather than the bare path. Pinned
    // here because an extraction must not quietly change which URLs exist.
    expect(newest.href).toBe('/products?sort=newest&dir=desc');
  });

  it('flips direction on the field already sorting the list', () => {
    const active = buildSortModel('/products', 'price', 'asc').options.find((o) => o.current);

    expect(active?.label).toBe('Price');
    expect(active?.direction).toBe('asc');
    expect(active?.href).toContain('dir=desc');
  });

  it('applies each inactive field its own natural direction', () => {
    const name = buildSortModel('/products', 'price', 'asc').options.find(
      (o) => o.label === 'Name',
    );

    expect(name?.current).toBe(false);
    expect(name?.direction).toBeNull();
    expect(name?.href).toContain('sort=name');
    expect(name?.href).toContain('dir=asc');
  });

  it('drops the page when the ordering changes', () => {
    // Re-sorting while holding page 7 would land a shopper mid-list.
    for (const option of buildSortModel('/products', 'price', 'asc').options) {
      expect(option.href).not.toContain('page=');
    }
  });

  it('stays on the path it was given', () => {
    for (const option of buildSortModel('/categories/apparel', 'newest', 'desc').options) {
      expect(option.href.startsWith('/categories/apparel')).toBe(true);
    }
  });
});

describe('buildPaginationModel', () => {
  it('produces nothing to render for a single page', () => {
    const single = buildPaginationModel('/products', 1, 1, 'newest', 'desc');

    expect(single.items).toEqual([]);
    expect(single.prevHref).toBeNull();
    expect(single.nextHref).toBeNull();
  });

  it('omits page=1 so the first page has one URL, not two', () => {
    const { prevHref } = buildPaginationModel('/products', 2, 5, 'newest', 'desc');

    expect(prevHref).toBe('/products');
  });

  it('carries a non-default sort through every page link', () => {
    const { nextHref } = buildPaginationModel('/products', 1, 5, 'price', 'asc');

    expect(nextHref).toContain('sort=price');
    expect(nextHref).toContain('dir=asc');
    expect(nextHref).toContain('page=2');
  });

  it('elides the middle of a long series', () => {
    const { items } = buildPaginationModel('/products', 10, 20, 'newest', 'desc');
    const pages = items.map((item) => item.page);

    expect(pages).toEqual([1, null, 9, 10, 11, null, 20]);
    expect(items.find((item) => item.page === null)?.href).toBeNull();
    expect(items.find((item) => item.current)?.page).toBe(10);
  });
});

describe('the store-owned catalog', () => {
  it('renders headings, categories, and cards', async () => {
    const html = await render(Catalog, model());

    expect(html).toContain('All products');
    expect(html).toContain('href="/categories/apparel"');
    expect(html).toContain('href="/products/item-1"');
    expect(html).toContain('$10.01');
  });

  it('announces an empty catalog instead of rendering a blank grid', async () => {
    // The wording belongs to the design; that the state is ANNOUNCED does not.
    // Asserting only "no product links" would pass if the empty state were
    // deleted outright, leaving a shopper with a silent blank page.
    const html = await render(Catalog, model({ products: [] }));
    const status = html.match(/<[^>]*role="status"[^>]*>([\s\S]*?)<\//);

    expect(html).not.toContain('href="/products/');
    expect(status).not.toBeNull();
    expect(status?.[1].trim().length).toBeGreaterThan(0);
  });

  it('keeps pagination a labelled landmark with rel hints', async () => {
    const html = await render(Catalog, model());

    expect(html).toContain('aria-label="Pagination"');
    expect(html).toContain('rel="next"');
    expect(html).toContain('aria-current="page"');
  });

  it('hides pagination entirely on a single page', async () => {
    const html = await render(
      Catalog,
      model({ pagination: buildPaginationModel('/products', 1, 1, 'newest', 'desc') }),
    );

    expect(html).not.toContain('aria-label="Pagination"');
  });

  it('marks the sorted field for assistive technology', async () => {
    const html = await render(
      Catalog,
      model({ sort: buildSortModel('/products', 'price', 'asc') }),
    );

    // aria-current is the contract; the arrow glyph beside it is decoration.
    expect(html).toContain('aria-current="true"');
  });

  it('gives the first card image priority and no others', async () => {
    const html = await render(Catalog, model());

    expect(html.match(/loading="eager"/g)?.length).toBe(1);
    expect(html.match(/loading="lazy"/g)?.length).toBe(1);
  });

  it('publishes no numeric row identifiers', async () => {
    const html = await render(Catalog, model());

    expect(html).not.toMatch(/\bproduct[-_]?id="\d+"/);
    expect(html).not.toContain('/products/1"');
  });
});

describe('an independently authored catalog', () => {
  it('satisfies the same model without using ProductCard at all', async () => {
    // The card model has to stand on its own, not only inside the component it
    // was extracted alongside.
    const html = await render(AltCatalog, model());

    expect(html).toContain('<table');
    expect(html).toContain('data-product="prod_k7m2qx8vn1"');
    expect(html).toContain('In stock');
    expect(html).toContain('aria-label="Pagination"');
    expect(html).not.toContain('reveal group');
  });

  it('renders its own empty state from the same model', async () => {
    const html = await render(AltCatalog, model({ products: [] }));

    expect(html).toContain('Nothing to show');
  });
});
