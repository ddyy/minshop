import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';

/**
 * Exercises loadProductDetail itself, not the helper it calls.
 *
 * The earlier version of this file asserted on requirePublicId directly, which
 * would have kept passing if the loader reverted to `public_id ?? ''` — the very
 * defect it was written to prevent. A row reaching a public surface without its
 * public ID is a deploy-order bug, and the page must fail rather than render 200
 * with an empty product_id whose Add to cart breaks later.
 */

const rows = {
  product: {
    id: 42,
    public_id: 'prod_k7m2qx8vn6' as string | null,
    name: 'Sample Tee',
    slug: 'sample-tee',
    description: 'A shirt.',
    price_cents: 2400,
    currency: 'usd',
    image_key: 'media/tee.jpg',
    stock: 7,
    active: 1,
    variant_label: 'Size',
    weight_grams: null,
    requires_shipping: 1,
    related_ids: null,
    created_at: '2026-01-01T00:00:00Z',
  } as Record<string, unknown>,
  variants: [] as Array<Record<string, unknown>>,
  extras: [] as Array<Record<string, unknown>>,
  images: [] as Array<Record<string, unknown>>,
};

vi.mock('../../src/features/products/db', () => ({
  getProductBySlug: vi.fn(async () => rows.product),
  listProductImages: vi.fn(async () => rows.images),
}));
vi.mock('../../src/features/products/variants', () => ({
  listVariants: vi.fn(async () => rows.variants),
  listExtras: vi.fn(async () => rows.extras),
}));
vi.mock('../../src/features/categories/db', () => ({
  categoriesForProduct: vi.fn(async () => []),
  relatedProducts: vi.fn(async () => []),
}));
vi.mock('../../src/features/search', () => ({
  getRelatedStored: vi.fn(async () => []),
  storeRelatedIds: vi.fn(async () => undefined),
}));
vi.mock('../../src/features/payments', () => ({
  enabledMethods: vi.fn(() => []),
}));

const { loadProductDetail } = await import('../../src/features/storefront/productDetail');

const load = () =>
  loadProductDetail({} as D1Database, {
    slug: 'sample-tee',
    searchParams: new URLSearchParams(),
    settings: undefined,
    imageBaseUrl: '',
    delivery: undefined,
    currency: 'usd',
    origin: 'https://shop.example.com',
    pathname: '/products/sample-tee',
  });

const variant = (overrides: Record<string, unknown> = {}) => ({
  id: 7,
  public_id: 'var_aaaaaaaaaa',
  label: 'Small',
  price_cents: 2400,
  stock: 5,
  sku: null,
  position: 0,
  active: 1,
  image_id: null,
  ...overrides,
});

const extra = (overrides: Record<string, unknown> = {}) => ({
  id: 9,
  public_id: 'xtra_cccccccccc',
  label: 'Gift wrap',
  price_delta_cents: 500,
  position: 0,
  active: 1,
  ...overrides,
});

const galleryRow = (overrides: Record<string, unknown> = {}) => ({
  id: 11,
  public_id: 'pimg_dddddddddd',
  image_key: 'media/tee-front.jpg',
  position: 0,
  alt: null,
  ...overrides,
});

beforeEach(() => {
  rows.product = { ...rows.product, public_id: 'prod_k7m2qx8vn6' };
  rows.variants = [];
  rows.extras = [];
  rows.images = [];
});

describe('loadProductDetail public-ID policy', () => {
  it('builds a page when every row has its public ID', async () => {
    rows.variants = [variant()];
    rows.extras = [extra()];
    rows.images = [galleryRow(), galleryRow({ id: 12, public_id: 'pimg_eeeeeeeeee' })];

    const loaded = await load();

    expect(loaded.status).toBe('ok');
    if (loaded.status !== 'ok') return;
    expect(loaded.model.id).toBe('prod_k7m2qx8vn6');
    expect(loaded.purchase.productId).toBe('prod_k7m2qx8vn6');
    expect(loaded.purchase.variants[0].id).toBe('var_aaaaaaaaaa');
    expect(loaded.purchase.extras[0].id).toBe('xtra_cccccccccc');
    expect(loaded.model.images[0].anchor).toBe('pimg_dddddddddd');
  });

  it('refuses a product without a public ID', async () => {
    rows.product = { ...rows.product, public_id: null };

    await expect(load()).rejects.toThrow(/product row 42 has no public_id/);
  });

  it('refuses a variant without a public ID', async () => {
    rows.variants = [variant({ public_id: null })];

    await expect(load()).rejects.toThrow(/variant row 7 has no public_id/);
  });

  it('refuses an extra without a public ID', async () => {
    rows.extras = [extra({ public_id: null })];

    await expect(load()).rejects.toThrow(/extra row 9 has no public_id/);
  });

  it('refuses a gallery image without a public ID', async () => {
    // The old fallback published the R2 object key as a DOM anchor instead.
    rows.images = [galleryRow({ public_id: null })];

    await expect(load()).rejects.toThrow(/product image row 11 has no public_id/);
  });

  it('refuses the image a variant points at when that image has no public ID', async () => {
    rows.images = [galleryRow({ public_id: null })];
    rows.variants = [variant({ image_id: 11 })];

    await expect(load()).rejects.toThrow(/product image row 11 has no public_id/);
  });

  it('reports not_found rather than throwing for a missing slug', async () => {
    const db = await import('../../src/features/products/db');
    vi.mocked(db.getProductBySlug).mockResolvedValueOnce(null);

    await expect(load()).resolves.toEqual({ status: 'not_found' });
  });
});
